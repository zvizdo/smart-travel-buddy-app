/**
 * Timeline layout algorithm.
 *
 * Pure function that computes vertical positions for nodes and edges
 * from raw Firestore data. No React dependencies.
 */

import { type PathResult } from "@/lib/path-computation";
import { formatUserName } from "@/lib/user-display";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimelineZoomLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Pixels per hour for each zoom level. Level 2 is the default (8 px/h). */
export const PX_PER_HOUR: Record<TimelineZoomLevel, number> = {
  0: 2,
  1: 4,
  2: 8,
  3: 16,
  4: 32,
  5: 60,
  6: 120,
};

export type TimingConflictSeverity = "info" | "advisory" | "error";

export interface PositionedNode {
  nodeId: string;
  yOffsetPx: number;
  heightPx: number;
  laneIndex: number;
  hasMissingTime: boolean;
  resolvedArrival: Date | null;
  resolvedDeparture: Date | null;
  arrivalEstimated: boolean;
  departureEstimated: boolean;
  durationEstimated: boolean;
  overnightHold: boolean;
  holdReason: "night_drive" | "max_drive_hours" | null;
  driveCap: boolean;
  timingConflict: string | null;
  timingConflictSeverity: TimingConflictSeverity | null;
  spansDays: number;
  isShared?: boolean;
  sharedNodeRole?: "diverge" | "merge" | null;
}

export interface PositionedEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  connectorHeightPx: number;
  hasTimingWarning: boolean;
}

export interface LaneLayout {
  laneId: string;
  participantLabel: string | null;
  nodeSequence: string[];
  positionedNodes: Map<string, PositionedNode>;
  positionedEdges: Map<string, PositionedEdge>;
  gapRegions: GapRegion[];
}

export interface GapRegion {
  afterNodeId: string;
  compressedHeightPx: number;
  realDurationHours: number;
}

export interface DateMarker {
  yOffsetPx: number;
  label: string;
  isToday: boolean;
}

export interface TimelineLayout {
  lanes: LaneLayout[];
  dateMarkers: DateMarker[];
  totalHeightPx: number;
  missingTimeNodeIds: Set<string>;
  timingConflictEdgeIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Interfaces for input data (mirrors page.tsx types)
// ---------------------------------------------------------------------------

interface NodeData {
  id: string;
  name: string;
  type: string;
  lat_lng: { lat: number; lng: number } | null;
  arrival_time: string | null;
  departure_time: string | null;
  duration_minutes?: number | null;
  participant_ids?: string[] | null;
  timezone?: string | null;
  // Enrichment flags populated by `enrichDagTimes`. Optional for callers
  // that pass raw Firestore data (tests); production always runs through
  // `useEnrichedNodes` first so these are present.
  arrival_time_estimated?: boolean;
  departure_time_estimated?: boolean;
  duration_estimated?: boolean;
  timing_conflict?: string | null;
  timing_conflict_severity?: TimingConflictSeverity | null;
  hold_reason?: "night_drive" | "max_drive_hours" | null;
  drive_cap_warning?: boolean;
  is_start?: boolean;
  is_end?: boolean;
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface ResolvedTime {
  arrival: Date | null;
  departure: Date | null;
  hasMissing: boolean;
  arrivalEstimated: boolean;
  departureEstimated: boolean;
  durationEstimated: boolean;
  timingConflict: string | null;
  timingConflictSeverity: TimingConflictSeverity | null;
  overnightHold: boolean;
  holdReason: "night_drive" | "max_drive_hours" | null;
  driveCap: boolean;
}

const MIN_NODE_HEIGHT_PX = 56;
const MIN_CONNECTOR_HEIGHT_PX = 40;
const GAP_THRESHOLD_HOURS = 8;
const GAP_COMPRESSED_HEIGHT_PX = 40;
const ORPHAN_SPACING_PX = 72;
const BOTTOM_PADDING_PX = 80;
const START_OFFSET_PX = 48;
const TIMING_WARNING_THRESHOLD_MIN = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAdjacency(edges: EdgeData[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const children = adj.get(e.from_node_id) ?? [];
    children.push(e.to_node_id);
    adj.set(e.from_node_id, children);
  }
  return adj;
}

function buildReverseAdjacency(edges: EdgeData[]): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    const parents = rev.get(e.to_node_id) ?? [];
    parents.push(e.from_node_id);
    rev.set(e.to_node_id, parents);
  }
  return rev;
}

function findEdgeBetween(edges: EdgeData[], fromId: string, toId: string): EdgeData | undefined {
  return edges.find((e) => e.from_node_id === fromId && e.to_node_id === toId);
}

/**
 * Compute gap compression offsets for a sorted sequence of timed nodes.
 * Returns a per-node cumulative compression offset (to subtract from raw Y)
 * plus the list of compressed gap regions.
 *
 * Used by both the multi-lane global pass and the single-lane per-lane pass.
 */
function compressGaps(
  timedNodes: { id: string; arrival: Date; departure: Date | null }[],
  edges: EdgeData[],
  pxPerHour: number,
): { compressionOffsets: Map<string, number>; gapRegions: GapRegion[] } {
  const compressionOffsets = new Map<string, number>();
  const gapRegions: GapRegion[] = [];
  let cumulativeCompression = 0;

  for (let i = 0; i < timedNodes.length; i++) {
    compressionOffsets.set(timedNodes[i].id, cumulativeCompression);

    if (i >= timedNodes.length - 1) continue;
    const curr = timedNodes[i];
    const next = timedNodes[i + 1];
    const currEnd = curr.departure ?? curr.arrival;
    const gapHours = (next.arrival.getTime() - currEnd.getTime()) / 3_600_000;
    const edge = findEdgeBetween(edges, curr.id, next.id);
    const travelHours = edge?.travel_time_hours ?? 0;
    const idleHours = gapHours - travelHours;

    if (idleHours > GAP_THRESHOLD_HOURS) {
      const savedPx = idleHours * pxPerHour - GAP_COMPRESSED_HEIGHT_PX;
      cumulativeCompression += savedPx;
      gapRegions.push({
        afterNodeId: curr.id,
        compressedHeightPx: GAP_COMPRESSED_HEIGHT_PX,
        realDurationHours: idleHours,
      });
    }
  }

  return { compressionOffsets, gapRegions };
}

/** Topological sort via Kahn's algorithm. Returns node IDs in order. */
function topoSort(nodeIds: string[], edges: EdgeData[]): string[] {
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const nodeSet = new Set(nodeIds);

  for (const id of nodeIds) {
    inDeg.set(id, 0);
    adj.set(id, []);
  }

  for (const e of edges) {
    if (!nodeSet.has(e.from_node_id) || !nodeSet.has(e.to_node_id)) continue;
    adj.get(e.from_node_id)!.push(e.to_node_id);
    inDeg.set(e.to_node_id, (inDeg.get(e.to_node_id) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    sorted.push(cur);
    for (const child of adj.get(cur) ?? []) {
      const newDeg = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  return sorted;
}

function isSameDay(a: Date, b: Date, timezone: string): boolean {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  return fmt.format(a) === fmt.format(b);
}

function isToday(date: Date, timezone: string): boolean {
  return isSameDay(date, new Date(), timezone);
}

/**
 * Number of calendar day boundaries a node crosses between its arrival and
 * departure in the given zone. Same-day stays = 0, overnight = 1, etc.
 */
function daysSpanned(
  arrival: Date,
  departure: Date | null,
  timezone: string,
): number {
  if (!departure) return 0;
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  });
  const toDayMs = (d: Date): number => {
    const parts = fmt.formatToParts(d);
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"));
  };
  const aDay = toDayMs(arrival);
  const dDay = toDayMs(departure);
  return Math.max(0, Math.round((dDay - aDay) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

export function computeTimelineLayout(
  nodes: NodeData[],
  edges: EdgeData[],
  pathResult: PathResult | null,
  pathMode: "all" | "mine",
  currentUserId: string | null,
  zoomLevel: TimelineZoomLevel,
  _dateFormat: "eu" | "us" | "iso" | "short",
  participantNames?: Map<string, string>,
): TimelineLayout {
  // Edge case: no nodes
  if (nodes.length === 0) {
    return {
      lanes: [],
      dateMarkers: [],
      totalHeightPx: 0,
      missingTimeNodeIds: new Set(),
      timingConflictEdgeIds: new Set(),
    };
  }

  const nodeMap = new Map<string, NodeData>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const adj = buildAdjacency(edges);
  const revAdj = buildReverseAdjacency(edges);
  const pxPerHour = PX_PER_HOUR[zoomLevel];

  // -----------------------------------------------------------------------
  // Step 1: Determine active lanes
  // -----------------------------------------------------------------------
  const laneDefinitions = determineLanes(nodes, edges, pathResult, pathMode, currentUserId, participantNames);

  // -----------------------------------------------------------------------
  // Step 2: Read timing fields directly from nodes.
  //
  // Enrichment is upstream now (`useEnrichedNodes` → `enrichDagTimes`) so
  // the timeline layout only needs to consume already-enriched nodes. It no
  // longer interpolates anything itself — if `arrival_time` is still null
  // after enrichment, the node really has no derivable time and should be
  // bucketed as untimed.
  // -----------------------------------------------------------------------
  const resolvedTimes = new Map<string, ResolvedTime>();
  const missingTimeNodeIds = new Set<string>();

  for (const node of nodes) {
    const arrival = node.arrival_time ? new Date(node.arrival_time) : null;
    const departure = node.departure_time ? new Date(node.departure_time) : null;
    const hasMissing = !arrival;
    if (hasMissing) missingTimeNodeIds.add(node.id);
    resolvedTimes.set(node.id, {
      arrival,
      departure,
      hasMissing,
      arrivalEstimated: node.arrival_time_estimated ?? false,
      departureEstimated: node.departure_time_estimated ?? false,
      durationEstimated: node.duration_estimated ?? false,
      timingConflict: node.timing_conflict ?? null,
      timingConflictSeverity: node.timing_conflict_severity ?? null,
      overnightHold: node.hold_reason != null,
      holdReason: node.hold_reason ?? null,
      driveCap: node.drive_cap_warning ?? false,
    });
  }

  // -----------------------------------------------------------------------
  // Step 3-7: Compute positions per lane
  // -----------------------------------------------------------------------
  const timingConflictEdgeIds = new Set<string>();

  // Collect only nodes that appear in at least one lane — nodes outside all
  // lanes (e.g. a 3rd root not assigned to any participant) must not affect
  // the earliest-time anchor or cause empty space.
  const laneNodeIdSet = new Set<string>();
  for (const laneDef of laneDefinitions) {
    for (const nodeId of laneDef.nodeIds) laneNodeIdSet.add(nodeId);
  }

  const allTimedArrivals: number[] = [];
  for (const nodeId of laneNodeIdSet) {
    const resolved = resolvedTimes.get(nodeId);
    if (resolved?.arrival) allTimedArrivals.push(resolved.arrival.getTime());
  }

  const earliestMs = allTimedArrivals.length > 0 ? Math.min(...allTimedArrivals) : 0;
  const allNodesUntimed = allTimedArrivals.length === 0;
  const isMultiLane = laneDefinitions.length > 1;

  // -----------------------------------------------------------------------
  // Compute shared node IDs across lanes (for participant-based lanes too)
  // -----------------------------------------------------------------------
  const globalSharedNodeIds = new Set<string>();
  if (isMultiLane) {
    const nodeAppearanceCount = new Map<string, number>();
    for (const laneDef of laneDefinitions) {
      for (const nodeId of laneDef.nodeIds) {
        nodeAppearanceCount.set(nodeId, (nodeAppearanceCount.get(nodeId) ?? 0) + 1);
      }
    }
    for (const [nodeId, count] of nodeAppearanceCount) {
      if (count > 1) globalSharedNodeIds.add(nodeId);
    }
  }

  // -----------------------------------------------------------------------
  // Multi-lane: compute global Y positions so lanes align on the same timeline
  // -----------------------------------------------------------------------
  const globalNodePositions = new Map<string, { yOffsetPx: number; heightPx: number }>();
  const globalGapRegions: GapRegion[] = [];

  if (isMultiLane && !allNodesUntimed) {
    // Collect all unique timed nodes across all lanes
    const allTimedNodes: { id: string; arrival: Date; departure: Date | null }[] = [];
    const seen = new Set<string>();
    for (const laneDef of laneDefinitions) {
      for (const nodeId of laneDef.nodeIds) {
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        const resolved = resolvedTimes.get(nodeId)!;
        if (resolved.arrival) {
          allTimedNodes.push({ id: nodeId, arrival: resolved.arrival, departure: resolved.departure });
        }
      }
    }
    allTimedNodes.sort((a, b) => a.arrival.getTime() - b.arrival.getTime());

    // Compute raw Y + height for each node
    const rawPositions = new Map<string, { y: number; height: number }>();
    for (const node of allTimedNodes) {
      const rawY = START_OFFSET_PX + ((node.arrival.getTime() - earliestMs) / 3_600_000) * pxPerHour;
      let heightPx = MIN_NODE_HEIGHT_PX;
      if (node.departure) {
        const durationHours = (node.departure.getTime() - node.arrival.getTime()) / 3_600_000;
        heightPx = Math.max(MIN_NODE_HEIGHT_PX, durationHours * pxPerHour);
      }
      rawPositions.set(node.id, { y: rawY, height: heightPx });
    }

    // Compute global gap compression
    const { compressionOffsets, gapRegions: globalGaps } = compressGaps(
      allTimedNodes,
      edges,
      pxPerHour,
    );
    globalGapRegions.push(...globalGaps);

    // Apply compression and enforce minimum spacing
    let prevBottom = 0;
    for (let i = 0; i < allTimedNodes.length; i++) {
      const nodeId = allTimedNodes[i].id;
      const { y: rawY, height: heightPx } = rawPositions.get(nodeId)!;
      const compression = compressionOffsets.get(nodeId) ?? 0;
      let yOffset = rawY - compression;

      if (i > 0) {
        const prevNodeId = allTimedNodes[i - 1].id;
        const edge = findEdgeBetween(edges, prevNodeId, nodeId);
        const minConnector = edge ? MIN_CONNECTOR_HEIGHT_PX : 0;
        const hasGap = globalGapRegions.some((g) => g.afterNodeId === prevNodeId);
        const gapExtra = hasGap ? GAP_COMPRESSED_HEIGHT_PX : 0;
        yOffset = Math.max(yOffset, prevBottom + minConnector + gapExtra);
      }

      globalNodePositions.set(nodeId, { yOffsetPx: yOffset, heightPx });
      prevBottom = yOffset + heightPx;
    }
  }

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function getEnrichmentProps(nodeId: string, resolved: ResolvedTime) {
    const node = nodeMap.get(nodeId);
    const tz = node?.timezone ?? browserTz;
    const spansDays = resolved.arrival
      ? daysSpanned(resolved.arrival, resolved.departure, tz)
      : 0;
    return {
      arrivalEstimated: resolved.arrivalEstimated,
      departureEstimated: resolved.departureEstimated,
      durationEstimated: resolved.durationEstimated,
      overnightHold: resolved.overnightHold,
      holdReason: resolved.holdReason,
      driveCap: resolved.driveCap,
      timingConflict: resolved.timingConflict,
      timingConflictSeverity: resolved.timingConflictSeverity,
      spansDays,
    };
  }

  const lanes: LaneLayout[] = [];

  for (let li = 0; li < laneDefinitions.length; li++) {
    const laneDef = laneDefinitions[li];
    const laneNodeIds = laneDef.nodeIds;
    const positionedNodes = new Map<string, PositionedNode>();
    const positionedEdges = new Map<string, PositionedEdge>();
    const gapRegions: GapRegion[] = [];
    const sharedSet = laneDef.sharedNodeIds ?? globalSharedNodeIds;

    function getSharedProps(nodeId: string) {
      const isShared = sharedSet.has(nodeId);
      let sharedNodeRole: "diverge" | "merge" | null = null;
      if (isShared) {
        const outDeg = (adj.get(nodeId) ?? []).length;
        const inDeg = (revAdj.get(nodeId) ?? []).length;
        if (outDeg >= 2) sharedNodeRole = "diverge";
        else if (inDeg >= 2) sharedNodeRole = "merge";
      }
      return { isShared, sharedNodeRole };
    }

    // Sort nodes by resolved arrival, fallback to topological order
    const sortedNodeIds = sortNodesByTime(laneNodeIds, resolvedTimes, edges);

    if (allNodesUntimed) {
      // All missing times — stack at equal spacing
      for (let i = 0; i < sortedNodeIds.length; i++) {
        const nodeId = sortedNodeIds[i];
        const resolved = resolvedTimes.get(nodeId)!;
        positionedNodes.set(nodeId, {
          nodeId,
          yOffsetPx: i * ORPHAN_SPACING_PX,
          heightPx: MIN_NODE_HEIGHT_PX,
          laneIndex: li,
          hasMissingTime: true,
          resolvedArrival: null,
          resolvedDeparture: null,
          ...getEnrichmentProps(nodeId, resolved),
          ...getSharedProps(nodeId),
        });
      }

      // Add edges between sequential nodes
      for (let i = 0; i < sortedNodeIds.length - 1; i++) {
        const edge = findEdgeBetween(edges, sortedNodeIds[i], sortedNodeIds[i + 1]);
        if (edge) {
          positionedEdges.set(edge.id, {
            edgeId: edge.id,
            fromNodeId: edge.from_node_id,
            toNodeId: edge.to_node_id,
            connectorHeightPx: ORPHAN_SPACING_PX - MIN_NODE_HEIGHT_PX,
            hasTimingWarning: false,
          });
        }
      }

      lanes.push({
        laneId: laneDef.laneId,
        participantLabel: laneDef.label,
        nodeSequence: sortedNodeIds,
        positionedNodes,
        positionedEdges,
        gapRegions,
      });
      continue;
    }

    // Separate timed and untimed nodes
    const timedNodeIds: string[] = [];
    const untimedNodeIds: string[] = [];
    for (const nodeId of sortedNodeIds) {
      const resolved = resolvedTimes.get(nodeId)!;
      if (resolved.arrival) {
        timedNodeIds.push(nodeId);
      } else {
        untimedNodeIds.push(nodeId);
      }
    }

    // Step 3-6: Compute positions for timed nodes
    let currentY = 0;

    if (isMultiLane) {
      // Multi-lane: use pre-computed global positions for alignment
      for (let i = 0; i < timedNodeIds.length; i++) {
        const nodeId = timedNodeIds[i];
        const resolved = resolvedTimes.get(nodeId)!;
        const globalPos = globalNodePositions.get(nodeId);

        if (globalPos) {
          positionedNodes.set(nodeId, {
            nodeId,
            yOffsetPx: globalPos.yOffsetPx,
            heightPx: globalPos.heightPx,
            laneIndex: li,
            hasMissingTime: resolved.hasMissing,
            resolvedArrival: resolved.arrival,
            resolvedDeparture: resolved.departure,
            ...getEnrichmentProps(nodeId, resolved),
            ...getSharedProps(nodeId),
          });
          currentY = globalPos.yOffsetPx + globalPos.heightPx;
        }
      }

      // Copy relevant global gap regions into this lane
      const laneNodeSet = new Set(laneNodeIds);
      for (const gap of globalGapRegions) {
        if (laneNodeSet.has(gap.afterNodeId)) {
          gapRegions.push(gap);
        }
      }
    } else {
      // Single-lane: original per-lane computation with gap compression
      const nodeYPositions = new Map<string, { y: number; height: number }>();

      for (let i = 0; i < timedNodeIds.length; i++) {
        const nodeId = timedNodeIds[i];
        const resolved = resolvedTimes.get(nodeId)!;
        const arrival = resolved.arrival!;
        const departure = resolved.departure;

        const rawY = START_OFFSET_PX + ((arrival.getTime() - earliestMs) / 3_600_000) * pxPerHour;
        let heightPx = MIN_NODE_HEIGHT_PX;
        if (departure) {
          const durationHours = (departure.getTime() - arrival.getTime()) / 3_600_000;
          heightPx = Math.max(MIN_NODE_HEIGHT_PX, durationHours * pxPerHour);
        }
        nodeYPositions.set(nodeId, { y: rawY, height: heightPx });
      }

      // Gap compression
      const laneTimedNodes = timedNodeIds.map((id) => {
        const resolved = resolvedTimes.get(id)!;
        return { id, arrival: resolved.arrival!, departure: resolved.departure };
      });
      const { compressionOffsets, gapRegions: laneGaps } = compressGaps(
        laneTimedNodes,
        edges,
        pxPerHour,
      );
      gapRegions.push(...laneGaps);

      // Apply positions with compression and enforce minimums
      let prevBottom = 0;
      for (let i = 0; i < timedNodeIds.length; i++) {
        const nodeId = timedNodeIds[i];
        const { y: rawY, height: heightPx } = nodeYPositions.get(nodeId)!;
        const resolved = resolvedTimes.get(nodeId)!;
        const compression = compressionOffsets.get(nodeId) ?? 0;

        let yOffset = rawY - compression;

        if (i > 0) {
          const prevNodeId = timedNodeIds[i - 1];
          const edge = findEdgeBetween(edges, prevNodeId, nodeId);
          const minConnector = edge ? MIN_CONNECTOR_HEIGHT_PX : 0;
          const hasGap = gapRegions.some((g) => g.afterNodeId === prevNodeId);
          const gapExtra = hasGap ? GAP_COMPRESSED_HEIGHT_PX : 0;
          const minY = prevBottom + minConnector + gapExtra;
          yOffset = Math.max(yOffset, minY);
        }

        positionedNodes.set(nodeId, {
          nodeId,
          yOffsetPx: yOffset,
          heightPx,
          laneIndex: li,
          hasMissingTime: resolved.hasMissing,
          resolvedArrival: resolved.arrival,
          resolvedDeparture: resolved.departure,
          ...getEnrichmentProps(nodeId, resolved),
          ...getSharedProps(nodeId),
        });

        prevBottom = yOffset + heightPx;
        currentY = prevBottom;
      }
    }

    // Step 7: Compute connector heights + Step 8: Timing warnings
    for (let i = 0; i < timedNodeIds.length - 1; i++) {
      const fromId = timedNodeIds[i];
      const toId = timedNodeIds[i + 1];
      const edge = findEdgeBetween(edges, fromId, toId);
      if (!edge) continue;

      const fromPos = positionedNodes.get(fromId)!;
      const toPos = positionedNodes.get(toId)!;
      const connectorHeightPx = Math.max(
        MIN_CONNECTOR_HEIGHT_PX,
        toPos.yOffsetPx - (fromPos.yOffsetPx + fromPos.heightPx),
      );

      // Timing warning check
      let hasTimingWarning = false;
      const fromNode = nodeMap.get(fromId);
      const toNode = nodeMap.get(toId);
      const depTime = fromNode?.departure_time ?? fromNode?.arrival_time;
      const arrTime = toNode?.arrival_time;
      if (depTime && arrTime && edge.travel_time_hours > 0) {
        const depMs = new Date(depTime).getTime();
        const arrMs = new Date(arrTime).getTime();
        const travelMs = edge.travel_time_hours * 3_600_000;
        const deficitMin = Math.round((depMs + travelMs - arrMs) / 60_000);
        if (deficitMin > TIMING_WARNING_THRESHOLD_MIN) {
          hasTimingWarning = true;
          timingConflictEdgeIds.add(edge.id);
        }
      }

      positionedEdges.set(edge.id, {
        edgeId: edge.id,
        fromNodeId: fromId,
        toNodeId: toId,
        connectorHeightPx,
        hasTimingWarning,
      });
    }

    // Also add edges not between sequential timed nodes (diagonal edges in DAG)
    for (const edge of edges) {
      if (positionedEdges.has(edge.id)) continue;
      const fromInLane = laneNodeIds.includes(edge.from_node_id);
      const toInLane = laneNodeIds.includes(edge.to_node_id);
      if (!fromInLane || !toInLane) continue;

      const fromPos = positionedNodes.get(edge.from_node_id);
      const toPos = positionedNodes.get(edge.to_node_id);
      if (!fromPos || !toPos) continue;

      const connectorHeightPx = Math.max(
        MIN_CONNECTOR_HEIGHT_PX,
        toPos.yOffsetPx - (fromPos.yOffsetPx + fromPos.heightPx),
      );

      let hasTimingWarning = false;
      const fromNode = nodeMap.get(edge.from_node_id);
      const toNode = nodeMap.get(edge.to_node_id);
      const depTime = fromNode?.departure_time ?? fromNode?.arrival_time;
      const arrTime = toNode?.arrival_time;
      if (depTime && arrTime && edge.travel_time_hours > 0) {
        const depMs = new Date(depTime).getTime();
        const arrMs = new Date(arrTime).getTime();
        const travelMs = edge.travel_time_hours * 3_600_000;
        const deficitMin = Math.round((depMs + travelMs - arrMs) / 60_000);
        if (deficitMin > TIMING_WARNING_THRESHOLD_MIN) {
          hasTimingWarning = true;
          timingConflictEdgeIds.add(edge.id);
        }
      }

      positionedEdges.set(edge.id, {
        edgeId: edge.id,
        fromNodeId: edge.from_node_id,
        toNodeId: edge.to_node_id,
        connectorHeightPx,
        hasTimingWarning,
      });
    }

    // Add untimed nodes at the end
    for (let i = 0; i < untimedNodeIds.length; i++) {
      const nodeId = untimedNodeIds[i];
      const resolved = resolvedTimes.get(nodeId)!;
      positionedNodes.set(nodeId, {
        nodeId,
        yOffsetPx: currentY + 24 + i * ORPHAN_SPACING_PX,
        heightPx: MIN_NODE_HEIGHT_PX,
        laneIndex: li,
        hasMissingTime: true,
        resolvedArrival: null,
        resolvedDeparture: null,
        ...getEnrichmentProps(nodeId, resolved),
        ...getSharedProps(nodeId),
      });
    }

    lanes.push({
      laneId: laneDef.laneId,
      participantLabel: laneDef.label,
      nodeSequence: [...timedNodeIds, ...untimedNodeIds],
      positionedNodes,
      positionedEdges,
      gapRegions,
    });
  }

  // -----------------------------------------------------------------------
  // Step 9: Compute date markers
  // -----------------------------------------------------------------------
  const dateMarkers = computeDateMarkers(lanes, resolvedTimes, nodeMap);

  // Compute total height
  let maxBottom = 0;
  for (const lane of lanes) {
    for (const pos of lane.positionedNodes.values()) {
      maxBottom = Math.max(maxBottom, pos.yOffsetPx + pos.heightPx);
    }
  }
  const totalHeightPx = maxBottom + BOTTOM_PADDING_PX;

  return {
    lanes,
    dateMarkers,
    totalHeightPx,
    missingTimeNodeIds,
    timingConflictEdgeIds,
  };
}

// ---------------------------------------------------------------------------
// Lane determination
// ---------------------------------------------------------------------------

interface LaneDefinition {
  laneId: string;
  label: string | null;
  nodeIds: string[];
  sharedNodeIds?: Set<string>;
}

function determineLanes(
  nodes: NodeData[],
  edges: EdgeData[],
  pathResult: PathResult | null,
  pathMode: "all" | "mine",
  currentUserId: string | null,
  participantNames?: Map<string, string>,
): LaneDefinition[] {
  // Edge case: no nodes
  const allNodeIds = nodes.map((n) => n.id);
  if (allNodeIds.length === 0) return [];

  // "mine" mode — show a single lane scoped to the current user's path only
  if (pathMode === "mine" && currentUserId && pathResult) {
    const myPath = pathResult.paths.get(currentUserId);
    if (myPath && myPath.length > 0) {
      return [{
        laneId: currentUserId,
        label: null,
        nodeIds: myPath,
      }];
    }
  }

  // "all" mode — always use topology-based to show all possible options
  if (pathMode === "all") {
    if (dagHasBranches(nodes, edges)) {
      const topoLanes = computeTopologyLanes(nodes, edges, participantNames);
      if (topoLanes.length >= 2) return topoLanes;
    }
  }

  // Fallback: single lane with all nodes
  return [{
    laneId: "__all__",
    label: null,
    nodeIds: allNodeIds,
  }];
}

// ---------------------------------------------------------------------------
// Topology-based lane helpers
// ---------------------------------------------------------------------------

/** Check if the DAG has any structural branches (divergence or multiple roots). */
function dagHasBranches(nodes: NodeData[], edges: EdgeData[]): boolean {
  const adj = buildAdjacency(edges);
  for (const children of adj.values()) {
    if (children.length > 1) return true;
  }
  const hasParent = new Set(edges.map((e) => e.to_node_id));
  return nodes.filter((n) => !hasParent.has(n.id)).length > 1;
}

/**
 * Build lanes from DAG topology — one lane per branch at the first divergence.
 * Each lane includes the shared spine (prefix + suffix) plus branch-exclusive nodes.
 */
function computeTopologyLanes(
  nodes: NodeData[],
  edges: EdgeData[],
  participantNames?: Map<string, string>,
): LaneDefinition[] {
  const adj = buildAdjacency(edges);
  const revAdj = buildReverseAdjacency(edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  
  const roots = nodes.filter((n) => (revAdj.get(n.id) ?? []).length === 0).map((n) => n.id);
  if (roots.length === 0 && nodes.length > 0) roots.push(nodes[0].id);

  const allPaths: string[][] = [];
  function dfs(current: string, currentPath: string[], visited: Set<string>) {
    const children = adj.get(current) ?? [];
    if (children.length === 0) {
      allPaths.push([...currentPath]);
      return;
    }
    let cycleDetected = true;
    for (const child of children) {
      if (!visited.has(child)) {
        cycleDetected = false;
        visited.add(child);
        currentPath.push(child);
        dfs(child, currentPath, visited);
        currentPath.pop();
        visited.delete(child);
      }
    }
    if (cycleDetected) {
      allPaths.push([...currentPath]);
    }
  }

  for (const root of roots) {
    const visited = new Set<string>();
    visited.add(root);
    dfs(root, [root], visited);
  }

  const branchLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lanes: LaneDefinition[] = [];

  // Identify nodes that appear in multiple paths
  const pathAppearanceCount = new Map<string, number>();
  for (const path of allPaths) {
    for (const nodeId of path) {
      pathAppearanceCount.set(nodeId, (pathAppearanceCount.get(nodeId) ?? 0) + 1);
    }
  }

  for (let i = 0; i < allPaths.length; i++) {
    const path = allPaths[i];
    // A node is exclusive to this path if it only appears in this one path
    const exclusiveNodes = path.filter((id) => (pathAppearanceCount.get(id) ?? 0) === 1);
    const nodesToLabel = exclusiveNodes.length > 0 ? exclusiveNodes : path;
    
    // Label using exclusive nodes so participants on shared nodes don't rename all branches
    const label = inferBranchLabel(nodesToLabel, nodeMap, participantNames, branchLetters[i % branchLetters.length]);
    
    lanes.push({
      laneId: `topology-${i}`,
      label,
      nodeIds: path,
    });
  }

  return lanes;
}

/**
 * Determine lane label from participant_ids on branch nodes.
 * Falls back to "Option X" if no participants assigned.
 */
function inferBranchLabel(
  branchNodeIds: string[],
  nodeMap: Map<string, NodeData>,
  participantNames?: Map<string, string>,
  fallbackLetter?: string,
): string | null {
  // Collect participant_ids from branch-exclusive nodes
  const pids = new Set<string>();
  for (const nodeId of branchNodeIds) {
    const node = nodeMap.get(nodeId);
    if (node?.participant_ids) {
      for (const pid of node.participant_ids) pids.add(pid);
    }
  }

  if (pids.size > 0 && participantNames) {
    const names: string[] = [];
    for (const pid of pids) {
      const name = participantNames.get(pid);
      if (name) names.push(formatUserName(name, pid));
    }
    if (names.length > 0) return names.slice(0, 3).join(", ");
  }

  return fallbackLetter ? `Option ${fallbackLetter}` : null;
}

// ---------------------------------------------------------------------------
// Node sorting
// ---------------------------------------------------------------------------

function sortNodesByTime(
  nodeIds: string[],
  resolvedTimes: Map<string, ResolvedTime>,
  edges: EdgeData[],
): string[] {
  // Separate timed and untimed
  const timed: { id: string; arrival: Date }[] = [];
  const untimed: string[] = [];

  for (const id of nodeIds) {
    const resolved = resolvedTimes.get(id);
    if (resolved?.arrival) {
      timed.push({ id, arrival: resolved.arrival });
    } else {
      untimed.push(id);
    }
  }

  // Sort timed by arrival
  timed.sort((a, b) => a.arrival.getTime() - b.arrival.getTime());

  // Sort untimed by topological order
  const sortedUntimed = topoSort(untimed, edges);

  return [...timed.map((t) => t.id), ...sortedUntimed];
}

// ---------------------------------------------------------------------------
// Date marker computation
// ---------------------------------------------------------------------------

function computeDateMarkers(
  lanes: LaneLayout[],
  resolvedTimes: Map<string, ResolvedTime>,
  nodeMap: Map<string, NodeData>,
): DateMarker[] {
  if (lanes.length === 0) return [];

  // Collect all positioned nodes across lanes to find date boundaries
  const allPositionedNodes: Array<{ nodeId: string; yOffsetPx: number }> = [];
  for (const lane of lanes) {
    for (const [nodeId, pos] of lane.positionedNodes) {
      allPositionedNodes.push({ nodeId, yOffsetPx: pos.yOffsetPx });
    }
  }

  if (allPositionedNodes.length === 0) return [];

  // Use the primary lane's node sequence with their timezones
  const primaryLane = lanes[0];
  const markers: DateMarker[] = [];
  const seenDayKeys = new Set<string>();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  for (const nodeId of primaryLane.nodeSequence) {
    const resolved = resolvedTimes.get(nodeId);
    if (!resolved?.arrival) continue;

    const node = nodeMap.get(nodeId);
    const tz = node?.timezone ?? browserTz;
    const arrival = resolved.arrival;
    const pos = primaryLane.positionedNodes.get(nodeId);
    if (!pos) continue;

    // Generate a day key unique per timezone+date
    const dayFmt = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: tz,
    });
    const dayKey = `${tz}:${dayFmt.format(arrival)}`;

    if (seenDayKeys.has(dayKey)) continue;
    seenDayKeys.add(dayKey);

    // Format the date label
    const dayOfWeek = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: tz,
    }).format(arrival);
    const dayNum = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      timeZone: tz,
    }).format(arrival);

    markers.push({
      yOffsetPx: pos.yOffsetPx,
      label: `${dayOfWeek} ${dayNum}`,
      isToday: isToday(arrival, tz),
    });
  }

  return markers;
}
