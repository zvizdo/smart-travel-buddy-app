# Smart Travel Buddy

**Your next trip, in every AI app you already use.** A collaborative, AI-first trip planner for your phone — chat your itinerary into existence, give every traveler their own path, and keep planning from Claude, ChatGPT, or Cursor via MCP.

Highlights:

- **Agent-first planning** — paste a group chat or describe your trip, and the agent builds the whole itinerary (stops, routes, timing) onto the map.
- **A path for every traveler** — each person gets their own route through the trip; splits and merges are first-class, so the group can hike, drive, and meet for dinner without losing track of who's where.
- **Map and timeline in one** — flip between a live Google Map and a zoomable multi-lane timeline, with time zones handled for you.
- **Plan from your favorite AI app** — a built-in MCP server lets Claude, ChatGPT, or Cursor read and edit your trips with a personal API key.
- **Real-time crew** — invite links, live participant pulse on the map, and notifications when the plan changes.
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

## Deployment

Three Cloud Run services in `europe-west1`, GCP project `as-dev-anze`.

| Service | URL |
|---|---|
| Frontend | `https://smart-travel-buddy-px6atnevbq-ew.a.run.app` |
| Backend | `https://smart-travel-buddy-backend-px6atnevbq-ew.a.run.app` |
| MCP Server | `https://smart-travel-buddy-mcpserver-px6atnevbq-ew.a.run.app` |

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