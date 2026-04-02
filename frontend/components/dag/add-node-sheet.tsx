"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type DocumentData } from "firebase/firestore";
import {
  PlacesAutocomplete,
  inferNodeType,
  type PlaceResult,
} from "@/components/map/places-autocomplete";
import { useDirections } from "@/lib/use-directions";
import {
  utcToLocalInput,
  localInputToUtc,
  type DateFormatPreference,
} from "@/lib/dates";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { ConnectionSelector } from "@/components/dag/connection-selector";

export interface InsertBetweenData {
  edgeId: string;
  fromNode: DocumentData;
  toNode: DocumentData;
}

interface AddNodeSheetProps {
  initialPlace?: PlaceResult | null;
  allNodes: DocumentData[];
  allEdges?: DocumentData[];
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  insertBetween?: InsertBetweenData | null;
  onSubmit: (data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    connect_after_node_id: string | null;
    connect_before_node_id: string | null;
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
    route_polyline: string | null;
  }) => void;
  onSplitEdge?: (edgeId: string, data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    leg_a: { travel_mode: string; travel_time_hours: number | null; distance_km: number | null; route_polyline: string | null } | null;
    leg_b: { travel_mode: string; travel_time_hours: number | null; distance_km: number | null; route_polyline: string | null } | null;
  }) => void;
  onSubmitConnected?: (data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    incoming: { node_id: string; travel_mode: string; travel_time_hours: number; distance_km: number | null; route_polyline: string | null }[];
    outgoing: { node_id: string; travel_mode: string; travel_time_hours: number; distance_km: number | null; route_polyline: string | null }[];
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

export function AddNodeSheet({
  initialPlace,
  allNodes,
  allEdges,
  datetimeFormat = "24h",
  dateFormat = "eu",
  insertBetween,
  onSubmit,
  onSplitEdge,
  onSubmitConnected,
  onCancel,
}: AddNodeSheetProps) {
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(
    initialPlace ?? null,
  );
  const [displayName, setDisplayName] = useState(initialPlace?.name ?? "");
  const [locationState, setLocationState] = useState<"empty" | "chip" | "searching">(
    initialPlace ? "chip" : "empty",
  );
  const [searchKey, setSearchKey] = useState(0);
  const nameAutoFilledRef = useRef(false);

  const [type, setType] = useState(
    initialPlace ? inferNodeType(initialPlace.types) : "place",
  );
  const [arrivalTime, setArrivalTime] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  // Multi-connection state (Feature 2)
  const [connectionMode, setConnectionMode] = useState<"simple" | "advanced">("simple");
  const [incomingNodes, setIncomingNodes] = useState<string[]>([]);
  const [outgoingNodes, setOutgoingNodes] = useState<string[]>([]);

  const [connectMode, setConnectMode] = useState<"after" | "before">("after");
  const [connectAfterNodeId, setConnectAfterNodeId] = useState("");
  const [connectBeforeNodeId, setConnectBeforeNodeId] = useState("");

  const activeConnectionId =
    connectMode === "after" ? connectAfterNodeId : connectBeforeNodeId;

  const targetNode = useMemo(
    () =>
      activeConnectionId
        ? allNodes.find((n) => n.id === activeConnectionId)
        : null,
    [allNodes, activeConnectionId],
  );

  const originCoords = useMemo(() => {
    if (!targetNode?.lat_lng || !selectedPlace) return null;
    if (connectMode === "after") {
      return { lat: targetNode.lat_lng.lat, lng: targetNode.lat_lng.lng };
    }
    return { lat: selectedPlace.lat, lng: selectedPlace.lng };
  }, [targetNode, selectedPlace, connectMode]);

  const destCoords = useMemo(() => {
    if (!targetNode?.lat_lng || !selectedPlace) return null;
    if (connectMode === "after") {
      return { lat: selectedPlace.lat, lng: selectedPlace.lng };
    }
    return { lat: targetNode.lat_lng.lat, lng: targetNode.lat_lng.lng };
  }, [targetNode, selectedPlace, connectMode]);

  const { travelData, loading: travelLoading } = useDirections(
    originCoords,
    destCoords,
  );

  // Insert-between mode: compute travel data for both legs
  const legAOrigin = useMemo(() => {
    if (!insertBetween?.fromNode?.lat_lng || !selectedPlace) return null;
    return { lat: insertBetween.fromNode.lat_lng.lat, lng: insertBetween.fromNode.lat_lng.lng };
  }, [insertBetween, selectedPlace]);

  const legADest = useMemo(() => {
    if (!insertBetween || !selectedPlace) return null;
    return { lat: selectedPlace.lat, lng: selectedPlace.lng };
  }, [insertBetween, selectedPlace]);

  const legBOrigin = useMemo(() => {
    if (!insertBetween || !selectedPlace) return null;
    return { lat: selectedPlace.lat, lng: selectedPlace.lng };
  }, [insertBetween, selectedPlace]);

  const legBDest = useMemo(() => {
    if (!insertBetween?.toNode?.lat_lng || !selectedPlace) return null;
    return { lat: insertBetween.toNode.lat_lng.lat, lng: insertBetween.toNode.lat_lng.lng };
  }, [insertBetween, selectedPlace]);

  const { travelData: legATravelData, loading: legALoading } = useDirections(
    insertBetween ? legAOrigin : null,
    insertBetween ? legADest : null,
  );
  const { travelData: legBTravelData, loading: legBLoading } = useDirections(
    insertBetween ? legBOrigin : null,
    insertBetween ? legBDest : null,
  );

  const earliestArrival = useMemo(() => {
    if (connectMode !== "after" || !targetNode || !travelData) return null;
    const dep =
      targetNode.departure_time ??
      targetNode.arrival_time;
    if (!dep) return null;
    const depMs = new Date(dep).getTime();
    return new Date(depMs + travelData.travel_time_hours * 3_600_000);
  }, [connectMode, targetNode, travelData]);

  useEffect(() => {
    if (earliestArrival && !arrivalTime) {
      setArrivalTime(utcToLocalInput(earliestArrival.toISOString()));
    }
  }, [earliestArrival, arrivalTime]);

  const timingWarning = useMemo(() => {
    if (!earliestArrival || !arrivalTime) return null;
    const userArrival = new Date(arrivalTime).getTime();
    const earliestTruncated = Math.floor(earliestArrival.getTime() / 60_000) * 60_000;
    const diffMin = Math.round((earliestTruncated - userArrival) / 60_000);
    if (diffMin > 10) {
      const diffStr =
        diffMin >= 60
          ? `${Math.round(diffMin / 6) / 10}h`
          : `${diffMin} min`;
      return `Arrival is ${diffStr} earlier than the estimated travel time allows`;
    }
    return null;
  }, [earliestArrival, arrivalTime]);

  function handlePlaceSelect(place: PlaceResult) {
    setSelectedPlace(place);
    setType(inferNodeType(place.types));
    setLocationState("chip");
    // Auto-fill name only if user hasn't typed anything yet
    if (displayName === "" && !nameAutoFilledRef.current) {
      setDisplayName(place.name);
      nameAutoFilledRef.current = true;
    }
  }

  function handleDisplayNameChange(value: string) {
    setDisplayName(value);
    nameAutoFilledRef.current = false;
  }

  function handleArrivalChange(value: string) {
    setArrivalTime(value);
    if (value && departureTime && value >= departureTime) {
      const d = new Date(value);
      d.setDate(d.getDate() + 1);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      setDepartureTime(`${yyyy}-${mm}-${dd}T${hh}:${min}`);
    }
  }

  const departureBeforeArrival =
    !!arrivalTime && !!departureTime && departureTime <= arrivalTime;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPlace || departureBeforeArrival) return;

    // Insert-between mode: split the edge
    if (insertBetween && onSplitEdge) {
      onSplitEdge(insertBetween.edgeId, {
        name: displayName.trim() || selectedPlace.name,
        type,
        lat: selectedPlace.lat,
        lng: selectedPlace.lng,
        place_id: selectedPlace.placeId,
        arrival_time: arrivalTime ? localInputToUtc(arrivalTime) : null,
        departure_time: departureTime ? localInputToUtc(departureTime) : null,
        leg_a: legATravelData ? {
          travel_mode: legATravelData.travel_mode,
          travel_time_hours: legATravelData.travel_time_hours,
          distance_km: legATravelData.distance_km,
          route_polyline: legATravelData.route_polyline,
        } : null,
        leg_b: legBTravelData ? {
          travel_mode: legBTravelData.travel_mode,
          travel_time_hours: legBTravelData.travel_time_hours,
          distance_km: legBTravelData.distance_km,
          route_polyline: legBTravelData.route_polyline,
        } : null,
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
        arrival_time: arrivalTime ? localInputToUtc(arrivalTime) : null,
        departure_time: departureTime ? localInputToUtc(departureTime) : null,
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
      arrival_time: arrivalTime ? localInputToUtc(arrivalTime) : null,
      departure_time: departureTime ? localInputToUtc(departureTime) : null,
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

  const travelLabel =
    connectMode === "after"
      ? `Travel from ${targetNode?.name ?? "source"}`
      : `Travel to ${targetNode?.name ?? "destination"}`;

  return (
    <div className="absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up max-h-[70vh] flex flex-col">
      <div className="flex justify-center pt-3 pb-1 shrink-0"><div className="h-1 w-10 rounded-full bg-surface-high" /></div>
      <div className="flex items-center justify-between px-4 pt-2 pb-2 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-on-surface">
            {insertBetween ? "Insert Stop" : "Add Node"}
          </h2>
          {insertBetween ? (
            <p className="text-xs text-on-surface-variant">
              Between {insertBetween.fromNode.name} and {insertBetween.toNode.name}
            </p>
          ) : selectedPlace ? (
            <p className="text-xs text-on-surface-variant">
              {selectedPlace.lat.toFixed(4)}, {selectedPlace.lng.toFixed(4)}
            </p>
          ) : null}
        </div>
        <button
          onClick={onCancel}
          className="h-8 w-8 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4 overflow-y-auto min-h-0">
        {/* Row 1: Name + Type */}
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <label className="block text-xs text-on-surface-variant mb-1">Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => handleDisplayNameChange(e.target.value)}
              placeholder="Give this stop a name"
              autoFocus={!initialPlace}
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
                  locationBias={
                    selectedPlace
                      ? { lat: selectedPlace.lat, lng: selectedPlace.lng }
                      : targetNode?.lat_lng ?? undefined
                  }
                />
              </div>
              <button
                type="button"
                onClick={() => setLocationState(selectedPlace ? "chip" : "empty")}
                className="shrink-0 text-xs text-on-surface-variant hover:text-on-surface transition-colors ml-1"
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <DateTimePicker
            label="Arrival"
            value={arrivalTime}
            onChange={handleArrivalChange}
            datetimeFormat={datetimeFormat}
            dateFormat={dateFormat}
            icon="arrival"
          />
          <DateTimePicker
            label="Departure"
            value={departureTime}
            onChange={setDepartureTime}
            datetimeFormat={datetimeFormat}
            dateFormat={dateFormat}
            icon="departure"
            error={departureBeforeArrival}
            errorMessage="Departure must be after arrival"
          />
        </div>

        {/* Insert-between mode: locked connection card */}
        {insertBetween && (
          <>
            <div className="rounded-xl bg-surface-low p-3">
              <p className="text-xs font-semibold text-on-surface-variant mb-2">Inserting between</p>
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-lg bg-surface-high px-2.5 py-1.5 text-xs font-medium text-on-surface border-l-2 border-primary">
                  {insertBetween.fromNode.name}
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M15 6l6 6-6 6" />
                </svg>
                <span className="flex items-center gap-1.5 rounded-lg bg-surface-high px-2.5 py-1.5 text-xs font-medium text-on-surface border-l-2 border-primary">
                  {insertBetween.toNode.name}
                </span>
              </div>
            </div>

            {/* Leg A travel data */}
            {selectedPlace && legATravelData && (
              <div className="rounded-xl bg-surface-low p-2.5 text-xs text-on-surface-variant space-y-1">
                <p className="font-semibold text-on-surface">Travel from {insertBetween.fromNode.name}</p>
                <div className="flex gap-3">
                  <span>{legATravelData.travel_mode}</span>
                  <span>{legATravelData.travel_time_hours >= 1 ? `${Math.round(legATravelData.travel_time_hours * 10) / 10}h` : `${Math.round(legATravelData.travel_time_hours * 60)} min`}</span>
                  {legATravelData.distance_km != null && <span>{Math.round(legATravelData.distance_km)} km</span>}
                </div>
              </div>
            )}
            {/* Leg B travel data */}
            {selectedPlace && legBTravelData && (
              <div className="rounded-xl bg-surface-low p-2.5 text-xs text-on-surface-variant space-y-1">
                <p className="font-semibold text-on-surface">Travel to {insertBetween.toNode.name}</p>
                <div className="flex gap-3">
                  <span>{legBTravelData.travel_mode}</span>
                  <span>{legBTravelData.travel_time_hours >= 1 ? `${Math.round(legBTravelData.travel_time_hours * 10) / 10}h` : `${Math.round(legBTravelData.travel_time_hours * 60)} min`}</span>
                  {legBTravelData.distance_km != null && <span>{Math.round(legBTravelData.distance_km)} km</span>}
                </div>
              </div>
            )}
            {selectedPlace && (legALoading || legBLoading) && (
              <div className="flex items-center gap-2 text-xs text-on-surface-variant px-1">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-outline-variant border-t-on-surface-variant" />
                Computing travel routes...
              </div>
            )}
          </>
        )}

        {/* Connection section (non-insert mode) */}
        {!insertBetween && (
          <>
            {connectionMode === "simple" ? (
              <>
                {/* Simple connection: after/before segmented control */}
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
                            setArrivalTime("");
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
                    value={connectMode === "after" ? connectAfterNodeId : connectBeforeNodeId}
                    onChange={(e) => {
                      if (connectMode === "after") {
                        setConnectAfterNodeId(e.target.value);
                        if (e.target.value) setArrivalTime("");
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
              </>
            ) : (
              /* Advanced multi-connection mode */
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

            {/* Simple mode travel data */}
            {connectionMode === "simple" && activeConnectionId && selectedPlace && travelData && (
              <div className="rounded-xl bg-surface-low p-2.5 text-xs text-on-surface-variant space-y-1">
                <p className="font-semibold text-on-surface">{travelLabel}</p>
                <div className="flex gap-3">
                  <span>
                    {travelData.travel_mode === "flight"
                      ? "\u2708\uFE0F"
                      : travelData.travel_mode === "walk"
                        ? "\u{1F6B6}"
                        : travelData.travel_mode === "transit"
                          ? "\u{1F68C}"
                          : "\u{1F697}"}{" "}
                    {travelData.travel_mode}
                  </span>
                  <span>
                    {travelData.travel_time_hours >= 1
                      ? `${Math.round(travelData.travel_time_hours * 10) / 10}h`
                      : `${Math.round(travelData.travel_time_hours * 60)} min`}
                  </span>
                  {travelData.distance_km != null && (
                    <span>{Math.round(travelData.distance_km)} km</span>
                  )}
                </div>
              </div>
            )}

            {connectionMode === "simple" && activeConnectionId && selectedPlace && travelLoading && (
              <div className="flex items-center gap-2 text-xs text-on-surface-variant px-1">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-outline-variant border-t-on-surface-variant" />
                Computing travel route...
              </div>
            )}
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
            disabled={
              !selectedPlace ||
              (!!activeConnectionId && travelLoading) ||
              departureBeforeArrival ||
              (!!insertBetween && (legALoading || legBLoading))
            }
            className="flex-1 rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {insertBetween ? "Insert Stop" : "Add Node"}
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
