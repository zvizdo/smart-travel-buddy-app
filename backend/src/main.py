import os
from contextlib import asynccontextmanager
from pathlib import Path

import firebase_admin
import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")
from backend.src.api import agent, edges, invites, nodes, notifications, paths, plans, pulse, trips, users
from backend.src.services.route_service import RouteService
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.cloud.firestore import AsyncClient
from google.cloud.storage import Client as GCSClient


@asynccontextmanager
async def lifespan(app: FastAPI):
    firebase_admin.initialize_app()
    app.state.firestore = AsyncClient()
    app.state.gcs = GCSClient()
    http_client = httpx.AsyncClient(limits=httpx.Limits(max_connections=20))
    app.state.http_client = http_client
    app.state.route_service = RouteService(http_client)
    yield
    app.state.firestore.close()
    await http_client.aclose()


app = FastAPI(
    title="Smart Travel Buddy API",
    version="0.1.0",
    lifespan=lifespan,
)

cors_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "VALIDATION_ERROR", "message": str(exc)}},
    )


@app.exception_handler(PermissionError)
async def permission_error_handler(request: Request, exc: PermissionError):
    return JSONResponse(
        status_code=403,
        content={"error": {"code": "FORBIDDEN", "message": str(exc)}},
    )


@app.exception_handler(LookupError)
async def not_found_handler(request: Request, exc: LookupError):
    return JSONResponse(
        status_code=404,
        content={"error": {"code": "NOT_FOUND", "message": str(exc)}},
    )


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    import traceback

    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL_ERROR", "message": str(exc)}},
    )


app.include_router(trips.router, prefix="/api/v1")
app.include_router(agent.router, prefix="/api/v1")
app.include_router(nodes.router, prefix="/api/v1")
app.include_router(edges.router, prefix="/api/v1")
app.include_router(invites.router, prefix="/api/v1")
app.include_router(paths.router, prefix="/api/v1")
app.include_router(notifications.router, prefix="/api/v1")
app.include_router(plans.router, prefix="/api/v1")
app.include_router(pulse.router, prefix="/api/v1")
app.include_router(users.router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok"}
