"use client";

import { useEffect, useState } from "react";
import { useMapsLibrary } from "@vis.gl/react-google-maps";
import {
  utcToLocalInput,
  localInputToUtc,
  type DateFormatPreference,
} from "@/lib/dates";
import {
  PlacesAutocomplete,
  type PlaceResult,
} from "@/components/map/places-autocomplete";
import { DateTimePicker } from "@/components/ui/datetime-picker";

interface NodeEditFormProps {
  node: {
    id: string;
    name: string;
    type: string;
    arrival_time: string | null;
    departure_time: string | null;
    lat_lng?: { lat: number; lng: number } | null;
    [key: string]: unknown;
  };
  userRole: string;
  plannerReadOnly?: boolean;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  onSave: (updates: Record<string, unknown>) => void;
  onCancel: () => void;
  onProposeChanges?: () => void;
}

const NODE_TYPES = [
  { value: "city", label: "City" },
  { value: "hotel", label: "Hotel" },
  { value: "restaurant", label: "Restaurant" },
  { value: "place", label: "Place" },
  { value: "activity", label: "Activity" },
];

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

export function NodeEditForm({
  node,
  userRole,
  plannerReadOnly = false,
  datetimeFormat = "24h",
  dateFormat = "eu",
  onSave,
  onCancel,
  onProposeChanges,
}: NodeEditFormProps) {
  const tz = (node as Record<string, unknown>).timezone as string | undefined;
  const [name, setName] = useState(node.name);
  const [type, setType] = useState(node.type);
  const [arrivalTime, setArrivalTime] = useState(
    utcToLocalInput(node.arrival_time, tz),
  );
  const [departureTime, setDepartureTime] = useState(
    utcToLocalInput(node.departure_time, tz),
  );
  const [locationUpdate, setLocationUpdate] = useState<PlaceResult | null>(null);
  const [locationState, setLocationState] = useState<"chip" | "searching">("chip");
  const [searchKey, setSearchKey] = useState(0);

  // Resolve place_id to Google Place display name on mount
  const places = useMapsLibrary("places");
  const [resolvedPlaceName, setResolvedPlaceName] = useState<string | null>(null);

  useEffect(() => {
    if (!places || !node.place_id || locationUpdate) return;
    const p = new places.Place({ id: node.place_id as string });
    p.fetchFields({ fields: ["displayName"] }).then(() => {
      if (p.displayName) setResolvedPlaceName(p.displayName);
    }).catch(() => {});
  }, [places, node.place_id, locationUpdate]);

  // The chip label: show resolved Google Place name when anchored, otherwise node name
  const chipLabel = locationUpdate
    ? locationUpdate.name
    : (resolvedPlaceName ?? node.name);

  // Search initial value: resolved Google name if anchored, empty if no place_id
  const searchInitialValue = locationUpdate
    ? locationUpdate.name
    : node.place_id
      ? (resolvedPlaceName ?? node.name)
      : "";

  const departureBeforeArrival =
    !!arrivalTime && !!departureTime && departureTime <= arrivalTime;

  if (plannerReadOnly) {
    return (
      <div className="px-4 py-3 mx-4 mb-4 bg-tertiary-container/15 rounded-xl space-y-3">
        <p className="text-sm text-on-surface-variant">
          This is the live plan. To make changes, work in a draft version.
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
          You don&apos;t have permission to edit nodes. Only Admins and Planners
          can make changes.
        </p>
      </div>
    );
  }

  function handlePlaceSelect(place: PlaceResult) {
    setLocationUpdate(place);
    setLocationState("chip");
    // Name is intentionally NOT auto-filled — user owns the name in edit mode
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (departureBeforeArrival) return;
    const updates: Record<string, unknown> = {};
    const newArrival = localInputToUtc(arrivalTime, tz);
    const newDeparture = localInputToUtc(departureTime, tz);

    if (name.trim() && name !== node.name) {
      updates.name = name.trim();
    }
    if (type !== node.type) {
      updates.type = type;
    }
    if (newArrival && newArrival !== node.arrival_time) {
      updates.arrival_time = newArrival;
    }
    if (newDeparture && newDeparture !== node.departure_time) {
      updates.departure_time = newDeparture;
    }
    if (locationUpdate) {
      updates.lat = locationUpdate.lat;
      updates.lng = locationUpdate.lng;
      updates.place_id = locationUpdate.placeId;
    }
    if (Object.keys(updates).length > 0) {
      onSave(updates);
    }
  }

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

      {/* Row 2: Location slot (always starts as chip) */}
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
          onClick={onCancel}
          className="flex-1 rounded-xl bg-surface-high px-4 py-2.5 text-sm font-semibold text-on-surface-variant"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
