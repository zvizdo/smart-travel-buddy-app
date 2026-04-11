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
