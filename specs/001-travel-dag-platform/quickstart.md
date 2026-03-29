# Quickstart: Travel DAG Platform

**Branch**: `001-travel-dag-platform` | **Date**: 2026-03-26

## Prerequisites

- Node.js 20.9+ (for Next.js 16)
- Python 3.12+ (via conda)
- conda (Miniconda or Anaconda)
- pnpm (frontend package manager)
- Google Cloud CLI (`gcloud`) -- for Application Default Credentials
- Google Cloud project with:
  - Firestore database (Native mode)
  - Firebase Auth (Google, Apple, Yahoo providers enabled)
  - Google Maps API key (Maps SDK, Places API, Geocoding API)
  - Gemini API enabled (for Gemini 3 Flash via Vertex AI)

## Google Application Default Credentials (ADC)

All Python services use ADC -- no service account JSON files needed for local dev.

```bash
gcloud auth application-default login
gcloud config set project your-project-id
```

This authenticates Firestore, Firebase Admin, and Gemini (via Vertex AI) automatically.

## Environment Variables

### Frontend (`frontend/.env.local`)

```env
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
```

### Backend (`backend/.env`)

```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_MAPS_API_KEY=...
CORS_ORIGINS=http://localhost:3000
```

### MCP Server (`mcpserver/.env`)

```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_MAPS_API_KEY=...
```

**Note**: No `GOOGLE_APPLICATION_CREDENTIALS` or `GEMINI_API_KEY` needed -- ADC handles auth for all Google services.

## Setup & Run

### 0. Python Environment (one-time)

```bash
conda create -n travel-app python=3.12 -y
conda activate travel-app
pip install -e shared/                          # Shared parsing library (editable)
pip install -r backend/requirements.txt         # Backend deps
pip install -r mcpserver/requirements.txt       # MCP server deps
```

All Python services share the single `travel-app` conda environment.

### 1. Frontend

```bash
cd frontend
pnpm install
pnpm dev
# Runs on http://localhost:3000
```

### 2. Backend

```bash
conda activate travel-app
cd backend
uvicorn src.main:app --reload --port 8000
# Runs on http://localhost:8000
```

### 3. MCP Server

```bash
conda activate travel-app
cd mcpserver
python src/main.py
# Runs as MCP server (stdio or SSE depending on config)
```

## Running Tests

```bash
conda activate travel-app

# Frontend
cd frontend && pnpm test

# Backend
cd backend && pytest

# Shared library
cd shared && pytest

# MCP Server
cd mcpserver && pytest
```

## Development Workflow

1. **Frontend changes**: Next.js dev server hot-reloads automatically (Turbopack)
2. **Backend changes**: uvicorn `--reload` watches for file changes
3. **Shared library changes**: Since installed with `-e` (editable), changes are picked up immediately by both backend and MCP server
4. **Firestore**: Use Firebase Emulator Suite for local development (`firebase emulators:start`)
5. **Python env**: Always `conda activate travel-app` before running any Python service

## Key URLs (Local Development)

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:8000 |
| API Docs (Swagger) | http://localhost:8000/docs |
| Firebase Emulator UI | http://localhost:4000 |
