import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  enrichDagTimes,
  type EnrichedNode,
  type RawEdge,
  type RawNode,
  type TripSettingsLike,
} from "./time-inference";

// The shared fixture is the source of truth; the Python mirror at
// shared/tests/test_time_inference.py runs the same cases. If you edit
// the algorithm, update the JSON and both runtimes must stay green.
interface FixtureCase {
  name: string;
  description?: string;
  trip_settings: TripSettingsLike | null;
  nodes: RawNode[];
  edges: RawEdge[];
  expected: Partial<EnrichedNode>[];
  expect_conflict_on?: string;
}

const FIXTURE_PATH = resolve(
  __dirname,
  "../../shared/tests/fixtures/time_inference_cases.json",
);

function loadFixture(): FixtureCase[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as FixtureCase[];
}

function findNode(enriched: EnrichedNode[], id: string): EnrichedNode {
  const match = enriched.find((n) => n.id === id);
  if (!match) throw new Error(`node ${id} not in enriched output`);
  return match;
}

/**
 * Datetime-aware comparison: if both sides parse as dates, compare by
 * epoch ms so `+00:00` vs `Z` variance from either runtime never produces
 * a false failure. Everything else uses strict deep equality.
 */
function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (
    typeof actual === "string" &&
    typeof expected === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(expected)
  ) {
    const a = Date.parse(actual);
    const e = Date.parse(expected);
    if (!Number.isNaN(a) && !Number.isNaN(e)) return a === e;
  }
  return Object.is(actual, expected);
}

describe("enrichDagTimes — shared fixture parity", () => {
  const cases = loadFixture();

  it.each(cases)("$name", (testCase) => {
    const enriched = enrichDagTimes(
      testCase.nodes,
      testCase.edges,
      testCase.trip_settings,
    );

    for (const expectation of testCase.expected) {
      const actual = findNode(enriched, expectation.id as string);
      for (const [key, expectedValue] of Object.entries(expectation)) {
        const actualValue = (actual as Record<string, unknown>)[key];
        expect(
          valuesEqual(actualValue, expectedValue),
          `[${testCase.name}] node ${expectation.id} field ${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`,
        ).toBe(true);
      }
    }

    if (testCase.expect_conflict_on) {
      const conflicted = findNode(enriched, testCase.expect_conflict_on);
      expect(conflicted.timing_conflict).not.toBeNull();
    }
  });
});

describe("enrichDagTimes — TS-specific invariants", () => {
  it("does not mutate the input nodes array", () => {
    const nodes: RawNode[] = [
      {
        id: "n_a",
        name: "A",
        type: "city",
        timezone: "UTC",
        departure_time: "2026-05-01T09:00:00+00:00",
      },
      { id: "n_b", name: "B", type: "place", timezone: "UTC" },
    ];
    const edges: RawEdge[] = [
      {
        from_node_id: "n_a",
        to_node_id: "n_b",
        travel_mode: "drive",
        travel_time_hours: 1,
      },
    ];
    enrichDagTimes(nodes, edges, {});
    expect(nodes[1].arrival_time).toBeUndefined();
    expect(nodes[1].duration_minutes).toBeUndefined();
    expect(
      (nodes[0] as Record<string, unknown>).arrival_time_estimated,
    ).toBeUndefined();
  });

  it("single start node with only departure publishes it as arrival", () => {
    const nodes: RawNode[] = [
      {
        id: "n_start",
        name: "Start",
        type: "place",
        timezone: "UTC",
        departure_time: "2026-05-01T09:00:00+00:00",
      },
    ];
    const enriched = enrichDagTimes(nodes, [], {});
    expect(enriched[0].arrival_time).toBe("2026-05-01T09:00:00+00:00");
    expect(enriched[0].arrival_time_estimated).toBe(true);
    expect(enriched[0].is_start).toBe(true);
    expect(enriched[0].is_end).toBe(true);
  });

  it("topology flags follow the edge set, not input order", () => {
    const nodes: RawNode[] = [
      { id: "b", name: "B", type: "place" },
      { id: "a", name: "A", type: "place" },
      { id: "c", name: "C", type: "place" },
    ];
    const edges: RawEdge[] = [
      {
        from_node_id: "a",
        to_node_id: "b",
        travel_mode: "drive",
        travel_time_hours: 1,
      },
      {
        from_node_id: "b",
        to_node_id: "c",
        travel_mode: "drive",
        travel_time_hours: 1,
      },
    ];
    const enriched = enrichDagTimes(nodes, edges, {});
    const a = findNode(enriched, "a");
    const b = findNode(enriched, "b");
    const c = findNode(enriched, "c");
    expect(a.is_start).toBe(true);
    expect(a.is_end).toBe(false);
    expect(b.is_start).toBe(false);
    expect(b.is_end).toBe(false);
    expect(c.is_start).toBe(false);
    expect(c.is_end).toBe(true);
  });

  it("output preserves input order", () => {
    const nodes: RawNode[] = [
      { id: "z", name: "Z", type: "place" },
      { id: "a", name: "A", type: "place" },
      { id: "m", name: "M", type: "place" },
    ];
    const enriched = enrichDagTimes(nodes, [], {});
    expect(enriched.map((n) => n.id)).toEqual(["z", "a", "m"]);
  });

  it("night-drive takes precedence over max-drive-hours when both fire", () => {
    const nodes: RawNode[] = [
      {
        id: "start",
        name: "Start",
        type: "city",
        timezone: "UTC",
        departure_time: "2026-05-01T20:00:00+00:00",
      },
      {
        id: "end",
        name: "End",
        type: "place",
        timezone: "UTC",
        duration_minutes: 30,
      },
    ];
    const edges: RawEdge[] = [
      {
        from_node_id: "start",
        to_node_id: "end",
        travel_mode: "drive",
        travel_time_hours: 7,
      },
    ];
    const settings: TripSettingsLike = {
      no_drive_window: { start_hour: 22, end_hour: 6 },
      max_drive_hours_per_day: 5.0,
    };
    const enriched = enrichDagTimes(nodes, edges, settings);
    const end = findNode(enriched, "end");
    expect(end.drive_cap_warning).toBe(true);
    expect(end.hold_reason).toBe("night_drive");
  });

  it("cycle returns raw nodes with defaults, no estimation", () => {
    const nodes: RawNode[] = [
      {
        id: "a",
        name: "A",
        type: "place",
        arrival_time: "2026-05-01T09:00:00+00:00",
      },
      { id: "b", name: "B", type: "place" },
    ];
    const edges: RawEdge[] = [
      {
        from_node_id: "a",
        to_node_id: "b",
        travel_mode: "drive",
        travel_time_hours: 1,
      },
      {
        from_node_id: "b",
        to_node_id: "a",
        travel_mode: "drive",
        travel_time_hours: 1,
      },
    ];
    const enriched = enrichDagTimes(nodes, edges, {});
    const a = findNode(enriched, "a");
    const b = findNode(enriched, "b");
    expect(a.arrival_time).toBe("2026-05-01T09:00:00+00:00");
    expect(a.arrival_time_estimated).toBe(false);
    expect(a.duration_minutes).toBe(30);
    expect(a.duration_estimated).toBe(true);
    expect(b.duration_minutes).toBe(30);
    expect(b.duration_estimated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timing conflict severity — mirror of TestTimingConflictSeverity in
// shared/tests/test_time_inference.py. Parity across runtimes is enforced
// by the shared JSON fixture; these tests exist so a TS reader can see the
// decision table without cross-referencing Python.
// ---------------------------------------------------------------------------

describe("enrichDagTimes — timing conflict severity", () => {
  function runCase(
    userArrival: string,
    travelHours = 1,
  ): EnrichedNode {
    const nodes: RawNode[] = [
      {
        id: "a",
        name: "A",
        type: "place",
        timezone: "UTC",
        departure_time: "2026-05-01T09:00:00+00:00",
      },
      {
        id: "b",
        name: "B",
        type: "activity",
        timezone: "UTC",
        arrival_time: userArrival,
        departure_time: "2026-05-01T13:00:00+00:00",
      },
    ];
    const edges: RawEdge[] = [
      {
        from_node_id: "a",
        to_node_id: "b",
        travel_mode: "drive",
        travel_time_hours: travelHours,
      },
    ];
    return findNode(enrichDagTimes(nodes, edges, {}), "b");
  }

  it("10 min early is suppressed", () => {
    const b = runCase("2026-05-01T10:10:00+00:00");
    expect(b.timing_conflict).toBeNull();
    expect(b.timing_conflict_severity).toBeNull();
  });

  it("29m59s early is still suppressed", () => {
    const b = runCase("2026-05-01T10:29:59+00:00");
    expect(b.timing_conflict).toBeNull();
    expect(b.timing_conflict_severity).toBeNull();
  });

  it("exactly 30m early crosses into info", () => {
    const b = runCase("2026-05-01T10:30:00+00:00");
    expect(b.timing_conflict_severity).toBe("info");
    expect(b.timing_conflict).not.toBeNull();
  });

  it("45m early is info", () => {
    const b = runCase("2026-05-01T10:45:00+00:00");
    expect(b.timing_conflict_severity).toBe("info");
  });

  it("1h59m early stays info", () => {
    const b = runCase("2026-05-01T11:59:00+00:00");
    expect(b.timing_conflict_severity).toBe("info");
  });

  it("exactly 2h early crosses into advisory", () => {
    const b = runCase("2026-05-01T12:00:00+00:00");
    expect(b.timing_conflict_severity).toBe("advisory");
  });

  it("3h early is advisory", () => {
    const b = runCase("2026-05-01T13:00:00+00:00");
    expect(b.timing_conflict_severity).toBe("advisory");
  });

  it("2 min late is error", () => {
    const b = runCase("2026-05-01T09:58:00+00:00");
    expect(b.timing_conflict_severity).toBe("error");
  });

  it("30 min late is error", () => {
    const b = runCase("2026-05-01T09:30:00+00:00");
    expect(b.timing_conflict_severity).toBe("error");
  });

  it("30 s off is within tolerance (null)", () => {
    const b = runCase("2026-05-01T10:00:30+00:00");
    expect(b.timing_conflict).toBeNull();
    expect(b.timing_conflict_severity).toBeNull();
  });

  it("message and severity are set together or both null", () => {
    for (const userArrival of [
      "2026-05-01T10:30:00+00:00", // info
      "2026-05-01T12:00:00+00:00", // advisory
      "2026-05-01T09:30:00+00:00", // error
      "2026-05-01T10:10:00+00:00", // suppressed
    ]) {
      const b = runCase(userArrival);
      expect(
        (b.timing_conflict === null) === (b.timing_conflict_severity === null),
        `desync at ${userArrival}: conflict=${b.timing_conflict}, severity=${b.timing_conflict_severity}`,
      ).toBe(true);
    }
  });
});
