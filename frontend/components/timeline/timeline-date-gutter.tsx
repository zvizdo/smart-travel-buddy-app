"use client";

import { memo } from "react";
import type { DateMarker } from "@/lib/timeline-layout";

interface TimelineDateGutterProps {
  dateMarkers: DateMarker[];
  totalHeightPx: number;
}

export const TimelineDateGutter = memo(function TimelineDateGutter({
  dateMarkers,
  totalHeightPx,
}: TimelineDateGutterProps) {
  return (
    <div
      className="relative w-14 shrink-0 bg-surface-low/60"
      style={{ height: totalHeightPx || "100%" }}
    >
      {dateMarkers.map((marker, i) => (
        <div
          key={`${marker.label}-${i}`}
          className="absolute left-0 w-14 flex items-start"
          style={{ top: marker.yOffsetPx }}
        >
          <div
            className={`
              sticky top-[60px] px-2 py-1
              text-xs font-semibold
              ${marker.isToday
                ? "text-primary border-l-2 border-primary"
                : "text-on-surface-variant"
              }
            `}
          >
            {marker.label}
          </div>
        </div>
      ))}
    </div>
  );
});
