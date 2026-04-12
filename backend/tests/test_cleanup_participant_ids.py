"""Tests for stale participant_ids cleanup in DAGService."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from shared.services.dag_service import DAGService


def _make_service():
    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()

    # Stub the Firestore batch path so cleanup_stale_participant_ids can
    # call node_repo._db.batch() -> batch.update(...) -> batch.commit().
    batch = MagicMock()
    batch.update = MagicMock()
    batch.commit = AsyncMock()
    node_repo._db = MagicMock()
    node_repo._db.batch = MagicMock(return_value=batch)

    collection = MagicMock()
    collection.document = MagicMock(return_value=MagicMock())
    node_repo._collection = MagicMock(return_value=collection)
    edge_repo._collection = MagicMock(return_value=collection)

    svc = DAGService(trip_repo, plan_repo, node_repo, edge_repo)
    svc._test_batch = batch  # expose for assertions
    return svc


class TestCleanupStaleParticipantIds:
    @pytest.mark.asyncio
    async def test_cleans_linear_dag(self):
        """In a linear DAG, all participant_ids should be set to None."""
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
            {"id": "e2", "from_node_id": "B", "to_node_id": "C"},
        ])
        svc._node_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "A", "participant_ids": ["user_1"]},
            {"id": "B", "participant_ids": None},
            {"id": "C", "participant_ids": ["user_2"]},
        ])

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 2
        assert svc._test_batch.update.call_count == 2
        svc._test_batch.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skips_divergent_dag(self):
        """In a DAG with divergence, no cleanup should happen."""
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
            {"id": "e2", "from_node_id": "A", "to_node_id": "C"},
        ])

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 0
        svc._test_batch.commit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_cleanup_when_already_clean(self):
        """No cleanup needed when all participant_ids are already None."""
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
        ])
        svc._node_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "A", "participant_ids": None},
            {"id": "B", "participant_ids": None},
        ])

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 0
        svc._test_batch.commit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_dag(self):
        """No edges, no cleanup."""
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 0


class TestDeleteNodePreservesParticipantIds:
    """Verify that delete_node does NOT wipe participant_ids.

    Stale participant_ids in a linear graph are harmless — path computation
    only checks them at divergence points (out-degree > 1). Eagerly wiping
    them causes user-visible data loss when a branch is re-added later.
    """

    @pytest.mark.asyncio
    async def test_delete_does_not_trigger_cleanup(self):
        svc = _make_service()
        # DAG: A -> B -> C (linear after B is deleted: A -> C)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "e1", "from_node_id": "A", "to_node_id": "B", "travel_mode": "drive", "travel_time_hours": 2},
            {"id": "e2", "from_node_id": "B", "to_node_id": "C", "travel_mode": "drive", "travel_time_hours": 2},
        ])
        svc._node_repo.list_by_plan = AsyncMock(return_value=[
            {"id": "A", "participant_ids": ["user_1"]},
            {"id": "C", "participant_ids": ["user_2"]},
        ])

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["participant_ids_cleaned"] == 0
