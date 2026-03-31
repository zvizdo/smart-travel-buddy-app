# Project Reference: Smart Travel Buddy

## Architecture Overview

Four sub-projects in a monorepo. Single `travel-app` conda env for all Python.

```
frontend/     Next.js 16.2 + React 19.2 + Tailwind 4 (pnpm)
backend/      FastAPI + google-cloud-firestore[async] + google-genai
shared/       Pydantic models + repositories + agent config + DAG logic (pip install -e)
mcpserver/    FastMCP server — streamable-http, per-request Bearer auth
```

Storage: Firestore (Native mode) + GCS for chat history.
Auth: Firebase Auth (frontend) -> `firebase-admin` token verification (backend). MCP server uses HMAC API keys (per-request Bearer token).
All Google Cloud auth via ADC — no service account JSON files.

## Deployment

Three Cloud Run services in `europe-west1`, GCP project `as-dev-anze`.

| Service | Cloud Run name | URL |
|---|---|---|
| Frontend | `smart-travel-buddy` | `https://smart-travel-buddy-px6atnevbq-ew.a.run.app` |
| Backend | `smart-travel-buddy-backend` | `https://smart-travel-buddy-backend-px6atnevbq-ew.a.run.app` |
| MCP Server | `smart-travel-buddy-mcpserver` | `https://smart-travel-buddy-mcpserver-px6atnevbq-ew.a.run.app` |

Deploy script: `./deploy/deploy.sh [setup|all|frontend|backend|mcpserver]`. Images stored in Artifact Registry (`europe-west1-docker.pkg.dev/as-dev-anze/stb-images`), tagged by git SHA. See `deploy/` for Dockerfiles and Cloud Build configs.

---

## Next.js 16 Breaking Changes (MUST READ)

- **`proxy.ts`** replaces `middleware.ts`. Export `function proxy()`, not `middleware()`. Config flag is `skipProxyUrlNormalize`.
- **Async request APIs**: `params`, `searchParams`, `cookies`, `headers` are all `Promise`. Must `await` them. Type helper: `PageProps<'/path/[param]'>` via `npx next typegen`.
- **Turbopack is default**. No `--turbopack` flag. Custom webpack configs fail unless `--webpack` passed.
- **React Compiler stable**: `reactCompiler: true` in next.config.ts (already enabled).
- **Cache APIs**: `cacheLife`/`cacheTag` stable (no `unstable_` prefix). `updateTag` for read-your-writes.
- Docs location: `node_modules/next/dist/docs/`

## Key Frontend Patterns

- **Server Components** are default. Use `"use client"` only for: maps, chat, real-time listeners, auth state, interactive forms.
- **Client-side params**: Use `useParams<{ tripId: string }>()` (no await needed in Client Components). For Server Components: `params: Promise<{ tripId: string }>` and `await params`.
- **Path alias**: `@/*` maps to `./` (e.g., `@/lib/firebase`, `@/components/map/trip-map`).
- **Providers** (`app/providers.tsx`): `AuthProvider` > `APIProvider` (Google Maps). Marked `"use client"`.
- **Firestore hooks** (`lib/firestore-hooks.ts`): `useTrip`, `useTripNodes`, `useTripEdges`, `usePulseLocations`, `useTripNotifications`. Return `{ data, loading, error }`. Use `onSnapshot` for real-time. Mutations go through backend API; all clients receive updates through listeners.
- **API client** (`lib/api.ts`): `api.get/post/patch/delete<T>`. Auto-injects Firebase Bearer token. Base: `NEXT_PUBLIC_BACKEND_URL/api/v1`. **Throws "Not authenticated" if `auth.currentUser` is null** — callers must wait for auth to be ready.
- **Directions hook** (`lib/use-directions.ts`): `useDirections(origin, destination)` -> `{ travelData, loading }`. Uses `google.maps.routes.Route.computeRoutes()` for travel time, distance, mode inference (>800km=flight, <3km=walk, else drive), and encoded route polyline. Haversine fallback on API failure.
- **Firebase** (`lib/firebase.ts`): Singleton. `getFirebaseAuth()`, `getFirestore()`. Firestore initialized with `persistentLocalCache` + `persistentMultipleTabManager` for offline.
- **Auth provider** (`components/auth/auth-provider.tsx`): `useAuth()` hook -> `{ user, loading, signInWithGoogle, signInWithApple, signInWithYahoo, signOut }`.
- **Proxy** (`proxy.ts`): Public paths: `/sign-in`, `/invite`. Invite URLs: `/invite/{tripId}/{token}`.

---

## Backend Architecture

### Entry Point & Config (`backend/src/main.py`)

Lifespan: `firebase_admin.initialize_app()`, `AsyncClient()`, `GCSClient()`, `RouteService(http_client)`. CORS from `CORS_ORIGINS` env. Exception handlers: `CycleDetectedError`->400 (`CYCLE_DETECTED` with `cycle_path`), `ValueError`->422, `PermissionError`->403, `LookupError`->404. Routers: trips, agent, nodes, edges, paths, notifications, invites, plans, users (all under `/api/v1`). Health: `GET /health`.

### Auth (`backend/src/auth/`)

- `get_current_user()`: `HTTPBearer` -> `auth.verify_id_token` via `asyncio.to_thread`. Returns decoded token dict (key: `uid`).
- `require_role(trip, user_id, *allowed_roles)`: checks `trip.participants[user_id].role`. Raises `PermissionError`.

### Repository Pattern

`BaseRepository` (`shared/shared/repositories/base_repository.py`): abstract `collection_path` (supports `{param}` placeholders), CRUD methods (`create`, `get`, `get_or_raise`, `update`, `delete`, `list_all`).

**Shared repositories** (`shared/shared/repositories/`) — used by both backend and mcpserver:

| Repository | Path | Notes |
|---|---|---|
| `TripRepository` | `trips` | `list_by_user(uid)` queries `participants.{uid}.role >= ""` |
| `PlanRepository` | `trips/{trip_id}/plans` | |
| `NodeRepository` | `trips/{trip_id}/plans/{plan_id}/nodes` | `batch_create` for bulk |
| `EdgeRepository` | `trips/{trip_id}/plans/{plan_id}/edges` | `batch_create` for bulk |
| `ActionRepository` | `trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions` | |
| `LocationRepository` | `trips/{trip_id}/locations` | user_id as doc ID |
| `UserRepository` | `users` | `create_or_update`, API keys subcollection |

**Backend-only repositories** (`backend/src/repositories/`) — backend-specific storage:

| Repository | Path | Notes |
|---|---|---|
| `ChatHistoryRepository` | GCS bucket | 12h TTL sessions |
| `InviteLinkRepository` | `trips/{trip_id}/invite_links` | |
| `NotificationRepository` | `trips/{trip_id}/notifications` | |
| `PreferenceRepository` | `trips/{trip_id}/preferences` | |

### Services (`backend/src/services/`)

| Service | Key methods |
|---|---|
| `TripService` | `create_trip` (caller=Admin, stores `display_name` in participant), `get_trip` (verifies participant), `list_trips` |
| `DAGService` | `create_plan_from_assembly`, `get_full_dag`, `create_node` (+connect), `delete_node` (+reconnect), `create_branch`, `update_node_with_cascade_preview` (BFS, auto-recalculates connected polylines on lat_lng change), `confirm_cascade`, `create_standalone_edge`, `delete_edge_by_id`, `split_edge` (atomic: delete old edge + create node + 2 new edges via batch write, proportional travel-time splitting), `create_connected_node` (multi-connection with cycle detection via `detect_cycle`, batch write), `cleanup_stale_participant_ids`. `_create_edge_if_new()` prevents duplicates + fires background polyline fetch. `_recalculate_connected_polylines()` fires background polyline fetch for all non-flight edges connected to a node. |
| `AgentService` | `import_chat` (Gemini->ImportChatResponse), `build_dag` (spine+branches->assemble_dag), `ongoing_chat` (AFC with DAG tools+grounding) |
| `PlanService` | `clone_plan` (deep clone, new UUIDs), `promote_plan` (swap active, demote old to draft), `delete_plan` (non-active only, batched: parallel list + WriteBatch delete of edges/actions/nodes/plan) |
| `NotificationService` | `create_notification`, `notify_member_joined`, `notify_unresolved_paths` |
| `InviteService` | `generate_invite` (token), `claim_invite` (adds participant with `display_name`) |
| `UserService` | `ensure_user` (upsert on sign-in), `update_user` (name, location tracking), `get_users_batch` (bulk name+setting lookup) |
| `RouteService` | `get_polyline(from_latlng, to_latlng, travel_mode)`, `fetch_and_patch_polyline` (fire-and-forget background task). Uses ADC + `x-goog-user-project` header for Google Routes API v2. Returns `None` for flights. |
| `ToolExecutor` | Dispatches `add/update/delete_node`, `add/delete_edge` to DAGService. Tracks `actions_taken`. |

### API Endpoints (`backend/src/api/`)

| File | Endpoints |
|---|---|
| `trips.py` | `POST/GET /trips`, `GET/DELETE /trips/{id}`, `PATCH /trips/{id}/settings` (admin only) |
| `agent.py` | `POST .../import/chat`, `POST .../import/build`, `POST .../agent/chat` (with optional `plan_id`) |
| `nodes.py` | CRUD + `POST .../nodes/connected` (multi-connection with cycle detection), `POST .../branch`, `POST .../cascade/confirm`, `PATCH .../participants`, `POST/DELETE .../choose` |
| `edges.py` | `GET .../edges`, `POST .../edges/{edge_id}/split` (insert node between endpoints) |
| `paths.py` | `GET .../paths` (compute paths), `GET .../warnings` (unresolved flows) |
| `notifications.py` | `GET /trips/{id}/notifications`, `PATCH .../notifications/{id}` |
| `invites.py` | `POST .../invites`, `POST .../invites/{token}/claim` |
| `plans.py` | `POST/GET /trips/{id}/plans`, `DELETE .../plans/{id}`, `POST .../plans/{id}/promote` |
| `pulse.py` | `POST /trips/{id}/pulse` (checks `location_tracking_enabled`) |
| `users.py` | `GET/PATCH /users/me`, `POST /users/batch` |

---

## Shared Library (`shared/`)

Installed as `pip install -e shared/`. Imported as `from shared.models import ...`, `from shared.repositories import ...`, `from shared.agent.config import ...`, `from shared.dag.assembler import ...`.

### Models (`shared/shared/models/`)

All Pydantic `BaseModel` with `StrEnum` for enums. Barrel export from `__init__.py`. **All datetimes are UTC-aware** via `datetime.now(UTC)`.

| Model | Key Fields | Notes |
|---|---|---|
| `Trip` | `id, name, created_by, active_plan_id, participants, settings, created_at, updated_at` | `Participant(role: TripRole, display_name, joined_at)`. Roles: admin/planner/viewer. `TripSettings`: datetime_format, date_format, distance_unit. |
| `User` | `id, display_name, email, location_tracking_enabled, created_at` | Stored at `users/{uid}`. `location_tracking_enabled` defaults to `false`. |
| `Plan` | `id, name, status: PlanStatus, created_by, parent_plan_id` | Status: active/draft/archived |
| `Node` | `id, name, type: NodeType, lat_lng, arrival_time, departure_time, duration_hours, timezone, participant_ids, order_index, place_id, created_by` | Types: city/hotel/restaurant/place/activity. `participant_ids=None` = shared. `timezone`: IANA string (e.g., "Europe/Paris") for local time display. |
| `Edge` | `id, from_node_id, to_node_id, travel_mode, travel_time_hours, distance_km, route_polyline` | Modes: drive/flight/transit/walk. `route_polyline`: encoded polyline from Routes API (null = straight line fallback). **No branch_id** — paths are implicit. |
| `Notification` | `id, type, message, target_user_ids, read_by, expire_at` | TTL: `expire_at = created_at + 7 days`. Firestore TTL auto-deletes. |
| `Preference` | `id, content, category, extracted_from` | Categories: travel_rule/accommodation/food/budget/schedule/activity/general |

### Agent (`shared/shared/agent/`)

- **`schemas.py`**: `ImportChatResponse(reply, notes, ready_to_build)`, `AgentReply(reply, preferences_extracted)`, `OngoingChatResponse(reply, actions_taken, preferences_extracted)`.
- **`config.py`**: `IMPORT_SYSTEM_PROMPT`, `ONGOING_SYSTEM_PROMPT` (confirm-before-acting). Grounding tools are SDK built-ins.
- **`definitions.py`**: `DAG_TOOL_DEFINITIONS` — SDK-agnostic dicts with JSON Schema (reference only). Actual AFC tools live in `backend/src/services/agent_tools.py` as async callables with type hints + docstrings that the SDK auto-converts to FunctionDeclarations. Five tools: `add_node`, `update_node`, `delete_node`, `add_edge`, `delete_edge`.

### DAG (`shared/shared/dag/`)

- **`assembler.py`**: `assemble_dag(notes, geocoded_locations, created_by, start_date?)`. Infers `NodeType` from name heuristics, `TravelMode` from distance (>800km=flight, <3km=walk, else drive). **Branching**: locations with `branch_group` → 4-phase algorithm. Connection resolution (3-tier fallback): name-based → index-based → positional heuristic.
- **`cycle.py`**: Pure cycle detection module (no I/O). `detect_cycle(existing_edges, new_node_id, incoming_node_ids, outgoing_node_ids)` — iterative DFS with gray-set (three-color) marking, returns cycle path or `None`. `CycleDetectedError(cycle_path)` exception. `get_ancestors(node_id, edges)` / `get_descendants(node_id, edges)` — BFS-based reachability helpers. Tests: `shared/tests/test_cycle.py`.
- **`paths.py`**: `compute_participant_paths(nodes, edges, participant_ids) -> PathResult(paths, unresolved)`. BFS per participant. At divergence (out-degree > 1): follow assigned child, fallback to shared, or flag unresolved. **Multi-root divergence**: when DAG has 2+ root nodes (in-degree = 0), treated as a virtual `__root__` divergence — participants must choose a starting point, same as downstream divergences. `detect_divergence_points()` returns `__root__` entry for multi-root DAGs alongside regular divergences. `detect_unresolved_flows()` and `compute_participant_paths()` generate `__root__` warnings for unassigned participants. Frontend mirror: `frontend/lib/path-computation.ts`.

---

## Firestore Collection Structure

```
trips/{tripId}                         # Trip doc (participants map, active_plan_id)
  plans/{planId}                       # Plan versions (active/draft/archived)
    nodes/{nodeId}                     # DAG vertices
      actions/{actionId}               # Notes, todos, places
    edges/{edgeId}                     # DAG edges
  preferences/{prefId}                 # Agent-extracted travel rules
  locations/{userId}                   # Pulse check-in
  invite_links/{token}                 # Invite tokens
  notifications/{notifId}              # In-app alerts (TTL on expire_at)
users/{userId}                         # User profile (display_name, email, location_tracking_enabled)
  api_keys/{keyId}                     # MCP API keys (hashed)
GCS: {bucket}/{user_id}/{trip_id}/chat-history.json  # 12h session, 7-day lifecycle
```

**Implicit branching**: No `branch_id` on edges. Paths derived at runtime from DAG topology + `participant_ids`. Divergence = out-degree > 1 **or** multiple root nodes (`__root__` virtual divergence). Merge = in-degree > 1.

---

## Frontend Pages & Components

### Pages (`frontend/app/`)

| Route | Key details |
|---|---|
| `/` | Trip list via `api.get("/trips")`. Profile avatar in header links to `/profile`. |
| `/sign-in` | Google/Apple/Yahoo sign-in |
| `/profile` | User profile: editable display name (syncs to Firebase + Firestore), location sharing toggle, sign out. |
| `/trips/new` | Create trip -> redirect to import |
| `/trips/[tripId]` (layout) | `TripContext` with `onSnapshot` for real-time `active_plan_id`. Persists `viewedPlanId`. Enriches participants with display names and `location_tracking_enabled` via `POST /users/batch`. |
| `/trips/[tripId]` (page) | Map view: node CRUD, edge splitting (insert stop), multi-connection node creation, path filtering, divergence resolver, cascade preview, plan switcher, agent overlay, pulse check-in, offline banner. Profile avatar in header. `displayPlanId = viewedPlanId ?? activePlanId`. `hasBranches` detects divergences from out-degree > 1 **or** multiple root nodes. Tracks `recalculatingEdges` state — set when node location changes, cleared when Firestore delivers updated polylines via `onSnapshot`. |
| `/trips/[tripId]/import` | Magic Import chat (10K char limit, send/skip/build) |
| `/trips/[tripId]/settings` | Settings, invites, plan versioning (create/promote/delete). Participants shown as "FirstName L." via `formatUserName()`. |
| `/invite/[tripId]/[token]` | Invite claim page |

### Key Components

| Component | Purpose |
|---|---|
| `TripMap` | Google Map with markers + polylines. Fan-out algorithm displaces co-located nodes radially (bounded 60px drift). Initial view: `fitBounds` with asymmetric padding, zoom clamped 3-14. |
| `NodeMarker` | Map marker with type-colored icon badge, name label, merge indicator. Exports `TYPE_TOKENS` and `FALLBACK_TOKEN` color maps. Fan-out: hides label, `pointerEvents: "none"` on container. |
| `EdgePolyline` | Renders route polylines (decoded or straight-line fallback) with travel-mode dash patterns, midpoint badge (time/distance), opacity animation for dimming. `recalculating` prop: RAF-based shimmer animation (neutral gray, oscillating opacity), badge shows spinner + "Updating..." text. |
| `FanOutTether` | Dashed tether line + anchor dot connecting displaced fan-out markers to real lat/lng. Rendered as non-clickable `google.maps.Polyline` with icon sequences. |
| `NodeDetailSheet` | Bottom sheet: view/edit/branch modes with two-click delete |
| `NodeEditForm` | Edit node fields. `DateTimePicker` for times. Departure-before-arrival validation. |
| `EdgeDetail` | Edge click bottom sheet with travel info and "Insert stop here" CTA for edge splitting. |
| `AddNodeSheet` / `BranchForm` | Add/branch nodes with travel data auto-computation. AddNodeSheet supports insert mode (`insertBetween` prop: locked connection card, two leg travel rows, calls split endpoint) and advanced multi-connection mode (`ConnectionSelector` with cycle pre-filtering, calls connected endpoint). |
| `ConnectionSelector` | Two-column "Coming from" / "Going to" connection picker with searchable node dropdowns. Client-side cycle pre-filtering via `getAncestors`/`getDescendants` disables cycle-creating options. "Simple mode" link to collapse back. |
| `DivergenceResolver` | Bottom overlay for path choices. Shows participant names via `formatUserName()`. Detects divergences from adjacency (out-degree > 1) **and** multiple root nodes (virtual `__root__` divergence). Admin sees other participants' unresolved. Stays mounted with `hidden` prop. |
| `ParticipantAssignment` | Modal for assigning participants to nodes. Shows names via `formatUserName()`. |
| `PathFilter` | Toggle "All Paths" / "My Path" with dimming |
| `CascadePreview` | Preview cascading schedule changes (BFS) |
| `PlanSwitcher` | Dropdown for active/draft/archived plans |
| `AgentOverlay` | Slide-up chat, sends `plan_id` to scope agent to viewed plan |
| `ProfileAvatar` | Reusable avatar showing user initials, links to `/profile`. Used in home and trip headers. |
| `PulseButton` | GPS check-in. Hidden when `location_tracking_enabled` is false. Fetches user profile on mount. |
| `PulseAvatars` | Other users' positions on map. Filters out users with `location_tracking_enabled: false`. |
| `OfflineBanner` | Disables edit actions when offline. Offline queue for pulse. Absolutely positioned below glass header in trip map (`top-12 z-20`). |

---

## MCP Server (`mcpserver/`)

FastMCP server exposing trip management tools to external AI agents (e.g. Claude Desktop) via the Model Context Protocol.

### Transport & Auth
- **Transport**: `streamable-http` (Cloud Run) or `stdio` (local dev). Configured via `MCP_TRANSPORT` env var.
- **HTTP auth**: Per-request `Authorization: Bearer <api_key>` header. `ApiKeyTokenVerifier` (`mcpserver/src/auth/api_key_auth.py`) resolves the key to a `user_id` via HMAC-SHA256 + Firestore lookup (`users/{uid}/api_keys`).
- **stdio auth**: Falls back to `MCP_API_KEY` env var resolved once at startup.
- **`_LazyTokenVerifier`**: FastMCP must be instantiated at module level for `@mcp.tool()` decorators, but the real verifier needs a Firestore client from lifespan. The lazy wrapper delegates once the lifespan has set it.

### Entry Point (`mcpserver/src/main.py`)
Lifespan: `firebase_admin.initialize_app()`, `AsyncClient()`, build services. For HTTP transports, runs via `uvicorn.run(mcp.streamable_http_app() / mcp.sse_app(), ...)`. `MCP_SERVER_URL` is used as the `AuthSettings.issuer_url` and `resource_server_url` (auto-set to Cloud Run URL post-deploy).

### Config (`mcpserver/src/config.py`)
Reads: `API_KEY_HMAC_SECRET`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_MAPS_API_KEY`, `MCP_TRANSPORT` (default `stdio`), `MCP_HOST` (default `0.0.0.0`), `MCP_PORT` (default `8080`), `MCP_SERVER_URL`.

### Services (`mcpserver/src/services/`)
| Service | Notes |
|---|---|
| `TripService` | Read/write trip DAG operations via shared repositories |
| `PlacesService` | Google Places API wrapper for location search |

### Tools (`mcpserver/src/tools/`)
| File | Tools |
|---|---|
| `trips.py` | List and read trips |
| `modify.py` | Add/update/delete nodes and edges |
| `actions.py` | Manage node actions (notes, todos, places) |
| `places.py` | Search for places via Google Places |

---

## Gemini Agent Integration

- SDK: `google-genai`. Client: `genai.Client(vertexai=True)`. Model: env `GEMINI_MODEL` (default `gemini-3-flash-preview`).
- Structured output: `response_mime_type="application/json"` + `response_schema` (Pydantic model).
- **Grounding tools**: `types.Tool(google_maps=types.GoogleMaps())`, `types.Tool(google_search=types.GoogleSearch())`.
- **DAG tools (AFC)**: Async callables via `AutomaticFunctionCallingConfig(maximum_remote_calls=10)`. `ToolExecutor` dispatches to `DAGService`. Actions tracked by executor, not LLM.
- **Confirm-first**: Agent proposes changes, executes only after user confirms.
- **Import flow**: Ephemeral (full `messages` array per request). Build step: Gemini returns JSON -> `assemble_dag()`.

---

## Key Patterns & Gotchas

- **Auth race condition**: `auth.currentUser` is null on initial page load. Always check `useAuth()` `loading`/`user` before API calls.
- **Firestore `__name__`**: Full document path, not just ID. Use `where("id", "==", ...)` or direct lookup.
- **Firestore composite indexes**: `array_contains` + `order_by` requires composite index. Sort in Python instead.
- **Date handling**: `@/lib/dates.ts` utilities with `Intl.DateTimeFormat`. `DateTimePicker` component for inputs. Departure-before-arrival validation in all forms.
- **User display names**: `@/lib/user-display.ts` — `formatUserName()` returns "FirstName L." format; `getInitials()` for avatars. Participant records may lack `display_name` for legacy data; trip layout enriches via `POST /users/batch`. Always use `formatUserName(participant.display_name, uid)`, never show raw UIDs.
- **Location tracking**: Controlled by `User.location_tracking_enabled`. Backend pulse endpoint rejects if disabled. `PATCH /users/me` with `location_tracking_enabled: false` deletes all location docs. Frontend `PulseButton` hides when disabled; `PulseAvatars` filters out disabled users.
- **CSS height chain**: Google Maps needs explicit height: `html.h-full > body.h-full > container.h-full > map.h-full`. Use `min-h-0` on flex children.
- **Root layout**: `body` uses `h-full flex flex-col` (not `min-h-full`).
- **Trip map overlay stacking**: Glass header is `absolute z-20`. OfflineBanner is `absolute top-12 z-20` (below header). DivergenceResolver is `absolute bottom-[nav] z-20`. Bottom nav is `z-30`.
- **Duplicate edge prevention**: `DAGService._create_edge_if_new()` on all user-facing creation paths.
- **Bottom sheet state**: `DivergenceResolver` uses `hidden` prop (not conditional render) to preserve collapsed state.
- **Node popups**: One `InfoWindow` at a time via parent-controlled `selectedNodeId`.
- **Route polyline flow**: Frontend `useDirections` computes polyline via client-side Routes API → passed through API to backend → stored on Edge. Agent-created edges get polyline via backend `RouteService` fire-and-forget task. Node location updates trigger `_recalculate_connected_polylines()` which fires background polyline fetch for all connected non-flight edges; frontend tracks recalculating state and clears it when Firestore `onSnapshot` delivers updated polylines. Fan-out tethers and edge polylines use `clickable: false` / `pointerEvents: "none"` to avoid intercepting node/edge clicks.
