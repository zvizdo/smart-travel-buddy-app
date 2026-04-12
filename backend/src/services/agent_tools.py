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

        Every stop has one of four timing shapes — pick fields matching the one
        that fits what the user told you:
        - **Float**: only `duration_minutes`. For short along-route stops
          (viewpoints, coffee breaks) where the user knows the stay length but
          not when. "30 minutes at the lookout" is a Float.
        - **Know when I leave**: only `departure_time`. **Preferred default for
          intermediate stops where the user gave a departure time but no firm
          arrival.** Downstream arrivals derive automatically from the upstream
          cascade — do not invent an arrival time.
        - **Know when I arrive**: only `arrival_time` (optionally plus
          `duration_minutes`). For firm arrivals (flight landings, hotel
          check-ins) with a flexible stay length.
        - **Fixed time**: both `arrival_time` and `departure_time`. Only when
          both sides are hard commitments (ticketed events, scheduled transport).

        Args:
            name: Name of the stop (e.g., "Hotel Lumiere, Lyon").
            type: Type of stop - one of: city, hotel, restaurant, place, activity.
            lat: Latitude of the stop.
            lng: Longitude of the stop.
            place_id: Google Places ID if known.
            arrival_time: ISO 8601 arrival datetime (e.g., 2026-04-10T14:00:00Z).
                Only set for `Know when I arrive` or `Fixed time` shapes.
            departure_time: ISO 8601 departure datetime. Only set for
                `Know when I leave` or `Fixed time` shapes.
            duration_minutes: Stay length in minutes. Only set for `Float` or
                `Know when I arrive` shapes where the stay length is a
                meaningful commitment.
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
        """Update an existing stop. Only provide the fields you want to change.

        Updates only this node. Downstream **Float** and **Know when I leave**
        stops re-derive their times automatically on the next read. Downstream
        **Fixed time** and **Know when I arrive** stops do NOT shift — update
        each of them explicitly if you want them to move.

        See `add_node` for the four timing shapes. When changing a stop's
        shape, pass the new field(s); the old shape's fields will be ignored
        going forward.

        Args:
            node_id: ID of the node to update.
            name: New name for the stop.
            type: New type - one of: city, hotel, restaurant, place, activity.
            lat: New latitude.
            lng: New longitude.
            arrival_time: New ISO 8601 arrival datetime. Only for
                `Know when I arrive` or `Fixed time` shapes.
            departure_time: New ISO 8601 departure datetime. Only for
                `Know when I leave` or `Fixed time` shapes.
            duration_minutes: New stay length in minutes. Only for `Float` or
                `Know when I arrive` shapes.
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
