# Tasks: Travel DAG Platform

**Input**: Design documents from `/specs/001-travel-dag-platform/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested — test tasks omitted. Per constitution, each PR MUST include evidence that code is testable (manual verification steps from phase checkpoint descriptions are acceptable).

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

**Branching model**: Implicit — paths derived from DAG topology and `participant_ids` on nodes. No explicit branch entities, `branch_id` on edges, or `branches` map on trips.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependency installation, and base configuration for all four sub-projects.

- [x] T001 Create backend project structure with `backend/src/{api,services,repositories,models,auth}/__init__.py` and `backend/requirements.txt`
- [x] T002 Create shared library project structure with `shared/shared/{__init__.py,models/__init__.py,agent/__init__.py,dag/__init__.py}` and `shared/setup.py`
- [x] T003 Create MCP server project structure with `mcpserver/src/{tools,services,repositories,auth,models}/__init__.py` and `mcpserver/requirements.txt`
- [x] T004 [P] Add backend dependencies to `backend/requirements.txt` (fastapi, uvicorn, google-cloud-firestore, firebase-admin, google-genai, google-cloud-storage, pydantic)
- [x] T005 [P] Add shared library dependencies to `shared/setup.py` (pydantic, google-cloud-firestore)
- [x] T006 [P] Add MCP server dependencies to `mcpserver/requirements.txt` (mcp, pydantic, google-cloud-firestore, firebase-admin)
- [x] T007 [P] Install `@vis.gl/react-google-maps` and `firebase` SDK in `frontend/` via pnpm
- [x] T008 [P] Configure ESLint and Prettier for frontend in `frontend/eslint.config.mjs`
- [x] T009 [P] Add ruff configuration for Python linting in root `pyproject.toml` (single config at repo root with `src` paths covering `backend/`, `shared/`, `mcpserver/`)
- [x] T010 [P] Enable React Compiler in `frontend/next.config.ts` (`reactCompiler: true`)
- [x] T011 [P] Create environment variable templates: `frontend/.env.local.example`, `backend/.env.example`, `mcpserver/.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Shared Library Base Models

- [x] T012 [P] Create Trip Pydantic model in `shared/shared/models/trip.py` (id, name, created_by, active_plan_id, participants map with role/joined_at, timestamps)
- [x] T013 [P] Create Plan Pydantic model in `shared/shared/models/plan.py` (id, name, status enum active/draft/archived, created_by, parent_plan_id, timestamps)
- [x] T014 [P] Create Node Pydantic model in `shared/shared/models/node.py` (id, name, type enum, lat_lng, arrival_time, departure_time, duration_hours, participant_ids optional array, order_index, place_id, created_by, timestamps)
- [x] T015 [P] Create Edge Pydantic model in `shared/shared/models/edge.py` (id, from_node_id, to_node_id, travel_mode enum, travel_time_hours, distance_km — no branch_id)
- [x] T016 [P] Create Action Pydantic model in `shared/shared/models/action.py` (id, type enum note/todo/place, content, place_data map, is_completed, created_by, timestamps)
- [x] T017 [P] Create User Pydantic model in `shared/shared/models/user.py` (id, display_name, email, timestamps)
- [x] T018 [P] Create Notification Pydantic model in `shared/shared/models/notification.py` (id, type enum including unresolved_path, message, target_user_ids, read_by, related_entity, timestamps)
- [x] T019 [P] Create Preference Pydantic model in `shared/shared/models/preference.py` (id, content, category enum, extracted_from, created_by, timestamps)
- [x] T020 [P] Create InviteLink Pydantic model in `shared/shared/models/invite_link.py` (id, role, created_by, expires_at, is_active, timestamps)
- [x] T021 [P] Create ApiKey Pydantic model in `shared/shared/models/api_key.py` (id, name, key_hash, key_prefix, is_active, timestamps)
- [x] T021a [P] Create Location Pydantic model in `shared/shared/models/location.py` (user_id, coords geopoint, heading, updated_at)
- [x] T022 Create shared models barrel export in `shared/shared/models/__init__.py`

### Backend Core Infrastructure

- [x] T023 Implement FastAPI app entry point with lifespan handler (firebase_admin.initialize_app, AsyncClient init) in `backend/src/main.py`
- [x] T024 Implement Firebase Auth token verification dependency (`get_current_user`) using `firebase_admin.auth.verify_id_token` wrapped in `asyncio.to_thread` in `backend/src/auth/firebase_auth.py`
- [x] T025 Implement role-based authorization dependency (`require_role`) that checks `trip.participants[user_id].role` in `backend/src/auth/permissions.py`
- [x] T026 Implement FastAPI dependency injection setup (Firestore AsyncClient, GCS client, Gemini client) in `backend/src/deps.py`
- [x] T027 [P] Implement base Firestore repository abstract class with CRUD operations in `backend/src/repositories/base_repository.py`
- [x] T028 Implement TripRepository (create, get, list by user, update) in `backend/src/repositories/trip_repository.py`
- [x] T029 [P] Implement UserRepository (create_or_update, get, api_keys subcollection) in `backend/src/repositories/user_repository.py`
- [x] T030 Configure CORS middleware and error handling in `backend/src/main.py`

### Frontend Core Infrastructure

- [x] T031 Initialize Firebase client SDK with `persistentLocalCache` and `persistentMultipleTabManager` in `frontend/lib/firebase.ts` (Client Component compatible, dynamic import)
- [x] T032 Create backend API client with Firebase ID token injection in `frontend/lib/api.ts`
- [x] T033 Implement `proxy.ts` for auth token forwarding to backend API in `frontend/proxy.ts`
- [x] T034 Create Firebase Auth context provider with Google/Apple/Yahoo sign-in in `frontend/components/auth/auth-provider.tsx`
- [x] T035 [P] Create sign-in page in `frontend/app/sign-in/page.tsx`
- [x] T036 Create root layout with AuthProvider and Google Maps APIProvider in `frontend/app/layout.tsx`
- [x] T037 [P] Create Firestore real-time listener hooks (`useTrip`, `useTripNodes`, `useTripEdges`) in `frontend/lib/firestore-hooks.ts`

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 — Text-to-Map Magic Import (Priority: P1) 🎯 MVP

**Goal**: Users paste unstructured text → AI agent extracts categorized notes → asks clarifying questions → assembles DAG → displays on interactive map.

**Independent Test**: Paste a multi-stop itinerary, verify agent extracts notes, asks clarifications, and produces a DAG with nodes on a map connected by edges.

### Shared Library — Agent & DAG Assembly

- [x] T038 [P] [US1] Implement agent configuration (system prompt template, tool declarations for Google Maps & Search, response schema with notes/categories/confidence/ready_to_build) in `shared/shared/agent/config.py`
- [x] T039 [P] [US1] Implement DAG assembly logic (convert finalized notes into Node and Edge instances with geocoding lookups) in `shared/shared/dag/assembler.py`
- [x] T040 [P] [US1] Implement agent response schema Pydantic models (ImportChatResponse with reply, notes list, ready_to_build flag) in `shared/shared/agent/schemas.py`

### Backend — Agent Service & Import Endpoints

- [x] T041 [US1] Implement Gemini agent service (create chat session, send message, handle tool calls for Maps/Search, parse structured responses) in `backend/src/services/agent_service.py`
- [x] T042 [US1] Implement ChatHistoryRepository for GCS read/write (`{user_id}/{trip_id}/chat-history.json`, 12h session TTL check) in `backend/src/repositories/chat_history_repository.py`
- [x] T043 [P] [US1] Implement PlanRepository (create, get, list by trip, update status) in `backend/src/repositories/plan_repository.py`
- [x] T044 [P] [US1] Implement NodeRepository (create, get, list by plan, update, delete, batch create) in `backend/src/repositories/node_repository.py`
- [x] T045 [P] [US1] Implement EdgeRepository (create, get, list by plan, update, delete, batch create) in `backend/src/repositories/edge_repository.py`
- [x] T046 [US1] Implement TripService (create trip, get trip with participants check) in `backend/src/services/trip_service.py`
- [x] T047 [US1] Implement DAGService (create plan with nodes and edges from assembler output, get full DAG) in `backend/src/services/dag_service.py`
- [x] T048 [US1] Implement import chat endpoint `POST /api/v1/trips/{tripId}/import/chat` in `backend/src/api/agent.py` (accepts messages array, delegates to agent_service, returns reply + notes + ready_to_build)
- [x] T049 [US1] Implement import build endpoint `POST /api/v1/trips/{tripId}/import/build` in `backend/src/api/agent.py` (accepts final messages, calls DAG assembler, persists plan/nodes/edges to Firestore)
- [x] T050 [P] [US1] Implement trip CRUD endpoints (`POST /api/v1/trips`, `GET /api/v1/trips`, `GET /api/v1/trips/{tripId}`) in `backend/src/api/trips.py`
- [x] T051 [P] [US1] Implement node list endpoint `GET /api/v1/trips/{tripId}/plans/{planId}/nodes` in `backend/src/api/nodes.py`
- [x] T052 [P] [US1] Implement edge list endpoint `GET /api/v1/trips/{tripId}/plans/{planId}/edges` in `backend/src/api/edges.py`

### Frontend — Import Flow & Map

- [x] T053 [US1] Create trip list page (Server Component fetching user's trips) in `frontend/app/page.tsx`
- [x] T054 [US1] Create new trip page with name input and creation in `frontend/app/trips/new/page.tsx`
- [x] T055 [US1] Create trip layout (loads trip data, provides context) in `frontend/app/trips/[tripId]/layout.tsx`
- [x] T056 [US1] Create Magic Import chat UI (Client Component — text input, message display, clarification Q&A, skip button, build confirmation) in `frontend/app/trips/[tripId]/import/page.tsx`
- [x] T057 [US1] Create chat message components (user messages, agent responses with categorized notes display) in `frontend/components/chat/chat-messages.tsx`
- [x] T058 [US1] Create interactive map component (Client Component — Google Map with node markers, edge polylines, info windows) in `frontend/components/map/trip-map.tsx`
- [x] T059 [US1] Create node marker component (styled by type: city/hotel/restaurant/place/activity) in `frontend/components/map/node-marker.tsx`
- [x] T060 [US1] Create edge polyline component (route lines between nodes) in `frontend/components/map/edge-polyline.tsx`
- [x] T061 [US1] Create trip map page with real-time Firestore listeners for nodes/edges in `frontend/app/trips/[tripId]/page.tsx`
- [x] T062 [US1] Create node detail bottom sheet (tap node → shows name, dates, travel info) in `frontend/components/dag/node-detail-sheet.tsx`
- [x] T063 [US1] Create edge detail component (tap edge → shows travel mode, duration, distance) in `frontend/components/dag/edge-detail.tsx`
- [x] T064 [US1] Handle empty/whitespace input and no-locations-found edge cases in import UI in `frontend/app/trips/[tripId]/import/page.tsx`
- [x] T065 [US1] Handle input text length cap (10,000 chars) with user feedback in import UI in `frontend/app/trips/[tripId]/import/page.tsx`

**Checkpoint**: US1 complete — users can create a trip, import text, interact with the AI agent, and see the resulting DAG on an interactive map. This is the MVP.

---

## Phase 4: User Story 3 — Cascading Schedule Updates (Priority: P2)

**Goal**: Modifying a node's schedule propagates changes downstream through the DAG. Users see a preview before confirming.

**Independent Test**: Modify a mid-trip node's dates, verify all downstream nodes shift, preview is shown, and confirmation applies changes.

**Dependencies**: Requires US1 (DAG exists with nodes/edges).

### Backend — Cascade Engine

- [x] T066 [US3] Implement cascade algorithm in DAGService (BFS from modified node, compute new arrival times via `child.arrival = parent.arrival + parent.duration + edge.travel_time`, path-aware traversal at divergence points, conflict detection) in `backend/src/services/dag_service.py`
- [x] T067 [US3] Implement cascade preview (return list of affected nodes with before/after times and conflict warnings) in `backend/src/services/dag_service.py`
- [x] T068 [US3] Implement cascade confirm (atomic Firestore transaction to batch-write all affected nodes) in `backend/src/services/dag_service.py`
- [x] T069 [US3] Implement node update endpoint `PATCH /api/v1/trips/{tripId}/plans/{planId}/nodes/{nodeId}` with cascade preview in response in `backend/src/api/nodes.py`
- [x] T070 [US3] Implement cascade confirm endpoint `POST /api/v1/trips/{tripId}/plans/{planId}/nodes/{nodeId}/cascade/confirm` in `backend/src/api/nodes.py`

### Frontend — Cascade Preview UI

- [x] T071 [US3] Create node edit form (inline editing of dates, duration) in `frontend/components/dag/node-edit-form.tsx`
- [x] T072 [US3] Create cascade preview modal (shows affected nodes with before/after dates, conflict warnings, confirm/cancel buttons) in `frontend/components/dag/cascade-preview.tsx`
- [x] T073 [US3] Integrate cascade flow in trip map page (edit node → show preview → confirm → refresh) in `frontend/app/trips/[tripId]/page.tsx`
- [x] T074 [US3] Add role-based edit restrictions (Viewer cannot edit nodes — show permission denied message) in `frontend/components/dag/node-edit-form.tsx`

**Checkpoint**: US3 complete — schedule changes cascade downstream with preview and confirmation.

---

## Phase 5: User Story 2 — Implicit Branching & Group Sync (Priority: P2)

**Goal**: DAG supports divergent paths via multiple start nodes or mid-trip splits. Participants are assigned to post-split nodes. Paths are derived at runtime from DAG topology and `participant_ids`. Map shows distinct colored paths converging at merge nodes.

**Independent Test**: Create a DAG with a divergence point, assign participants to post-split nodes, verify map shows distinct colored paths converging at a merge node with arrival-time proximity.

**Dependencies**: Requires US1 (trip/DAG), benefits from US3 (cascade is path-aware at divergence points).

### Shared Library — Path Computation

- [x] T075 [P] [US2] Implement participant path computation algorithm in `shared/shared/dag/paths.py` (build adjacency list from edges, identify root nodes, BFS/DFS per participant following `participant_ids` at divergence points, return `Map<userId, List<nodeId>>`)
- [x] T076 [P] [US2] Implement divergence point detection (nodes with out-degree > 1) and unresolved flow detection (participant not assigned at divergence) in `shared/shared/dag/paths.py`
- [x] T077 [P] [US2] Implement merge node detection (nodes with in-degree > 1 where incoming edges originate from different computed paths) in `shared/shared/dag/paths.py`

### Backend — Invites, Participant Assignment, Path APIs

- [x] T078 [P] [US2] Implement InviteLinkRepository (create, get by token, deactivate) in `backend/src/repositories/invite_link_repository.py`
- [x] T079 [P] [US2] Implement NotificationRepository (create, list by user, mark read) in `backend/src/repositories/notification_repository.py`
- [x] T080 [US2] Implement InviteService (generate token, validate expiry, claim invite — add user to trip with role) in `backend/src/services/invite_service.py`
- [x] T081 [US2] Implement NotificationService (create notification, fan out to target users, create `unresolved_path` notifications) in `backend/src/services/notification_service.py`
- [x] T082 [US2] Implement invite endpoints (`POST /api/v1/trips/{tripId}/invites`, `POST /api/v1/invites/{token}/claim`) in `backend/src/api/invites.py`
- [x] T083 [US2] Implement participant assignment endpoint `PATCH /api/v1/trips/{tripId}/plans/{planId}/nodes/{nodeId}/participants` (set `participant_ids` on node, requires Admin/Planner) in `backend/src/api/nodes.py`
- [x] T084 [US2] Implement path computation endpoint `GET /api/v1/trips/{tripId}/plans/{planId}/paths` (compute and return each participant's derived path with colors) in `backend/src/api/paths.py`
- [x] T085 [US2] Implement path warnings endpoint `GET /api/v1/trips/{tripId}/plans/{planId}/warnings` (detect unresolved participant flows at divergence points) in `backend/src/api/paths.py`
- [x] T086 [US2] Implement notification endpoints (`GET /api/v1/trips/{tripId}/notifications`, `PATCH /api/v1/trips/{tripId}/notifications/{notificationId}`) in `backend/src/api/notifications.py`

### Frontend — Invites, Path Visualization, Participant Assignment

- [x] T087 [US2] Create invite link claim page (authenticate + auto-join trip with role) in `frontend/app/invite/[token]/page.tsx`
- [x] T088 [US2] Create trip settings page with invite link generation (Admin only — one link per role) in `frontend/app/trips/[tripId]/settings/page.tsx`
- [x] T089 [US2] Implement client-side path computation for real-time coloring in `frontend/lib/path-computation.ts` (mirrors shared library logic, runs on nodes/edges from Firestore listeners)
- [x] T090 [US2] Implement path-colored polylines on map (distinct color per participant group derived from path computation) in `frontend/components/map/edge-polyline.tsx`
- [x] T091 [US2] Implement merge node marker (special styling showing multiple groups' arrival times) in `frontend/components/map/node-marker.tsx`
- [x] T092 [US2] Implement path visibility toggle (show all paths / show my path only) in `frontend/components/map/path-filter.tsx`
- [x] T093 [US2] Create participant assignment UI for divergence points (Admin/Planner assigns participants to post-split nodes) in `frontend/components/dag/participant-assignment.tsx`
- [x] T094 [US2] Create unresolved path warning banner (shows which participants need assignment at divergence points) in `frontend/components/dag/path-warnings.tsx`
- [x] T095 [US2] Create notification bell component with unread count and dropdown in `frontend/components/ui/notification-bell.tsx`
- [x] T096 [US2] Add Firestore `onSnapshot` listener for notifications in `frontend/lib/firestore-hooks.ts`

**Checkpoint**: US2 complete — participants join via invite links, divergent paths display as colored routes, merge nodes show convergence, unresolved flows trigger warnings.

---

## Phase 6: User Story 6 — In-App Agent for Ongoing Trip Management (Priority: P2)

**Goal**: Users summon the AI agent from any trip view to make changes conversationally — add/remove nodes, update times, search places, research destinations.

**Independent Test**: Open existing trip, summon agent, ask to add a stop between two nodes, verify DAG updates with new node and recalculated edges.

**Dependencies**: Requires US1 (agent infrastructure), US3 (cascade engine for agent-triggered changes).

### Backend — Ongoing Agent

- [x] T097 [US6] Extend AgentService for ongoing trip management (load trip context into system prompt, inject preferences, handle session continuity from GCS with 12h TTL) in `backend/src/services/agent_service.py`
- [x] T098 [US6] Implement agent tool dispatch for DAG modifications (add/remove/update/reorder nodes, cascade changes, reconnect edges) in `backend/src/services/agent_service.py`
- [x] T099 [US6] Implement agent tool dispatch for Google Maps (geocoding, directions, places search) and Google Search (destination research) in `backend/src/services/agent_service.py`
- [x] T100 [US6] Implement preference extraction (agent identifies travel rules/constraints from conversation, saves to `trips/{tripId}/preferences`) in `backend/src/services/agent_service.py`
- [x] T101 [P] [US6] Implement PreferenceRepository (create, list by trip) in `backend/src/repositories/preference_repository.py`
- [x] T102 [US6] Implement ongoing agent chat endpoint `POST /api/v1/trips/{tripId}/agent/chat` (single message input, returns reply + actions_taken + preferences_extracted) in `backend/src/api/agent.py`

### Frontend — Agent Chat UI

- [x] T103 [US6] Create ongoing agent chat panel (slide-up panel or drawer accessible from trip map view) in `frontend/app/trips/[tripId]/agent/page.tsx`
- [x] T104 [US6] Create agent action badges (visual feedback for actions_taken — node added, cascade applied, places searched) in `frontend/components/chat/action-badges.tsx`
- [x] T105 [US6] Integrate agent chat with map (agent changes trigger real-time updates via onSnapshot, highlight affected nodes) in `frontend/app/trips/[tripId]/page.tsx`
- [x] T106 [US6] Create summon agent button on trip map view in `frontend/app/trips/[tripId]/page.tsx`

**Checkpoint**: US6 complete — users converse with the agent to manage trips, changes reflect in real-time on the map.

---

## Phase 7: User Story 4 — Alternative Plan Versioning (Priority: P3)

**Goal**: Planners create alternative plan versions, compare side-by-side, Admins promote alternatives to main.

**Independent Test**: Create alternative plan, make changes, promote to main, verify all members see the updated plan.

**Dependencies**: Requires US1 (plans/DAG).

### Backend — Plan Versioning

- [x] T107 [US4] Implement PlanService (deep clone plan with all nodes/edges, promote plan — swap active_plan_id, archive old main, create notifications, warn active editors via notification before promotion) in `backend/src/services/plan_service.py`
- [x] T108 [US4] Implement plan endpoints (`POST /api/v1/trips/{tripId}/plans` for clone, `POST /api/v1/trips/{tripId}/plans/{planId}/promote` for Admin-only promotion) in `backend/src/api/plans.py`

### Frontend — Plan Versioning UI

- [x] T109 [US4] Create plan version switcher (dropdown/tabs showing plan names and statuses) in `frontend/components/dag/plan-switcher.tsx`
- [x] T110 [US4] Create "Create Alternative" button (available to Planners and Admins) in `frontend/app/trips/[tripId]/settings/page.tsx`
- [x] T111 [US4] Implement plan promotion flow (Admin-only button, confirmation dialog, notification sent) in `frontend/app/trips/[tripId]/settings/page.tsx`
- [x] T112 [US4] Update trip map to reload nodes/edges when active plan changes (listen to trip document `active_plan_id` field) in `frontend/app/trips/[tripId]/page.tsx`

**Checkpoint**: US4 complete — alternative plans can be created, compared, and promoted.

---

## Phase 8: User Story 5 — Offline Access & Pulse Check-in (Priority: P3)

**Goal**: Read-only offline access to trip data; manual Pulse check-in broadcasts location to group.

**Independent Test**: Load trip online, go offline, verify map/nodes/notes viewable; go online, trigger Pulse, verify avatar visible to others.

**Dependencies**: Requires US1 (trip view with map).

### Backend — Pulse

- [x] T113 [P] [US5] Implement LocationRepository (upsert user location, get all locations for trip) in `backend/src/repositories/location_repository.py`
- [x] T114 [US5] Implement Pulse endpoint `POST /api/v1/trips/{tripId}/pulse` (write GPS coords to `trips/{tripId}/locations/{userId}`) in `backend/src/api/pulse.py`

### Frontend — Offline & Pulse

- [x] T115 [US5] Implement offline detection and UI mode switch (check `navigator.onLine`, disable edit actions, show offline banner) in `frontend/components/ui/offline-banner.tsx`
- [x] T116 [US5] Implement Pulse check-in button (get GPS via `navigator.geolocation`, POST to backend, handle GPS unavailability with manual pin option) in `frontend/components/map/pulse-button.tsx`
- [x] T117 [US5] Implement Pulse avatar markers on map (show other users' last known positions from `trips/{tripId}/locations` via onSnapshot) in `frontend/components/map/pulse-avatars.tsx`
- [x] T118 [US5] Add Firestore `onSnapshot` listener for locations collection in `frontend/lib/firestore-hooks.ts`
- [x] T119 [US5] Implement offline Pulse queue (store check-in in localStorage when offline, flush on reconnect) in `frontend/lib/offline-queue.ts`

**Checkpoint**: US5 complete — trip viewable offline, Pulse check-ins broadcast location in real-time.

---

## Phase 9: User Story 7 — External AI Assistant via MCP Server (Priority: P3)

**Goal**: External AI agents connect via MCP Server using API keys to query and modify trips with full feature parity.

**Independent Test**: Configure MCP client with API key, query trip data, modify nodes, verify changes appear in the app in real-time.

**Dependencies**: Requires US1 (trip data), US3 (cascade engine), US6 (agent service layer for DAG operations).

### Backend — API Key Management

- [ ] T120 [US7] Implement API key generation endpoint `POST /api/v1/users/me/api-keys` (generate random key, store HMAC-SHA256 hash using server-side secret, return plaintext once) in `backend/src/api/users.py`
- [ ] T121 [US7] Implement API key list and revoke endpoints (`GET /api/v1/users/me/api-keys`, `DELETE /api/v1/users/me/api-keys/{keyId}`) in `backend/src/api/users.py`
- [ ] T122 [P] [US7] Implement user profile endpoint `GET /api/v1/users/me` in `backend/src/api/users.py`

### MCP Server — Tools & Auth

- [ ] T123 [US7] Implement MCP API key authentication (compute HMAC-SHA256 of provided key using server secret, lookup hash in Firestore `users/{}/api_keys`, resolve user, check `is_active`) in `mcpserver/src/auth/api_key_auth.py`
- [ ] T124 [US7] Implement MCP Firestore repositories (reuse patterns from backend — TripRepository, NodeRepository, EdgeRepository, PlanRepository) in `mcpserver/src/repositories/`
- [ ] T125 [US7] Implement MCP TripService (delegates to shared library for DAG and path logic) in `mcpserver/src/services/trip_service.py`
- [ ] T126 [P] [US7] Implement `get_trips` MCP tool in `mcpserver/src/tools/trips.py`
- [ ] T127 [P] [US7] Implement `get_trip_versions` MCP tool in `mcpserver/src/tools/trips.py`
- [ ] T128 [P] [US7] Implement `get_trip_context` MCP tool (returns full DAG + participant locations + computed paths) in `mcpserver/src/tools/trips.py`
- [ ] T129 [US7] Implement `create_or_modify_trip` MCP tool (full CRUD on nodes + edges with `participant_ids`, auto-cascade, create plan if none exists) in `mcpserver/src/tools/trips.py`
- [ ] T130 [P] [US7] Implement `suggest_stop` MCP tool (Google Places API search along route) in `mcpserver/src/tools/places.py`
- [ ] T131 [P] [US7] Implement `add_action` MCP tool (attach note/todo/place to node) in `mcpserver/src/tools/actions.py`
- [ ] T132 [P] [US7] Implement `search_places` MCP tool (Google Places API near location) in `mcpserver/src/tools/places.py`
- [ ] T133 [P] [US7] Implement `search_web` MCP tool (web search for travel info) in `mcpserver/src/tools/search.py`
- [ ] T134 [US7] Implement FastMCP server entry point with tool registration and auth middleware in `mcpserver/src/main.py`

### Frontend — API Key Management

- [ ] T135 [US7] Create user profile page with API key management (generate, list, revoke) in `frontend/app/profile/page.tsx`

**Checkpoint**: US7 complete — external AI agents can query and modify trips via MCP with full feature parity.

---

## Phase 10: Cross-Cutting — Node Actions & User Management

**Purpose**: Features that serve multiple user stories.

### Backend — Node Actions

- [x] T136 [P] Implement ActionRepository (create, list by node) in `backend/src/repositories/action_repository.py`
- [x] T137 Implement action endpoints (`POST /api/v1/trips/{tripId}/plans/{planId}/nodes/{nodeId}/actions`, `GET .../actions`) — Viewer role allowed for writes in `backend/src/api/nodes.py`

### Frontend — Node Actions

- [x] T138 Create action list component (notes, todos, places displayed within node detail sheet) in `frontend/components/dag/action-list.tsx`
- [x] T139 Create add action form (note/todo/place type selector, text input, place picker) in `frontend/components/dag/add-action-form.tsx`
- [x] T140 Add onSnapshot listener for actions subcollection in `frontend/lib/firestore-hooks.ts`

### Backend — User Profile

- [x] T141 Implement user creation/update on first sign-in (upsert from Firebase token claims) in `backend/src/services/user_service.py`

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories.

- [x] T142 [P] Implement Firestore security rules (trips, plans, nodes, edges, actions, locations, invites, notifications, preferences, users/api_keys) in `firestore.rules`
- [x] T143 [P] Create required Firestore indexes (nodes by participant_ids+order, edges by source, notifications by user+date, api_keys by hash+active) in `firestore.indexes.json`
- [ ] T144 [P] Configure GCS bucket lifecycle policy (7-day auto-delete for chat history) via Terraform or gcloud CLI
- [x] T145 Implement error response formatting (standard `{ error: { code, message } }` format) across all backend endpoints in `backend/src/main.py`
- [x] T146 Implement concurrent edit conflict detection (compare node `updated_at` timestamp in Firestore transaction — if changed since client read, notify second editor via `edit_conflict` notification; last-write-wins) in `backend/src/services/dag_service.py`
- [x] T147 Handle circular routes in DAG (return to origin creates A' node to preserve acyclic property) in `shared/shared/dag/assembler.py`
- [x] T148 Handle expired/invalid invite links with clear error messages in `backend/src/services/invite_service.py`
- [x] T149 Implement automatic cleanup of stale `participant_ids` when DAG becomes linear (all divergent paths removed) in `backend/src/services/dag_service.py`
- [x] T150 Validate participant assignment reachability (reject assignment to unreachable nodes) in `backend/src/services/dag_service.py`
- [ ] T151 [P] Mobile-first responsive styling pass across all pages (bottom sheets, touch targets, map controls) in `frontend/`
- [x] T152 Add timing instrumentation for import flow (SC-001: < 60s for 1,500-word itinerary) and cascade engine (SC-002: < 5s for downstream propagation) with logged metrics in `backend/src/services/agent_service.py` and `backend/src/services/dag_service.py`
- [ ] T153 Run quickstart.md validation (verify all setup steps work end-to-end)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Foundational — MVP, must complete first
- **US3 (Phase 4)**: Depends on US1 (DAG must exist)
- **US2 (Phase 5)**: Depends on US1, benefits from US3 (cascade is path-aware)
- **US6 (Phase 6)**: Depends on US1 (agent infra), US3 (cascade engine)
- **US4 (Phase 7)**: Depends on US1 (plans/DAG)
- **US5 (Phase 8)**: Depends on US1 (trip view)
- **US7 (Phase 9)**: Depends on US1, US3, US6 (full agent + cascade capabilities)
- **Cross-Cutting (Phase 10)**: Can start after US1, complements all stories
- **Polish (Phase 11)**: Depends on all desired user stories being complete

### User Story Dependencies

```
Phase 1: Setup
    ↓
Phase 2: Foundational
    ↓
Phase 3: US1 Magic Import (P1) ← MVP
    ↓         ↓           ↓
Phase 4:   Phase 7:    Phase 8:    Phase 10:
US3        US4         US5         Cross-Cutting
Cascade    Versioning  Offline     (Actions, etc.)
    ↓
Phase 5: US2 Implicit Branching
    ↓
Phase 6: US6 Ongoing Agent
    ↓
Phase 9: US7 MCP Server
    ↓
Phase 11: Polish
```

### Within Each User Story

- Models before services
- Services before endpoints
- Core implementation before integration
- Backend before frontend (frontend depends on API)

### Parallel Opportunities

- All Setup tasks T004-T011 can run in parallel
- All Foundational model tasks T012-T021 can run in parallel
- Within US1: T038-T040 (shared lib) in parallel, T043-T045 (repositories) in parallel, T050-T052 (endpoints) in parallel
- Within US2: T075-T077 (path computation) in parallel, T078-T079 (repositories) in parallel
- US4, US5 can run in parallel (both only depend on US1)
- Within US7: T126-T128, T130-T133 (read-only MCP tools) all in parallel

---

## Parallel Example: User Story 2 (Implicit Branching)

```bash
# Launch path computation tasks in parallel:
Task: "Implement participant path computation in shared/shared/dag/paths.py"
Task: "Implement divergence point detection in shared/shared/dag/paths.py"
Task: "Implement merge node detection in shared/shared/dag/paths.py"

# Launch repository tasks in parallel:
Task: "Implement InviteLinkRepository in backend/src/repositories/invite_link_repository.py"
Task: "Implement NotificationRepository in backend/src/repositories/notification_repository.py"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1 — Magic Import
4. **STOP and VALIDATE**: Paste itinerary → AI extracts notes → clarification → DAG on map
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 (Magic Import) → Test → Deploy (MVP!)
3. US3 (Cascade) → Test → Deploy
4. US2 (Implicit Branching) + US6 (Agent) → Test → Deploy
5. US4 (Versioning) + US5 (Offline/Pulse) → Test → Deploy
6. US7 (MCP Server) → Test → Deploy
7. Polish → Final release

### Parallel Team Strategy

With multiple developers after Foundational is done:

- **Developer A**: US1 → US3 → US6 (agent + cascade track)
- **Developer B**: US1 frontend → US2 → US5 (paths + offline track)
- **Developer C**: US4 + US7 (versioning + MCP track)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Read `node_modules/next/dist/docs/` before writing any Next.js code (per AGENTS.md)
- All Python services share single `travel-app` conda environment
- Use ADC for all Google Cloud auth — no service account JSON files
- **Implicit branching**: No `branch_id` on edges, no `branch_ids` on nodes, no `branches` map on trips. Paths derived from DAG topology + `participant_ids`.
