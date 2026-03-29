"use client";

import { useState } from "react";
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
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  onSave: (updates: Record<string, unknown>) => void;
  onCancel: () => void;
}

const NODE_TYPES = [
  { value: "city", label: "City" },
  { value: "hotel", label: "Hotel" },
  { value: "restaurant", label: "Restaurant" },
  { value: "place", label: "Place" },
  { value: "activity", label: "Activity" },
];

export function NodeEditForm({
  node,
  userRole,
  datetimeFormat = "24h",
  dateFormat = "eu",
  onSave,
  onCancel,
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

  const departureBeforeArrival =
    !!arrivalTime && !!departureTime && departureTime <= arrivalTime;

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
    }
    if (Object.keys(updates).length > 0) {
      onSave(updates);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <label className="block text-xs text-on-surface-variant mb-1">Name</label>
          <PlacesAutocomplete
            onPlaceSelect={(place) => {
              setName(place.name);
              setLocationUpdate(place);
            }}
            initialValue={name}
            placeholder="Search for a place..."
            onTextChange={setName}
            locationBias={node.lat_lng ?? undefined}
          />
          {locationUpdate && (
            <p className="text-xs text-secondary mt-1">
              Location will update to {locationUpdate.name}
            </p>
          )}
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
