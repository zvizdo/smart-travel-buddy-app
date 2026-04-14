"use client";

import { useEffect, useRef, useState } from "react";

export interface MutationOptimistic<TArgs, TSnapshot> {
  apply: (args: TArgs) => TSnapshot;
  rollback: (snapshot: TSnapshot, args: TArgs) => void;
}

export interface UseMutationOptions<TArgs, TData, TSnapshot> {
  mutationFn: (args: TArgs, signal: AbortSignal) => Promise<TData>;
  onSuccess?: (data: TData, args: TArgs) => void;
  onError?: (error: Error, args: TArgs) => void;
  optimistic?: MutationOptimistic<TArgs, TSnapshot>;
  /** Minimum ms isPending stays true. Default 300. 0 disables. */
  minPendingMs?: number;
}

export interface UseMutationResult<TArgs, TData> {
  mutate: (args: TArgs) => Promise<TData | undefined>;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Pure, testable runner for a single mutation. Drives state through setters
 * so both the React hook and tests can exercise it without a renderer.
 */
export interface RunMutationDeps<TArgs, TData, TSnapshot> {
  options: UseMutationOptions<TArgs, TData, TSnapshot>;
  args: TArgs;
  signal: AbortSignal;
  setPending: (pending: boolean) => void;
  setError: (error: Error | null) => void;
  /** Resolves after ms unless signal aborts. Injectable for tests. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runMutation<TArgs, TData, TSnapshot>(
  deps: RunMutationDeps<TArgs, TData, TSnapshot>,
): Promise<TData | undefined> {
  const {
    options,
    args,
    signal,
    setPending,
    setError,
    delay = defaultDelay,
    now = () => Date.now(),
  } = deps;
  const minPendingMs = options.minPendingMs ?? 300;

  let snapshot: TSnapshot | undefined;
  if (options.optimistic) {
    snapshot = options.optimistic.apply(args);
  }

  setPending(true);
  setError(null);
  const startMs = now();

  try {
    const data = await options.mutationFn(args, signal);
    if (signal.aborted) return undefined;
    const elapsed = now() - startMs;
    if (minPendingMs > 0 && elapsed < minPendingMs) {
      await delay(minPendingMs - elapsed, signal);
    }
    if (signal.aborted) return undefined;
    options.onSuccess?.(data, args);
    return data;
  } catch (err) {
    if (signal.aborted) return undefined;
    if (options.optimistic && snapshot !== undefined) {
      options.optimistic.rollback(snapshot, args);
    }
    const error = err instanceof Error ? err : new Error(String(err));
    setError(error);
    options.onError?.(error, args);
    return undefined;
  } finally {
    if (!signal.aborted) setPending(false);
  }
}

export function useMutation<TArgs = void, TData = void, TSnapshot = void>(
  options: UseMutationOptions<TArgs, TData, TSnapshot>,
): UseMutationResult<TArgs, TData> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // `options` is captured by closure on each render — callers pass fresh
  // callbacks every render, which the React Compiler memoizes. `mutate` is
  // not useCallback-wrapped because the Compiler handles that too.
  async function mutate(args: TArgs): Promise<TData | undefined> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    return runMutation<TArgs, TData, TSnapshot>({
      options,
      args,
      signal: controller.signal,
      setPending: (p) => {
        if (!unmountedRef.current) setIsPending(p);
      },
      setError: (e) => {
        if (!unmountedRef.current) setError(e);
      },
    });
  }

  function reset() {
    if (!unmountedRef.current) {
      setError(null);
      setIsPending(false);
    }
  }

  return { mutate, isPending, error, reset };
}
