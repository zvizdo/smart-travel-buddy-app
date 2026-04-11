"""Async callable tools for Gemini Automatic Function Calling (AFC).

The google-genai SDK reads type annotations and docstrings from these
functions to generate FunctionDeclaration objects. The SDK then handles
the function calling loop automatically — no manual loop needed.

Tools are defined once in _define_all_tools() and composed into subsets
by create_agent_tools() and create_build_tools().
"""

from backend.src.services.tool_executor import ToolExecutor

from shared.services.flight_service import FlightSearchError, FlightService, format_flight_results


def _define_all_tools(executor: ToolExecutor) -> dict:
    """Define all tool callables once, returning a dict of {name: callable}."""

    async def add_node(
        name: str,
        type: str,
        lat: float,
        lng: float,
        place_id: str | None = None,
        arrival_time: str | None = None,
        departure_time: str | None = None,
        duration_minutes: int | None = None,
    ) -> dict:
        """Add a new stop to the trip itinerary. Returns the created node (including its ID).

        Use the returned node ID in subsequent add_edge calls to connect stops.
        NEVER use placeholder strings — only use real IDs from the trip context or from previous tool results.

        Stops can be time-bound (both arrival_time and departure_time set), flexible
        (only duration_minutes set), or mixed. For a rough stop without a firm schedule,
        provide only duration_minutes and let downstream enrichment derive the times.

        Args:
            name: Name of the stop (e.g., "Hotel Lumiere, Lyon").
            type: Type of stop - one of: city, hotel, restaurant, place, activity.
            lat: Latitude of the stop.
            lng: Longitude of the stop.
            place_id: Google Places ID if known.
            arrival_time: ISO 8601 arrival datetime (e.g., 2026-04-10T14:00:00Z).
            departure_time: ISO 8601 departure datetime.
            duration_minutes: Approximate duration of the stop in minutes. Use this
                for flexible stops when the user doesn't have a firm schedule
                (e.g. "~2 hours at the chateau" = 120).
        """
        return await executor.execute("add_node", {
            "name": name,
            "type": type,
            "lat": lat,
            "lng": lng,
            "place_id": place_id,
            "arrival_time": arrival_time,
            "departure_time": departure_time,
            "duration_minutes": duration_minutes,
        })

    async def update_node(
        node_id: str,
        name: str | None = None,
        type: str | None = None,
        lat: float | None = None,
        lng: float | None = None,
        arrival_time: str | None = None,
        departure_time: str | None = None,
        duration_minutes: int | None = None,
    ) -> dict:
        """Update an existing stop. Only provide the fields you want to change. Updates only this node — no downstream cascade.

        Args:
            node_id: ID of the node to update.
            name: New name for the stop.
            type: New type - one of: city, hotel, restaurant, place, activity.
            lat: New latitude.
            lng: New longitude.
            arrival_time: New ISO 8601 arrival datetime.
            departure_time: New ISO 8601 departure datetime.
            duration_minutes: New approximate duration in minutes for flexible stops.
        """
        return await executor.execute("update_node", {
            "node_id": node_id,
            "name": name,
            "type": type,
            "lat": lat,
            "lng": lng,
            "arrival_time": arrival_time,
            "departure_time": departure_time,
            "duration_minutes": duration_minutes,
        })

    async def delete_node(node_id: str) -> dict:
        """Remove a stop from the itinerary. Surrounding edges are automatically reconnected if possible.

        Args:
            node_id: ID of the node to delete.
        """
        return await executor.execute("delete_node", {"node_id": node_id})

    async def add_edge(
        from_node_id: str,
        to_node_id: str,
        travel_mode: str = "drive",
        notes: str | None = None,
    ) -> dict:
        """Create a connection between two existing stops. Travel time and distance are auto-calculated.

        Args:
            from_node_id: ID of the source node.
            to_node_id: ID of the destination node.
            travel_mode: Travel mode - one of: drive, ferry, flight, transit, walk. Use 'ferry' for ship/cruise routes. Default: drive.
            notes: Optional advisory note about the route (e.g., seasonal closures, scenic highlights).
        """
        return await executor.execute("add_edge", {
            "from_node_id": from_node_id,
            "to_node_id": to_node_id,
            "travel_mode": travel_mode,
            "notes": notes,
        })

    async def delete_edge(edge_id: str) -> dict:
        """Remove a connection between two stops.

        Args:
            edge_id: ID of the edge to delete.
        """
        return await executor.execute("delete_edge", {"edge_id": edge_id})

    async def get_plan() -> dict:
        """Fetch the current plan with all stops and connections.

        Returns a text summary of the plan in the same format as the initial
        trip context. Call this after completing a sequence of mutations
        (add_node, update_node, delete_node, etc.) to verify the resulting
        itinerary before responding to the user.
        """
        return await executor.execute("get_plan", {})

    return {
        "add_node": add_node,
        "update_node": update_node,
        "delete_node": delete_node,
        "add_edge": add_edge,
        "delete_edge": delete_edge,
        "get_plan": get_plan,
    }


def create_agent_tools(executor: ToolExecutor, can_mutate: bool = True) -> list:
    """Create async callables for the ongoing trip management agent.

    Returns all 6 tools when can_mutate=True, or just get_plan when False.
    """
    tools = _define_all_tools(executor)
    if can_mutate:
        return list(tools.values())
    return [tools["get_plan"]]


def create_build_tools(executor: ToolExecutor) -> list:
    """Create the tool set for the build agent.

    Includes add_node, add_edge, delete_node, delete_edge, and get_plan.
    Excludes update_node since the build agent constructs a fresh DAG.
    """
    tools = _define_all_tools(executor)
    return [
        tools["add_node"],
        tools["add_edge"],
        tools["delete_node"],
        tools["delete_edge"],
        tools["get_plan"],
    ]


def create_search_tools(flight_service: FlightService) -> list:
    """Create search tool callables for the agent.

    These are standalone — they don't go through ToolExecutor because
    they are read-only and don't mutate the DAG.
    """

    async def find_flights(
        origin: str,
        destination: str,
        date: str,
        return_date: str | None = None,
        cabin: str = "economy",
        max_stops: str = "any",
        max_results: int = 5,
        adults: int = 1,
    ) -> dict:
        """Search for flights between airports. Returns prices, durations, airlines, and stops.

        Use IATA airport codes (3-letter codes like JFK, LHR, CDG, NRT).
        Dates must be in YYYY-MM-DD format and in the future.
        Omit return_date for one-way; provide it for round-trip.

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
        try:
            result = await flight_service.search(
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

    return [find_flights]
