"use client";

import { useEffect, useMemo, useState } from "react";
import { type DocumentData } from "firebase/firestore";
import {
  PlacesAutocomplete,
  inferNodeType,
  type PlaceResult,
} from "@/components/map/places-autocomplete";
import { useDirections } from "@/lib/use-directions";
import { utcToLocalInput, localInputToUtc, type DateFormatPreference } from "@/lib/dates";
import { ConnectionSelector } from "@/components/dag/connection-selector";
import {
  TimingFieldsSection,
  type TimingFieldsValue,
  type TimingMode,
  type FlexAnchor,
} from "@/components/dag/timing-fields-section";

export type CreateContext =
  | { type: "standalone" }
  | { type: "insert"; edgeId: string; fromNode: DocumentData; toNode: DocumentData }
  | { type: "branch"; sourceNode: DocumentData };

export interface CreateNodeFormProps {
  context: CreateContext;
  initialPlace?: PlaceResult | null;
  allNodes: DocumentData[];
  allEdges?: DocumentData[];
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  onSubmit: (data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    duration_minutes: number | null;
    connect_after_node_id: string | null;
    connect_before_node_id: string | null;
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
    route_polyline: string | null;
  }) => void;
  onSplitEdge?: (
    edgeId: string,
    data: {
      name: string;
      type: string;
      lat: number;
      lng: number;
      place_id: string | null;
      arrival_time: string | null;
      departure_time: string | null;
      duration_minutes: number | null;
      leg_a: {
        travel_mode: string;
        travel_time_hours: number | null;
        distance_km: number | null;
        route_polyline: string | null;
      } | null;
      leg_b: {
        travel_mode: string;
        travel_time_hours: number | null;
        distance_km: number | null;
        route_polyline: string | null;
      } | null;
    },
  ) => void;
  onSubmitConnected?: (data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    duration_minutes: number | null;
    incoming: {
      node_id: string;
      travel_mode: string;
      travel_time_hours: number;
      distance_km: number | null;
      route_polyline: string | null;
    }[];
    outgoing: {
      node_id: string;
      travel_mode: string;
      travel_time_hours: number;
      distance_km: number | null;
      route_polyline: string | null;
    }[];
  }) => void;
  onSubmitBranch?: (data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    duration_minutes: number | null;
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
    route_polyline: string | null;
    connect_to_node_id: string | null;
  }) => void;
  onCancel: () => void;
}

const NODE_TYPES = [
  { value: "city", label: "City" },
  { value: "hotel", label: "Hotel" },
  { value: "restaurant", label: "Restaurant" },
  { value: "place", label: "Place" },
  { value: "activity", label: "Activity" },
];

const DEFAULT_FLEXIBLE_DURATION_MINUTES = 120;

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

function deriveTimingPayload(v: TimingFieldsValue) {
  if (v.mode === "fixed") {
    return {
      arrival_time: v.arrivalTime ? localInputToUtc(v.arrivalTime) : null,
      departure_time: v.departureTime ? localInputToUtc(v.departureTime) : null,
      duration_minutes: null,
    };
  }
  return {
    arrival_time:
      v.anchor === "arrival" && v.arrivalTime
        ? localInputToUtc(v.arrivalTime)
        : null,
    departure_time:
      v.anchor === "departure" && v.departureTime
        ? localInputToUtc(v.departureTime)
        : null,
    duration_minutes: v.durationMinutes,
  };
}

export function CreateNodeForm({
  context,
  initialPlace,
  allNodes,
  allEdges,
  datetimeFormat = "24h",
  dateFormat = "eu",
  onSubmit,
  onSplitEdge,
  onSubmitConnected,
  onSubmitBranch,
  onCancel,
}: CreateNodeFormProps) {
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(
    initialPlace ?? null,
  );
  const [displayName, setDisplayName] = useState(initialPlace?.name ?? "");
  const [locationState, setLocationState] = useState<
    "empty" | "chip" | "searching"
  >(initialPlace && initialPlace.name ? "chip" : "empty");
  const [searchKey, setSearchKey] = useState(0);

  const [type, setType] = useState(
    initialPlace ? inferNodeType(initialPlace.types) : "place",
  );

  // Timing state
  const [timing, setTiming] = useState<TimingFieldsValue>({
    mode: "flexible" as TimingMode,
    anchor: "none" as FlexAnchor,
    arrivalTime: "",
    departureTime: "",
    durationMinutes: DEFAULT_FLEXIBLE_DURATION_MINUTES,
  });

  // Connection state (standalone mode only)
  const [connectionMode, setConnectionMode] = useState<"simple" | "advanced">(
    "simple",
  );
  const [incomingNodes, setIncomingNodes] = useState<string[]>([]);
  const [outgoingNodes, setOutgoingNodes] = useState<string[]>([]);
  const [connectMode, setConnectMode] = useState<"after" | "before">("after");
  const [connectAfterNodeId, setConnectAfterNodeId] = useState("");
  const [connectBeforeNodeId, setConnectBeforeNodeId] = useState("");

  // Branch reconnect state
  const [connectToNodeId, setConnectToNodeId] = useState("");

  const activeConnectionId =
    connectMode === "after" ? connectAfterNodeId : connectBeforeNodeId;

  const targetNode = useMemo(
    () =>
      activeConnectionId
        ? allNodes.find((n) => n.id === activeConnectionId)
        : null,
    [allNodes, activeConnectionId],
  );

  // Travel data computation for standalone mode
  const originCoords = useMemo(() => {
    if (context.type !== "standalone" && context.type !== "branch") return null;
    if (context.type === "branch") {
      return context.sourceNode.lat_lng
        ? { lat: context.sourceNode.lat_lng.lat, lng: context.sourceNode.lat_lng.lng }
        : null;
    }
    if (!targetNode?.lat_lng || !selectedPlace) return null;
    if (connectMode === "after") {
      return { lat: targetNode.lat_lng.lat, lng: targetNode.lat_lng.lng };
    }
    return { lat: selectedPlace.lat, lng: selectedPlace.lng };
  }, [context, targetNode, selectedPlace, connectMode]);

  const destCoords = useMemo(() => {
    if (context.type === "branch") {
      return selectedPlace
        ? { lat: selectedPlace.lat, lng: selectedPlace.lng }
        : null;
    }
    if (context.type !== "standalone") return null;
    if (!targetNode?.lat_lng || !selectedPlace) return null;
    if (connectMode === "after") {
      return { lat: selectedPlace.lat, lng: selectedPlace.lng };
    }
    return { lat: targetNode.lat_lng.lat, lng: targetNode.lat_lng.lng };
  }, [context, targetNode, selectedPlace, connectMode]);

  const { travelData, loading: travelLoading } = useDirections(
    originCoords,
    destCoords,
  );

  // Insert-between mode: compute travel data for both legs
  const legAOrigin = useMemo(() => {
    if (context.type !== "insert" || !selectedPlace) return null;
    return context.fromNode.lat_lng
      ? { lat: context.fromNode.lat_lng.lat, lng: context.fromNode.lat_lng.lng }
      : null;
  }, [context, selectedPlace]);

  const legADest = useMemo(() => {
    if (context.type !== "insert" || !selectedPlace) return null;
    return { lat: selectedPlace.lat, lng: selectedPlace.lng };
  }, [context, selectedPlace]);

  const legBOrigin = useMemo(() => {
    if (context.type !== "insert" || !selectedPlace) return null;
    return { lat: selectedPlace.lat, lng: selectedPlace.lng };
  }, [context, selectedPlace]);

  const legBDest = useMemo(() => {
    if (context.type !== "insert" || !selectedPlace) return null;
    return context.toNode.lat_lng
      ? { lat: context.toNode.lat_lng.lat, lng: context.toNode.lat_lng.lng }
      : null;
  }, [context, selectedPlace]);

  const { travelData: legATravelData, loading: legALoading } = useDirections(
    context.type === "insert" ? legAOrigin : null,
    context.type === "insert" ? legADest : null,
  );
  const { travelData: legBTravelData, loading: legBLoading } = useDirections(
    context.type === "insert" ? legBOrigin : null,
    context.type === "insert" ? legBDest : null,
  );

  // Earliest arrival computation
  const sourceNodeForArrival = useMemo(() => {
    if (context.type === "branch") return context.sourceNode;
    if (context.type === "standalone" && connectMode === "after" && targetNode)
      return targetNode;
    return null;
  }, [context, connectMode, targetNode]);

  const earliestArrival = useMemo(() => {
    if (!sourceNodeForArrival || !travelData) return null;
    const dep =
      sourceNodeForArrival.departure_time ?? sourceNodeForArrival.arrival_time;
    if (!dep) return null;
    const depMs = new Date(dep).getTime();
    return new Date(depMs + travelData.travel_time_hours * 3_600_000);
  }, [sourceNodeForArrival, travelData]);

  useEffect(() => {
    if (earliestArrival && !timing.arrivalTime) {
      setTiming((prev) => ({
        ...prev,
        arrivalTime: utcToLocalInput(earliestArrival.toISOString()),
      }));
    }
  }, [earliestArrival, timing.arrivalTime]);

  const timingWarning = useMemo(() => {
    if (!earliestArrival || !timing.arrivalTime) return null;
    const userArrival = new Date(timing.arrivalTime).getTime();
    const earliestTruncated =
      Math.floor(earliestArrival.getTime() / 60_000) * 60_000;
    const diffMin = Math.round((earliestTruncated - userArrival) / 60_000);
    if (diffMin > 10) {
      const diffStr =
        diffMin >= 60
          ? `${Math.round(diffMin / 6) / 10}h`
          : `${diffMin} min`;
      return `Arrival is ${diffStr} too early for the estimated travel time`;
    }
    return null;
  }, [earliestArrival, timing.arrivalTime]);

  function handlePlaceSelect(place: PlaceResult) {
    setSelectedPlace(place);
    setType(inferNodeType(place.types));
    setLocationState("chip");
    if (context.type === "branch") {
      setTiming((prev) => ({ ...prev, arrivalTime: "" }));
    }
    setDisplayName(place.name);
  }


  const departureBeforeArrival =
    !!timing.arrivalTime &&
    !!timing.departureTime &&
    timing.departureTime <= timing.arrivalTime;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPlace) return;
    if (timing.mode === "fixed" && departureBeforeArrival) return;

    const timingPayload = deriveTimingPayload(timing);

    // Insert-between mode
    if (context.type === "insert" && onSplitEdge) {
      onSplitEdge(context.edgeId, {
        name: displayName.trim() || selectedPlace.name,
        type,
        lat: selectedPlace.lat,
        lng: selectedPlace.lng,
        place_id: selectedPlace.placeId,
        ...timingPayload,
        leg_a: legATravelData
          ? {
              travel_mode: legATravelData.travel_mode,
              travel_time_hours: legATravelData.travel_time_hours,
              distance_km: legATravelData.distance_km,
              route_polyline: legATravelData.route_polyline,
            }
          : null,
        leg_b: legBTravelData
          ? {
              travel_mode: legBTravelData.travel_mode,
              travel_time_hours: legBTravelData.travel_time_hours,
              distance_km: legBTravelData.distance_km,
              route_polyline: legBTravelData.route_polyline,
            }
          : null,
      });
      return;
    }

    // Branch mode
    if (context.type === "branch" && onSubmitBranch) {
      onSubmitBranch({
        name: displayName.trim() || selectedPlace.name,
        type,
        lat: selectedPlace.lat,
        lng: selectedPlace.lng,
        place_id: selectedPlace.placeId,
        ...timingPayload,
        travel_mode: travelData?.travel_mode ?? "drive",
        travel_time_hours: travelData?.travel_time_hours ?? 1,
        distance_km: travelData?.distance_km ?? null,
        route_polyline: travelData?.route_polyline ?? null,
        connect_to_node_id: connectToNodeId || null,
      });
      return;
    }

    // Multi-connection mode
    if (connectionMode === "advanced" && onSubmitConnected) {
      onSubmitConnected({
        name: displayName.trim() || selectedPlace.name,
        type,
        lat: selectedPlace.lat,
        lng: selectedPlace.lng,
        place_id: selectedPlace.placeId,
        ...timingPayload,
        incoming: incomingNodes.map((nid) => ({
          node_id: nid,
          travel_mode: "drive",
          travel_time_hours: 1,
          distance_km: null,
          route_polyline: null,
        })),
        outgoing: outgoingNodes.map((nid) => ({
          node_id: nid,
          travel_mode: "drive",
          travel_time_hours: 1,
          distance_km: null,
          route_polyline: null,
        })),
      });
      return;
    }

    // Standard single-connection mode
    onSubmit({
      name: displayName.trim() || selectedPlace.name,
      type,
      lat: selectedPlace.lat,
      lng: selectedPlace.lng,
      place_id: selectedPlace.placeId,
      ...timingPayload,
      connect_after_node_id:
        connectMode === "after" ? connectAfterNodeId || null : null,
      connect_before_node_id:
        connectMode === "before" ? connectBeforeNodeId || null : null,
      travel_mode: travelData?.travel_mode ?? "drive",
      travel_time_hours: travelData?.travel_time_hours ?? 1,
      distance_km: travelData?.distance_km ?? null,
      route_polyline: travelData?.route_polyline ?? null,
    });
  }

  const isInsert = context.type === "insert";
  const isBranch = context.type === "branch";

  const title = isInsert
    ? "Insert Stop"
    : isBranch
      ? "Side Trip"
      : "Add Stop";

  const subtitle = isInsert
    ? `Between ${context.fromNode.name} and ${context.toNode.name}`
    : isBranch
      ? `From ${context.sourceNode.name}`
      : selectedPlace && selectedPlace.name
        ? `${selectedPlace.lat.toFixed(4)}, ${selectedPlace.lng.toFixed(4)}`
        : null;

  const travelLabel =
    isBranch
      ? `Travel from ${context.sourceNode.name}`
      : connectMode === "after"
        ? `Travel from ${targetNode?.name ?? "source"}`
        : `Travel to ${targetNode?.name ?? "destination"}`;

  const locationBias = useMemo(() => {
    if (isBranch) return context.sourceNode.lat_lng ?? undefined;
    if (selectedPlace) return { lat: selectedPlace.lat, lng: selectedPlace.lng };
    return targetNode?.lat_lng ?? undefined;
  }, [context, isBranch, selectedPlace, targetNode]);

  const isSubmitDisabled =
    !selectedPlace ||
    departureBeforeArrival ||
    (context.type === "standalone" &&
      connectionMode === "simple" &&
      !!activeConnectionId &&
      travelLoading) ||
    (context.type === "branch" && travelLoading) ||
    (context.type === "insert" && (legALoading || legBLoading));

  const otherNodes = isBranch
    ? allNodes.filter((n) => n.id !== context.sourceNode.id)
    : allNodes;

  return (
    <div
      className={
        isBranch
          ? ""
          : "absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up max-h-[70vh] flex flex-col"
      }
    >
      {!isBranch && (
        <>
          <div className="flex justify-center pt-3 pb-1 shrink-0">
            <div className="h-1 w-10 rounded-full bg-surface-high" />
          </div>
          <div className="flex items-center justify-between px-4 pt-2 pb-2 shrink-0">
            <div>
              <h2 className="text-base font-semibold text-on-surface">
                {title}
              </h2>
              {subtitle && (
                <p className="text-xs text-on-surface-variant">{subtitle}</p>
              )}
            </div>
            <button
              onClick={onCancel}
              className="h-8 w-8 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </>
      )}

      <form
        onSubmit={handleSubmit}
        className={`space-y-3 px-4 pb-4 ${!isBranch ? "overflow-y-auto min-h-0" : ""}`}
      >
        {isBranch && (
          <p className="text-xs text-on-surface-variant">
            New side trip from{" "}
            <span className="font-semibold">{context.sourceNode.name}</span>
          </p>
        )}

        {/* Row 1: Name + Type */}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <label className="block text-xs text-on-surface-variant mb-1">
              Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Give this stop a name"
              autoFocus={!initialPlace}
              className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="block text-xs text-on-surface-variant mb-1">
              Type
            </label>
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
          <label className="block text-xs text-on-surface-variant mb-1">
            Location
          </label>
          {locationState === "empty" && (
            <button
              type="button"
              onClick={() => setLocationState("searching")}
              className="w-full rounded-xl border border-dashed border-outline-variant/50 px-3 py-2.5 flex items-center gap-2 text-sm text-on-surface-variant hover:bg-surface-low transition-colors"
            >
              <PinIcon />
              <span>Pin to a specific place</span>
            </button>
          )}
          {locationState === "chip" && selectedPlace && (
            <div className="rounded-xl bg-primary/[0.08] px-3 py-2 flex items-center gap-2 animate-fade-in">
              <PinIcon colored />
              <span className="flex-1 text-sm font-medium text-on-surface truncate">
                {selectedPlace.name}
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
                  initialValue={selectedPlace?.name ?? ""}
                  placeholder="Search for a place..."
                  autoFocus
                  locationBias={locationBias}
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  setLocationState(selectedPlace ? "chip" : "empty")
                }
                className="shrink-0 text-xs text-on-surface-variant hover:text-on-surface transition-colors ml-1"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Timing section — full four-shape model for all contexts */}
        <TimingFieldsSection
          value={timing}
          onChange={setTiming}
          datetimeFormat={datetimeFormat}
          dateFormat={dateFormat}
          showValidation={timing.mode === "fixed"}
        />

        {/* Context-specific sections */}

        {/* Insert-between: locked connection card + leg data */}
        {isInsert && (
          <>
            <div className="rounded-xl bg-surface-low p-3">
              <p className="text-xs font-semibold text-on-surface-variant mb-2">
                Inserting between
              </p>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-lg bg-surface-high px-2.5 py-1.5 text-xs font-medium text-on-surface border-l-2 border-primary">
                  {context.fromNode.name}
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#9ca3af"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M15 6l6 6-6 6" />
                </svg>
                <span className="flex items-center gap-1.5 rounded-lg bg-surface-high px-2.5 py-1.5 text-xs font-medium text-on-surface border-l-2 border-primary">
                  {context.toNode.name}
                </span>
              </div>
            </div>

            {selectedPlace && legATravelData && (
              <TravelSummary
                label={`Travel from ${context.fromNode.name}`}
                data={legATravelData}
              />
            )}
            {selectedPlace && legBTravelData && (
              <TravelSummary
                label={`Travel to ${context.toNode.name}`}
                data={legBTravelData}
              />
            )}
            {selectedPlace && (legALoading || legBLoading) && (
              <LoadingSpinner label="Computing travel routes..." />
            )}
          </>
        )}

        {/* Standalone: connection selector */}
        {context.type === "standalone" && (
          <>
            {connectionMode === "simple" ? (
              <div>
                <label className="block text-xs text-on-surface-variant mb-1.5">
                  Connection
                </label>
                <div className="flex rounded-xl bg-surface-high p-0.5 gap-0.5 mb-2">
                  {(["after", "before"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        setConnectMode(mode);
                        if (mode === "after") {
                          setConnectBeforeNodeId("");
                        } else {
                          setConnectAfterNodeId("");
                        }
                      }}
                      className={`flex-1 rounded-[10px] px-3 py-1.5 text-xs font-semibold transition-all ${
                        connectMode === mode
                          ? "bg-surface-lowest text-on-surface shadow-soft"
                          : "text-on-surface-variant"
                      }`}
                    >
                      {mode === "after" ? "After node" : "Before node"}
                    </button>
                  ))}
                </div>

                <select
                  value={
                    connectMode === "after"
                      ? connectAfterNodeId
                      : connectBeforeNodeId
                  }
                  onChange={(e) => {
                    if (connectMode === "after") {
                      setConnectAfterNodeId(e.target.value);
                      if (e.target.value)
                        setTiming((prev) => ({ ...prev, arrivalTime: "" }));
                    } else {
                      setConnectBeforeNodeId(e.target.value);
                    }
                  }}
                  className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">None (standalone)</option>
                  {allNodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </select>

                {connectMode === "before" && connectBeforeNodeId && (
                  <p className="mt-1 text-xs text-on-surface-variant px-1">
                    This node will be inserted before the selected node.
                  </p>
                )}

                {allNodes.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setConnectionMode("advanced")}
                    className="mt-2 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    Add more connections
                  </button>
                )}
              </div>
            ) : (
              <ConnectionSelector
                allNodes={allNodes}
                allEdges={allEdges ?? []}
                incomingNodes={incomingNodes}
                outgoingNodes={outgoingNodes}
                onIncomingChange={setIncomingNodes}
                onOutgoingChange={setOutgoingNodes}
                onSwitchToSimple={() => setConnectionMode("simple")}
              />
            )}

            {connectionMode === "simple" &&
              activeConnectionId &&
              selectedPlace &&
              travelData && (
                <TravelSummary label={travelLabel} data={travelData} />
              )}

            {connectionMode === "simple" &&
              activeConnectionId &&
              selectedPlace &&
              travelLoading && (
                <LoadingSpinner label="Computing travel route..." />
              )}
          </>
        )}

        {/* Branch: travel data + reconnect picker */}
        {isBranch && (
          <>
            {selectedPlace && travelData && (
              <TravelSummary label={travelLabel} data={travelData} />
            )}
            {selectedPlace && travelLoading && (
              <LoadingSpinner label="Computing travel route..." />
            )}

            <div>
              <label className="block text-xs text-on-surface-variant mb-1">
                Rejoin at (optional)
              </label>
              <select
                value={connectToNodeId}
                onChange={(e) => setConnectToNodeId(e.target.value)}
                className="w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">None (open branch)</option>
                {otherNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {timingWarning && (
          <div className="rounded-xl bg-tertiary-container/15 p-2.5 text-xs text-on-surface-variant">
            {timingWarning}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={isSubmitDisabled}
            className="flex-1 rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {title}
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
    </div>
  );
}

function TravelSummary({
  label,
  data,
}: {
  label: string;
  data: {
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
  };
}) {
  return (
    <div className="rounded-xl bg-surface-low p-2.5 text-xs text-on-surface-variant space-y-1">
      <p className="font-semibold text-on-surface">{label}</p>
      <div className="flex gap-3">
        <span>
          {data.travel_mode === "flight"
            ? "\u2708\uFE0F"
            : data.travel_mode === "walk"
              ? "\u{1F6B6}"
              : data.travel_mode === "transit"
                ? "\u{1F68C}"
                : "\u{1F697}"}{" "}
          {data.travel_mode}
        </span>
        <span>
          {data.travel_time_hours >= 1
            ? `${Math.round(data.travel_time_hours * 10) / 10}h`
            : `${Math.round(data.travel_time_hours * 60)} min`}
        </span>
        {data.distance_km != null && (
          <span>{Math.round(data.distance_km)} km</span>
        )}
      </div>
    </div>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-on-surface-variant px-1">
      <div className="h-3 w-3 animate-spin rounded-full border-2 border-outline-variant border-t-on-surface-variant" />
      {label}
    </div>
  );
}
