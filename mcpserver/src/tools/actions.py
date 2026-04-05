"""MCP tools for node actions — notes, todos, and place pins attached to trip stops."""

from mcp.server.fastmcp import Context
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_trip_participant
from shared.models import ActionType, PlaceData

_VALID_TYPES = {t.value for t in ActionType}


@mcp.tool()
async def add_action(
    trip_id: str,
    node_id: str,
    type: str,
    content: str,
    ctx: Context,
    plan_id: str | None = None,
    place_name: str | None = None,
    place_id: str | None = None,
    place_lat: float | None = None,
    place_lng: float | None = None,
    place_category: str | None = None,
) -> str:
    """Attach a note, todo, or place pin to a trip stop.

    Role required: any participant (including Viewer).

    Args:
        trip_id: The trip identifier.
        node_id: The stop to attach the action to. Must exist on the target plan.
        type: One of 'note', 'todo', or 'place'.
        content: Text body of the action (1–2000 chars). For 'place', use this
            for a short description or reason ("cheap dinner spot", "must try").
        plan_id: Optional plan to target. Defaults to the trip's active plan.
        place_name: Display name of the place. **Required when type='place'.**
        place_id: Google Places ID. **Required when type='place'** — obtain it
            by calling `find_places` first and copying the returned place_id.
        place_lat: Optional latitude of the place.
        place_lng: Optional longitude of the place.
        place_category: Optional free-form category (e.g. "restaurant", "museum").

    For type='note' or 'todo', the place_* fields must be left unset.
    """
    user_id, resolved_plan_id, _ = await resolve_trip_participant(ctx, trip_id, plan_id)
    app: AppContext = ctx.request_context.lifespan_context

    if type not in _VALID_TYPES:
        raise ValueError(
            f"Invalid action type '{type}'. Must be one of: {sorted(_VALID_TYPES)}"
        )
    action_type = ActionType(type)

    place_fields_set = any(
        v is not None
        for v in (place_name, place_id, place_lat, place_lng, place_category)
    )

    place_data: PlaceData | None = None
    if action_type == ActionType.PLACE:
        if not place_name or not place_id:
            raise ValueError(
                "type='place' requires both place_name and place_id. "
                "Call find_places first to obtain a Google place_id."
            )
        lat_lng = None
        if place_lat is not None and place_lng is not None:
            lat_lng = {"lat": place_lat, "lng": place_lng}
        place_data = PlaceData(
            name=place_name,
            place_id=place_id,
            lat_lng=lat_lng,
            category=place_category,
        )
    elif place_fields_set:
        raise ValueError(
            f"place_* fields are only allowed when type='place' (got type='{type}')."
        )

    result = await app.trip_service.add_action(
        user_id=user_id,
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        node_id=node_id,
        action_type=action_type,
        content=content,
        place_data=place_data,
    )

    return (
        f"Added {result['type']} to node {node_id}: \"{result['content']}\" "
        f"(action_id: {result['action_id']})"
    )


@mcp.tool()
async def list_actions(
    trip_id: str,
    node_id: str,
    ctx: Context,
    plan_id: str | None = None,
) -> str:
    """List all actions (notes, todos, places) attached to a specific trip stop.

    Returns detailed info for each action including place data, completion
    state, and timestamps. For a compact overview across every node, use
    `get_trip_context` instead.

    Role required: any participant (including Viewer).

    Args:
        trip_id: The trip identifier.
        node_id: The stop whose actions to list.
        plan_id: Optional plan to target. Defaults to the trip's active plan.
    """
    _, resolved_plan_id, _ = await resolve_trip_participant(ctx, trip_id, plan_id)
    app: AppContext = ctx.request_context.lifespan_context

    actions = await app.trip_service.list_actions(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        node_id=node_id,
    )

    if not actions:
        return f"No actions on node {node_id}."

    lines = [f"Actions on node {node_id} ({len(actions)}):"]
    for a in actions:
        done = "x" if a.get("is_completed") else " "
        lines.append(
            f"- [{a.get('type')}, id: {a.get('id')}, done: [{done}]] {a.get('content')}"
        )
        pd = a.get("place_data")
        if pd:
            name = pd.get("name")
            pid = pd.get("place_id")
            cat = pd.get("category")
            ll = pd.get("lat_lng") or {}
            lat = ll.get("lat")
            lng = ll.get("lng")
            place_bits = []
            if name:
                place_bits.append(f"name: {name}")
            if pid:
                place_bits.append(f"place_id: {pid}")
            if lat is not None and lng is not None:
                place_bits.append(f"coords: {lat:.5f},{lng:.5f}")
            if cat:
                place_bits.append(f"category: {cat}")
            if place_bits:
                lines.append("    place: " + ", ".join(place_bits))
        created_by = a.get("created_by")
        created_at = a.get("created_at")
        meta_bits = []
        if created_by:
            meta_bits.append(f"by: {created_by}")
        if created_at:
            meta_bits.append(f"at: {created_at}")
        if meta_bits:
            lines.append("    " + ", ".join(meta_bits))

    return "\n".join(lines)


@mcp.tool()
async def delete_action(
    trip_id: str,
    node_id: str,
    action_id: str,
    ctx: Context,
    plan_id: str | None = None,
) -> str:
    """Delete a specific action from a trip stop.

    Role required: any participant (including Viewer).

    Args:
        trip_id: The trip identifier.
        node_id: The stop the action is attached to.
        action_id: The action to delete (obtain via `list_actions` or `get_trip_context`).
        plan_id: Optional plan to target. Defaults to the trip's active plan.
    """
    _, resolved_plan_id, _ = await resolve_trip_participant(ctx, trip_id, plan_id)
    app: AppContext = ctx.request_context.lifespan_context

    result = await app.trip_service.delete_action(
        trip_id=trip_id,
        plan_id=resolved_plan_id,
        node_id=node_id,
        action_id=action_id,
    )

    return (
        f"Deleted {result.get('type') or 'action'} {action_id} from node {node_id}."
    )
