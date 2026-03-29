"""MCP tool: add_action — attach notes, todos, or places to trip stops."""

from mcp.server.fastmcp import Context
from mcpserver.src.main import AppContext, mcp


@mcp.tool()
async def add_action(
    trip_id: str,
    node_id: str,
    type: str,
    content: str,
    ctx: Context,
    place_data: str | None = None,
) -> str:
    """Add a note, todo, or place pin to a specific trip stop.

    Available to all roles including Viewer.

    Args:
        trip_id: The trip identifier.
        node_id: The stop to attach the action to.
        type: Action type: 'note', 'todo', or 'place'.
        content: Text content or description.
        place_data: Optional JSON string for type='place': {"name", "lat", "lng", "place_id?", "category?"}.
    """
    import json

    app: AppContext = ctx.request_context.lifespan_context

    parsed_place_data = json.loads(place_data) if place_data else None

    result = await app.trip_service.add_action(
        user_id=app.user_id,
        trip_id=trip_id,
        node_id=node_id,
        action_type=type,
        content=content,
        place_data=parsed_place_data,
    )

    return (
        f"Added {result['type']} to node {node_id}: \"{result['content']}\" "
        f"(action_id: {result['action_id']})"
    )
