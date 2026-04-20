# Project Reference: Smart Travel Buddy

## Architecture Overview

Four sub-projects in a monorepo. Single `travel-app` conda env for all Python.

```
frontend/     Next.js 16.2 + React 19.2 + Tailwind 4 (pnpm)
backend/      FastAPI + google-cloud-firestore[async] + google-genai
shared/       Pydantic models + repositories + agent config + DAG logic + services (pip install -e)
mcpserver/    fastmcp 3.2 server — streamable-http only, per-request Bearer auth
```

Storage: Firestore (Native mode) + GCS for chat history.
Auth: Firebase Auth (frontend) -> `firebase-admin` token verification (backend). MCP server uses HMAC API keys.
All Google Cloud auth via ADC — no service account JSON files.
Deploy: `./deploy/deploy.sh [setup|all|frontend|backend|mcpserver]`. Images in Artifact Registry (`europe-west1-docker.pkg.dev/as-dev-anze/stb-images`), tagged by git SHA.

## Deep-Dive References

Detailed subsystem docs live in [`references/`](./references/):

- [MCP_SERVER.md](./references/MCP_SERVER.md) — fastmcp entry point, auth gates, tool response contract, MCP-specific behaviors.
- [TIMELINE.md](./references/TIMELINE.md) — layout engine, zoom levels, per-day pxPerMinute, sticky content, "joins later" placeholder, memo discipline.
- [ROUTING.md](./references/ROUTING.md) — `RouteService`, flight estimate notes, polyline recalculation, airport resolver.
- [TIME_INFERENCE.md](./references/TIME_INFERENCE.md) — `enrich_dag_times()`, flex timing model, merge-node per-branch arrivals.
- [FRONTEND_GOTCHAS.md](./references/FRONTEND_GOTCHAS.md) — API retry, map camera, React Compiler refs, Gemini AFC tool signatures.
- [BACKEND_GOTCHAS.md](./references/BACKEND_GOTCHAS.md) — input bounds, side-effect isolation, PATCH body handling, dev uvicorn.
- [ANALYTICS.md](./references/ANALYTICS.md) — Firebase Analytics (GA4), event registry, opt-out, MCP Measurement Protocol.

---

## Next.js 16 Breaking Changes (MUST READ)

- **`proxy.ts`** replaces `middleware.ts`. Export `function proxy()`, not `middleware()`.
- **Async request APIs**: `params`, `searchParams`, `cookies`, `headers` are all `Promise`. Must `await` them.
- **Turbopack is default**. Custom webpack needs `--webpack` flag.
- **React Compiler stable**: `reactCompiler: true` in next.config.ts (already enabled).

## Key Frontend Patterns

- **Server Components** are default. Use `"use client"` only for: maps, chat, real-time listeners, auth state, interactive forms.
- **Path alias**: `@/*` maps to `./`. **Providers** (`app/providers.tsx`): `AuthProvider` > `APIProvider` (Google Maps).
- **Firestore hooks** (`lib/firestore-hooks.ts`): `useTrip`, `useTripPlans`, `useTripNodes`, `useTripEdges`, `usePulseLocations`, `useNodeActions`. Return `{ data, loading, error }`. Use `onSnapshot` for real-time.
- **API client** (`lib/api.ts`): `api.get/post/patch/delete<T>(path, body?, signal?)`. Auto-injects Firebase Bearer token. Base: `NEXT_PUBLIC_BACKEND_URL/api/v1`. Throws if `auth.currentUser` is null. See [FRONTEND_GOTCHAS.md](./references/FRONTEND_GOTCHAS.md) for retry semantics.
- **Directions hook** (`lib/use-directions.ts`): `useDirections(origin, destination)` -> `{ travelData, loading }`. Mode inference: >800km=flight, <3km=walk, else drive. Ferry is agent-set only (not auto-inferred). Haversine fallback.
- **Auth provider** (`components/auth/auth-provider.tsx`): `useAuth()` -> `{ user, loading, signInWithGoogle, signInWithApple, signInWithYahoo, signOut }`.
- **Proxy** (`proxy.ts`): Public paths: `/sign-in`, `/invite`. Invite URLs: `/invite/{tripId}/{token}`.

---

## Backend Architecture

### Entry Point (`backend/src/main.py`)
Lifespan: `firebase_admin.initialize_app()`, `AsyncClient()`, `GCSClient()`, `RouteService(http_client)`. CORS from `CORS_ORIGINS`. Exception handlers: `CycleDetectedError`->400, `ConflictError`->409, `ValueError`->422, `PermissionError`->403, `LookupError`->404. All routers under `/api/v1`. Health: `GET /health`.

### Auth (`backend/src/auth/`)
`get_current_user()`: `HTTPBearer` -> `auth.verify_id_token`. Returns decoded token dict (key: `uid`).
`require_role(trip, user_id, *allowed_roles)`: checks `trip.participants[user_id].role`. Raises `PermissionError`.

### Repository Pattern
`BaseRepository` (`shared/shared/repositories/base_repository.py`): abstract `collection_path` with `{param}` placeholders, CRUD methods.

**Shared repos** (`shared/shared/repositories/`): `TripRepository`, `PlanRepository`, `NodeRepository` (batch_create), `EdgeRepository` (batch_create), `ActionRepository`, `LocationRepository`, `UserRepository`.
**Backend-only repos** (`backend/src/repositories/`): `ChatHistoryRepository` (GCS, 12h TTL), `InviteLinkRepository`, `NotificationRepository`, `PreferenceRepository`.

### Services (`backend/src/services/`)

| Service | Key methods |
|---|---|
| `TripService` | `create_trip`, `get_trip` (verifies participant), `list_trips` |
| `DAGService` | **In `shared/shared/services/`**. Node/edge CRUD, cycle detection, polyline management. `update_node_only` (agent/MCP path, no propagation) + `update_node_with_impact_preview` (REST path, returns enrichment diff). `create_standalone_edge()` rejects cycles via `would_create_cycle()` before fetching route data. |
| `AgentService` | `import_chat`, `build_dag` (AFC with tools), `ongoing_chat` (AFC with DAG tools+grounding). |
| `AgentUserContext` | `build_user_context()` — computes role, can_mutate, resolved path for the chatting user. |
| `ToolExecutor` | Dispatches `add/update/delete_node`, `add/delete_edge`, `get_plan` to DAGService. `update_node` uses `update_node_only` (no cascade). Converts `lat/lng` to `lat_lng` sub-object. Tracks `actions_taken`. |
| `PlanService` | **In `shared/shared/services/`**. `clone_plan`, `promote_plan`, `delete_plan` (cascading batch delete). `notification_service` is optional — backend injects it, MCP passes `None` and `promote_plan` skips the notification step. |
| `RouteService` | **In `shared/shared/services/`**. Google Routes API v2 + flights via `FlightService`. See [ROUTING.md](./references/ROUTING.md) for flow, field mask, and fallback semantics. |
| `FlightService` | **In `shared/shared/services/`**. Google Flights search via `fli` library (pip: `flights`). `search(origin, destination, date, ...)` -> `FlightSearchResult`. Sync `curl_cffi` bridged to async via `asyncio.to_thread()`. No API key needed. |
| `NotificationService` | `create_notification`, `notify_member_joined`, `notify_member_removed`, `notify_role_changed` |
| `InviteService` | `generate_invite` (token), `claim_invite` (adds participant) |
| `UserService` | `ensure_user`, `update_user`, `get_users_batch` |

### API Endpoints (`backend/src/api/`)

| File | Endpoints |
|---|---|
| `trips.py` | `POST/GET /trips`, `GET/DELETE /trips/{id}`, `PATCH /trips/{id}/settings` |
| `agent.py` | `POST .../import/chat`, `POST .../import/build`, `GET/DELETE .../agent/history`, `POST .../agent/chat` |
| `nodes.py` | CRUD + `POST .../nodes/connected`, `POST .../branch`, `PATCH .../participants`, `POST/DELETE .../choose` |
| `edges.py` | `GET .../edges`, `PATCH .../edges/{edge_id}`, `POST .../edges/{edge_id}/split`, `POST .../edges/{edge_id}/refresh` (admin-only dev helper) |
| `paths.py` | `GET .../paths`, `GET .../warnings` |
| `plans.py` | `POST/GET /trips/{id}/plans`, `DELETE .../plans/{id}`, `POST .../plans/{id}/promote` |
| `participants.py` | `DELETE/PATCH /trips/{id}/participants/{user_id}` |
| `notifications.py` | `GET /trips/{id}/notifications`, `PATCH .../notifications/{id}` |
| `invites.py` | `POST .../invites`, `POST .../invites/{token}/claim` |
| `pulse.py` | `POST /trips/{id}/pulse` |
| `users.py` | `GET/PATCH /users/me`, `POST /users/batch`, `POST/GET /users/me/api-keys`, `DELETE /users/me/api-keys/{id}` |

---

## Shared Library (`shared/`)

### Models (`shared/shared/models/`)
All Pydantic `BaseModel` with `StrEnum`. **All datetimes UTC-aware** via `datetime.now(UTC)`.

| Model | Key Fields |
|---|---|
| `Trip` | `id, name, created_by, active_plan_id, participants: dict[str, Participant], settings: TripSettings` (incl. `no_drive_window: NoDriveWindow \| None`, `max_drive_hours_per_day: float \| None` for flex planning) |
| `Plan` | `id, name, status: PlanStatus (active/draft/archived), created_by, parent_plan_id` |
| `Node` | `id, name, type: NodeType (city/hotel/restaurant/place/activity), lat_lng, arrival_time?, departure_time?, duration_minutes?, timezone, participant_ids, place_id, created_by` (all timing fields optional — enriched at read time) |
| `Edge` | `id, from_node_id, to_node_id, travel_mode (drive/ferry/flight/transit/walk), travel_time_hours, distance_km, route_polyline, notes, route_updated_at` (route_updated_at written by background route fetch on every attempt, success or failure) |
| `Notification` | `id, type, message, target_user_ids, read_by, expire_at` (7-day TTL) |
| `Preference` | `id, content, category, extracted_from, created_by` |

### Agent (`shared/shared/agent/`)

- **`schemas.py`**: `ImportChatResponse(reply, notes, ready_to_build)`, `AgentReply(reply, preferences_extracted)`, `OngoingChatResponse(reply, actions_taken, preferences_extracted)`, `BuildDagReply(summary, node_count, edge_count)`, `BuildDagResponse(summary, actions_taken, node_count, edge_count)`.
- **`config.py`**: `IMPORT_SYSTEM_PROMPT`, `ONGOING_SYSTEM_PROMPT` (confirm-before-acting), `BUILD_SYSTEM_PROMPT` (4-phase: spine nodes -> branch nodes -> edges -> verify). Response schemas: `RESPONSE_SCHEMA`, `ONGOING_RESPONSE_SCHEMA`, `BUILD_RESPONSE_SCHEMA`.

### Agent Tools (`backend/src/services/agent_tools.py`)

`_define_all_tools(executor)` defines all 6 DAG tools once (`add_node`, `update_node`, `delete_node`, `add_edge`, `delete_edge`, `get_plan`).
- `create_agent_tools(executor, can_mutate)`: all 6 if can_mutate, else just `get_plan`.
- `create_build_tools(executor)`: `add_node`, `add_edge`, `delete_node`, `delete_edge`, `get_plan` (excludes `update_node`).
- `create_search_tools(flight_service)`: `find_flights` — standalone async callable that bypasses `ToolExecutor` (read-only, not a DAG mutation). Added to ongoing chat tools alongside DAG tools.

### DAG (`shared/shared/dag/`)
- **`cycle.py`**: `detect_cycle()` — iterative DFS for multi-connection node insertion. `would_create_cycle(from_id, to_id, edges)` — BFS check for standalone edge creation. `CycleDetectedError`, `get_ancestors/get_descendants`.
- **`paths.py`**: `compute_participant_paths()` — BFS per participant. Multi-root `__root__` divergence handling. `detect_divergence_points()`. Frontend mirror: `frontend/lib/path-computation.ts`.
- **`time_inference.py`**: `enrich_dag_times()` — forward-only topological time enrichment. See [TIME_INFERENCE.md](./references/TIME_INFERENCE.md) for night rule, drive-cap, merge-node per-branch arrivals.

### Tools (`shared/shared/tools/`)
- **`trip_context.py`**: `format_trip_context()` — shared markdown formatter used by both in-app agent and MCP server.
- **`definitions.py`**: `DAG_TOOL_DEFINITIONS` — SDK-agnostic tool schemas consumed by both Gemini AFC and MCP `@mcp.tool()` handlers.
- **`timezone.py`**: `resolve_timezone(lat, lng)` — IANA timezone resolution via `timezonefinder`.
- **`airport_resolver.py`**: IATA resolution for flight edges. See [ROUTING.md](./references/ROUTING.md).
- **`id_gen.py`**: `node_id()`, `edge_id()`, `plan_id()`, `trip_id()`, `action_id()` — short typed IDs (e.g. `n_k3xd9mpq`).

---

## Firestore Structure

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
users/{userId}                         # User profile
  api_keys/{keyId}                     # MCP API keys (hashed)
GCS: {bucket}/{user_id}/{trip_id}/chat-history.json  # 12h session, 7-day lifecycle
```

---

## Frontend Pages & Components

### Pages (`frontend/app/`)

| Route | Key details |
|---|---|
| `/` | Trip list. Profile avatar links to `/profile`. |
| `/sign-in` | Google/Apple/Yahoo sign-in |
| `/profile` | Editable display name, location sharing toggle, sign out. |
| `/trips/new` | Create trip -> redirect to import |
| `/trips/[tripId]` (layout) | `TripContext` with real-time `active_plan_id`. Enriches participants via `POST /users/batch`. |
| `/trips/[tripId]` (page) | Map view: full node/edge CRUD, path filtering, divergence resolver, inline impact preview, plan switcher, agent overlay, pulse, offline banner. Uses `useEnrichedNodes()` hook (wraps `useTripNodes` + `useTripEdges`, memoizes `enrichDagTimes` on identity). |
| `/trips/[tripId]/import` | Magic Import chat. Build triggers `BuildProgress` animation (SVG graph + activity feed). |
| `/trips/[tripId]/settings` | Settings, invites, plan versioning (create/promote/delete). |
| `/invite/[tripId]/[token]` | Invite claim page |

### Key Components

| Component | Purpose |
|---|---|
| `TripMap` | Google Map with markers + polylines. Fan-out for co-located nodes. `fitBounds` with zoom clamp 3-14. See [FRONTEND_GOTCHAS.md](./references/FRONTEND_GOTCHAS.md) for camera stability. |
| `NodeMarker` | Type-colored icon badge, name label. Exports `TYPE_TOKENS` / `FALLBACK_TOKEN`. |
| `EdgePolyline` | Route polylines with mode dash patterns, midpoint badge. `recalculating` shimmer animation. |
| `BuildProgress` | Build animation: SVG node graph canvas, activity feed, phase indicators (preparing->nodes->edges->verifying->complete). |
| `NodeDetailSheet` | Bottom sheet: view/edit/branch modes with two-click delete |
| `CreateNodeForm` | Unified node-creation form for all contexts: standalone (map tap / timeline +), insert (edge split), and branch (side trip). Uses discriminated union `CreateContext` prop. |
| `TimingFieldsSection` | Shared controlled timing sub-component used by both `CreateNodeForm` and `NodeEditForm`. Renders the four-shape timing model: Fixed time, Float, Know when I arrive, Know when I leave. |
| `DivergenceResolver` | Path choices overlay. Handles out-degree>1 and `__root__` divergence. Uses `hidden` prop. |
| `AgentOverlay` | Slide-up chat, sends `plan_id` to scope agent to viewed plan |
| `PulseButton` / `PulseAvatars` | GPS check-in + other users' positions. Hidden when `location_tracking_enabled` is false. |
| `OfflineBanner` | Inline banner with offline status via `useOnlineStatus()` hook. Disables edits when offline. |
| `TimelineView` / `TimelineLane` / `TimelineNodeBlock` / `TimelineEdgeConnector` | Vertical timeline with date gutter, multi-lane, zoom 0-6. See [TIMELINE.md](./references/TIMELINE.md). |
| `ErrorBoundary` | Class component in `components/error-boundary.tsx`. Wraps `/trips/[tripId]` layout. Catches render errors, logs componentStack, shows retry button. Accepts optional `fallback(error, retry)` render prop. |

---

## Gemini Agent Integration

- SDK: `google-genai`. Client: `genai.Client(vertexai=True)`. Model: env `GEMINI_MODEL` (default `gemini-3-flash-preview`).
- **Grounding tools**: `types.Tool(google_maps=types.GoogleMaps())`, `types.Tool(google_search=types.GoogleSearch())`.
- **DAG tools (AFC)**: Async callables via `AutomaticFunctionCallingConfig`. `ToolExecutor` dispatches to `DAGService`. Actions tracked by executor, not LLM.
- **Import flow**: Ephemeral (full `messages` array per request). Structured output via `response_schema`.
- **Build flow**: AFC with `add_node`, `add_edge`, `delete_node`, `delete_edge`, `get_plan` tools (`maximum_remote_calls=128`). Creates empty plan first, agent builds into it step-by-step. Frontend shows `BuildProgress` animation replaying `actions_taken`.
- **Ongoing chat**: AFC with all 6 DAG tools + `find_flights` search tool (`maximum_remote_calls=50`). Confirm-before-acting pattern.
