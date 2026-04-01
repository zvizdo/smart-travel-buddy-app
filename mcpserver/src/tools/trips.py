"""MCP tools for querying trip data: get_trips, get_trip_versions, get_trip_context."""

from mcp.server.fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp

from shared.tools.trip_context import format_trip_context


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

    return f"# {trip['name']}\n\n" + format_trip_context(
        nodes=plan["nodes"],
        edges=plan["edges"],
        participants=trip.get("participants"),
        paths=trip.get("paths"),
        locations=trip.get("participant_locations"),
        plan_name=plan.get("name"),
        plan_id=plan["id"],
        plan_status=plan.get("status"),
    )
