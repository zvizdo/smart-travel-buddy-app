"""Pure cascade computation algorithm for DAG schedule propagation.

Used by both the backend DAGService and the MCP server to propagate
schedule changes downstream through the DAG.
"""

from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta


def parse_dt(value: str | datetime) -> datetime:
    """Parse a datetime value that may be a string or already a datetime."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


def compute_cascade(
    modified_node_id: str,
    departure: datetime,
    all_nodes: list[dict],
    all_edges: list[dict],
) -> dict:
    """Pure cascade computation — no I/O.

    Starting from the modified node's new departure time, computes new
    arrival/departure times for all downstream nodes. Preserves each node's
    stay duration (departure - arrival) when cascading.

    Merge nodes (multiple incoming edges from the affected subgraph) must
    wait for their latest parent to arrive — we use Kahn-style topological
    processing, holding a node back until every one of its in-subgraph
    parents has been resolved, and taking max() across parent arrivals.

    Returns {"affected_nodes": [...], "conflicts": [...]}.
    Each affected node entry: {id, name, old_arrival, new_arrival, old_departure, new_departure}.
    """
    node_map: dict[str, dict] = {n["id"]: n for n in all_nodes}
    adj: dict[str, list[dict]] = defaultdict(list)
    for e in all_edges:
        adj[e["from_node_id"]].append(e)

    # Reachable subgraph from the modified node (children only).
    reachable: set[str] = set()
    stack: list[str] = [modified_node_id]
    while stack:
        node_id = stack.pop()
        for edge in adj.get(node_id, []):
            child_id = edge["to_node_id"]
            if child_id not in reachable:
                reachable.add(child_id)
                stack.append(child_id)

    # In-degree restricted to edges from the reachable subgraph (including
    # the modified node). Nodes reached via other roots keep their original
    # schedule for those edges; we only constrain on parents we cascade from.
    in_deg: dict[str, int] = defaultdict(int)
    for parent_id in {modified_node_id, *reachable}:
        for edge in adj.get(parent_id, []):
            child_id = edge["to_node_id"]
            if child_id in reachable:
                in_deg[child_id] += 1

    pending_arrival: dict[str, datetime] = {}
    remaining: dict[str, int] = dict(in_deg)
    queue: deque[str] = deque()

    for edge in adj.get(modified_node_id, []):
        child_id = edge["to_node_id"]
        travel_hours = edge.get("travel_time_hours", 0)
        candidate = departure + timedelta(hours=travel_hours)
        existing = pending_arrival.get(child_id)
        if existing is None or candidate > existing:
            pending_arrival[child_id] = candidate
        remaining[child_id] -= 1
        if remaining[child_id] == 0:
            queue.append(child_id)

    affected_nodes: list[dict] = []
    conflicts: list[dict] = []

    while queue:
        current_id = queue.popleft()
        current = node_map.get(current_id)
        if current is None:
            continue

        new_arrival = pending_arrival[current_id]
        old_arrival_str = current.get("arrival_time")
        old_arrival = parse_dt(old_arrival_str) if old_arrival_str else None

        # Preserve stay duration (departure - arrival) when cascading.
        old_arrival_dt = old_arrival if old_arrival else new_arrival
        old_departure_str = current.get("departure_time")
        if old_departure_str:
            stay_duration = parse_dt(old_departure_str) - old_arrival_dt
            new_departure = new_arrival + stay_duration
        else:
            new_departure = new_arrival

        schedule_changed = not (
            old_arrival and abs((new_arrival - old_arrival).total_seconds()) < 60
        )
        if schedule_changed:
            affected_nodes.append({
                "id": current_id,
                "name": current.get("name", ""),
                "old_arrival": old_arrival.isoformat() if old_arrival else None,
                "new_arrival": new_arrival.isoformat(),
                "old_departure": current.get("departure_time"),
                "new_departure": new_departure.isoformat(),
            })

        for edge in adj.get(current_id, []):
            child_id = edge["to_node_id"]
            if child_id not in reachable:
                continue
            travel_hours = edge.get("travel_time_hours", 0)
            candidate = new_departure + timedelta(hours=travel_hours)
            existing = pending_arrival.get(child_id)
            if existing is None or candidate > existing:
                pending_arrival[child_id] = candidate
            remaining[child_id] -= 1
            if remaining[child_id] == 0:
                queue.append(child_id)

    return {
        "affected_nodes": affected_nodes,
        "conflicts": conflicts,
    }
