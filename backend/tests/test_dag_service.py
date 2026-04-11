"""Tests for DAGService: impact previews and node operations.

The old cascade engine (``compute_cascade``, ``confirm_cascade``,
``update_node_with_cascade_preview``) has been replaced by read-time
enrichment via ``shared.dag.time_inference.enrich_dag_times`` plus an
``impact_preview`` diff returned by ``update_node_with_impact_preview``.
These tests cover that new surface and the unchanged ``delete_node``
reconnection behavior.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest
from shared.dag._internals import parse_dt as _parse_dt
from shared.services.dag_service import DAGService


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
    arrival: str | None = None,
    duration_hours: float = 24,
    departure: str | None = None,
    duration_minutes: int | None = None,
) -> dict:
    if arrival is not None and departure is None and duration_minutes is None:
        arr = datetime.fromisoformat(arrival)
        departure = (arr + timedelta(hours=duration_hours)).isoformat()
    return {
        "id": id,
        "name": name,
        "type": "city",
        "lat_lng": {"lat": 0, "lng": 0},
        "arrival_time": arrival,
        "departure_time": departure,
        "duration_minutes": duration_minutes,
        "participant_ids": None,
        "order_index": 0,
        "place_id": None,
        "timezone": None,
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


# ── Impact preview diff (static helper) ──────────────────────────
class TestDiffEnrichment:
    """``_diff_enrichment`` is a pure static helper; unit-test it directly."""

    def test_shifting_upstream_moves_downstream_flex_node(self):
        # A is time-bound and just slid forward 24h; B is flexible so it
        # should follow automatically.
        before_nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-02T10:00:00+00:00",
            ),
            _make_node_dict("B", "Lyon", duration_minutes=120),
        ]
        after_nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-02T10:00:00+00:00",
                departure="2026-06-03T10:00:00+00:00",
            ),
            _make_node_dict("B", "Lyon", duration_minutes=120),
        ]
        edges = [_make_edge_dict("A", "B", 2)]

        result = DAGService._diff_enrichment(
            before_nodes, after_nodes, edges, trip_settings={}
        )

        shifted_ids = {s["id"] for s in result["estimated_shifts"]}
        assert "B" in shifted_ids
        assert result["new_conflicts"] == []

    def test_time_bound_downstream_surfaces_conflict(self):
        # A is moved so that its propagated arrival to B (+2h) no longer
        # matches B's user-set arrival. B is time-bound so it does NOT shift
        # — the diff must surface this as a `new_conflict`.
        before_nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-01T12:00:00+00:00",
            ),
            _make_node_dict(
                "B", "Lyon",
                arrival="2026-06-01T14:00:00+00:00",
                departure="2026-06-01T16:00:00+00:00",
            ),
        ]
        after_nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-01T18:00:00+00:00",  # +6h
            ),
            _make_node_dict(
                "B", "Lyon",
                arrival="2026-06-01T14:00:00+00:00",
                departure="2026-06-01T16:00:00+00:00",
            ),
        ]
        edges = [_make_edge_dict("A", "B", 2)]

        result = DAGService._diff_enrichment(
            before_nodes, after_nodes, edges, trip_settings={}
        )

        conflict_ids = {c["id"] for c in result["new_conflicts"]}
        assert "B" in conflict_ids

    def test_no_change_returns_empty_lists(self):
        nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-02T10:00:00+00:00",
            ),
            _make_node_dict("B", "Lyon", duration_minutes=120),
        ]
        edges = [_make_edge_dict("A", "B", 2)]

        result = DAGService._diff_enrichment(nodes, nodes, edges, trip_settings={})
        assert result == {
            "estimated_shifts": [],
            "new_conflicts": [],
            "new_overnight_holds": [],
        }


class TestUpdateNodeWithImpactPreview:
    """End-to-end: read before, update, read after, diff."""

    @pytest.mark.asyncio
    async def test_name_only_update_has_empty_impact_preview(self):
        nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-02T10:00:00+00:00",
            ),
            _make_node_dict("B", "Lyon", duration_minutes=120),
        ]
        edges = [_make_edge_dict("A", "B", 2)]
        svc = _make_service()

        from shared.models import Node

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[0]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        result = await svc.update_node_with_impact_preview(
            "trip1", "plan1", "A", {"name": "New Paris"}, trip_settings={}
        )

        assert result["impact_preview"]["estimated_shifts"] == []
        assert result["impact_preview"]["new_conflicts"] == []

    @pytest.mark.asyncio
    async def test_departure_shift_surfaces_downstream_flex_shift(self):
        nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-02T10:00:00+00:00",
            ),
            _make_node_dict("B", "Lyon", duration_minutes=120),
        ]
        edges = [_make_edge_dict("A", "B", 2)]
        svc = _make_service()

        from shared.models import Node

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[0]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        result = await svc.update_node_with_impact_preview(
            "trip1", "plan1", "A",
            {"departure_time": "2026-06-03T10:00:00+00:00"},
            trip_settings={},
        )

        shifted_ids = {s["id"] for s in result["impact_preview"]["estimated_shifts"]}
        assert "B" in shifted_ids

    @pytest.mark.asyncio
    async def test_departure_shift_surfaces_time_bound_conflict(self):
        nodes = [
            _make_node_dict(
                "A", "Paris",
                arrival="2026-06-01T10:00:00+00:00",
                departure="2026-06-01T12:00:00+00:00",
            ),
            _make_node_dict(
                "B", "Lyon",
                arrival="2026-06-01T14:00:00+00:00",
                departure="2026-06-01T16:00:00+00:00",
            ),
        ]
        edges = [_make_edge_dict("A", "B", 2)]
        svc = _make_service()

        from shared.models import Node

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[0]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        result = await svc.update_node_with_impact_preview(
            "trip1", "plan1", "A",
            {"departure_time": "2026-06-01T18:00:00+00:00"},
            trip_settings={},
        )

        conflict_ids = {c["id"] for c in result["impact_preview"]["new_conflicts"]}
        assert "B" in conflict_ids


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
