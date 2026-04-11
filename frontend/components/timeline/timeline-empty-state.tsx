"use client";

import Link from "next/link";

interface TimelineEmptyStateProps {
  tripId: string;
}

export function TimelineEmptyState({ tripId }: TimelineEmptyStateProps) {
  return (
    <div className="flex flex-1 items-center justify-center h-full">
      <div className="text-center px-6">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <svg className="h-8 w-8 text-primary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <line x1="3" y1="6" x2="3" y2="18" />
            <line x1="7" y1="6" x2="21" y2="6" />
            <line x1="7" y1="12" x2="21" y2="12" />
            <line x1="7" y1="18" x2="21" y2="18" />
          </svg>
        </div>
        <h3 className="text-base font-bold text-on-surface mb-1">No stops yet</h3>
        <p className="text-sm text-on-surface-variant mb-4">
          Add a stop to start building your timeline.
        </p>
        <Link
          href={`/trips/${tripId}/import`}
          className="inline-flex gradient-primary rounded-full px-6 py-3 text-sm font-semibold text-on-primary shadow-ambient transition-all active:scale-[0.98]"
        >
          Import Itinerary
        </Link>
      </div>
    </div>
  );
}
