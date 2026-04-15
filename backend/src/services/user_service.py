"""User service: create/update user profile on first sign-in, API key management."""

import hashlib
import hmac
import os
import secrets
import uuid
from base64 import urlsafe_b64encode
from datetime import UTC, datetime

from shared.models import ApiKey, User
from shared.repositories.user_repository import UserRepository


class UserService:
    def __init__(self, user_repo: UserRepository):
        self._user_repo = user_repo

    async def ensure_user(
        self,
        uid: str,
        display_name: str = "",
        email: str = "",
    ) -> dict:
        """Create or update a user profile from Firebase token claims.

        Called on first sign-in or when token claims change.
        Uses merge=True so existing fields aren't overwritten.
        """
        user = User(
            id=uid,
            display_name=display_name or uid,
            email=email or "",
            created_at=datetime.now(UTC),
        )
        return await self._user_repo.create_or_update(user)

    async def update_user(
        self,
        uid: str,
        display_name: str | None = None,
        location_tracking_enabled: bool | None = None,
        analytics_enabled: bool | None = None,
    ) -> dict:
        """Update user profile fields."""
        updates: dict = {}
        if display_name is not None:
            updates["display_name"] = display_name
        if location_tracking_enabled is not None:
            updates["location_tracking_enabled"] = location_tracking_enabled
        if analytics_enabled is not None:
            updates["analytics_enabled"] = analytics_enabled
        if not updates:
            user = await self._user_repo.get_user_or_raise(uid)
            return user.model_dump(mode="json")
        await self._user_repo.update(uid, updates)
        user = await self._user_repo.get_user_or_raise(uid)
        return user.model_dump(mode="json")

    async def get_user(self, uid: str) -> User | None:
        return await self._user_repo.get_user(uid)

    async def create_api_key(self, uid: str, name: str) -> dict:
        """Generate a new API key for the user.

        Returns the full key exactly once — only the hash is stored.
        """
        raw_bytes = secrets.token_bytes(32)
        raw_key = "stb_" + urlsafe_b64encode(raw_bytes).rstrip(b"=").decode()

        hmac_secret = os.environ["API_KEY_HMAC_SECRET"]
        key_hash = hmac.new(
            hmac_secret.encode(), raw_key.encode(), hashlib.sha256
        ).hexdigest()

        api_key = ApiKey(
            id=str(uuid.uuid4()),
            name=name,
            key_hash=key_hash,
            key_prefix=raw_key[:12],
        )
        stored = await self._user_repo.create_api_key(uid, api_key)

        return {
            "id": stored["id"],
            "name": stored["name"],
            "key_prefix": stored["key_prefix"],
            "key": raw_key,
            "created_at": stored["created_at"],
        }

    async def list_api_keys(self, uid: str) -> list[dict]:
        """List API keys for a user, stripping sensitive fields."""
        keys = await self._user_repo.list_api_keys(uid)
        return [
            {
                "id": k["id"],
                "name": k["name"],
                "key_prefix": k["key_prefix"],
                "is_active": k["is_active"],
                "created_at": k["created_at"],
                "last_used_at": k.get("last_used_at"),
            }
            for k in keys
        ]

    async def revoke_api_key(self, uid: str, key_id: str) -> None:
        """Deactivate an API key."""
        await self._user_repo.deactivate_api_key(uid, key_id)

    async def get_users_batch(self, uids: list[str]) -> dict[str, dict]:
        """Get display names for a batch of user IDs. Parallel fetch."""
        found = await self._user_repo.get_users_by_ids(uids)
        result: dict[str, dict] = {}
        for uid in uids:
            user = found.get(uid)
            if user:
                result[uid] = {
                    "display_name": user.display_name,
                    "email": user.email,
                    "location_tracking_enabled": user.location_tracking_enabled,
                }
            else:
                result[uid] = {
                    "display_name": uid,
                    "email": "",
                    "location_tracking_enabled": False,
                }
        return result
