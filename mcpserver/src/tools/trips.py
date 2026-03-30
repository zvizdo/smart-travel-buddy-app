"""MCP tools for querying trip data: get_trips, get_trip_versions, get_trip_context."""

from datetime import datetime
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp


def _format_dt(raw: str | None, tz_str: str | None) -> str | None:
    """Convert a stored UTC datetime string to local time with timezone label.

    Mirrors the formatting in agent_service.build_trip_context.
    """
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


@mcp.tool()
async def get_trips(ctx: Context) -> str:
    """Get a list of all trips you have access to.

    Returns trip names, your role, and participant counts.
    No parameters needed.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context
    trips = await app.trip_service.get_trips(user_id)

    if not trips:
        return "You don't have any trips yet."

    lines = []
    for t in trips:
        plan_info = f", active_plan: {t['active_plan_id']}" if t.get("active_plan_id") else ", no plan yet"
        lines.append(
            f"- {t['name']} (id: {t['id']}, role: {t['role']}, "
            f"participants: {t['participant_count']}{plan_info})"
        )
    return "Your trips:\n" + "\n".join(lines)


@mcp.tool()
async def get_trip_versions(trip_id: str, ctx: Context) -> str:
    """Get all plan versions (main + alternatives) for a trip.

    Args:
        trip_id: The trip identifier.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.trip_service.get_trip_versions(trip_id, user_id)

    active_id = result["active_plan_id"]
    lines = [f"Trip: {trip_id}, Active plan: {active_id}"]
    for v in result["versions"]:
        marker = " (ACTIVE)" if v["id"] == active_id else ""
        lines.append(
            f"- {v['name']}{marker} (id: {v['id']}, status: {v['status']}, "
            f"nodes: {v['node_count']})"
        )
    return "\n".join(lines)


@mcp.tool()
async def get_trip_context(
    trip_id: str,
    ctx: Context,
    plan_id: str | None = None,
) -> str:
    """Get the full trip context: DAG structure (nodes, edges), computed paths, and participant locations.

    This is the primary tool for understanding a trip's current state.
    Defaults to the active plan version unless a specific plan_id is provided.

    Participant locations are shown as human-readable descriptions relative to trip stops,
    only for users who have opted in to location sharing.

    Args:
        trip_id: The trip identifier.
        plan_id: Optional specific plan version ID. Defaults to the active plan.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.trip_service.get_trip_context(trip_id, user_id, plan_id)

    trip = result["trip"]
    plan = trip.get("plan")
    if not plan:
        return f"Trip '{trip['name']}' has no active plan yet."

    lines = [f"# {trip['name']} — {plan['name']} (plan_id: {plan['id']}, status: {plan['status']})"]

    # Participants
    participants = trip.get("participants", {})
    if participants:
        lines.append(f"\n## Participants ({len(participants)})")
        for uid, p in participants.items():
            lines.append(f"- {p['display_name']} (user_id: {uid}, role: {p['role']})")

    # Nodes (sorted by order_index, matching agent_service.build_trip_context)
    sorted_nodes = sorted(plan["nodes"], key=lambda n: n.get("order_index", 0))
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
        if pids:
            participant_info = f" [assigned to: {', '.join(pids)}]"

        lines.append(
            f"- [{n['id']}] {n['name']} ({n.get('type', 'place')}"
            f"{tz_str}{time_info}){participant_info}"
        )
        for a in n.get("actions", []):
            action_id = f"id: {a['id']}, " if a.get("id") else ""
            lines.append(
                f"  - [{a['type']}, {action_id}by: {a.get('created_by', '?')}] "
                f"{a['content']}"
            )

    # Edges (include IDs and node IDs for mutation reference)
    lines.append(f"\n## Connections ({len(plan['edges'])} edges)")
    for e in plan["edges"]:
        mode = e.get("travel_mode", "?")
        time_h = e.get("travel_time_hours")
        time_str = f"{time_h:.1f}h" if time_h else "?"
        dist = e.get("distance_km")
        dist_str = f", {dist:.0f}km" if dist else ""
        lines.append(
            f"- [{e['id']}] {e['from']} ({e['from_node_id']}) → "
            f"{e['to']} ({e['to_node_id']}) ({mode}, {time_str}{dist_str})"
        )

    # Paths
    paths = trip.get("paths", {})
    if paths:
        lines.append("\n## Participant Paths")
        for uid, path_names in paths.items():
            lines.append(f"- {uid}: {' → '.join(path_names)}")

    # Locations
    locs = trip.get("participant_locations", [])
    if locs:
        lines.append("\n## Participant Locations")
        for loc in locs:
            lines.append(
                f"- {loc['user_name']}: {loc['description']} "
                f"(as of {loc.get('updated_at', 'unknown')})"
            )

    return "\n".join(lines)
