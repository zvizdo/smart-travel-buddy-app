"""API key authentication for MCP server.

Validates API keys by computing HMAC-SHA256 and looking up the hash
across all users' api_keys subcollections via a collection group query.

Multi-user mode (streamable-http): each request carries its own
Authorization: Bearer <key> header, resolved per-request via InMemoryOAuthProvider.

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

if TYPE_CHECKING:
    from mcp.server.fastmcp import Context

logger = logging.getLogger(__name__)

# In-memory cache: hash -> (user_id, expiry_timestamp)
_cache: dict[str, tuple[str, float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes
_CACHE_MAX_ENTRIES = 1000

# Rate limiting: track failed auth attempts by key hash prefix
_fail_tracker: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW = 60  # seconds
_RATE_LIMIT_MAX_FAILURES = 10


class RateLimitError(PermissionError):
    """Raised when auth attempts exceed the rate limit."""


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

    # Rate limit check: reject if too many recent failures for this key prefix
    now = time.monotonic()
    hash_prefix = key_hash[:8]
    if hash_prefix in _fail_tracker:
        _fail_tracker[hash_prefix] = [
            t for t in _fail_tracker[hash_prefix] if now - t < _RATE_LIMIT_WINDOW
        ]
        if not _fail_tracker[hash_prefix]:
            del _fail_tracker[hash_prefix]
        elif len(_fail_tracker[hash_prefix]) >= _RATE_LIMIT_MAX_FAILURES:
            raise RateLimitError("Too many failed authentication attempts")

    # Check cache
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
        _fail_tracker.setdefault(hash_prefix, []).append(now)
        raise PermissionError("Invalid or revoked API key")

    # Extract user_id from document path: "users/{userId}/api_keys/{keyId}"
    path_parts = matched_doc.reference.path.split("/")
    user_id = path_parts[1]

    # Clear failure tracker on successful auth
    _fail_tracker.pop(hash_prefix, None)

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
