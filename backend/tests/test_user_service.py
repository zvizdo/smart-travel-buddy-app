"""Tests for UserService."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from backend.src.services.user_service import UserService


class TestUserService:
    def _make_service(self):
        user_repo = MagicMock()
        return UserService(user_repo)

    @pytest.mark.asyncio
    async def test_ensure_user_creates_profile(self):
        svc = self._make_service()
        svc._user_repo.create_or_update = AsyncMock(
            return_value={"id": "uid1", "display_name": "Test User", "email": "test@example.com"}
        )

        result = await svc.ensure_user("uid1", "Test User", "test@example.com")

        assert result["id"] == "uid1"
        assert result["display_name"] == "Test User"
        svc._user_repo.create_or_update.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_ensure_user_defaults_name_to_uid(self):
        svc = self._make_service()
        svc._user_repo.create_or_update = AsyncMock(return_value={"id": "uid1"})

        await svc.ensure_user("uid1")

        call_args = svc._user_repo.create_or_update.call_args[0][0]
        assert call_args.display_name == "uid1"
        assert call_args.email == ""

    @pytest.mark.asyncio
    async def test_get_user_delegates_to_repo(self):
        svc = self._make_service()
        svc._user_repo.get_user = AsyncMock(return_value=None)

        result = await svc.get_user("uid1")

        assert result is None
        svc._user_repo.get_user.assert_awaited_once_with("uid1")
