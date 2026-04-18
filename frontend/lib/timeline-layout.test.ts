import { describe, it, expect } from "vitest";
import { computeTimelineLayout } from "./timeline-layout";
import { computeParticipantPaths } from "./path-computation";

// Helpers
function node(
  id: string,
  opts?: {
    participant_ids?: string[] | null;
    arrival_time?: string | null;
    departure_time?: string | null;
  },
) {
  return {
    id,
    name: id,
    type: "city" as const,
    lat_lng: null,
    arrival_time: opts?.arrival_time ?? null,
    departure_time: opts?.departure_time ?? null,
    participant_ids: opts?.participant_ids ?? null,
  };
}

function edge(from: string, to: string) {
  return {
    id: `${from}->${to}`,
    from_node_id: from,
    to_node_id: to,
    travel_mode: "drive",
    travel_time_hours: 1,
    distance_km: 100,
  };
}

describe("timeline layout: lane determination", () => {
  it("linear DAG → single lane", () => {
    const nodes = [node("A"), node("B"), node("C")];
    const edges = [edge("A", "B"), edge("B", "C")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0].laneId).toBe("__all__");
  });

  it("diamond DAG (A→B, A→C, B→D, C→D) → 2 topology lanes", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    // 1 participant means paths can't differentiate branches → topology fallback
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(2);
    // Each lane should contain spine nodes A and D
    for (const lane of layout.lanes) {
      const nodeIds = [...lane.positionedNodes.keys()];
      expect(nodeIds).toContain("A");
      expect(nodeIds).toContain("D");
    }
    // Branch nodes should be in different lanes
    const lane0Nodes = [...layout.lanes[0].positionedNodes.keys()];
    const lane1Nodes = [...layout.lanes[1].positionedNodes.keys()];
    const lane0HasB = lane0Nodes.includes("B");
    const lane0HasC = lane0Nodes.includes("C");
    const lane1HasB = lane1Nodes.includes("B");
    const lane1HasC = lane1Nodes.includes("C");
    expect(lane0HasB !== lane1HasB).toBe(true); // B in one lane, not the other
    expect(lane0HasC !== lane1HasC).toBe(true); // C in one lane, not the other
  });

  it("2 participants with different paths → topology lanes labelled by participants", () => {
    const nodes = [
      node("A"),
      node("B", { participant_ids: ["u1"] }),
      node("C", { participant_ids: ["u2"] }),
      node("D"),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    const names = new Map([["u1", "Alice"], ["u2", "Bob"]]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu", names,
    );

    expect(layout.lanes).toHaveLength(2);
    // Topology-based lanes: IDs are `topology-N`, and the label is derived
    // from participant_ids on branch-exclusive nodes. This test used to
    // assert participant-keyed lane IDs, but the production code has always
    // emitted topology-N — the assertion was stale from day one.
    const laneIds = layout.lanes.map((l) => l.laneId);
    expect(laneIds).toEqual(["topology-0", "topology-1"]);
    const labels = layout.lanes.map((l) => l.participantLabel);
    expect(labels).toContain("Alice");
    expect(labels).toContain("Bob");
  });

  it("2 participants, same path, DAG has branches → topology lanes", () => {
    // Both users assigned to the same branch → identical paths
    const nodes = [
      node("A"),
      node("B", { participant_ids: ["u1", "u2"] }),
      node("C"),
      node("D"),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    // Both users on same path, but DAG has branches → topology fallback
    expect(layout.lanes).toHaveLength(2);
    expect(layout.lanes[0].laneId).toMatch(/^topology-/);
  });

  it("shared nodes have isShared=true in topology lanes", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes.length).toBeGreaterThanOrEqual(2);
    // A and D should be shared in both lanes
    for (const lane of layout.lanes) {
      const posA = lane.positionedNodes.get("A");
      const posD = lane.positionedNodes.get("D");
      expect(posA?.isShared).toBe(true);
      expect(posD?.isShared).toBe(true);
    }
  });

  it("divergence node has sharedNodeRole='diverge'", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A");
    expect(posA?.sharedNodeRole).toBe("diverge");
  });

  it("merge node has sharedNodeRole='merge'", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    const posD = layout.lanes[0].positionedNodes.get("D");
    expect(posD?.sharedNodeRole).toBe("merge");
  });

  it("mine mode is unaffected", () => {
    const nodes = [
      node("A"),
      node("B", { participant_ids: ["u1"] }),
      node("C", { participant_ids: ["u2"] }),
      node("D"),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "mine", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(1);
    expect(layout.lanes[0].laneId).toBe("u1");
    const nodeIds = [...layout.lanes[0].positionedNodes.keys()];
    expect(nodeIds).toContain("A");
    expect(nodeIds).toContain("B");
    expect(nodeIds).toContain("D");
    expect(nodeIds).not.toContain("C");
  });

  it("participant labels populated from participantNames", () => {
    const nodes = [
      node("A"),
      node("B", { participant_ids: ["u1"] }),
      node("C", { participant_ids: ["u2"] }),
      node("D"),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    const names = new Map([["u1", "Alice Smith"], ["u2", "Bob Jones"]]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu", names,
    );

    expect(layout.lanes).toHaveLength(2);
    const labels = layout.lanes.map((l) => l.participantLabel);
    expect(labels).toContain("Alice S.");
    expect(labels).toContain("Bob J.");
  });

  it("topology lanes get Option A/B labels when no participant_ids", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(2);
    const labels = layout.lanes.map((l) => l.participantLabel);
    expect(labels).toContain("Option A");
    expect(labels).toContain("Option B");
  });
});

// ---------------------------------------------------------------------------
// Gap compression — protects against regressions in the compressGaps helper
// that both the multi-lane global pass and the single-lane per-lane pass
// delegate to. Two very similar loops used to be inlined; one call site
// drifting would silently break alignment or produce phantom gap indicators.
// ---------------------------------------------------------------------------

describe("timeline layout: gap compression", () => {
  // 10 days of idle between A and B — massively above the 8h threshold.
  // Without compression, 240h × 60px/h = 14400px of empty space. Compressed
  // gap indicator is 40px.
  const idleHours = 240;
  const aArrival = "2026-01-01T10:00:00Z";
  const aDeparture = "2026-01-01T12:00:00Z";
  const bArrival = new Date(new Date(aDeparture).getTime() + idleHours * 3_600_000).toISOString();

  function twoNodeTrip() {
    const nodes = [
      node("A", { arrival_time: aArrival, departure_time: aDeparture }),
      node("B", { arrival_time: bArrival }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);
    return { nodes, edges, pathResult };
  }

  it("records a gap region when idle exceeds the threshold (single lane)", () => {
    const { nodes, edges, pathResult } = twoNodeTrip();
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(1);
    const lane = layout.lanes[0];
    expect(lane.gapRegions).toHaveLength(1);
    const gap = lane.gapRegions[0];
    expect(gap.afterNodeId).toBe("A");
    expect(gap.compressedHeightPx).toBe(40);
    // 240h idle minus 1h travel time from the edge fixture.
    expect(gap.realDurationHours).toBeCloseTo(239, 0);
  });

  it("does NOT record a gap when idle is below the threshold", () => {
    const nodes = [
      node("A", { arrival_time: "2026-01-01T10:00:00Z", departure_time: "2026-01-01T12:00:00Z" }),
      node("B", { arrival_time: "2026-01-01T15:00:00Z" }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes[0].gapRegions).toHaveLength(0);
  });

  it("compression keeps B within a sane distance of A (not 14000+px)", () => {
    const { nodes, edges, pathResult } = twoNodeTrip();
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    const lane = layout.lanes[0];
    const posA = lane.positionedNodes.get("A")!;
    const posB = lane.positionedNodes.get("B")!;
    const bottomOfA = posA.yOffsetPx + posA.heightPx;
    const distance = posB.yOffsetPx - bottomOfA;
    // Without compression this would be ~14400px. With compression it
    // should be bounded by gap (40px) + connector min (40px) + travel time
    // (1h × 32px/h at zoom 2 = 32px). Give it a generous ceiling.
    expect(distance).toBeLessThan(300);
    expect(distance).toBeGreaterThan(0);
  });

  it("multi-lane global pass produces the same gap regions in affected lanes", () => {
    // Shared A and D with a massive idle gap between them. Two branches
    // (B and C) live in the short middle.
    const nodes = [
      node("A", { arrival_time: "2026-01-01T10:00:00Z", departure_time: "2026-01-01T11:00:00Z" }),
      node("B", {
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T13:00:00Z",
        departure_time: "2026-01-01T14:00:00Z",
      }),
      node("C", {
        participant_ids: ["u2"],
        arrival_time: "2026-01-01T13:00:00Z",
        departure_time: "2026-01-01T14:00:00Z",
      }),
      // D is 10 days after B/C
      node("D", { arrival_time: "2026-01-11T14:00:00Z" }),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(2);

    // The B→D and C→D gaps should each surface in their own lane.
    const lane0GapIds = layout.lanes[0].gapRegions.map((g) => g.afterNodeId);
    const lane1GapIds = layout.lanes[1].gapRegions.map((g) => g.afterNodeId);
    const allGapAfterIds = new Set([...lane0GapIds, ...lane1GapIds]);
    expect(allGapAfterIds.has("B") || allGapAfterIds.has("C")).toBe(true);

    // Multi-lane alignment invariant: D should be at the same yOffset in
    // both lanes (shared node). Regression guard for the helper extraction.
    const posD0 = layout.lanes[0].positionedNodes.get("D")!;
    const posD1 = layout.lanes[1].positionedNodes.get("D")!;
    expect(posD0.yOffsetPx).toBe(posD1.yOffsetPx);
  });
});

// ---------------------------------------------------------------------------
// Edge-case regressions
// ---------------------------------------------------------------------------

describe("timeline layout: edge cases", () => {
  it("empty node list does not crash and returns no lanes", () => {
    const layout = computeTimelineLayout(
      [], [], null, "all", "u1", 2, "eu",
    );
    expect(layout.lanes).toHaveLength(0);
    expect(layout.dateMarkers).toHaveLength(0);
    expect(layout.totalHeightPx).toBeGreaterThanOrEqual(0);
  });

  it("single-node trip renders without crashing", () => {
    // PR1 fix #1 relaxed the "length < 2" early return that previously
    // blocked CurrentTimeIndicator computation. Layout itself must also
    // handle one timed node gracefully.
    const nodes = [node("A", { arrival_time: "2026-01-01T10:00:00Z" })];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(1);
    const pos = layout.lanes[0].positionedNodes.get("A");
    expect(pos).toBeDefined();
    expect(pos?.yOffsetPx).toBeGreaterThanOrEqual(0);
  });

  it("all-untimed nodes stack at orphan spacing (no crash)", () => {
    const nodes = [node("A"), node("B"), node("C")];
    const edges = [edge("A", "B"), edge("B", "C")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(1);
    const positions = [...layout.lanes[0].positionedNodes.values()];
    expect(positions).toHaveLength(3);
    // Orphan stacking produces monotonically increasing y offsets.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].yOffsetPx).toBeGreaterThan(positions[i - 1].yOffsetPx);
    }
  });
});

// ---------------------------------------------------------------------------
// Commit 4: zoom levels, day dividers, enrichment flag propagation.
// ---------------------------------------------------------------------------

describe("timeline layout: zoom levels", () => {
  // Two-node trip spanning 5 hours (below the 8h gap threshold so
  // compression doesn't interfere). Node A has a 5h duration so its
  // own height scales linearly with pxPerHour too, giving zoom a
  // double effect: span + node height.
  function fiveHourTrip() {
    const nodes = [
      node("A", { arrival_time: "2026-01-01T10:00:00Z", departure_time: "2026-01-01T15:00:00Z" }),
      node("B", { arrival_time: "2026-01-01T16:00:00Z", departure_time: "2026-01-01T18:00:00Z" }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);
    return { nodes, edges, pathResult };
  }

  it("zoom 0 (2 px/h) produces the most compact layout", () => {
    const { nodes, edges, pathResult } = fiveHourTrip();
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 0, "eu",
    );
    // At 2px/h, minimum clamps dominate. Stay well under 400px.
    expect(layout.totalHeightPx).toBeLessThan(400);
  });

  it("zoom 6 (120 px/h) produces the most expanded layout", () => {
    const { nodes, edges, pathResult } = fiveHourTrip();
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 6, "eu",
    );
    // At 120px/h: A height = 5h × 120 = 600px, plus connector, plus B
    // height (2h × 120 = 240px), plus padding. Total easily > 900.
    expect(layout.totalHeightPx).toBeGreaterThan(900);
  });

  it("higher zoom level produces taller layout than lower zoom level", () => {
    const { nodes, edges, pathResult } = fiveHourTrip();
    const heights = [0, 1, 2, 3, 4, 5, 6].map((z) =>
      computeTimelineLayout(
        nodes, edges, pathResult, "all", "u1", z as 0 | 1 | 2 | 3 | 4 | 5 | 6, "eu",
      ).totalHeightPx,
    );
    // Monotonically non-decreasing — each zoom level should be at least
    // as tall as the previous one. Strict inequality would be ideal but
    // min clamps absorb very small spans at the lowest zooms.
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
    }
    // And the extremes should differ materially — zoom 6 is 60× zoom 0.
    expect(heights[6]).toBeGreaterThan(heights[0] + 500);
  });
});

describe("timeline layout: date markers", () => {
  it("emits a marker per calendar day across a multi-day trip", () => {
    // Three nodes, each on a distinct UTC day.
    const nodes = [
      node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-01T11:00:00Z" }),
      node("B", { arrival_time: "2026-04-02T10:00:00Z", departure_time: "2026-04-02T11:00:00Z" }),
      node("C", { arrival_time: "2026-04-03T10:00:00Z" }),
    ];
    const edges = [edge("A", "B"), edge("B", "C")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    // Day dividers are rendered by the view at marker.yOffsetPx; the
    // layout should expose one marker per distinct calendar day. The
    // browser's local timezone may shift dates, but we should always
    // have at least as many markers as there are distinct days touched.
    expect(layout.dateMarkers.length).toBeGreaterThanOrEqual(2);
    // Markers must be sorted by Y offset so the view can draw them
    // without additional sorting.
    for (let i = 1; i < layout.dateMarkers.length; i++) {
      expect(layout.dateMarkers[i].yOffsetPx).toBeGreaterThanOrEqual(
        layout.dateMarkers[i - 1].yOffsetPx,
      );
    }
  });

  it("single-day trip produces exactly one date marker", () => {
    const nodes = [
      node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-01T11:00:00Z" }),
      node("B", { arrival_time: "2026-04-01T15:00:00Z" }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.dateMarkers).toHaveLength(1);
  });
});

describe("timeline layout: enrichment flag propagation", () => {
  // These fields are normally populated upstream by `enrichDagTimes`.
  // The timeline layout must forward them to PositionedNode verbatim so
  // the renderer can show dashed borders, overnight chips, etc.

  it("forwards arrivalEstimated/departureEstimated flags", () => {
    const nodes = [
      {
        ...node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-01T11:00:00Z" }),
        arrival_time_estimated: true,
        departure_time_estimated: false,
      },
      {
        ...node("B", { arrival_time: "2026-04-01T13:00:00Z" }),
        arrival_time_estimated: false,
        departure_time_estimated: true,
      },
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A")!;
    const posB = layout.lanes[0].positionedNodes.get("B")!;
    expect(posA.arrivalEstimated).toBe(true);
    expect(posA.departureEstimated).toBe(false);
    expect(posB.arrivalEstimated).toBe(false);
    expect(posB.departureEstimated).toBe(true);
  });

  it("forwards overnightHold + holdReason", () => {
    const nodes = [
      {
        ...node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-02T06:00:00Z" }),
        hold_reason: "night_drive" as const,
      },
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.overnightHold).toBe(true);
    expect(posA.holdReason).toBe("night_drive");
  });

  it("forwards timingConflict", () => {
    const nodes = [
      {
        ...node("A", { arrival_time: "2026-04-01T10:00:00Z" }),
        timing_conflict: "Propagated arrival 15:20 > user arrival 14:00",
      },
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.timingConflict).toBe("Propagated arrival 15:20 > user arrival 14:00");
  });

  it("computes spansDays=0 for same-day stays", () => {
    const nodes = [
      node("A", { arrival_time: "2026-04-01T09:00:00Z", departure_time: "2026-04-01T18:00:00Z" }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.spansDays).toBe(0);
  });

  it("computes spansDays>=1 for overnight stays", () => {
    // In UTC (the default browser TZ in vitest), arriving 10:00 on the
    // 1st and departing 08:00 on the 3rd crosses 2 day boundaries.
    const nodes = [
      node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-03T08:00:00Z" }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.spansDays).toBeGreaterThanOrEqual(1);
  });

  it("missing enrichment flags default to false/null/0 (back-compat)", () => {
    // A raw Firestore node with no enrichment metadata — the layout
    // should not crash and should fill with safe defaults.
    const nodes = [
      node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-01T12:00:00Z" }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.arrivalEstimated).toBe(false);
    expect(posA.departureEstimated).toBe(false);
    expect(posA.overnightHold).toBe(false);
    expect(posA.holdReason).toBe(null);
    expect(posA.timingConflict).toBe(null);
    expect(posA.spansDays).toBe(0);
  });
});
