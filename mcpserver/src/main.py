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
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

import httpx
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from mcpserver.src.auth.api_key_auth import resolve_user_from_api_key
from mcpserver.src.auth.oauth_provider import InMemoryOAuthProvider
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
    config: dict
    http_client: httpx.AsyncClient | None = field(default=None)
    stdio_user_id: str | None = field(default=None)


# --- Eager Firebase + config initialization -----------------------------------

if not firebase_admin._apps:
    firebase_admin.initialize_app()

_db = AsyncClient()
_config = get_config()

# Build auth components for HTTP transports (streamable-http / sse).
# Using auth_server_provider (not token_verifier) so FastMCP serves ALL
# OAuth discovery + auth endpoints that Claude Code's SDK expects:
#   - /.well-known/oauth-protected-resource
#   - /.well-known/oauth-authorization-server
#   - /register, /authorize, /token
# The InMemoryOAuthProvider.load_access_token validates Bearer API keys
# via HMAC+Firestore, so the actual OAuth flow is never needed — the
# API key from .mcp.json headers works on every request.
_is_http_transport = _config["mcp_transport"] in ("streamable-http", "sse")
_oauth_provider = (
    InMemoryOAuthProvider(_db, _config["api_key_hmac_secret"])
    if _is_http_transport
    else None
)
_auth_settings = (
    AuthSettings(
        issuer_url=_config["mcp_server_url"],
        resource_server_url=_config["mcp_server_url"],
        required_scopes=[],
        client_registration_options=ClientRegistrationOptions(enabled=True),
    )
    if _is_http_transport
    else None
)


# --- Lifespan --------------------------------------------------------------


@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[AppContext]:
    """Build services for MCP tools. Firebase/Firestore already initialized."""
    config = get_config()

    # Resolve user for stdio mode only (local dev)
    stdio_user_id = None
    if config["mcp_transport"] == "stdio":
        api_key = os.environ.get("MCP_API_KEY", "")
        if api_key:
            stdio_user_id = await resolve_user_from_api_key(
                _db, api_key, config["api_key_hmac_secret"]
            )
            logger.info("stdio mode: authenticated as user %s", stdio_user_id)
        else:
            logger.warning(
                "stdio mode: MCP_API_KEY not set — tool calls will fail auth"
            )

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

    try:
        yield AppContext(
            db=_db,
            trip_service=trip_service,
            dag_service=dag_service,
            plan_service=plan_service,
            places_service=places_service,
            config=config,
            http_client=http_client,
            stdio_user_id=stdio_user_id,
        )
    finally:
        await places_service.close()
        await http_client.aclose()


# --- FastMCP instance ------------------------------------------------------

# Disable DNS rebinding protection for non-localhost hosts (e.g. Cloud Run).
_transport_security = (
    None  # FastMCP auto-enables for localhost
    if _config["mcp_host"] in ("127.0.0.1", "localhost", "::1")
    else TransportSecuritySettings(enable_dns_rebinding_protection=False)
)

mcp = FastMCP(
    "smart-travel-buddy",
    lifespan=app_lifespan,
    host=_config["mcp_host"],
    port=_config["mcp_port"],
    transport_security=_transport_security,
    auth=_auth_settings,
    auth_server_provider=_oauth_provider,
)

# Import tools to register them with the server
import mcpserver.src.tools.actions  # noqa: E402, F401
import mcpserver.src.tools.nodes  # noqa: E402, F401
import mcpserver.src.tools.edges  # noqa: E402, F401
import mcpserver.src.tools.places  # noqa: E402, F401
import mcpserver.src.tools.plans  # noqa: E402, F401
import mcpserver.src.tools.trips  # noqa: E402, F401


def main():
    import uvicorn

    config = get_config()
    transport = config["mcp_transport"]

    if transport == "sse":
        # FastMCP's sse_app() includes auth middleware + discovery routes
        # when auth/token_verifier are configured.
        app = mcp.sse_app()
        uvicorn.run(app, host=config["mcp_host"], port=config["mcp_port"])
    elif transport == "streamable-http":
        # FastMCP's streamable_http_app() includes:
        #   - Session manager lifespan (task group init)
        #   - BearerAuthBackend + AuthContextMiddleware
        #   - RequireAuthMiddleware on /mcp endpoint
        #   - /.well-known/oauth-protected-resource metadata
        # No wrapping needed -- this preserves the lifespan chain.
        app = mcp.streamable_http_app()
        uvicorn.run(
            app,
            host=config["mcp_host"],
            port=config["mcp_port"],
        )
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
