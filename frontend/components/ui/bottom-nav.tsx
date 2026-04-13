"use client";

import Link from "next/link";
import { PulseButton } from "@/components/map/pulse-button";

type Tab = "map" | "agent" | "settings";

interface BottomNavProps {
  tripId: string;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onPulseToast?: (message: string) => void;
  showPulse?: boolean;
}

export function BottomNav({
  tripId,
  activeTab,
  onTabChange,
  onPulseToast,
  showPulse = true,
}: BottomNavProps) {
  return (
    <nav className="relative z-30 flex items-center justify-around bg-surface-lowest px-2 py-2 shadow-[0_-2px_12px_rgba(0,0,0,0.06)]">
      {/* Map */}
      <button
        onClick={() => onTabChange("map")}
        className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-xl transition-colors ${
          activeTab === "map"
            ? "text-primary"
            : "text-on-surface-variant"
        }`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={activeTab === "map" ? 2.2 : 1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z" />
        </svg>
        <span className="text-[10px] font-semibold">Map</span>
      </button>

      {/* Agent */}
      <button
        onClick={() => onTabChange("agent")}
        className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-xl transition-colors ${
          activeTab === "agent"
            ? "text-primary"
            : "text-on-surface-variant"
        }`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={activeTab === "agent" ? 2.2 : 1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
        </svg>
        <span className="text-[10px] font-semibold">Buddy</span>
      </button>

      {/* Settings */}
      <Link
        href={`/trips/${tripId}/settings`}
        className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-xl transition-colors text-on-surface-variant`}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
        <span className="text-[10px] font-semibold">Settings</span>
      </Link>

      {/* Pulse */}
      {showPulse && (
        <PulseButton tripId={tripId} onToast={onPulseToast} />
      )}
    </nav>
  );
}
