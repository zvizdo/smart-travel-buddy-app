"""SDK-agnostic DAG tool definitions.

Each tool is a plain dict with name, description, parameters (JSON Schema),
and is_mutation flag. These definitions are consumed by:
- The Gemini agent (converted to async callables for AFC)
- The MCP server (converted to @mcp.tool() handlers in Phase 9)
"""

DAG_TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "add_node",
        "description": (
            "Add a new stop to the trip itinerary. Optionally connect it after "
            "an existing node by providing connect_after_node_id."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the stop (e.g., 'Hotel Lumiere, Lyon')",
                },
                "type": {
                    "type": "string",
                    "enum": ["city", "hotel", "restaurant", "place", "activity"],
                    "description": "Type of stop",
                },
                "lat": {"type": "number", "description": "Latitude"},
                "lng": {"type": "number", "description": "Longitude"},
                "place_id": {
                    "type": "string",
                    "description": "Google Places ID if known",
                },
                "connect_after_node_id": {
                    "type": "string",
                    "description": "Node ID to insert this stop after (creates an edge)",
                },
                "travel_mode": {
                    "type": "string",
                    "enum": ["drive", "flight", "transit", "walk"],
                    "description": "Travel mode from the preceding node. Default: drive",
                },
                "travel_time_hours": {
                    "type": "number",
                    "description": "Travel time in hours from the preceding node",
                },
                "distance_km": {
                    "type": "number",
                    "description": "Distance in km from the preceding node",
                },
                "arrival_time": {
                    "type": "string",
                    "description": "ISO 8601 arrival datetime (e.g., '2026-04-10T14:00:00Z')",
                },
                "departure_time": {
                    "type": "string",
                    "description": "ISO 8601 departure datetime",
                },
            },
            "required": ["name", "type", "lat", "lng"],
        },
        "is_mutation": True,
    },
    {
        "name": "update_node",
        "description": (
            "Update an existing stop. Only provide the fields you want to change. "
            "Schedule changes automatically cascade to downstream nodes."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "node_id": {
                    "type": "string",
                    "description": "ID of the node to update",
                },
                "name": {"type": "string", "description": "New name"},
                "type": {
                    "type": "string",
                    "enum": ["city", "hotel", "restaurant", "place", "activity"],
                    "description": "New type",
                },
                "lat": {"type": "number", "description": "New latitude"},
                "lng": {"type": "number", "description": "New longitude"},
                "arrival_time": {
                    "type": "string",
                    "description": "New ISO 8601 arrival datetime",
                },
                "departure_time": {
                    "type": "string",
                    "description": "New ISO 8601 departure datetime",
                },
            },
            "required": ["node_id"],
        },
        "is_mutation": True,
    },
    {
        "name": "delete_node",
        "description": (
            "Remove a stop from the itinerary. If the node has one incoming and "
            "one outgoing edge, they are automatically reconnected."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "node_id": {
                    "type": "string",
                    "description": "ID of the node to delete",
                },
            },
            "required": ["node_id"],
        },
        "is_mutation": True,
    },
    {
        "name": "add_edge",
        "description": "Create a connection between two existing stops.",
        "parameters": {
            "type": "object",
            "properties": {
                "from_node_id": {
                    "type": "string",
                    "description": "ID of the source node",
                },
                "to_node_id": {
                    "type": "string",
                    "description": "ID of the destination node",
                },
                "travel_mode": {
                    "type": "string",
                    "enum": ["drive", "flight", "transit", "walk"],
                    "description": "Travel mode. Default: drive",
                },
                "travel_time_hours": {
                    "type": "number",
                    "description": "Travel time in hours (optional, can be inferred)",
                },
                "distance_km": {
                    "type": "number",
                    "description": "Distance in km (optional, can be inferred)",
                },
            },
            "required": ["from_node_id", "to_node_id"],
        },
        "is_mutation": True,
    },
    {
        "name": "delete_edge",
        "description": "Remove a connection between two stops.",
        "parameters": {
            "type": "object",
            "properties": {
                "edge_id": {
                    "type": "string",
                    "description": "ID of the edge to delete",
                },
            },
            "required": ["edge_id"],
        },
        "is_mutation": True,
    },
]
