"""Smart Travel Buddy MCP Server entry point.

Exposes trip management tools to external AI agents via the Model Context Protocol.
Authenticates via user-generated API keys (HMAC-SHA256 verified against Firestore).
"""

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

import firebase_admin
from google.cloud.firestore import AsyncClient
from mcp.server.fastmcp import FastMCP
from mcpserver.src.auth.api_key_auth import resolve_user_from_api_key
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
    user_id: str
    trip_service: TripService
    places_service: PlacesService
    config: dict


@asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[AppContext]:
    """Initialize Firebase, Firestore, authenticate API key, and build services."""
    config = get_config()

    # Initialize Firebase Admin (idempotent)
    if not firebase_admin._apps:
        firebase_admin.initialize_app()

    db = AsyncClient()

    # Resolve API key to user ID
    api_key = os.environ.get("MCP_API_KEY", "")
    if not api_key:
        raise RuntimeError("MCP_API_KEY environment variable is required")

    user_id = await resolve_user_from_api_key(
        db, api_key, config["api_key_hmac_secret"]
    )
    logger.info("Authenticated as user %s", user_id)

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
            user_id=user_id,
            trip_service=trip_service,
            places_service=places_service,
            config=config,
        )
    finally:
        await places_service.close()
        db.close()


mcp = FastMCP("smart-travel-buddy", lifespan=app_lifespan)

# Import tools to register them with the server
import mcpserver.src.tools.actions  # noqa: E402
import mcpserver.src.tools.modify  # noqa: E402
import mcpserver.src.tools.places  # noqa: E402
import mcpserver.src.tools.trips  # noqa: F401, E402


def main():
    config = get_config()
    transport = config["mcp_transport"]

    if transport == "sse":
        mcp.run(
            transport="sse",
            host=config["mcp_host"],
            port=config["mcp_port"],
        )
    elif transport == "streamable-http":
        mcp.run(
            transport="streamable-http",
            host=config["mcp_host"],
            port=config["mcp_port"],
        )
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
