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

    Every stop has one of four timing shapes — pass fields matching the one that
    fits what the user actually told you:

    - **Float**: only `duration_minutes`. Use for short along-route stops where
      the user knows the stay length but not when — viewpoints, coffee breaks,
      scenic overlooks. "30 minutes at the lookout" is a Float.
    - **Know when I leave**: only `departure_time`. **Prefer this default for
      intermediate stops where the user mentioned a departure time but no firm
      arrival.** Downstream arrivals derive automatically from the upstream
      cascade — do not invent an arrival time.
    - **Know when I arrive**: only `arrival_time` (optionally with
      `duration_minutes`). Use for firm arrivals like flight landings and hotel
      check-ins.
    - **Fixed time**: both `arrival_time` and `departure_time`. Use only when
      the user gave firm clock times on both sides (ticketed events, scheduled
      transport).

    Returns the created node (including its ID). Requires Admin or Planner role.

    Args:
        trip_id: The trip identifier.
        name: Name of the stop (e.g., "Hotel Lumiere, Lyon").
        type: Type of stop - one of: city, hotel, restaurant, place, activity.
        lat: Latitude of the stop.
        lng: Longitude of the stop.
        plan_id: Optional plan version to modify. Defaults to active plan.
        place_id: Google Places ID if known.
        arrival_time: ISO 8601 arrival datetime (e.g., 2026-04-10T14:00:00Z).
            Only set for `Know when I arrive` or `Fixed time` shapes.
        departure_time: ISO 8601 departure datetime. Only set for
            `Know when I leave` or `Fixed time` shapes.
        duration_minutes: Stay length in minutes. Only set for `Float` or
            `Know when I arrive` shapes where the stay length is a meaningful
            commitment. Do NOT set for `Know when I leave` or `Fixed time`.
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

    Updates only this node. Downstream **Float** and **Know when I leave** stops
    re-derive their times automatically on the next read. Downstream **Fixed
    time** and **Know when I arrive** stops do NOT shift — update each of them
    explicitly if you want them to move.

    Every stop has one of four timing shapes (see `add_node` docs): **Float**
    (only duration), **Know when I leave** (only departure_time — preferred
    default for intermediate stops), **Know when I arrive** (only arrival_time),
    **Fixed time** (both). When changing a stop's shape, pass the new field(s)
    and the fields from the old shape will be ignored going forward.

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
            Only set for `Know when I arrive` or `Fixed time` shapes.
        departure_time: New ISO 8601 departure datetime. Only set for
            `Know when I leave` or `Fixed time` shapes.
        duration_minutes: New stay length in minutes. Only set for `Float` or
            `Know when I arrive` shapes.
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

    Returns: ``{deleted: true, node_id, deleted_edge_count, reconnected_edges,
        participant_ids_cleaned}``.
    """
    _, resolved_plan_id, _ = await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.lifespan_context

    result = await app.dag_service.delete_node(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        node_id=node_id,
    )
    return {
        "deleted": True,
        "node_id": result.get("deleted_node_id", node_id),
        "deleted_edge_count": result.get("deleted_edge_count", 0),
        "reconnected_edges": result.get("reconnected_edges", []),
        "participant_ids_cleaned": result.get("participant_ids_cleaned", 0),
    }
