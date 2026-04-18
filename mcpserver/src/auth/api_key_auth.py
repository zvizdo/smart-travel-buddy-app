"""API key authentication for MCP server.

Validates API keys by computing HMAC-SHA256 and looking up the hash
across all users' api_keys subcollections via a collection group query.
Each request carries its own Authorization: Bearer <key> header, resolved
per-request via ApiKeyTokenVerifier.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import logging
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token
from google.cloud.firestore import AsyncClient
from google.cloud.firestore_v1.base_query import FieldFilter

if TYPE_CHECKING:
    from fastmcp import Context

logger = logging.getLogger(__name__)

# In-memory cache: hash -> (user_id, expiry_timestamp)
_cache: dict[str, tuple[str, float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes
_CACHE_MAX_ENTRIES = 1000

# Rate limiting: track failed auth attempts keyed on the full HMAC hash so
# two distinct API keys never share a rate-limit bucket. The threat model
# is HMAC-SHA256 output brute-force — infeasible over a 2^256 space — so
# per-hash bucketing is sufficient; no global or IP-based dimension needed.
_fail_tracker: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW = 60  # seconds
_RATE_LIMIT_MAX_FAILURES = 10
_FAIL_TRACKER_MAX_ENTRIES = 1000


def _record_failure(key_hash: str, now: float) -> None:
    """Append a failure timestamp for ``key_hash``, bounding tracker size.

    An attacker sending N distinct bogus bearer tokens would otherwise grow
    ``_fail_tracker`` by N entries (each ~200B), so ~10M requests ≈ 2GB →
    Cloud Run OOM. Mirror ``_cache``'s size-check-then-evict pattern: drop
    entries whose newest timestamp is already outside the rate-limit window
    (can never trigger rate-limit again), and if still at capacity, evict
    the entry with the oldest most-recent timestamp (closest to aging out).
    """
    if key_hash not in _fail_tracker and len(_fail_tracker) >= _FAIL_TRACKER_MAX_ENTRIES:
        cutoff = now - _RATE_LIMIT_WINDOW
        stale = [k for k, ts in _fail_tracker.items() if not ts or max(ts) < cutoff]
        for k in stale:
            del _fail_tracker[k]
        if len(_fail_tracker) >= _FAIL_TRACKER_MAX_ENTRIES:
            oldest = min(_fail_tracker, key=lambda k: max(_fail_tracker[k]))
            del _fail_tracker[oldest]
    _fail_tracker.setdefault(key_hash, []).append(now)


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

    # Rate limit check: reject if too many recent failures for this exact
    # key hash. Keying on the full HMAC hash rather than a prefix eliminates
    # any chance of two distinct keys sharing a rate-limit bucket.
    now = time.monotonic()
    if key_hash in _fail_tracker:
        _fail_tracker[key_hash] = [
            t for t in _fail_tracker[key_hash] if now - t < _RATE_LIMIT_WINDOW
        ]
        if not _fail_tracker[key_hash]:
            del _fail_tracker[key_hash]
        elif len(_fail_tracker[key_hash]) >= _RATE_LIMIT_MAX_FAILURES:
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
        _record_failure(key_hash, now)
        raise PermissionError("Invalid or revoked API key")

    # Extract user_id from document path: "users/{userId}/api_keys/{keyId}"
    path_parts = matched_doc.reference.path.split("/")
    user_id = path_parts[1]

    # Clear failure tracker on successful auth
    _fail_tracker.pop(key_hash, None)

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

    # Do not log the user_id at info level — anything the server process
    # can write to shared logs is a potential user-enumeration vector for
    # other operators. Demote to debug so it's there during development
    # but silent in production (which runs at INFO).
    logger.debug("API key authenticated")
    return user_id


class ApiKeyTokenVerifier(TokenVerifier):
    """TokenVerifier implementation for FastMCP bearer auth.

    Resolves API keys to user IDs via HMAC-SHA256 + Firestore lookup.
    Extends fastmcp's TokenVerifier which installs BearerAuthBackend +
    AuthContextMiddleware but mounts zero OAuth discovery endpoints, so
    clients with a static Bearer header in .mcp.json use it directly.
    """

    def __init__(self, db: AsyncClient, hmac_secret: str) -> None:
        super().__init__(base_url=None, required_scopes=[])
        self._db = db
        self._hmac_secret = hmac_secret

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            user_id = await resolve_user_from_api_key(
                self._db, token, self._hmac_secret
            )
        except PermissionError:
            return None
        return AccessToken(token=token, client_id=user_id, scopes=[])


def get_user_id(ctx: Context) -> str:
    """Extract the authenticated user_id for the current request.

    Reads from the bearer auth ContextVar set by AuthContextMiddleware, which
    ApiKeyTokenVerifier populates via its verify_token() return value.
    """
    del ctx  # unused — kept for call-site compatibility across tool handlers
    access_token = get_access_token()
    if access_token and access_token.client_id:
        return access_token.client_id

    raise PermissionError("No authenticated user in request context")
