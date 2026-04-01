"""Tests for concurrent edit conflict detection in DAGService."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from shared.services.dag_service import DAGService

from shared.models import Node, Participant, Trip, TripRole


def _make_service():
    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()
    return DAGService(trip_repo, plan_repo, node_repo, edge_repo)


def _make_node(
    node_id: str = "n1",
    updated_at: str = "2026-06-01T10:00:00+00:00",
) -> Node:
    return Node(
        id=node_id,
        name="Test Node",
        type="city",
        lat_lng={"lat": 0, "lng": 0},
        arrival_time=datetime(2026, 6, 1, 10, 0, tzinfo=UTC),
        departure_time=datetime(2026, 6, 2, 10, 0, tzinfo=UTC),
        participant_ids=None,
        order_index=0,
        place_id=None,
        created_by="user_1",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=updated_at,
    )


class TestConflictDetection:
    @pytest.mark.asyncio
    async def test_no_conflict_when_timestamps_match(self):
        svc = _make_service()
        node = _make_node()
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=node)
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[node.model_dump(mode="json")])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.update_node_with_cascade_preview(
            "trip1", "plan1", "n1",
            {"name": "Updated"},
            client_updated_at="2026-06-01T10:00:00+00:00",
        )
        assert result["conflict"] is False

    @pytest.mark.asyncio
    async def test_conflict_when_timestamps_differ(self):
        svc = _make_service()
        node = _make_node(updated_at="2026-06-01T12:00:00+00:00")
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=node)
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[node.model_dump(mode="json")])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.update_node_with_cascade_preview(
            "trip1", "plan1", "n1",
            {"name": "Updated"},
            client_updated_at="2026-06-01T10:00:00+00:00",
        )
        assert result["conflict"] is True

    @pytest.mark.asyncio
    async def test_conflict_sends_notification(self):
        svc = _make_service()
        node = _make_node(updated_at="2026-06-01T12:00:00+00:00")
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=node)
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[node.model_dump(mode="json")])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        trip = Trip(
            id="trip1",
            name="Test Trip",
            created_by="user_1",
            participants={
                "user_1": Participant(role=TripRole.ADMIN, joined_at=datetime.now(UTC)),
                "user_2": Participant(role=TripRole.PLANNER, joined_at=datetime.now(UTC)),
            },
        )
        svc._trip_repo.get_trip_or_raise = AsyncMock(return_value=trip)

        mock_notification_service = MagicMock()
        mock_notification_service.create_notification = AsyncMock(return_value={})

        result = await svc.update_node_with_cascade_preview(
            "trip1", "plan1", "n1",
            {"name": "Updated"},
            client_updated_at="2026-06-01T10:00:00+00:00",
            edited_by="user_1",
            notification_service=mock_notification_service,
        )

        assert result["conflict"] is True
        mock_notification_service.create_notification.assert_awaited_once()
        call_kwargs = mock_notification_service.create_notification.call_args[1]
        assert call_kwargs["target_user_ids"] == ["user_2"]

    @pytest.mark.asyncio
    async def test_no_conflict_when_client_updated_at_not_provided(self):
        svc = _make_service()
        node = _make_node()
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=node)
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[node.model_dump(mode="json")])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.update_node_with_cascade_preview(
            "trip1", "plan1", "n1",
            {"name": "Updated"},
        )
        assert result["conflict"] is False
