# Smart Travel Buddy

A collaborative trip planning app with an AI agent, real-time map, and MCP server for external AI agent access.

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

# MCP server (stdio mode for Claude Desktop)
conda activate travel-app
MCP_API_KEY=<your-key> python -m mcpserver.src.main
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
