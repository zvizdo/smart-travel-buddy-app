"""API key authentication for MCP server.

Validates API keys by computing HMAC-SHA256 and looking up the hash
across all users' api_keys subcollections via a collection group query.
"""

import contextlib
import hashlib
import hmac
import logging
import time
from datetime import UTC, datetime

from google.cloud.firestore import AsyncClient
from google.cloud.firestore_v1.base_query import FieldFilter

logger = logging.getLogger(__name__)

# In-memory cache: hash -> (user_id, expiry_timestamp)
_cache: dict[str, tuple[str, float]] = {}
_CACHE_TTL_SECONDS = 300  # 5 minutes


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

    # Cache the result
    _cache[key_hash] = (user_id, now + _CACHE_TTL_SECONDS)

    logger.info("API key authenticated for user %s", user_id)
    return user_id
