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
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [placeNote, setPlaceNote] = useState("");

  useEffect(() => {
    if (!expanded) setActiveTab(defaultTab);
  }, [defaultTab, expanded]);

  function reset() {
    setExpanded(false);
    setTextContent("");
    setSelectedPlace(null);
    setPlaceNote("");
  }

  function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = textContent.trim();
    if (!trimmed) return;
    onSubmit({ type: activeTab, content: trimmed });
    reset();
  }

  function handlePlaceSelected(place: PlaceResult) {
    setSelectedPlace(place);
  }

  function handlePlaceSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPlace) return;
    const description = placeNote.trim();
    onSubmit({
      type: "place",
      content: description || selectedPlace.name,
      place_data: {
        name: selectedPlace.name,
        lat_lng: { lat: selectedPlace.lat, lng: selectedPlace.lng },
        place_id: selectedPlace.placeId,
      },
    });
    reset();
  }

  if (!expanded) {
    return (
      <div className="pt-1">
        <button
          onClick={() => setExpanded(true)}
          disabled={disabled}
          className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/5 py-2.5 px-3 text-xs font-semibold text-primary transition-all active:scale-[0.99] active:bg-primary/10 disabled:opacity-50"
        >
          <PlusIcon />
          Add note, todo, or place
        </button>
      </div>
    );
  }

  const tabs: {
    key: ActionTab;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { key: "note", label: "Note", icon: <NoteIcon /> },
    { key: "todo", label: "Todo", icon: <TodoIcon /> },
    { key: "place", label: "Place", icon: <PinIcon /> },
  ];

  return (
    <div className="pt-1 space-y-3 rounded-xl bg-surface-low p-3 border border-outline-variant/50">
      {/* Segmented tab selector */}
      <div className="flex gap-1 p-1 rounded-full bg-surface-lowest border border-outline-variant/40">
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                setActiveTab(tab.key);
                if (tab.key !== "place") {
                  setSelectedPlace(null);
                  setPlaceNote("");
                }
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? "bg-primary text-on-primary shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Input area */}
      {activeTab === "place" ? (
        selectedPlace ? (
          <form onSubmit={handlePlaceSubmit} className="space-y-2.5">
            {/* Selected place preview card */}
            <div className="flex items-start gap-2.5 rounded-lg bg-gradient-to-br from-secondary/10 to-surface-lowest border border-secondary/20 p-3">
              <span className="mt-0.5 shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-secondary/15 text-secondary">
                <PinIcon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-on-surface truncate">
                  {selectedPlace.name}
                </p>
                <p className="text-[11px] text-on-surface-variant mt-0.5">
                  {selectedPlace.lat.toFixed(4)}, {selectedPlace.lng.toFixed(4)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedPlace(null);
                  setPlaceNote("");
                }}
                aria-label="Choose a different place"
                className="shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 18 18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <textarea
              value={placeNote}
              onChange={(e) => setPlaceNote(e.target.value)}
              placeholder="Why this place? (optional)"
              maxLength={2000}
              rows={2}
              className="w-full text-sm rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2 text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none resize-none transition-all"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={reset}
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant hover:bg-surface-high transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={disabled}
                className="rounded-full px-4 py-1.5 text-xs font-semibold bg-primary text-on-primary disabled:opacity-50 transition-all active:scale-95"
              >
                Save place
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-2">
            <PlacesAutocomplete
              onPlaceSelect={handlePlaceSelected}
              locationBias={locationBias}
              placeholder="Search for a place..."
              autoFocus
              className="w-full rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-all"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={reset}
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant hover:bg-surface-high transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )
      ) : (
        <form onSubmit={handleTextSubmit} className="space-y-2">
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            placeholder={
              activeTab === "note"
                ? "Write a note..."
                : "What needs to get done?"
            }
            maxLength={2000}
            rows={2}
            className="w-full text-sm rounded-lg border border-outline-variant bg-surface-lowest px-3 py-2 text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none resize-none transition-all"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-full px-3 py-1.5 text-xs font-semibold text-on-surface-variant hover:bg-surface-high transition-colors"
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

function PlusIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 4.5v15m7.5-7.5h-15"
      />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 4.487 18.549 2.8a2.121 2.121 0 1 1 3 3L19.862 7.487m-3-3L6.34 15.01a4.5 4.5 0 0 0-1.13 1.897l-.912 3.04 3.04-.912a4.5 4.5 0 0 0 1.897-1.13l10.523-10.523m-3-3 3 3"
      />
    </svg>
  );
}

function TodoIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
      />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"
      />
    </svg>
  );
}
