"""MCP tools: atomic edge operations (add, delete)."""

from fastmcp import Context
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_trip_plan


@mcp.tool()
async def add_edge(
    trip_id: str,
    from_node_id: str,
    to_node_id: str,
    ctx: Context,
    plan_id: str | None = None,
    travel_mode: str = "drive",
    notes: str | None = None,
) -> dict:
    """Create a connection between two existing stops. Travel time and distance are auto-calculated.

    Requires Admin or Planner role.

    Args:
        trip_id: The trip identifier.
        from_node_id: ID of the source node.
        to_node_id: ID of the destination node.
        plan_id: Optional plan version. Defaults to active plan.
        travel_mode: Travel mode - one of: drive, ferry, flight, transit, walk. Use 'ferry' for ship/cruise routes. Default: drive.
        notes: Optional advisory note about the route (e.g., seasonal closures, scenic highlights).
    """
    _, resolved_plan_id, _ = await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.lifespan_context

    result = await app.dag_service.create_standalone_edge(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        from_node_id=from_node_id,
        to_node_id=to_node_id,
        travel_mode=travel_mode,
        notes=notes,
    )
    return result


@mcp.tool()
async def delete_edge(
    trip_id: str,
    edge_id: str,
    ctx: Context,
    plan_id: str | None = None,
) -> dict:
    """Remove a connection between two stops.

    Requires Admin or Planner role.

    Args:
        trip_id: The trip identifier.
        edge_id: ID of the edge to delete.
        plan_id: Optional plan version. Defaults to active plan.
    """
    _, resolved_plan_id, _ = await resolve_trip_plan(ctx, trip_id, plan_id)
    app: AppContext = ctx.lifespan_context

    result = await app.dag_service.delete_edge_by_id(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        edge_id=edge_id,
    )
    return result
