"use client";

import { type DocumentData } from "firebase/firestore";
import { formatTravelTime, formatDistance } from "@/lib/dates";

interface EdgeDisambiguationPickerProps {
  edges: DocumentData[];
  nodeMap: Map<string, DocumentData>;
  distanceUnit?: "km" | "mi";
  onPick: (edgeId: string) => void;
  onClose: () => void;
}

const MODE_LABELS: Record<string, string> = {
  drive: "Drive",
  flight: "Flight",
  transit: "Transit",
  walk: "Walk",
};

const MODE_COLORS: Record<string, string> = {
  drive: "#006479",
  flight: "#5e35b1",
  transit: "#9a7c00",
  walk: "#006b1b",
};

function ModeIcon({ mode }: { mode: string }) {
  const color = MODE_COLORS[mode] ?? "#707978";
  const s = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (mode) {
    case "flight":
      return (
        <svg {...s}>
          <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 1-3.5 2.5L11 8.2 4.8 6.4c-.7-.3-1.2 0-1.4.7L3 8l5.5 2.5L6.5 14l-2-.5-.8 2 3 1.5 1.5 3 2-.8-.5-2 3.5-2L19 22z" />
        </svg>
      );
    case "transit":
      return (
        <svg {...s}>
          <rect width="16" height="16" x="4" y="3" rx="2" />
          <path d="M4 11h16M12 3v8" />
          <circle cx="8.5" cy="17" r="1.5" fill={color} stroke="none" />
          <circle cx="15.5" cy="17" r="1.5" fill={color} stroke="none" />
        </svg>
      );
    case "walk":
      return (
        <svg {...s}>
          <circle cx="13" cy="4" r="1" fill={color} stroke="none" />
          <path d="m7 21 1-4m6 4-1-4M9 8.5 7 21M5 9l4-1 1 4 4 2" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <path d="M19 17H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h11l4 4v4a2 2 0 0 1-2 2z" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </svg>
      );
  }
}

export function EdgeDisambiguationPicker({
  edges,
  nodeMap,
  distanceUnit = "km",
  onPick,
  onClose,
}: EdgeDisambiguationPickerProps) {
  return (
    <div className="absolute bottom-[var(--bottom-nav-height,0px)] left-0 right-0 z-10 rounded-t-3xl bg-surface-lowest shadow-float animate-slide-up">
      {/* Handle */}
      <div className="flex justify-center pt-3 pb-1">
        <div className="h-1 w-10 rounded-full bg-surface-high" />
      </div>

      <div className="flex items-center justify-between px-5 pt-2 pb-3">
        <h3 className="text-sm font-bold text-on-surface">Which route?</h3>
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

      {/* Edge cards */}
      <div className="flex flex-wrap gap-3 px-5 pb-5">
        {edges.map((edge) => {
          const from = nodeMap.get(edge.from_node_id);
          const to = nodeMap.get(edge.to_node_id);
          const modeColor = MODE_COLORS[edge.travel_mode] ?? "#707978";

          return (
            <button
              key={edge.id}
              onClick={() => onPick(edge.id)}
              className="flex-1 min-w-[calc(50%-6px)] rounded-2xl bg-surface-low p-3.5 text-left transition-all active:scale-[0.98] active:bg-surface-container"
            >
              {/* Mode icon + label */}
              <div className="flex items-center gap-1.5 mb-2">
                <ModeIcon mode={edge.travel_mode} />
                <span
                  className="text-xs font-semibold"
                  style={{ color: modeColor }}
                >
                  {MODE_LABELS[edge.travel_mode] || edge.travel_mode}
                </span>
              </div>

              {/* From → To */}
              <div className="flex items-center gap-1 text-sm font-semibold text-on-surface mb-1">
                <span className="truncate max-w-[80px]">
                  {from?.name || "?"}
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={modeColor}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0"
                >
                  <path d="M5 12h14M15 6l6 6-6 6" />
                </svg>
                <span className="truncate max-w-[80px]">
                  {to?.name || "?"}
                </span>
              </div>

              {/* Duration + distance */}
              <div className="text-xs text-on-surface-variant">
                {edge.travel_time_hours > 0 &&
                  formatTravelTime(edge.travel_time_hours)}
                {edge.travel_time_hours > 0 &&
                  edge.distance_km != null &&
                  " \u00B7 "}
                {edge.distance_km != null &&
                  formatDistance(edge.distance_km, distanceUnit)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
