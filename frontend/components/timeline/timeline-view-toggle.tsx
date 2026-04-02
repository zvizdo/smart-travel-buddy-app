"use client";

interface TimelineViewToggleProps {
  viewMode: "map" | "timeline";
  onToggle: (mode: "map" | "timeline") => void;
}

export function TimelineViewToggle({ viewMode, onToggle }: TimelineViewToggleProps) {
  return (
    <div className="relative flex items-center h-7 rounded-[14px] bg-surface-high/80 p-0.5 shadow-soft">
      {/* Sliding indicator */}
      <div
        className="absolute top-0.5 h-[24px] rounded-[11px] bg-surface-lowest shadow-soft transition-[left] duration-150"
        style={{
          width: "calc(50% - 2px)",
          left: viewMode === "map" ? "2px" : "50%",
        }}
      />

      <button
        onClick={() => onToggle("map")}
        className={`relative z-10 flex-1 min-w-0 flex items-center justify-center gap-1 px-2.5 h-6 text-[11px] transition-all duration-150 ${
          viewMode === "map" ? "font-semibold text-on-surface" : "font-medium text-on-surface-variant"
        }`}
      >
        {/* Map pin icon */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <span>Map</span>
      </button>

      <button
        onClick={() => onToggle("timeline")}
        className={`relative z-10 flex-1 min-w-0 flex items-center justify-center gap-1 px-2.5 h-6 text-[11px] transition-all duration-150 ${
          viewMode === "timeline" ? "font-semibold text-on-surface" : "font-medium text-on-surface-variant"
        }`}
      >
        {/* Timeline/list icon */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="3" y2="18" />
          <line x1="7" y1="6" x2="21" y2="6" />
          <line x1="7" y1="12" x2="21" y2="12" />
          <line x1="7" y1="18" x2="21" y2="18" />
        </svg>
        <span>Timeline</span>
      </button>
    </div>
  );
}
