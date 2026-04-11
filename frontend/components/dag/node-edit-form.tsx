"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMapsLibrary } from "@vis.gl/react-google-maps";
import {
  utcToLocalInput,
  localInputToUtc,
  formatDateTimeWithPreference,
  type DateFormatPreference,
} from "@/lib/dates";
import {
  PlacesAutocomplete,
  type PlaceResult,
} from "@/components/map/places-autocomplete";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { DurationInput } from "@/components/ui/duration-input";
import {
  enrichDagTimes,
  type EnrichedNode,
  type RawEdge,
  type RawNode,
  type TripSettingsLike,
} from "@/lib/time-inference";

type EditMode = "fixed" | "flexible";
type FlexAnchor = "none" | "arrival" | "departure";

interface NodeEditFormProps {
  node: {
    id: string;
    name: string;
    type: string;
    arrival_time: string | null;
    departure_time: string | null;
    duration_minutes?: number | null;
    arrival_time_estimated?: boolean;
    departure_time_estimated?: boolean;
    duration_estimated?: boolean;
    lat_lng?: { lat: number; lng: number } | null;
    [key: string]: unknown;
  };
  userRole: string;
  plannerReadOnly?: boolean;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  allNodes?: RawNode[];
  allEdges?: RawEdge[];
  tripSettings?: TripSettingsLike | null;
  onSave: (updates: Record<string, unknown>) => void;
  onCancel: () => void;
  onProposeChanges?: () => void;
  onShiftFollowing?: (
    shifts: Array<{
      id: string;
      arrival_time: string | null;
      departure_time: string | null;
    }>,
  ) => void | Promise<void>;
  onImpactDiscarded?: () => void;
}

const NODE_TYPES = [
  { value: "city", label: "City" },
  { value: "hotel", label: "Hotel" },
  { value: "restaurant", label: "Restaurant" },
  { value: "place", label: "Place" },
  { value: "activity", label: "Activity" },
];

const DEBOUNCE_MS = 400;

function PinIcon({ colored = false }: { colored?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${colored ? "text-primary" : "text-outline-variant"}`}
    >
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function inferInitialMode(node: NodeEditFormProps["node"]): EditMode {
  if (node.duration_minutes != null && !node.duration_estimated) {
    return "flexible";
  }
  const hasUserArrival =
    node.arrival_time != null && !node.arrival_time_estimated;
  const hasUserDeparture =
    node.departure_time != null && !node.departure_time_estimated;
  if (hasUserArrival && hasUserDeparture) return "fixed";
  return "fixed";
}

function inferInitialAnchor(node: NodeEditFormProps["node"]): FlexAnchor {
  const hasUserArrival =
    node.arrival_time != null && !node.arrival_time_estimated;
  const hasUserDeparture =
    node.departure_time != null && !node.departure_time_estimated;
  if (hasUserArrival) return "arrival";
  if (hasUserDeparture) return "departure";
  return "none";
}

interface ImpactDiff {
  shifts: Array<{
    id: string;
    name: string;
    oldArrival: string | null;
    newArrival: string | null;
  }>;
  conflicts: Array<{
    id: string;
    name: string;
    userArrivalIso: string;
    propagatedArrivalIso: string;
    deltaMinutes: number;
    direction: "early" | "late";
  }>;
  overnightHolds: Array<{
    id: string;
    name: string;
    reason: "night_drive" | "max_drive_hours";
  }>;
}

const EMPTY_DIFF: ImpactDiff = {
  shifts: [],
  conflicts: [],
  overnightHolds: [],
};

function diffEnrichments(
  before: EnrichedNode[],
  after: EnrichedNode[],
  editedNodeId: string,
  edges: RawEdge[],
): ImpactDiff {
  const beforeMap = new Map(before.map((n) => [n.id, n]));
  const afterMap = new Map(after.map((n) => [n.id, n]));
  const diff: ImpactDiff = { shifts: [], conflicts: [], overnightHolds: [] };

  for (const a of after) {
    if (a.id === editedNodeId) continue;
    const b = beforeMap.get(a.id);
    if (!b) continue;

    if (
      a.arrival_time !== b.arrival_time ||
      a.departure_time !== b.departure_time
    ) {
      diff.shifts.push({
        id: a.id,
        name: String(a.name ?? a.id),
        oldArrival: b.arrival_time,
        newArrival: a.arrival_time,
      });
    }

    if (a.timing_conflict && !b.timing_conflict) {
      const parents = edges.filter((e) => e.to_node_id === a.id);
      let propagated: Date | null = null;
      for (const edge of parents) {
        const parent = afterMap.get(edge.from_node_id);
        if (!parent?.departure_time) continue;
        const pd = new Date(parent.departure_time);
        if (Number.isNaN(pd.getTime())) continue;
        const candidate = new Date(
          pd.getTime() + Number(edge.travel_time_hours ?? 0) * 3_600_000,
        );
        if (!propagated || candidate.getTime() > propagated.getTime()) {
          propagated = candidate;
        }
      }
      const userArrival = a.arrival_time ? new Date(a.arrival_time) : null;
      if (propagated && userArrival && !Number.isNaN(userArrival.getTime())) {
        const deltaMs = propagated.getTime() - userArrival.getTime();
        diff.conflicts.push({
          id: a.id,
          name: String(a.name ?? a.id),
          userArrivalIso: a.arrival_time!,
          propagatedArrivalIso: propagated.toISOString(),
          deltaMinutes: Math.abs(Math.round(deltaMs / 60000)),
          direction: deltaMs < 0 ? "early" : "late",
        });
      }
    }

    if (a.overnight_hold && !b.overnight_hold) {
      diff.overnightHolds.push({
        id: a.id,
        name: String(a.name ?? a.id),
        reason: a.hold_reason ?? "night_drive",
      });
    }
  }

  return diff;
}

function formatDeltaMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  if (rem === 0) return `${hours}h`;
  return `${hours}h ${rem}m`;
}

function formatSignedHours(deltaMs: number): string {
  const minutes = Math.round(deltaMs / 60000);
  const sign = minutes >= 0 ? "+" : "-";
  return `${sign}${formatDeltaMinutes(Math.abs(minutes))}`;
}

export function NodeEditForm({
  node,
  userRole,
  plannerReadOnly = false,
  datetimeFormat = "24h",
  dateFormat = "eu",
  allNodes,
  allEdges,
  tripSettings,
  onSave,
  onCancel,
  onProposeChanges,
  onShiftFollowing,
  onImpactDiscarded,
}: NodeEditFormProps) {
  const tz = (node as Record<string, unknown>).timezone as string | undefined;
  const [name, setName] = useState(node.name);
  const [type, setType] = useState(node.type);
  const [mode, setMode] = useState<EditMode>(() => inferInitialMode(node));
  const [anchor, setAnchor] = useState<FlexAnchor>(() => inferInitialAnchor(node));
  const [durationMinutes, setDurationMinutes] = useState<number | null>(() => {
    if (node.duration_minutes != null && !node.duration_estimated) {
      return node.duration_minutes;
    }
    return node.duration_minutes ?? null;
  });
  const [arrivalTime, setArrivalTime] = useState(() =>
    !node.arrival_time_estimated ? utcToLocalInput(node.arrival_time, tz) : "",
  );
  const [departureTime, setDepartureTime] = useState(() =>
    !node.departure_time_estimated
      ? utcToLocalInput(node.departure_time, tz)
      : "",
  );
  const [locationUpdate, setLocationUpdate] = useState<PlaceResult | null>(null);
  const [locationState, setLocationState] = useState<"chip" | "searching">("chip");
  const [searchKey, setSearchKey] = useState(0);

  const places = useMapsLibrary("places");
  const [resolvedPlaceName, setResolvedPlaceName] = useState<string | null>(null);

  useEffect(() => {
    if (!places || !node.place_id || locationUpdate) return;
    const p = new places.Place({ id: node.place_id as string });
    p.fetchFields({ fields: ["displayName"] })
      .then(() => {
        if (p.displayName) setResolvedPlaceName(p.displayName);
      })
      .catch(() => {});
  }, [places, node.place_id, locationUpdate]);

  const chipLabel = locationUpdate
    ? locationUpdate.name
    : (resolvedPlaceName ?? node.name);

  const searchInitialValue = locationUpdate
    ? locationUpdate.name
    : node.place_id
      ? (resolvedPlaceName ?? node.name)
      : "";

  const departureBeforeArrival =
    mode === "fixed" &&
    !!arrivalTime &&
    !!departureTime &&
    departureTime <= arrivalTime;

  // ---------------------------------------------------------------------------
  // Proposed updates — what the form would persist right now.
  // ---------------------------------------------------------------------------
  const proposedUpdates = useMemo<Record<string, unknown>>(() => {
    const updates: Record<string, unknown> = {};
    if (name.trim() && name !== node.name) updates.name = name.trim();
    if (type !== node.type) updates.type = type;

    if (mode === "fixed") {
      const newArrival = arrivalTime ? localInputToUtc(arrivalTime, tz) : null;
      const newDeparture = departureTime
        ? localInputToUtc(departureTime, tz)
        : null;
      if (newArrival !== node.arrival_time) updates.arrival_time = newArrival;
      if (newDeparture !== node.departure_time) {
        updates.departure_time = newDeparture;
      }
      if (node.duration_minutes != null && !node.duration_estimated) {
        updates.duration_minutes = null;
      }
    } else {
      // flexible
      if (durationMinutes !== (node.duration_minutes ?? null)) {
        updates.duration_minutes = durationMinutes;
      }
      if (anchor === "none") {
        if (node.arrival_time && !node.arrival_time_estimated) {
          updates.arrival_time = null;
        }
        if (node.departure_time && !node.departure_time_estimated) {
          updates.departure_time = null;
        }
      } else if (anchor === "arrival") {
        const newArrival = arrivalTime ? localInputToUtc(arrivalTime, tz) : null;
        if (newArrival !== node.arrival_time) updates.arrival_time = newArrival;
        if (node.departure_time && !node.departure_time_estimated) {
          updates.departure_time = null;
        }
      } else {
        const newDeparture = departureTime
          ? localInputToUtc(departureTime, tz)
          : null;
        if (newDeparture !== node.departure_time) {
          updates.departure_time = newDeparture;
        }
        if (node.arrival_time && !node.arrival_time_estimated) {
          updates.arrival_time = null;
        }
      }
    }

    if (locationUpdate) {
      updates.lat = locationUpdate.lat;
      updates.lng = locationUpdate.lng;
      updates.place_id = locationUpdate.placeId;
    }

    return updates;
  }, [
    name,
    type,
    mode,
    arrivalTime,
    departureTime,
    durationMinutes,
    anchor,
    locationUpdate,
    tz,
    node,
  ]);

  const hasTimingChange = useMemo(() => {
    return (
      "arrival_time" in proposedUpdates ||
      "departure_time" in proposedUpdates ||
      "duration_minutes" in proposedUpdates
    );
  }, [proposedUpdates]);

  // ---------------------------------------------------------------------------
  // Live impact preview — debounced so intermediate keystrokes don't flicker.
  // ---------------------------------------------------------------------------
  const [debouncedTick, setDebouncedTick] = useState(0);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTick((x) => x + 1), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [
    name,
    type,
    mode,
    arrivalTime,
    departureTime,
    durationMinutes,
    anchor,
    locationUpdate,
  ]);

  const impactDiff = useMemo<ImpactDiff>(() => {
    void debouncedTick;
    if (
      !hasTimingChange ||
      !allNodes ||
      !allEdges ||
      allNodes.length === 0 ||
      departureBeforeArrival
    ) {
      return EMPTY_DIFF;
    }
    try {
      const before = enrichDagTimes(allNodes, allEdges, tripSettings ?? null);
      const proposedNode: RawNode = {
        ...(node as RawNode),
        ...proposedUpdates,
      } as RawNode;
      if ("arrival_time" in proposedUpdates) {
        proposedNode.arrival_time = proposedUpdates.arrival_time as
          | string
          | null;
      }
      if ("departure_time" in proposedUpdates) {
        proposedNode.departure_time = proposedUpdates.departure_time as
          | string
          | null;
      }
      if ("duration_minutes" in proposedUpdates) {
        proposedNode.duration_minutes = proposedUpdates.duration_minutes as
          | number
          | null;
      }
      const proposedNodes = allNodes.map((n) =>
        n.id === node.id ? proposedNode : n,
      );
      const after = enrichDagTimes(proposedNodes, allEdges, tripSettings ?? null);
      return diffEnrichments(before, after, node.id, allEdges);
    } catch {
      return EMPTY_DIFF;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debouncedTick,
    hasTimingChange,
    allNodes,
    allEdges,
    tripSettings,
    node,
    proposedUpdates,
    departureBeforeArrival,
  ]);

  const hasImpact =
    impactDiff.shifts.length > 0 ||
    impactDiff.conflicts.length > 0 ||
    impactDiff.overnightHolds.length > 0;

  // Track whether the impact panel has ever been non-empty during this edit
  // session so we can fire `onImpactDiscarded` on cancel/unmount.
  const everHadImpactRef = useRef(false);
  useEffect(() => {
    if (hasImpact) everHadImpactRef.current = true;
  }, [hasImpact]);

  // ---------------------------------------------------------------------------
  // Edit delta for the "shift following" button.
  // ---------------------------------------------------------------------------
  const editDeltaMs = useMemo<number | null>(() => {
    const target =
      mode === "fixed"
        ? departureTime
          ? localInputToUtc(departureTime, tz)
          : null
        : anchor === "departure"
          ? departureTime
            ? localInputToUtc(departureTime, tz)
            : null
          : anchor === "arrival"
            ? arrivalTime
              ? localInputToUtc(arrivalTime, tz)
              : null
            : null;
    const original =
      mode === "fixed"
        ? node.departure_time
        : anchor === "departure"
          ? node.departure_time
          : anchor === "arrival"
            ? node.arrival_time
            : null;
    if (!target || !original) return null;
    return new Date(target).getTime() - new Date(original).getTime();
  }, [mode, anchor, arrivalTime, departureTime, tz, node]);

  const shiftButtonLabel = useMemo(() => {
    if (editDeltaMs == null || editDeltaMs === 0) return null;
    return `Shift all following stops by ${formatSignedHours(editDeltaMs)}`;
  }, [editDeltaMs]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  if (plannerReadOnly) {
    return (
      <div className="px-4 py-3 mx-4 mb-4 bg-tertiary-container/15 rounded-xl space-y-3">
        <p className="text-sm text-on-surface-variant">
          This is the active plan. Switch to a draft to make edits.
        </p>
        {onProposeChanges && (
          <button
            type="button"
            onClick={onProposeChanges}
            className="w-full rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98]"
          >
            Create draft version
          </button>
        )}
      </div>
    );
  }

  if (userRole === "viewer") {
    return (
      <div className="px-4 py-3 bg-tertiary-container/15 rounded-xl">
        <p className="text-sm text-on-surface-variant">
          Only Admins and Planners can edit stops. Ask a trip admin for access.
        </p>
      </div>
    );
  }

  function handlePlaceSelect(place: PlaceResult) {
    setLocationUpdate(place);
    setLocationState("chip");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (departureBeforeArrival) return;
    if (Object.keys(proposedUpdates).length === 0) {
      onCancel();
      return;
    }
    onSave(proposedUpdates);
  }

  function handleCancel() {
    if (everHadImpactRef.current) onImpactDiscarded?.();
    onCancel();
  }

  async function handleShiftFollowing() {
    if (!onShiftFollowing || editDeltaMs == null || editDeltaMs === 0) return;
    if (impactDiff.conflicts.length === 0) return;
    const shifts = impactDiff.conflicts
      .map((c) => {
        const originalArrivalMs = new Date(c.userArrivalIso).getTime();
        const newArrival = new Date(originalArrivalMs + editDeltaMs);
        const original = (allNodes ?? []).find((n) => n.id === c.id);
        let newDeparture: string | null = null;
        if (original?.departure_time) {
          const origDepMs = new Date(original.departure_time).getTime();
          newDeparture = new Date(origDepMs + editDeltaMs).toISOString();
        }
        return {
          id: c.id,
          arrival_time: newArrival.toISOString(),
          departure_time: newDeparture,
        };
      });
    await onShiftFollowing(shifts);
  }

  // Format a timing conflict for display.
  function formatConflictDescription(c: ImpactDiff["conflicts"][number]): string {
    const conflictNode = allNodes?.find((n) => n.id === c.id);
    const nodeTz = (conflictNode?.timezone as string | undefined) ?? undefined;
    const fixedLabel = formatDateTimeWithPreference(
      c.userArrivalIso,
      datetimeFormat,
      dateFormat,
      nodeTz,
    );
    return `Arrives ${formatDeltaMinutes(c.deltaMinutes)} ${c.direction} vs fixed ${fixedLabel}`;
  }

  function formatShiftDescription(s: ImpactDiff["shifts"][number]): string {
    if (!s.newArrival) return s.name;
    const shiftNode = allNodes?.find((n) => n.id === s.id);
    const nodeTz = (shiftNode?.timezone as string | undefined) ?? undefined;
    const newLabel = formatDateTimeWithPreference(
      s.newArrival,
      datetimeFormat,
      dateFormat,
      nodeTz,
    );
    return `${s.name} → ${newLabel}`;
  }

  const overnightLabel = (reason: "night_drive" | "max_drive_hours") =>
    reason === "night_drive" ? "Night-drive hold" : "Max-drive-hours hold";

  return (
    <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
      {/* Row 1: Name + Type */}
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <label className="block text-xs text-on-surface-variant mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Node name"
            className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-xs text-on-surface-variant mb-1">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {NODE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Row 2: Location slot */}
      <div>
        <label className="block text-xs text-on-surface-variant mb-1">Location</label>
        {locationState === "chip" && (
          <div className="rounded-xl bg-primary/[0.08] px-3 py-2 flex items-center gap-2">
            <PinIcon colored />
            <span className="flex-1 text-sm font-medium text-on-surface truncate">
              {chipLabel}
            </span>
            <button
              type="button"
              onClick={() => {
                setSearchKey((k) => k + 1);
                setLocationState("searching");
              }}
              className="shrink-0 text-xs font-semibold text-primary rounded-lg px-2 py-1 hover:bg-primary/10 transition-colors"
            >
              Change
            </button>
          </div>
        )}
        {locationState === "searching" && (
          <div className="rounded-xl bg-surface-high px-3 py-2 flex items-center gap-2">
            <PinIcon />
            <div className="flex-1">
              <PlacesAutocomplete
                key={searchKey}
                onPlaceSelect={handlePlaceSelect}
                initialValue={searchInitialValue}
                placeholder="Search for a place..."
                autoFocus
                locationBias={node.lat_lng ?? undefined}
              />
            </div>
            <button
              type="button"
              onClick={() => setLocationState("chip")}
              className="shrink-0 text-xs text-on-surface-variant hover:text-on-surface transition-colors ml-1"
            >
              Cancel
            </button>
          </div>
        )}
        {locationUpdate && (
          <p className="text-xs text-secondary mt-1">
            Location will update to {locationUpdate.name}
          </p>
        )}
      </div>

      {/* Row 3: Timing mode toggle */}
      <div>
        <div className="flex rounded-xl bg-surface-high p-0.5 gap-0.5">
          {(["fixed", "flexible"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-[10px] px-3 py-1.5 text-xs font-semibold transition-all ${
                mode === m
                  ? "bg-surface-lowest text-on-surface shadow-soft"
                  : "text-on-surface-variant"
              }`}
            >
              {m === "fixed" ? "Fixed time" : "Flexible duration"}
            </button>
          ))}
        </div>
      </div>

      {/* Timing inputs */}
      {mode === "fixed" ? (
        <div className="grid grid-cols-2 gap-2">
          <DateTimePicker
            label="Arrival"
            value={arrivalTime}
            onChange={(newArrival) => {
              setArrivalTime(newArrival);
              if (newArrival && departureTime && newArrival >= departureTime) {
                const d = new Date(newArrival);
                d.setDate(d.getDate() + 1);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const dd = String(d.getDate()).padStart(2, "0");
                const hh = String(d.getHours()).padStart(2, "0");
                const min = String(d.getMinutes()).padStart(2, "0");
                setDepartureTime(`${yyyy}-${mm}-${dd}T${hh}:${min}`);
              }
            }}
            datetimeFormat={datetimeFormat}
            dateFormat={dateFormat}
            timezone={tz}
            icon="arrival"
          />
          <DateTimePicker
            label="Departure"
            value={departureTime}
            onChange={setDepartureTime}
            datetimeFormat={datetimeFormat}
            dateFormat={dateFormat}
            timezone={tz}
            icon="departure"
            error={departureBeforeArrival}
            errorMessage="Departure must be after arrival"
          />
        </div>
      ) : (
        <>
          <DurationInput
            value={durationMinutes}
            onChange={setDurationMinutes}
          />
          <div>
            <label className="block text-[11px] font-medium text-on-surface-variant mb-1.5 uppercase tracking-wide">
              Anchor
            </label>
            <select
              value={anchor}
              onChange={(e) => setAnchor(e.target.value as FlexAnchor)}
              className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="none">No anchor — estimate from upstream</option>
              <option value="arrival">Anchor arrival time</option>
              <option value="departure">Anchor departure time</option>
            </select>
          </div>
          {anchor === "arrival" && (
            <DateTimePicker
              label="Anchored arrival"
              value={arrivalTime}
              onChange={setArrivalTime}
              datetimeFormat={datetimeFormat}
              dateFormat={dateFormat}
              timezone={tz}
              icon="arrival"
            />
          )}
          {anchor === "departure" && (
            <DateTimePicker
              label="Anchored departure"
              value={departureTime}
              onChange={setDepartureTime}
              datetimeFormat={datetimeFormat}
              dateFormat={dateFormat}
              timezone={tz}
              icon="departure"
            />
          )}
        </>
      )}

      {/* Live impact panel */}
      <div aria-live="polite" aria-atomic="true">
        {hasImpact && (
          <div className="space-y-2 rounded-xl bg-surface-low/70 p-3">
            <p className="text-[11px] font-semibold text-on-surface-variant uppercase tracking-wide">
              Impact on the rest of the trip
            </p>

            {impactDiff.shifts.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-secondary">
                  {impactDiff.shifts.length === 1
                    ? "1 stop will shift"
                    : `${impactDiff.shifts.length} stops will shift`}
                </p>
                <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                  {impactDiff.shifts.slice(0, 6).map((s) => (
                    <li
                      key={s.id}
                      className="text-[11px] text-on-surface-variant leading-tight"
                    >
                      {formatShiftDescription(s)}
                    </li>
                  ))}
                  {impactDiff.shifts.length > 6 && (
                    <li className="text-[11px] text-on-surface-variant italic">
                      +{impactDiff.shifts.length - 6} more
                    </li>
                  )}
                </ul>
              </div>
            )}

            {impactDiff.conflicts.length > 0 && (
              <div className="space-y-1 rounded-lg bg-tertiary-container/30 p-2">
                <p className="text-[11px] font-medium text-on-tertiary-container">
                  {impactDiff.conflicts.length === 1
                    ? "1 conflict with a fixed time"
                    : `${impactDiff.conflicts.length} conflicts with fixed times`}
                </p>
                <ul className="space-y-0.5">
                  {impactDiff.conflicts.map((c) => (
                    <li
                      key={c.id}
                      className="text-[11px] text-on-tertiary-container leading-tight"
                    >
                      <span className="font-medium">{c.name}:</span>{" "}
                      {formatConflictDescription(c)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {impactDiff.overnightHolds.length > 0 && (
              <div className="space-y-1 rounded-lg bg-tertiary-container/30 p-2">
                <p className="text-[11px] font-medium text-on-tertiary-container">
                  New overnight holds
                </p>
                <ul className="space-y-0.5">
                  {impactDiff.overnightHolds.map((h) => (
                    <li
                      key={h.id}
                      className="text-[11px] text-on-tertiary-container leading-tight"
                    >
                      <span className="font-medium">{h.name}</span> — {overnightLabel(h.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {impactDiff.conflicts.length > 0 &&
              shiftButtonLabel &&
              onShiftFollowing && (
                <button
                  type="button"
                  onClick={handleShiftFollowing}
                  className="w-full rounded-lg bg-surface-lowest px-3 py-2 text-[11px] font-semibold text-primary shadow-soft transition-all active:scale-[0.98]"
                >
                  {shiftButtonLabel}
                </button>
              )}
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={departureBeforeArrival}
          className="flex-1 rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={handleCancel}
          className="flex-1 rounded-xl bg-surface-high px-4 py-2.5 text-sm font-semibold text-on-surface-variant"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
