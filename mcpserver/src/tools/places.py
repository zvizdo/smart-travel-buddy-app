"""MCP tool for place discovery: find_places."""

from fastmcp import Context
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_authenticated, tool_error_guard_text


@mcp.tool()
@tool_error_guard_text
async def find_places(
    query: str,
    lat: float,
    lng: float,
    ctx: Context,
    radius_km: float = 10,
) -> str:
    """Search for places (restaurants, hotels, attractions, anything) near coordinates.

    Coordinates for every trip stop are included in get_trip_context output as
    "lat,lng" on each node line — read them from there. For a point between two
    stops, average their coordinates. Scale radius_km with the area you're
    searching: tight city search ~2, between two stops ~half the distance
    between them (min 5, max 50).

    Args:
        query: Free-text search (e.g. "Italian restaurant", "budget hotel",
            "viewpoint", "gas station with coffee").
        lat: Search center latitude.
        lng: Search center longitude.
        radius_km: Search radius in km (default 10).
    """
    await resolve_authenticated(ctx)
    app: AppContext = ctx.lifespan_context

    results = await app.places_service.search_text(
        query=query, lat=lat, lng=lng, radius_km=radius_km
    )

    if not results:
        return f"No places found for '{query}' near {lat:.4f},{lng:.4f}."

    lines = [f"Places matching '{query}' near {lat:.4f},{lng:.4f}:"]
    for p in results:
        rating = f", rating: {p['rating']}" if p.get("rating") else ""
        lines.append(f"- {p['name']} (place_id: {p['place_id']}{rating})")
        if p.get("address"):
            lines.append(f"  Address: {p['address']}")
    return "\n".join(lines)
