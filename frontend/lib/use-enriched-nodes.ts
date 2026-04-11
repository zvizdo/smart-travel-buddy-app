"use client";

import { useMemo } from "react";
import type { DocumentData } from "firebase/firestore";
import { useTripNodes, useTripEdges } from "@/lib/firestore-hooks";
import {
  enrichDagTimes,
  type EnrichedNode,
  type RawEdge,
  type RawNode,
  type TripSettingsLike,
} from "@/lib/time-inference";

interface UseEnrichedNodesResult {
  nodes: EnrichedNode[];
  edges: DocumentData[];
  loading: boolean;
  error: Error | null;
}

/**
 * Live enriched view of a plan's nodes + edges.
 *
 * Subscribes to `useTripNodes` and `useTripEdges`, then runs the pure
 * `enrichDagTimes` pass on every snapshot. The output is memoized on the
 * identity of `(nodes, edges, tripSettings)` so consumers with a stable
 * list don't re-enrich on unrelated re-renders.
 *
 * Trip settings are taken directly from the trip doc — pass whatever
 * `useTrip(tripId).data?.settings` returns (null is fine; enrichment
 * falls back to sensible defaults).
 */
export function useEnrichedNodes(
  tripId: string | null,
  planId: string | null,
  tripSettings: TripSettingsLike | null | undefined,
): UseEnrichedNodesResult {
  const { data: rawNodes, loading: nodesLoading, error: nodesError } = useTripNodes(
    tripId,
    planId,
  );
  const { data: rawEdges, loading: edgesLoading, error: edgesError } = useTripEdges(
    tripId,
    planId,
  );

  const enriched = useMemo(
    () =>
      enrichDagTimes(
        rawNodes as unknown as RawNode[],
        rawEdges as unknown as RawEdge[],
        tripSettings,
      ),
    [rawNodes, rawEdges, tripSettings],
  );

  return {
    nodes: enriched,
    edges: rawEdges,
    loading: nodesLoading || edgesLoading,
    error: nodesError ?? edgesError,
  };
}
