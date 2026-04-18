"""Tests for participant management: remove_participant and change_participant_role."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.src.errors import ConflictError
from backend.src.services.trip_service import TripService
from shared.models import Participant, Trip, TripRole


def _make_trip(participants: dict[str, Participant] | None = None) -> Trip:
    if participants is None:
        participants = {
            "admin1": Participant(role=TripRole.ADMIN, display_name="Admin One"),
            "planner1": Participant(role=TripRole.PLANNER, display_name="Planner One"),
            "viewer1": Participant(role=TripRole.VIEWER, display_name="Viewer One"),
        }
    return Trip(
        id="trip1",
        name="Test Trip",
        created_by="admin1",
        participants=participants,
    )


def _make_service(trip: Trip | None = None) -> TripService:
    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()
    action_repo = MagicMock()
    notification_repo = MagicMock()
    location_repo = MagicMock()
    invite_link_repo = MagicMock()
    preference_repo = MagicMock()

    svc = TripService(
        trip_repo, plan_repo, node_repo, edge_repo, action_repo,
        notification_repo, location_repo, invite_link_repo, preference_repo,
    )

    if trip:
        trip_repo.get_trip_or_raise = AsyncMock(return_value=trip)

    trip_repo.update_trip = AsyncMock()
    trip_repo._db = MagicMock()

    # Mock batch
    mock_batch = MagicMock()
    mock_batch.update = MagicMock()
    mock_batch.commit = AsyncMock()
    trip_repo._db.batch = MagicMock(return_value=mock_batch)

    plan_repo.list_all = AsyncMock(return_value=[])
    node_repo.list_by_plan = AsyncMock(return_value=[])
    node_repo._collection = MagicMock()
    location_repo.delete = AsyncMock()

    return svc


class TestRemoveParticipant:
    @pytest.mark.asyncio
    async def test_admin_removes_other(self):
        trip = _make_trip()
        svc = _make_service(trip)

        result = await svc.remove_participant("trip1", "planner1", "admin1")

        assert result["removed_user_id"] == "planner1"
        assert result["self_removal"] is False
        # Notification-fan-out data the handler used to re-fetch the trip for.
        assert result["target_name"] == "Planner One"
        assert set(result["remaining_participant_ids"]) == {"admin1", "viewer1"}
        svc._trip_repo.update_trip.assert_awaited_once()
        call_args = svc._trip_repo.update_trip.call_args[0]
        assert "participants.planner1" in call_args[1]

    @pytest.mark.asyncio
    async def test_self_removal(self):
        trip = _make_trip({
            "admin1": Participant(role=TripRole.ADMIN, display_name="Admin One"),
            "admin2": Participant(role=TripRole.ADMIN, display_name="Admin Two"),
        })
        svc = _make_service(trip)

        result = await svc.remove_participant("trip1", "admin1", "admin1")

        assert result["self_removal"] is True
        assert result["removed_user_id"] == "admin1"

    @pytest.mark.asyncio
    async def test_non_admin_cannot_remove_others(self):
        trip = _make_trip()
        svc = _make_service(trip)

        with pytest.raises(PermissionError):
            await svc.remove_participant("trip1", "admin1", "planner1")

    @pytest.mark.asyncio
    async def test_non_admin_can_leave(self):
        trip = _make_trip()
        svc = _make_service(trip)

        result = await svc.remove_participant("trip1", "viewer1", "viewer1")

        assert result["self_removal"] is True
        assert result["removed_user_id"] == "viewer1"

    @pytest.mark.asyncio
    async def test_last_admin_blocked(self):
        trip = _make_trip({
            "admin1": Participant(role=TripRole.ADMIN, display_name="Admin One"),
            "planner1": Participant(role=TripRole.PLANNER, display_name="Planner One"),
        })
        svc = _make_service(trip)

        with pytest.raises(ConflictError, match="last admin"):
            await svc.remove_participant("trip1", "admin1", "admin1")

    @pytest.mark.asyncio
    async def test_nonexistent_target(self):
        trip = _make_trip()
        svc = _make_service(trip)

        with pytest.raises(LookupError, match="not a participant"):
            await svc.remove_participant("trip1", "ghost_user", "admin1")

    @pytest.mark.asyncio
    async def test_node_cleanup(self):
        trip = _make_trip()
        svc = _make_service(trip)
        svc._plan_repo.list_all = AsyncMock(return_value=[{"id": "plan1"}])
        svc._node_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "n1", "participant_ids": ["planner1", "viewer1"]},
            {"id": "n2", "participant_ids": ["planner1"]},
            {"id": "n3", "participant_ids": None},
        ])

        mock_doc_ref = MagicMock()
        svc._node_repo._collection = MagicMock(return_value=MagicMock(
            document=MagicMock(return_value=mock_doc_ref)
        ))

        result = await svc.remove_participant("trip1", "planner1", "admin1")

        assert result["nodes_cleaned"] == 2
        batch = svc._trip_repo._db.batch()
        # n1 should keep viewer1, n2 should become None
        calls = batch.update.call_args_list
        assert len(calls) == 2
        assert calls[0][0][1] == {"participant_ids": ["viewer1"]}
        assert calls[1][0][1] == {"participant_ids": None}

    @pytest.mark.asyncio
    async def test_location_cleanup(self):
        trip = _make_trip()
        svc = _make_service(trip)

        await svc.remove_participant("trip1", "planner1", "admin1")

        svc._location_repo.delete.assert_awaited_once_with("planner1", trip_id="trip1")


class TestChangeParticipantRole:
    @pytest.mark.asyncio
    async def test_change_role_success(self):
        trip = _make_trip()
        svc = _make_service(trip)

        result = await svc.change_participant_role("trip1", "planner1", "viewer", "admin1")

        assert result["user_id"] == "planner1"
        assert result["new_role"] == "viewer"
        # Notification-fan-out data the handler used to re-fetch the trip for.
        assert result["target_name"] == "Planner One"
        assert result["actor_name"] == "Admin One"
        assert set(result["all_participant_ids"]) == {"admin1", "planner1", "viewer1"}
        svc._trip_repo.update_trip.assert_awaited_once()
        call_args = svc._trip_repo.update_trip.call_args[0]
        assert call_args[1]["participants.planner1.role"] == "viewer"

    @pytest.mark.asyncio
    async def test_non_admin_cannot_change_role(self):
        trip = _make_trip()
        svc = _make_service(trip)

        with pytest.raises(PermissionError):
            await svc.change_participant_role("trip1", "viewer1", "admin", "planner1")

    @pytest.mark.asyncio
    async def test_cannot_change_own_role(self):
        trip = _make_trip()
        svc = _make_service(trip)

        with pytest.raises(ValueError, match="Cannot change your own role"):
            await svc.change_participant_role("trip1", "admin1", "viewer", "admin1")

    @pytest.mark.asyncio
    async def test_demote_admin_when_multiple_admins(self):
        """Demoting an admin is allowed when another admin remains."""
        trip = _make_trip({
            "admin1": Participant(role=TripRole.ADMIN, display_name="Admin One"),
            "admin2": Participant(role=TripRole.ADMIN, display_name="Admin Two"),
        })
        svc = _make_service(trip)

        result = await svc.change_participant_role("trip1", "admin1", "planner", "admin2")
        assert result["new_role"] == "planner"

    @pytest.mark.asyncio
    async def test_target_not_participant(self):
        trip = _make_trip()
        svc = _make_service(trip)

        with pytest.raises(LookupError, match="not a participant"):
            await svc.change_participant_role("trip1", "ghost_user", "admin", "admin1")

    @pytest.mark.asyncio
    async def test_invalid_role(self):
        trip = _make_trip()
        svc = _make_service(trip)

        with pytest.raises(ValueError):
            await svc.change_participant_role("trip1", "planner1", "superadmin", "admin1")

    @pytest.mark.asyncio
    async def test_same_role_is_idempotent(self):
        trip = _make_trip()
        svc = _make_service(trip)

        result = await svc.change_participant_role("trip1", "planner1", "planner", "admin1")

        assert result["new_role"] == "planner"
        svc._trip_repo.update_trip.assert_awaited_once()


class TestParticipantMutationsAvoidRedundantTripRead:
    """Pin the optimization: handlers used to load the trip purely to derive
    notification fan-out data (display names + participant id list), and the
    service then loaded it again for permission checks. The service now
    returns those derived fields itself so the handler can drop its
    pre-fetch. A regression here would silently re-add a trip-doc read on
    every participant mutation."""

    @pytest.mark.asyncio
    async def test_remove_participant_loads_trip_exactly_once(self):
        trip = _make_trip()
        svc = _make_service(trip)

        await svc.remove_participant("trip1", "planner1", "admin1")
        assert svc._trip_repo.get_trip_or_raise.await_count == 1

    @pytest.mark.asyncio
    async def test_change_role_loads_trip_exactly_once(self):
        trip = _make_trip()
        svc = _make_service(trip)

        await svc.change_participant_role("trip1", "planner1", "viewer", "admin1")
        assert svc._trip_repo.get_trip_or_raise.await_count == 1
