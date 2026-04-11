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
- **API client** (`lib/api.ts`): `api.get/post/patch/delete<T>(path, body?, signal?)`. Auto-injects Firebase Bearer token. Base: `NEXT_PUBLIC_BACKEND_URL/api/v1`. Throws if `auth.currentUser` is null. Transparently retries once with a force-refreshed token on 401. All verbs accept an optional trailing `AbortSignal` for cleanup in `useEffect` teardown.
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
| `DAGService` | **In `shared/shared/services/`**. Node/edge CRUD, cascade engine, cycle detection, polyline management. `create_standalone_edge()` rejects cycles via `would_create_cycle()` before auto-fetching route data. |
| `AgentService` | `import_chat`, `build_dag` (AFC with tools), `ongoing_chat` (AFC with DAG tools+grounding). |
| `AgentUserContext` | `build_user_context()` — computes role, can_mutate, resolved path for the chatting user. |
| `ToolExecutor` | Dispatches `add/update/delete_node`, `add/delete_edge`, `get_plan` to DAGService. `update_node` uses `update_node_only` (no cascade). Converts `lat/lng` to `lat_lng` sub-object. Tracks `actions_taken`. |
| `PlanService` | **In `shared/shared/services/`**. `clone_plan`, `promote_plan`, `delete_plan` (cascading batch delete). `notification_service` is optional — backend injects it, MCP passes `None` and `promote_plan` skips the notification step. |
| `RouteService` | **In `shared/shared/services/`**. Google Routes API v2. `get_route_data()` -> `RouteData(polyline, travel_time_hours, distance_km)`. |
| `FlightService` | **In `shared/shared/services/`**. Google Flights search via `fli` library (pip: `flights`). `search(origin, destination, date, ...)` -> `FlightSearchResult`. Sync `curl_cffi` bridged to async via `asyncio.to_thread()`. No API key needed. |
| `NotificationService` | `create_notification`, `notify_member_joined`, `notify_member_removed`, `notify_role_changed` |
| `InviteService` | `generate_invite` (token), `claim_invite` (adds participant) |
| `UserService` | `ensure_user`, `update_user`, `get_users_batch` |

### API Endpoints (`backend/src/api/`)

| File | Endpoints |
|---|---|
| `trips.py` | `POST/GET /trips`, `GET/DELETE /trips/{id}`, `PATCH /trips/{id}/settings` |
| `agent.py` | `POST .../import/chat`, `POST .../import/build`, `GET/DELETE .../agent/history`, `POST .../agent/chat` |
| `nodes.py` | CRUD + `POST .../nodes/connected`, `POST .../branch`, `POST .../cascade/confirm`, `PATCH .../participants`, `POST/DELETE .../choose` |
| `edges.py` | `GET .../edges`, `PATCH .../edges/{edge_id}`, `POST .../edges/{edge_id}/split` |
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
| `Trip` | `id, name, created_by, active_plan_id, participants: dict[str, Participant], settings: TripSettings` |
| `Plan` | `id, name, status: PlanStatus (active/draft/archived), created_by, parent_plan_id` |
| `Node` | `id, name, type: NodeType (city/hotel/restaurant/place/activity), lat_lng, arrival_time, departure_time, timezone, participant_ids, order_index, place_id, created_by` |
| `Edge` | `id, from_node_id, to_node_id, travel_mode (drive/ferry/flight/transit/walk), travel_time_hours, distance_km, route_polyline, notes` |
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
- **`cascade.py`**: `compute_cascade()` — pure BFS cascade propagation of schedule changes downstream through the DAG. No I/O.

### Tools (`shared/shared/tools/`)
- **`trip_context.py`**: `format_trip_context()` — shared markdown formatter used by both in-app agent and MCP server.
- **`definitions.py`**: `DAG_TOOL_DEFINITIONS` — SDK-agnostic tool schemas consumed by both Gemini AFC and MCP `@mcp.tool()` handlers.
- **`timezone.py`**: `resolve_timezone(lat, lng)` — IANA timezone resolution via `timezonefinder`.
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
| `BuildProgress` | Build animation: SVG node graph canvas, activity feed, phase indicators (preparing->nodes->edges->verifying->complete). |
| `NodeDetailSheet` | Bottom sheet: view/edit/branch modes with two-click delete |
| `AddNodeSheet` | Add nodes with insert mode (`insertBetween`) and multi-connection mode (`ConnectionSelector`). |
| `DivergenceResolver` | Path choices overlay. Handles out-degree>1 and `__root__` divergence. Uses `hidden` prop. |
| `AgentOverlay` | Slide-up chat, sends `plan_id` to scope agent to viewed plan |
| `PulseButton` / `PulseAvatars` | GPS check-in + other users' positions. Hidden when `location_tracking_enabled` is false. |
| `OfflineBanner` | Inline banner with offline status via `useOnlineStatus()` hook. Disables edits when offline. |
| `TimelineView` | Vertical timeline with date gutter, multi-lane support, zoom controls (0-4), current-time indicator. |
| `TimelineLane` | Renders one lane: positioned node blocks, edge connectors, gap indicators, diverge/merge chips. |
| `TimelineNodeBlock` | Node card with type-colored left border, time display, shared-node badge. |
| `TimelineEdgeConnector` | Travel mode icon, duration/distance label, timezone transition indicator, insert-stop button. |
| `ErrorBoundary` | Class component in `components/error-boundary.tsx`. Wraps `/trips/[tripId]` layout. Catches render errors, logs componentStack, shows retry button that calls `onRetry` prop + clears internal error state. Accepts an optional `fallback(error, retry)` render prop. |

### Timeline Layout Engine (`lib/timeline-layout.ts`)

Pure `computeTimelineLayout()` — no React. Takes nodes, edges, path result, zoom; returns `TimelineLayout` with lanes, date markers, total height. **Lane strategy** (`determineLanes`): "mine" = single lane scoped to current user's path; "all" = topology-based — if DAG has branches (out-degree>=2 or multiple roots), `computeTopologyLanes()` maps every distinct topological path to a lane, labels from `participant_ids`; fallback is a single `__all__` lane. **Multi-lane alignment**: global Y-position pass computes positions for all timed nodes across all lanes (sorted by arrival, with gap compression); per-lane loops look up from this global map so shared nodes align at identical Y offsets. **Key invariant**: `earliestMs` and global positions computed only from nodes in the lane definitions. **Shared nodes** in 2+ lanes get `isShared=true`; `sharedNodeRole` is `"diverge"` (out-degree>=2) or `"merge"` (in-degree>=2), rendered as "Paths split"/"Paths rejoin" chips. **Gap compression**: idle >8h compressed to 40px "~Xh/days idle" indicators. Frontend path computation (`lib/path-computation.ts`) mirrors `shared/shared/dag/paths.py`.

---

## MCP Server (`mcpserver/`)

fastmcp 3.2 server for external AI agents via Model Context Protocol. Transport: `streamable-http` only (Cloud Run).

**Entry point** (`mcpserver/src/main.py`): mirrors `backend/src/main.py` shape — `load_dotenv(mcpserver/.env)` at the top, then module-level eager init (`firebase_admin.initialize_app()`, `AsyncClient()`, `ApiKeyTokenVerifier`, `FastMCP(..., auth=_token_verifier)`), tool modules imported for registration side-effects, and finally `app = mcp.http_app(path="/mcp")` exposed at module scope. Run as `uvicorn mcpserver.src.main:app --host 0.0.0.0 --port ${PORT}` (Dockerfile CMD) or `cd mcpserver && uvicorn src.main:app --reload --port 8080` locally. Dotted-path loading means `main.py` is always imported under its real module name, so the `mcp` instance tool modules import is the same one uvicorn serves — no `__main__.py` shim, no double-import risk. Per-request services (`TripService`, `DAGService`, `PlanService`, `PlacesService`, `httpx.AsyncClient`) are built in the FastMCP `app_lifespan` and reach tools via `AppContext` (`ctx.lifespan_context`).

**Auth architecture**: `ApiKeyTokenVerifier` extends fastmcp's `TokenVerifier` base class (`from fastmcp.server.auth import TokenVerifier`). `TokenVerifier` installs `BearerAuthBackend` + `AuthContextMiddleware` via `get_middleware()` but its `get_routes()` returns an empty list — zero OAuth discovery endpoints, no `/.well-known/oauth-*` routes. MCP clients with a static `Authorization: Bearer <api_key>` header in `.mcp.json` use it directly — no OAuth dance, no "Authenticate" click. `ApiKeyTokenVerifier.verify_token` funnels into `resolve_user_from_api_key` (HMAC-SHA256 → Firestore collection group query, 5-min cache, rate limited). Tool handlers read the authenticated user via `get_user_id(ctx)` which calls `get_access_token()` from `fastmcp.server.dependencies`.

**Key files**: `auth/api_key_auth.py` (`ApiKeyTokenVerifier`, `resolve_user_from_api_key()` HMAC→Firestore, `get_user_id(ctx)` for tool handlers), `config.py` (env vars).

**Client config** (`.mcp.json`): `type: "http"`, `url: ".../mcp"`, `headers: { "Authorization": "Bearer <api_key>" }`.

**Tools**: `get_trips`, `get_trip_plans`, `get_trip_context` | `create_trip`, `delete_trip`, `update_trip_settings` | `create_plan`, `promote_plan`, `delete_plan` | `add_node`, `update_node`, `delete_node` | `add_edge`, `delete_edge` | `add_action`, `list_actions`, `delete_action` | `find_places` | `find_flights`. Shared `DAGService` + `PlanService` for mutations, shared `format_trip_context()` for context. `add_action` takes flattened place params (`place_name`, `place_id`, `place_lat`, `place_lng`, `place_category`) and requires `place_id` when `type='place'`. `find_flights` takes IATA codes + date; supports one-way and round-trip.

**Return format convention**: Tools returning data the LLM chains (IDs, lists, settings) return **dicts** — this includes all mutation tools, `get_trips`, `get_trip_plans`, `find_flights`. Tools returning rich context for comprehension return **text/markdown** — `get_trip_context`, `list_actions`, `find_places`.

**MCP-specific behaviors** (diverge from backend on purpose):
- `create_trip` bundles an initial active plan named "Main Route" so `add_node` works immediately. Backend's `POST /trips` stays planless — web flow creates the first plan inside `import_build`.

**Shared agent + MCP behavior**: Both the in-app agent (`ToolExecutor`) and MCP server use `DAGService.update_node_only` for `update_node` — updates only the target node, no cascade. Polylines on connected edges are recalculated if `lat_lng` changes. The REST API (`backend/src/api/nodes.py`) still uses `update_node_with_cascade_preview` for the manual map UI, which has its own cascade preview/confirm flow. Overlapping tools (`add_node`, `update_node`, `delete_node`, `add_edge`, `delete_edge`, `find_flights`) call the same underlying service methods and return the same dict shapes.

**Auth gates** (`mcpserver/src/tools/_helpers.py`): every `@mcp.tool()` calls exactly one on its first line — Gate A `resolve_trip_plan` (editor: admin/planner), Gate B participant check (in `add_action`), Gate C `resolve_trip_admin` (admin only), Gate D `get_user_id` (auth only, for `create_trip` / `find_places`).

---

## Gemini Agent Integration

- SDK: `google-genai`. Client: `genai.Client(vertexai=True)`. Model: env `GEMINI_MODEL` (default `gemini-3-flash-preview`).
- **Grounding tools**: `types.Tool(google_maps=types.GoogleMaps())`, `types.Tool(google_search=types.GoogleSearch())`.
- **DAG tools (AFC)**: Async callables via `AutomaticFunctionCallingConfig`. `ToolExecutor` dispatches to `DAGService`. Actions tracked by executor, not LLM.
- **Import flow**: Ephemeral (full `messages` array per request). Structured output via `response_schema`.
- **Build flow**: AFC with `add_node`, `add_edge`, `delete_node`, `delete_edge`, `get_plan` tools (`maximum_remote_calls=128`). Creates empty plan first, agent builds into it step-by-step. Frontend shows `BuildProgress` animation replaying `actions_taken`.
- **Ongoing chat**: AFC with all 6 DAG tools + `find_flights` search tool (`maximum_remote_calls=50`). Confirm-before-acting pattern.

---

## Key Patterns & Gotchas

- **Auth race**: `auth.currentUser` is null on initial load. Check `useAuth()` `loading`/`user` before API calls.
- **API client retry semantics** (`frontend/lib/api.ts`): Firebase ID tokens are cached for up to an hour by `user.getIdToken()`, so a stale token surfaces as an opaque 401 with no recovery. `request<T>()` detects 401, calls `user.getIdToken(true)` (force refresh), and retries the same request exactly once. A second 401 bubbles up as a thrown error — the client does NOT redirect; callers decide. Every verb (`get/post/patch/delete`) accepts an optional trailing `AbortSignal` that's forwarded to `fetch` and preserved across the retry. Guarded by `frontend/lib/api.test.ts`.
- **Memo comparator discipline**: `TimelineNodeBlock` and `TimelineLane` use custom `memo()` comparators. Every prop the component reads must be in the comparator, or Firestore updates to that field will render stale UI. Missing `type`, `timezone`, `name`, `datetimeFormat`, `dateFormat`, `hasMissingTime`, or `isInterpolated` from a node block comparator caused visible staleness when trip settings or node metadata changed. When adding a prop to one of these components, also add it to the comparator.
- **Firestore `__name__`**: Full document path, not just ID. Use `where("id", "==", ...)` or direct lookup.
- **Date handling**: `@/lib/dates.ts` with `Intl.DateTimeFormat`. `DateTimePicker` for inputs. Departure-before-arrival validation.
- **User display names**: `formatUserName()` returns "FirstName L." format. Never show raw UIDs.
- **Location tracking**: `User.location_tracking_enabled`. Backend rejects pulse if disabled. Disabling deletes all location docs.
- **CSS height chain**: Google Maps needs `html.h-full > body.h-full > container.h-full > map.h-full`. Use `min-h-0` on flex children.
- **Overlay stacking**: Glass header `z-20`, DivergenceResolver `bottom-[nav] z-20`, Bottom nav `z-30`.
- **Duplicate edge prevention**: `DAGService._create_edge_if_new()` on all creation paths.
- **Route data flow**: `create_standalone_edge()` fetches route data synchronously for drive/transit/walk; uses haversine estimation for flight (~800 km/h) and ferry (~40 km/h). Route advisory warnings (seasonal closures, tolls) are auto-extracted from Routes API navigation instructions and stored in `edge.notes`. `_recalculate_connected_polylines()` only fires when `lat_lng` actually changes (old vs new comparison) and skips flight/ferry edges. Frontend sets `recalculatingEdges` shimmer only on real coordinate changes, cleared on `onSnapshot`.
- **Implicit branching**: No `branch_id` on edges. Paths derived at runtime from DAG topology + `participant_ids`. Divergence = out-degree>1 or multiple root nodes.
- **Timeline zoom**: 5 levels (0-4), `PX_PER_HOUR` = [8, 16, 32, 60, 120]. Scroll position anchored on zoom change so content stays centered.
- **Timeline lane alignment**: Multi-lane Y positions are computed globally, not per-lane. Adding per-lane gap compression or independent Y computation breaks cross-lane alignment of shared nodes. `START_OFFSET_PX` reserves visual padding without breaking CSS `sticky top-0` lane labels. Gap compression is centralized in `compressGaps()` — both the multi-lane global pass and single-lane per-lane pass call it so they can't drift out of sync. Guarded by `frontend/lib/timeline-layout.test.ts` tests in the `gap compression` and `edge cases` describe blocks (shared-node Y equality, single-node trip, empty trip, all-untimed stacking).
- **Timeline lane IDs**: "all" mode always emits `topology-N` lane IDs via `computeTopologyLanes()`, with participant names surfaced in `participantLabel`, not `laneId`. "mine" mode uses the `currentUserId` as the lane ID. There is no code path that keys lanes by participant ID in "all" mode — a stale test used to assert otherwise.
- **Ref reads during render** (React Compiler): The `react-hooks/refs` rule flags `ref.current` reads inside render bodies/JSX. When a parent component accesses `ref.current` just to pass a snapshot to a child that only reads it at mount (e.g. `savedCamera` consumed once by `TripMap`), use a lazy `useState` initializer instead of `useRef`. The setter can still write-only to sessionStorage without calling setState, preserving the "don't re-render parents on map pan" behavior that pure state would break. Gotcha: the React Compiler silently bails out of analyzing a component when it sees other rule violations (e.g. direct `ref.current =` writes during render), so fixing one violation can surface several latent `set-state-in-effect` warnings in the same file — treat those as separate pre-existing issues.
- **ID format**: Short typed IDs (`n_`, `e_`, `p_`, `t_`, `a_` prefixes + 8 alphanumeric chars) for agent-friendliness. Generated by `shared/shared/tools/id_gen.py`.
- **Map camera stability**: `TripMap` initial fit is gated by an internal `hasFittedRef` (reset on `planId` change), not by `useEffect` deps — `initialFitNodes` and `myNodeIds` are memos that rebuild on every Firestore snapshot, so dep-driven effects refit the map on every unrelated update. The path-filter refit must compare `myNodeIds` by semantic content (size + members), not reference equality. Refs exposed via React Context (e.g. an old `mapFitted` flag) do not trigger consumer re-renders, so the consumer always reads the first value — gate one-shot side effects inside `TripMap` itself, not via context state.
- **Agent tool signatures (`agent_tools.py`)**: Never add `from __future__ import annotations` — Gemini AFC's runtime arg converter calls `isinstance(value, param.annotation)`, which raises `TypeError` when annotations are PEP 563 strings. Schema generation has a pydantic fallback that hides this; only the invocation path crashes, so symptoms look like "the agent can read but can't mutate." Optional params must be `T | None = None`, not `T = None`, so they pass the SDK's strict schema validator instead of the brittle fallback. Guarded by `backend/tests/test_agent_tools.py`, which runs every tool through the SDK's actual `convert_argument_from_function` and `_parse_schema_from_parameter`.
