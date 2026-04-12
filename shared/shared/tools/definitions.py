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
            "with its ID. Use add_edge separately to connect it to other stops. "
            "Every stop has one of four timing shapes: Float (duration_minutes "
            "only — for viewpoints and short along-route stops), Know when I "
            "leave (departure_time only — preferred default for intermediate "
            "stops), Know when I arrive (arrival_time only), or Fixed time "
            "(both arrival_time and departure_time). Downstream Float and Know "
            "when I leave stops derive their times automatically from the "
            "upstream cascade."
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
                "duration_minutes": {
                    "type": "integer",
                    "description": (
                        "Stay length in minutes. Only set for Float or Know "
                        "when I arrive shapes where the stay length is a "
                        "meaningful commitment (e.g. '30 min at the lookout' "
                        "= 30, '~2h at the chateau' = 120)."
                    ),
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
            "downstream nodes. Downstream Float and Know when I leave stops "
            "re-derive their times automatically on read; downstream Fixed "
            "time and Know when I arrive stops must be updated explicitly if "
            "you want them to shift."
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
                "duration_minutes": {
                    "type": "integer",
                    "description": "New approximate duration in minutes for flexible stops.",
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
