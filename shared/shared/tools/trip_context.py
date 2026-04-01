"""Shared trip context formatter for agent consumption.

Produces a markdown-formatted summary of the current trip DAG state.
Used by both the in-app Gemini agent and the MCP server.
"""

from datetime import datetime
from zoneinfo import ZoneInfo


def _format_dt(raw: str | None, tz_str: str | None) -> str | None:
    """Convert a stored datetime string to local time with timezone label."""
    if not raw:
        return None
    tz = ZoneInfo(tz_str) if tz_str else None
    if not tz:
        return raw
    try:
        dt = datetime.fromisoformat(raw) if isinstance(raw, str) else raw
        return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M %Z")
    except (ValueError, TypeError):
        return raw


def format_trip_context(
    nodes: list[dict],
    edges: list[dict],
    preferences: list[dict] | None = None,
    participants: dict | None = None,
    paths: dict | None = None,
    locations: list[dict] | None = None,
    plan_name: str | None = None,
    plan_id: str | None = None,
    plan_status: str | None = None,
) -> str:
    """Format the trip DAG state as a markdown string for agent consumption.

    Args:
        nodes: List of node dicts (must include id, name, type, order_index, timezone, etc.)
        edges: List of edge dicts (must include id, from_node_id, to_node_id, etc.)
        preferences: Optional travel preferences (category + content).
        participants: Optional dict of uid -> {display_name, role}.
        paths: Optional dict of uid -> list of node names.
        locations: Optional list of participant location descriptions.
        plan_name: Optional plan name for the header.
        plan_id: Optional plan ID for the header.
        plan_status: Optional plan status for the header.
    """
    lines: list[str] = []
    node_map = {n["id"]: n for n in nodes}

    # Plan header
    if plan_name or plan_id:
        header_parts = []
        if plan_name:
            header_parts.append(plan_name)
        if plan_id:
            header_parts.append(f"plan_id: {plan_id}")
        if plan_status:
            header_parts.append(f"status: {plan_status}")
        lines.append(f"# {' — '.join(header_parts)}")

    # Participants
    if participants:
        lines.append(f"\n## Participants ({len(participants)})")
        for uid, p in participants.items():
            lines.append(f"- {p.get('display_name', uid)} (user_id: {uid}, role: {p.get('role', 'viewer')})")

    # Nodes sorted by order_index
    sorted_nodes = sorted(nodes, key=lambda n: n.get("order_index", 0))
    lines.append(f"\n## Stops ({len(sorted_nodes)} nodes)")
    for n in sorted_nodes:
        tz = n.get("timezone")
        time_info = ""
        arrival = _format_dt(n.get("arrival_time"), tz)
        if arrival:
            time_info = f", arrives: {arrival}"
        departure = _format_dt(n.get("departure_time"), tz)
        if departure:
            time_info += f", departs: {departure}"

        duration = n.get("duration_hours")
        if duration:
            time_info += f", duration: {duration}h"

        tz_str = f", tz: {tz}" if tz else ""

        pids = n.get("participant_ids")
        participant_info = ""
        # if pids:
        #     participant_info = f" [assigned to: {', '.join(pids)}]"

        lines.append(
            f"- [{n['id']}] {n['name']} ({n.get('type', 'place')}"
            f"{tz_str}{time_info}){participant_info}"
        )

        # Actions attached to nodes (MCP enriched format)
        for a in n.get("actions", []):
            action_id_str = f"id: {a['id']}, " if a.get("id") else ""
            lines.append(
                f"  - [{a['type']}, {action_id_str}by: {a.get('created_by', '?')}] "
                f"{a['content']}"
            )

    # Edges
    lines.append(f"\n## Connections ({len(edges)} edges)")
    for e in edges:
        from_name = e.get("from") or node_map.get(e["from_node_id"], {}).get("name", e["from_node_id"])
        to_name = e.get("to") or node_map.get(e["to_node_id"], {}).get("name", e["to_node_id"])
        mode = e.get("travel_mode", "?")
        time_h = e.get("travel_time_hours")
        time_str = f"{time_h:.1f}h" if time_h else "?"
        dist = e.get("distance_km")
        dist_str = f", {dist:.0f}km" if dist else ""
        edge_id = e.get("id", "?")
        lines.append(
            f"- [{edge_id}] {from_name} -> {to_name} ({mode}, {time_str}{dist_str})"
        )

    # Preferences
    if preferences:
        lines.append(f"\n## Travel Preferences ({len(preferences)})")
        for p in preferences:
            lines.append(f"- [{p.get('category', 'general')}] {p.get('content', '')}")

    # Paths
    if paths:
        lines.append("\n## Participant Paths")
        for uid, path_names in paths.items():
            lines.append(f"- {uid}: {' -> '.join(path_names)}")

    # Locations
    # if locations:
    #     lines.append("\n## Participant Locations")
    #     for loc in locations:
    #         lines.append(
    #             f"- {loc['user_name']}: {loc['description']} "
    #             f"(as of {loc.get('updated_at', 'unknown')})"
    #         )

    return "\n".join(lines)
