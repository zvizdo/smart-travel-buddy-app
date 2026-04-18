# Smart Travel Buddy

**Your next trip, in every AI app you already use.** A collaborative, AI-first trip planner for your phone — chat your itinerary into existence, give every traveler their own path, and keep planning from Claude, ChatGPT, or Cursor via MCP.

Highlights:

- **Agent-first planning** — paste a group chat or describe your trip, and the agent builds the whole itinerary (stops, routes, timing) onto the map.
- **Confirm before acting** — the agent proposes changes and shows what it will do before touching your plan. Catch hallucinated places or wrong dates before they land in your itinerary, not after you land in the wrong city.
- **A path for every traveler** — each person gets their own route through the trip; splits and merges are first-class, so a group can hike, drive, and meet for dinner without losing track of who's where.
- **Smart timing that respects reservations** — anchor the fixed points (the 4 PM gondola, the 06:40 flight); the planner propagates everything around them, handles time zones across cities, and flags overnight drives or missed connections — without nagging you about a 6-minute buffer.
- **What-if with plan versions** — clone the active plan, try a different route, promote it if the group agrees, throw it away if not. The active plan never gets trampled while you explore alternatives.
- **One home for every stop** — notes, to-dos, and saved places pinned directly to each stop, so bookings and ideas don't end up scattered across email, chat screenshots, and half a dozen Notes apps.
- **Bring the whole crew** — invite links with admin / planner / viewer roles, live participant pulse on the map, and notifications when the plan changes — so the "designated planner" isn't the only one who knows what's happening.
- **Map and timeline in one** — flip between a live Google Map and a zoomable multi-lane timeline, with shared-stop alignment across lanes when paths overlap.
- **Plan from your favorite AI app** — a built-in MCP server lets Claude, ChatGPT, or Cursor read and edit your trips with a personal API key.
- **Works in the mountains** — offline-aware editing, optimistic updates, and optional per-user location sharing.

## Architecture

Monorepo with four sub-projects:

```
frontend/     Next.js 16.2 + React 19.2 + Tailwind 4
backend/      FastAPI + Firestore + Gemini
shared/       Pydantic models, repositories, DAG logic  (pip install -e)
mcpserver/    FastMCP server — MCP protocol access to trip data
```

**Storage**: Firestore (Native mode) for trip data, GCS for agent chat history.
**Auth**: Firebase Auth (frontend) → firebase-admin token verification (backend). MCP server uses HMAC API keys.
**Google Cloud auth**: Application Default Credentials everywhere — no service account JSON files.

## Local Development

### Prerequisites

- Node.js 22+ and pnpm
- Python 3.12+ with conda (`travel-app` env)
- `gcloud` CLI authenticated with ADC (`gcloud auth application-default login`)

### Setup

```bash
# Python (backend, shared, mcpserver)
conda activate travel-app
pip install -e shared/
pip install -r backend/requirements.txt
pip install -r mcpserver/requirements.txt

# Frontend
cd frontend && pnpm install
```

### Environment files

Copy and fill in the example files:

```bash
cp frontend/.env.local.example frontend/.env.local
cp backend/.env.example backend/.env
cp mcpserver/.env.example mcpserver/.env
```

### Running services locally

```bash
# Terminal 1 — backend
conda activate travel-app
cd backend && uvicorn src.main:app --reload --port 8000

# Terminal 2 — frontend
cd frontend && pnpm dev

# MCP server (streamable-http on :8080)
conda activate travel-app
cd mcpserver && uvicorn src.main:app --reload --port 8080
```

### Running tests

```bash
# Python (backend + shared)
conda activate travel-app
PYTHONPATH=. pytest backend/tests shared/tests

# Frontend
cd frontend && pnpm test
```

## Deployment

Three Cloud Run services in `europe-west1`, GCP project `as-dev-anze` (frontend, backend, MCP server).

### Deploy script

```bash
./deploy/deploy.sh setup       # One-time: create Artifact Registry repo
./deploy/deploy.sh all         # Build and deploy all three services
./deploy/deploy.sh frontend    # Deploy only frontend
./deploy/deploy.sh backend     # Deploy only backend
./deploy/deploy.sh mcpserver   # Deploy only MCP server
```

Images are tagged by git SHA and pushed to Artifact Registry. The frontend build bakes `NEXT_PUBLIC_*` variables into the JS bundle at build time via Cloud Build substitutions.

### Deploy directory

```
deploy/
  deploy.sh                  Main orchestration script
  Dockerfile.frontend        Multi-stage Next.js standalone build
  Dockerfile.backend         FastAPI + shared package
  Dockerfile.mcpserver       FastMCP + shared package
  cloudbuild-frontend.yaml   Cloud Build config (handles NEXT_PUBLIC_* build args)
  cloudbuild-backend.yaml    Cloud Build config for backend
  cloudbuild-mcpserver.yaml  Cloud Build config for MCP server
```

## Project Reference

See [AGENTS.md](AGENTS.md) for the full architecture reference: models, repositories, services, API endpoints, frontend components, and key patterns.