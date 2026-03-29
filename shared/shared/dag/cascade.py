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
    """Pure BFS cascade computation — no I/O.

    Starting from the modified node's new departure time, computes new
    arrival/departure times for all downstream nodes. Preserves each node's
    stay duration (departure - arrival) when cascading.

    Returns {"affected_nodes": [...], "conflicts": [...]}.
    Each affected node entry: {id, name, old_arrival, new_arrival, old_departure, new_departure}.
    """
    node_map: dict[str, dict] = {n["id"]: n for n in all_nodes}
    adj: dict[str, list[dict]] = defaultdict(list)
    for e in all_edges:
        adj[e["from_node_id"]].append(e)

    affected_nodes: list[dict] = []
    conflicts: list[dict] = []

    queue: deque[str] = deque()
    parent_departure: dict[str, datetime] = {}

    for edge in adj.get(modified_node_id, []):
        child_id = edge["to_node_id"]
        travel_hours = edge.get("travel_time_hours", 0)
        new_arrival = departure + timedelta(hours=travel_hours)
        parent_departure[child_id] = new_arrival
        queue.append(child_id)

    visited: set[str] = set()
    while queue:
        current_id = queue.popleft()
        if current_id in visited:
            continue
        visited.add(current_id)

        current = node_map.get(current_id)
        if current is None:
            continue

        new_arrival = parent_departure[current_id]
        old_arrival_str = current.get("arrival_time")
        old_arrival = parse_dt(old_arrival_str) if old_arrival_str else None

        if old_arrival and abs((new_arrival - old_arrival).total_seconds()) < 60:
            continue

        # Preserve the node's stay duration (departure - arrival) when cascading
        old_arrival_dt = parse_dt(old_arrival_str) if old_arrival_str else new_arrival
        old_departure_str = current.get("departure_time")
        if old_departure_str:
            stay_duration = parse_dt(old_departure_str) - old_arrival_dt
            new_departure = new_arrival + stay_duration
        else:
            new_departure = new_arrival

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
            if child_id not in visited:
                travel_hours = edge.get("travel_time_hours", 0)
                child_arrival = new_departure + timedelta(hours=travel_hours)
                parent_departure[child_id] = child_arrival
                queue.append(child_id)

    return {
        "affected_nodes": affected_nodes,
        "conflicts": conflicts,
    }
