<!--
Sync Impact Report
===================
Version change: 1.0.0 → 1.1.0 (add shared/ sub-project)
Modified principles: N/A
Added sections:
  - shared/ added to Technology Stack project structure
Removed sections: N/A
Templates requiring updates:
  - .specify/templates/plan-template.md — ✅ no changes needed (generic)
  - .specify/templates/spec-template.md — ✅ no changes needed (generic)
  - .specify/templates/tasks-template.md — ✅ no changes needed (generic)
  - .specify/templates/commands/ — no command files exist
Follow-up TODOs: none
-->

# Smart Travel Buddy App Constitution

## Core Principles

### I. Next.js 16 Best Practices

The frontend MUST be built with Next.js 16 following its current
conventions, APIs, and file structure. Before writing any frontend
code, the relevant guide in `node_modules/next/dist/docs/` MUST be
consulted to account for breaking changes from earlier versions.

- All frontend code MUST use the App Router and Next.js 16 idioms.
- Deprecation notices from Next.js 16 MUST be heeded; deprecated
  APIs MUST NOT be introduced into new code.
- Server Components MUST be the default; Client Components used
  only when interactivity or browser APIs are required.

### II. Object-Oriented Python Backend

The backend and MCP server MUST use Python with FastAPI and FastMCP
respectively, following object-oriented design principles.

- Every distinct domain concept MUST be represented as a class.
- Business logic MUST live in service classes, not in route
  handlers or MCP tool definitions.
- Data models MUST use Pydantic for validation and serialization.
- FastMCP tool implementations MUST delegate to service classes
  rather than containing logic inline.

### III. Separation of Concerns

Each class and module MUST have a single, well-defined
responsibility. Boundaries between layers MUST be explicit.

- Route handlers / MCP tools: request parsing, response formatting.
- Service classes: business logic and orchestration.
- Repository / data-access classes: persistence operations.
- Models: data shape and validation only.
- No layer may bypass an adjacent layer (e.g., a route handler
  MUST NOT query the database directly).

### IV. Modular & Testable Code

All code MUST be written to be modular, independently testable,
maintainable, and swappable.

- Dependencies MUST be injected, not hard-coded, so implementations
  can be replaced without changing consumers.
- Each module MUST be importable and testable in isolation without
  requiring the full application to be running.
- Interfaces (abstract base classes in Python, TypeScript interfaces
  in the frontend) SHOULD be used at module boundaries to enable
  substitution.
- Side effects (network calls, file I/O, database access) MUST be
  isolated behind explicit abstractions.

## Technology Stack

- **Frontend**: Next.js 16 (TypeScript, React, Tailwind CSS)
- **Backend API**: Python 3.12+, FastAPI
- **MCP Server**: Python 3.12+, FastMCP
- **Package Manager (frontend)**: pnpm
- **Project Structure**:
  - `frontend/` — Next.js application
  - `backend/` — FastAPI service
  - `mcpserver/` — FastMCP server
  - `shared/` — Shared Python library (Pydantic models, parsing logic; imported by backend and mcpserver)

Each sub-project MUST maintain its own dependency manifest and MUST
be runnable independently of the others for local development.

## Development Workflow

- Code reviews MUST verify compliance with all Core Principles
  before merging.
- Every pull request MUST include evidence that new or changed code
  is testable (test files or manual verification steps).
- Linting and formatting tools MUST be configured and enforced in
  CI for both the frontend (ESLint, Prettier) and backend (ruff or
  equivalent).
- Commits SHOULD be atomic — one logical change per commit.

## Governance

This constitution is the authoritative source for architectural
decisions and non-negotiable practices in the Smart Travel Buddy
App project. It supersedes ad-hoc decisions made in code reviews
or conversations.

- **Amendments**: Any change to this constitution MUST be documented
  with a version bump, a rationale, and an updated Sync Impact
  Report at the top of this file.
- **Versioning**: MAJOR for principle removals or redefinitions,
  MINOR for new principles or material expansions, PATCH for
  clarifications and wording fixes.
- **Compliance**: All plans, specs, and task lists produced by
  Specify commands MUST be checked against these principles. The
  Constitution Check section in plan templates MUST reference the
  current principles by number.
- **Guidance**: See `AGENTS.md` for runtime development guidance
  specific to the AI-assisted workflow.

**Version**: 1.1.0 | **Ratified**: 2026-03-26 | **Last Amended**: 2026-03-26
