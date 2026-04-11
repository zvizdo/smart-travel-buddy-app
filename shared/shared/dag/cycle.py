"""Cycle detection for DAG integrity.

Pure function — no I/O. Builds an in-memory adjacency list and uses
iterative DFS with gray-set detection to find cycles.
"""

from collections import defaultdict


class CycleDetectedError(Exception):
    """Raised when adding edges would create a cycle in the DAG."""

    def __init__(self, cycle_path: list[str]):
        self.cycle_path = cycle_path
        super().__init__(f"Cycle detected: {' -> '.join(cycle_path)}")


def detect_cycle(
    existing_edges: list[dict],
    new_node_id: str,
    incoming_node_ids: list[str],
    outgoing_node_ids: list[str],
) -> list[str] | None:
    """Check if adding a node with given connections would create a cycle.

    Args:
        existing_edges: List of edge dicts with ``from_node_id`` and ``to_node_id``.
        new_node_id: ID of the node being added.
        incoming_node_ids: Nodes that will have edges TO the new node.
        outgoing_node_ids: Nodes that will have edges FROM the new node.

    Returns:
        The cycle path as a list of node IDs if a cycle would be created,
        or ``None`` if the graph remains acyclic.
    """
    # Build adjacency list from existing edges + proposed new edges
    adj: dict[str, list[str]] = defaultdict(list)
    all_nodes: set[str] = set()

    for edge in existing_edges:
        src = edge["from_node_id"]
        dst = edge["to_node_id"]
        adj[src].append(dst)
        all_nodes.add(src)
        all_nodes.add(dst)

    # Add proposed edges
    all_nodes.add(new_node_id)
    for from_id in incoming_node_ids:
        adj[from_id].append(new_node_id)
        all_nodes.add(from_id)
    for to_id in outgoing_node_ids:
        adj[new_node_id].append(to_id)
        all_nodes.add(to_id)

    # Iterative DFS with three-color marking (white/gray/black)
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {n: WHITE for n in all_nodes}
    parent: dict[str, str | None] = {n: None for n in all_nodes}

    for start in all_nodes:
        if color[start] != WHITE:
            continue

        stack: list[tuple[str, int]] = [(start, 0)]
        while stack:
            node, child_idx = stack.pop()

            if child_idx == 0:
                color[node] = GRAY

            children = adj.get(node, [])
            if child_idx < len(children):
                # Push current node back with next child index
                stack.append((node, child_idx + 1))
                child = children[child_idx]

                if color[child] == GRAY:
                    # Found a cycle — reconstruct path
                    cycle = [child, node]
                    p = parent.get(node)
                    while p is not None and p != child:
                        cycle.append(p)
                        p = parent.get(p)
                    cycle.append(child)
                    cycle.reverse()
                    return cycle
                elif color[child] == WHITE:
                    parent[child] = node
                    stack.append((child, 0))
            else:
                color[node] = BLACK

    return None


def would_create_cycle(
    from_node_id: str,
    to_node_id: str,
    existing_edges: list[dict],
) -> list[str] | None:
    """Check if adding an edge from_node -> to_node would create a cycle.

    Returns the cycle path if the edge would create a cycle, or None if safe.
    A cycle exists when to_node can already reach from_node via existing edges
    (adding from -> to would close the loop), or when from_node == to_node
    (self-loop).
    """
    if from_node_id == to_node_id:
        return [from_node_id, from_node_id]

    descendants = get_descendants(to_node_id, existing_edges)
    if from_node_id in descendants:
        # Reconstruct a readable cycle path: from -> ... -> to -> from
        # Use BFS to find the shortest path from to_node back to from_node
        from collections import deque

        adj: dict[str, list[str]] = defaultdict(list)
        for edge in existing_edges:
            adj[edge["from_node_id"]].append(edge["to_node_id"])

        parent: dict[str, str | None] = {to_node_id: None}
        queue = deque([to_node_id])
        while queue:
            current = queue.popleft()
            if current == from_node_id:
                break
            for child in adj.get(current, []):
                if child not in parent:
                    parent[child] = current
                    queue.append(child)

        # Reconstruct path: to_node -> ... -> from_node, then prepend from_node
        path = [from_node_id]
        node = from_node_id
        while node != to_node_id:
            node = parent[node]
            path.append(node)
        path.reverse()
        # path is now: to_node -> ... -> from_node
        # The full cycle is: from_node -> to_node -> ... -> from_node
        return [from_node_id, *path]

    return None


def get_ancestors(
    node_id: str,
    edges: list[dict],
) -> set[str]:
    """Return all ancestor node IDs reachable by following edges backwards."""
    reverse_adj: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        reverse_adj[edge["to_node_id"]].append(edge["from_node_id"])

    visited: set[str] = set()
    stack = [node_id]
    while stack:
        current = stack.pop()
        for parent in reverse_adj.get(current, []):
            if parent not in visited:
                visited.add(parent)
                stack.append(parent)
    return visited


def get_descendants(
    node_id: str,
    edges: list[dict],
) -> set[str]:
    """Return all descendant node IDs reachable by following edges forward."""
    adj: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        adj[edge["from_node_id"]].append(edge["to_node_id"])

    visited: set[str] = set()
    stack = [node_id]
    while stack:
        current = stack.pop()
        for child in adj.get(current, []):
            if child not in visited:
                visited.add(child)
                stack.append(child)
    return visited
