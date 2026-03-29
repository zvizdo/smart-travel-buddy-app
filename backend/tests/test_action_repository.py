"""Tests for ActionRepository."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from backend.src.repositories.action_repository import ActionRepository

from shared.models import Action, ActionType


class TestActionRepository:
    def _make_repo(self):
        db = MagicMock()
        return ActionRepository(db)

    def test_collection_path(self):
        repo = self._make_repo()
        assert repo.collection_path == "trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions"

    @pytest.mark.asyncio
    async def test_create_action(self):
        repo = self._make_repo()
        mock_doc = MagicMock()
        mock_doc.set = AsyncMock()
        mock_collection = MagicMock()
        mock_collection.document = MagicMock(return_value=mock_doc)
        repo._collection = MagicMock(return_value=mock_collection)

        action = Action(
            id="act_1",
            type=ActionType.NOTE,
            content="Test note",
            created_by="user_1",
            created_at=datetime(2026, 1, 1, tzinfo=UTC),
        )

        result = await repo.create_action("trip1", "plan1", "node1", action)

        assert result["id"] == "act_1"
        assert result["type"] == "note"
        assert result["content"] == "Test note"
        repo._collection.assert_called_with(
            trip_id="trip1", plan_id="plan1", node_id="node1"
        )

    @pytest.mark.asyncio
    async def test_list_by_node(self):
        repo = self._make_repo()
        mock_docs = [
            MagicMock(to_dict=MagicMock(return_value={"id": "act_1", "content": "Note 1"})),
            MagicMock(to_dict=MagicMock(return_value={"id": "act_2", "content": "Note 2"})),
        ]

        async def mock_stream():
            for doc in mock_docs:
                yield doc

        mock_collection = MagicMock()
        mock_collection.stream = mock_stream
        repo._collection = MagicMock(return_value=mock_collection)

        result = await repo.list_by_node("trip1", "plan1", "node1")

        assert len(result) == 2
        assert result[0]["id"] == "act_1"
        assert result[1]["id"] == "act_2"

    @pytest.mark.asyncio
    async def test_update_action(self):
        repo = self._make_repo()
        mock_doc = MagicMock()
        mock_doc.update = AsyncMock()
        mock_collection = MagicMock()
        mock_collection.document = MagicMock(return_value=mock_doc)
        repo._collection = MagicMock(return_value=mock_collection)

        await repo.update_action("trip1", "plan1", "node1", "act_1", {"is_completed": True})

        mock_collection.document.assert_called_with("act_1")
        mock_doc.update.assert_awaited_once_with({"is_completed": True})

    @pytest.mark.asyncio
    async def test_delete_action(self):
        repo = self._make_repo()
        mock_doc = MagicMock()
        mock_doc.delete = AsyncMock()
        mock_collection = MagicMock()
        mock_collection.document = MagicMock(return_value=mock_doc)
        repo._collection = MagicMock(return_value=mock_collection)

        await repo.delete_action("trip1", "plan1", "node1", "act_1")

        mock_collection.document.assert_called_with("act_1")
        mock_doc.delete.assert_awaited_once()
