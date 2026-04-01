"""Async callable tools for Gemini Automatic Function Calling (AFC).

The google-genai SDK reads type annotations and docstrings from these
functions to generate FunctionDeclaration objects. The SDK then handles
the function calling loop automatically — no manual loop needed.

Tools are defined once in _define_all_tools() and composed into subsets
by create_agent_tools() and create_build_tools().
"""

from backend.src.services.tool_executor import ToolExecutor


def _define_all_tools(executor: ToolExecutor) -> dict:
    """Define all tool callables once, returning a dict of {name: callable}."""

    async def add_node(
        name: str,
        type: str,
        lat: float,
        lng: float,
        place_id: str = None,
        arrival_time: str = None,
        departure_time: str = None,
    ) -> dict:
        """Add a new stop to the trip itinerary. Returns the created node (including its ID).

        Use the returned node ID in subsequent add_edge calls to connect stops.
        NEVER use placeholder strings — only use real IDs from the trip context or from previous tool results.

        Args:
            name: Name of the stop (e.g., "Hotel Lumiere, Lyon").
            type: Type of stop - one of: city, hotel, restaurant, place, activity.
            lat: Latitude of the stop.
            lng: Longitude of the stop.
            place_id: Google Places ID if known.
            arrival_time: ISO 8601 arrival datetime (e.g., 2026-04-10T14:00:00Z).
            departure_time: ISO 8601 departure datetime.
        """
        return await executor.execute("add_node", {
            "name": name,
            "type": type,
            "lat": lat,
            "lng": lng,
            "place_id": place_id,
            "arrival_time": arrival_time,
            "departure_time": departure_time,
        })

    async def update_node(
        node_id: str,
        name: str = None,
        type: str = None,
        lat: float = None,
        lng: float = None,
        arrival_time: str = None,
        departure_time: str = None,
    ) -> dict:
        """Update an existing stop. Only provide the fields you want to change. Schedule changes cascade downstream.

        Args:
            node_id: ID of the node to update.
            name: New name for the stop.
            type: New type - one of: city, hotel, restaurant, place, activity.
            lat: New latitude.
            lng: New longitude.
            arrival_time: New ISO 8601 arrival datetime.
            departure_time: New ISO 8601 departure datetime.
        """
        return await executor.execute("update_node", {
            "node_id": node_id,
            "name": name,
            "type": type,
            "lat": lat,
            "lng": lng,
            "arrival_time": arrival_time,
            "departure_time": departure_time,
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
    ) -> dict:
        """Create a connection between two existing stops. Travel time and distance are auto-calculated.

        Args:
            from_node_id: ID of the source node.
            to_node_id: ID of the destination node.
            travel_mode: Travel mode - one of: drive, flight, transit, walk. Default: drive.
        """
        return await executor.execute("add_edge", {
            "from_node_id": from_node_id,
            "to_node_id": to_node_id,
            "travel_mode": travel_mode,
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
