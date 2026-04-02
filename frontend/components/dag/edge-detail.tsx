"use client";

import { type DocumentData } from "firebase/firestore";
import { formatTravelTime, formatDistance } from "@/lib/dates";
import { TravelModeIcon, MODE_COLORS } from "@/components/dag/travel-mode-icon";

interface EdgeDetailProps {
  edge: DocumentData;
  fromNode?: DocumentData | null;
  toNode?: DocumentData | null;
  distanceUnit?: "km" | "mi";
  timingWarning?: boolean;
  warningMessage?: string;
  canEdit?: boolean;
  onInsertStop?: () => void;
  onClose: () => void;
}

const MODE_LABELS: Record<string, string> = {
  drive: "Drive",
  flight: "Flight",
  transit: "Transit",
  walk: "Walk",
};

export function EdgeDetail({
  edge,
  fromNode,
  toNode,
  distanceUnit = "km",
  timingWarning,
  warningMessage,
  canEdit,
  onInsertStop,
  onClose,
}: EdgeDetailProps) {
  const modeColor = MODE_COLORS[edge.travel_mode] ?? "#707978";

  return (
    <div className="absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up">
      {/* Handle */}
      <div className="flex justify-center pt-3 pb-1">
        <div className="h-1 w-10 rounded-full bg-surface-high" />
      </div>

      {/* Color accent bar */}
      <div className="mx-5 h-0.5 rounded-full" style={{ background: modeColor }} />

      <div className="flex items-start justify-between px-5 pt-3 pb-2">
        <div className="space-y-2">
          {/* Route: From → To */}
          <div className="flex items-center gap-1.5 text-sm">
            <span className="font-semibold text-on-surface truncate max-w-[120px]">
              {fromNode?.name || "?"}
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
            <span className="font-semibold text-on-surface truncate max-w-[120px]">
              {toNode?.name || "?"}
            </span>
          </div>

          {/* Mode badge */}
          <div
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1"
            style={{ background: `${modeColor}14` }}
          >
            <TravelModeIcon mode={edge.travel_mode} />
            <span
              className="text-xs font-semibold"
              style={{ color: modeColor }}
            >
              {MODE_LABELS[edge.travel_mode] || edge.travel_mode}
            </span>
          </div>
        </div>

        <button
          onClick={onClose}
          className="h-8 w-8 rounded-full bg-surface-low flex items-center justify-center text-on-surface-variant transition-colors active:bg-surface-container"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
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

      <div className="px-5 pb-5 space-y-3">
        {/* Duration and distance */}
        {edge.travel_time_hours > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-on-surface-variant">Duration</span>
            <span className="font-medium text-on-surface">
              {formatTravelTime(edge.travel_time_hours)}
            </span>
          </div>
        )}
        {edge.distance_km != null && (
          <div className="flex justify-between text-sm">
            <span className="text-on-surface-variant">Distance</span>
            <span className="font-medium text-on-surface">
              {formatDistance(edge.distance_km, distanceUnit)}
            </span>
          </div>
        )}

        {/* Insert stop CTA */}
        {canEdit && onInsertStop && (
          <button
            type="button"
            onClick={onInsertStop}
            className="w-full rounded-xl bg-primary/[0.07] border border-primary/15 px-3.5 py-3 flex items-center gap-3 cursor-pointer transition-colors active:bg-primary/15 active:scale-[0.99]"
          >
            <span className="h-8 w-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </span>
            <span className="text-left">
              <span className="block text-sm font-semibold text-on-surface">Insert stop here</span>
              <span className="block text-xs text-on-surface-variant">
                Add a stop between {fromNode?.name || "?"} and {toNode?.name || "?"}
              </span>
            </span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-auto shrink-0">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        )}

        {/* Warning */}
        {timingWarning && (
          <div className="flex items-start gap-2 rounded-xl bg-[#fef3c7] p-3 text-xs text-[#92400e]">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-px shrink-0"
            >
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>
              {warningMessage || "Travel time may be too tight for the scheduled arrival"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
