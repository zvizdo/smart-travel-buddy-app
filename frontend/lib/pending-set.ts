/**
 * Drop ids from a "pending" Set that no longer appear in a server-confirmed
 * collection. Returns the SAME Set reference when no ids need to be cleared,
 * so React `useEffect` / memo consumers don't trigger spurious re-renders.
 *
 * Used by the optimistic-delete pattern: when the Firestore snapshot stops
 * including an id we had marked pending, we drop it from the pending set.
 */
export function pruneResolvedPending(
  pending: Set<string>,
  presentIds: Iterable<string>,
): Set<string> {
  if (pending.size === 0) return pending;
  const present = new Set(presentIds);
  let changed = false;
  const next = new Set(pending);
  for (const id of pending) {
    if (!present.has(id)) {
      next.delete(id);
      changed = true;
    }
  }
  return changed ? next : pending;
}

export function filterOutPendingNodes<T extends { id: string }>(
  nodes: T[],
  pending: Set<string>,
): T[] {
  return pending.size === 0 ? nodes : nodes.filter((n) => !pending.has(n.id));
}

export function filterOutPendingEdges<
  T extends { from_node_id: string; to_node_id: string },
>(edges: T[], pending: Set<string>): T[] {
  return pending.size === 0
    ? edges
    : edges.filter(
        (e) => !pending.has(e.from_node_id) && !pending.has(e.to_node_id),
      );
}
