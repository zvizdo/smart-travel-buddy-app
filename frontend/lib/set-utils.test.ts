import { describe, it, expect } from "vitest";
import { setsEqual } from "./set-utils";

describe("setsEqual", () => {
  it("returns true for identical references", () => {
    const a = new Set([1, 2, 3]);
    expect(setsEqual(a, a)).toBe(true);
  });

  it("returns true for two empty sets", () => {
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });

  it("returns true for sets with same members regardless of insertion order", () => {
    expect(setsEqual(new Set([1, 2, 3]), new Set([3, 1, 2]))).toBe(true);
    expect(setsEqual(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
  });

  it("returns false for different sizes", () => {
    expect(setsEqual(new Set([1, 2]), new Set([1, 2, 3]))).toBe(false);
  });

  it("returns false for same size but different members", () => {
    expect(setsEqual(new Set([1, 2, 3]), new Set([1, 2, 4]))).toBe(false);
  });

  it("treats null and undefined as equal (both nullish)", () => {
    expect(setsEqual(null, null)).toBe(true);
    expect(setsEqual(undefined, undefined)).toBe(true);
    expect(setsEqual(null, undefined)).toBe(true);
  });

  it("returns false when one side is nullish and the other is a set", () => {
    expect(setsEqual(null, new Set([1]))).toBe(false);
    expect(setsEqual(new Set([1]), null)).toBe(false);
    expect(setsEqual(undefined, new Set())).toBe(false);
  });

  // Regression: the path-filter refit in trip-map.tsx used to inline a
  // 25-line null-and-membership check. Replacing it with setsEqual must
  // preserve the "null sentinel means skip first run" behavior used by
  // prevMyNodeIdsRef: when the ref is undefined we want to return early,
  // not match against a real Set.
  it("distinguishes undefined ref sentinel from an empty set", () => {
    const prev: Set<string> | undefined = undefined;
    const current = new Set<string>();
    // Both are "no members", but we want the sentinel vs value distinction
    // to survive — that's why setsEqual(undefined, emptySet) returns false.
    expect(setsEqual(prev, current)).toBe(false);
  });

  it("handles sets of objects by reference identity", () => {
    const obj = { id: 1 };
    expect(setsEqual(new Set([obj]), new Set([obj]))).toBe(true);
    expect(setsEqual(new Set([{ id: 1 }]), new Set([{ id: 1 }]))).toBe(false);
  });
});
