"use client";

import { memo, useCallback } from "react";
import { TYPE_TOKENS, FALLBACK_TOKEN } from "@/components/map/node-marker";

interface TimelineNodeBlockProps {
  nodeId: string;
  name: string;
  type: string;
  arrivalTime: string | null;
  departureTime: string | null;
  timezone?: string;
  heightPx: number;
  hasMissingTime: boolean;
  arrivalEstimated?: boolean;
  departureEstimated?: boolean;
  overnightHold?: boolean;
  holdReason?: "night_drive" | "max_drive_hours" | null;
  driveCap?: boolean;
  timingConflict?: string | null;
  spansDays?: number;
  selected: boolean;
  dimmed: boolean;
  hasTimingConflict?: boolean;
  isShared?: boolean;
  isStart?: boolean;
  isEnd?: boolean;
  datetimeFormat: "12h" | "24h";
  dateFormat: "eu" | "us" | "iso" | "short";
  onSelect: (nodeId: string) => void;
  blockRef: (el: HTMLElement | null) => void;
}

const TYPE_BORDER_COLORS: Record<string, string> = {
  city: "#006479",     // primary
  hotel: "#5e35b1",    // purple
  restaurant: "#6d5a00", // tertiary
  place: "#006b1b",    // secondary
  activity: "#b31b25", // error
};

function NodeTypeIcon({ type, size = 14 }: { type: string; size?: number }) {
  const token = TYPE_TOKENS[type] ?? FALLBACK_TOKEN;
  const s = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: token.bg,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "city":
      return (
        <svg {...s}>
          <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
          <path d="M6 12H4a2 2 0 0 0-2 2v8h4M18 9h2a2 2 0 0 1 2 2v11h-4" />
          <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
        </svg>
      );
    case "hotel":
      return (
        <svg {...s}>
          <path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8" />
          <path d="M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" />
          <path d="M12 10v4M2 16h20" />
        </svg>
      );
    case "restaurant":
      return (
        <svg {...s}>
          <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20" />
          <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3ZM21 15v7" />
        </svg>
      );
    case "activity":
      return (
        <svg {...s}>
          <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
          <circle cx="12" cy="10" r="3" />
        </svg>
      );
  }
}

function formatTimeOnly(iso: string | null, datetimeFormat: "12h" | "24h", timezone?: string): string {
  if (!iso) return "-";
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: datetimeFormat === "12h",
    timeZone: tz,
  }).format(new Date(iso));
}

const WARNING_LABELS: Record<"night_drive" | "max_drive_hours", { tooltip: string; label: string }> = {
  night_drive: { tooltip: "Night drive — consider adding a rest stop", label: "Night drive — add rest stop" },
  max_drive_hours: { tooltip: "Daily drive limit reached — consider adding a rest stop", label: "Drive cap — add rest stop" },
};

export const TimelineNodeBlock = memo(function TimelineNodeBlock({
  nodeId,
  name,
  type,
  arrivalTime,
  departureTime,
  timezone,
  heightPx,
  hasMissingTime,
  arrivalEstimated,
  departureEstimated,
  overnightHold,
  holdReason,
  driveCap,
  timingConflict,
  spansDays,
  selected,
  dimmed,
  isShared,
  isStart,
  isEnd,
  datetimeFormat,
  onSelect,
  blockRef,
}: TimelineNodeBlockProps) {
  const borderColor = TYPE_BORDER_COLORS[type] ?? "#707978";
  const borderWidth = selected ? 4 : 3;

  const handleClick = useCallback(() => onSelect(nodeId), [onSelect, nodeId]);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(nodeId);
      }
    },
    [onSelect, nodeId],
  );

  const arrivalDisplay = formatTimeOnly(arrivalTime, datetimeFormat, timezone ?? undefined);
  const departureDisplay = formatTimeOnly(departureTime, datetimeFormat, timezone ?? undefined);
  const arrivalPrefix = arrivalEstimated ? "~" : "";
  const departurePrefix = departureEstimated ? "~" : "";
  const anyEstimated = arrivalEstimated || departureEstimated;
  const showConflict = !!timingConflict;
  const showDriveCap = !!driveCap;
  const showSpanChip = (spansDays ?? 0) > 0;
  
  const driveLabel = holdReason ? WARNING_LABELS[holdReason].label : "Drive cap — add rest stop";
  const driveTooltip = holdReason ? WARNING_LABELS[holdReason].tooltip : "Drive limit reached — consider a rest stop";

  return (
    <div
      ref={blockRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`
        relative rounded-xl transition-all duration-150
        ${selected
          ? "bg-surface-lowest shadow-float ring-1 ring-primary/20"
          : "bg-surface-lowest/80 shadow-soft"
        }
        ${anyEstimated ? "border border-dashed border-on-surface-variant/40" : ""}
        ${dimmed ? "opacity-45 pointer-events-none" : "cursor-pointer active:scale-[0.98]"}
      `}
      style={{
        height: heightPx,
        minHeight: MIN_HEIGHT,
        borderLeft: `${borderWidth}px solid ${borderColor}`,
        borderRadius: 12,
      }}
    >
      <div className="flex flex-col justify-center h-full px-3 py-2 overflow-hidden">
        {/* Line 1: Icon + Name + status pills */}
        <div className="flex items-center gap-1.5 min-w-0">
          <NodeTypeIcon type={type} size={14} />
          <span className="text-sm font-semibold text-on-surface truncate">{name}</span>
          {showSpanChip && (
            <span
              className="shrink-0 text-[9px] font-semibold rounded-full px-1.5 py-px"
              style={{ background: "rgba(0,100,121,0.12)", color: "#006479" }}
              title={`Spans ${spansDays} calendar day${spansDays! > 1 ? "s" : ""}`}
            >
              +{spansDays}d
            </span>
          )}
          {showConflict && (
            <span
              className="shrink-0 inline-flex items-center"
              title={timingConflict ?? "Timing conflict"}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#b31b25" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
          )}
          {showDriveCap && !showConflict && (
            <span
              className="shrink-0 inline-flex items-center"
              title={driveTooltip}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#92400e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
          )}
        </div>

        {/* Line 2: Times */}
        <div className="flex items-center gap-1 mt-0.5">
          {hasMissingTime && !arrivalTime && !departureTime ? (
            <div className="flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: "rgba(253,212,0,0.15)" }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6d5a00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="text-[10px] font-medium" style={{ color: "#6d5a00" }}>No time set</span>
            </div>
          ) : (
            <span className="text-xs text-on-surface-variant">
              {isStart
                ? `${departurePrefix}${departureDisplay}`
                : isEnd
                  ? `${arrivalPrefix}${arrivalDisplay}`
                  : `${arrivalPrefix}${arrivalDisplay}${departureTime ? ` - ${departurePrefix}${departureDisplay}` : ""}`
              }
            </span>
          )}
        </div>

        {/* Line 3: Drive-cap advisory */}
        {showDriveCap && (
          <div className="flex items-center gap-1 mt-0.5">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#92400e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-[10px] font-medium truncate" style={{ color: "#92400e" }}>
              {driveLabel}
            </span>
          </div>
        )}
      </div>

      {/* Shared node badge */}
      {isShared && (
        <div className="absolute bottom-1 right-1.5 opacity-40">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-on-surface-variant">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.nodeId === next.nodeId &&
  prev.name === next.name &&
  prev.type === next.type &&
  prev.timezone === next.timezone &&
  prev.selected === next.selected &&
  prev.dimmed === next.dimmed &&
  prev.heightPx === next.heightPx &&
  prev.arrivalTime === next.arrivalTime &&
  prev.departureTime === next.departureTime &&
  prev.hasMissingTime === next.hasMissingTime &&
  prev.arrivalEstimated === next.arrivalEstimated &&
  prev.departureEstimated === next.departureEstimated &&
  prev.overnightHold === next.overnightHold &&
  prev.holdReason === next.holdReason &&
  prev.driveCap === next.driveCap &&
  prev.timingConflict === next.timingConflict &&
  prev.spansDays === next.spansDays &&
  prev.hasTimingConflict === next.hasTimingConflict &&
  prev.isShared === next.isShared &&
  prev.isStart === next.isStart &&
  prev.isEnd === next.isEnd &&
  prev.datetimeFormat === next.datetimeFormat &&
  prev.dateFormat === next.dateFormat
);

const MIN_HEIGHT = 56;
