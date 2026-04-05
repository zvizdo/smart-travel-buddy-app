"""MCP tools for trip read + lifecycle operations.

Read: get_trips, get_trip_plans, get_trip_context.
Write: create_trip, delete_trip, update_trip_settings.
"""

from mcp.server.fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_trip_admin

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
async def get_trip_plans(trip_id: str, ctx: Context) -> str:
    """Get all plans (main + alternatives) for a trip.

    Returns the active plan ID plus a list of every plan with its ID, name,
    status, and node count. Use this to discover draft alternatives before
    calling promote_plan or delete_plan.

    Args:
        trip_id: The trip identifier.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.trip_service.get_trip_plans(trip_id, user_id)

    active_id = result["active_plan_id"]
    lines = [f"Trip: {trip_id}, Active plan: {active_id}"]
    for p in result["plans"]:
        marker = " (ACTIVE)" if p["id"] == active_id else ""
        lines.append(
            f"- {p['name']}{marker} (id: {p['id']}, status: {p['status']}, "
            f"nodes: {p['node_count']})"
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


@mcp.tool()
async def create_trip(name: str, ctx: Context) -> str:
    """Create a new trip. You become its sole Admin.

    Use this as the first step when starting a new itinerary from scratch.
    Do NOT use this to add a stop to an existing trip — use add_node for that.
    Role required: any authenticated user.
    Side effects: creates one trip document AND an initial empty active plan
    named "Main Route", so add_node can be called immediately afterwards.

    Args:
        name: Human-readable trip name, e.g. "Italy 2026" or "Summer road trip".

    Returns: Confirmation with the new trip ID, the initial plan ID, and next steps.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context

    trip = await app.trip_service.create_trip(
        user_id=user_id,
        name=name,
        user_display_name="",
    )
    plan = trip.get("plan") or {}
    return (
        f"Trip created: {trip['name']} (id: {trip['id']}). You are Admin.\n"
        f"Active plan: {plan.get('name', 'Main Route')} (id: {plan.get('id')}).\n"
        f"Next: use add_node to add stops, then add_edge to connect them."
    )


@mcp.tool()
async def delete_trip(trip_id: str, ctx: Context) -> str:
    """Permanently delete a trip and every plan, node, edge, action, and invite under it.

    Use this only when the user explicitly asks to delete the whole trip.
    Do NOT use this to clean up a draft plan — use delete_plan for that.
    Role required: Admin (the trip's admin only).
    Side effects: irreversible cascading delete. All participants lose access.

    Args:
        trip_id: The trip identifier to delete.

    Returns: Confirmation with counts of what was removed.
    """
    user_id, trip_name = await resolve_trip_admin(ctx, trip_id)
    app: AppContext = ctx.request_context.lifespan_context

    result = await app.trip_service.delete_trip(trip_id, user_id)
    return (
        f"Trip deleted: {trip_name} (id: {trip_id}). "
        f"Removed {result['plans_deleted']} plan(s) and "
        f"{result['docs_deleted']} total documents."
    )


@mcp.tool()
async def update_trip_settings(
    trip_id: str,
    ctx: Context,
    datetime_format: str | None = None,
    date_format: str | None = None,
    distance_unit: str | None = None,
) -> str:
    """Update trip display settings (date format, distance units).

    Use this when the user wants to change how dates, times, or distances are shown
    in the web app for this trip. Only pass the fields you want to change.
    Role required: Admin.
    Side effects: updates the trip's settings map. No nodes or plans are touched.

    Args:
        trip_id: The trip identifier.
        datetime_format: Datetime display preset (e.g. "24h", "12h").
        date_format: Date display preset (e.g. "iso", "us", "eu").
        distance_unit: "km" or "miles".

    Returns: The updated settings dict.
    """
    user_id, _ = await resolve_trip_admin(ctx, trip_id)
    app: AppContext = ctx.request_context.lifespan_context

    if datetime_format is None and date_format is None and distance_unit is None:
        return "No settings to update. Provide at least one of: datetime_format, date_format, distance_unit."

    updated = await app.trip_service.update_trip_settings(
        user_id=user_id,
        trip_id=trip_id,
        datetime_format=datetime_format,
        date_format=date_format,
        distance_unit=distance_unit,
    )
    parts = [f"{k}={v}" for k, v in updated.items()]
    return f"Trip settings updated: {', '.join(parts)}"
