"""MCP tools for place discovery: suggest_stop, search_places."""

import math

from mcp.server.fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp


@mcp.tool()
async def suggest_stop(
    trip_id: str,
    edge_id: str,
    category: str,
    ctx: Context,
    preferences: str | None = None,
) -> str:
    """Find restaurants, hotels, or attractions along a specific route segment.

    Searches near the midpoint of an edge (connection between two stops).
    Returns suggestions without inserting them — use create_or_modify_trip to add a chosen stop.

    Args:
        trip_id: The trip identifier.
        edge_id: The edge (route segment) to search along.
        category: Type of stop: 'restaurant', 'hotel', or 'attraction'.
        preferences: Optional natural language preferences (e.g., "Italian food", "budget-friendly").
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context

    # Get trip and edge to find the route segment
    trip_data = await app.trip_service._trip_repo.get_or_raise(trip_id)
    app.trip_service._verify_participant(trip_data, user_id)

    plan_id = trip_data.get("active_plan_id")
    if not plan_id:
        return "Trip has no active plan."

    edge = await app.trip_service._edge_repo.get_edge(trip_id, plan_id, edge_id)
    if not edge:
        return f"Edge {edge_id} not found."

    from_node = await app.trip_service._node_repo.get_node(
        trip_id, plan_id, edge.from_node_id
    )
    to_node = await app.trip_service._node_repo.get_node(
        trip_id, plan_id, edge.to_node_id
    )

    if not from_node or not to_node:
        return "Could not find the nodes connected by this edge."

    # Compute midpoint
    from_lat = from_node.lat_lng.lat if from_node.lat_lng else 0
    from_lng = from_node.lat_lng.lng if from_node.lat_lng else 0
    to_lat = to_node.lat_lng.lat if to_node.lat_lng else 0
    to_lng = to_node.lat_lng.lng if to_node.lat_lng else 0
    mid_lat = (from_lat + to_lat) / 2
    mid_lng = (from_lng + to_lng) / 2

    # Search radius based on distance between nodes
    dist_km = _haversine_km(from_lat, from_lng, to_lat, to_lng)
    radius_m = min(max(dist_km * 500, 5000), 50000)  # 5km-50km

    results = await app.places_service.search_nearby(
        lat=mid_lat,
        lng=mid_lng,
        category=category,
        preferences=preferences,
        radius_m=radius_m,
    )

    if not results:
        return f"No {category} suggestions found along {from_node.name} → {to_node.name}."

    lines = [f"Suggestions for {category} between {from_node.name} and {to_node.name}:"]
    for p in results:
        rating = f", rating: {p['rating']}" if p.get("rating") else ""
        lines.append(f"- {p['name']} (place_id: {p['place_id']}{rating})")
        if p.get("address"):
            lines.append(f"  Address: {p['address']}")
    return "\n".join(lines)


@mcp.tool()
async def search_places(
    query: str,
    ctx: Context,
    near_node_id: str | None = None,
    near_lat: float | None = None,
    near_lng: float | None = None,
    radius_km: float = 5,
) -> str:
    """Search for places near a location using Google Maps.

    Provide either near_node_id (to search near a trip stop) or near_lat/near_lng coordinates.

    Args:
        query: Search query (e.g., "Italian restaurant", "budget hotel").
        near_node_id: Search near a specific trip stop's location.
        near_lat: Latitude for search center (alternative to near_node_id).
        near_lng: Longitude for search center (alternative to near_node_id).
        radius_km: Search radius in km (default: 5).
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.request_context.lifespan_context

    lat, lng = near_lat, near_lng

    # Resolve node location if provided
    if near_node_id and (lat is None or lng is None):
        # Need to find the node — search across user's trips
        trips = await app.trip_service._trip_repo.list_by_user(user_id)
        for trip_data in trips:
            plan_id = trip_data.get("active_plan_id")
            if not plan_id:
                continue
            node = await app.trip_service._node_repo.get_node(
                trip_data["id"], plan_id, near_node_id
            )
            if node and node.lat_lng:
                lat = node.lat_lng.lat
                lng = node.lat_lng.lng
                break

    results = await app.places_service.search_text(
        query=query, lat=lat, lng=lng, radius_km=radius_km
    )

    if not results:
        return f"No places found for '{query}'."

    lines = [f"Places matching '{query}':"]
    for p in results:
        rating = f", rating: {p['rating']}" if p.get("rating") else ""
        loc = f"lat: {p['lat']}, lng: {p['lng']}" if p.get("lat") else ""
        lines.append(f"- {p['name']} ({loc}{rating})")
        if p.get("address"):
            lines.append(f"  Address: {p['address']}")
    return "\n".join(lines)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
