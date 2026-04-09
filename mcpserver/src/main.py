"""Smart Travel Buddy MCP Server entry point.

Exposes trip management tools to external AI agents via the Model Context Protocol.
Transport is streamable-http only — each request carries an
Authorization: Bearer <key> header that is resolved per-request to a user ID
via HMAC-SHA256 + Firestore lookup.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import firebase_admin
from google.cloud.firestore import AsyncClient
from fastmcp import FastMCP
from fastmcp.server.providers.skills import SkillProvider

import httpx
from mcpserver.src.auth.api_key_auth import ApiKeyTokenVerifier
from mcpserver.src.config import get_config
from mcpserver.src.services.places_service import PlacesService
from mcpserver.src.services.trip_service import TripService
from shared.repositories import (
    ActionRepository,
    EdgeRepository,
    LocationRepository,
    NodeRepository,
    PlanRepository,
    TripRepository,
    UserRepository,
)
from shared.services.dag_service import DAGService
from shared.services.flight_service import FlightService
from shared.services.plan_service import PlanService
from shared.services.route_service import RouteService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class AppContext:
    """Application context available to all MCP tools via lifespan."""

    db: AsyncClient
    trip_service: TripService
    dag_service: DAGService
    plan_service: PlanService
    places_service: PlacesService
    flight_service: FlightService
    config: dict
    http_client: httpx.AsyncClient | None = field(default=None)


# --- Eager Firebase + config initialization -----------------------------------

if not firebase_admin._apps:
    firebase_admin.initialize_app()

_db = AsyncClient()
_config = get_config()

# ApiKeyTokenVerifier extends fastmcp's TokenVerifier which installs
# BearerAuthBackend + AuthContextMiddleware but mounts zero OAuth discovery
# routes (get_routes() returns []). Clients with a static Bearer header in
# .mcp.json use it directly — no OAuth dance, no "Authenticate" click.
_token_verifier = ApiKeyTokenVerifier(_db, _config["api_key_hmac_secret"])


# --- Lifespan --------------------------------------------------------------


@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[AppContext]:
    """Build services for MCP tools. Firebase/Firestore already initialized."""
    config = get_config()

    # Build repositories
    trip_repo = TripRepository(_db)
    plan_repo = PlanRepository(_db)
    node_repo = NodeRepository(_db)
    edge_repo = EdgeRepository(_db)
    action_repo = ActionRepository(_db)
    location_repo = LocationRepository(_db)
    user_repo = UserRepository(_db)

    # Build services
    trip_service = TripService(
        trip_repo, plan_repo, node_repo, edge_repo,
        action_repo, location_repo, user_repo,
    )
    http_client = httpx.AsyncClient(limits=httpx.Limits(max_connections=20))
    route_service = RouteService(http_client)
    dag_service = DAGService(
        trip_repo, plan_repo, node_repo, edge_repo,
        route_service=route_service,
        action_repo=action_repo,
    )
    # PlanService is shared with the backend. notification_service is None here
    # so promote_plan skips the in-app notification step — MCP callers don't
    # use the notification subsystem.
    plan_service = PlanService(
        trip_repo,
        plan_repo,
        node_repo,
        edge_repo,
        notification_service=None,
        action_repo=action_repo,
    )
    places_service = PlacesService(config["google_maps_api_key"])
    flight_service = FlightService()

    try:
        yield AppContext(
            db=_db,
            trip_service=trip_service,
            dag_service=dag_service,
            plan_service=plan_service,
            places_service=places_service,
            flight_service=flight_service,
            config=config,
            http_client=http_client,
        )
    finally:
        await places_service.close()
        await http_client.aclose()


# --- FastMCP instance ------------------------------------------------------

mcp = FastMCP(
    "smart-travel-buddy",
    lifespan=app_lifespan,
    auth=_token_verifier,
)

# Import tools to register them with the server
import mcpserver.src.tools.actions  # noqa: E402, F401
import mcpserver.src.tools.nodes  # noqa: E402, F401
import mcpserver.src.tools.edges  # noqa: E402, F401
import mcpserver.src.tools.flights  # noqa: E402, F401
import mcpserver.src.tools.places  # noqa: E402, F401
import mcpserver.src.tools.plans  # noqa: E402, F401
import mcpserver.src.tools.trips  # noqa: E402, F401


# Streamable-HTTP ASGI app. fastmcp's http_app() includes:
#   - Session manager lifespan (task group init)
#   - BearerAuthBackend + AuthContextMiddleware (from TokenVerifier.get_middleware)
# No /.well-known/oauth-* routes are mounted (TokenVerifier.get_routes() returns []).
# Exposed as a module-level ASGI app so uvicorn can load it as
# `mcpserver.src.main:app` -- mirrors the backend's entry point shape.
app = mcp.http_app(path="/mcp")
mcp.add_provider(SkillProvider(Path(__file__).resolve().parent.parent.parent / "skill" / "smart-travel-buddy"))

