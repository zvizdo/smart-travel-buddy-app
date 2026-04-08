"""SDK-agnostic DAG tool definitions.

Each tool is a plain dict with name, description, parameters (JSON Schema),
and is_mutation flag. These definitions are consumed by:
- The Gemini agent (converted to async callables for AFC)
- The MCP server (converted to @mcp.tool() handlers)
"""

DAG_TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "add_node",
        "description": (
            "Add a new stop to the trip itinerary. Returns the created node "
            "with its ID. Use add_edge separately to connect it to other stops."
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
            "Updates only this stop — does NOT cascade schedule changes to "
            "downstream nodes. Update each downstream stop explicitly if needed."
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
        "description": (
            "Create a connection between two existing stops. "
            "Travel time and distance are auto-calculated from the Routes API."
        ),
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
                    "enum": ["drive", "ferry", "flight", "transit", "walk"],
                    "description": "Travel mode. Use 'ferry' for ship/cruise sea routes. Default: drive",
                },
                "notes": {
                    "type": "string",
                    "description": "Optional advisory note about the route (e.g., seasonal closures, scenic highlights).",
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
