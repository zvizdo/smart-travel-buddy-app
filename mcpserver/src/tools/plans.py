"""MCP tools for plan versioning: create_plan (clone), promote_plan, delete_plan."""

from mcp.server.fastmcp import Context
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_trip_admin, resolve_trip_plan


@mcp.tool()
async def create_plan(
    trip_id: str,
    name: str,
    ctx: Context,
    source_plan_id: str | None = None,
    include_actions: bool = False,
) -> str:
    """Create an alternative plan by deep-cloning an existing plan.

    Use this when the user wants to explore a variant of their itinerary
    (e.g. "what if we skipped Florence?") without losing the original. The
    clone starts as a draft — use promote_plan afterward to make it the
    active plan shown on the map.
    Do NOT use this to start a new trip — use create_trip for that.
    Role required: Admin or Planner.
    Side effects: creates a new plan document plus a deep copy of all nodes
    and edges. Actions are copied only when include_actions=true.

    Args:
        trip_id: The trip identifier.
        name: Name for the new plan, e.g. "Without Florence" or "Shorter version".
        source_plan_id: Plan to clone from. Defaults to the trip's active plan.
        include_actions: When true, also clones notes/todos/place pins on each node.

    Returns: Confirmation with the new plan ID and clone statistics.
    """
    user_id, resolved_source_plan_id, _ = await resolve_trip_plan(
        ctx, trip_id, source_plan_id
    )
    app: AppContext = ctx.request_context.lifespan_context

    result = await app.plan_service.clone_plan(
        trip_id=trip_id,
        source_plan_id=resolved_source_plan_id,
        name=name,
        created_by=user_id,
        include_actions=include_actions,
    )
    new_plan = result["plan"]
    actions_cloned = result.get("actions_cloned") or 0
    action_suffix = f", {actions_cloned} actions" if actions_cloned else ""
    return (
        f"Plan created: {new_plan['name']} (id: {new_plan['id']}, status: draft). "
        f"Cloned {result['nodes_cloned']} nodes, {result['edges_cloned']} edges"
        f"{action_suffix}. Use promote_plan to make it the active plan."
    )


@mcp.tool()
async def promote_plan(trip_id: str, plan_id: str, ctx: Context) -> str:
    """Make a plan the active plan for the trip. The previously active plan becomes a draft.

    Use this once the user has decided an alternative version is the one they
    want to follow. The demoted plan is NOT deleted — it stays as a draft and
    can be promoted again later, or deleted with delete_plan.
    Role required: Admin.
    Side effects: swaps the trip's active_plan_id and flips both plans' status.

    Args:
        trip_id: The trip identifier.
        plan_id: The plan to promote to active.

    Returns: Confirmation with the previous active plan ID (if any).
    """
    user_id, _ = await resolve_trip_admin(ctx, trip_id)
    app: AppContext = ctx.request_context.lifespan_context

    result = await app.plan_service.promote_plan(
        trip_id=trip_id,
        plan_id=plan_id,
        promoted_by=user_id,
    )
    previous = result.get("previous_active")
    if previous:
        return (
            f"Plan {plan_id} is now the active plan. "
            f"Previous active plan ({previous}) was demoted to draft."
        )
    return f"Plan {plan_id} is now the active plan."


@mcp.tool()
async def delete_plan(trip_id: str, plan_id: str, ctx: Context) -> str:
    """Permanently delete a non-active plan and all its nodes, edges, and actions.

    Use this to clean up draft alternatives the user no longer wants.
    Cannot delete the currently active plan — promote a different plan first.
    Role required: Admin or Planner.
    Side effects: irreversible cascading delete of the plan and all its contents.

    Args:
        trip_id: The trip identifier.
        plan_id: The plan to delete. Must not be the active plan.

    Returns: Confirmation of deletion.
    """
    # Gate A — editor. Pass the target plan_id through so the helper doesn't
    # need an active plan fallback; the service layer re-verifies the plan exists.
    await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.request_context.lifespan_context

    await app.plan_service.delete_plan(trip_id=trip_id, plan_id=plan_id)
    return f"Plan deleted: {plan_id}"
