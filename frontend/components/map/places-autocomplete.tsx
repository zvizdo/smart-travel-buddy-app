"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMapsLibrary } from "@vis.gl/react-google-maps";

export interface PlaceResult {
  name: string;
  placeId: string;
  lat: number;
  lng: number;
  types: string[];
}

interface PlacesAutocompleteProps {
  onPlaceSelect: (place: PlaceResult) => void;
  onTextChange?: (value: string) => void;
  locationBias?: { lat: number; lng: number };
  placeholder?: string;
  initialValue?: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Infer our node type from Google Maps place types.
 */
export function inferNodeType(types: string[]): string {
  const t = new Set(types);
  if (t.has("lodging") || t.has("hotel")) return "hotel";
  if (
    t.has("restaurant") ||
    t.has("food") ||
    t.has("cafe") ||
    t.has("bar") ||
    t.has("bakery") ||
    t.has("meal_delivery") ||
    t.has("meal_takeaway")
  )
    return "restaurant";
  if (
    t.has("locality") ||
    t.has("administrative_area_level_1") ||
    t.has("administrative_area_level_2") ||
    t.has("country")
  )
    return "city";
  if (
    t.has("amusement_park") ||
    t.has("aquarium") ||
    t.has("bowling_alley") ||
    t.has("campground") ||
    t.has("gym") ||
    t.has("park") ||
    t.has("stadium") ||
    t.has("zoo") ||
    t.has("tourist_attraction")
  )
    return "activity";
  return "place";
}

export function PlacesAutocomplete({
  onPlaceSelect,
  onTextChange,
  locationBias,
  placeholder = "Search for a place...",
  initialValue = "",
  autoFocus = false,
  className,
}: PlacesAutocompleteProps) {
  const places = useMapsLibrary("places");
  const [inputValue, setInputValue] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<
    google.maps.places.AutocompleteSuggestion[]
  >([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const sessionTokenRef =
    useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!places) return;
    sessionTokenRef.current = new places.AutocompleteSessionToken();
  }, [places]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const fetchSuggestions = useCallback(
    async (input: string) => {
      if (!places || input.length < 2) {
        setSuggestions([]);
        return;
      }

      setLoading(true);
      try {
        const request: google.maps.places.AutocompleteRequest = {
          input,
          sessionToken: sessionTokenRef.current ?? undefined,
        };
        if (locationBias) {
          request.locationBias = new google.maps.Circle({
            center: locationBias,
            radius: 50_000,
          });
        }
        const { suggestions: results } =
          await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(
            request,
          );
        setSuggestions(results);
        setIsOpen(results.length > 0);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    },
    [places, locationBias],
  );

  function handleInputChange(value: string) {
    setInputValue(value);
    onTextChange?.(value);
    clearTimeout(debounceRef.current);
    if (value.length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 300);
  }

  async function handleSelect(
    suggestion: google.maps.places.AutocompleteSuggestion,
  ) {
    if (!places || !suggestion.placePrediction) return;

    const placeId = suggestion.placePrediction.placeId;
    const place = new places.Place({ id: placeId });

    await place.fetchFields({
      fields: ["displayName", "location", "types"],
    });

    const location = place.location;
    if (!location) return;

    const result: PlaceResult = {
      name:
        place.displayName ??
        suggestion.placePrediction.text?.toString() ??
        "",
      placeId,
      lat: location.lat(),
      lng: location.lng(),
      types: place.types ?? [],
    };

    setInputValue(result.name);
    setSuggestions([]);
    setIsOpen(false);

    sessionTokenRef.current = new places.AutocompleteSessionToken();

    onPlaceSelect(result);
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={inputValue}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => {
          if (suggestions.length > 0) setIsOpen(true);
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={
          className ??
          "w-full rounded-xl bg-surface-high px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary/30"
        }
      />
      {loading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-outline-variant border-t-primary" />
        </div>
      )}
      {isOpen && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-2 w-full max-h-48 overflow-y-auto rounded-2xl bg-surface-lowest shadow-float">
          {suggestions.map((suggestion, idx) => {
            const prediction = suggestion.placePrediction;
            if (!prediction) return null;
            return (
              <li key={prediction.placeId ?? idx}>
                <button
                  type="button"
                  onClick={() => handleSelect(suggestion)}
                  className="w-full px-4 py-3 text-left text-sm hover:bg-surface-low transition-colors"
                >
                  <span className="font-semibold text-on-surface">
                    {prediction.mainText?.toString() ?? ""}
                  </span>
                  {prediction.secondaryText && (
                    <span className="ml-1.5 text-on-surface-variant text-xs">
                      {prediction.secondaryText.toString()}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
