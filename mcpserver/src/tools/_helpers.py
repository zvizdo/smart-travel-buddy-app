"""Shared helpers for MCP tool handlers.

Auth gates (see /Users/anzekravanja/.claude/plans/lively-squishing-quill.md):

- Gate A (editor):      resolve_trip_plan — admin or planner, plan resolution.
- Gate B (participant): resolve_trip_participant — any participant, plan resolution.
- Gate C (admin):       resolve_trip_admin — admin only, no plan resolution.
- Gate D (auth):        get_user_id directly — for tools where no trip exists yet.

Every @mcp.tool() must call exactly one gate on its first executable line.
"""

from fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext


async def resolve_trip_plan(
    ctx: Context,
    trip_id: str,
    plan_id: str | None = None,
) -> tuple[str, str, str]:
    """Resolve user_id, verify participant + editor role, and resolve plan_id.

    Returns (user_id, plan_id, trip_name).
    Raises PermissionError if user is not an admin/planner.
    Raises ValueError if trip has no active plan and no plan_id provided.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context

    trip_data = await app.trip_service._trip_repo.get_or_raise(trip_id)
    role = app.trip_service._verify_participant(trip_data, user_id)
    app.trip_service._require_editor(role)

    resolved_plan_id = plan_id or trip_data.get("active_plan_id")
    if not resolved_plan_id:
        raise ValueError("Trip has no active plan and no plan_id was provided")

    return user_id, resolved_plan_id, trip_data.get("name", trip_id)


async def resolve_trip_participant(
    ctx: Context,
    trip_id: str,
    plan_id: str | None = None,
) -> tuple[str, str, str]:
    """Resolve user_id, verify the caller is any trip participant, and resolve plan_id.

    Returns (user_id, plan_id, trip_name).
    Raises PermissionError if user is not a participant.
    Raises ValueError if trip has no active plan and no plan_id provided.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context

    trip_data = await app.trip_service._trip_repo.get_or_raise(trip_id)
    app.trip_service._verify_participant(trip_data, user_id)

    resolved_plan_id = plan_id or trip_data.get("active_plan_id")
    if not resolved_plan_id:
        raise ValueError("Trip has no active plan and no plan_id was provided")

    return user_id, resolved_plan_id, trip_data.get("name", trip_id)


async def resolve_trip_admin(
    ctx: Context,
    trip_id: str,
) -> tuple[str, str]:
    """Resolve user_id and verify the caller is a trip admin.

    Returns (user_id, trip_name).
    Raises PermissionError if the user is not a participant or not an admin.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context

    trip_data = await app.trip_service._trip_repo.get_or_raise(trip_id)
    role = app.trip_service._verify_participant(trip_data, user_id)
    app.trip_service._require_admin(role)

    return user_id, trip_data.get("name", trip_id)
