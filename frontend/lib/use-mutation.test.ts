import { describe, it, expect, vi } from "vitest";
import { runMutation } from "./use-mutation";

function harness() {
  const pending: boolean[] = [];
  const errors: (Error | null)[] = [];
  return {
    pending,
    errors,
    setPending: (p: boolean) => pending.push(p),
    setError: (e: Error | null) => errors.push(e),
  };
}

// Deterministic "delay" that records the requested wait but resolves immediately.
// Lets tests verify the min-pending gate is invoked without real timers.
function fakeDelay() {
  const calls: number[] = [];
  return {
    calls,
    delay: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

describe("runMutation", () => {
  it("awaits mutationFn, fires onSuccess, flips pending true→false, returns data", async () => {
    const h = harness();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const result = await runMutation({
      options: {
        mutationFn: async () => "ok",
        onSuccess,
        onError,
        minPendingMs: 0,
      },
      args: undefined,
      signal: new AbortController().signal,
      ...h,
    });
    expect(result).toBe("ok");
    expect(onSuccess).toHaveBeenCalledWith("ok", undefined);
    expect(onError).not.toHaveBeenCalled();
    expect(h.pending).toEqual([true, false]);
    expect(h.errors).toEqual([null]);
  });

  it("holds pending for minPendingMs when the mutation resolves faster", async () => {
    const h = harness();
    const fd = fakeDelay();
    let elapsedNow = 0;
    const now = () => elapsedNow;
    // Mutation "finishes" at t=50ms — min-pending gate should request a 250ms delay.
    const result = await runMutation({
      options: {
        mutationFn: async () => {
          elapsedNow = 50;
          return 1;
        },
        minPendingMs: 300,
      },
      args: undefined,
      signal: new AbortController().signal,
      delay: fd.delay,
      now,
      ...h,
    });
    expect(result).toBe(1);
    expect(fd.calls).toEqual([250]);
    expect(h.pending).toEqual([true, false]);
  });

  it("does NOT delay when the mutation already exceeded minPendingMs", async () => {
    const h = harness();
    const fd = fakeDelay();
    let elapsedNow = 0;
    const result = await runMutation({
      options: {
        mutationFn: async () => {
          elapsedNow = 500;
          return 1;
        },
        minPendingMs: 300,
      },
      args: undefined,
      signal: new AbortController().signal,
      delay: fd.delay,
      now: () => elapsedNow,
      ...h,
    });
    expect(result).toBe(1);
    expect(fd.calls).toEqual([]);
  });

  it("rolls back optimistic updates and calls onError on mutation failure", async () => {
    const h = harness();
    const applied: string[] = [];
    const rolledBack: string[] = [];
    const boom = new Error("boom");
    const onError = vi.fn();

    const result = await runMutation({
      options: {
        mutationFn: async () => {
          throw boom;
        },
        optimistic: {
          apply: (arg: string) => {
            applied.push(arg);
            return { prev: arg };
          },
          rollback: (snapshot, arg) => {
            expect(snapshot).toEqual({ prev: arg });
            rolledBack.push(arg);
          },
        },
        onError,
        minPendingMs: 0,
      },
      args: "node-1",
      signal: new AbortController().signal,
      ...h,
    });
    expect(result).toBeUndefined();
    expect(applied).toEqual(["node-1"]);
    expect(rolledBack).toEqual(["node-1"]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe(boom);
    expect(h.errors).toEqual([null, boom]);
    expect(h.pending).toEqual([true, false]);
  });

  it("wraps non-Error thrown values into Error", async () => {
    const h = harness();
    const onError = vi.fn();
    await runMutation({
      options: {
        mutationFn: async () => {
          throw "nope";
        },
        onError,
        minPendingMs: 0,
      },
      args: undefined,
      signal: new AbortController().signal,
      ...h,
    });
    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("nope");
  });

  it("does not roll back or call onError when signal aborts mid-flight", async () => {
    const h = harness();
    const controller = new AbortController();
    const onError = vi.fn();
    const rollback = vi.fn();

    const result = await runMutation({
      options: {
        mutationFn: async () => {
          controller.abort();
          throw new Error("cancelled");
        },
        optimistic: {
          apply: () => ({}),
          rollback,
        },
        onError,
        minPendingMs: 0,
      },
      args: undefined,
      signal: controller.signal,
      ...h,
    });
    expect(result).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    // Pending was set true; the finally block skips setPending(false) once aborted
    // so the React hook's cleanup path doesn't fight with a new mutation that
    // replaced this one.
    expect(h.pending).toEqual([true]);
  });

  it("does not call onSuccess when signal aborts before response settles", async () => {
    const h = harness();
    const controller = new AbortController();
    const onSuccess = vi.fn();
    const result = await runMutation({
      options: {
        mutationFn: async () => {
          controller.abort();
          return "late";
        },
        onSuccess,
        minPendingMs: 0,
      },
      args: undefined,
      signal: controller.signal,
      ...h,
    });
    expect(result).toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("passes the AbortSignal to mutationFn", async () => {
    const h = harness();
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    await runMutation({
      options: {
        mutationFn: async (_args, signal) => {
          seen.push(signal);
          return undefined;
        },
        minPendingMs: 0,
      },
      args: undefined,
      signal: controller.signal,
      ...h,
    });
    expect(seen).toEqual([controller.signal]);
  });
});
