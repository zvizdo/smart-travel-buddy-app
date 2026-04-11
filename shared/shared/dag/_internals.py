"""Internal helpers shared between DAG algorithms.

These are pure functions with no I/O, used by ``time_inference`` and other
modules that need to walk a DAG. Keeping them in one place avoids drift
between ``paths.py`` and the enrichment code.
"""

from collections import defaultdict, deque
from datetime import UTC, datetime


def parse_dt(value: str | datetime | None) -> datetime | None:
    """Parse a datetime value that may be a string, datetime, or None.

    Returns None when the input is None or an empty string so callers can
    safely distinguish "unset" from "set to UTC epoch". Naive datetimes are
    assumed to be UTC.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        if not value:
            return None
        dt = datetime.fromisoformat(value)
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)
    raise TypeError(f"Cannot parse datetime from {type(value).__name__}")


def build_adjacency(
    edges: list[dict],
) -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """Build forward and reverse adjacency lists keyed by node id.

    Unlike ``paths.build_adjacency`` this returns the full edge dicts on each
    side so callers can access ``travel_time_hours`` and ``travel_mode``
    without re-joining.
    """
    forward: dict[str, list[dict]] = defaultdict(list)
    reverse: dict[str, list[dict]] = defaultdict(list)
    for edge in edges:
        forward[edge["from_node_id"]].append(edge)
        reverse[edge["to_node_id"]].append(edge)
    return dict(forward), dict(reverse)


def toposort(
    nodes: list[dict],
    forward_adj: dict[str, list[dict]],
    reverse_adj: dict[str, list[dict]],
) -> list[str] | None:
    """Return node ids in topological order, or None if the graph has a cycle.

    Uses Kahn's algorithm over node ids. Nodes with no incoming edges are
    emitted first; ties are broken by input order so the result is
    deterministic for a given node list.
    """
    in_degree: dict[str, int] = {n["id"]: 0 for n in nodes}
    for node_id, incoming in reverse_adj.items():
        if node_id in in_degree:
            in_degree[node_id] = len(incoming)

    queue: deque[str] = deque(n["id"] for n in nodes if in_degree[n["id"]] == 0)
    order: list[str] = []
    remaining = dict(in_degree)

    while queue:
        node_id = queue.popleft()
        order.append(node_id)
        for edge in forward_adj.get(node_id, []):
            child_id = edge["to_node_id"]
            if child_id not in remaining:
                continue
            remaining[child_id] -= 1
            if remaining[child_id] == 0:
                queue.append(child_id)

    if len(order) != len(nodes):
        return None
    return order
