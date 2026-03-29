"use client";

import { useEffect, useState } from "react";
import {
  PlacesAutocomplete,
  type PlaceResult,
} from "@/components/map/places-autocomplete";

import { type ActionTab } from "@/components/dag/action-list";

export interface AddActionData {
  type: string;
  content: string;
  place_data?: {
    name: string;
    lat_lng: { lat: number; lng: number };
    place_id: string;
  };
}

interface AddActionFormProps {
  onSubmit: (data: AddActionData) => void;
  disabled?: boolean;
  locationBias?: { lat: number; lng: number };
  defaultTab?: ActionTab;
}

export function AddActionForm({
  onSubmit,
  disabled,
  locationBias,
  defaultTab = "note",
}: AddActionFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<ActionTab>(defaultTab);
  const [textContent, setTextContent] = useState("");

  useEffect(() => {
    if (!expanded) setActiveTab(defaultTab);
  }, [defaultTab, expanded]);

  function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = textContent.trim();
    if (!trimmed) return;
    onSubmit({ type: activeTab, content: trimmed });
    setTextContent("");
    setExpanded(false);
  }

  function handlePlaceSelect(place: PlaceResult) {
    onSubmit({
      type: "place",
      content: place.name,
      place_data: {
        name: place.name,
        lat_lng: { lat: place.lat, lng: place.lng },
        place_id: place.placeId,
      },
    });
    setExpanded(false);
  }

  if (!expanded) {
    return (
      <div className="pt-1">
        <button
          onClick={() => setExpanded(true)}
          disabled={disabled}
          className="w-full text-left text-xs font-medium text-primary py-2 px-3 rounded-lg bg-primary/5 transition-colors active:bg-primary/10 disabled:opacity-50"
        >
          + Add note, todo, or place
        </button>
      </div>
    );
  }

  const tabs: { key: ActionTab; label: string }[] = [
    { key: "note", label: "Note" },
    { key: "todo", label: "Todo" },
    { key: "place", label: "Place" },
  ];

  return (
    <div className="pt-1 space-y-2">
      {/* Tab selector */}
      <div className="flex gap-1.5">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-primary text-on-primary"
                : "bg-surface-high text-on-surface-variant"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Input area */}
      {activeTab === "place" ? (
        <div className="space-y-2">
          <PlacesAutocomplete
            onPlaceSelect={handlePlaceSelect}
            locationBias={locationBias}
            placeholder="Search for a place..."
            autoFocus
            className="w-full rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setTextContent("");
              }}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleTextSubmit} className="space-y-2">
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            placeholder={
              activeTab === "note" ? "Write a note..." : "Add a todo..."
            }
            maxLength={2000}
            rows={2}
            className="w-full text-sm rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2 text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none resize-none"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setTextContent("");
              }}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!textContent.trim() || disabled}
              className="rounded-full px-4 py-1.5 text-xs font-semibold bg-primary text-on-primary disabled:opacity-50 transition-all active:scale-95"
            >
              Add
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
