# Project Reference: Smart Travel Buddy

## Architecture Overview

Four sub-projects in a monorepo. Single `travel-app` conda env for all Python.

```
frontend/     Next.js 16.2 + React 19.2 + Tailwind 4 (pnpm)
backend/      FastAPI + google-cloud-firestore[async] + google-genai
shared/       Pydantic models + repositories + agent config + DAG logic + services (pip install -e)
mcpserver/    FastMCP server — streamable-http, per-request Bearer auth
```

Storage: Firestore (Native mode) + GCS for chat history.
Auth: Firebase Auth (frontend) -> `firebase-admin` token verification (backend). MCP server uses HMAC API keys.
All Google Cloud auth via ADC — no service account JSON files.
Deploy: `./deploy/deploy.sh [setup|all|frontend|backend|mcpserver]`. Images in Artifact Registry (`europe-west1-docker.pkg.dev/as-dev-anze/stb-images`), tagged by git SHA.

---

## Next.js 16 Breaking Changes (MUST READ)

- **`proxy.ts`** replaces `middleware.ts`. Export `function proxy()`, not `middleware()`.
- **Async request APIs**: `params`, `searchParams`, `cookies`, `headers` are all `Promise`. Must `await` them.
- **Turbopack is default**. Custom webpack needs `--webpack` flag.
- **React Compiler stable**: `reactCompiler: true` in next.config.ts (already enabled).

## Key Frontend Patterns

- **Server Components** are default. Use `"use client"` only for: maps, chat, real-time listeners, auth state, interactive forms.
- **Path alias**: `@/*` maps to `./`. **Providers** (`app/providers.tsx`): `AuthProvider` > `APIProvider` (Google Maps).
- **Firestore hooks** (`lib/firestore-hooks.ts`): `useTrip`, `useTripNodes`, `useTripEdges`, `usePulseLocations`, `useTripNotifications`. Return `{ data, loading, error }`. Use `onSnapshot` for real-time.
- **API client** (`lib/api.ts`): `api.get/post/patch/delete<T>`. Auto-injects Firebase Bearer token. Base: `NEXT_PUBLIC_BACKEND_URL/api/v1`. Throws if `auth.currentUser` is null.
- **Directions hook** (`lib/use-directions.ts`): `useDirections(origin, destination)` -> `{ travelData, loading }`. Mode inference: >800km=flight, <3km=walk, else drive. Haversine fallback.
- **Auth provider** (`components/auth/auth-provider.tsx`): `useAuth()` -> `{ user, loading, signInWithGoogle, signInWithApple, signInWithYahoo, signOut }`.
- **Proxy** (`proxy.ts`): Public paths: `/sign-in`, `/invite`. Invite URLs: `/invite/{tripId}/{token}`.

---

## Backend Architecture

### Entry Point (`backend/src/main.py`)
Lifespan: `firebase_admin.initialize_app()`, `AsyncClient()`, `GCSClient()`, `RouteService(http_client)`. CORS from `CORS_ORIGINS`. Exception handlers: `CycleDetectedError`->400, `ValueError`->422, `PermissionError`->403, `LookupError`->404. All routers under `/api/v1`. Health: `GET /health`.

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
| `DAGService` | **In `shared/shared/services/`**. Node/edge CRUD, cascade engine, cycle detection, polyline management. `create_standalone_edge()` rejects cycles via `would_create_cycle()` before auto-fetching route data. |
| `AgentService` | `import_chat` (Gemini->ImportChatResponse), `build_dag` (AFC with tools, constructs DAG step-by-step), `ongoing_chat` (AFC with DAG tools+grounding). |
| `ToolExecutor` | Dispatches `add/update/delete_node`, `add/delete_edge`, `get_plan` to DAGService. Tracks `actions_taken`. |
| `PlanService` | `clone_plan`, `promote_plan`, `delete_plan` (cascading batch delete) |
| `RouteService` | **In `shared/shared/services/`**. Google Routes API v2. `get_route_data()` -> `RouteData(polyline, travel_time_hours, distance_km)`. |
| `NotificationService` | `create_notification`, `notify_member_joined`, `notify_unresolved_paths` |
| `InviteService` | `generate_invite` (token), `claim_invite` (adds participant) |
| `UserService` | `ensure_user`, `update_user`, `get_users_batch` |

### API Endpoints (`backend/src/api/`)

| File | Endpoints |
|---|---|
| `trips.py` | `POST/GET /trips`, `GET/DELETE /trips/{id}`, `PATCH /trips/{id}/settings` |
| `agent.py` | `POST .../import/chat`, `POST .../import/build` (creates plan + AFC build), `POST .../agent/chat` |
| `nodes.py` | CRUD + `POST .../nodes/connected`, `POST .../branch`, `POST .../cascade/confirm`, `PATCH .../participants`, `POST/DELETE .../choose` |
| `edges.py` | `GET .../edges`, `POST .../edges/{edge_id}/split` |
| `paths.py` | `GET .../paths`, `GET .../warnings` |
| `plans.py` | `POST/GET /trips/{id}/plans`, `DELETE .../plans/{id}`, `POST .../plans/{id}/promote` |
| `notifications.py` | `GET /trips/{id}/notifications`, `PATCH .../notifications/{id}` |
| `invites.py` | `POST .../invites`, `POST .../invites/{token}/claim` |
| `pulse.py` | `POST /trips/{id}/pulse` |
| `users.py` | `GET/PATCH /users/me`, `POST /users/batch` |

---

## Shared Library (`shared/`)

### Models (`shared/shared/models/`)
All Pydantic `BaseModel` with `StrEnum`. **All datetimes UTC-aware** via `datetime.now(UTC)`.

| Model | Key Fields |
|---|---|
| `Trip` | `id, name, created_by, active_plan_id, participants: dict[str, Participant], settings: TripSettings` |
| `Plan` | `id, name, status: PlanStatus (active/draft/archived), created_by, parent_plan_id` |
| `Node` | `id, name, type: NodeType (city/hotel/restaurant/place/activity), lat_lng, arrival_time, departure_time, duration_hours, timezone, participant_ids, place_id, created_by` |
| `Edge` | `id, from_node_id, to_node_id, travel_mode (drive/flight/transit/walk), travel_time_hours, distance_km, route_polyline` |
| `Notification` | `id, type, message, target_user_ids, read_by, expire_at` (7-day TTL) |
| `Preference` | `id, content, category, extracted_from` |

### Agent (`shared/shared/agent/`)

- **`schemas.py`**: `ImportChatResponse(reply, notes, ready_to_build)`, `AgentReply(reply, preferences_extracted)`, `OngoingChatResponse(reply, actions_taken, preferences_extracted)`, `BuildDagReply(summary, node_count, edge_count)`, `BuildDagResponse(summary, actions_taken, node_count, edge_count)`.
- **`config.py`**: `IMPORT_SYSTEM_PROMPT`, `ONGOING_SYSTEM_PROMPT` (confirm-before-acting), `BUILD_SYSTEM_PROMPT` (4-phase: spine nodes → branch nodes → edges → verify). Response schemas: `RESPONSE_SCHEMA`, `ONGOING_RESPONSE_SCHEMA`, `BUILD_RESPONSE_SCHEMA`.

### Agent Tools (`backend/src/services/agent_tools.py`)

`_define_all_tools(executor)` defines all 6 tools once (`add_node`, `update_node`, `delete_node`, `add_edge`, `delete_edge`, `get_plan`).
- `create_agent_tools(executor, can_mutate)`: all 6 if can_mutate, else just `get_plan`.
- `create_build_tools(executor)`: `add_node`, `add_edge`, `delete_node`, `delete_edge`, `get_plan` (excludes `update_node`).

### DAG (`shared/shared/dag/`)
- **`cycle.py`**: `detect_cycle()` — iterative DFS for multi-connection node insertion. `would_create_cycle(from_id, to_id, edges)` — BFS check for standalone edge creation. `CycleDetectedError`, `get_ancestors/get_descendants`.
- **`paths.py`**: `compute_participant_paths()` — BFS per participant. Multi-root `__root__` divergence handling. Frontend mirror: `frontend/lib/path-computation.ts`.

### Tools (`shared/shared/tools/`)
- **`trip_context.py`**: `format_trip_context()` — shared markdown formatter used by both in-app agent and MCP server.

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
| `/trips/[tripId]` (page) | Map view: full node/edge CRUD, path filtering, divergence resolver, cascade preview, plan switcher, agent overlay, pulse, offline banner. |
| `/trips/[tripId]/import` | Magic Import chat. Build triggers `BuildProgress` animation (SVG graph + activity feed). |
| `/trips/[tripId]/settings` | Settings, invites, plan versioning (create/promote/delete). |
| `/invite/[tripId]/[token]` | Invite claim page |

### Key Components

| Component | Purpose |
|---|---|
| `TripMap` | Google Map with markers + polylines. Fan-out for co-located nodes. `fitBounds` with zoom clamp 3-14. |
| `NodeMarker` | Type-colored icon badge, name label. Exports `TYPE_TOKENS` / `FALLBACK_TOKEN`. |
| `EdgePolyline` | Route polylines with mode dash patterns, midpoint badge. `recalculating` shimmer animation. |
| `BuildProgress` | Build animation: SVG node graph canvas, activity feed, phase indicators (preparing→nodes→edges→verifying→complete). |
| `NodeDetailSheet` | Bottom sheet: view/edit/branch modes with two-click delete |
| `AddNodeSheet` | Add nodes with insert mode (`insertBetween`) and multi-connection mode (`ConnectionSelector`). |
| `DivergenceResolver` | Path choices overlay. Handles out-degree>1 and `__root__` divergence. Uses `hidden` prop. |
| `AgentOverlay` | Slide-up chat, sends `plan_id` to scope agent to viewed plan |
| `PulseButton` / `PulseAvatars` | GPS check-in + other users' positions. Hidden when `location_tracking_enabled` is false. |
| `OfflineBanner` | Disables edits when offline. Absolutely positioned below glass header (`top-12 z-20`). |

---

## MCP Server (`mcpserver/`)

FastMCP server for external AI agents via Model Context Protocol. Transport: `streamable-http` (Cloud Run) or `stdio` (local). Auth: HMAC API keys via `ApiKeyTokenVerifier`.

**Tools**: `get_trips`, `get_trip_versions`, `get_trip_context` | `add_node`, `update_node`, `delete_node` | `add_edge`, `delete_edge` | action CRUD | `search_places`. Shared `DAGService` for mutations, shared `format_trip_context()` for context.

---

## Gemini Agent Integration

- SDK: `google-genai`. Client: `genai.Client(vertexai=True)`. Model: env `GEMINI_MODEL` (default `gemini-3-flash-preview`).
- **Grounding tools**: `types.Tool(google_maps=types.GoogleMaps())`, `types.Tool(google_search=types.GoogleSearch())`.
- **DAG tools (AFC)**: Async callables via `AutomaticFunctionCallingConfig`. `ToolExecutor` dispatches to `DAGService`. Actions tracked by executor, not LLM.
- **Import flow**: Ephemeral (full `messages` array per request). Structured output via `response_schema`.
- **Build flow**: AFC with `add_node`, `add_edge`, `delete_node`, `delete_edge`, `get_plan` tools (`maximum_remote_calls=128`). Creates empty plan first, agent builds into it step-by-step. Frontend shows `BuildProgress` animation replaying `actions_taken`.
- **Ongoing chat**: AFC with all 6 tools (`maximum_remote_calls=50`). Confirm-before-acting pattern.

---

## Key Patterns & Gotchas

- **Auth race**: `auth.currentUser` is null on initial load. Check `useAuth()` `loading`/`user` before API calls.
- **Firestore `__name__`**: Full document path, not just ID. Use `where("id", "==", ...)` or direct lookup.
- **Date handling**: `@/lib/dates.ts` with `Intl.DateTimeFormat`. `DateTimePicker` for inputs. Departure-before-arrival validation.
- **User display names**: `formatUserName()` returns "FirstName L." format. Never show raw UIDs.
- **Location tracking**: `User.location_tracking_enabled`. Backend rejects pulse if disabled. Disabling deletes all location docs.
- **CSS height chain**: Google Maps needs `html.h-full > body.h-full > container.h-full > map.h-full`. Use `min-h-0` on flex children.
- **Overlay stacking**: Glass header `z-20`, OfflineBanner `top-12 z-20`, DivergenceResolver `bottom-[nav] z-20`, Bottom nav `z-30`.
- **Duplicate edge prevention**: `DAGService._create_edge_if_new()` on all creation paths.
- **Route data flow**: `create_standalone_edge()` fetches route data synchronously. Node location updates trigger `_recalculate_connected_polylines()` background fetch. Frontend tracks `recalculatingEdges` state, cleared on `onSnapshot`.
- **Implicit branching**: No `branch_id` on edges. Paths derived at runtime from DAG topology + `participant_ids`. Divergence = out-degree>1 or multiple root nodes.
