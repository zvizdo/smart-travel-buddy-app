"""User service: create/update user profile on first sign-in."""

from datetime import UTC, datetime

from backend.src.repositories.user_repository import UserRepository

from shared.models import User


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
    ) -> dict:
        """Update user profile fields."""
        updates: dict = {}
        if display_name is not None:
            updates["display_name"] = display_name
        if location_tracking_enabled is not None:
            updates["location_tracking_enabled"] = location_tracking_enabled
        if not updates:
            user = await self._user_repo.get_user_or_raise(uid)
            return user.model_dump(mode="json")
        await self._user_repo.update(uid, updates)
        user = await self._user_repo.get_user_or_raise(uid)
        return user.model_dump(mode="json")

    async def get_user(self, uid: str) -> User | None:
        return await self._user_repo.get_user(uid)

    async def get_users_batch(self, uids: list[str]) -> dict[str, dict]:
        """Get display names for a batch of user IDs."""
        result: dict[str, dict] = {}
        for uid in uids:
            user = await self._user_repo.get_user(uid)
            if user:
                result[uid] = {
                    "display_name": user.display_name,
                    "email": user.email,
                    "location_tracking_enabled": user.location_tracking_enabled,
                }
            else:
                result[uid] = {"display_name": uid, "email": "", "location_tracking_enabled": False}
        return result
