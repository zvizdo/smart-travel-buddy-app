# MCP Server Tools Contract

**Server**: FastMCP (Python, `mcp` SDK)
**Protocol**: Model Context Protocol (MCP)

These tools are exposed to external AI agents (e.g., phone assistants, Claude Desktop) to query and modify trip data.

**Feature Parity Principle**: The MCP server MUST support the full set of trip management capabilities available to the in-app Gemini agent. Any DAG operation a user can perform via the in-app agent (add/remove/update nodes and edges, cascade changes, search places, etc.) must also be possible via MCP tools. External agents create trips by submitting a complete DAG (nodes + edges) via `create_or_modify_trip` rather than using the in-app conversational import flow.

---

## Authentication

MCP tools authenticate via **user-generated API keys**. Users create API keys in their profile settings within the app. The API key is passed as a credential when configuring the MCP server in the AI client.

- The MCP server validates the API key by computing its HMAC-SHA256 (using a server-side secret) and looking up the hash in `users/{userId}/api_keys`
- A valid API key grants access to all trips where the associated user is a participant
- Per-trip authorization respects the user's role (e.g., Viewer cannot modify nodes)

---

## Tool: `get_trips`

Returns a list of all trips the authenticated user has access to.

**Parameters**: None

**Returns**:
```json
{
  "trips": [
    { "id": "trip_abc123", "name": "Road Trip 2026", "role": "admin", "active_plan_id": "plan_xyz", "participant_count": 5 },
    { "id": "trip_def456", "name": "Japan 2026", "role": "planner", "active_plan_id": "plan_uvw", "participant_count": 3 }
  ]
}
```

---

## Tool: `get_trip_versions`

Returns a list of all plan versions (main + alternatives) for a trip.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `trip_id` | string | Yes | Trip identifier |

**Returns**:
```json
{
  "trip_id": "trip_abc123",
  "active_plan_id": "plan_xyz",
  "versions": [
    { "id": "plan_xyz", "name": "Main Route", "status": "active", "node_count": 8 },
    { "id": "plan_alt1", "name": "Scenic Alternative", "status": "draft", "node_count": 10 }
  ]
}
```

---

## Tool: `get_trip_context`

Returns the full DAG structure and current participant locations for a trip. Defaults to the main (active) plan version but can return a specific version if `plan_id` is passed.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `trip_id` | string | Yes | Trip identifier |
| `plan_id` | string | No | Specific plan version ID. Defaults to active plan. |

**Returns**:
```json
{
  "trip": {
    "id": "trip_abc123",
    "name": "Road Trip 2026",
    "plan": {
      "id": "plan_xyz",
      "name": "Main Route",
      "status": "active",
      "nodes": [
        { "id": "node_1", "name": "Paris", "type": "city", "lat": 48.8566, "lng": 2.3522, "arrival_time": "2026-06-01", "departure_time": "2026-06-06", "participant_ids": null, "actions": [ { "type": "note", "content": "Nikola recommended Chez L'Ami Jean", "created_by_name": "Nikola" } ] }
      ],
      "edges": [
        { "from": "Paris", "to": "Alps", "travel_mode": "drive", "travel_time_hours": 6 }
      ]
    },
    "participant_locations": [
      { "user_name": "Anze", "lat": 48.85, "lng": 2.35, "updated_at": "2026-06-15T14:30:00Z" }
    ]
  }
}
```

---

## Tool: `create_or_modify_trip`

Create a complete trip DAG from scratch or modify an existing one. Supports full CRUD on both nodes and edges, enabling external agents to build entire trips or make structural changes. Cascading updates are applied automatically when node timing changes.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `trip_id` | string | Yes | Trip identifier |
| `plan_id` | string | No | Plan version to modify. Defaults to active plan. If no active plan exists, a new plan is created. |
| `plan_name` | string | No | Name for a newly created plan (e.g., "Main Route"). Used only when creating a new plan. |
| `nodes_to_add` | array | No | New nodes: `[{ name, type, lat, lng, arrival_time?, departure_time?, duration_hours?, participant_ids?, order_index?, after_node_id? }]` |
| `nodes_to_update` | array | No | Updated nodes: `[{ id, name?, type?, lat?, lng?, arrival_time?, departure_time?, duration_hours?, participant_ids? }]` |
| `nodes_to_remove` | array | No | Node IDs to remove: `["node_id_1", "node_id_2"]` |
| `edges_to_add` | array | No | New edges: `[{ from_node_id, to_node_id, travel_mode?, travel_time_hours?, distance_km? }]`. `from_node_id`/`to_node_id` can reference existing node IDs or temporary IDs from `nodes_to_add` (use the node's `name` as temp ID if no `id` returned yet). |
| `edges_to_update` | array | No | Updated edges: `[{ id, travel_mode?, travel_time_hours?, distance_km? }]` |
| `edges_to_remove` | array | No | Edge IDs to remove: `["edge_id_1", "edge_id_2"]` |

**Returns**:
```json
{
  "plan_id": "plan_xyz",
  "nodes_added": 5,
  "nodes_updated": 0,
  "nodes_removed": 0,
  "edges_added": 4,
  "edges_updated": 0,
  "edges_removed": 0,
  "cascade_applied": true,
  "affected_downstream_nodes": 3,
  "updated_plan_summary": {
    "total_nodes": 5,
    "total_edges": 4
  }
}
```

**Creating a full trip**: To create a trip from scratch, pass `nodes_to_add` with all stops and `edges_to_add` connecting them. If the trip has no active plan, one is created automatically. Use `after_node_id` on nodes or provide `order_index` to define sequencing.

**Notes**: Cascading updates are applied automatically when node timing changes (no preview/confirm flow for AI agents). Requires Planner or Admin role. When removing nodes, connected edges are automatically cleaned up and neighboring nodes are reconnected.

---

## Tool: `suggest_stop`

Uses the Google Places API to find a restaurant, hotel, or point of interest along a specific route segment. Returns suggestions without inserting -- the agent can then call `create_or_modify_trip` to insert a chosen suggestion.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `trip_id` | string | Yes | Trip identifier |
| `edge_id` | string | Yes | Edge (route segment) to search along |
| `category` | string | Yes | Type of stop: 'restaurant', 'hotel', 'attraction' |
| `preferences` | string | No | Natural language preferences (e.g., "Italian food", "budget-friendly") |

**Returns**:
```json
{
  "suggestions": [
    { "name": "La Petite Auberge", "place_id": "ChIJ...", "lat": 46.5, "lng": 3.1, "rating": 4.5, "category": "restaurant", "distance_from_route_km": 2.1 }
  ]
}
```

---

## Tool: `add_action`

Add a note, todo, or place pin to a specific node. Available to all roles including Viewer.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `trip_id` | string | Yes | Trip identifier |
| `node_id` | string | Yes | Node to attach the action to |
| `type` | string | Yes | Action type: 'note', 'todo', 'place' |
| `content` | string | Yes | Text content or description |
| `place_data` | object | No | Required for type='place': `{ name, lat, lng, place_id?, category? }` |

**Returns**:
```json
{
  "action_id": "action_abc",
  "type": "note",
  "content": "Nikola recommended Chez L'Ami Jean for dinner",
  "node_id": "node_1",
  "created_at": "2026-06-15T10:00:00Z"
}
```

---

## Tool: `search_places`

Search for places near a location or along a route using Google Maps Places API.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., "Italian restaurant", "budget hotel") |
| `near_node_id` | string | No | Search near a specific node's location |
| `near_lat` | number | No | Latitude for search center |
| `near_lng` | number | No | Longitude for search center |
| `radius_km` | number | No | Search radius in km (default: 5) |

**Returns**:
```json
{
  "places": [
    { "name": "Chez L'Ami Jean", "place_id": "ChIJ...", "lat": 48.856, "lng": 2.352, "rating": 4.6, "price_level": 3, "types": ["restaurant", "food"] }
  ]
}
```

---

## Tool: `search_web`

Search the web for travel information about destinations, activities, weather, etc.

**Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., "best time to visit Alps", "Paris travel advisory June 2026") |

**Returns**:
```json
{
  "results": [
    { "title": "Best Time to Visit the Alps", "snippet": "June through September offers the best weather...", "url": "https://..." }
  ]
}
```

