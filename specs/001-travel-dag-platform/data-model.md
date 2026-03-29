# Data Model: Travel DAG Platform

**Branch**: `001-travel-dag-platform` | **Date**: 2026-03-27

This data model describes the Firestore document structure for the Travel DAG Platform with implicit branching (paths derived from DAG topology and participant assignments, not stored as explicit branch entities).

## Entity Relationship Overview

```
User (root collection)
└── api_keys (subcollection: MCP API keys)

Trip (root collection)
├── participants: Map<userId, {role, joined_at}>
├── Plan (subcollection)
│   ├── Node (subcollection)
│   │   └── Action (subcollection: notes, todos, places)
│   └── Edge (subcollection)
├── Preference (subcollection: agent-extracted travel rules)
├── Location (subcollection: Pulse check-ins)
├── InviteLink (subcollection)
└── Notification (subcollection)

Note: Paths/branches are IMPLICIT — derived at runtime from DAG topology
      (edges) and participant_ids on nodes. No explicit branch entity exists.

Note: Magic Import sessions are ephemeral with respect to Firestore.
      Chat history (import + ongoing) is persisted to GCS.

GCS (google-cloud-storage):
└── {bucket}/
    └── {user_id}/
        └── {trip_id}/
            └── chat-history.json   # Agent conversation history (12h session TTL, 7-day bucket lifecycle)
```

---

## Collection: `trips`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `name` | string | Trip display name | Required, 1-200 chars |
| `created_by` | string | User ID of trip creator (Admin) | Required |
| `active_plan_id` | string | Reference to the current active plan | Required after import |
| `participants` | map | `{ userId: { role, joined_at } }` | role: 'admin' \| 'planner' \| 'viewer' |
| `created_at` | timestamp | Creation time | Auto-set |
| `updated_at` | timestamp | Last modification time | Auto-updated |

**State transitions**: Created (no plan) -> Importing -> Active (has active plan) -> Archived

**Note**: No `branches` map — paths are implicit, derived from DAG topology and `participant_ids` on nodes.

---

## Subcollection: `trips/{tripId}/plans`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `name` | string | Plan display name (e.g., "Main Route", "Scenic Alternative") | Required, 1-200 chars |
| `status` | string | Plan status | 'active' \| 'draft' \| 'archived' |
| `created_by` | string | User ID who created this plan version | Required |
| `parent_plan_id` | string \| null | ID of plan this was cloned from (for alternatives) | Null for original |
| `created_at` | timestamp | Creation time | Auto-set |

---

## Subcollection: `trips/{tripId}/plans/{planId}/nodes`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `name` | string | Location/stop display name | Required, 1-500 chars |
| `type` | string | Node category | 'city' \| 'hotel' \| 'restaurant' \| 'place' \| 'activity' |
| `lat_lng` | geopoint | Geographic coordinates | Required |
| `arrival_time` | timestamp | Expected arrival | Required |
| `departure_time` | timestamp \| null | Expected departure | Optional |
| `duration_hours` | number | Duration of stay in hours | Default: 0 |
| `participant_ids` | array\<string\> \| null | User IDs of participants who travel through this node. Null/empty = all participants (linear segment). Populated at divergence points and multi-start nodes. | Optional |
| `order_index` | number | Sequence position within the path | Required |
| `place_id` | string \| null | Google Maps Place ID (if resolved) | Optional |
| `created_by` | string | User ID who created this node | Required |
| `created_at` | timestamp | Creation time | Auto-set |
| `updated_at` | timestamp | Last modification time | Auto-updated |

**Implicit path derivation**: Paths are computed at runtime by traversing edges from each participant's assigned start/post-split node downstream. A node with `participant_ids = null/[]` is on a shared segment — all participants pass through it. A node with `participant_ids = ["user_a", "user_b"]` is on a divergent segment exclusive to those participants.

**Merge Node identification**: A node with multiple incoming edges (in-degree > 1) where the incoming edges originate from nodes on different computed paths. Detected structurally at runtime — not marked by a special field.

**Divergence point**: A node with multiple outgoing edges (out-degree > 1) leading to different paths. Participants must be assigned to the downstream nodes via `participant_ids` to resolve which path they take.

### Subcollection: `trips/{tripId}/plans/{planId}/nodes/{nodeId}/actions`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `type` | string | Action category | 'note' \| 'todo' \| 'place' |
| `content` | string | Text content or description | Required, 1-2000 chars |
| `place_data` | map \| null | `{ name, lat_lng, place_id, category }` for type='place' | Required if type='place' |
| `is_completed` | boolean | Completion status (for todos) | Default: false |
| `created_by` | string | User ID who created this action | Required |
| `created_at` | timestamp | Creation time | Auto-set |

---

## Subcollection: `trips/{tripId}/plans/{planId}/edges`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `from_node_id` | string | Source node reference | Required |
| `to_node_id` | string | Destination node reference | Required |
| `travel_mode` | string | Mode of transport | 'drive' \| 'flight' \| 'transit' \| 'walk' |
| `travel_time_hours` | number | Estimated travel duration in hours | Default: 0 |
| `distance_km` | number \| null | Estimated distance | Optional |

**Note**: No `branch_id` on edges — paths are derived from DAG topology and participant assignments on nodes.

---

## Subcollection: `trips/{tripId}/preferences`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `content` | string | The preference/rule/constraint in natural language | Required, 1-500 chars |
| `category` | string | Preference category | 'travel_rule' \| 'accommodation' \| 'food' \| 'budget' \| 'schedule' \| 'activity' \| 'general' |
| `extracted_from` | string | Brief context of the conversation that produced this | Required |
| `created_by` | string | User ID whose conversation produced this preference | Required |
| `created_at` | timestamp | Creation time | Auto-set |

**Shared**: All preferences are visible to and used by all trip members' agent sessions. Injected into the agent system prompt for every session.

---

## Subcollection: `trips/{tripId}/locations`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `user_id` | string | Document ID = user ID | Required |
| `coords` | geopoint | Last known coordinates | Required |
| `heading` | number | Compass heading in degrees | 0-360 |
| `updated_at` | timestamp | Time of last Pulse check-in | Auto-set |

---

## Collection: `users`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Firebase Auth UID (document ID) | Required |
| `display_name` | string | User display name | Required |
| `email` | string | User email | Required |
| `created_at` | timestamp | Account creation time | Auto-set |

### Subcollection: `users/{userId}/api_keys`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `name` | string | User-assigned label (e.g., "Claude Desktop") | Required, 1-100 chars |
| `key_hash` | string | HMAC-SHA256 of the API key using a server-side secret | Required |
| `key_prefix` | string | First 8 chars of the key (for display) | Required |
| `is_active` | boolean | Whether the key is active | Default: true |
| `created_at` | timestamp | Creation time | Auto-set |
| `last_used_at` | timestamp \| null | Last time the key was used | Updated on use |

**Note**: The plaintext API key is shown to the user only once at creation time. Only the HMAC-SHA256 hash (using a server-side secret from environment config) is stored. This provides defense-in-depth: even if the database is compromised, keys cannot be verified without the server secret.

---

## Magic Import (Ephemeral in Firestore, Persisted in GCS)

The Magic Import conversation is ephemeral with respect to Firestore -- no import session state is stored in Firestore. However, the chat history is persisted to GCS (`{user_id}/{trip_id}/chat-history.json`) so the Gemini agent retains context between turns. The frontend sends the full messages array on each import request. Only the final result (a Plan with Nodes and Edges) is persisted to Firestore.

## Agent Chat History (GCS)

Chat history for both import and ongoing agent conversations is stored in Google Cloud Storage as JSON.

- **Path**: `{bucket}/{user_id}/{trip_id}/chat-history.json`
- **Session TTL**: 12 hours from last interaction. If the file's `updated` metadata is >12h old, the backend starts a new session (overwrites the file).
- **Bucket lifecycle**: 7-day auto-delete policy. Files are automatically removed after 7 days regardless of session activity.
- **Isolation**: Each user has their own conversation file per trip. Users do not share conversation history.
- **Format**: JSON array of `{ role, content, timestamp }` messages.

---

## Subcollection: `trips/{tripId}/invite_links`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated token (URL-safe) | Required |
| `role` | string | Role assigned on join | 'planner' \| 'viewer' |
| `created_by` | string | Admin user ID | Required |
| `expires_at` | timestamp | Link expiration | Required |
| `is_active` | boolean | Whether link can still be used | Default: true |
| `created_at` | timestamp | Creation time | Auto-set |

---

## Subcollection: `trips/{tripId}/notifications`

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| `id` | string | Auto-generated UUID | Required |
| `type` | string | Notification category | 'plan_promoted' \| 'schedule_changed' \| 'edit_conflict' \| 'member_joined' \| 'unresolved_path' |
| `message` | string | Human-readable notification text | Required |
| `target_user_ids` | array\<string\> | Users who should see this | Required |
| `read_by` | array\<string\> | Users who have read this | Default: [] |
| `related_entity` | map | `{ type, id }` reference to related plan/node | Optional |
| `created_at` | timestamp | Creation time | Auto-set |

---

## Implicit Path Computation

Paths are derived at runtime — not stored. The algorithm:

1. **Build adjacency list** from edges: `Map<nodeId, List<{toNodeId, edgeId}>>`.
2. **Identify root nodes** (in-degree = 0): These are start nodes.
3. **For each participant**, determine their path:
   - If DAG has a single root: start there.
   - If DAG has multiple roots: find the root where the participant is in `participant_ids` (or the root they were assigned to at join time).
   - BFS/DFS downstream, following edges.
   - At divergence points (out-degree > 1): check `participant_ids` on each child node. Follow the child where the participant is listed. If the participant is not listed on any child → **unresolved flow** (warn Admin/Planner).
   - At merge nodes (in-degree > 1): continue downstream — the participant converges with others.
4. **Result**: `Map<userId, List<nodeId>>` — each participant's ordered path through the DAG.
5. **UI coloring**: Group participants with identical divergent-segment paths. Assign each group a distinct color.

**When to recompute**: On plan load, on node/edge add/remove, on `participant_ids` change.

---

## Real-time Listeners

The frontend uses Firestore `onSnapshot` listeners on the following collections to enable real-time collaboration:

- **Nodes**: `trips/{tripId}/plans/{planId}/nodes` -- map updates when any participant adds/moves/edits nodes
- **Edges**: `trips/{tripId}/plans/{planId}/edges` -- route changes reflected instantly
- **Locations**: `trips/{tripId}/locations` -- Pulse check-ins appear on map in real-time
- **Notifications**: `trips/{tripId}/notifications` -- in-app alerts appear immediately
- **Trip document**: `trips/{tripId}` -- active plan changes, participant updates

---

## Firestore Security Rules (Summary)

- **Users**: Read/write own document only. API keys subcollection: read/write own only.
- **Trips**: Read if user is a participant. Create if authenticated.
- **Plans/Nodes/Edges**: Read if trip participant. Write if role is 'admin' or 'planner'. Actions (notes/todos/places) writable by all roles including 'viewer'.
- **Locations**: Read if trip participant. Write own location only.
- **Invite Links**: Read by anyone (for claiming). Create/update by 'admin' only.
- **Notifications**: Read own notifications. Create by server only (via admin SDK).
- **Preferences**: Read if trip participant. Create by server only (via admin SDK, agent-extracted).

## Indexes Required

1. **Nodes by participant**: `trips/{}/plans/{}/nodes` -- composite index on `participant_ids` (array-contains) + `order_index` (ascending)
2. **Edges by source**: `trips/{}/plans/{}/edges` -- index on `from_node_id`
3. **Notifications by user**: `trips/{}/notifications` -- composite index on `target_user_ids` (array-contains) + `created_at` (descending)
4. **API keys by hash**: `users/{}/api_keys` -- index on `key_hash` + `is_active` (for MCP auth lookup)
