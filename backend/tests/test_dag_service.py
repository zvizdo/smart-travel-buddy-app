"""Tests for DAGService cascade engine and node operations."""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from backend.src.services.dag_service import DAGService
from shared.dag.cascade import parse_dt as _parse_dt


# ── _parse_dt helper ──────────────────────────────────────────────
class TestParseDt:
    def test_parses_iso_string(self):
        dt = _parse_dt("2026-06-01T10:00:00+00:00")
        assert dt == datetime(2026, 6, 1, 10, 0, tzinfo=UTC)

    def test_parses_iso_string_without_tz(self):
        dt = _parse_dt("2026-06-01T10:00:00")
        assert dt.tzinfo == UTC

    def test_passes_through_datetime(self):
        original = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
        assert _parse_dt(original) is original

    def test_adds_utc_to_naive_datetime(self):
        naive = datetime(2026, 6, 1, 10, 0)
        result = _parse_dt(naive)
        assert result.tzinfo == UTC


# ── Cascade Preview ───────────────────────────────────────────────
def _make_service():
    """Create a DAGService with mocked repositories."""
    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()
    return DAGService(trip_repo, plan_repo, node_repo, edge_repo)


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
        "lat_lng": {"lat": 0, "lng": 0},
        "arrival_time": arrival,
        "departure_time": departure,
        "participant_ids": None,
        "order_index": 0,
        "place_id": None,
        "created_by": "user_1",
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


def _make_edge_dict(from_id: str, to_id: str, travel_hours: float = 2) -> dict:
    return {
        "id": f"e_{from_id}_{to_id}",
        "from_node_id": from_id,
        "to_node_id": to_id,
        "travel_mode": "drive",
        "travel_time_hours": travel_hours,
        "distance_km": 100,
    }


class TestCascadePreviewLinear:
    """Test cascade preview on a linear DAG: A -> B -> C."""

    @pytest.fixture()
    def linear_dag(self):
        # A: June 1 10:00, 24h stay -> departs June 2 10:00
        # B: June 2 12:00 (2h travel), 24h stay -> departs June 3 12:00
        # C: June 3 14:00 (2h travel), 24h stay
        nodes = [
            _make_node_dict("A", "Paris", "2026-06-01T10:00:00+00:00", 24),
            _make_node_dict("B", "Lyon", "2026-06-02T12:00:00+00:00", 24),
            _make_node_dict("C", "Marseille", "2026-06-03T14:00:00+00:00", 24),
        ]
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 2),
        ]
        return nodes, edges

    @pytest.mark.asyncio
    async def test_cascade_propagates_to_downstream(self, linear_dag):
        """Moving A's departure by +24h should shift B and C by +24h."""
        nodes, edges = linear_dag
        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        from shared.models import Node

        # A is modified: arrival pushed forward by 24h
        modified_a = Node(**{
            **nodes[0],
            "arrival_time": "2026-06-02T10:00:00+00:00",
            "departure_time": "2026-06-03T10:00:00+00:00",
        })

        preview = await svc._compute_cascade_preview("trip1", "plan1", modified_a)

        assert len(preview["affected_nodes"]) == 2
        affected_ids = {n["id"] for n in preview["affected_nodes"]}
        assert affected_ids == {"B", "C"}

        # B should now arrive at June 3 12:00 (was June 2 12:00)
        b_affected = next(n for n in preview["affected_nodes"] if n["id"] == "B")
        assert b_affected["new_arrival"] == "2026-06-03T12:00:00+00:00"

    @pytest.mark.asyncio
    async def test_no_cascade_when_no_change(self, linear_dag):
        """If node timing doesn't actually change downstream, no nodes affected."""
        nodes, edges = linear_dag
        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        from shared.models import Node

        # A stays the same
        unchanged_a = Node(**nodes[0])
        preview = await svc._compute_cascade_preview("trip1", "plan1", unchanged_a)
        assert len(preview["affected_nodes"]) == 0


class TestCascadePreviewDivergent:
    """Test cascade on a diamond DAG: A -> B, A -> C, B -> D, C -> D."""

    @pytest.fixture()
    def diamond_dag(self):
        nodes = [
            _make_node_dict("A", "Start", "2026-06-01T10:00:00+00:00", 12),
            _make_node_dict("B", "Branch1", "2026-06-01T23:00:00+00:00", 12),
            _make_node_dict("C", "Branch2", "2026-06-02T01:00:00+00:00", 12),
            _make_node_dict("D", "Merge", "2026-06-02T14:00:00+00:00", 12),
        ]
        edges = [
            _make_edge_dict("A", "B", 1),
            _make_edge_dict("A", "C", 3),
            _make_edge_dict("B", "D", 1),
            _make_edge_dict("C", "D", 1),
        ]
        return nodes, edges

    @pytest.mark.asyncio
    async def test_cascade_follows_both_branches(self, diamond_dag):
        """Changing A should cascade to B, C, and D."""
        nodes, edges = diamond_dag
        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        from shared.models import Node

        # Push A forward by 12h
        modified_a = Node(**{
            **nodes[0],
            "arrival_time": "2026-06-01T22:00:00+00:00",
            "departure_time": "2026-06-02T10:00:00+00:00",
        })

        preview = await svc._compute_cascade_preview("trip1", "plan1", modified_a)
        affected_ids = {n["id"] for n in preview["affected_nodes"]}
        assert "B" in affected_ids
        assert "C" in affected_ids
        assert "D" in affected_ids


class TestCascadeConfirm:
    """Test that confirm_cascade writes changes atomically."""

    @pytest.mark.asyncio
    async def test_confirm_applies_batch_write(self):
        nodes = [
            _make_node_dict("A", "Paris", "2026-06-02T10:00:00+00:00", 24),
            _make_node_dict("B", "Lyon", "2026-06-02T12:00:00+00:00", 24),
        ]
        edges = [_make_edge_dict("A", "B", 2)]

        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        from shared.models import Node

        svc._node_repo.get_node_or_raise = AsyncMock(
            return_value=Node(**{
                **nodes[0],
                "arrival_time": "2026-06-02T10:00:00+00:00",
                "departure_time": "2026-06-03T10:00:00+00:00",
            })
        )

        mock_batch = MagicMock()
        mock_batch.commit = AsyncMock()
        svc._node_repo._db = MagicMock()
        svc._node_repo._db.batch = MagicMock(return_value=mock_batch)
        svc._node_repo._collection = MagicMock()
        mock_doc = MagicMock()
        svc._node_repo._collection.return_value.document = MagicMock(return_value=mock_doc)

        result = await svc.confirm_cascade("trip1", "plan1", "A")

        assert result["updated_count"] == 1
        mock_batch.update.assert_called_once()
        mock_batch.commit.assert_awaited_once()


class TestCascadeEdgeCases:
    """Test edge cases in cascade computation."""

    @pytest.mark.asyncio
    async def test_leaf_node_no_cascade(self):
        """A node with no outgoing edges should produce empty cascade."""
        nodes = [
            _make_node_dict("A", "Start", "2026-06-01T10:00:00+00:00", 24),
            _make_node_dict("B", "End", "2026-06-02T12:00:00+00:00", 24),
        ]
        edges = [_make_edge_dict("A", "B", 2)]

        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        from shared.models import Node

        # Modify B (leaf) — no downstream nodes
        modified_b = Node(**{
            **nodes[1],
            "arrival_time": "2026-06-05T12:00:00+00:00",
            "departure_time": "2026-06-06T12:00:00+00:00",
        })
        preview = await svc._compute_cascade_preview("trip1", "plan1", modified_b)
        assert len(preview["affected_nodes"]) == 0

    @pytest.mark.asyncio
    async def test_long_chain_cascade(self):
        """A long chain A->B->C->D->E should cascade all the way."""
        base_time = datetime(2026, 6, 1, 10, 0, tzinfo=UTC)
        nodes = []
        edges = []
        names = ["A", "B", "C", "D", "E"]
        for i, name in enumerate(names):
            arrival = (base_time + timedelta(hours=26 * i)).isoformat()
            nodes.append(_make_node_dict(name, name, arrival, 24))
            if i > 0:
                edges.append(_make_edge_dict(names[i - 1], name, 2))

        svc = _make_service()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        from shared.models import Node

        # Push A forward by 48h
        modified_a = Node(**{
            **nodes[0],
            "arrival_time": "2026-06-03T10:00:00+00:00",
            "departure_time": "2026-06-04T10:00:00+00:00",
        })
        preview = await svc._compute_cascade_preview("trip1", "plan1", modified_a)
        # All 4 downstream nodes should be affected
        assert len(preview["affected_nodes"]) == 4
        affected_ids = [n["id"] for n in preview["affected_nodes"]]
        assert affected_ids == ["B", "C", "D", "E"]


# ── Delete Node ──────────────────────────────────────────────────
class TestDeleteNodeLinear:
    """Test delete_node on a linear DAG: A -> B -> C."""

    @pytest.mark.asyncio
    async def test_delete_middle_reconnects_edges(self):
        """Deleting B from A->B->C should create edge A->C."""
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["deleted_node_id"] == "B"
        assert result["deleted_edge_count"] == 2
        assert result["reconnected_edge"] is not None
        assert result["reconnected_edge"]["from_node_id"] == "A"
        assert result["reconnected_edge"]["to_node_id"] == "C"
        # Travel time should be sum of both original edges
        assert result["reconnected_edge"]["travel_time_hours"] == 5

        svc._node_repo.delete_node.assert_awaited_once_with("trip1", "plan1", "B")
        svc._edge_repo.create_edge.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_delete_leaf_no_reconnect(self):
        """Deleting C (leaf) from A->B->C should just remove the edge B->C."""
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "C")

        assert result["deleted_node_id"] == "C"
        assert result["deleted_edge_count"] == 1
        assert result["reconnected_edge"] is None
        svc._edge_repo.create_edge.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_delete_root_no_reconnect(self):
        """Deleting A (root) from A->B->C should just remove edge A->B."""
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "A")

        assert result["deleted_node_id"] == "A"
        assert result["deleted_edge_count"] == 1
        assert result["reconnected_edge"] is None

    @pytest.mark.asyncio
    async def test_delete_standalone_node(self):
        """Deleting a node with no edges should succeed cleanly."""
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "X")

        assert result["deleted_node_id"] == "X"
        assert result["deleted_edge_count"] == 0
        assert result["reconnected_edge"] is None


class TestDeleteNodeDivergent:
    """Test delete_node at divergence/merge points."""

    @pytest.mark.asyncio
    async def test_delete_divergence_point_no_reconnect(self):
        """Deleting a node with multiple outgoing edges should not reconnect.

        DAG: A -> B, A -> C (A has 2 outgoing, 0 incoming => no reconnect)
        """
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("A", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "A")

        assert result["deleted_edge_count"] == 2
        assert result["reconnected_edge"] is None

    @pytest.mark.asyncio
    async def test_delete_merge_point_no_reconnect(self):
        """Deleting a merge node with multiple incoming edges should not reconnect.

        DAG: B -> D, C -> D (D has 2 incoming, 0 outgoing => no reconnect)
        """
        edges = [
            _make_edge_dict("B", "D", 2),
            _make_edge_dict("C", "D", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "D")

        assert result["deleted_edge_count"] == 2
        assert result["reconnected_edge"] is None

    @pytest.mark.asyncio
    async def test_delete_mid_branch_reconnects(self):
        """Deleting a mid-branch node with 1-in-1-out should reconnect.

        DAG: A -> B -> D, A -> C -> D. Delete B => reconnect A -> D.
        """
        edges = [
            _make_edge_dict("A", "B", 1),
            _make_edge_dict("B", "D", 2),
            _make_edge_dict("A", "C", 1),
            _make_edge_dict("C", "D", 2),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["deleted_edge_count"] == 2
        assert result["reconnected_edge"] is not None
        assert result["reconnected_edge"]["from_node_id"] == "A"
        assert result["reconnected_edge"]["to_node_id"] == "D"
        assert result["reconnected_edge"]["travel_time_hours"] == 3
