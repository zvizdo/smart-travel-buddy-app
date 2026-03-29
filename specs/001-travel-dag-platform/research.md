# Research: Travel DAG Platform

**Branch**: `001-travel-dag-platform` | **Date**: 2026-03-26

## R1: Next.js 16 Breaking Changes & Patterns

**Decision**: Use Next.js 16.2 with App Router, Server Components default, Turbopack default.

**Key findings from `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`**:

1. **Async Request APIs (Breaking)**: `params`, `searchParams`, `cookies`, `headers`, `draftMode` are all async. Must `await` them. Use `PageProps<'/path/[param]'>` type helper via `npx next typegen`.
2. **`middleware` renamed to `proxy`**: File must be `proxy.ts`, export `function proxy()`. Config flags renamed (e.g., `skipProxyUrlNormalize`). Runs on `nodejs` runtime only.
3. **Turbopack by default**: No `--turbopack` flag needed. Custom webpack configs will fail builds unless `--webpack` is passed. `turbopack` config is top-level (not under `experimental`).
4. **React 19.2**: View Transitions (animate between routes), `useEffectEvent` (non-reactive effect logic), `Activity` (background rendering with `display: none`).
5. **React Compiler stable**: Enable via `reactCompiler: true` in next.config.ts. Auto-memoization.
6. **Cache APIs**: `cacheLife`/`cacheTag` stable (no `unstable_` prefix). New `updateTag` for read-your-writes. New `refresh()` from `next/cache`.
7. **PPR via `cacheComponents`**: `experimental.ppr` removed, use `cacheComponents: true`.
8. **Image changes**: `minimumCacheTTL` default now 4 hours, `imageSizes` no longer includes 16, `qualities` defaults to `[75]` only.

**Patterns for this project**:
- Server Components for trip list, trip layout (data fetching close to source)
- Client Components for: Google Maps, Magic Import chat UI, real-time Firestore listeners, Pulse check-in, Bottom Sheet interactions
- `proxy.ts` for auth token forwarding to backend API
- React 19.2 View Transitions for smooth trip/plan navigation
- React Compiler enabled for automatic memoization of map/DAG components

**Alternatives considered**: None -- Next.js 16 is already installed and specified by constitution.

---

## R2: Google Maps Integration with Next.js 16

**Decision**: Use `@vis.gl/react-google-maps` (Google's official React wrapper).

**Rationale**:
- Official Google library, actively maintained, designed for React 18+/19
- Declarative API with `<Map>`, `<Marker>`, `<Polyline>` components
- Supports all Google Maps features needed: markers (nodes), polylines (edges), info windows (node details), Places API (suggestions)
- Must be wrapped in Client Components (`'use client'`) since it uses browser APIs

**Key patterns**:
- `<APIProvider>` at trip layout level, `<Map>` in the map component
- Custom markers for nodes (styled by type: city, hotel, restaurant)
- Colored polylines for branches (distinct colors per branch)
- Merge Node markers with special styling showing multiple branch arrivals
- Geocoding API for resolving location names during import
- Places API for restaurant/hotel suggestions (MCP `suggest_stop` tool)

**Alternatives considered**:
- `react-google-maps/api` -- community library, less actively maintained
- Mapbox GL -- good alternative but spec explicitly calls for Google Maps SDK

---

## R3: FastAPI + Firestore Async Integration

**Decision**: Use `google-cloud-firestore` with async client (`AsyncClient`).

**Rationale**:
- `google-cloud-firestore >= 2.16` supports native async operations via `AsyncClient`
- Pairs naturally with FastAPI's async request handling
- Firestore transactions support batch writes needed for cascading DAG updates

**Key patterns**:
- Repository classes accept `AsyncClient` via dependency injection
- Cascading updates use `async_transaction` to batch all downstream node writes atomically
- Real-time listeners on frontend via Firebase JS SDK `onSnapshot` (not backend)
- Backend handles write operations; frontend handles read subscriptions

**Libraries**:
- `google-cloud-firestore[async]` >= 2.16 -- async Firestore client
- `firebase-admin` -- for auth token verification and admin operations
- `pydantic` >= 2.0 -- model validation

**Pitfalls**:
- Firestore has a 500 document limit per transaction -- sufficient for 50-node DAGs
- Nested subcollection queries require collection group queries or known paths
- `onSnapshot` listeners on frontend must be cleaned up on component unmount

---

## R4: Gemini 3 Flash for Magic Import Parsing

**Decision**: Use Gemini 3 Flash via `google-genai` Python SDK (new unified SDK) for structured text extraction.

**Rationale**:
- Spec and prompt.md explicitly specify Gemini 3 Flash
- Fast inference suitable for real-time import flow (<60s target)
- Native structured output (JSON mode) for reliable entity extraction
- Cost-effective for potentially high-volume parsing operations

**Key patterns**:
- The Gemini agent handles note extraction, categorization, and clarification conversationally — no separate `ImportNote`/`ClarifyingQuestion` models or extraction/detection subsystems needed
- Structured output via Pydantic response schemas: the agent produces JSON with categorized notes (destination, date/timing, activity, budget, preference, accommodation), confidence levels, and a `ready_to_build` flag
- Import is a conversational flow: user sends text, agent responds with extracted notes and asks clarifying questions naturally, user answers, agent refines — all within the chat session
- Chat history persisted to GCS provides session continuity; no Firestore state for import
- System prompt includes category definitions and confidence scoring guidance
- When `ready_to_build` is true, a separate build step assembles notes into DAG nodes/edges with geocoding

**Gemini Tool Use (Function Calling)**:
- The Gemini agent has two external tools configured via function declarations:
  - **Google Maps tool**: geocoding, directions, places search, distance calculation. Used during import (resolve locations) and ongoing management (find restaurants, calculate drive times).
  - **Google Search tool**: research destinations, find activities, check travel advisories, weather info. Available during both import and trip management.
- Gemini calls these tools autonomously during conversation -- the backend intercepts tool calls, executes them against the respective APIs, and returns results to the Gemini context.

**Agent Lifecycle**:
- The agent is NOT limited to import. After trip creation, the agent remains available as a first-class interface for ongoing trip management.
- Users can summon the agent from the trip view to make any change conversationally: add/remove/reorder nodes, update times, search for places, research destinations, resolve conflicts.
- The backend maintains a Gemini chat session with the trip context as system prompt. Each user interaction appends to the session.
- Agent actions are executed via the same service layer as manual UI actions -- ensuring consistency.

**Libraries**:
- `google-genai` >= 1.x -- new unified Google GenAI SDK (preferred over older `google-generativeai`)
- Structured output via `response_mime_type="application/json"` + `response_schema` with Pydantic models
- Model identifier: verify exact string for Gemini 3 Flash from Google docs (may be `gemini-3.0-flash` or similar)

**Alternatives considered**:
- OpenAI GPT-4 -- not specified, would add unnecessary vendor dependency
- Local LLM -- too slow for real-time parsing, deployment complexity

---

## R5: Firebase Auth with FastAPI

**Decision**: Verify Firebase ID tokens in FastAPI using `firebase-admin` SDK.

**Rationale**:
- Firebase Auth handles user registration/login on frontend (Google, Apple, Yahoo)
- Backend verifies ID tokens passed in `Authorization: Bearer <token>` header
- Role-based access comes from Firestore `participants` map, not Firebase custom claims (simpler for per-trip roles)

**Key patterns**:
- FastAPI dependency `get_current_user()` extracts and verifies token via `firebase_admin.auth.verify_id_token()`
- **Important**: `verify_id_token()` is synchronous -- wrap in `asyncio.to_thread()` for async endpoints
- Trip-level authorization: check `trip.participants[user_id].role` for permission decisions
- Invite links: generate unique tokens stored in Firestore, resolve to trip + role on claim
- `proxy.ts` in Next.js forwards auth cookies/headers to backend API
- `initialize_app()` must be called exactly once -- use FastAPI lifespan handler

**Libraries**:
- `firebase-admin` >= 6.0 -- token verification, user management

**Pitfalls**:
- Tokens expire after 1 hour -- client SDK handles refresh, backend must handle expired-token errors
- `firebase-admin`'s Firestore client is synchronous -- use `google-cloud-firestore` `AsyncClient` directly for data access

---

## R6: Firestore Offline Persistence in Next.js

**Decision**: Use Firebase JS SDK v10+ with `persistentLocalCache` and `persistentMultipleTabManager` for offline read-only access.

**Rationale**:
- `enableIndexedDbPersistence()` is deprecated in Firebase JS SDK v10+
- New API: `initializeFirestore()` with `persistentLocalCache` configuration
- `onSnapshot` listeners work seamlessly offline against cached data
- Read-only offline mode: frontend checks `navigator.onLine` to disable write operations

**Key patterns**:
```typescript
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
```
- Must initialize in a Client Component (`'use client'`) -- IndexedDB is browser-only
- Do NOT initialize Firestore in Server Components -- use `firebase-admin` server-side
- `onSnapshot` in `useEffect` with cleanup: `return () => unsub()`
- Pulse check-ins queued to `localStorage` when offline, flushed on reconnect
- Import from `firebase/firestore` (not `firebase/firestore/lite` -- lite has no offline support)

**Pitfalls**:
- `persistentLocalCache` must be set at initialization time -- cannot be enabled later
- Full Firestore SDK is significantly larger than `firestore/lite` -- use dynamic imports to avoid loading during SSR
- Cache size is unlimited by default -- consider configuring `cacheSizeBytes` for mobile

---

## R7: FastMCP Server Structure

**Decision**: Use FastMCP with tool definitions delegating to service classes that import the shared agent configuration and DAG assembly library. Auth via user-generated API keys.

**Rationale**:
- FastMCP provides a clean decorator-based API for defining MCP tools
- Tools are thin wrappers: parse input, delegate to service, format output
- Shared library (`shared/`) imported as a Python package by both backend and MCP server
- API key auth is simpler than Firebase token forwarding for AI agent use cases

**Key patterns**:
- `@mcp.tool()` decorators on functions in `tools/` modules
- Each tool function calls a service class method
- Services import from `shared.parsing` for text analysis and from repository classes for Firestore access
- Auth: API key hash lookup in `users/{userId}/api_keys`, then resolve user's trips via `participants` map
- Nine tools (full feature parity with in-app agent):
  - `get_trips()` -- list all trips the user has access to
  - `get_trip_versions(tripId)` -- list plan versions for a trip
  - `get_trip_context(tripId, planId?)` -- full DAG (defaults to active plan)
  - `modify_trip(tripId, nodes_to_add?, nodes_to_update?, nodes_to_remove?)` -- submit modified DAG
  - `suggest_stop(tripId, edgeId, category)` -- Places API search along a route
  - `add_action(tripId, nodeId, type, content)` -- attach note/todo/place to a node
  - `search_places(query, near_node_id?)` -- Google Places API near a location
  - `search_web(query)` -- web search for travel information
  - `import_chat(tripId, messages)` -- conversational text-to-DAG import (mirrors backend `POST /import/chat`)

**Libraries**:
- `mcp` >= 1.x -- official MCP Python SDK (includes `FastMCP` class via `mcp.server.fastmcp`)
- `shared` -- local package (installed via `pip install -e ../shared`)

---

## R8: Cascading DAG Update Algorithm

**Decision**: Implement recursive downstream propagation with Firestore batch transaction.

**Rationale**:
- Per prompt.md section 3.1: update triggers recursive propagation through all downstream nodes
- Formula: `child.arrival_time = parent.arrival_time + parent.duration + edge.travel_time`
- All updates committed atomically in a single Firestore transaction

**Key patterns**:
- `DAGService.cascade_update(trip_id, plan_id, modified_node_id)`:
  1. Load all edges from modified node's plan
  2. Build adjacency list (parent -> children)
  3. BFS/DFS from modified node, computing new arrival times
  4. Collect all changed nodes
  5. Return preview (list of changes with before/after)
  6. On user confirm, execute batch write in transaction
- Branch-aware: only follow edges within the affected branch
- Conflict detection: flag overlapping dates between consecutive nodes

**Scale considerations**:
- Max 50 nodes, 100 edges -- O(V+E) traversal is trivial
- Firestore transaction limit of 500 writes is well within bounds

---

## R9: Google Application Default Credentials (ADC)

**Decision**: Use Google Application Default Credentials for all Python services (backend, MCP server, shared library).

**Rationale**:
- ADC provides a unified credential chain: local dev (`gcloud auth application-default login`), Cloud Run/GKE (automatic via metadata server), CI (service account key)
- Eliminates the need for explicit `GOOGLE_APPLICATION_CREDENTIALS` env var in most environments
- Both `google-cloud-firestore` and `firebase-admin` support ADC natively
- `google-genai` SDK supports ADC via `google.auth.default()` credentials

**Key patterns**:
- `firebase_admin.initialize_app()` with no arguments uses ADC automatically
- `google.cloud.firestore.AsyncClient()` with no arguments uses ADC
- For local development: `gcloud auth application-default login` with the correct project
- For deployment: service account attached to the runtime environment
- Gemini: `google.genai.Client()` with no explicit API key when running with ADC (uses Vertex AI endpoint)

**Alternatives considered**:
- Explicit service account JSON files -- less secure, harder to manage across environments

---

## R10: Python Environment Strategy

**Decision**: Use a single conda environment `travel-app` for all Python projects (backend, MCP server, shared library).

**Rationale**:
- Single environment simplifies development -- no switching between venvs
- All three Python sub-projects share many dependencies (google-cloud-firestore, firebase-admin, pydantic)
- Shared library is installed in editable mode (`pip install -e ../shared`) within the conda env
- conda handles Python version management (3.12+)

**Key patterns**:
- `conda activate travel-app` before running any Python service
- Install all dependencies: `pip install -r backend/requirements.txt -r mcpserver/requirements.txt`
- Install shared library: `pip install -e shared/`
- No per-project venvs -- single environment for the whole project

---

## R11: Implicit Branching Model (Participant-Flow-Based Paths)

**Decision**: Replace explicit branch entities with implicit path derivation from DAG topology and `participant_ids` on nodes.

**Rationale**:
- Branches are a derived concept, not a first-class entity. The DAG structure (edges) already defines paths.
- Participant assignment at divergence points is the only additional data needed to derive each person's route.
- Eliminates redundant `branch_id` on edges, `branch_ids` on nodes, and `branches` map on trips — reducing data duplication and potential for inconsistency.
- Simplifies linear DAGs: no branch setup needed when there's only one path.

**How it works**:
1. **Linear DAG** (single path): All participants flow from first to last node. `participant_ids` on nodes is null/empty. No assignment needed.
2. **Multiple start nodes**: Each participant is assigned to a start node. They flow downstream through edges until paths merge.
3. **Mid-graph divergence**: All participants flow together until the split. At the divergence point (node with 2+ outgoing edges to different paths), participants must be assigned to post-split nodes.
4. **Merge nodes**: Detected structurally — any node with multiple incoming edges from different paths. No explicit marking needed.
5. **Path inference algorithm**: For each participant, BFS/DFS from their assigned start or post-split node, following edges downstream. The set of nodes on their path = their "branch" in the UI.
6. **Unresolved flows**: If a participant reaches a divergence point with no assignment to a post-split node, the system warns the Admin/Planner.

**Data model changes**:
- Node: Remove `branch_ids` array. Add `participant_ids` (optional list of user IDs; null/empty = all participants).
- Edge: Remove `branch_id` field entirely.
- Trip: Remove `branches` map. Add `start_node_assignments` to participants map (optional, for multi-start DAGs).
- Path colors: Computed at runtime by grouping participants at divergence points, not stored.

**Key patterns**:
- `DAGService.compute_participant_paths(plan_id)`: Traverses edges, resolves participant assignments at each divergence, returns `Map<userId, List<nodeId>>`.
- Frontend: Calls path computation on plan load. Colors derived from participant groups sharing the same divergent segment.
- Merge node detection: `node` where `in_degree > 1` and incoming edges originate from nodes on different computed paths.
- Cascade engine: Follows edges downstream from modified node regardless of participant assignment — cascading is topology-based, not participant-based.

**Edge cases**:
- Participant with no assignment at divergence → warning shown, path shown as "unresolved" with dashed line
- All divergent paths removed (DAG becomes linear) → stale `participant_ids` cleaned up automatically
- Participant assigned to unreachable node → assignment rejected with error

**Alternatives considered**:
- Explicit branch entities (previous model) — more intuitive naming but redundant data, potential for inconsistency between branch metadata and actual DAG structure
- Edge-based branch tagging — still redundant, doesn't solve the derivation problem
