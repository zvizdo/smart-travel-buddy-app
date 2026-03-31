"""DAG assembly: convert finalized agent notes into Node and Edge instances.

Supports both linear DAGs (flat list of sequential stops) and branching DAGs
where the group splits up and reconvenes. Branch annotations on locations:
- branch_group: label tying parallel branches together
- connects_from_index: array index of the divergence source node
- connects_to_index: array index of the merge target node
- participant_names: optional list of participant names for the branch
"""

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from shared.agent.schemas import ImportNote
from shared.models.edge import Edge, TravelMode
from shared.models.node import LatLng, Node, NodeType
from shared.tools.id_gen import edge_id, node_id
from shared.tools.timezone import resolve_timezone


def _infer_node_type(name: str) -> NodeType:
    """Infer node type from the location name using simple heuristics."""
    lower = name.lower()
    if any(kw in lower for kw in ["hotel", "hostel", "airbnb", "resort", "lodge"]):
        return NodeType.HOTEL
    if any(kw in lower for kw in ["restaurant", "cafe", "bistro", "bar", "diner"]):
        return NodeType.RESTAURANT
    if any(kw in lower for kw in ["hike", "trek", "tour", "surf", "ski", "dive"]):
        return NodeType.ACTIVITY
    if any(kw in lower for kw in ["museum", "park", "beach", "temple", "church", "market"]):
        return NodeType.PLACE
    return NodeType.CITY


def _infer_travel_mode(distance_km: float | None) -> TravelMode:
    """Infer travel mode from distance."""
    if distance_km is None:
        return TravelMode.DRIVE
    if distance_km > 800:
        return TravelMode.FLIGHT
    if distance_km < 3:
        return TravelMode.WALK
    return TravelMode.DRIVE


def _get(loc: dict, key: str, default: float) -> float:
    """Get a numeric value from loc, treating None the same as missing."""
    val = loc.get(key)
    return val if val is not None else default


def _create_node(
    loc: dict,
    arrival_time: datetime,
    order_index: int,
    created_by: str,
    now: datetime,
) -> Node:
    """Create a Node from a location dict."""
    duration_hours = _get(loc, "duration_hours", 24)
    return Node(
        id=node_id(),
        name=loc["name"],
        type=_infer_node_type(loc["name"]),
        lat_lng=LatLng(lat=loc["lat"], lng=loc["lng"]),
        arrival_time=arrival_time,
        departure_time=arrival_time + timedelta(hours=duration_hours),
        timezone=resolve_timezone(loc["lat"], loc["lng"]),
        participant_ids=None,
        order_index=order_index,
        place_id=loc.get("place_id"),
        created_by=created_by,
        created_at=now,
        updated_at=now,
    )


def _create_edge(from_node: Node, to_node: Node, loc: dict) -> Edge:
    """Create an Edge between two nodes using the location's travel data."""
    travel_time = _get(loc, "travel_time_hours", 0)
    distance_km = loc.get("distance_km")
    return Edge(
        id=edge_id(),
        from_node_id=from_node.id,
        to_node_id=to_node.id,
        travel_mode=_infer_travel_mode(distance_km),
        travel_time_hours=travel_time,
        distance_km=distance_km,
    )


def _handle_circular_route(locations: list[dict]) -> list[dict]:
    """Detect and handle return-to-origin routes.

    If the last spine location shares a name with the first spine location,
    rename it with a ' (return)' suffix to create a distinct A' node and
    preserve the acyclic DAG property.
    """
    if len(locations) < 2:
        return locations

    # Only compare spine locations (no branch_group)
    spine = [loc for loc in locations if not loc.get("branch_group")]
    if len(spine) < 2:
        return locations

    first_name = spine[0].get("name", "").lower().strip()
    last_name = spine[-1].get("name", "").lower().strip()

    if first_name and first_name == last_name:
        # Make a copy so we don't mutate the input
        locations = [dict(loc) for loc in locations]
        # Find and rename the last spine location in the full list
        last_spine_loc = spine[-1]
        for i in range(len(locations) - 1, -1, -1):
            if locations[i] is last_spine_loc or (
                locations[i].get("name", "").lower().strip() == last_name
                and not locations[i].get("branch_group")
                and i > 0
            ):
                locations[i] = dict(locations[i])
                locations[i]["name"] = f"{locations[i]['name']} (return)"
                break

    return locations


class AssemblyResult:
    """Result of DAG assembly from agent notes and geocoded locations."""

    def __init__(self, nodes: list[Node], edges: list[Edge]):
        self.nodes = nodes
        self.edges = edges


def assemble_dag(
    notes: list[ImportNote],
    geocoded_locations: list[dict],
    created_by: str,
    start_date: datetime | None = None,
) -> AssemblyResult:
    """Convert finalized notes and geocoded locations into a DAG (nodes + edges).

    Args:
        notes: The categorized notes from the agent conversation.
        geocoded_locations: List of dicts with keys: name, lat, lng, place_id,
            duration_hours, travel_time_hours, distance_km. Branch locations
            additionally have: branch_group, connects_from_index, connects_to_index,
            participant_names.
        created_by: User ID of the trip creator.
        start_date: Optional start date for the trip. Defaults to tomorrow.

    Returns:
        AssemblyResult with nodes and edges forming a DAG (linear or branching).
    """
    if not geocoded_locations:
        return AssemblyResult(nodes=[], edges=[])

    # Handle circular routes: if last location matches first, rename to "Name (return)"
    # to preserve acyclic DAG property
    geocoded_locations = _handle_circular_route(geocoded_locations)

    if start_date is None:
        start_date = datetime.now(UTC).replace(
            hour=10, minute=0, second=0, microsecond=0
        ) + timedelta(days=1)

    now = datetime.now(UTC)

    # Phase 1: Partition into spine (linear) locations and branch groups
    spine_entries: list[tuple[int, dict]] = []  # (original_index, loc)
    branch_groups: dict[str, list[tuple[int, dict]]] = defaultdict(list)

    for i, loc in enumerate(geocoded_locations):
        if loc.get("branch_group"):
            branch_groups[loc["branch_group"]].append((i, loc))
        else:
            spine_entries.append((i, loc))

    # Phase 2: Build spine nodes sequentially
    index_to_node: dict[int, Node] = {}
    nodes: list[Node] = []
    current_time = start_date

    for orig_idx, loc in spine_entries:
        node = _create_node(loc, current_time, len(nodes), created_by, now)
        nodes.append(node)
        index_to_node[orig_idx] = node
        current_time = node.departure_time + timedelta(
            hours=_get(loc, "travel_time_hours", 0)
        )

    # Phase 3: Determine which spine edges to skip (replaced by branch groups)
    branch_spans: set[tuple[int, int]] = set()
    for group_locs in branch_groups.values():
        from_idx = _resolve_from_index(group_locs, spine_entries)
        to_idx = _resolve_to_index(group_locs, spine_entries)
        if from_idx is not None and to_idx is not None:
            branch_spans.add((from_idx, to_idx))

    edges: list[Edge] = []
    for i in range(len(spine_entries) - 1):
        curr_idx = spine_entries[i][0]
        next_idx = spine_entries[i + 1][0]
        if (curr_idx, next_idx) in branch_spans:
            continue
        edges.append(_create_edge(index_to_node[curr_idx], index_to_node[next_idx], spine_entries[i][1]))

    # Phase 4: Create branch nodes and wire divergence/merge edges
    for group_locs in branch_groups.values():
        from_idx = _resolve_from_index(group_locs, spine_entries)
        to_idx = _resolve_to_index(group_locs, spine_entries)
        source_node = index_to_node.get(from_idx) if from_idx is not None else None
        merge_node = index_to_node.get(to_idx) if to_idx is not None else None

        branch_arrival_base = source_node.departure_time if source_node else current_time

        for orig_idx, loc in group_locs:
            travel_hours = _get(loc, "travel_time_hours", 0)
            branch_arrival = branch_arrival_base + timedelta(hours=travel_hours)
            node = _create_node(loc, branch_arrival, len(nodes), created_by, now)
            nodes.append(node)
            index_to_node[orig_idx] = node

            # Edge from divergence source to branch node
            if source_node:
                edges.append(_create_edge(source_node, node, loc))

            # Edge from branch node to merge target
            if merge_node:
                edges.append(Edge(
                    id=edge_id(),
                    from_node_id=node.id,
                    to_node_id=merge_node.id,
                    travel_mode=_infer_travel_mode(None),
                    travel_time_hours=0,
                    distance_km=None,
                ))

        # Adjust merge node arrival to the latest branch departure
        if merge_node and group_locs:
            latest_departure = max(
                (index_to_node[idx].departure_time for idx, _ in group_locs
                 if idx in index_to_node and index_to_node[idx].departure_time),
                default=None,
            )
            if latest_departure and latest_departure > merge_node.arrival_time:
                duration = merge_node.departure_time - merge_node.arrival_time
                merge_node.arrival_time = latest_departure
                merge_node.departure_time = latest_departure + duration

    return AssemblyResult(nodes=nodes, edges=edges)


def _resolve_from_index(
    group_locs: list[tuple[int, dict]],
    spine_entries: list[tuple[int, dict]],
) -> int | None:
    """Resolve the divergence source index for a branch group.

    Resolution order:
    1. Name-based: connects_from (stop name string)
    2. Index-based: connects_from_index (integer)
    3. Positional heuristic: last spine node before the first branch in array
    """
    first_loc = group_locs[0][1]

    # 1. Name-based resolution
    name_ref = first_loc.get("connects_from")
    if name_ref:
        for orig_idx, loc in spine_entries:
            if loc["name"].lower().strip() == name_ref.lower().strip():
                return orig_idx

    # 2. Index-based resolution
    explicit = first_loc.get("connects_from_index")
    if explicit is not None:
        return explicit

    # 3. Positional heuristic
    first_branch_idx = min(idx for idx, _ in group_locs)
    for orig_idx, _ in reversed(spine_entries):
        if orig_idx < first_branch_idx:
            return orig_idx
    return None


def _resolve_to_index(
    group_locs: list[tuple[int, dict]],
    spine_entries: list[tuple[int, dict]],
) -> int | None:
    """Resolve the merge target index for a branch group.

    Resolution order:
    1. Name-based: connects_to (stop name string)
    2. Index-based: connects_to_index (integer)
    3. Positional heuristic: first spine node after the last branch in array
    """
    first_loc = group_locs[0][1]

    # 1. Name-based resolution
    name_ref = first_loc.get("connects_to")
    if name_ref:
        for orig_idx, loc in spine_entries:
            if loc["name"].lower().strip() == name_ref.lower().strip():
                return orig_idx

    # 2. Index-based resolution
    explicit = first_loc.get("connects_to_index")
    if explicit is not None:
        return explicit

    # 3. Positional heuristic
    last_branch_idx = max(idx for idx, _ in group_locs)
    for orig_idx, _ in spine_entries:
        if orig_idx > last_branch_idx:
            return orig_idx
    return None
