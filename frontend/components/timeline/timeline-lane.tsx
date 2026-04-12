"use client";

import { Fragment, memo } from "react";
import { TimelineNodeBlock } from "./timeline-node-block";
import { TimelineEdgeConnector } from "./timeline-edge-connector";
import type { LaneLayout, PositionedEdge } from "@/lib/timeline-layout";

interface TimelineLaneProps {
  lane: LaneLayout;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNodeSelect: (nodeId: string) => void;
  onEdgeSelect: (edgeId: string) => void;
  onInsertStop: (edgeId: string) => void;
  canEdit: boolean;
  datetimeFormat: "12h" | "24h";
  dateFormat: "eu" | "us" | "iso" | "short";
  distanceUnit: "km" | "mi";
  nodeBlockRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  dimmedNodeIds?: Set<string> | null;
  nodes: Array<{ id: string; name: string; type: string; arrival_time: string | null; departure_time: string | null; timezone?: string | null; [key: string]: unknown }>;
  edges: Array<{ id: string; from_node_id: string; to_node_id: string; travel_mode: string; travel_time_hours: number; travel_time_estimated?: boolean; distance_km: number | null; [key: string]: unknown }>;
}

export const TimelineLane = memo(function TimelineLane({
  lane,
  selectedNodeId,
  selectedEdgeId,
  onNodeSelect,
  onEdgeSelect,
  onInsertStop,
  canEdit,
  datetimeFormat,
  dateFormat,
  distanceUnit,
  nodeBlockRefs,
  dimmedNodeIds,
  nodes,
  edges,
}: TimelineLaneProps) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Compute timezone transitions between consecutive nodes
  function getUtcOffset(iso: string | null, timezone: string | undefined): { offsetMinutes: number; label: string } | null {
    if (!iso || !timezone) return null;
    try {
      const date = new Date(iso);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        timeZoneName: "shortOffset",
      }).formatToParts(date);
      const tzPart = parts.find((p) => p.type === "timeZoneName");
      const label = tzPart?.value ?? "";

      // Parse offset directly from label (e.g. "GMT-6" → -360, "GMT+5:30" → 330, "GMT" → 0)
      const match = label.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
      if (!match) return { offsetMinutes: 0, label };
      const sign = match[1] === "-" ? -1 : 1;
      const hours = parseInt(match[2], 10);
      const minutes = parseInt(match[3] ?? "0", 10);
      return { offsetMinutes: sign * (hours * 60 + minutes), label };
    } catch {
      return null;
    }
  }

  function getTimezoneTransition(fromNodeId: string, toNodeId: string) {
    const fromNode = nodeMap.get(fromNodeId);
    const toNode = nodeMap.get(toNodeId);
    if (!fromNode || !toNode) return null;

    const fromTz = fromNode.timezone;
    const toTz = toNode.timezone;
    if (!fromTz || !toTz) return null;

    const fromOffset = getUtcOffset(fromNode.departure_time ?? fromNode.arrival_time, fromTz ?? undefined);
    const toOffset = getUtcOffset(toNode.arrival_time, toTz ?? undefined);
    if (!fromOffset || !toOffset) return null;
    if (fromOffset.offsetMinutes === toOffset.offsetMinutes) return null;

    return {
      fromOffset: fromOffset.label,
      toOffset: toOffset.label,
      hoursDiff: (toOffset.offsetMinutes - fromOffset.offsetMinutes) / 60,
    };
  }

  // Build a quick lookup for edges between sequential nodes
  const edgeLookup = new Map<string, typeof edges[number]>();
  for (const e of edges) {
    edgeLookup.set(`${e.from_node_id}->${e.to_node_id}`, e);
  }

  // Separate timed and untimed nodes. After upstream enrichment, a node with
  // a null `resolvedArrival` really has no derivable time and belongs in the
  // untimed bucket — there is no interpolation flag to distinguish.
  const timedNodeIds: string[] = [];
  const untimedNodeIds: string[] = [];
  for (const nodeId of lane.nodeSequence) {
    const pos = lane.positionedNodes.get(nodeId);
    if (pos && pos.resolvedArrival === null) {
      untimedNodeIds.push(nodeId);
    } else {
      timedNodeIds.push(nodeId);
    }
  }

  // Compute lane total height
  let totalLaneHeight = 0;
  for (const pos of lane.positionedNodes.values()) {
    totalLaneHeight = Math.max(totalLaneHeight, pos.yOffsetPx + pos.heightPx);
  }

  // Untimed section divider position
  const firstUntimedPos = untimedNodeIds.length > 0 ? lane.positionedNodes.get(untimedNodeIds[0]) : null;
  const untimedDividerTop = firstUntimedPos ? firstUntimedPos.yOffsetPx - 20 : 0;

  return (
    <div className="relative flex-1 group" style={{ minHeight: totalLaneHeight }}>
      {/* Participant label for multi-lane */}
      {lane.participantLabel && (
        <div className="sticky top-0 z-[1] mx-3 px-2 py-1 rounded bg-surface-low text-[10px] font-semibold text-on-surface-variant">
          {lane.participantLabel}
        </div>
      )}

      {/* Timed nodes and connectors — absolutely positioned */}
      {timedNodeIds.map((nodeId, i) => {
        const pos = lane.positionedNodes.get(nodeId);
        const node = nodeMap.get(nodeId);
        if (!pos || !node) return null;

        const isDimmed = dimmedNodeIds ? !dimmedNodeIds.has(nodeId) : false;

        // Find edge to next node
        let edgeToNext: PositionedEdge | undefined;
        if (i < timedNodeIds.length - 1) {
          const nextNodeId = timedNodeIds[i + 1];
          for (const [, pe] of lane.positionedEdges) {
            if (pe.fromNodeId === nodeId && pe.toNodeId === nextNodeId) {
              edgeToNext = pe;
              break;
            }
          }
        }

        const rawEdge = edgeToNext
          ? edgeLookup.get(`${edgeToNext.fromNodeId}->${edgeToNext.toNodeId}`)
          : undefined;

        // Check for gap region after this node
        const gapAfter = lane.gapRegions.find((g) => g.afterNodeId === nodeId);
        const gapHeight = gapAfter ? gapAfter.compressedHeightPx : 0;
        const nodeBottom = pos.yOffsetPx + pos.heightPx;

        return (
          <Fragment key={nodeId}>
            {/* Merge chip — before the node block */}
            {pos.sharedNodeRole === "merge" && (
              <div className="absolute left-3 right-3 flex justify-center" style={{ top: pos.yOffsetPx - 18 }}>
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-low">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-on-surface-variant">
                    <path d="M18 6 7 17l-5-5" />
                    <path d="m22 10-7.5 7.5L13 16" />
                  </svg>
                  <span className="text-[9px] font-medium text-on-surface-variant">Paths rejoin</span>
                </div>
              </div>
            )}

            {/* Node block */}
            <div className="absolute left-3 right-3" style={{ top: pos.yOffsetPx }}>
              <TimelineNodeBlock
                nodeId={nodeId}
                name={node.name}
                type={node.type}
                arrivalTime={node.arrival_time}
                departureTime={node.departure_time}
                timezone={node.timezone ?? undefined}
                heightPx={pos.heightPx}
                hasMissingTime={pos.hasMissingTime}
                arrivalEstimated={pos.arrivalEstimated}
                departureEstimated={pos.departureEstimated}
                overnightHold={pos.overnightHold}
                holdReason={pos.holdReason}
                driveCap={pos.driveCap}
                timingConflict={pos.timingConflict}
                spansDays={pos.spansDays}
                selected={selectedNodeId === nodeId}
                dimmed={isDimmed}
                isShared={pos.isShared}
                datetimeFormat={datetimeFormat}
                dateFormat={dateFormat}
                onSelect={onNodeSelect}
                blockRef={(el) => {
                  if (el) {
                    nodeBlockRefs.current.set(nodeId, el);
                  } else {
                    nodeBlockRefs.current.delete(nodeId);
                  }
                }}
              />
            </div>

            {/* Diverge chip — after the node block */}
            {pos.sharedNodeRole === "diverge" && (
              <div className="absolute left-3 right-3 flex justify-center" style={{ top: pos.yOffsetPx + pos.heightPx + 2 }}>
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-low">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-on-surface-variant">
                    <path d="M16 3h5v5" />
                    <path d="M8 3H3v5" />
                    <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
                    <path d="m15 9 6-6" />
                  </svg>
                  <span className="text-[9px] font-medium text-on-surface-variant">Paths split</span>
                </div>
              </div>
            )}

            {/* Gap indicator */}
            {gapAfter && (
              <div
                className="absolute left-3 right-3 flex items-center justify-center rounded-lg bg-surface-low/60 border-y border-dashed border-surface-dim"
                style={{ top: nodeBottom, height: gapHeight }}
              >
                <div className="flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-outline-variant">
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                  </svg>
                  <span className="text-[10px] font-medium text-on-surface-variant">
                    ~{gapAfter.realDurationHours >= 24
                      ? `${Math.round(gapAfter.realDurationHours / 24)} days idle`
                      : `${Math.round(gapAfter.realDurationHours)}h idle`
                    }
                  </span>
                </div>
              </div>
            )}

            {/* Edge connector */}
            {edgeToNext && rawEdge && (
              <div className="absolute left-3 right-3" style={{ top: nodeBottom + gapHeight }}>
                <TimelineEdgeConnector
                  edgeId={edgeToNext.edgeId}
                  travelMode={rawEdge.travel_mode}
                  travelTimeHours={rawEdge.travel_time_hours}
                  travelTimeEstimated={rawEdge.travel_time_estimated}
                  distanceKm={rawEdge.distance_km}
                  distanceUnit={distanceUnit}
                  connectorHeightPx={Math.max(40, edgeToNext.connectorHeightPx - gapHeight)}
                  hasTimingWarning={edgeToNext.hasTimingWarning}
                  hasNote={!!rawEdge.notes}
                  selected={selectedEdgeId === edgeToNext.edgeId}
                  dimmed={isDimmed}
                  canEdit={canEdit}
                  timezoneTransition={getTimezoneTransition(edgeToNext.fromNodeId, edgeToNext.toNodeId)}
                  onSelect={onEdgeSelect}
                  onInsertStop={onInsertStop}
                />
              </div>
            )}
          </Fragment>
        );
      })}

      {/* Untimed nodes section */}
      {untimedNodeIds.length > 0 && (
        <>
          {/* Tinted background region */}
          <div
            className="absolute left-0 right-0 bg-surface-low/40 rounded-b-xl"
            style={{ top: untimedDividerTop - 8, bottom: 0 }}
          />

          {/* Divider */}
          <div className="absolute left-3 right-3 z-[1] flex items-center gap-2" style={{ top: untimedDividerTop }}>
            <div className="flex-1 border-t border-dashed border-outline-variant" />
            <span className="text-[10px] font-medium text-on-surface-variant">Untimed stops</span>
            <div className="flex-1 border-t border-dashed border-outline-variant" />
          </div>

          {/* Untimed node blocks */}
          {untimedNodeIds.map((nodeId) => {
            const pos = lane.positionedNodes.get(nodeId);
            const node = nodeMap.get(nodeId);
            if (!pos || !node) return null;

            return (
              <div key={nodeId} className="absolute left-3 right-3 z-[1]" style={{ top: pos.yOffsetPx }}>
                <TimelineNodeBlock
                  nodeId={nodeId}
                  name={node.name}
                  type={node.type}
                  arrivalTime={null}
                  departureTime={null}
                  heightPx={56}
                  hasMissingTime={true}
                  selected={selectedNodeId === nodeId}
                  dimmed={false}
                  datetimeFormat={datetimeFormat}
                  dateFormat={dateFormat}
                  onSelect={onNodeSelect}
                  blockRef={(el) => {
                    if (el) {
                      nodeBlockRefs.current.set(nodeId, el);
                    } else {
                      nodeBlockRefs.current.delete(nodeId);
                    }
                  }}
                />
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}, (prev, next) =>
  prev.lane === next.lane &&
  prev.selectedNodeId === next.selectedNodeId &&
  prev.selectedEdgeId === next.selectedEdgeId &&
  prev.dimmedNodeIds === next.dimmedNodeIds &&
  prev.nodes === next.nodes &&
  prev.edges === next.edges
);
