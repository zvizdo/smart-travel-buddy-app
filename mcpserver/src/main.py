"""Smart Travel Buddy MCP Server entry point.

Exposes trip management tools to external AI agents via the Model Context Protocol.

Multi-user deployment: each request carries an Authorization: Bearer <key> header.
The API key is resolved per-request to a user ID via HMAC-SHA256 + Firestore lookup.

Local stdio mode: falls back to MCP_API_KEY env var (resolved once at startup).
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import firebase_admin
from google.cloud.firestore import AsyncClient
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from pydantic import AnyHttpUrl

from mcpserver.src.auth.api_key_auth import ApiKeyTokenVerifier, resolve_user_from_api_key
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class AppContext:
    """Application context available to all MCP tools via lifespan."""

    db: AsyncClient
    trip_service: TripService
    places_service: PlacesService
    config: dict
    stdio_user_id: str | None = field(default=None)


# --- Lazy TokenVerifier ---------------------------------------------------
# FastMCP must be instantiated at module level (so @mcp.tool() decorators work),
# but the real ApiKeyTokenVerifier needs a Firestore db created in the lifespan.
# This wrapper delegates to the real verifier once set.

_verifier: ApiKeyTokenVerifier | None = None


class _LazyTokenVerifier:
    """Delegates to the real ApiKeyTokenVerifier once the lifespan has set it."""

    async def verify_token(self, token: str) -> AccessToken | None:
        if _verifier is None:
            return None
        return await _verifier.verify_token(token)


# --- Lifespan --------------------------------------------------------------


@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[AppContext]:
    """Initialize Firebase, Firestore, and build services."""
    global _verifier
    config = get_config()

    # Initialize Firebase Admin (idempotent)
    if not firebase_admin._apps:
        firebase_admin.initialize_app()

    db = AsyncClient()

    # Set the real verifier now that db is available
    _verifier = ApiKeyTokenVerifier(db, config["api_key_hmac_secret"])

    # Resolve user for stdio mode only (local dev)
    stdio_user_id = None
    if config["mcp_transport"] == "stdio":
        api_key = os.environ.get("MCP_API_KEY", "")
        if api_key:
            stdio_user_id = await resolve_user_from_api_key(
                db, api_key, config["api_key_hmac_secret"]
            )
            logger.info("stdio mode: authenticated as user %s", stdio_user_id)
        else:
            logger.warning(
                "stdio mode: MCP_API_KEY not set — tool calls will fail auth"
            )

    # Build repositories
    trip_repo = TripRepository(db)
    plan_repo = PlanRepository(db)
    node_repo = NodeRepository(db)
    edge_repo = EdgeRepository(db)
    action_repo = ActionRepository(db)
    location_repo = LocationRepository(db)
    user_repo = UserRepository(db)

    # Build services
    trip_service = TripService(
        trip_repo, plan_repo, node_repo, edge_repo,
        action_repo, location_repo, user_repo,
    )
    places_service = PlacesService(config["google_maps_api_key"])

    try:
        yield AppContext(
            db=db,
            trip_service=trip_service,
            places_service=places_service,
            config=config,
            stdio_user_id=stdio_user_id,
        )
    finally:
        _verifier = None
        await places_service.close()
        db.close()


# --- FastMCP instance ------------------------------------------------------

_config = get_config()
_server_url = _config["mcp_server_url"]
_lazy_verifier = _LazyTokenVerifier()

mcp = FastMCP(
    "smart-travel-buddy",
    lifespan=app_lifespan,
    token_verifier=_lazy_verifier,
    auth=AuthSettings(
        issuer_url=AnyHttpUrl(_server_url),
        resource_server_url=AnyHttpUrl(_server_url),
    ),
)

# Import tools to register them with the server
import mcpserver.src.tools.actions  # noqa: E402
import mcpserver.src.tools.modify  # noqa: E402
import mcpserver.src.tools.places  # noqa: E402
import mcpserver.src.tools.trips  # noqa: F401, E402


def main():
    import uvicorn

    config = get_config()
    transport = config["mcp_transport"]

    if transport == "sse":
        uvicorn.run(mcp.sse_app(), host=config["mcp_host"], port=config["mcp_port"])
    elif transport == "streamable-http":
        uvicorn.run(
            mcp.streamable_http_app(),
            host=config["mcp_host"],
            port=config["mcp_port"],
        )
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
