"""MCP tool: create_or_modify_trip — full CRUD on nodes and edges with auto-cascade."""

import json

from mcp.server.fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp


@mcp.tool()
async def create_or_modify_trip(
    trip_id: str,
    ctx: Context,
    plan_id: str | None = None,
    plan_name: str | None = None,
    nodes_to_add: str | None = None,
    nodes_to_update: str | None = None,
    nodes_to_remove: str | None = None,
    edges_to_add: str | None = None,
    edges_to_update: str | None = None,
    edges_to_remove: str | None = None,
) -> str:
    """Create a complete trip DAG from scratch or modify an existing one.

    Supports full CRUD on both nodes and edges. Cascading schedule updates
    are applied automatically when node timing changes. Requires Admin or Planner role.

    When adding nodes and edges together, you can reference new nodes by their name
    in edge from_node_id/to_node_id fields (they'll be resolved to real IDs).

    Args:
        trip_id: The trip identifier.
        plan_id: Plan version to modify. Defaults to active plan. If none exists, a new plan is created.
        plan_name: Name for a newly created plan (used only when creating).
        nodes_to_add: JSON array of nodes to add. Each: {name, type, lat, lng, arrival_time?, departure_time?, duration_hours?, participant_ids?, order_index?}
        nodes_to_update: JSON array of nodes to update. Each: {id, name?, type?, lat?, lng?, arrival_time?, departure_time?, duration_hours?, participant_ids?}
        nodes_to_remove: JSON array of node ID strings to remove.
        edges_to_add: JSON array of edges to add. Each: {from_node_id, to_node_id, travel_mode?, travel_time_hours?, distance_km?}
        edges_to_update: JSON array of edges to update. Each: {id, travel_mode?, travel_time_hours?, distance_km?}
        edges_to_remove: JSON array of edge ID strings to remove.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context

    # Parse JSON string parameters
    parsed_nodes_add = json.loads(nodes_to_add) if nodes_to_add else None
    parsed_nodes_update = json.loads(nodes_to_update) if nodes_to_update else None
    parsed_nodes_remove = json.loads(nodes_to_remove) if nodes_to_remove else None
    parsed_edges_add = json.loads(edges_to_add) if edges_to_add else None
    parsed_edges_update = json.loads(edges_to_update) if edges_to_update else None
    parsed_edges_remove = json.loads(edges_to_remove) if edges_to_remove else None

    result = await app.trip_service.create_or_modify_trip(
        user_id=user_id,
        trip_id=trip_id,
        plan_id=plan_id,
        plan_name=plan_name,
        nodes_to_add=parsed_nodes_add,
        nodes_to_update=parsed_nodes_update,
        nodes_to_remove=parsed_nodes_remove,
        edges_to_add=parsed_edges_add,
        edges_to_update=parsed_edges_update,
        edges_to_remove=parsed_edges_remove,
    )

    lines = [f"Plan: {result['plan_id']}"]
    if result["nodes_added"]:
        lines.append(f"Nodes added: {result['nodes_added']}")
    if result["nodes_updated"]:
        lines.append(f"Nodes updated: {result['nodes_updated']}")
    if result["nodes_removed"]:
        lines.append(f"Nodes removed: {result['nodes_removed']}")
    if result["edges_added"]:
        lines.append(f"Edges added: {result['edges_added']}")
    if result["edges_updated"]:
        lines.append(f"Edges updated: {result['edges_updated']}")
    if result["edges_removed"]:
        lines.append(f"Edges removed: {result['edges_removed']}")
    if result["cascade_applied"]:
        lines.append(
            f"Cascade applied: {result['affected_downstream_nodes']} downstream nodes updated"
        )
    summary = result.get("updated_plan_summary", {})
    lines.append(
        f"Plan now has {summary.get('total_nodes', '?')} nodes "
        f"and {summary.get('total_edges', '?')} edges"
    )
    return "\n".join(lines)
