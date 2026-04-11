"""MCP tools for trip read + lifecycle operations.

Read: get_trips, get_trip_plans, get_trip_context.
Write: create_trip, delete_trip, update_trip_settings.
"""

from fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import (
    resolve_trip_admin,
    tool_error_guard,
    tool_error_guard_text,
)

from shared.tools.trip_context import build_agent_trip_context


@mcp.tool()
@tool_error_guard
async def get_trips(ctx: Context) -> dict:
    """Get a list of all trips you have access to.

    Returns trip names, your role, and participant counts.
    No parameters needed.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context
    trips = await app.trip_service.get_trips(user_id)
    return {"trips": trips}


@mcp.tool()
@tool_error_guard
async def get_trip_plans(trip_id: str, ctx: Context) -> dict:
    """Get all plans (main + alternatives) for a trip.

    Returns the active plan ID plus a list of every plan with its ID, name,
    status, and node count. Use this to discover draft alternatives before
    calling promote_plan or delete_plan.

    Args:
        trip_id: The trip identifier.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context
    return await app.trip_service.get_trip_plans(trip_id, user_id)


@mcp.tool()
@tool_error_guard_text
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
    app: AppContext = ctx.lifespan_context
    result = await app.trip_service.get_trip_context(trip_id, user_id, plan_id)

    trip = result["trip"]
    plan = trip.get("plan")
    if not plan:
        return f"Trip '{trip['name']}' has no active plan yet."

    return f"# {trip['name']}\n\n" + build_agent_trip_context(
        nodes=plan["nodes"],
        edges=plan["edges"],
        trip_settings=trip.get("settings") or {},
        participants=trip.get("participants"),
        paths=trip.get("paths"),
        locations=trip.get("participant_locations"),
        plan_name=plan.get("name"),
        plan_id=plan["id"],
        plan_status=plan.get("status"),
    )


@mcp.tool()
@tool_error_guard
async def create_trip(name: str, ctx: Context) -> dict:
    """Create a new trip. You become its sole Admin.

    Use this as the first step when starting a new itinerary from scratch.
    Do NOT use this to add a stop to an existing trip — use add_node for that.
    Role required: any authenticated user.
    Side effects: creates one trip document AND an initial empty active plan
    named "Main Route", so add_node can be called immediately afterwards.

    Args:
        name: Human-readable trip name, e.g. "Italy 2026" or "Summer road trip".

    Returns: The created trip with its ID, plan, and participant info.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context

    return await app.trip_service.create_trip(
        user_id=user_id,
        name=name,
        user_display_name="",
    )


@mcp.tool()
@tool_error_guard
async def delete_trip(trip_id: str, ctx: Context) -> dict:
    """Permanently delete a trip and every plan, node, edge, action, and invite under it.

    Use this only when the user explicitly asks to delete the whole trip.
    Do NOT use this to clean up a draft plan — use delete_plan for that.
    Role required: Admin (the trip's admin only).
    Side effects: irreversible cascading delete. All participants lose access.

    Args:
        trip_id: The trip identifier to delete.

    Returns: Deletion result with counts of what was removed.
    """
    user_id, _ = await resolve_trip_admin(ctx, trip_id)
    app: AppContext = ctx.lifespan_context

    return await app.trip_service.delete_trip(trip_id, user_id)


@mcp.tool()
@tool_error_guard
async def update_trip_settings(
    trip_id: str,
    ctx: Context,
    datetime_format: str | None = None,
    date_format: str | None = None,
    distance_unit: str | None = None,
    no_drive_window_start_hour: int | None = None,
    no_drive_window_end_hour: int | None = None,
    clear_no_drive_window: bool = False,
    max_drive_hours_per_day: float | None = None,
    clear_max_drive_hours: bool = False,
) -> dict:
    """Update trip display + flex-planning settings.

    Covers display presets (date/time/distance) plus the two flex-planning
    rules that govern read-time schedule enrichment:

    - **no_drive_window**: a local-time range during which drive/walk edges
      should not be traversed (default 22:00→06:00). Setting
      ``no_drive_window_start_hour`` + ``no_drive_window_end_hour`` enables
      or updates the window; ``clear_no_drive_window=true`` explicitly
      disables the rule. Leaving both unset leaves the current value alone.
    - **max_drive_hours_per_day**: a hard cap on cumulative drive hours
      before a rest node is required (default 10.0). Works the same way:
      provide a number to set it, or ``clear_max_drive_hours=true`` to
      disable it.

    Role required: Admin. Only pass the fields you want to change.

    Args:
        trip_id: The trip identifier.
        datetime_format: Datetime display preset (e.g. "24h", "12h").
        date_format: Date display preset (e.g. "iso", "us", "eu").
        distance_unit: "km" or "miles".
        no_drive_window_start_hour: Start hour (0-23) of the no-drive window.
            Must be provided together with no_drive_window_end_hour.
        no_drive_window_end_hour: End hour (0-23) of the no-drive window.
        clear_no_drive_window: Set to True to explicitly disable the no-drive window.
        max_drive_hours_per_day: Cap on cumulative drive hours between rest
            nodes. Float in [1.0, 24.0].
        clear_max_drive_hours: Set to True to explicitly disable the cap.

    Returns: The updated settings dict.
    """
    user_id, _ = await resolve_trip_admin(ctx, trip_id)
    app: AppContext = ctx.lifespan_context

    no_drive_window: dict | None = None
    if no_drive_window_start_hour is not None or no_drive_window_end_hour is not None:
        if no_drive_window_start_hour is None or no_drive_window_end_hour is None:
            raise ValueError(
                "Both no_drive_window_start_hour and no_drive_window_end_hour "
                "must be provided together."
            )
        if not 0 <= no_drive_window_start_hour <= 23 or not 0 <= no_drive_window_end_hour <= 23:
            raise ValueError("no_drive_window hours must be in [0, 23].")
        no_drive_window = {
            "start_hour": no_drive_window_start_hour,
            "end_hour": no_drive_window_end_hour,
        }

    if max_drive_hours_per_day is not None and not 1.0 <= max_drive_hours_per_day <= 24.0:
        raise ValueError("max_drive_hours_per_day must be in [1.0, 24.0].")

    any_change = (
        datetime_format is not None
        or date_format is not None
        or distance_unit is not None
        or no_drive_window is not None
        or clear_no_drive_window
        or max_drive_hours_per_day is not None
        or clear_max_drive_hours
    )
    if not any_change:
        raise ValueError(
            "No settings to update. Provide at least one of: "
            "datetime_format, date_format, distance_unit, "
            "no_drive_window_start_hour+no_drive_window_end_hour, "
            "clear_no_drive_window, max_drive_hours_per_day, clear_max_drive_hours."
        )

    return await app.trip_service.update_trip_settings(
        user_id=user_id,
        trip_id=trip_id,
        datetime_format=datetime_format,
        date_format=date_format,
        distance_unit=distance_unit,
        no_drive_window=no_drive_window,
        clear_no_drive_window=clear_no_drive_window,
        max_drive_hours_per_day=max_drive_hours_per_day,
        clear_max_drive_hours=clear_max_drive_hours,
    )
