"""API key authentication for MCP server.

Validates API keys by computing HMAC-SHA256 and looking up the hash
across all users' api_keys subcollections via a collection group query.

Multi-user mode (streamable-http): each request carries its own
Authorization: Bearer <key> header, resolved per-request via TokenVerifier.

Single-user mode (stdio): MCP_API_KEY env var resolved once at startup.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import logging
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from google.cloud.firestore import AsyncClient
from google.cloud.firestore_v1.base_query import FieldFilter
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken

if TYPE_CHECKING:
    from mcp.server.fastmcp import Context

logger = logging.getLogger(__name__)

# In-memory cache: hash -> (user_id, expiry_timestamp)
_cache: dict[str, tuple[str, float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes
_CACHE_MAX_ENTRIES = 1000


async def resolve_user_from_api_key(
    db: AsyncClient,
    api_key: str,
    hmac_secret: str,
) -> str:
    """Resolve an API key to a user ID.

    Computes HMAC-SHA256 of the key, looks up the hash in Firestore
    via a collection group query across all users' api_keys subcollections.

    Returns the user ID or raises PermissionError.
    """
    key_hash = hmac.new(
        hmac_secret.encode(), api_key.encode(), hashlib.sha256
    ).hexdigest()

    # Check cache
    now = time.monotonic()
    if key_hash in _cache:
        user_id, expiry = _cache[key_hash]
        if now < expiry:
            return user_id

    # Collection group query across all users' api_keys subcollections
    query = (
        db.collection_group("api_keys")
        .where(filter=FieldFilter("key_hash", "==", key_hash))
        .where(filter=FieldFilter("is_active", "==", True))
        .limit(1)
    )

    matched_doc = None
    async for doc in query.stream():
        matched_doc = doc
        break

    if matched_doc is None:
        raise PermissionError("Invalid or revoked API key")

    # Extract user_id from document path: "users/{userId}/api_keys/{keyId}"
    path_parts = matched_doc.reference.path.split("/")
    user_id = path_parts[1]

    # Update last_used_at (non-critical)
    with contextlib.suppress(Exception):
        await matched_doc.reference.update(
            {"last_used_at": datetime.now(UTC).isoformat()}
        )

    # Cache with eviction if at capacity
    if len(_cache) >= _CACHE_MAX_ENTRIES:
        oldest_key = min(_cache, key=lambda k: _cache[k][1])
        del _cache[oldest_key]
    _cache[key_hash] = (user_id, now + _CACHE_TTL_SECONDS)

    logger.info("API key authenticated for user %s", user_id)
    return user_id


class ApiKeyTokenVerifier:
    """TokenVerifier implementation for FastMCP bearer auth.

    Resolves API keys to user IDs via HMAC-SHA256 + Firestore lookup.
    Used automatically by FastMCP's auth middleware stack.
    """

    def __init__(self, db: AsyncClient, hmac_secret: str) -> None:
        self._db = db
        self._hmac_secret = hmac_secret

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            user_id = await resolve_user_from_api_key(
                self._db, token, self._hmac_secret
            )
            return AccessToken(token=token, client_id=user_id, scopes=[])
        except PermissionError:
            return None


def get_user_id(ctx: Context) -> str:
    """Extract the authenticated user_id for the current request.

    In streamable-http mode: reads from the bearer auth ContextVar set by
    AuthContextMiddleware. In stdio mode: falls back to AppContext.stdio_user_id.
    """
    access_token = get_access_token()
    if access_token and access_token.client_id:
        return access_token.client_id

    # stdio / local dev fallback
    app = ctx.request_context.lifespan_context
    if hasattr(app, "stdio_user_id") and app.stdio_user_id:
        return app.stdio_user_id

    raise PermissionError("No authenticated user in request context")
