"""MCP tool for flight search: find_flights."""

from fastmcp import Context
from mcpserver.src.main import AppContext, mcp
from mcpserver.src.tools._helpers import resolve_authenticated, tool_error_guard

from shared.services.flight_service import (
    FlightOption,
    FlightSearchError,
    FlightSearchResult,
)


def _serialize_option(opt: FlightOption) -> dict:
    return {
        "price": opt.price,
        "currency": opt.currency,
        "total_duration_minutes": opt.total_duration_minutes,
        "stops": opt.stops,
        "legs": [
            {
                "airline": leg.airline,
                "flight_number": leg.flight_number,
                "departure_airport": leg.departure_airport,
                "arrival_airport": leg.arrival_airport,
                "departure_time": leg.departure_time.isoformat(),
                "arrival_time": leg.arrival_time.isoformat(),
                "duration_minutes": leg.duration_minutes,
            }
            for leg in opt.legs
        ],
    }


def _serialize_search_result(result: FlightSearchResult) -> dict:
    payload: dict = {
        "origin": result.origin,
        "destination": result.destination,
        "date": result.date,
        "return_date": result.return_date,
        "outbound": [_serialize_option(o) for o in result.outbound],
    }
    if result.return_date:
        payload["return_flights"] = [
            _serialize_option(o) for o in result.return_flights
        ]
    return payload


@mcp.tool()
@tool_error_guard
async def find_flights(
    origin: str,
    destination: str,
    date: str,
    ctx: Context,
    return_date: str | None = None,
    cabin: str = "economy",
    max_stops: str = "any",
    max_results: int = 5,
    adults: int = 1,
) -> dict:
    """Search for flights between airports. Returns prices, durations, airlines, and stops.

    Use IATA airport codes (3-letter codes like JFK, LHR, CDG, NRT).
    Dates must be in YYYY-MM-DD format and in the future.
    Omit return_date for one-way searches; provide it for round-trip.

    Returns a structured payload:
        ``{origin, destination, date, return_date, outbound: [{price, currency,
        total_duration_minutes, stops, legs: [...]}], return_flights?: [...]}``

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
    await resolve_authenticated(ctx)
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

    return _serialize_search_result(result)
