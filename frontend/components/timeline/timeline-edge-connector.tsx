"use client";

import { memo, useCallback } from "react";
import { TravelModeIcon } from "@/components/dag/travel-mode-icon";
import { formatTravelTime } from "@/lib/dates";

interface TimezoneTransition {
  fromOffset: string;
  toOffset: string;
  hoursDiff: number;
}

interface TimelineEdgeConnectorProps {
  edgeId: string;
  travelMode: string;
  travelTimeHours: number;
  distanceKm: number | null;
  distanceUnit: "km" | "mi";
  connectorHeightPx: number;
  hasTimingWarning: boolean;
  hasNote: boolean;
  selected: boolean;
  dimmed: boolean;
  canEdit: boolean;
  timezoneTransition?: TimezoneTransition | null;
  onSelect: (edgeId: string) => void;
  onInsertStop: (edgeId: string) => void;
}

const LINE_STYLES: Record<string, { style: string; dashArray?: string }> = {
  drive: { style: "solid" },
  ferry: { style: "dashed", dashArray: "8 4" },
  flight: { style: "dashed", dashArray: "6 4" },
  transit: { style: "dashed", dashArray: "3 3" },
  walk: { style: "dotted" },
};

export const TimelineEdgeConnector = memo(function TimelineEdgeConnector({
  edgeId,
  travelMode,
  travelTimeHours,
  distanceKm,
  distanceUnit,
  connectorHeightPx,
  hasTimingWarning,
  hasNote,
  selected,
  dimmed,
  canEdit,
  timezoneTransition,
  onSelect,
  onInsertStop,
}: TimelineEdgeConnectorProps) {
  const handleClick = useCallback(() => onSelect(edgeId), [onSelect, edgeId]);
  const handleInsert = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onInsertStop(edgeId);
    },
    [onInsertStop, edgeId],
  );

  const lineColor = hasTimingWarning ? "#b31b25" : "#c4c7c5";
  const lineStyle = LINE_STYLES[travelMode] ?? LINE_STYLES.drive;

  const formattedDistance = distanceKm != null
    ? distanceUnit === "mi"
      ? `${Math.round(distanceKm * 0.621)} mi`
      : `${Math.round(distanceKm)} km`
    : null;

  return (
    <div
      className={`relative ${dimmed ? "opacity-45" : "cursor-pointer"}`}
      style={{ height: connectorHeightPx, minHeight: 40 }}
      onClick={dimmed ? undefined : handleClick}
      role="button"
      tabIndex={dimmed ? -1 : 0}
      aria-label={`${travelMode} connection, ${formatTravelTime(travelTimeHours)}`}
    >
      {/* Centered vertical line */}
      <div className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2 w-0" style={{
        borderLeft: `${hasTimingWarning ? 3 : 2}px ${lineStyle.style} ${lineColor}`,
      }} />

      {/* Centered Route Info Badge */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[1]">
        <div className={`
          flex flex-nowrap items-center gap-1 rounded-full px-2 py-0.5 border w-max max-w-full
          ${selected
            ? "bg-primary/10 border-primary/20"
            : hasTimingWarning
              ? "bg-error/10 border-error/20"
              : "bg-surface-low border-outline-variant/30 shadow-soft"
          }
        `}
          style={hasTimingWarning ? { boxShadow: "0 0 0 2px rgba(179,27,37,0.12)" } : undefined}
        >
          <TravelModeIcon mode={travelMode} size={13} />
          <span className={`text-[11px] font-medium whitespace-nowrap ${hasTimingWarning ? "text-error" : "text-on-surface-variant"}`}>
            {formatTravelTime(travelTimeHours)}
          </span>
          {formattedDistance && (
            <span className="text-[10px] text-on-surface-variant/60 whitespace-nowrap">· {formattedDistance}</span>
          )}
          {timezoneTransition && (
            <div className="flex items-center gap-1 border-l border-outline-variant/30 pl-1.5 ml-0.5">
              <span className="text-[10px] font-medium text-on-surface-variant/80 tracking-tight whitespace-nowrap">
                {timezoneTransition.fromOffset} → {timezoneTransition.toOffset}
              </span>
              {Math.abs(timezoneTransition.hoursDiff) >= 2 && (
                <span className="text-[9px] text-on-surface-variant/60 whitespace-nowrap hidden sm:inline">
                  ({timezoneTransition.hoursDiff > 0 ? "+" : "-"}{Math.abs(timezoneTransition.hoursDiff)}h)
                </span>
              )}
            </div>
          )}
          {hasTimingWarning && (
            <>
              <span className="text-[10px] text-error/60">·</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#b31b25" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </>
          )}
          {hasNote && !hasTimingWarning && (
            <>
              <span className="text-[10px] text-on-surface-variant/60">·</span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#6d5a00] shrink-0" />
            </>
          )}
        </div>
      </div>

      {/* Insert stop button */}
      {canEdit && !dimmed && (
        <button
          onClick={handleInsert}
          className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-primary opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100 transition-opacity"
          aria-label="Insert stop here"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
    </div>
  );
}, (prev, next) =>
  prev.edgeId === next.edgeId &&
  prev.selected === next.selected &&
  prev.dimmed === next.dimmed &&
  prev.connectorHeightPx === next.connectorHeightPx &&
  prev.hasTimingWarning === next.hasTimingWarning &&
  prev.hasNote === next.hasNote
);
