/**
 * Read-time enrichment for flex-planning node timings (TypeScript port).
 *
 * Byte-compatible port of ``shared/shared/dag/time_inference.py``. Both
 * implementations are driven by the same JSON fixture at
 * ``shared/tests/fixtures/time_inference_cases.json`` so drift surfaces as a
 * red test in either runtime.
 *
 * The algorithm is pure: no `Date.now()`, no I/O. It takes raw Firestore
 * nodes + edges plus the parent trip's settings and returns a new array of
 * nodes with inferred arrival/departure/duration fields filled in along
 * with flags describing how each value was produced.
 */

export const DEFAULT_DURATION_MINUTES = 30;
const REST_NODE_TYPES = new Set(["hotel", "city"]);
const REST_DURATION_MINUTES = 360; // 6h
const DRIVE_MODES = new Set(["drive", "walk"]);
const CONFLICT_TOLERANCE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NoDriveWindow {
  start_hour: number;
  end_hour: number;
}

export interface TripSettingsLike {
  no_drive_window?: NoDriveWindow | null;
  max_drive_hours_per_day?: number | null;
  default_timezone?: string | null;
  [key: string]: unknown;
}

export interface RawNode {
  id: string;
  name?: string;
  type?: string;
  timezone?: string | null;
  arrival_time?: string | null;
  departure_time?: string | null;
  duration_minutes?: number | null;
  [key: string]: unknown;
}

export interface RawEdge {
  from_node_id: string;
  to_node_id: string;
  travel_mode?: string;
  travel_time_hours?: number | null;
  [key: string]: unknown;
}

export interface EnrichedNode extends RawNode {
  arrival_time: string | null;
  departure_time: string | null;
  duration_minutes: number;
  arrival_time_estimated: boolean;
  departure_time_estimated: boolean;
  duration_estimated: boolean;
  is_start: boolean;
  is_end: boolean;
  timing_conflict: string | null;
  overnight_hold: boolean;
  hold_reason: "night_drive" | "max_drive_hours" | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TripRules {
  window: NoDriveWindow | null;
  maxDriveHours: number | null;
  defaultTz: string | null;
}

function extractRules(settings: TripSettingsLike | null | undefined): TripRules {
  const s = settings ?? {};
  let window: NoDriveWindow | null = null;
  const rawWindow = s.no_drive_window;
  if (rawWindow) {
    window = {
      start_hour: Number(rawWindow.start_hour ?? 22),
      end_hour: Number(rawWindow.end_hour ?? 6),
    };
  }
  const max = s.max_drive_hours_per_day;
  return {
    window,
    maxDriveHours: max == null ? null : Number(max),
    defaultTz: (s.default_timezone as string | undefined) ?? null,
  };
}

function crossesMidnight(w: NoDriveWindow): boolean {
  return w.start_hour >= w.end_hour;
}

interface Adjacency {
  forward: Map<string, RawEdge[]>;
  reverse: Map<string, RawEdge[]>;
}

function buildAdjacency(edges: RawEdge[]): Adjacency {
  const forward = new Map<string, RawEdge[]>();
  const reverse = new Map<string, RawEdge[]>();
  for (const e of edges) {
    const f = forward.get(e.from_node_id) ?? [];
    f.push(e);
    forward.set(e.from_node_id, f);
    const r = reverse.get(e.to_node_id) ?? [];
    r.push(e);
    reverse.set(e.to_node_id, r);
  }
  return { forward, reverse };
}

function toposort(nodes: RawNode[], adj: Adjacency): string[] | null {
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  for (const [toId, incoming] of adj.reverse) {
    if (inDeg.has(toId)) inDeg.set(toId, incoming.length);
  }
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) queue.push(n.id);
  }
  const order: string[] = [];
  const remaining = new Map(inDeg);
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    order.push(nodeId);
    for (const edge of adj.forward.get(nodeId) ?? []) {
      const child = edge.to_node_id;
      if (!remaining.has(child)) continue;
      const d = (remaining.get(child) ?? 0) - 1;
      remaining.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  return order.length === nodes.length ? order : null;
}

function parseDt(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value === "") return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

// ---------------------------------------------------------------------------
// Timezone helpers
//
// JavaScript has no native ZoneInfo; we emulate Python's zoneinfo math using
// `Intl.DateTimeFormat` in the target zone. For performance we memoize the
// formatter per (zone) and reuse it across calls.
// ---------------------------------------------------------------------------

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const _localFormatters = new Map<string, Intl.DateTimeFormat>();

function getLocalFormatter(tz: string): Intl.DateTimeFormat | null {
  const cached = _localFormatters.get(tz);
  if (cached) return cached;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    _localFormatters.set(tz, fmt);
    return fmt;
  } catch {
    return null;
  }
}

function toLocalParts(utcMs: number, tz: string): LocalParts | null {
  const fmt = getLocalFormatter(tz);
  if (!fmt) return null;
  const parts = fmt.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  let hour = get("hour");
  // en-US in hour12:false sometimes emits 24 for midnight — normalize to 0
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Convert a wall-clock time in the given IANA zone to a UTC millisecond
 * timestamp. Iterative correction handles DST cleanly (in practice only one
 * adjustment is ever needed).
 */
function wallToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const local = toLocalParts(guess, tz);
    if (!local) return guess;
    const localAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const delta = localAsUtc - Date.UTC(year, month - 1, day, hour, minute, 0);
    if (delta === 0) break;
    guess -= delta;
  }
  return guess;
}

function isValidZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  return getLocalFormatter(tz) != null;
}

interface WindowInterval {
  startMs: number;
  endMs: number;
}

function windowIntervalsForDay(
  year: number,
  month: number,
  day: number,
  window: NoDriveWindow,
  tz: string,
): WindowInterval[] {
  if (crossesMidnight(window)) {
    const startMs = wallToUtcMs(year, month, day, window.start_hour, 0, tz);
    const nextLocal = addLocalDays(year, month, day, 1);
    const endMs = wallToUtcMs(
      nextLocal.year,
      nextLocal.month,
      nextLocal.day,
      window.end_hour,
      0,
      tz,
    );
    return [{ startMs, endMs }];
  }
  const startMs = wallToUtcMs(year, month, day, window.start_hour, 0, tz);
  const endMs = wallToUtcMs(year, month, day, window.end_hour, 0, tz);
  return [{ startMs, endMs }];
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  // Use UTC arithmetic for date math — DST does not affect Gregorian day
  // arithmetic, only intra-day offsets.
  const baseMs = Date.UTC(year, month - 1, day);
  const nextMs = baseMs + delta * 86400000;
  const d = new Date(nextMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function intervalOverlapsWindow(
  startMs: number,
  endMs: number,
  window: NoDriveWindow,
  tz: string,
): boolean {
  const startLocal = toLocalParts(startMs, tz);
  const endLocal = toLocalParts(endMs, tz);
  if (!startLocal || !endLocal) return false;

  let cursor = { year: startLocal.year, month: startLocal.month, day: startLocal.day };
  const endDay = { year: endLocal.year, month: endLocal.month, day: endLocal.day };

  // Walk day-by-day in the local zone until one full day past the end.
  // A small upper bound guards against pathological zones. In practice the
  // loop runs 1–3 iterations for any realistic drive interval.
  for (let safety = 0; safety < 14; safety++) {
    for (const interval of windowIntervalsForDay(
      cursor.year,
      cursor.month,
      cursor.day,
      window,
      tz,
    )) {
      if (interval.startMs < endMs && interval.endMs > startMs) {
        return true;
      }
    }
    if (
      cursor.year > endDay.year ||
      (cursor.year === endDay.year && cursor.month > endDay.month) ||
      (cursor.year === endDay.year &&
        cursor.month === endDay.month &&
        cursor.day > endDay.day)
    ) {
      break;
    }
    cursor = addLocalDays(cursor.year, cursor.month, cursor.day, 1);
  }
  return false;
}

function shiftToWindowEnd(
  departureMs: number,
  window: NoDriveWindow,
  tz: string,
): number {
  const local = toLocalParts(departureMs, tz);
  if (!local) return departureMs;

  const morningHour = window.end_hour;
  let morningMs = wallToUtcMs(local.year, local.month, local.day, morningHour, 0, tz);

  // If we're already past this morning's end-hour, jump to tomorrow.
  if (departureMs >= morningMs) {
    const next = addLocalDays(local.year, local.month, local.day, 1);
    morningMs = wallToUtcMs(next.year, next.month, next.day, morningHour, 0, tz);
  }
  return morningMs;
}

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

function draftNode(node: RawNode, adj: Adjacency): EnrichedNode {
  let duration = node.duration_minutes;
  let durationEstimated = false;
  if (duration == null) {
    duration = DEFAULT_DURATION_MINUTES;
    durationEstimated = true;
  }
  const draft: EnrichedNode = {
    ...node,
    arrival_time: node.arrival_time ?? null,
    departure_time: node.departure_time ?? null,
    duration_minutes: duration,
    duration_estimated: durationEstimated,
    arrival_time_estimated: false,
    departure_time_estimated: false,
    is_start: !adj.reverse.has(node.id),
    is_end: !adj.forward.has(node.id),
    timing_conflict: null,
    overnight_hold: false,
    hold_reason: null,
  };
  return draft;
}

function propagateArrival(
  parents: RawEdge[] | undefined,
  drafts: Map<string, EnrichedNode>,
): Date | null {
  if (!parents || parents.length === 0) return null;
  let best: Date | null = null;
  for (const edge of parents) {
    const parent = drafts.get(edge.from_node_id);
    if (!parent) continue;
    const parentDeparture = parseDt(parent.departure_time);
    if (!parentDeparture) return null;
    const travelMs = Number(edge.travel_time_hours ?? 0) * 3_600_000;
    const candidate = new Date(parentDeparture.getTime() + travelMs);
    if (!best || candidate.getTime() > best.getTime()) {
      best = candidate;
    }
  }
  return best;
}

function resolveDeparture(
  draft: EnrichedNode,
  userDeparture: Date | null,
): Date | null {
  if (userDeparture) return userDeparture;
  const arrival = parseDt(draft.arrival_time);
  if (!arrival) return null;
  return new Date(arrival.getTime() + draft.duration_minutes * 60_000);
}

function formatDelta(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  if (rem === 0) return `${hours}h`;
  return `${hours}h${String(rem).padStart(2, "0")}m`;
}

/** Python's `datetime.isoformat()` with UTC offset (`+00:00`), not `Z`. */
function toIsoString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}:${s}+00:00`;
}

function checkArrivalConflict(
  draft: EnrichedNode,
  userArrival: Date,
  propagated: Date,
): void {
  const deltaSeconds = Math.abs(
    (propagated.getTime() - userArrival.getTime()) / 1000,
  );
  if (deltaSeconds <= CONFLICT_TOLERANCE_SECONDS) return;
  const direction = propagated.getTime() < userArrival.getTime() ? "early" : "late";
  draft.timing_conflict =
    `Propagated arrival ${toIsoString(propagated)} is ` +
    `${formatDelta(deltaSeconds)} ${direction} vs user arrival ` +
    `${toIsoString(userArrival)}`;
}

function applyDriveRules(
  draft: EnrichedNode,
  outgoing: RawEdge[] | undefined,
  accumulatedHours: number,
  rules: TripRules,
): Date | null {
  const departureDt = parseDt(draft.departure_time);
  if (!departureDt || !outgoing || outgoing.length === 0) return departureDt;

  let longestDrive = 0;
  for (const edge of outgoing) {
    if (!DRIVE_MODES.has(String(edge.travel_mode ?? ""))) continue;
    const h = Number(edge.travel_time_hours ?? 0);
    if (h > longestDrive) longestDrive = h;
  }
  if (longestDrive <= 0) return departureDt;

  const tzName = draft.timezone ?? rules.defaultTz;
  if (!isValidZone(tzName)) return departureDt;
  const tz = tzName as string;

  let departureMs = departureDt.getTime();
  let holdReason: "night_drive" | "max_drive_hours" | null = null;

  if (rules.window) {
    const projectedArrivalMs = departureMs + longestDrive * 3_600_000;
    if (
      intervalOverlapsWindow(departureMs, projectedArrivalMs, rules.window, tz)
    ) {
      departureMs = shiftToWindowEnd(departureMs, rules.window, tz);
      holdReason = "night_drive";
    }
  }

  if (
    rules.maxDriveHours != null &&
    accumulatedHours + longestDrive > rules.maxDriveHours
  ) {
    const fallbackWindow: NoDriveWindow = rules.window ?? {
      start_hour: 22,
      end_hour: 6,
    };
    departureMs = shiftToWindowEnd(departureMs, fallbackWindow, tz);
    holdReason = holdReason ?? "max_drive_hours";
  }

  if (holdReason) {
    const newDeparture = new Date(departureMs);
    draft.departure_time = toIsoString(newDeparture);
    draft.departure_time_estimated = true;
    draft.overnight_hold = true;
    draft.hold_reason = holdReason;
    return newDeparture;
  }

  return departureDt;
}

function isRestNode(draft: EnrichedNode): boolean {
  if (draft.type && REST_NODE_TYPES.has(draft.type)) return true;
  return (draft.duration_minutes ?? 0) >= REST_DURATION_MINUTES;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function enrichDagTimes(
  nodes: RawNode[],
  edges: RawEdge[],
  tripSettings: TripSettingsLike | null | undefined,
): EnrichedNode[] {
  const rules = extractRules(tripSettings);
  const adj = buildAdjacency(edges);

  const drafts = new Map<string, EnrichedNode>();
  for (const n of nodes) drafts.set(n.id, draftNode(n, adj));

  const order = toposort(nodes, adj);
  if (!order) {
    // Cycle → conservative no-op; duration defaults stay in place.
    return nodes.map((n) => drafts.get(n.id)!);
  }

  const accDriveHours = new Map<string, number>();

  for (const nodeId of order) {
    const draft = drafts.get(nodeId)!;
    const parents = adj.reverse.get(nodeId);

    // (a) Effective arrival
    const propagated = propagateArrival(parents, drafts);
    const userArrival = parseDt(draft.arrival_time);
    if (userArrival) {
      if (propagated) {
        checkArrivalConflict(draft, userArrival, propagated);
      }
    } else if (propagated) {
      draft.arrival_time = toIsoString(propagated);
      draft.arrival_time_estimated = true;
    }

    // (b) Effective departure
    const userDeparture = parseDt(draft.departure_time);
    const effDeparture = resolveDeparture(draft, userDeparture);
    if (effDeparture && !userDeparture) {
      draft.departure_time = toIsoString(effDeparture);
      draft.departure_time_estimated = true;
    }

    // Start node special case: departure is a point-in-time. With no user
    // arrival, publish it as the effective arrival so downstream edges can
    // project off a concrete timestamp.
    if (draft.is_start && draft.arrival_time == null && effDeparture) {
      draft.arrival_time = toIsoString(effDeparture);
      draft.arrival_time_estimated = true;
    }

    // (c) Drive rules
    const outgoing = adj.forward.get(nodeId);
    applyDriveRules(draft, outgoing, accDriveHours.get(nodeId) ?? 0, rules);

    // (d) Propagate drive-hours; rest nodes reset.
    if (outgoing) {
      for (const edge of outgoing) {
        const childId = edge.to_node_id;
        const child = drafts.get(childId);
        if (!child) continue;
        const mode = String(edge.travel_mode ?? "");
        const travelHours = Number(edge.travel_time_hours ?? 0);
        const carry = accDriveHours.get(nodeId) ?? 0;
        let newAcc = DRIVE_MODES.has(mode) ? carry + travelHours : carry;
        if (isRestNode(child)) newAcc = 0;
        const existing = accDriveHours.get(childId) ?? 0;
        accDriveHours.set(childId, Math.max(existing, newAcc));
      }
    }
  }

  return nodes.map((n) => drafts.get(n.id)!);
}
