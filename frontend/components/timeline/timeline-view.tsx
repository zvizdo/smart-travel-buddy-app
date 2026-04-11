"use client";

import { type SetStateAction, useEffect, useMemo, useRef } from "react";
import { computeTimelineLayout, PX_PER_HOUR, type TimelineZoomLevel } from "@/lib/timeline-layout";
import { type PathResult } from "@/lib/path-computation";
import { TimelineDateGutter } from "./timeline-date-gutter";
import { TimelineLane } from "./timeline-lane";
import { TimelineEmptyState } from "./timeline-empty-state";

const SCROLL_TOP_BUFFER_PX = 80;

interface NodeData {
  id: string;
  name: string;
  type: string;
  lat_lng: { lat: number; lng: number } | null;
  arrival_time: string | null;
  departure_time: string | null;
  order_index: number;
  participant_ids?: string[] | null;
  timezone?: string | null;
  [key: string]: unknown;
}

interface EdgeData {
  id: string;
  from_node_id: string;
  to_node_id: string;
  travel_mode: string;
  travel_time_hours: number;
  distance_km: number | null;
  [key: string]: unknown;
}

interface TimelineViewProps {
  tripId: string;
  nodes: NodeData[];
  edges: EdgeData[];
  pathResult: PathResult | null;
  pathMode: "all" | "mine";
  currentUserId: string | null;
  participants: Record<string, { role: string; display_name?: string }>;

  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNodeSelect: (nodeId: string) => void;
  onEdgeSelect: (edgeId: string) => void;
  onInsertStop: (edgeId: string) => void;
  onAddNodeRequest: () => void;

  canEdit: boolean;
  datetimeFormat: "12h" | "24h";
  dateFormat: "eu" | "us" | "iso" | "short";
  distanceUnit: "km" | "mi";

  zoomLevel: TimelineZoomLevel;
  onZoomChange: React.Dispatch<SetStateAction<TimelineZoomLevel>>;
}

export function TimelineView({
  tripId,
  nodes,
  edges,
  pathResult,
  pathMode,
  currentUserId,
  participants,

  selectedNodeId,
  selectedEdgeId,
  onNodeSelect,
  onEdgeSelect,
  onInsertStop,
  onAddNodeRequest,

  canEdit,
  datetimeFormat,
  dateFormat,
  distanceUnit,

  zoomLevel,
  onZoomChange,
}: TimelineViewProps) {
  const nodeBlockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitially = useRef(false);

  const participantNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const [uid, p] of Object.entries(participants)) {
      map.set(uid, p.display_name ?? uid.slice(0, 8));
    }
    return map;
  }, [participants]);

  const layout = useMemo(
    () =>
      computeTimelineLayout(
        nodes,
        edges,
        pathResult,
        pathMode,
        currentUserId,
        zoomLevel,
        dateFormat,
        participantNames,
      ),
    [nodes, edges, pathResult, pathMode, currentUserId, zoomLevel, dateFormat, participantNames],
  );

  // Anchor scroll position on zoom change so content stays centered
  const prevZoomRef = useRef(zoomLevel);
  useEffect(() => {
    if (prevZoomRef.current === zoomLevel) return;
    const container = scrollContainerRef.current;
    if (container && container.scrollHeight > container.clientHeight) {
      const oldPxPerHour = PX_PER_HOUR[prevZoomRef.current];
      const newPxPerHour = PX_PER_HOUR[zoomLevel];
      const ratio = newPxPerHour / oldPxPerHour;
      const viewCenter = container.scrollTop + container.clientHeight / 2;
      const target = viewCenter * ratio - container.clientHeight / 2;
      const maxScroll = Math.max(0, container.scrollHeight * ratio - container.clientHeight);
      container.scrollTop = Math.min(maxScroll, Math.max(0, target));
    }
    prevZoomRef.current = zoomLevel;
  }, [zoomLevel]);

  // Scroll to selected node
  useEffect(() => {
    if (!selectedNodeId) return;
    const el = nodeBlockRefs.current.get(selectedNodeId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selectedNodeId]);

  // Scroll to today or first node on initial view
  useEffect(() => {
    if (hasScrolledInitially.current || nodes.length === 0) return;
    hasScrolledInitially.current = true;
    // Find today marker or just scroll to top
    const todayMarker = layout.dateMarkers.find((m) => m.isToday);
    if (todayMarker && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = Math.max(0, todayMarker.yOffsetPx - SCROLL_TOP_BUFFER_PX);
    }
  }, [layout, nodes]);

  // Dimmed node IDs (for "mine" path mode)
  const dimmedNodeIds = useMemo(() => {
    if (pathMode !== "mine" || !currentUserId || !pathResult) return null;
    const myPath = pathResult.paths.get(currentUserId);
    return myPath ? new Set(myPath) : null;
  }, [pathMode, currentUserId, pathResult]);

  const isSheetOpen = !!selectedNodeId || !!selectedEdgeId;

  // Empty state
  if (nodes.length === 0) {
    return <TimelineEmptyState tripId={tripId} />;
  }

  // All nodes missing times — escalated warning
  const allMissing = layout.missingTimeNodeIds.size === nodes.length && nodes.length > 0;

  return (
    <div className="relative flex flex-col h-full">
      {/* Summary warning banner */}
      {layout.missingTimeNodeIds.size >= 3 && (
        <div
          className="sticky top-0 z-[8] flex items-center gap-2 px-4 py-2 cursor-pointer"
          style={{ background: allMissing ? "var(--surface-high)" : "rgba(109,90,0,0.08)" }}
          onClick={() => {
            // Scroll to untimed section
            const container = scrollContainerRef.current;
            if (container) container.scrollTop = container.scrollHeight;
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6d5a00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className={`${allMissing ? "text-sm" : "text-xs"} font-medium text-on-surface-variant flex-1`}>
            {allMissing
              ? "All stops are missing times \u2014 add times to see the timeline"
              : `${layout.missingTimeNodeIds.size} stops are missing times \u2014 tap to review`
            }
          </span>
          {!allMissing && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#707978" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </div>
      )}

      {/* Scrollable content */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden pb-32"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div className="flex" style={{ minHeight: layout.totalHeightPx }}>
          {/* Date gutter */}
          <TimelineDateGutter
            dateMarkers={layout.dateMarkers}
            totalHeightPx={layout.totalHeightPx}
          />

          {/* Lane area */}
          <div className={`relative flex flex-1 min-w-0 ${layout.lanes.length > 3 ? "overflow-x-auto scroll-snap-x mandatory" : ""}`}>
            {/* Day divider lines — full-width horizontal at each new day in the
                primary lane's timezone. Rendered behind the lanes (z-0). */}
            {layout.dateMarkers.map((marker, i) => (
              <div
                key={`day-divider-${i}`}
                aria-hidden
                className="absolute left-0 right-0 pointer-events-none z-0 border-t border-dashed"
                style={{
                  top: marker.yOffsetPx,
                  borderColor: marker.isToday
                    ? "rgba(179,27,37,0.35)"
                    : "rgba(196,199,197,0.55)",
                }}
              />
            ))}
            {layout.lanes.map((lane, i) => (
              <div
                key={lane.laneId}
                className={`${layout.lanes.length > 3 ? "scroll-snap-start" : ""}`}
                style={{
                  flex: layout.lanes.length <= 3 ? 1 : "0 0 auto",
                  width: layout.lanes.length > 3 ? 111 : undefined,
                  borderRight: i < layout.lanes.length - 1 ? "1px solid rgba(196,199,197,0.4)" : undefined,
                }}
              >
                <TimelineLane
                  lane={lane}
                  selectedNodeId={selectedNodeId}
                  selectedEdgeId={selectedEdgeId}
                  onNodeSelect={onNodeSelect}
                  onEdgeSelect={onEdgeSelect}
                  onInsertStop={onInsertStop}
                  canEdit={canEdit}
                  datetimeFormat={datetimeFormat}
                  dateFormat={dateFormat}
                  distanceUnit={distanceUnit}
                  nodeBlockRefs={nodeBlockRefs}
                  dimmedNodeIds={dimmedNodeIds}
                  nodes={nodes}
                  edges={edges}
                />
              </div>
            ))}

            {/* "More paths" indicator for 4+ lanes */}
            {layout.lanes.length > 3 && (
              <div className="flex items-start justify-center pt-4 px-2">
                <div className="rounded-full bg-surface-high px-2.5 py-1">
                  <span className="text-xs font-semibold text-on-surface-variant whitespace-nowrap">
                    +{layout.lanes.length - 3} more
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Current time indicator */}
        <CurrentTimeIndicator layout={layout} />
      </div>

      {/* FAB */}
      {canEdit && (
        <button
          onClick={onAddNodeRequest}
          className={`fixed bottom-[72px] right-4 z-[25] h-14 w-14 rounded-full flex items-center justify-center text-on-primary shadow-float active:scale-95 transition-all duration-150 ${isSheetOpen ? "opacity-0 pointer-events-none" : "opacity-100"}`}
          style={{ background: "linear-gradient(135deg, #006479, #008299)" }}
          aria-label="Add stop"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}

      {/* Zoom controls */}
      <div className={`fixed right-3 bottom-[136px] z-[25] flex flex-col items-center rounded-[20px] bg-surface-lowest/90 shadow-soft transition-opacity duration-150 ${isSheetOpen ? "opacity-0 pointer-events-none" : "opacity-100"}`} style={{ width: 32 }}>
        <button
          onClick={() => onZoomChange(prev => Math.min(6, prev + 1) as TimelineZoomLevel)}
          disabled={zoomLevel >= 6}
          className="h-9 w-8 flex items-center justify-center text-on-surface-variant active:bg-surface-high active:scale-[0.94] transition-all rounded-t-[20px] disabled:opacity-30"
          aria-label="Zoom in"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <div className="w-5 h-px bg-surface-dim" />
        <button
          onClick={() => onZoomChange(prev => Math.max(0, prev - 1) as TimelineZoomLevel)}
          disabled={zoomLevel <= 0}
          className="h-9 w-8 flex items-center justify-center text-on-surface-variant active:bg-surface-high active:scale-[0.94] transition-all rounded-b-[20px] disabled:opacity-30"
          aria-label="Zoom out"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Current time indicator
// ---------------------------------------------------------------------------

function CurrentTimeIndicator({ layout }: {
  layout: ReturnType<typeof computeTimelineLayout>;
}) {
  // Find if current time falls within the trip's time range
  const now = new Date();

  // Get earliest and latest times from positioned nodes
  let earliestMs = Infinity;
  let latestMs = -Infinity;
  for (const lane of layout.lanes) {
    for (const pos of lane.positionedNodes.values()) {
      if (pos.resolvedArrival) {
        earliestMs = Math.min(earliestMs, pos.resolvedArrival.getTime());
      }
      if (pos.resolvedDeparture) {
        latestMs = Math.max(latestMs, pos.resolvedDeparture.getTime());
      }
    }
  }

  if (earliestMs === Infinity || latestMs === -Infinity) return null;
  const nowMs = now.getTime();
  if (nowMs < earliestMs || nowMs > latestMs) return null;

  // Find the Y position for current time by interpolating from positioned nodes
  // Use the first lane's nodes to estimate
  const primaryLane = layout.lanes[0];
  if (!primaryLane) return null;

  const sortedNodes = [...primaryLane.positionedNodes.values()]
    .filter((p) => p.resolvedArrival)
    .sort((a, b) => a.resolvedArrival!.getTime() - b.resolvedArrival!.getTime());

  if (sortedNodes.length === 0) return null;

  // Find surrounding nodes and interpolate Y for current time
  let yOffset = 0;
  let found = false;
  for (let i = 0; i < sortedNodes.length - 1; i++) {
    const curr = sortedNodes[i];
    const next = sortedNodes[i + 1];
    const currMs = curr.resolvedArrival!.getTime();
    const nextMs = next.resolvedArrival!.getTime();
    if (nowMs >= currMs && nowMs <= nextMs) {
      const span = nextMs - currMs;
      const ratio = span > 0 ? (nowMs - currMs) / span : 0;
      yOffset = curr.yOffsetPx + ratio * (next.yOffsetPx - curr.yOffsetPx);
      found = true;
      break;
    }
  }

  // Single-node lane or exact match at the only node
  if (!found && sortedNodes.length === 1) {
    const only = sortedNodes[0];
    if (nowMs >= only.resolvedArrival!.getTime()) {
      yOffset = only.yOffsetPx;
      found = true;
    }
  }

  if (!found) return null;

  return (
    <div
      className="absolute left-14 right-0 z-[5] pointer-events-none"
      style={{ top: yOffset }}
    >
      <div className="relative">
        <div className="absolute -left-[3px] -top-[3px] w-1.5 h-1.5 rounded-full bg-error" />
        <div className="h-px bg-error" />
      </div>
    </div>
  );
}
