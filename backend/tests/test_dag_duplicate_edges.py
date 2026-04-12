"""Tests for duplicate edge prevention across all DAG manipulation methods."""

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from shared.services.dag_service import DAGService

from shared.models import Node

# ── Helpers ──────────────────────────────────────────────────────


def _make_service():
    """Create a DAGService with mocked repositories.

    Sets up the Firestore batch mock so mutation methods (``create_node``,
    ``create_branch``, ``delete_node``) that commit all mutations in a
    single atomic batch can ``await batch.commit()``.
    """
    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()

    # Wire up batch mock for atomic batch paths.
    batch = MagicMock()
    batch.commit = AsyncMock()
    node_repo._db = MagicMock()
    node_repo._db.batch = MagicMock(return_value=batch)

    # Wire up _collection mocks for batch.set/batch.delete document refs.
    collection = MagicMock()
    collection.document = MagicMock(return_value=MagicMock())
    node_repo._collection = MagicMock(return_value=collection)
    edge_repo._collection = MagicMock(return_value=collection)

    svc = DAGService(trip_repo, plan_repo, node_repo, edge_repo)
    svc._test_batch = batch
    return svc


def _make_node_dict(
    id: str,
    name: str,
    arrival: str,
    duration_hours: float = 24,
    departure: str | None = None,
) -> dict:
    if departure is None:
        arr = datetime.fromisoformat(arrival)
        departure = (arr + timedelta(hours=duration_hours)).isoformat()
    return {
        "id": id,
        "name": name,
        "type": "city",
        "lat_lng": {"lat": 40.0, "lng": -110.0},
        "arrival_time": arrival,
        "departure_time": departure,
        "participant_ids": None,
        "place_id": None,
        "timezone": "America/Denver",
        "created_by": "user_1",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


def _make_edge_dict(
    from_id: str, to_id: str, travel_hours: float = 2, edge_id: str | None = None,
) -> dict:
    return {
        "id": edge_id or f"e_{from_id}_{to_id}",
        "from_node_id": from_id,
        "to_node_id": to_id,
        "travel_mode": "drive",
        "travel_time_hours": travel_hours,
        "distance_km": 100,
    }


# ── _create_edge_if_new ─────────────────────────────────────────


class TestCreateEdgeIfNew:
    """Test the core deduplication helper."""

    @pytest.mark.asyncio
    async def test_creates_edge_when_none_exists(self):
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])
        svc._edge_repo.create_edge = AsyncMock()

        from shared.models import Edge, TravelMode

        edge = Edge(
            id="e1",
            from_node_id="A",
            to_node_id="B",
            travel_mode=TravelMode.DRIVE,
            travel_time_hours=2,
            distance_km=100,
        )
        result = await svc._create_edge_if_new("trip1", "plan1", edge)

        svc._edge_repo.create_edge.assert_awaited_once()
        assert result["from_node_id"] == "A"
        assert result["to_node_id"] == "B"

    @pytest.mark.asyncio
    async def test_returns_existing_when_duplicate(self):
        existing_edge = _make_edge_dict("A", "B", 5, edge_id="existing_id")
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing_edge])
        svc._edge_repo.create_edge = AsyncMock()

        from shared.models import Edge, TravelMode

        edge = Edge(
            id="new_id",
            from_node_id="A",
            to_node_id="B",
            travel_mode=TravelMode.DRIVE,
            travel_time_hours=2,
            distance_km=100,
        )
        result = await svc._create_edge_if_new("trip1", "plan1", edge)

        svc._edge_repo.create_edge.assert_not_awaited()
        assert result["id"] == "existing_id"

    @pytest.mark.asyncio
    async def test_different_direction_is_not_duplicate(self):
        """A->B exists, creating B->A should succeed (different direction)."""
        existing_edge = _make_edge_dict("A", "B", 5)
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing_edge])
        svc._edge_repo.create_edge = AsyncMock()

        from shared.models import Edge, TravelMode

        edge = Edge(
            id="e_reverse",
            from_node_id="B",
            to_node_id="A",
            travel_mode=TravelMode.DRIVE,
            travel_time_hours=2,
            distance_km=100,
        )
        result = await svc._create_edge_if_new("trip1", "plan1", edge)

        svc._edge_repo.create_edge.assert_awaited_once()
        assert result["from_node_id"] == "B"
        assert result["to_node_id"] == "A"

    @pytest.mark.asyncio
    async def test_different_nodes_is_not_duplicate(self):
        """A->B exists, creating A->C should succeed."""
        existing_edge = _make_edge_dict("A", "B", 5)
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing_edge])
        svc._edge_repo.create_edge = AsyncMock()

        from shared.models import Edge, TravelMode

        edge = Edge(
            id="e_new",
            from_node_id="A",
            to_node_id="C",
            travel_mode=TravelMode.DRIVE,
            travel_time_hours=3,
            distance_km=200,
        )
        result = await svc._create_edge_if_new("trip1", "plan1", edge)

        svc._edge_repo.create_edge.assert_awaited_once()


# ── create_standalone_edge ───────────────────────────────────────


class TestCreateStandaloneEdgeDuplicates:
    """Test that create_standalone_edge prevents duplicates."""

    @pytest.mark.asyncio
    async def test_creates_edge_when_no_duplicate(self):
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])
        svc._edge_repo.create_edge = AsyncMock()
        mock_node = Node(**_make_node_dict("A", "NodeA", "2026-06-01T10:00:00+00:00"))
        mock_node.lat_lng = None
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=mock_node)

        result = await svc.create_standalone_edge(
            "trip1", "plan1", "A", "B", "drive", 2, 100,
        )

        svc._edge_repo.create_edge.assert_awaited_once()
        assert result["from_node_id"] == "A"
        assert result["to_node_id"] == "B"

    @pytest.mark.asyncio
    async def test_returns_existing_on_duplicate(self):
        existing = _make_edge_dict("A", "B", 5, edge_id="old_edge")
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing])
        svc._edge_repo.create_edge = AsyncMock()
        mock_node = Node(**_make_node_dict("A", "NodeA", "2026-06-01T10:00:00+00:00"))
        mock_node.lat_lng = None
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=mock_node)

        result = await svc.create_standalone_edge(
            "trip1", "plan1", "A", "B", "flight", 1, 500,
        )

        svc._edge_repo.create_edge.assert_not_awaited()
        assert result["id"] == "old_edge"


# ── create_node with connect_after ───────────────────────────────


class TestCreateNodeDuplicateEdge:
    """Test that create_node with connect_after_node_id doesn't create duplicate edges."""

    @pytest.mark.asyncio
    async def test_no_duplicate_edge_on_connect_after(self):
        """connect_after creates edge via atomic batch when no duplicate exists."""
        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[
            _make_node_dict("A", "Denver", "2026-06-01T10:00:00+00:00"),
        ])
        svc._node_repo.get_node_or_raise = AsyncMock(
            return_value=Node(**_make_node_dict("A", "Denver", "2026-06-01T10:00:00+00:00"))
        )

        # No existing edges — edge should be created
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.create_node(
            trip_id="trip1",
            plan_id="plan1",
            name="Salt Lake City",
            node_type="city",
            lat=40.76,
            lng=-111.89,
            connect_after_node_id="A",
            travel_mode="drive",
            travel_time_hours=6,
            distance_km=525,
            created_by="user_1",
        )

        assert result["edge"] is not None
        # Node + edge written via batch — 2 set calls
        assert svc._test_batch.set.call_count == 2
        svc._test_batch.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_no_edge_without_connect_after(self):
        """Without connect_after_node_id, only the node is batch-written."""
        svc = _make_service()

        result = await svc.create_node(
            trip_id="trip1",
            plan_id="plan1",
            name="Denver",
            node_type="city",
            lat=39.74,
            lng=-104.99,
            connect_after_node_id=None,
            travel_mode="drive",
            travel_time_hours=0,
            distance_km=None,
            created_by="user_1",
        )

        assert result["edge"] is None
        # Only node written — 1 set call
        assert svc._test_batch.set.call_count == 1
        svc._test_batch.commit.assert_awaited_once()


# ── delete_node reconnection ────────────────────────────────────


class TestDeleteNodeDuplicateEdge:
    """Test that delete_node reconnection doesn't create duplicate edges."""

    @pytest.mark.asyncio
    async def test_reconnect_skips_if_edge_exists(self):
        """Deleting B from A->B->C when A->C already exists should not duplicate."""
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 3),
            _make_edge_dict("A", "C", 4, edge_id="existing_ac"),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["deleted_node_id"] == "B"
        assert result["reconnected_edge"] is not None
        # Should return the existing edge, not create a new one
        assert result["reconnected_edge"]["id"] == "existing_ac"
        # No batch.set for edges — duplicate was detected
        svc._test_batch.set.assert_not_called()

    @pytest.mark.asyncio
    async def test_reconnect_creates_when_no_existing(self):
        """Deleting B from A->B->C when no A->C exists should create the edge."""
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["reconnected_edge"] is not None
        assert result["reconnected_edge"]["from_node_id"] == "A"
        assert result["reconnected_edge"]["to_node_id"] == "C"
        assert result["reconnected_edge"]["travel_time_hours"] == 5
        # Edge created via batch.set (atomic write)
        svc._test_batch.set.assert_called_once()


# ── create_branch ────────────────────────────────────────────────


class TestCreateBranchDuplicateEdge:
    """Test that create_branch doesn't create duplicate edges."""

    @pytest.mark.asyncio
    async def test_branch_edge_created_normally(self):
        """Normal branch creation should create the branch edge via atomic batch."""
        source_node = _make_node_dict("A", "Denver", "2026-06-01T10:00:00+00:00")
        svc = _make_service()
        svc._node_repo.get_node_or_raise = AsyncMock(
            return_value=Node(**source_node)
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=[source_node])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.create_branch(
            trip_id="trip1",
            plan_id="plan1",
            from_node_id="A",
            name="Moab",
            node_type="city",
            lat=38.57,
            lng=-109.55,
            travel_mode="drive",
            travel_time_hours=5.5,
            distance_km=350,
            connect_to_node_id=None,
            created_by="user_1",
        )

        assert result["edge"] is not None
        assert result["merge_edge"] is None
        # Node + branch edge via batch — 2 set calls
        assert svc._test_batch.set.call_count == 2
        svc._test_batch.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_branch_with_merge_creates_two_edges(self):
        """Branch with connect_to should create node + both edges atomically."""
        source_node = _make_node_dict("A", "Denver", "2026-06-01T10:00:00+00:00")
        merge_target = _make_node_dict("C", "SLC", "2026-06-05T10:00:00+00:00")
        svc = _make_service()

        async def _get_node(tid, pid, nid):
            if nid == "A":
                return Node(**source_node)
            return Node(**merge_target)

        svc._node_repo.get_node_or_raise = AsyncMock(side_effect=_get_node)
        svc._node_repo.list_by_plan = AsyncMock(return_value=[source_node, merge_target])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.create_branch(
            trip_id="trip1",
            plan_id="plan1",
            from_node_id="A",
            name="Moab",
            node_type="city",
            lat=38.57,
            lng=-109.55,
            travel_mode="drive",
            travel_time_hours=5.5,
            distance_km=350,
            connect_to_node_id="C",
            created_by="user_1",
        )

        assert result["edge"] is not None
        assert result["merge_edge"] is not None
        # Node + branch edge + merge edge via batch — 3 set calls
        assert svc._test_batch.set.call_count == 3
        svc._test_batch.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_branch_merge_skips_if_edge_exists(self):
        """If no pre-existing duplicates, both edges are created via batch."""
        source_node = _make_node_dict("A", "Denver", "2026-06-01T10:00:00+00:00")
        svc = _make_service()
        svc._node_repo.get_node_or_raise = AsyncMock(
            return_value=Node(**source_node)
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=[source_node])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc.create_branch(
            trip_id="trip1",
            plan_id="plan1",
            from_node_id="A",
            name="Moab",
            node_type="city",
            lat=38.57,
            lng=-109.55,
            travel_mode="drive",
            travel_time_hours=5.5,
            distance_km=350,
            connect_to_node_id="C",
            created_by="user_1",
        )

        assert result["edge"] is not None
        assert result["merge_edge"] is not None


# ── _find_existing_edge ──────────────────────────────────────────


class TestFindExistingEdge:
    """Test the edge lookup helper."""

    @pytest.mark.asyncio
    async def test_finds_matching_edge(self):
        existing = _make_edge_dict("A", "B", 5, edge_id="found")
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing])

        result = await svc._find_existing_edge("trip1", "plan1", "A", "B")

        assert result is not None
        assert result["id"] == "found"

    @pytest.mark.asyncio
    async def test_returns_none_when_no_match(self):
        existing = _make_edge_dict("A", "B", 5)
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing])

        result = await svc._find_existing_edge("trip1", "plan1", "A", "C")

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_empty_edges(self):
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])

        result = await svc._find_existing_edge("trip1", "plan1", "A", "B")

        assert result is None

    @pytest.mark.asyncio
    async def test_ignores_reverse_direction(self):
        existing = _make_edge_dict("B", "A", 5)
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[existing])

        result = await svc._find_existing_edge("trip1", "plan1", "A", "B")

        assert result is None
