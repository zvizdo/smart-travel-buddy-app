/**
 * Timeline layout algorithm — Sweep-and-Stretch.
 *
 * Single global time→Y map shared across every lane. Lanes render via
 * absolute positioning from lookups into this map, so a vertical slice at
 * any Y represents the same wall-clock time in every lane by construction.
 *
 * Algorithm:
 *   1. Collect all unique "pinning" timestamps from every lane:
 *      - Per-lane arrival (per_parent_arrivals override when set)
 *      - Node departure (shared)
 *      - Midnight boundaries in the primary timezone (strictly inside trip)
 *   2. Build intervals between consecutive timestamps. Baseline height =
 *      deltaMin × basePxPerMin (zoom-dependent).
 *   3. Compress "idle" intervals (no node active) longer than 8 h to a
 *      compact fixed height — empty calendar days and long downtime both
 *      collapse so the scroll length is proportional to activity, not
 *      wall-clock.
 *   4. Apply "stretch" claims — ≥ constraints that grow intervals in their
 *      range proportionally:
 *        * node-span [arr, dep] ≥ MIN_NODE
 *        * edge-span [from.dep || from.arr, to.arr] ≥ MIN_CONNECTOR
 *        * consecutive-pair [A.arr, B.arr] ≥ MIN_NODE + (edge ? MIN_CONNECTOR : 0)
 *      Pair claims are the structural no-overlap guarantee: two consecutive
 *      lane nodes can never stack on top of each other, at any zoom.
 *   5. Accumulate interval heights into a `time_to_Y_map`.
 *   6. Position nodes/edges via map lookups. Shared nodes (trip start/end,
 *      merge points with equal parent arrivals) land at identical Y in
 *      every lane. Merge nodes with `per_parent_arrivals` use the lane's
 *      per-parent arrival as the block TOP Y; the BOTTOM (joint departure)
 *      still aligns across lanes.
 */

import { type PathResult } from "@/lib/path-computation";
import { formatUserName } from "@/lib/user-display";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimelineZoomLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Baseline pixels per hour for each zoom level. Level 2 is the default. */
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
  /**
   * Per-lane arrival ISO for a shared merge node whose parent arrivals
   * diverge (emitted as ``per_parent_arrivals`` by ``enrichDagTimes``).
   * When set, the block's top Y has been shifted upward to this lane's
   * real arrival time (so a lane that arrived the previous evening
   * shows the overnight stay) and renderers should use this string for
   * the lane's arrival label instead of ``node.arrival_time`` (which
   * remains the joint-start ``max()`` across all parents).
   */
  laneArrivalTime?: string | null;
  laneIncomingEdgeId?: string | null;
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
}

export interface DateMarker {
  yOffsetPx: number;
  label: string;
  isToday: boolean;
  kind: "midnight";
}

export interface TimelineLayout {
  lanes: LaneLayout[];
  dateMarkers: DateMarker[];
  totalHeightPx: number;
  missingTimeNodeIds: Set<string>;
  timingConflictEdgeIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Input types (mirror Firestore shapes)
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
  arrival_time_estimated?: boolean;
  departure_time_estimated?: boolean;
  duration_estimated?: boolean;
  timing_conflict?: string | null;
  timing_conflict_severity?: TimingConflictSeverity | null;
  hold_reason?: "night_drive" | "max_drive_hours" | null;
  drive_cap_warning?: boolean;
  is_start?: boolean;
  is_end?: boolean;
  per_parent_arrivals?: Record<string, string> | null;
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_NODE_HEIGHT_PX = 56;
/**
 * Minimum height for a node block that renders a third advisory row
 * (drive-cap / night-drive / rest-stop). The 56 px base fits icon + name
 * + time row; the extra ~20 px reserves space for the advisory line so
 * the label doesn't paint past the rounded border of the block. The
 * rendered block's `minHeight` in ``TimelineNodeBlock`` stays at 56 px,
 * but the layout engine's claims and heightPx floor lift to this value
 * for any node with ``drive_cap_warning: true``.
 */
const MIN_NODE_HEIGHT_WITH_ADVISORY_PX = 76;
const MIN_CONNECTOR_HEIGHT_PX = 40;
/**
 * Compressed height for idle stretches — any interval where no lane has a
 * node active and whose duration exceeds IDLE_COMPRESSION_THRESHOLD_MS.
 * Empty calendar days (no arrival or departure falling on them, no node
 * spanning through) count as idle and collapse to this height, so a
 * 10-day idle between two nodes renders as ~10 compact rows rather than
 * thousands of pixels of empty scroll.
 */
const IDLE_COMPRESSED_PX = 40;
const IDLE_COMPRESSION_THRESHOLD_MS = 8 * 60 * 60 * 1000; // 8 h
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
 * Find the edge that ends at ``nodeId`` whose source is in ``laneNodeIdSet`` —
 * the lane's own incoming edge for a (possibly merge) node. Returns ``null``
 * when no such edge exists (e.g. node is a root in this lane).
 */
function laneIncomingEdge(
  nodeId: string,
  laneNodeIdSet: Set<string>,
  edges: EdgeData[],
): { edge: EdgeData; edgeKey: string } | null {
  for (const e of edges) {
    if (e.to_node_id !== nodeId) continue;
    if (!laneNodeIdSet.has(e.from_node_id)) continue;
    const edgeKey = e.id || `${e.from_node_id}->${nodeId}`;
    return { edge: e, edgeKey };
  }
  return null;
}

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
// Sweep-and-Stretch primitives
// ---------------------------------------------------------------------------

interface LaneEvent {
  nodeId: string;
  arrivalMs: number;
  departureMs: number | null;
  override?: { iso: string; edgeId: string };
}

interface Interval {
  startMs: number;
  endMs: number;
  deltaMin: number;
  heightPx: number;
  /**
   * True when at least one node's [arrival, departure] fully covers this
   * interval in some lane — used by idle compression to know when to leave
   * the interval at baseline.
   */
  active: boolean;
}

interface StretchClaim {
  startMs: number;
  endMs: number;
  minPx: number;
}

/**
 * Compute the Y for an arbitrary millisecond via the pre-computed
 * interval heights. Pinned timestamps read from ``timeToY`` directly;
 * anything between pins interpolates linearly inside the containing
 * interval (pxPerMinute is constant within a single interval, so this is
 * exact, not an approximation).
 */
function makeTimeToY(
  intervals: Interval[],
  timeToY: Map<number, number>,
  tailY: number,
) {
  return function resolveY(ms: number): number {
    const pinned = timeToY.get(ms);
    if (pinned != null) return pinned;
    if (intervals.length === 0) return START_OFFSET_PX;
    if (ms <= intervals[0].startMs) return START_OFFSET_PX;
    if (ms >= intervals[intervals.length - 1].endMs) return tailY;
    for (const iv of intervals) {
      if (ms >= iv.startMs && ms <= iv.endMs) {
        const span = iv.endMs - iv.startMs;
        if (span <= 0) return timeToY.get(iv.startMs) ?? START_OFFSET_PX;
        const frac = (ms - iv.startMs) / span;
        const yStart = timeToY.get(iv.startMs) ?? START_OFFSET_PX;
        return yStart + frac * iv.heightPx;
      }
    }
    return tailY;
  };
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

  // -----------------------------------------------------------------------
  // Lane determination
  // -----------------------------------------------------------------------
  const laneDefinitions = determineLanes(
    nodes, edges, pathResult, pathMode, currentUserId, participantNames,
  );

  // -----------------------------------------------------------------------
  // Resolve arrival / departure dates & enrichment flags per node
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

  const timingConflictEdgeIds = new Set<string>();

  /** Advisory-aware min height (drive-cap nodes render a 3rd row). */
  function minHeightFor(nodeId: string): number {
    return resolvedTimes.get(nodeId)?.driveCap
      ? MIN_NODE_HEIGHT_WITH_ADVISORY_PX
      : MIN_NODE_HEIGHT_PX;
  }

  const laneNodeIdSet = new Set<string>();
  for (const laneDef of laneDefinitions) {
    for (const nodeId of laneDef.nodeIds) laneNodeIdSet.add(nodeId);
  }

  const allTimedArrivals: number[] = [];
  for (const nodeId of laneNodeIdSet) {
    const resolved = resolvedTimes.get(nodeId);
    if (resolved?.arrival) allTimedArrivals.push(resolved.arrival.getTime());
  }

  const allNodesUntimed = allTimedArrivals.length === 0;
  const isMultiLane = laneDefinitions.length > 1;

  const globalSharedNodeIds = new Set<string>();
  if (isMultiLane) {
    const count = new Map<string, number>();
    for (const laneDef of laneDefinitions) {
      for (const nodeId of laneDef.nodeIds) {
        count.set(nodeId, (count.get(nodeId) ?? 0) + 1);
      }
    }
    for (const [nodeId, c] of count) if (c > 1) globalSharedNodeIds.add(nodeId);
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

  // -----------------------------------------------------------------------
  // Per-lane per-parent-arrival overrides (for merge nodes whose parent
  // arrivals diverged). Pre-computed so each lane's event list uses the
  // lane-specific arrival time from the start.
  // -----------------------------------------------------------------------
  interface LaneOverride {
    laneArrivalMs: number;
    laneArrivalIso: string;
    laneIncomingEdgeId: string;
  }
  const laneOverrides = new Map<string, Map<string, LaneOverride>>();
  for (const laneDef of laneDefinitions) {
    const setOfLaneNodes = new Set(laneDef.nodeIds);
    const overrideMap = new Map<string, LaneOverride>();
    for (const nodeId of laneDef.nodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node?.per_parent_arrivals) continue;
      const resolved = resolvedTimes.get(nodeId);
      if (!resolved?.arrival) continue;
      const incoming = laneIncomingEdge(nodeId, setOfLaneNodes, edges);
      if (!incoming) continue;
      const laneIso = node.per_parent_arrivals[incoming.edgeKey];
      if (!laneIso || laneIso === node.arrival_time) continue;
      const laneMs = Date.parse(laneIso);
      if (Number.isNaN(laneMs)) continue;
      if (laneMs >= resolved.arrival.getTime()) continue;
      overrideMap.set(nodeId, {
        laneArrivalMs: laneMs,
        laneArrivalIso: laneIso,
        laneIncomingEdgeId: incoming.edge.id,
      });
    }
    if (overrideMap.size > 0) laneOverrides.set(laneDef.laneId, overrideMap);
  }

  // -----------------------------------------------------------------------
  // Primary timezone for calendar-day math
  // -----------------------------------------------------------------------
  let primaryTz: string | null = null;
  for (const laneDef of laneDefinitions) {
    for (const nodeId of laneDef.nodeIds) {
      const node = nodeMap.get(nodeId);
      const resolved = resolvedTimes.get(nodeId);
      if (resolved?.arrival && node?.timezone) {
        primaryTz = node.timezone;
        break;
      }
    }
    if (primaryTz) break;
  }
  const tz = primaryTz ?? browserTz;

  // -----------------------------------------------------------------------
  // Build per-lane event list using lane-specific arrivals.
  // -----------------------------------------------------------------------
  const laneEvents = new Map<string, LaneEvent[]>();
  for (const laneDef of laneDefinitions) {
    const overrideMap = laneOverrides.get(laneDef.laneId);
    const events: LaneEvent[] = [];
    for (const nodeId of laneDef.nodeIds) {
      const resolved = resolvedTimes.get(nodeId);
      if (!resolved?.arrival) continue;
      const override = overrideMap?.get(nodeId);
      const arrivalMs = override?.laneArrivalMs ?? resolved.arrival.getTime();
      const departureMs = resolved.departure?.getTime() ?? null;
      events.push({
        nodeId,
        arrivalMs,
        departureMs,
        override: override
          ? { iso: override.laneArrivalIso, edgeId: override.laneIncomingEdgeId }
          : undefined,
      });
    }
    events.sort((a, b) => a.arrivalMs - b.arrivalMs);
    laneEvents.set(laneDef.laneId, events);
  }

  // -----------------------------------------------------------------------
  // Collect unique timestamps. Add midnights strictly inside trip bounds
  // so empty days become discrete intervals (each compressed + gets a
  // date marker).
  // -----------------------------------------------------------------------
  let earliestMs = Number.POSITIVE_INFINITY;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const events of laneEvents.values()) {
    for (const e of events) {
      if (e.arrivalMs < earliestMs) earliestMs = e.arrivalMs;
      const endMs = e.departureMs ?? e.arrivalMs;
      if (endMs > latestMs) latestMs = endMs;
    }
  }
  if (!isFinite(earliestMs) || !isFinite(latestMs)) {
    earliestMs = 0;
    latestMs = 0;
  }
  if (latestMs <= earliestMs) latestMs = earliestMs + 60 * 60 * 1000; // 1h fallback

  const timestampSet = new Set<number>();
  timestampSet.add(earliestMs);
  timestampSet.add(latestMs);
  for (const events of laneEvents.values()) {
    for (const e of events) {
      timestampSet.add(e.arrivalMs);
      if (e.departureMs != null) timestampSet.add(e.departureMs);
    }
  }

  const tripStartMidnight = midnightMsForTimeInTz(earliestMs, tz);
  let midnightCursor = tripStartMidnight;
  let safety = 0;
  while (midnightCursor <= latestMs && safety++ < 365) {
    if (midnightCursor > earliestMs && midnightCursor < latestMs) {
      timestampSet.add(midnightCursor);
    }
    midnightCursor = nextMidnightInTz(midnightCursor, tz);
  }

  const timestamps = [...timestampSet].sort((a, b) => a - b);

  // -----------------------------------------------------------------------
  // Build intervals with baseline height, then compress idle stretches.
  // -----------------------------------------------------------------------
  const baseRate = PX_PER_HOUR[zoomLevel] / 60; // px per minute
  const intervals: Interval[] = [];
  if (!allNodesUntimed && timestamps.length >= 2) {
    for (let i = 0; i < timestamps.length - 1; i++) {
      const startMs = timestamps[i];
      const endMs = timestamps[i + 1];
      const deltaMin = (endMs - startMs) / 60_000;

      let active = false;
      for (const events of laneEvents.values()) {
        for (const e of events) {
          const eStart = e.arrivalMs;
          const eEnd = e.departureMs ?? e.arrivalMs;
          if (eStart <= startMs && eEnd >= endMs && eStart < eEnd) {
            active = true;
            break;
          }
        }
        if (active) break;
      }

      let heightPx = deltaMin * baseRate;
      const isIdle = !active;
      const isLongEnough = (endMs - startMs) >= IDLE_COMPRESSION_THRESHOLD_MS;
      if (isIdle && isLongEnough) {
        heightPx = Math.min(heightPx, IDLE_COMPRESSED_PX);
      }

      intervals.push({ startMs, endMs, deltaMin, heightPx, active });
    }
  }

  // -----------------------------------------------------------------------
  // Collect stretch claims.
  // -----------------------------------------------------------------------
  const claims: StretchClaim[] = [];

  // Node span: [arr, dep] ≥ min-node-height when a departure exists.
  for (const events of laneEvents.values()) {
    for (const e of events) {
      if (e.departureMs != null && e.departureMs > e.arrivalMs) {
        claims.push({
          startMs: e.arrivalMs,
          endMs: e.departureMs,
          minPx: minHeightFor(e.nodeId),
        });
      }
    }
  }

  // Edge + consecutive-pair claims.
  for (const [, events] of laneEvents) {
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      const b = events[i + 1];
      if (b.arrivalMs <= a.arrivalMs) continue;
      const edge = findEdgeBetween(edges, a.nodeId, b.nodeId);
      const edgeStartMs = a.departureMs ?? a.arrivalMs;
      if (edge && b.arrivalMs > edgeStartMs) {
        claims.push({
          startMs: edgeStartMs,
          endMs: b.arrivalMs,
          minPx: MIN_CONNECTOR_HEIGHT_PX,
        });
      }
      // The pair claim is the no-overlap guarantee: A's min height + the
      // MIN_CONNECTOR fit strictly between A's and B's arrival times.
      claims.push({
        startMs: a.arrivalMs,
        endMs: b.arrivalMs,
        minPx: minHeightFor(a.nodeId) + (edge ? MIN_CONNECTOR_HEIGHT_PX : 0),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Satisfy each claim by growing intervals in its range proportionally
  // to their current duration. Adding height only helps other claims
  // (they're all ≥ constraints), so order is irrelevant.
  // -----------------------------------------------------------------------
  for (const claim of claims) {
    const affected: number[] = [];
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      if (iv.startMs >= claim.startMs && iv.endMs <= claim.endMs) {
        affected.push(i);
      }
    }
    if (affected.length === 0) continue;

    let totalHeight = 0;
    let totalDuration = 0;
    for (const idx of affected) {
      totalHeight += intervals[idx].heightPx;
      totalDuration += intervals[idx].deltaMin;
    }
    if (totalHeight >= claim.minPx) continue;
    const deficit = claim.minPx - totalHeight;
    if (totalDuration > 0) {
      for (const idx of affected) {
        intervals[idx].heightPx += deficit * (intervals[idx].deltaMin / totalDuration);
      }
    } else {
      const per = deficit / affected.length;
      for (const idx of affected) intervals[idx].heightPx += per;
    }
  }

  // -----------------------------------------------------------------------
  // Accumulate heights → time_to_Y_map.
  // -----------------------------------------------------------------------
  const timeToYMap = new Map<number, number>();
  let cursorY = START_OFFSET_PX;
  if (intervals.length > 0) {
    timeToYMap.set(intervals[0].startMs, cursorY);
    for (const iv of intervals) {
      cursorY += iv.heightPx;
      timeToYMap.set(iv.endMs, cursorY);
    }
  } else if (timestamps.length > 0) {
    timeToYMap.set(timestamps[0], cursorY);
  }
  const tailY = cursorY;
  const timeToY = makeTimeToY(intervals, timeToYMap, tailY);

  // -----------------------------------------------------------------------
  // Build lanes via time_to_Y lookups.
  // -----------------------------------------------------------------------
  const lanes: LaneLayout[] = [];

  for (let li = 0; li < laneDefinitions.length; li++) {
    const laneDef = laneDefinitions[li];
    const laneNodeIds = laneDef.nodeIds;
    const positionedNodes = new Map<string, PositionedNode>();
    const positionedEdges = new Map<string, PositionedEdge>();
    const sharedSet = laneDef.sharedNodeIds ?? globalSharedNodeIds;
    const overrideMap = laneOverrides.get(laneDef.laneId);

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

    const sortedNodeIds = sortNodesByTime(laneNodeIds, resolvedTimes, edges);

    if (allNodesUntimed) {
      for (let i = 0; i < sortedNodeIds.length; i++) {
        const nodeId = sortedNodeIds[i];
        const resolved = resolvedTimes.get(nodeId)!;
        const yOffsetPx = i * ORPHAN_SPACING_PX;
        positionedNodes.set(nodeId, {
          nodeId,
          yOffsetPx,
          heightPx: MIN_NODE_HEIGHT_PX,
          laneIndex: li,
          hasMissingTime: true,
          resolvedArrival: null,
          resolvedDeparture: null,
          ...getEnrichmentProps(nodeId, resolved),
          ...getSharedProps(nodeId),
        });
      }
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
      });
      continue;
    }

    const timedNodeIds: string[] = [];
    const untimedNodeIds: string[] = [];
    for (const nodeId of sortedNodeIds) {
      const resolved = resolvedTimes.get(nodeId)!;
      if (resolved.arrival) timedNodeIds.push(nodeId);
      else untimedNodeIds.push(nodeId);
    }

    let laneBottomY = START_OFFSET_PX;
    for (const nodeId of timedNodeIds) {
      const resolved = resolvedTimes.get(nodeId)!;
      const override = overrideMap?.get(nodeId);
      const arrivalMs = override?.laneArrivalMs ?? resolved.arrival!.getTime();
      const yOffsetPx = timeToY(arrivalMs);
      const minHeight = minHeightFor(nodeId);
      let heightPx = minHeight;
      if (resolved.departure) {
        const departureMs = resolved.departure.getTime();
        const natural = timeToY(departureMs) - yOffsetPx;
        heightPx = Math.max(minHeight, natural);
      }
      positionedNodes.set(nodeId, {
        nodeId,
        yOffsetPx,
        heightPx,
        laneIndex: li,
        hasMissingTime: resolved.hasMissing,
        resolvedArrival: resolved.arrival,
        resolvedDeparture: resolved.departure,
        ...getEnrichmentProps(nodeId, resolved),
        ...getSharedProps(nodeId),
        ...(override
          ? {
              laneArrivalTime: override.laneArrivalIso,
              laneIncomingEdgeId: override.laneIncomingEdgeId,
              arrivalEstimated: true,
            }
          : {}),
      });
      laneBottomY = Math.max(laneBottomY, yOffsetPx + heightPx);
    }

    // Connectors: between consecutive timed nodes in this lane.
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

    // Diagonal / non-sequential edges within the lane.
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

    // Untimed nodes appended at the bottom of the lane.
    for (let i = 0; i < untimedNodeIds.length; i++) {
      const nodeId = untimedNodeIds[i];
      const resolved = resolvedTimes.get(nodeId)!;
      const yOffsetPx = laneBottomY + 24 + i * ORPHAN_SPACING_PX;
      positionedNodes.set(nodeId, {
        nodeId,
        yOffsetPx,
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
    });
  }

  // -----------------------------------------------------------------------
  // Date markers — one per calendar day that intersects the trip.
  // First day anchored to trip start (not midnight before it), subsequent
  // days anchored to their midnight Y from timeToY.
  // -----------------------------------------------------------------------
  const dateMarkers: DateMarker[] = [];
  if (!allNodesUntimed && intervals.length > 0) {
    // Trip start marker (first day of trip)
    dateMarkers.push({
      yOffsetPx: START_OFFSET_PX,
      label: formatDayLabel(new Date(earliestMs), tz),
      isToday: isToday(new Date(earliestMs), tz),
      kind: "midnight",
    });
    // Each subsequent midnight in the trip
    let cursor = nextMidnightInTz(tripStartMidnight, tz);
    safety = 0;
    while (cursor <= latestMs && safety++ < 365) {
      if (cursor > earliestMs) {
        dateMarkers.push({
          yOffsetPx: Math.round(timeToY(cursor)),
          label: formatDayLabel(new Date(cursor), tz),
          isToday: isToday(new Date(cursor), tz),
          kind: "midnight",
        });
      }
      cursor = nextMidnightInTz(cursor, tz);
    }
  }

  // Total height
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
  const allNodeIds = nodes.map((n) => n.id);
  if (allNodeIds.length === 0) return [];

  if (pathMode === "mine" && currentUserId && pathResult) {
    const myPath = pathResult.paths.get(currentUserId);
    if (myPath && myPath.length > 0) {
      return [{ laneId: currentUserId, label: null, nodeIds: myPath }];
    }
  }

  if (pathMode === "all") {
    if (dagHasBranches(nodes, edges)) {
      const topoLanes = computeTopologyLanes(nodes, edges, participantNames);
      if (topoLanes.length >= 2) return topoLanes;
    }
  }

  return [{ laneId: "__all__", label: null, nodeIds: allNodeIds }];
}

function dagHasBranches(nodes: NodeData[], edges: EdgeData[]): boolean {
  const adj = buildAdjacency(edges);
  for (const children of adj.values()) {
    if (children.length > 1) return true;
  }
  const hasParent = new Set(edges.map((e) => e.to_node_id));
  return nodes.filter((n) => !hasParent.has(n.id)).length > 1;
}

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

  const pathAppearanceCount = new Map<string, number>();
  for (const path of allPaths) {
    for (const nodeId of path) {
      pathAppearanceCount.set(nodeId, (pathAppearanceCount.get(nodeId) ?? 0) + 1);
    }
  }

  for (let i = 0; i < allPaths.length; i++) {
    const path = allPaths[i];
    const exclusiveNodes = path.filter((id) => (pathAppearanceCount.get(id) ?? 0) === 1);
    const nodesToLabel = exclusiveNodes.length > 0 ? exclusiveNodes : path;
    const label = inferBranchLabel(
      nodesToLabel, nodeMap, participantNames, branchLetters[i % branchLetters.length],
    );
    lanes.push({ laneId: `topology-${i}`, label, nodeIds: path });
  }

  return lanes;
}

function inferBranchLabel(
  branchNodeIds: string[],
  nodeMap: Map<string, NodeData>,
  participantNames?: Map<string, string>,
  fallbackLetter?: string,
): string | null {
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
    if (names.length > 0) return names.join(", ");
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

  timed.sort((a, b) => a.arrival.getTime() - b.arrival.getTime());
  const sortedUntimed = topoSort(untimed, edges);
  return [...timed.map((t) => t.id), ...sortedUntimed];
}

// ---------------------------------------------------------------------------
// Timezone helpers for midnight math
// ---------------------------------------------------------------------------

function formatDayLabel(d: Date, tz: string): string {
  const dow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: tz }).format(d);
  return `${dow} ${day}`;
}

function midnightMsForTimeInTz(timeMs: number, tz: string): number {
  const [y, mo, d] = dayTripletInTz(timeMs, tz);
  return midnightMsForDateInTz(y, mo, d, tz);
}

function nextMidnightInTz(currentMidnightMs: number, tz: string): number {
  const [y, mo, d] = dayTripletInTz(currentMidnightMs, tz);
  const nextUtc = Date.UTC(y, mo - 1, d + 1, 12, 0, 0);
  const [ny, nmo, nd] = dayTripletInTz(nextUtc, tz);
  return midnightMsForDateInTz(ny, nmo, nd, tz);
}

function dayTripletInTz(timeMs: number, tz: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(timeMs)).split("-");
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function midnightMsForDateInTz(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstPass = guess - tzOffsetMs(guess, tz);
  const offsetAtFirstPass = tzOffsetMs(firstPass, tz);
  return guess - offsetAtFirstPass;
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  let h = g("hour");
  if (h === 24) h = 0;
  const asIfUtc = Date.UTC(g("year"), g("month") - 1, g("day"), h, g("minute"), g("second"));
  return asIfUtc - utcMs;
}
