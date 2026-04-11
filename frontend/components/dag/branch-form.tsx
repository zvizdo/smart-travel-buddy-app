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

interface BranchFormProps {
  sourceNode: DocumentData;
  allNodes: DocumentData[];
  onSubmit: (data: {
    name: string;
    type: string;
    lat: number;
    lng: number;
    place_id: string | null;
    arrival_time: string | null;
    departure_time: string | null;
    travel_mode: string;
    travel_time_hours: number;
    distance_km: number | null;
    route_polyline: string | null;
    connect_to_node_id: string | null;
  }) => void;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
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

export function BranchForm({
  sourceNode,
  allNodes,
  onSubmit,
  datetimeFormat = "24h",
  dateFormat = "eu",
  onCancel,
}: BranchFormProps) {
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [locationState, setLocationState] = useState<"empty" | "chip" | "searching">("empty");
  const [searchKey, setSearchKey] = useState(0);
  const nameAutoFilledRef = useRef(false);

  const [type, setType] = useState("place");
  const [arrivalTime, setArrivalTime] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  const [connectToNodeId, setConnectToNodeId] = useState("");

  const otherNodes = allNodes.filter((n) => n.id !== sourceNode.id);

  const originCoords = useMemo(
    () =>
      sourceNode.lat_lng
        ? { lat: sourceNode.lat_lng.lat, lng: sourceNode.lat_lng.lng }
        : null,
    [sourceNode],
  );

  const destCoords = useMemo(
    () =>
      selectedPlace ? { lat: selectedPlace.lat, lng: selectedPlace.lng } : null,
    [selectedPlace],
  );

  const { travelData, loading: travelLoading } = useDirections(
    originCoords,
    destCoords,
  );

  const earliestArrival = useMemo(() => {
    if (!travelData) return null;
    const dep = sourceNode.departure_time ?? sourceNode.arrival_time;
    if (!dep) return null;
    const depMs = new Date(dep).getTime();
    return new Date(depMs + travelData.travel_time_hours * 3_600_000);
  }, [sourceNode, travelData]);

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
      return `Arrival is ${diffStr} too early for the estimated travel time`;
    }
    return null;
  }, [earliestArrival, arrivalTime]);

  function handlePlaceSelect(place: PlaceResult) {
    setSelectedPlace(place);
    setType(inferNodeType(place.types));
    setLocationState("chip");
    // Reset arrival so it can be re-filled by travel data
    setArrivalTime("");
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

    onSubmit({
      name: displayName.trim() || selectedPlace.name,
      type,
      lat: selectedPlace.lat,
      lng: selectedPlace.lng,
      place_id: selectedPlace.placeId,
      arrival_time: arrivalTime ? localInputToUtc(arrivalTime) : null,
      departure_time: departureTime ? localInputToUtc(departureTime) : null,
      travel_mode: travelData?.travel_mode ?? "drive",
      travel_time_hours: travelData?.travel_time_hours ?? 1,
      distance_km: travelData?.distance_km ?? null,
      route_polyline: travelData?.route_polyline ?? null,
      connect_to_node_id: connectToNodeId || null,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
      <p className="text-xs text-on-surface-variant">
        New side trip from <span className="font-semibold">{sourceNode.name}</span>
      </p>

      {/* Row 1: Name + Type */}
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <label className="block text-xs text-on-surface-variant mb-1">Name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => handleDisplayNameChange(e.target.value)}
            placeholder="Give this stop a name"
            autoFocus
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
                locationBias={sourceNode.lat_lng ?? undefined}
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

      {selectedPlace && travelData && (
        <div className="rounded-xl bg-surface-low p-2.5 text-xs text-on-surface-variant space-y-1">
          <p className="font-semibold text-on-surface">
            Travel from {sourceNode.name}
          </p>
          <div className="flex gap-3">
            <span>
              {travelData.travel_mode === "flight"
                ? "✈️"
                : travelData.travel_mode === "walk"
                  ? "🚶"
                  : travelData.travel_mode === "transit"
                    ? "🚌"
                    : "🚗"}{" "}
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

      {selectedPlace && travelLoading && (
        <div className="flex items-center gap-2 text-xs text-on-surface-variant px-1">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-outline-variant border-t-on-surface-variant" />
          Computing travel route...
        </div>
      )}

      {timingWarning && (
        <div className="rounded-xl bg-tertiary-container/15 p-2.5 text-xs text-on-surface-variant">
          ⚠ {timingWarning}
        </div>
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

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={!selectedPlace || travelLoading || departureBeforeArrival}
          className="flex-1 rounded-xl gradient-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-soft transition-all active:scale-[0.98] disabled:opacity-50"
        >
          Create Branch
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
