"""MCP tool for flight search: find_flights."""

from fastmcp import Context
from mcpserver.src.auth.api_key_auth import get_user_id
from mcpserver.src.main import AppContext, mcp
from shared.services.flight_service import FlightSearchError, format_flight_results


@mcp.tool()
async def find_flights(
    origin: str,
    destination: str,
    date: str,
    ctx: Context,
    return_date: str = None,
    cabin: str = "economy",
    max_stops: str = "any",
    max_results: int = 5,
    adults: int = 1,
) -> dict:
    """Search for flights between airports. Returns prices, durations, airlines, and stops.

    Use IATA airport codes (3-letter codes like JFK, LHR, CDG, NRT).
    Dates must be in YYYY-MM-DD format and in the future.
    Omit return_date for one-way searches; provide it for round-trip.

    Args:
        origin: Departure airport IATA code (e.g. "LHR").
        destination: Arrival airport IATA code (e.g. "JFK").
        date: Departure date as YYYY-MM-DD.
        return_date: Return date as YYYY-MM-DD for round-trip searches.
        cabin: Cabin class — economy, premium_economy, business, first.
        max_stops: Stop filter — any, nonstop, one_stop, two_stops.
        max_results: Number of results to return (1-10, default 5).
        adults: Number of adult passengers (1-9, default 1).
    """
    get_user_id(ctx)  # auth check
    app: AppContext = ctx.lifespan_context

    try:
        result = await app.flight_service.search(
            origin=origin,
            destination=destination,
            date=date,
            return_date=return_date,
            cabin=cabin,
            max_stops=max_stops,
            max_results=max_results,
            adults=adults,
        )
    except FlightSearchError as exc:
        return {"error": str(exc)}

    return {"flights": format_flight_results(result)}
