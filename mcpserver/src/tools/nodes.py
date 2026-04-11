"""MCP tools: atomic node operations (add, update, delete)."""

from fastmcp import Context
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_trip_plan, tool_error_guard


@mcp.tool()
@tool_error_guard
async def add_node(
    trip_id: str,
    name: str,
    type: str,
    lat: float,
    lng: float,
    ctx: Context,
    plan_id: str | None = None,
    place_id: str | None = None,
    arrival_time: str | None = None,
    departure_time: str | None = None,
    duration_minutes: int | None = None,
) -> dict:
    """Add a new stop to the trip itinerary. Use add_edge separately to connect it.

    Stops can be time-bound (arrival_time and/or departure_time set) or flexible
    (only duration_minutes set — times are then derived on read from upstream
    anchors). Returns the created node (including its ID). Requires Admin or
    Planner role.

    Args:
        trip_id: The trip identifier.
        name: Name of the stop (e.g., "Hotel Lumiere, Lyon").
        type: Type of stop - one of: city, hotel, restaurant, place, activity.
        lat: Latitude of the stop.
        lng: Longitude of the stop.
        plan_id: Optional plan version to modify. Defaults to active plan.
        place_id: Google Places ID if known.
        arrival_time: ISO 8601 arrival datetime (e.g., 2026-04-10T14:00:00Z).
        departure_time: ISO 8601 departure datetime.
        duration_minutes: Approximate duration of the stop in minutes. Use this
            for flexible stops when the user doesn't have a firm schedule
            (e.g. "~2 hours at the chateau" = 120).
    """
    user_id, resolved_plan_id, _ = await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.lifespan_context

    result = await app.dag_service.create_node(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        name=name,
        node_type=type,
        lat=lat,
        lng=lng,
        connect_after_node_id=None,
        travel_mode="drive",
        travel_time_hours=0,
        distance_km=None,
        created_by=user_id,
        place_id=place_id,
        arrival_time=arrival_time,
        departure_time=departure_time,
        duration_minutes=duration_minutes,
    )
    return result


@mcp.tool()
@tool_error_guard
async def update_node(
    trip_id: str,
    node_id: str,
    ctx: Context,
    plan_id: str | None = None,
    name: str | None = None,
    type: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    arrival_time: str | None = None,
    departure_time: str | None = None,
    duration_minutes: int | None = None,
) -> dict:
    """Update an existing stop. Only provide the fields you want to change.

    Updates only this node. Downstream flex stops (duration_minutes set, no
    fixed times) re-derive their times automatically on the next read.
    Downstream time-bound stops do NOT shift — update each of them explicitly
    if you want them to move.
    Role required: Admin or Planner.

    Args:
        trip_id: The trip identifier.
        node_id: ID of the node to update.
        plan_id: Optional plan version. Defaults to active plan.
        name: New name for the stop.
        type: New type - one of: city, hotel, restaurant, place, activity.
        lat: New latitude.
        lng: New longitude.
        arrival_time: New ISO 8601 arrival datetime, e.g. "2026-04-10T14:00:00Z".
        departure_time: New ISO 8601 departure datetime.
        duration_minutes: New approximate duration in minutes for flexible stops.
    """
    _, resolved_plan_id, _ = await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.lifespan_context

    updates: dict = {}
    if name is not None:
        updates["name"] = name
    if type is not None:
        updates["type"] = type
    if lat is not None and lng is not None:
        updates["lat_lng"] = {"lat": lat, "lng": lng}
    if arrival_time is not None:
        updates["arrival_time"] = arrival_time
    if departure_time is not None:
        updates["departure_time"] = departure_time
    if duration_minutes is not None:
        updates["duration_minutes"] = duration_minutes

    if not updates:
        raise ValueError("No fields to update.")

    node = await app.dag_service.update_node_only(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        node_id=node_id,
        updates=updates,
    )
    return {"node": node}


@mcp.tool()
@tool_error_guard
async def delete_node(
    trip_id: str,
    node_id: str,
    ctx: Context,
    plan_id: str | None = None,
) -> dict:
    """Remove a stop from the itinerary. Surrounding edges reconnect if possible.

    Requires Admin or Planner role.

    Args:
        trip_id: The trip identifier.
        node_id: ID of the node to delete.
        plan_id: Optional plan version. Defaults to active plan.
    """
    _, resolved_plan_id, _ = await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.lifespan_context

    result = await app.dag_service.delete_node(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        node_id=node_id,
    )
    return result
