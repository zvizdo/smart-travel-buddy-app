# Implementation Plan: Travel DAG Platform

**Branch**: `001-travel-dag-platform` | **Date**: 2026-03-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-travel-dag-platform/spec.md`

## Summary

Mobile-first, AI-integrated travel orchestration platform that transforms unstructured text itineraries into dynamic Directed Acyclic Graphs (DAGs) visualized on interactive maps. The system uses a Next.js 16 frontend with Firestore real-time sync, a Python/FastAPI backend with Gemini 3 Flash for conversational AI import and ongoing trip management, a shared Python library for code reuse, and a FastMCP server for external AI agent integration. Core capabilities include **implicit branching** (paths derived from DAG topology and participant assignments, not stored as explicit branch entities), cascading schedule updates, plan versioning, offline read-only access, and real-time collaboration via Firestore `onSnapshot`.

## Technical Context

**Language/Version**: TypeScript 5+ (frontend), Python 3.12+ (backend, MCP server, shared library)
**Primary Dependencies**:
- Frontend: Next.js 16.2, React 19.2, `@vis.gl/react-google-maps`, Firebase JS SDK v10+, Tailwind CSS
- Backend: FastAPI, `google-cloud-firestore[async]`, `firebase-admin`, `google-genai` (Gemini 3 Flash)
- MCP Server: FastMCP (`mcp` SDK), shared library
- Shared: Pydantic 2.0+, shared agent config & DAG assembly logic

**Storage**: Google Firestore (Native mode) with offline IndexedDB persistence; Google Cloud Storage for agent chat history (7-day auto-delete lifecycle)
**Testing**: Frontend: Jest/Vitest + React Testing Library; Backend/Shared/MCP: pytest
**Target Platform**: Mobile-first Progressive Web App (mobile browsers), Python services on Cloud Run/GKE
**Project Type**: Web application (frontend + backend API + MCP server + shared library)
**Performance Goals**: Import 1,500-word itinerary → complete DAG in <60s; cascade updates in <5s; Pulse visible to others in <30s; plan promotion propagates in <10s
**Constraints**: Offline read-only (no edits without connectivity); Firestore 500-doc transaction limit (sufficient for 50-node DAGs); 10,000 char import text cap; English only for v1
**Scale/Scope**: 2-20 members per trip; up to 50 nodes, 100 edges per DAG; in-app notifications only (no push/email)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| I | Next.js 16 Best Practices | ✅ PASS | App Router, Server Components default, Client Components only for maps/chat/real-time listeners/Pulse. `proxy.ts` for auth forwarding. React Compiler enabled. Turbopack default. See R1. |
| II | Object-Oriented Python Backend | ✅ PASS | FastAPI backend + FastMCP server. Domain concepts as classes. Business logic in service classes. Pydantic models. MCP tools delegate to services. See R3, R7. |
| III | Separation of Concerns | ✅ PASS | Route handlers → services → repositories → Firestore. MCP tools → services → repositories. Models for validation only. No layer bypass. |
| IV | Modular & Testable Code | ✅ PASS | Dependency injection throughout. Shared library independently testable. Abstract interfaces at module boundaries. Side effects isolated behind repository/client abstractions. |
| Tech Stack | Constitution alignment | ✅ PASS | Next.js 16 (TS, React, Tailwind), FastAPI, FastMCP, pnpm, project structure matches `frontend/`, `backend/`, `mcpserver/`, `shared/`. |
| Dev Workflow | Constitution alignment | ✅ PASS | ESLint+Prettier for frontend, ruff for Python. Atomic commits. PRs require test evidence. |

**Pre-Phase 0 gate**: PASSED — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-travel-dag-platform/
├── plan.md              # This file
├── research.md          # Phase 0 output — 11 research topics resolved
├── data-model.md        # Phase 1 output — Firestore document schema (implicit branching)
├── quickstart.md        # Phase 1 output — setup & run guide
├── contracts/
│   ├── backend-api.md   # Phase 1 output — REST API contract
│   └── mcp-tools.md     # Phase 1 output — MCP tool definitions
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
frontend/                    # Next.js 16 application (TypeScript, React, Tailwind)
├── app/                     # App Router pages & layouts
│   ├── layout.tsx           # Root layout (Server Component)
│   ├── page.tsx             # Landing / trip list
│   ├── trips/
│   │   ├── [tripId]/
│   │   │   ├── layout.tsx   # Trip layout (loads trip context)
│   │   │   ├── page.tsx     # Map view (Client Component)
│   │   │   ├── import/      # Magic Import chat UI
│   │   │   ├── agent/       # Ongoing agent chat
│   │   │   └── settings/    # Trip settings, invites, participant assignments
│   │   └── new/             # Create trip flow
│   ├── invite/
│   │   └── [token]/         # Invite link claim
│   ├── profile/             # User profile, API key management
│   └── api/                 # API route handlers (if needed)
├── proxy.ts                 # Auth token forwarding to backend
├── components/              # Shared React components
│   ├── map/                 # Google Maps components (Client)
│   ├── dag/                 # DAG visualization + path components
│   ├── chat/                # Chat UI (import + agent)
│   └── ui/                  # Base UI components
├── lib/                     # Client-side utilities
│   ├── firebase.ts          # Firebase init (Client — IndexedDB persistence)
│   ├── firestore-hooks.ts   # onSnapshot hooks for real-time data
│   ├── api.ts               # Backend API client
│   └── path-computation.ts  # Client-side participant path derivation
└── tests/

backend/                     # FastAPI service (Python 3.12+)
├── src/
│   ├── main.py              # App entry, lifespan, CORS
│   ├── api/                 # Route handlers (thin — delegate to services)
│   │   ├── trips.py
│   │   ├── nodes.py
│   │   ├── edges.py
│   │   ├── plans.py
│   │   ├── paths.py         # Participant path computation + warnings
│   │   ├── agent.py         # Import chat + ongoing agent endpoints
│   │   ├── users.py
│   │   ├── invites.py
│   │   ├── pulse.py
│   │   └── notifications.py
│   ├── services/            # Business logic & orchestration
│   │   ├── trip_service.py
│   │   ├── dag_service.py   # Cascade engine, node/edge CRUD, path computation
│   │   ├── agent_service.py # Gemini agent management, tool dispatch
│   │   ├── plan_service.py  # Versioning, promotion
│   │   ├── invite_service.py
│   │   ├── user_service.py  # User profile upsert on first sign-in
│   │   └── notification_service.py
│   ├── repositories/        # Firestore data access (async)
│   │   ├── trip_repository.py
│   │   ├── node_repository.py
│   │   ├── edge_repository.py
│   │   ├── plan_repository.py
│   │   ├── user_repository.py
│   │   └── chat_history_repository.py  # GCS read/write
│   ├── models/              # Pydantic models (request/response/domain)
│   ├── auth/                # Firebase token verification, role checking
│   └── deps.py              # FastAPI dependency injection
├── requirements.txt
└── tests/

shared/                      # Shared Python library (Pydantic models, agent config, DAG logic)
├── shared/
│   ├── __init__.py
│   ├── models/              # Shared Pydantic domain models
│   ├── agent/               # Agent configuration (prompts, tool declarations, response schemas)
│   └── dag/                 # DAG assembly, cascade logic, path computation
├── setup.py                 # pip install -e shared/
└── tests/

mcpserver/                   # FastMCP server (Python 3.12+)
├── src/
│   ├── main.py              # FastMCP server entry
│   ├── tools/               # MCP tool definitions (@mcp.tool decorators)
│   ├── services/            # Service layer (delegates to shared + repositories)
│   ├── repositories/        # Firestore data access
│   ├── auth/                # API key validation
│   └── models/              # MCP-specific request/response models
├── requirements.txt
└── tests/
```

**Structure Decision**: Web application with four sub-projects (`frontend/`, `backend/`, `shared/`, `mcpserver/`) matching the constitution's project structure. The `shared/` library is installed in editable mode and imported by both `backend/` and `mcpserver/` to avoid code duplication for agent configuration, Pydantic models, and DAG assembly logic.

## Phase 0: Research — Complete

All technical unknowns resolved in [research.md](research.md). Key decisions:

| # | Topic | Decision |
|---|-------|----------|
| R1 | Next.js 16 patterns | App Router, Server Components default, `proxy.ts`, React Compiler, Turbopack |
| R2 | Maps integration | `@vis.gl/react-google-maps` (official Google wrapper) |
| R3 | FastAPI + Firestore | `google-cloud-firestore[async]` with `AsyncClient`, batch transactions for cascades |
| R4 | AI agent | Gemini 3 Flash via `google-genai` SDK, structured output, Google Maps + Search tools |
| R5 | Auth | Firebase Auth on frontend, `firebase-admin` token verification on backend |
| R6 | Offline persistence | Firebase JS SDK v10+ `persistentLocalCache` with IndexedDB |
| R7 | MCP server | FastMCP with 8 tools, API key auth, delegates to shared library |
| R8 | Cascade algorithm | BFS from modified node, atomic Firestore transaction, path-aware |
| R9 | Google credentials | Application Default Credentials (ADC) everywhere |
| R10 | Python environment | Single conda env `travel-app` for all Python sub-projects |
| R11 | Implicit branching | Paths derived from DAG topology + `participant_ids` on nodes; no explicit branch entity |

## Phase 1: Design & Contracts — Complete

### Data Model

Full Firestore document schema in [data-model.md](data-model.md). Key changes from implicit branching model:

- **Removed**: `branch_ids` from Node, `branch_id` from Edge, `branches` map from Trip, `branch_id` from participants
- **Added**: `participant_ids` (optional array) on Node — null/empty for shared segments, populated at divergence points
- **Added**: Path computation algorithm (BFS/DFS from assigned start/post-split nodes)
- **Added**: `unresolved_path` notification type for unassigned participants at divergence points

Key collections:

- `trips` — root, with `participants` map (role + joined_at, no branch_id)
- `trips/{tripId}/plans` — plan versions (active/draft/archived)
- `trips/{tripId}/plans/{planId}/nodes` — DAG vertices with geocoordinates, timing, `participant_ids`
- `trips/{tripId}/plans/{planId}/edges` — DAG edges with travel mode/time (no branch_id)
- `trips/{tripId}/plans/{planId}/nodes/{nodeId}/actions` — notes, todos, places
- `trips/{tripId}/preferences` — agent-extracted travel rules (shared across members)
- `trips/{tripId}/locations` — Pulse check-ins
- `trips/{tripId}/invite_links` — role-specific invite tokens
- `trips/{tripId}/notifications` — in-app alerts (including `unresolved_path` type)
- `users` — profiles with `api_keys` subcollection (hashed)
- GCS: `{user_id}/{trip_id}/chat-history.json` — agent chat history (12h session TTL, 7-day bucket lifecycle)

### Interface Contracts

- **Backend REST API**: [contracts/backend-api.md](contracts/backend-api.md) — 20+ endpoints. New: `PATCH .../nodes/{nodeId}/participants` (assign participants), `GET .../plans/{planId}/paths` (compute paths), `GET .../plans/{planId}/warnings` (unresolved flows). Removed: branch CRUD endpoints.
- **MCP Tools**: [contracts/mcp-tools.md](contracts/mcp-tools.md) — 8 tools: `get_trips`, `get_trip_versions`, `get_trip_context`, `create_or_modify_trip`, `suggest_stop`, `add_action`, `search_places`, `search_web`. Nodes now use `participant_ids` instead of `branch_ids`; edges have no `branch_id`.

### Quickstart

Setup and run guide in [quickstart.md](quickstart.md). Single conda env, pnpm for frontend, ADC for all Google services. Unchanged from previous version.

## Constitution Re-Check (Post Phase 1)

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | Next.js 16 | ✅ PASS | Frontend structure uses App Router, proxy.ts, Client Components only where needed |
| II | OO Python | ✅ PASS | Service/repository/model classes in backend, MCP, and shared |
| III | Separation of Concerns | ✅ PASS | API → Service → Repository layering explicit in project structure |
| IV | Modular & Testable | ✅ PASS | DI via FastAPI deps, shared library independently testable, path computation in shared/dag/ |

**Post-Phase 1 gate**: PASSED — no violations.

## Complexity Tracking

No constitution violations to justify. The four sub-project structure (`frontend/`, `backend/`, `shared/`, `mcpserver/`) is explicitly mandated by the constitution's Technology Stack section.

---

**Next step**: Run `/speckit.tasks` to generate the updated implementation task list.
