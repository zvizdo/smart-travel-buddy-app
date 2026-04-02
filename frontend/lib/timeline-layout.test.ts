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
    order_index: 0,
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
      nodes, edges, pathResult, "all", "u1", ["u1"], 2, "eu",
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
      nodes, edges, pathResult, "all", "u1", ["u1"], 2, "eu",
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

  it("2 participants with different paths → participant-based lanes", () => {
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
      nodes, edges, pathResult, "all", "u1", ["u1", "u2"], 2, "eu", names,
    );

    expect(layout.lanes).toHaveLength(2);
    // Participant-based lanes use userId as laneId
    const laneIds = layout.lanes.map((l) => l.laneId);
    expect(laneIds).toContain("u1");
    expect(laneIds).toContain("u2");
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
      nodes, edges, pathResult, "all", "u1", ["u1", "u2"], 2, "eu",
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
      nodes, edges, pathResult, "all", "u1", ["u1"], 2, "eu",
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
      nodes, edges, pathResult, "all", "u1", ["u1"], 2, "eu",
    );

    const posA = layout.lanes[0].positionedNodes.get("A");
    expect(posA?.sharedNodeRole).toBe("diverge");
  });

  it("merge node has sharedNodeRole='merge'", () => {
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")];
    const pathResult = computeParticipantPaths(nodes, edges, ["u1"]);

    const layout = computeTimelineLayout(
      nodes, edges, pathResult, "all", "u1", ["u1"], 2, "eu",
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
      nodes, edges, pathResult, "mine", "u1", ["u1", "u2"], 2, "eu",
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
      nodes, edges, pathResult, "all", "u1", ["u1", "u2"], 2, "eu", names,
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
      nodes, edges, pathResult, "all", "u1", ["u1"], 2, "eu",
    );

    expect(layout.lanes).toHaveLength(2);
    const labels = layout.lanes.map((l) => l.participantLabel);
    expect(labels).toContain("Option A");
    expect(labels).toContain("Option B");
  });
});
