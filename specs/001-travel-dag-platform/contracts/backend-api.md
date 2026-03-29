# Backend API Contract

**Base URL**: `/api/v1`
**Auth**: All endpoints require `Authorization: Bearer <firebase-id-token>` header unless noted.

---

## Trips

### `POST /trips`
Create a new trip. Caller becomes Admin.

**Request**:
```json
{ "name": "Road Trip 2026" }
```

**Response** `201`:
```json
{
  "id": "trip_abc123",
  "name": "Road Trip 2026",
  "active_plan_id": null,
  "participants": { "user_123": { "role": "admin" } },
  "created_at": "2026-03-26T10:00:00Z"
}
```

### `GET /trips`
List trips for the authenticated user.

**Response** `200`:
```json
{
  "trips": [
    { "id": "trip_abc123", "name": "Road Trip 2026", "role": "admin", "active_plan_id": "plan_xyz" }
  ]
}
```

### `GET /trips/{tripId}`
Get trip details including participants.

**Response** `200`: Full trip object.

---

## AI Agent

The Gemini agent is a first-class interface for the entire trip lifecycle. It handles both the initial import and ongoing trip management. The agent has Google Maps tool (geocoding, directions, places) and Google Search tool (destination research) available. The backend manages Gemini chat sessions and executes tool calls against the respective APIs.

### Magic Import (Ephemeral Conversation)

The import flow is a single ephemeral conversation -- no state is persisted to Firestore until the final plan is created. The frontend manages conversation state in-memory and exchanges messages with the backend.

### `POST /trips/{tripId}/import/chat`
Send a message in the import conversation. The backend delegates to Gemini for text analysis, note extraction, and clarification. The conversation must be completed in a single session.

**Request** (initial -- user pastes itinerary):
```json
{
  "messages": [
    { "role": "user", "content": "We want to visit Paris in June, then head to the Alps for hiking, budget around $3000..." }
  ]
}
```

**Response** `200` (agent asks clarifying questions):
```json
{
  "reply": {
    "role": "assistant",
    "content": "I've identified several stops in your itinerary. A few questions:\n1. How many days do you plan to spend in Paris?\n2. Do you want to drive or fly from Paris to the Alps?"
  },
  "notes": [
    { "category": "destination", "content": "Paris", "confidence": "high" },
    { "category": "timing", "content": "June", "confidence": "high" },
    { "category": "activity", "content": "hiking in Alps", "confidence": "high" },
    { "category": "budget", "content": "$3000", "confidence": "high" }
  ],
  "ready_to_build": false
}
```

**Request** (user answers questions):
```json
{
  "messages": [
    { "role": "user", "content": "We want to visit Paris in June..." },
    { "role": "assistant", "content": "I've identified several stops..." },
    { "role": "user", "content": "5 days in Paris, and we'll drive to the Alps" }
  ]
}
```

**Response** `200` (ready to build):
```json
{
  "reply": {
    "role": "assistant",
    "content": "Great! I have everything I need. Here's your trip plan:\n- Paris (June 1-6)\n- Drive to Alps (6 hours)\n- Alps hiking (June 6-10)\n\nShall I create this trip?"
  },
  "notes": [ /* finalized notes */ ],
  "ready_to_build": true
}
```

### `POST /trips/{tripId}/import/build`
Confirm and build the DAG from the finalized conversation. The frontend sends the full conversation history; the backend extracts the final plan and creates nodes/edges in Firestore.

**Request**:
```json
{
  "messages": [ /* full conversation history */ ]
}
```

**Response** `201`:
```json
{
  "plan_id": "plan_xyz",
  "nodes_created": 5,
  "edges_created": 4
}
```

### Ongoing Trip Agent

### `POST /trips/{tripId}/agent/chat`
Send a message to the trip agent for ongoing management. The agent can modify the DAG, search for places, research destinations, etc. The backend persists conversation history in GCS (`{user_id}/{trip_id}/chat-history.json`) and loads it on each request. If the last interaction was >12h ago, a new session starts automatically.

**Request**:
```json
{
  "message": "Push our Paris stay back one day and find a good Italian restaurant near our hotel"
}
```

No `conversation_id` needed -- the backend resolves the active conversation from GCS by user ID + trip ID. One active conversation per user per trip.

**Response** `200`:
```json
{
  "reply": "Done! I've pushed Paris from June 1-6 to June 2-7, and all downstream nodes have been updated. I also found 3 Italian restaurants near your Paris hotel:\n\n1. Chez L'Ami Jean (4.6★) - 200m away\n2. Il Campionissimo (4.4★) - 350m away\n3. Osteria Ferrara (4.3★) - 500m away\n\nWould you like me to pin any of these to your Paris node?",
  "is_new_session": false,
  "actions_taken": [
    { "type": "node_updated", "node_id": "node_1", "description": "Paris dates shifted to June 2-7" },
    { "type": "cascade_applied", "affected_nodes": 4 },
    { "type": "places_searched", "results_count": 3 }
  ],
  "preferences_extracted": [
    { "content": "Prefer Italian restaurants", "category": "food" }
  ]
}
```

- `is_new_session`: `true` if the previous session expired (>12h) and a fresh conversation was started.
- `actions_taken`: Lets the frontend highlight affected nodes on the map. Changes are written to Firestore immediately and propagate to other users via onSnapshot.
- `preferences_extracted`: Preferences the agent extracted from this message. Saved to `trips/{tripId}/preferences` automatically. May be empty.

---

## User Profile & API Keys

### `GET /users/me`
Get the authenticated user's profile.

### `POST /users/me/api-keys`
Generate a new API key for MCP server access.

**Request**:
```json
{ "name": "Claude Desktop" }
```

**Response** `201`:
```json
{
  "id": "key_abc123",
  "name": "Claude Desktop",
  "key": "stb_k_a1b2c3d4e5f6...",
  "key_prefix": "stb_k_a1",
  "created_at": "2026-03-26T10:00:00Z"
}
```

**Note**: The `key` field is returned only once at creation time. Store it securely.

### `GET /users/me/api-keys`
List all API keys (prefix and metadata only, not full keys).

### `DELETE /users/me/api-keys/{keyId}`
Revoke an API key.

---

## Nodes

### `GET /trips/{tripId}/plans/{planId}/nodes`
List all nodes in a plan.

**Response** `200`:
```json
{
  "nodes": [
    { "id": "node_1", "name": "Paris", "type": "city", "lat_lng": { "lat": 48.8566, "lng": 2.3522 }, "arrival_time": "2026-06-01T10:00:00Z", "participant_ids": null, "order_index": 0 }
  ]
}
```

### `PATCH /trips/{tripId}/plans/{planId}/nodes/{nodeId}`
Update a node. Returns cascade preview if dates changed.

**Request**:
```json
{ "arrival_time": "2026-06-02T10:00:00Z", "duration_hours": 120 }
```

**Response** `200`:
```json
{
  "node": { /* updated node */ },
  "cascade_preview": {
    "affected_nodes": [
      { "id": "node_2", "name": "Alps", "old_arrival": "2026-06-06T10:00:00Z", "new_arrival": "2026-06-07T10:00:00Z" }
    ],
    "conflicts": []
  }
}
```

### `POST /trips/{tripId}/plans/{planId}/nodes/{nodeId}/cascade/confirm`
Confirm cascading update after preview.

**Response** `200`:
```json
{ "updated_count": 3 }
```

---

## Node Actions

### `POST /trips/{tripId}/plans/{planId}/nodes/{nodeId}/actions`
Add a note, todo, or place to a node. Available to all roles including Viewer.

**Request**:
```json
{ "type": "note", "content": "Nikola recommended Chez L'Ami Jean for dinner" }
```

**Response** `201`: Created action object.

### `GET /trips/{tripId}/plans/{planId}/nodes/{nodeId}/actions`
List all actions on a node.

---

## Edges

### `GET /trips/{tripId}/plans/{planId}/edges`
List all edges in a plan.

---

## Plans (Versioning)

### `POST /trips/{tripId}/plans`
Create an alternative plan (deep clone of active plan). Requires Planner or Admin role.

**Request**:
```json
{ "name": "Scenic Alternative", "source_plan_id": "plan_xyz" }
```

**Response** `201`: New plan object with status "draft".

### `POST /trips/{tripId}/plans/{planId}/promote`
Promote a draft plan to active. Requires Admin role.

**Response** `200`:
```json
{ "plan_id": "plan_alt", "status": "active", "previous_active": "plan_xyz" }
```

---

## Participant Path Assignment

### `PATCH /trips/{tripId}/plans/{planId}/nodes/{nodeId}/participants`
Assign participants to a node on a divergent path. Requires Admin or Planner role. Used at divergence points (nodes with multiple outgoing edges) and multi-start nodes to indicate which participants travel through this node.

**Request**:
```json
{ "participant_ids": ["user_abc", "user_def"] }
```

**Response** `200`:
```json
{ "node_id": "node_1", "participant_ids": ["user_abc", "user_def"] }
```

### `GET /trips/{tripId}/plans/{planId}/paths`
Compute participant paths for the current plan. Returns each participant's derived path through the DAG based on topology and participant assignments.

**Response** `200`:
```json
{
  "paths": {
    "user_abc": { "node_ids": ["node_1", "node_2", "node_5", "node_6"], "color": "#FF5733" },
    "user_def": { "node_ids": ["node_3", "node_4", "node_5", "node_6"], "color": "#3498DB" }
  },
  "unresolved": [
    { "user_id": "user_ghi", "divergence_node_id": "node_2", "message": "Participant not assigned at divergence point" }
  ]
}
```

### `GET /trips/{tripId}/plans/{planId}/warnings`
Check for unresolved participant flows (participants not assigned at divergence points).

**Response** `200`:
```json
{
  "warnings": [
    { "type": "unresolved_path", "user_id": "user_ghi", "user_name": "John", "divergence_node_id": "node_2", "divergence_node_name": "Denver" }
  ]
}
```

---

## Notifications

### `GET /trips/{tripId}/notifications`
List notifications for the authenticated user in this trip. Returns unread first, then read, most recent first.

**Query params**: `unread_only` (optional, boolean)

**Response** `200`:
```json
{
  "notifications": [
    { "id": "notif_abc", "type": "plan_promoted", "message": "Main plan updated to 'Scenic Alternative'", "is_read": false, "created_at": "2026-06-15T10:00:00Z" }
  ]
}
```

### `PATCH /trips/{tripId}/notifications/{notificationId}`
Mark a notification as read.

**Request**:
```json
{ "is_read": true }
```

**Response** `200`:
```json
{ "id": "notif_abc", "is_read": true }
```

---

## Pulse (Location Sharing)

### `POST /trips/{tripId}/pulse`
Submit a Pulse check-in with current GPS coordinates.

**Request**:
```json
{ "lat": 48.8566, "lng": 2.3522, "heading": 90 }
```

**Response** `200`:
```json
{ "updated_at": "2026-06-15T14:30:00Z" }
```

---

## Invite Links

### `POST /trips/{tripId}/invites`
Generate an invite link. Requires Admin role.

**Request**:
```json
{ "role": "planner", "expires_in_hours": 72 }
```

**Response** `201`:
```json
{ "token": "inv_abc123xyz", "url": "/invite/inv_abc123xyz", "role": "planner", "expires_at": "2026-03-29T10:00:00Z" }
```

### `POST /invites/{token}/claim`
Claim an invite link. User must be authenticated (Firebase ID token required). Adds user to trip with specified role.

**Response** `200`:
```json
{ "trip_id": "trip_abc123", "role": "planner" }
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to promote plans. Admin role required."
  }
}
```

**Common codes**: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `VALIDATION_ERROR` (422), `CONFLICT` (409)
