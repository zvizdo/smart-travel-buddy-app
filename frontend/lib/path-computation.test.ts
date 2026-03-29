import { describe, it, expect } from "vitest";
import { computeParticipantPaths, computeEdgeColors } from "./path-computation";

// Helper to build simple node objects
function node(
  id: string,
  participantIds?: string[] | null,
): { id: string; participant_ids: string[] | null } {
  return { id, participant_ids: participantIds ?? null };
}

function edge(
  from: string,
  to: string,
): { from_node_id: string; to_node_id: string } {
  return { from_node_id: from, to_node_id: to };
}

describe("computeParticipantPaths", () => {
  it("linear DAG: all participants share the same path", () => {
    const nodes = [node("A"), node("B"), node("C")];
    const edges = [edge("A", "B"), edge("B", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "B", "C"]);
    expect(result.paths.get("u2")).toEqual(["A", "B", "C"]);
    expect(result.unresolved).toEqual([]);
  });

  it("divergence with no assignments: all participants unresolved", () => {
    // A -> B, A -> C (no participant_ids on B or C)
    const nodes = [node("A"), node("B"), node("C")];
    const edges = [edge("A", "B"), edge("A", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    // Both users should be unresolved at divergence A
    const unresolvedAtA = result.unresolved.filter(
      (u) => u.divergence_node_id === "A",
    );
    expect(unresolvedAtA).toHaveLength(2);
    expect(unresolvedAtA.map((u) => u.user_id).sort()).toEqual(["u1", "u2"]);
  });

  it("divergence with assignments: each user follows their branch", () => {
    // A -> B (u1), A -> C (u2)
    const nodes = [node("A"), node("B", ["u1"]), node("C", ["u2"])];
    const edges = [edge("A", "B"), edge("A", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "B"]);
    expect(result.paths.get("u2")).toEqual(["A", "C"]);
    expect(result.unresolved).toEqual([]);
  });

  it("divergence and merge: paths include merge node", () => {
    // A -> B (u1) -> D, A -> C (u2) -> D
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("C", ["u2"]),
      node("D"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "C"),
      edge("B", "D"),
      edge("C", "D"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "B", "D"]);
    expect(result.paths.get("u2")).toEqual(["A", "C", "D"]);
    expect(result.unresolved).toEqual([]);
  });

  it("chained divergences: user only sees divergences on their path", () => {
    // This is the bug scenario: A -> B (u1 chose), A -> C, C -> D, C -> E
    // u1 should NOT have an unresolved divergence at C (not on their path)
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("C"),
      node("D"),
      node("E"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "C"),
      edge("C", "D"),
      edge("C", "E"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1"]);

    // u1's path is A -> B only. They should NOT be asked about C's divergence.
    expect(result.paths.get("u1")).toEqual(["A", "B"]);
    // The only unresolved is NOT at C for u1
    const u1Unresolved = result.unresolved.filter((u) => u.user_id === "u1");
    expect(u1Unresolved).toEqual([]);
  });

  it("chained divergences: unassigned user gets unresolved only at first divergence", () => {
    // A -> B (u1 assigned), A -> C. C -> D, C -> E.
    // u2 has NO assignment at A (some branches have assignments, but u2 isn't on any)
    // u2 should be unresolved at A, NOT at C
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("C"),
      node("D"),
      node("E"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "C"),
      edge("C", "D"),
      edge("C", "E"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const u2Unresolved = result.unresolved.filter((u) => u.user_id === "u2");
    // u2 follows unassigned branch C, then hits divergence at C with no assignments
    expect(u2Unresolved).toHaveLength(1);
    expect(u2Unresolved[0].divergence_node_id).toBe("C");

    // u2's path should include A and C (stopped at C's divergence)
    expect(result.paths.get("u2")).toEqual(["A", "C"]);
  });

  it("three end nodes: user on one branch doesn't see other branch divergences", () => {
    // The exact bug scenario reported:
    // A -> B -> D (end), A -> C -> E (end), A -> C -> F (end)
    // Actually: A -> B (u1), A -> C. C -> E, C -> F.
    // u1 chose B, so they should only see divergence at A (resolved), NOT at C.
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("C"),
      node("D"),
      node("E"),
      node("F"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "C"),
      edge("B", "D"),
      edge("C", "E"),
      edge("C", "F"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1"]);

    // u1's path goes A -> B -> D
    expect(result.paths.get("u1")).toEqual(["A", "B", "D"]);
    // u1 should have NO unresolved (they chose B at divergence A)
    expect(result.unresolved.filter((u) => u.user_id === "u1")).toEqual([]);

    // The divergence at C is NOT on u1's path
    const u1PathSet = new Set(result.paths.get("u1"));
    expect(u1PathSet.has("C")).toBe(false);
  });

  it("three end nodes: admin path only includes their branch divergences", () => {
    // Full scenario: A -> B (admin) -> D, A -> C -> E, A -> C -> F
    // Admin (u1) chose B. Other user u2 has no assignment.
    // Admin's path: A, B, D. Divergences on admin's path: A (resolved).
    // Divergence at C should NOT be on admin's path.
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("C"),
      node("D"),
      node("E"),
      node("F"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "C"),
      edge("B", "D"),
      edge("C", "E"),
      edge("C", "F"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    // Admin path
    const adminPath = result.paths.get("u1")!;
    expect(adminPath).toEqual(["A", "B", "D"]);

    // Divergence nodes in the graph: A (out-degree 2) and C (out-degree 2)
    // Only A is on admin's path
    const adminPathSet = new Set(adminPath);
    expect(adminPathSet.has("A")).toBe(true);
    expect(adminPathSet.has("C")).toBe(false);

    // u2 follows unassigned C, then hits divergence at C
    expect(result.paths.get("u2")).toEqual(["A", "C"]);
    const u2Unresolved = result.unresolved.filter((u) => u.user_id === "u2");
    expect(u2Unresolved).toHaveLength(1);
    expect(u2Unresolved[0].divergence_node_id).toBe("C");
  });

  it("multiple sequential divergences on same path", () => {
    // A -> B (u1) -> C, A -> X. C -> D (u1) -> F, C -> E.
    // u1 should have divergences at A (resolved) and C (resolved) on their path.
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("X"),
      node("C"),
      node("D", ["u1"]),
      node("E"),
      node("F"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "X"),
      edge("B", "C"),
      edge("C", "D"),
      edge("C", "E"),
      edge("D", "F"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1"]);

    // u1's full path: A -> B -> C -> D -> F
    expect(result.paths.get("u1")).toEqual(["A", "B", "C", "D", "F"]);
    // Both divergence nodes (A and C) are on u1's path
    const pathSet = new Set(result.paths.get("u1"));
    expect(pathSet.has("A")).toBe(true);
    expect(pathSet.has("C")).toBe(true);
    // No unresolved since u1 is assigned at both
    expect(result.unresolved.filter((u) => u.user_id === "u1")).toEqual([]);
  });

  it("multiple roots with no assignments: all participants unresolved at __root__", () => {
    // Two starting points: A and B, no participant assignments
    const nodes = [node("A"), node("B"), node("C")];
    const edges = [edge("A", "C"), edge("B", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const rootUnresolved = result.unresolved.filter(
      (u) => u.divergence_node_id === "__root__",
    );
    expect(rootUnresolved).toHaveLength(2);
    expect(rootUnresolved.map((u) => u.user_id).sort()).toEqual(["u1", "u2"]);
  });

  it("multiple roots with assignments: each user follows their root", () => {
    // Two starting points: A (u1) and B (u2), merging at C
    const nodes = [node("A", ["u1"]), node("B", ["u2"]), node("C")];
    const edges = [edge("A", "C"), edge("B", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "C"]);
    expect(result.paths.get("u2")).toEqual(["B", "C"]);

    const rootUnresolved = result.unresolved.filter(
      (u) => u.divergence_node_id === "__root__",
    );
    expect(rootUnresolved).toHaveLength(0);
  });

  it("multiple roots: unassigned user follows fallback root", () => {
    // Two starting points: A (u1 assigned) and B (unassigned). u2 has no assignment.
    const nodes = [node("A", ["u1"]), node("B"), node("C")];
    const edges = [edge("A", "C"), edge("B", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "C"]);
    // u2 falls back to unassigned root B
    expect(result.paths.get("u2")).toEqual(["B", "C"]);

    // u2 is not unresolved because B is an unassigned fallback
    const u2RootUnresolved = result.unresolved.filter(
      (u) => u.divergence_node_id === "__root__" && u.user_id === "u2",
    );
    expect(u2RootUnresolved).toHaveLength(0);
  });

  it("multiple roots: all assigned, missing user gets __root__ unresolved", () => {
    // All roots assigned but u3 is not on any
    const nodes = [node("A", ["u1"]), node("B", ["u2"]), node("C")];
    const edges = [edge("A", "C"), edge("B", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2", "u3"]);

    expect(result.paths.get("u1")).toEqual(["A", "C"]);
    expect(result.paths.get("u2")).toEqual(["B", "C"]);

    const u3Root = result.unresolved.filter(
      (u) => u.user_id === "u3" && u.divergence_node_id === "__root__",
    );
    expect(u3Root).toHaveLength(1);
  });

  it("three roots: each user follows their assigned root", () => {
    const nodes = [
      node("A", ["u1"]),
      node("B", ["u2"]),
      node("C", ["u3"]),
      node("D"),
    ];
    const edges = [edge("A", "D"), edge("B", "D"), edge("C", "D")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2", "u3"]);

    expect(result.paths.get("u1")).toEqual(["A", "D"]);
    expect(result.paths.get("u2")).toEqual(["B", "D"]);
    expect(result.paths.get("u3")).toEqual(["C", "D"]);

    const rootUnresolved = result.unresolved.filter(
      (u) => u.divergence_node_id === "__root__",
    );
    expect(rootUnresolved).toHaveLength(0);
  });

  it("multiple roots + downstream divergence: both layers resolved", () => {
    // A(u1) -> C -> D(u1), B(u2) -> C -> E(u2)
    const nodes = [
      node("A", ["u1"]),
      node("B", ["u2"]),
      node("C"),
      node("D", ["u1"]),
      node("E", ["u2"]),
    ];
    const edges = [
      edge("A", "C"),
      edge("B", "C"),
      edge("C", "D"),
      edge("C", "E"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "C", "D"]);
    expect(result.paths.get("u2")).toEqual(["B", "C", "E"]);
    expect(result.unresolved).toEqual([]);
  });

  it("multiple roots: independent chains, no merge", () => {
    // Two roots leading to separate endpoints
    const nodes = [
      node("A", ["u1"]),
      node("B", ["u2"]),
      node("C"),
      node("D"),
    ];
    const edges = [edge("A", "C"), edge("B", "D")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    expect(result.paths.get("u1")).toEqual(["A", "C"]);
    expect(result.paths.get("u2")).toEqual(["B", "D"]);
    expect(result.unresolved).toEqual([]);
  });

  it("single root: no __root__ unresolved even with multiple participants", () => {
    const nodes = [node("A"), node("B"), node("C")];
    const edges = [edge("A", "B"), edge("A", "C")];
    const result = computeParticipantPaths(nodes, edges, ["u1", "u2"]);

    const rootUnresolved = result.unresolved.filter(
      (u) => u.divergence_node_id === "__root__",
    );
    expect(rootUnresolved).toHaveLength(0);
  });

  it("participant assigned to one branch, unresolved at later divergence", () => {
    // A -> B (u1) -> C. C -> D, C -> E. No assignments at C.
    // u1 is resolved at A but unresolved at C.
    const nodes = [
      node("A"),
      node("B", ["u1"]),
      node("X"),
      node("C"),
      node("D"),
      node("E"),
    ];
    const edges = [
      edge("A", "B"),
      edge("A", "X"),
      edge("B", "C"),
      edge("C", "D"),
      edge("C", "E"),
    ];
    const result = computeParticipantPaths(nodes, edges, ["u1"]);

    // u1 follows A -> B -> C, then stops at divergence at C (unresolved)
    expect(result.paths.get("u1")).toEqual(["A", "B", "C"]);
    const u1Unresolved = result.unresolved.filter((u) => u.user_id === "u1");
    expect(u1Unresolved).toHaveLength(1);
    expect(u1Unresolved[0].divergence_node_id).toBe("C");
  });
});

describe("computeEdgeColors", () => {
  it("assigns colors to edges on participant paths", () => {
    const edges = [edge("A", "B"), edge("B", "C"), edge("A", "D")];
    const paths = new Map<string, string[]>();
    paths.set("u1", ["A", "B", "C"]);
    paths.set("u2", ["A", "D"]);

    const colors = computeEdgeColors(edges, paths, ["u1", "u2"]);

    expect(colors.has("A->B")).toBe(true);
    expect(colors.has("B->C")).toBe(true);
    expect(colors.has("A->D")).toBe(true);
  });

  it("multi-root paths produce correct edge colors", () => {
    // A(u1) -> C, B(u2) -> C
    const edges = [edge("A", "C"), edge("B", "C")];
    const paths = new Map<string, string[]>();
    paths.set("u1", ["A", "C"]);
    paths.set("u2", ["B", "C"]);

    const colors = computeEdgeColors(edges, paths, ["u1", "u2"]);

    expect(colors.has("A->C")).toBe(true);
    expect(colors.has("B->C")).toBe(true);
  });

  it("edges not on any path have no color", () => {
    const edges = [edge("A", "B"), edge("X", "Y")];
    const paths = new Map<string, string[]>();
    paths.set("u1", ["A", "B"]);

    const colors = computeEdgeColors(edges, paths, ["u1"]);

    expect(colors.has("A->B")).toBe(true);
    expect(colors.has("X->Y")).toBe(false);
  });
});
