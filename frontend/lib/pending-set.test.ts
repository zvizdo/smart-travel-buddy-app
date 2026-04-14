import { describe, it, expect } from "vitest";
import {
  pruneResolvedPending,
  filterOutPendingNodes,
  filterOutPendingEdges,
} from "./pending-set";

describe("pruneResolvedPending", () => {
  it("returns the same Set reference when nothing pending", () => {
    const empty = new Set<string>();
    const result = pruneResolvedPending(empty, ["a", "b"]);
    expect(result).toBe(empty);
  });

  it("returns the same Set reference when all pending ids still present", () => {
    // Referential stability matters: a new Set would re-trigger downstream
    // useEffect and memo recomputation even when nothing conceptually changed.
    const pending = new Set(["a", "b"]);
    const result = pruneResolvedPending(pending, ["a", "b", "c"]);
    expect(result).toBe(pending);
  });

  it("returns a new Set with resolved ids removed", () => {
    const pending = new Set(["a", "b", "c"]);
    const result = pruneResolvedPending(pending, ["a"]);
    expect(result).not.toBe(pending);
    expect(Array.from(result).sort()).toEqual(["a"]);
    // Input must not be mutated.
    expect(Array.from(pending).sort()).toEqual(["a", "b", "c"]);
  });

  it("handles the case where every pending id has been resolved", () => {
    const pending = new Set(["a", "b"]);
    const result = pruneResolvedPending(pending, []);
    expect(result).not.toBe(pending);
    expect(result.size).toBe(0);
  });
});

describe("filterOutPendingNodes", () => {
  it("returns the original array when pending is empty", () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    expect(filterOutPendingNodes(nodes, new Set())).toBe(nodes);
  });

  it("drops nodes whose id is in the pending set", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = filterOutPendingNodes(nodes, new Set(["b"]));
    expect(result.map((n) => n.id)).toEqual(["a", "c"]);
  });
});

describe("filterOutPendingEdges", () => {
  it("returns the original array when pending is empty", () => {
    const edges = [{ from_node_id: "a", to_node_id: "b" }];
    expect(filterOutPendingEdges(edges, new Set())).toBe(edges);
  });

  it("drops edges whose endpoint is in the pending set (cascading delete mirror)", () => {
    // Mirrors backend cascading delete: when node X is pending-deleted, any
    // edge touching X must vanish too or we leak phantom polylines on the map.
    const edges = [
      { from_node_id: "a", to_node_id: "b" },
      { from_node_id: "b", to_node_id: "c" },
      { from_node_id: "c", to_node_id: "d" },
    ];
    const result = filterOutPendingEdges(edges, new Set(["b"]));
    expect(result).toEqual([{ from_node_id: "c", to_node_id: "d" }]);
  });
});
