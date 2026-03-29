"use client";

import { useEffect, useMemo, useState } from "react";
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

interface AddNodeSheetProps {
  initialPlace?: PlaceResult | null;
  allNodes: DocumentData[];
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
    connect_after_node_id: string | null;
    connect_before_node_id: string | null;
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
    route_polyline: string | null;
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

export function AddNodeSheet({
  initialPlace,
  allNodes,
  datetimeFormat = "24h",
  dateFormat = "eu",
  onSubmit,
  onCancel,
}: AddNodeSheetProps) {
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(
    initialPlace ?? null,
  );
  const [type, setType] = useState(
    initialPlace ? inferNodeType(initialPlace.types) : "place",
  );
  const [arrivalTime, setArrivalTime] = useState("");
  const [departureTime, setDepartureTime] = useState("");
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

  // For "after" mode: origin = target node, destination = new place
  // For "before" mode: origin = new place, destination = target node
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

  // Pre-fill arrival time when source node and travel data are available (after mode only)
  const earliestArrival = useMemo(() => {
    if (connectMode !== "after" || !targetNode || !travelData) return null;
    const dep =
      targetNode.departure_time ??
      targetNode.arrival_time;
    if (!dep) return null;
    const depMs = new Date(dep).getTime();
    return new Date(depMs + travelData.travel_time_hours * 3_600_000);
  }, [connectMode, targetNode, travelData]);

  // Auto-set arrival when travel data first comes in
  useEffect(() => {
    if (earliestArrival && !arrivalTime) {
      setArrivalTime(utcToLocalInput(earliestArrival.toISOString()));
    }
  }, [earliestArrival, arrivalTime]);

  // Check if arrival is too early (truncate to minute precision to match datetime-local input)
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
  }

  function handleArrivalChange(value: string) {
    setArrivalTime(value);
    // Auto-bump departure if arrival >= departure
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

    onSubmit({
      name: selectedPlace.name,
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
    <div className="absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up">
      <div className="flex justify-center pt-3 pb-1"><div className="h-1 w-10 rounded-full bg-surface-high" /></div>
      <div className="flex items-center justify-between px-4 pt-2 pb-2">
        <div>
          <h2 className="text-base font-semibold text-on-surface">Add Node</h2>
          {selectedPlace && (
            <p className="text-xs text-on-surface-variant">
              {selectedPlace.lat.toFixed(4)}, {selectedPlace.lng.toFixed(4)}
            </p>
          )}
        </div>
        <button
          onClick={onCancel}
          className="h-8 w-8 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div>
            <label className="block text-xs text-on-surface-variant mb-1">Place</label>
            <PlacesAutocomplete
              onPlaceSelect={handlePlaceSelect}
              initialValue={selectedPlace?.name ?? ""}
              placeholder="Search for a place..."
              autoFocus={!initialPlace}
              locationBias={
                selectedPlace
                  ? { lat: selectedPlace.lat, lng: selectedPlace.lng }
                  : targetNode?.lat_lng ?? undefined
              }
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

        {/* Connection direction segmented control */}
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

          {/* Node dropdown */}
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
        </div>

        {activeConnectionId && selectedPlace && travelData && (
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

        {activeConnectionId && selectedPlace && travelLoading && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant px-1">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-outline-variant border-t-on-surface-variant" />
            Computing travel route...
          </div>
        )}

        {timingWarning && (
          <div className="rounded-xl bg-tertiary-container/15 p-2.5 text-xs text-on-surface-variant">
            {timingWarning}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={!selectedPlace || (!!activeConnectionId && travelLoading) || departureBeforeArrival}
            className="flex-1 rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-50"
          >
            Add Node
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
