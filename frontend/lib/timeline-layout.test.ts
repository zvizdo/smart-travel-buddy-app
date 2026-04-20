import { describe, it, expect } from "vitest";
import { computeTimelineLayout } from "./timeline-layout";
import { computeParticipantPaths } from "./path-computation";

// Helpers
function node(
  id: string,
  opts?: {
    type?: string;
    participant_ids?: string[] | null;
    arrival_time?: string | null;
    departure_time?: string | null;
    timezone?: string | null;
  },
) {
  return {
    id,
    name: id,
    type: opts?.type ?? "city",
    lat_lng: null,
    arrival_time: opts?.arrival_time ?? null,
    departure_time: opts?.departure_time ?? null,
    participant_ids: opts?.participant_ids ?? null,
    timezone: opts?.timezone ?? null,
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

  it("branch with 4+ participants lists every name (no cap)", () => {
    // Two-root merge: {u1,u2,u3,u4} start at A, u5 starts at X, they merge at B.
    // Guards the 4+1 shape where one branch has more participants than the old
    // 3-name cap would surface.
    const nodes = [
      node("A", { participant_ids: ["u1", "u2", "u3", "u4"] }),
      node("X", { participant_ids: ["u5"] }),
      node("B"),
      node("C"),
    ];
    const edges = [edge("A", "B"), edge("X", "B"), edge("B", "C")];
    const pathResult = computeParticipantPaths(
      nodes, edges, ["u1", "u2", "u3", "u4", "u5"],
    );
    const names = new Map([
      ["u1", "Alice Smith"],
      ["u2", "Bob Jones"],
      ["u3", "Carol Davis"],
      ["u4", "Dan Wilson"],
      ["u5", "Eve Thompson"],
    ]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu", names,
    );

    expect(layout.lanes).toHaveLength(2);
    const labels = layout.lanes.map((l) => l.participantLabel);
    // 4-participant branch must surface all 4 short-formatted names
    expect(labels).toContain("Alice S., Bob J., Carol D., Dan W.");
    // Solo branch unaffected
    expect(labels).toContain("Eve T.");
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
// Idle-stretch compression — long gaps between stops (≥8h with no lane
// actively spanning the interval) collapse to IDLE_COMPRESSED_PX per
// interval so the scroll length stays proportional to activity, not
// wall-clock.
// ---------------------------------------------------------------------------

describe("timeline layout: idle-stretch compression", () => {
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

  it("long idle stretch between two nodes collapses to empty-day rows", () => {
    const { nodes, edges, pathResult } = twoNodeTrip();
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(1);
    const lane = layout.lanes[0];
    const posA = lane.positionedNodes.get("A")!;
    const posB = lane.positionedNodes.get("B")!;
    const distance = posB.yOffsetPx - (posA.yOffsetPx + posA.heightPx);
    // 240h (~10 days) idle. At uniform 8 px/h this would be ~14 400 px.
    // Sweep-and-Stretch collapses each ≥8h idle interval (incl. every
    // empty calendar day) to IDLE_COMPRESSED_PX. Total stays well under
    // 2000 px.
    expect(distance).toBeLessThan(2000);
    expect(distance).toBeGreaterThan(0);
  });

  it("multi-lane: shared nodes land at identical Y in every lane", () => {
    // Sweep-and-Stretch uses a single shared time_to_Y_map. A shared node
    // at the same wall-clock time must produce the same yOffset in every
    // lane, regardless of per-branch activity density.
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
      // D is 10 days after B/C — used to be the compression-trigger case.
      // Under strict time→Y, the 10-day idle simply renders as proportional
      // empty space.
      node("D", { arrival_time: "2026-01-11T14:00:00Z" }),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(2);

    // Shared-node alignment: D must land at the same Y in every lane.
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
      node("A", { type: "place", arrival_time: "2026-01-01T10:00:00Z", departure_time: "2026-01-01T13:00:00Z" }),
      node("B", { type: "place", arrival_time: "2026-01-01T14:00:00Z", departure_time: "2026-01-01T16:00:00Z" }),
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
    // At 120px/h: A (3h) = 360, B (2h) = 240, gap + padding. > 700.
    expect(layout.totalHeightPx).toBeGreaterThan(700);
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
    expect(heights[6]).toBeGreaterThan(heights[0] + 400);
  });
});

describe("timeline layout: date markers", () => {
  it("emits a marker per calendar day across a multi-day trip", () => {
    // Three nodes, each on a distinct UTC day — pin timezone to UTC so the
    // assertion isn't host-dependent.
    const nodes = [
      node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-01T11:00:00Z", timezone: "UTC" }),
      node("B", { arrival_time: "2026-04-02T10:00:00Z", departure_time: "2026-04-02T11:00:00Z", timezone: "UTC" }),
      node("C", { arrival_time: "2026-04-03T10:00:00Z", timezone: "UTC" }),
    ];
    const edges = [edge("A", "B"), edge("B", "C")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    // Trip spans 3 calendar days in UTC → 3 markers (one per day). The
    // short A–B and B–C idle gaps (22h each) do trip gap-compression, so
    // some interior midnights land inside collapsed regions — that's
    // expected, the count is still one per calendar day.
    expect(layout.dateMarkers).toHaveLength(3);
    for (const m of layout.dateMarkers) expect(m.kind).toBe("midnight");
    // Markers sorted by Y (renderer draws them in order).
    for (let i = 1; i < layout.dateMarkers.length; i++) {
      expect(layout.dateMarkers[i].yOffsetPx).toBeGreaterThanOrEqual(
        layout.dateMarkers[i - 1].yOffsetPx,
      );
    }
  });

  it("single-day trip produces exactly one date marker", () => {
    const nodes = [
      node("A", { arrival_time: "2026-04-01T10:00:00Z", departure_time: "2026-04-01T11:00:00Z", timezone: "UTC" }),
      node("B", { arrival_time: "2026-04-01T15:00:00Z", timezone: "UTC" }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.dateMarkers).toHaveLength(1);
    expect(layout.dateMarkers[0].kind).toBe("midnight");
  });

  it("48h overnight stay emits one marker per day at each day's startY", () => {
    // Dec 10 → Dec 12 spans 3 calendar days (Dec 10, 11, 12). Per-day
    // layout emits one marker per calendar day, anchored to the day's
    // startY (no interpolation). Each marker is at an integer Y that
    // aligns with a horizontal divider in the renderer.
    const nodes = [
      node("A", {
        arrival_time: "2026-12-10T20:00:00Z",
        departure_time: "2026-12-12T20:00:00Z",
        timezone: "UTC",
      }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.dateMarkers).toHaveLength(3);
    // First day-of-trip marker pinned to trip start Y.
    expect(layout.dateMarkers[0].yOffsetPx).toBe(48);
    for (const m of layout.dateMarkers) expect(m.kind).toBe("midnight");
    // Subsequent markers strictly increase in Y.
    expect(layout.dateMarkers[1].yOffsetPx).toBeGreaterThan(
      layout.dateMarkers[0].yOffsetPx,
    );
    expect(layout.dateMarkers[2].yOffsetPx).toBeGreaterThan(
      layout.dateMarkers[1].yOffsetPx,
    );
  });

  it("long idle stretch: each empty day gets its own compact marker", () => {
    // 10 calendar days from A to B. Sweep-and-Stretch emits one marker
    // per calendar day and compresses each empty day's interval to
    // IDLE_COMPRESSED_PX so the stack stays compact.
    const nodes = [
      node("A", {
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T12:00:00Z",
        timezone: "UTC",
      }),
      node("B", { arrival_time: "2026-01-11T12:00:00Z", timezone: "UTC" }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    // 11 calendar days (Jan 1 through Jan 11) → 11 markers.
    expect(layout.dateMarkers.length).toBeGreaterThanOrEqual(10);
    for (const m of layout.dateMarkers) expect(m.kind).toBe("midnight");
  });

  it("overnight flight edge places the next day's marker between A.bottom and B.top", () => {
    const nodes = [
      node("A", { arrival_time: "2026-01-01T22:00:00Z", timezone: "UTC" }),
      node("B", { arrival_time: "2026-01-02T06:00:00Z", timezone: "UTC" }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.dateMarkers).toHaveLength(2);
    const posB = layout.lanes[0].positionedNodes.get("B")!;
    // Jan 2 midnight marker is the second one.
    const jan2 = layout.dateMarkers[1];
    expect(jan2.kind).toBe("midnight");
    // Day 2 starts before B's arrival (06:00 day 2) — i.e. marker sits
    // above B's block top.
    expect(jan2.yOffsetPx).toBeLessThanOrEqual(posB.yOffsetPx);
  });
});

describe("timeline layout: multi-day height", () => {
  // Sweep-and-Stretch uses a zoom-dependent baseline (PX_PER_HOUR[zoom] /
  // 60) to size unclaimed intervals. A node's rendered height still
  // scales with zoom proportional to its duration, gated by the
  // MIN_NODE_HEIGHT_PX floor.
  it("stop height floors at MIN_NODE_HEIGHT_PX and scales with zoom", () => {
    const nodes = [
      node("A", {
        type: "place",
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T13:00:00Z",
        timezone: "UTC",
      }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const at = (z: 0 | 2 | 6) =>
      computeTimelineLayout(nodes, [], pathResult, "all", "u1", z, "eu")
        .lanes[0].positionedNodes.get("A")!.heightPx;

    // Low zoom floors to MIN_NODE_HEIGHT_PX.
    expect(at(0)).toBeGreaterThanOrEqual(56);
    // Zoom 2: 3h × 8 = 24 → floored to 56.
    expect(at(2)).toBeGreaterThanOrEqual(56);
    // Zoom 6: 3h × 120 = 360 px.
    expect(at(6)).toBe(360);
  });

  it("sub-1h stop renders at natural height, floored at MIN_NODE_HEIGHT_PX", () => {
    // A 30-min stop at the baseline rate is duration × rate, then floored
    // to MIN_NODE_HEIGHT_PX.
    const nodes = [
      node("A", {
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T10:30:00Z",
        timezone: "UTC",
      }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const at = (z: 0 | 2 | 6) =>
      computeTimelineLayout(nodes, [], pathResult, "all", "u1", z, "eu")
        .lanes[0].positionedNodes.get("A")!.heightPx;

    expect(at(0)).toBeGreaterThanOrEqual(56);
    expect(at(2)).toBeGreaterThanOrEqual(56);
    // At zoom 6, 30 min × 120/60 = 60 → natural height 60, above MIN floor.
    expect(at(6)).toBeGreaterThanOrEqual(56);
  });

  it("multi-hour stop at high zoom respects full duration", () => {
    // 3h stop at zoom 6. Single-node trip → rate = baseline (120/60 = 2).
    // heightPx = 180 min × 2 = 360. Above the 56 px floor.
    const nodes = [
      node("A", {
        type: "place",
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T13:00:00Z",
        timezone: "UTC",
      }),
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 6, "eu",
    );
    expect(layout.lanes[0].positionedNodes.get("A")!.heightPx).toBe(360);
  });

  it("multi-lane: wall-clock time lands at the same Y in every lane", () => {
    // Diamond DAG: A (shared start) → B, C (diverge) → D (shared end).
    //   B-lane has 5 short stops over a 12h window.
    //   C-lane has one 12h block.
    // Sweep-and-Stretch's shared time_to_Y_map means any wall-clock time
    // maps to exactly one Y in every lane. Pair claims guarantee dense
    // short-stop lanes don't overlap.
    const nodes = [
      node("A", {
        type: "place",
        arrival_time: "2026-04-20T08:00:00Z",
        departure_time: "2026-04-20T09:00:00Z",
        timezone: "UTC",
      }),
      node("C", {
        type: "place",
        participant_ids: ["u2"],
        arrival_time: "2026-04-20T10:00:00Z",
        departure_time: "2026-04-20T13:00:00Z",
        timezone: "UTC",
      }),
      // 5 short stops on the B branch spanning roughly 10:00→20:00
      node("B1", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-04-20T10:00:00Z",
        departure_time: "2026-04-20T10:30:00Z",
        timezone: "UTC",
      }),
      node("B2", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-04-20T12:00:00Z",
        departure_time: "2026-04-20T12:30:00Z",
        timezone: "UTC",
      }),
      node("B3", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-04-20T14:00:00Z",
        departure_time: "2026-04-20T14:30:00Z",
        timezone: "UTC",
      }),
      node("B4", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-04-20T16:00:00Z",
        departure_time: "2026-04-20T16:30:00Z",
        timezone: "UTC",
      }),
      node("B5", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-04-20T18:00:00Z",
        departure_time: "2026-04-20T18:30:00Z",
        timezone: "UTC",
      }),
      node("D", {
        type: "place",
        arrival_time: "2026-04-20T23:00:00Z",
        timezone: "UTC",
      }),
    ];
    const edges = [
      edge("A", "B1"), edge("A", "C"),
      edge("B1", "B2"), edge("B2", "B3"), edge("B3", "B4"), edge("B4", "B5"),
      edge("B5", "D"), edge("C", "D"),
    ];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    expect(layout.lanes).toHaveLength(2);

    // Shared-node alignment invariant: A and D must be at the same Y in
    // every lane.
    const laneB = layout.lanes.find((l) => l.nodeSequence.includes("B1"))!;
    const laneC = layout.lanes.find((l) => l.nodeSequence.includes("C"))!;
    const aB = laneB.positionedNodes.get("A")!;
    const aC = laneC.positionedNodes.get("A")!;
    expect(aB.yOffsetPx).toBe(aC.yOffsetPx);
    const dB = laneB.positionedNodes.get("D")!;
    const dC = laneC.positionedNodes.get("D")!;
    expect(dB.yOffsetPx).toBe(dC.yOffsetPx);

    // C's 3h block floors at MIN_NODE_HEIGHT_PX.
    const cPos = laneC.positionedNodes.get("C")!;
    expect(cPos.heightPx).toBeGreaterThanOrEqual(56);

    // Time-alignment invariant: Y at C.arrival (10:00Z) = Y at B1.arrival
    // (also 10:00Z).
    const b1Pos = laneB.positionedNodes.get("B1")!;
    expect(cPos.yOffsetPx).toBe(b1Pos.yOffsetPx);

    // No overlap: the five short B-lane stops don't paint over each other
    // because the pair claim stretches intervals to fit MIN_NODE +
    // MIN_CONNECTOR between consecutive arrivals.
    const shortIds = ["B1", "B2", "B3", "B4", "B5"];
    for (let i = 0; i < shortIds.length - 1; i++) {
      const a = laneB.positionedNodes.get(shortIds[i])!;
      const b = laneB.positionedNodes.get(shortIds[i + 1])!;
      expect(a.yOffsetPx + a.heightPx).toBeLessThanOrEqual(b.yOffsetPx);
    }
  });

  it("point-in-time node (no departure) keeps the 56px floor", () => {
    // No departure → no duration to scale. The 56 px floor applies so the
    // block has room for its icon, name, time, and status chips.
    const nodes = [node("A", { arrival_time: "2026-01-01T10:00:00Z", timezone: "UTC" })];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);

    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 0, "eu",
    );

    expect(layout.lanes[0].positionedNodes.get("A")!.heightPx).toBe(56);
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

describe("timeline layout: drive-cap advisory min height", () => {
  // Drive-cap nodes render a third advisory row ("Drive cap — add rest
  // stop") inside the node block. The layout engine reserves extra
  // pixels (MIN_NODE_HEIGHT_WITH_ADVISORY_PX = 76) so the label doesn't
  // paint past the rounded border.

  it("drive-cap node floors at the advisory-aware min height", () => {
    // Point-in-time node (no departure) with drive_cap_warning — the
    // natural height is 0, so the advisory-aware floor dominates.
    const nodes = [
      {
        ...node("A", { arrival_time: "2026-01-01T10:00:00Z", timezone: "UTC" }),
        drive_cap_warning: true,
      },
    ];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);
    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );
    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.driveCap).toBe(true);
    expect(posA.heightPx).toBeGreaterThanOrEqual(76);
  });

  it("non-drive-cap node keeps the base 56 px floor", () => {
    const nodes = [node("A", { arrival_time: "2026-01-01T10:00:00Z", timezone: "UTC" })];
    const pathResult = computeParticipantPaths(nodes, [], ["u1"]);
    const layout = computeTimelineLayout(
      nodes, [], pathResult, "all", "u1", 2, "eu",
    );
    const posA = layout.lanes[0].positionedNodes.get("A")!;
    expect(posA.driveCap).toBe(false);
    expect(posA.heightPx).toBe(56);
  });

  it("drive-cap node followed by another node: no overlap at any zoom", () => {
    // The pair claim uses the drive-cap node's advisory-aware min height,
    // so there's always enough room for the 3rd advisory line + connector
    // before the next node.
    const nodes = [
      {
        ...node("A", {
          arrival_time: "2026-01-01T10:00:00Z",
          departure_time: "2026-01-01T10:30:00Z",
          timezone: "UTC",
        }),
        drive_cap_warning: true,
      },
      node("B", {
        arrival_time: "2026-01-01T11:00:00Z",
        departure_time: "2026-01-01T11:30:00Z",
        timezone: "UTC",
      }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);
    for (const zoom of [0, 2, 4, 6] as const) {
      const layout = computeTimelineLayout(
        nodes, edges, pathResult, "all", "u1", zoom, "eu",
      );
      const lane = layout.lanes[0];
      const posA = lane.positionedNodes.get("A")!;
      const posB = lane.positionedNodes.get("B")!;
      // A's block (drive-cap, ≥76 px) plus its connector (≥40 px) fit
      // between A's arrival and B's arrival at every zoom.
      expect(posA.heightPx).toBeGreaterThanOrEqual(76);
      expect(posA.yOffsetPx + posA.heightPx + 40).toBeLessThanOrEqual(posB.yOffsetPx);
    }
  });
});

describe("timeline layout: per-lane arrival for shared merge nodes", () => {
  // Shared helpers --------------------------------------------------------
  // Diamond DAG with two distinct "left" and "right" start times, merging at
  // M. The left branch arrives early; the right branch arrives later; M
  // departs after both at a joint time. Enrichment normally emits
  // ``M.per_parent_arrivals = {B->M: 09:00Z, C->M: 15:00Z}`` and stores
  // ``M.arrival_time = 15:00Z`` (max). Layout must shift M's top in the
  // left lane up to Y(09:00Z) while keeping the bottom aligned across
  // lanes.
  function buildMergeTrip(opts?: {
    withDivergence?: boolean;
    mergeDeparture?: string;
  }) {
    const withDivergence = opts?.withDivergence ?? true;
    const nodes = [
      node("A", {
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T08:00:00Z",
        departure_time: "2026-01-01T08:00:00Z",
      }),
      node("B", {
        participant_ids: ["u1"],
        arrival_time: withDivergence
          ? "2026-01-01T08:00:00Z"
          : "2026-01-01T14:00:00Z",
        departure_time: withDivergence
          ? "2026-01-01T08:00:00Z"
          : "2026-01-01T14:00:00Z",
      }),
      node("C", {
        participant_ids: ["u2"],
        arrival_time: "2026-01-01T14:00:00Z",
        departure_time: "2026-01-01T14:00:00Z",
      }),
      // The merge. `arrival_time` is the enrichment-computed max across
      // parents; `per_parent_arrivals` carries the per-lane values.
      {
        ...node("M", {
          type: "place",
          arrival_time: "2026-01-01T15:00:00Z",
          departure_time: opts?.mergeDeparture ?? "2026-01-01T16:00:00Z",
        }),
        ...(withDivergence
          ? {
              per_parent_arrivals: {
                "B->M": "2026-01-01T13:00:00Z",
                "C->M": "2026-01-01T15:00:00Z",
              },
            }
          : {}),
      },
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "M"), edge("C", "M")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    return { nodes, edges, pathResult };
  }

  it("multi-lane: merge-node block extends up to the lane's per-parent arrival; bottoms stay aligned across lanes", () => {
    const { nodes, edges, pathResult } = buildMergeTrip();
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    // Two lanes should exist (topology-based). Find the lane containing B
    // (the "left/early" branch) and the lane containing C.
    const leftLane = layout.lanes.find((l) => l.nodeSequence.includes("B"))!;
    const rightLane = layout.lanes.find((l) => l.nodeSequence.includes("C"))!;
    expect(leftLane).toBeTruthy();
    expect(rightLane).toBeTruthy();
    expect(leftLane.laneId).not.toBe(rightLane.laneId);

    const leftM = leftLane.positionedNodes.get("M")!;
    const rightM = rightLane.positionedNodes.get("M")!;
    expect(leftM).toBeTruthy();
    expect(rightM).toBeTruthy();

    // Left lane: lane-specific override present. Text label reflects the
    // earlier arrival; enrichment flag is forced to "estimated" (per-branch
    // arrivals are always derived).
    expect(leftM.laneArrivalTime).toBe("2026-01-01T13:00:00Z");
    expect(leftM.arrivalEstimated).toBe(true);

    // Right lane: no override — its incoming edge arrives at the same time
    // that was already stored as ``arrival_time`` (the max).
    expect(rightM.laneArrivalTime ?? null).toBeNull();

    // Block top Y: left < right (left lane arrives earlier). Block bottom
    // Y (yOffsetPx + heightPx): left === right (joint departure stays in
    // sync across lanes). This is the core invariant this change ships.
    expect(leftM.yOffsetPx).toBeLessThan(rightM.yOffsetPx);
    expect(leftM.yOffsetPx + leftM.heightPx).toBe(
      rightM.yOffsetPx + rightM.heightPx,
    );
    // And the left block is strictly taller than the right (it covers the
    // lane's overnight / early-arrival span).
    expect(leftM.heightPx).toBeGreaterThan(rightM.heightPx);
  });

  it("multi-lane regression: merge node WITHOUT per_parent_arrivals renders at identical Y across lanes", () => {
    const { nodes, edges, pathResult } = buildMergeTrip({
      withDivergence: false,
    });
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );
    const leftLane = layout.lanes.find((l) => l.nodeSequence.includes("B"))!;
    const rightLane = layout.lanes.find((l) => l.nodeSequence.includes("C"))!;
    const leftM = leftLane.positionedNodes.get("M")!;
    const rightM = rightLane.positionedNodes.get("M")!;

    // No per_parent_arrivals → no override, no laneArrivalTime.
    expect(leftM.laneArrivalTime ?? null).toBeNull();
    expect(rightM.laneArrivalTime ?? null).toBeNull();

    // Identical Y and height across lanes.
    expect(leftM.yOffsetPx).toBe(rightM.yOffsetPx);
    expect(leftM.heightPx).toBe(rightM.heightPx);
  });

  it("single-lane (My Path = left branch): merge node uses this lane's per-parent arrival for Y and label", () => {
    const { nodes, edges, pathResult } = buildMergeTrip();
    // Filter to the left-branch participant → single-lane view that still
    // sees M via its B->M edge.
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "mine", "u1", 2, "eu",
    );
    expect(layout.lanes).toHaveLength(1);

    const lane = layout.lanes[0];
    expect(lane.nodeSequence).toContain("B");
    expect(lane.nodeSequence).toContain("M");
    // The right-branch node should not be in this lane.
    expect(lane.nodeSequence).not.toContain("C");

    const posM = lane.positionedNodes.get("M")!;
    const posB = lane.positionedNodes.get("B")!;

    // Override applied in single-lane too.
    expect(posM.laneArrivalTime).toBe("2026-01-01T13:00:00Z");
    expect(posM.arrivalEstimated).toBe(true);

    // M's block starts right after B departs (1h drive, 09:00Z arrival)
    // rather than at the max-based 15:00Z.
    expect(posM.yOffsetPx).toBeGreaterThan(posB.yOffsetPx);
    expect(posM.yOffsetPx).toBeLessThan(posB.yOffsetPx + posB.heightPx + 10_000);
  });

  it("multi-lane: per-lane override uses timeToY of the per-parent arrival", () => {
    // The per-parent arrival Y resolves through the shared time_to_Y_map;
    // cross-lane alignment at that instant is preserved even when a
    // lane's node renders at the MIN_NODE_HEIGHT floor.
    const nodes = [
      node("A", {
        participant_ids: ["u1", "u2"],
        arrival_time: "2026-01-01T08:00:00Z",
        departure_time: "2026-01-01T08:00:00Z",
      }),
      node("B", {
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T15:00:00Z",
      }),
      node("C", {
        participant_ids: ["u2"],
        arrival_time: "2026-01-02T14:00:00Z",
        departure_time: "2026-01-02T14:00:00Z",
      }),
      {
        ...node("M", {
          arrival_time: "2026-01-02T15:00:00Z",
          departure_time: "2026-01-02T16:00:00Z",
        }),
        per_parent_arrivals: {
          "B->M": "2026-01-01T16:00:00Z",
          "C->M": "2026-01-02T15:00:00Z",
        },
      },
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "M"), edge("C", "M")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );

    const leftLane = layout.lanes.find((l) => l.nodeSequence.includes("B"))!;
    const posM = leftLane.positionedNodes.get("M")!;

    // Label override still fires — the lane really did arrive at 16:00Z.
    expect(posM.laneArrivalTime).toBe("2026-01-01T16:00:00Z");
    expect(posM.arrivalEstimated).toBe(true);

    // Cross-lane invariant: at any time in any lane, timeToY(ms) is the
    // same. So posM.yOffsetPx = timeToY(perParent) = timeToY(16:00 day 1).
    // Assert alignment by checking another lane's timeToY at the same
    // wall clock produces identical Y.
    const rightLane = layout.lanes.find((l) => l.nodeSequence.includes("C"))!;
    const posA = rightLane.positionedNodes.get("A")!;
    // C arrives on day 2 at 14:00; the override of 16:00 day 1 is 8h
    // after A (08:00 day 1). A's Y in the right lane corresponds to
    // timeToY(08:00), so posM.yOffsetPx > posA.yOffsetPx but still on day 1.
    expect(posM.yOffsetPx).toBeGreaterThan(posA.yOffsetPx);
  });

  it("multi-lane: Y at any wall-clock time is identical across all lanes", () => {
    // The invariant the user cares about: a vertical slice at any Y
    // represents the same wall-clock time in every lane. Exercise with
    // a diamond where both branches have blocks at overlapping times.
    const nodes = [
      node("A", {
        participant_ids: ["u1", "u2"],
        arrival_time: "2026-01-01T08:00:00Z",
        departure_time: "2026-01-01T08:00:00Z",
      }),
      node("B", {
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T18:00:00Z",
      }),
      node("C", {
        participant_ids: ["u2"],
        arrival_time: "2026-01-01T12:00:00Z",
        departure_time: "2026-01-01T20:00:00Z",
      }),
      node("D", {
        arrival_time: "2026-01-02T08:00:00Z",
        departure_time: "2026-01-02T08:00:00Z",
      }),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );
    expect(layout.lanes).toHaveLength(2);

    const laneB = layout.lanes.find((l) => l.nodeSequence.includes("B"))!;
    const laneC = layout.lanes.find((l) => l.nodeSequence.includes("C"))!;

    // A (shared start): same Y in both lanes.
    expect(laneB.positionedNodes.get("A")!.yOffsetPx).toBe(
      laneC.positionedNodes.get("A")!.yOffsetPx,
    );
    // D (shared end): same Y in both lanes.
    expect(laneB.positionedNodes.get("D")!.yOffsetPx).toBe(
      laneC.positionedNodes.get("D")!.yOffsetPx,
    );

    // B and C have equal durations (both 8h) → equal heightPx. Y
    // positions match across lanes at equal wall-clock times. Ordering
    // B.arrival (10:00) < C.arrival (12:00) → B.Y < C.Y.
    const bPos = laneB.positionedNodes.get("B")!;
    const cPos = laneC.positionedNodes.get("C")!;
    expect(bPos.yOffsetPx).toBeLessThan(cPos.yOffsetPx);
    expect(bPos.heightPx).toBe(cPos.heightPx);
  });
});

describe("timeline layout: Sweep-and-Stretch no-overlap invariant", () => {
  // Pair claims (MIN_NODE + MIN_CONNECTOR between every consecutive
  // arrival pair) grow intervals as needed so two timed nodes in the
  // same lane never paint over each other, at any zoom.

  it("5 back-to-back short stops on one branch never overlap", () => {
    // Five 30-min stops, each 45 min apart, on one branch of a diamond.
    const nodes = [
      node("A", {
        type: "place",
        participant_ids: ["u1", "u2"],
        arrival_time: "2026-01-01T08:00:00Z",
        departure_time: "2026-01-01T09:00:00Z",
        timezone: "UTC",
      }),
      node("S1", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T10:30:00Z",
        timezone: "UTC",
      }),
      node("S2", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T11:15:00Z",
        departure_time: "2026-01-01T11:45:00Z",
        timezone: "UTC",
      }),
      node("S3", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T12:30:00Z",
        departure_time: "2026-01-01T13:00:00Z",
        timezone: "UTC",
      }),
      node("S4", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T13:45:00Z",
        departure_time: "2026-01-01T14:15:00Z",
        timezone: "UTC",
      }),
      node("S5", {
        type: "place",
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T15:00:00Z",
        departure_time: "2026-01-01T15:30:00Z",
        timezone: "UTC",
      }),
      node("X", {
        type: "place",
        participant_ids: ["u2"],
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T18:00:00Z",
        timezone: "UTC",
      }),
      node("Z", {
        type: "place",
        participant_ids: ["u1", "u2"],
        arrival_time: "2026-01-01T18:00:00Z",
        departure_time: "2026-01-01T20:00:00Z",
        timezone: "UTC",
      }),
    ];
    const edges = [
      edge("A", "S1"),
      edge("S1", "S2"),
      edge("S2", "S3"),
      edge("S3", "S4"),
      edge("S4", "S5"),
      edge("S5", "Z"),
      edge("A", "X"),
      edge("X", "Z"),
    ];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    for (const zoom of [2, 4, 6] as const) {
      const layout = computeTimelineLayout(
        nodes, edges, pathResult, "all", "u1", zoom, "eu",
      );
      const sLane = layout.lanes.find((l) => l.nodeSequence.includes("S1"))!;
      const ids = ["A", "S1", "S2", "S3", "S4", "S5", "Z"];
      for (let i = 0; i < ids.length - 1; i++) {
        const a = sLane.positionedNodes.get(ids[i])!;
        const b = sLane.positionedNodes.get(ids[i + 1])!;
        expect(a.yOffsetPx + a.heightPx).toBeLessThanOrEqual(b.yOffsetPx);
      }
    }
  });

  it("shared nodes land at identical Y across lanes (strict cross-lane alignment)", () => {
    const nodes = [
      node("A", {
        participant_ids: ["u1", "u2"],
        arrival_time: "2026-01-01T08:00:00Z",
        departure_time: "2026-01-01T08:00:00Z",
        timezone: "UTC",
      }),
      node("B", {
        participant_ids: ["u1"],
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T11:00:00Z",
        timezone: "UTC",
      }),
      node("C", {
        participant_ids: ["u2"],
        arrival_time: "2026-01-01T13:00:00Z",
        departure_time: "2026-01-01T14:00:00Z",
        timezone: "UTC",
      }),
      node("D", {
        participant_ids: ["u1", "u2"],
        arrival_time: "2026-01-01T18:00:00Z",
        departure_time: "2026-01-01T18:00:00Z",
        timezone: "UTC",
      }),
    ];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1", "u2"]);
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );
    expect(layout.lanes).toHaveLength(2);
    const laneB = layout.lanes.find((l) => l.nodeSequence.includes("B"))!;
    const laneC = layout.lanes.find((l) => l.nodeSequence.includes("C"))!;
    // Shared endpoints align exactly.
    expect(laneB.positionedNodes.get("A")!.yOffsetPx).toBe(
      laneC.positionedNodes.get("A")!.yOffsetPx,
    );
    expect(laneB.positionedNodes.get("D")!.yOffsetPx).toBe(
      laneC.positionedNodes.get("D")!.yOffsetPx,
    );
  });

  it("idle calendar days between content compress to empty-day rows", () => {
    // Every idle interval ≥ IDLE_COMPRESSION_THRESHOLD_MS with no lane
    // actively spanning it collapses to IDLE_COMPRESSED_PX, so multi-day
    // gaps don't dominate vertical space.
    const nodes = [
      node("A", {
        arrival_time: "2026-01-01T10:00:00Z",
        departure_time: "2026-01-01T12:00:00Z",
        timezone: "UTC",
      }),
      node("B", {
        arrival_time: "2026-01-08T10:00:00Z",
        departure_time: "2026-01-08T12:00:00Z",
        timezone: "UTC",
      }),
    ];
    const edges = [edge("A", "B")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);
    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", 2, "eu",
    );
    const lane = layout.lanes[0];
    const a = lane.positionedNodes.get("A")!;
    const b = lane.positionedNodes.get("B")!;
    // Without compression at zoom 2 (8 px/h), this would be ~7 × 24 × 8
    // = 1344 px of pure gap. Idle-interval compression keeps the total
    // height manageable.
    const total = b.yOffsetPx - a.yOffsetPx;
    expect(total).toBeLessThan(1000);
    expect(total).toBeGreaterThan(0);
  });
});
