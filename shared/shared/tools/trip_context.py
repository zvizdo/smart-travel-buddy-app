"""Shared trip context formatter for agent consumption.

Produces a markdown-formatted summary of the current trip DAG state.
Used by both the in-app Gemini agent and the MCP server.

``build_agent_trip_context`` is the high-level entry point that runs the
read-time enrichment pass first (so the agent sees the same propagated /
estimated times the user's map does) and then calls the low-level
``format_trip_context`` renderer.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from shared.dag._internals import build_adjacency, toposort
from shared.dag.time_inference import enrich_dag_times


def _node_coords(n: dict) -> tuple[float, float] | None:
    """Extract lat/lng from a node dict, tolerating both flat and nested shapes."""
    if n.get("lat") is not None and n.get("lng") is not None:
        return n["lat"], n["lng"]
    ll = n.get("lat_lng")
    if isinstance(ll, dict) and ll.get("lat") is not None and ll.get("lng") is not None:
        return ll["lat"], ll["lng"]
    return None


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


def build_agent_trip_context(
    nodes: list[dict],
    edges: list[dict],
    trip_settings: dict | None = None,
    **format_kwargs,
) -> str:
    """Run enrichment over the DAG then format it for the agent.

    The enrichment pass fills arrival/departure/duration + estimation flags,
    overnight-hold reasons, and timing conflicts so the formatter can render
    the same signals the UI does. ``trip_settings`` is passed through to the
    enrichment rules (``no_drive_window``, ``max_drive_hours_per_day``).
    """
    enriched = enrich_dag_times(nodes, edges, trip_settings or {})
    return format_trip_context(
        enriched,
        edges,
        trip_settings=trip_settings,
        **format_kwargs,
    )


def _format_timing_rules(trip_settings: dict | None) -> list[str]:
    if not trip_settings:
        return []
    lines: list[str] = []
    window = trip_settings.get("no_drive_window")
    if window:
        start = window.get("start_hour")
        end = window.get("end_hour")
        if start is not None and end is not None:
            lines.append(f"- No-drive window: {start:02d}:00 → {end:02d}:00 (local)")
    elif window is None and "no_drive_window" in trip_settings:
        lines.append("- No-drive window: disabled")
    max_hours = trip_settings.get("max_drive_hours_per_day")
    if max_hours is not None:
        lines.append(f"- Max drive hours per day: {max_hours}")
    elif "max_drive_hours_per_day" in trip_settings:
        lines.append("- Max drive hours per day: disabled")
    return lines


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
    trip_settings: dict | None = None,
) -> str:
    """Format the trip DAG state as a markdown string for agent consumption.

    When ``nodes`` have already been enriched by ``enrich_dag_times`` the
    output includes estimation markers (``~`` prefix, ``(est.)`` suffix),
    timing conflicts, overnight holds, and topology-derived START/END chips.

    Args:
        nodes: List of node dicts. Pass enriched nodes to render the estimation
            markers; raw Firestore dicts are tolerated and just omit the flags.
        edges: List of edge dicts (must include id, from_node_id, to_node_id, etc.)
        preferences: Optional travel preferences (category + content).
        participants: Optional dict of uid -> {display_name, role}.
        paths: Optional dict of uid -> list of node names.
        locations: Optional list of participant location descriptions.
        plan_name: Optional plan name for the header.
        plan_id: Optional plan ID for the header.
        plan_status: Optional plan status for the header.
        trip_settings: Optional trip settings dict — when provided the header
            surfaces the active flex-planning rules so the agent knows what
            constraints the read-time pass is enforcing.
    """
    lines: list[str] = []
    node_map = {n["id"]: n for n in nodes}

    if plan_name or plan_id:
        header_parts = []
        if plan_name:
            header_parts.append(plan_name)
        if plan_id:
            header_parts.append(f"plan_id: {plan_id}")
        if plan_status:
            header_parts.append(f"status: {plan_status}")
        lines.append(f"# {' — '.join(header_parts)}")

    rule_lines = _format_timing_rules(trip_settings)
    if rule_lines:
        lines.append("\n## Trip timing rules")
        lines.extend(rule_lines)
        lines.append(
            "- Times prefixed with `~` are derived from enrichment; `(est.)` "
            "marks the specific field that was inferred. Do not quote these "
            "as firm commitments."
        )

    if participants:
        lines.append(f"\n## Participants ({len(participants)})")
        for uid, p in participants.items():
            lines.append(f"- {p.get('display_name', uid)} (user_id: {uid}, role: {p.get('role', 'viewer')})")

    forward_adj, reverse_adj = build_adjacency(edges)
    topo_order = toposort(nodes, forward_adj, reverse_adj)
    if topo_order is not None:
        id_to_node = {n["id"]: n for n in nodes}
        sorted_nodes = [id_to_node[nid] for nid in topo_order if nid in id_to_node]
    else:
        sorted_nodes = list(nodes)
    lines.append(f"\n## Stops ({len(sorted_nodes)} nodes)")
    for n in sorted_nodes:
        tz = n.get("timezone")

        time_segments: list[str] = []
        arrival_raw = n.get("arrival_time")
        if arrival_raw:
            arrival = _format_dt(arrival_raw, tz)
            prefix = "~" if n.get("arrival_time_estimated") else ""
            suffix = " (est.)" if n.get("arrival_time_estimated") else ""
            time_segments.append(f"arrives: {prefix}{arrival}{suffix}")
        departure_raw = n.get("departure_time")
        if departure_raw:
            departure = _format_dt(departure_raw, tz)
            prefix = "~" if n.get("departure_time_estimated") else ""
            suffix = " (est.)" if n.get("departure_time_estimated") else ""
            time_segments.append(f"departs: {prefix}{departure}{suffix}")
        duration = n.get("duration_minutes")
        if duration is not None and not n.get("duration_estimated"):
            time_segments.append(f"duration: {duration}m")

        time_info = ""
        if time_segments:
            time_info = ", " + ", ".join(time_segments)

        tz_str = f", tz: {tz}" if tz else ""

        coords = _node_coords(n)
        coords_str = f", {coords[0]:.4f},{coords[1]:.4f}" if coords else ""

        topology_chip = ""
        if n.get("is_start"):
            topology_chip = "🚩 START "
        elif n.get("is_end"):
            topology_chip = "🏁 END "

        lines.append(
            f"- {topology_chip}[{n['id']}] {n['name']} ({n.get('type', 'place')}"
            f"{coords_str}{tz_str}{time_info})"
        )

        if n.get("timing_conflict"):
            lines.append(f"  - ⚠ timing conflict: {n['timing_conflict']}")
        if n.get("overnight_hold"):
            reason = n.get("hold_reason") or "overnight_hold"
            lines.append(f"  - 🛌 overnight hold: {reason}")
        if n.get("drive_cap_warning"):
            reason = n.get("hold_reason") or "max_drive_hours"
            lines.append(f"  - ⚠ warning: drive limit exceeded ({reason})")

        for a in n.get("actions", []):
            action_id_str = f"id: {a['id']}, " if a.get("id") else ""
            lines.append(
                f"  - [{a['type']}, {action_id_str}by: {a.get('created_by', '?')}] "
                f"{a['content']}"
            )

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

    if paths:
        lines.append("\n## Participant Paths")
        for uid, path_names in paths.items():
            lines.append(f"- {uid}: {' -> '.join(path_names)}")

    return "\n".join(lines)
