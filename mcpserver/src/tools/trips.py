"""MCP tools for querying trip data: get_trips, get_trip_versions, get_trip_context."""

from mcp.server.fastmcp import Context
from mcpserver.src.main import AppContext, mcp


@mcp.tool()
async def get_trips(ctx: Context) -> str:
    """Get a list of all trips you have access to.

    Returns trip names, your role, and participant counts.
    No parameters needed.
    """
    app: AppContext = ctx.request_context.lifespan_context
    trips = await app.trip_service.get_trips(app.user_id)

    if not trips:
        return "You don't have any trips yet."

    lines = []
    for t in trips:
        lines.append(
            f"- {t['name']} (id: {t['id']}, role: {t['role']}, "
            f"participants: {t['participant_count']})"
        )
    return "Your trips:\n" + "\n".join(lines)


@mcp.tool()
async def get_trip_versions(trip_id: str, ctx: Context) -> str:
    """Get all plan versions (main + alternatives) for a trip.

    Args:
        trip_id: The trip identifier.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.trip_service.get_trip_versions(trip_id, app.user_id)

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
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.trip_service.get_trip_context(trip_id, app.user_id, plan_id)

    trip = result["trip"]
    plan = trip.get("plan")
    if not plan:
        return f"Trip '{trip['name']}' has no active plan yet."

    lines = [f"# {trip['name']} — {plan['name']} ({plan['status']})"]

    # Nodes
    lines.append(f"\n## Stops ({len(plan['nodes'])} nodes)")
    for n in plan["nodes"]:
        time_info = ""
        if n.get("arrival_time"):
            time_info = f", arrives: {n['arrival_time']}"
        if n.get("departure_time"):
            time_info += f", departs: {n['departure_time']}"

        pids = n.get("participant_ids")
        participant_info = ""
        if pids:
            participant_info = f" [assigned to: {', '.join(pids)}]"

        lines.append(
            f"- {n['name']} ({n.get('type', 'place')}, id: {n['id']}"
            f"{time_info}){participant_info}"
        )
        for a in n.get("actions", []):
            lines.append(f"  - [{a['type']}] {a['content']}")

    # Edges
    lines.append(f"\n## Connections ({len(plan['edges'])} edges)")
    for e in plan["edges"]:
        mode = e.get("travel_mode", "?")
        time_h = e.get("travel_time_hours")
        time_str = f"{time_h:.1f}h" if time_h else "?"
        dist = e.get("distance_km")
        dist_str = f", {dist:.0f}km" if dist else ""
        lines.append(f"- {e['from']} → {e['to']} ({mode}, {time_str}{dist_str})")

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
