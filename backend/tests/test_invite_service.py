"""Tests for InviteService error handling."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from backend.src.services.invite_service import InviteService

from shared.models import InviteLink, Participant, Trip, TripRole


def _make_service():
    invite_repo = MagicMock()
    trip_repo = MagicMock()
    return InviteService(invite_repo, trip_repo)


class TestClaimInviteErrors:
    @pytest.mark.asyncio
    async def test_not_found_raises_lookup(self):
        svc = _make_service()
        svc._invite_repo.get_invite = AsyncMock(return_value=None)

        with pytest.raises(LookupError, match="not found"):
            await svc.claim_invite("trip1", "bad_token", "user1")

    @pytest.mark.asyncio
    async def test_deactivated_raises_value_error(self):
        svc = _make_service()
        invite = InviteLink(
            id="token1",
            role=TripRole.VIEWER,
            created_by="admin",
            expires_at=datetime.now(UTC) + timedelta(hours=24),
            is_active=False,
        )
        svc._invite_repo.get_invite = AsyncMock(return_value=invite)

        with pytest.raises(ValueError, match="deactivated"):
            await svc.claim_invite("trip1", "token1", "user1")

    @pytest.mark.asyncio
    async def test_expired_raises_value_error(self):
        svc = _make_service()
        invite = InviteLink(
            id="token1",
            role=TripRole.VIEWER,
            created_by="admin",
            expires_at=datetime.now(UTC) - timedelta(hours=1),
            is_active=True,
        )
        svc._invite_repo.get_invite = AsyncMock(return_value=invite)

        with pytest.raises(ValueError, match="expired"):
            await svc.claim_invite("trip1", "token1", "user1")

    @pytest.mark.asyncio
    async def test_already_participant_returns_existing_role(self):
        svc = _make_service()
        invite = InviteLink(
            id="token1",
            role=TripRole.PLANNER,
            created_by="admin",
            expires_at=datetime.now(UTC) + timedelta(hours=24),
            is_active=True,
        )
        trip = Trip(
            id="trip1",
            name="Test Trip",
            created_by="admin",
            participants={
                "admin": Participant(role=TripRole.ADMIN, joined_at=datetime.now(UTC)),
                "user1": Participant(role=TripRole.VIEWER, joined_at=datetime.now(UTC)),
            },
        )
        svc._invite_repo.get_invite = AsyncMock(return_value=invite)
        svc._trip_repo.get_trip_or_raise = AsyncMock(return_value=trip)

        result = await svc.claim_invite("trip1", "token1", "user1")
        assert result["role"] == "viewer"

    @pytest.mark.asyncio
    async def test_successful_claim(self):
        svc = _make_service()
        invite = InviteLink(
            id="token1",
            role=TripRole.PLANNER,
            created_by="admin",
            expires_at=datetime.now(UTC) + timedelta(hours=24),
            is_active=True,
        )
        trip = Trip(
            id="trip1",
            name="Test Trip",
            created_by="admin",
            participants={
                "admin": Participant(role=TripRole.ADMIN, joined_at=datetime.now(UTC)),
            },
        )
        svc._invite_repo.get_invite = AsyncMock(return_value=invite)
        svc._trip_repo.get_trip_or_raise = AsyncMock(return_value=trip)
        svc._trip_repo.update_trip = AsyncMock()

        result = await svc.claim_invite("trip1", "token1", "new_user")
        assert result["role"] == "planner"
        svc._trip_repo.update_trip.assert_awaited_once()
