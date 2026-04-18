"""Tests for DAGService: impact previews, node operations, and departure-time
fallback for the Routes API.

The old cascade engine (``compute_cascade``, ``confirm_cascade``,
``update_node_with_cascade_preview``) has been replaced by read-time
enrichment via ``shared.dag.time_inference.enrich_dag_times`` plus an
``impact_preview`` diff returned by ``update_node_with_impact_preview``.
These tests cover that new surface and the unchanged ``delete_node``
reconnection behavior.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from shared.dag._internals import parse_dt as _parse_dt
from shared.models.edge import Edge, TravelMode
from shared.models.node import LatLng, Node
from shared.services.dag_service import DAGService, _build_departure_map


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
    """Create a DAGService with mocked repositories.

    Sets up the Firestore batch mock so mutation methods (``create_node``,
    ``create_branch``, ``delete_node``) that commit all mutations in a
    single atomic batch can ``await batch.commit()``.
    """
    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()

    # Wire up a shared batch mock reachable via node_repo._db.batch().
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
    svc._test_batch = batch  # expose for assertions
    return svc


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
        nodes = [
            _make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
            _make_node_dict("B", "Lyon", arrival="2026-06-02T10:00:00+00:00"),
            _make_node_dict("C", "Nice", arrival="2026-06-03T10:00:00+00:00"),
        ]
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("B", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["deleted_node_id"] == "B"
        assert result["deleted_edge_count"] == 2
        assert result["reconnected_edge"] is not None
        assert result["reconnected_edge"]["from_node_id"] == "A"
        assert result["reconnected_edge"]["to_node_id"] == "C"
        # Travel time should be sum of both original edges
        assert result["reconnected_edge"]["travel_time_hours"] == 5

        svc._test_batch.commit.assert_awaited()
        # Batch should contain: 2 edge deletes + 1 edge create + 1 node delete = 4 ops
        assert svc._test_batch.delete.call_count >= 3  # 2 edges + 1 node
        assert svc._test_batch.set.call_count == 1  # 1 reconnected edge

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
        svc._test_batch.set.assert_not_called()

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
        nodes = [
            _make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
            _make_node_dict("B", "Lyon", arrival="2026-06-02T10:00:00+00:00"),
            _make_node_dict("C", "Nice", arrival="2026-06-02T10:00:00+00:00"),
            _make_node_dict("D", "Rome", arrival="2026-06-03T10:00:00+00:00"),
        ]
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
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["deleted_edge_count"] == 2
        assert result["reconnected_edge"] is not None
        assert result["reconnected_edge"]["from_node_id"] == "A"
        assert result["reconnected_edge"]["to_node_id"] == "D"
        assert result["reconnected_edge"]["travel_time_hours"] == 3

    @pytest.mark.asyncio
    async def test_delete_merge_node_reconnects_all_predecessors(self):
        """Deleting a merge node with N incoming, 1 outgoing reconnects all.

        DAG: A -> D, B -> D, C -> D, D -> E. Delete D =>
        reconnect A->E, B->E, C->E.
        """
        nodes = [
            _make_node_dict("A", "Paris"),
            _make_node_dict("B", "Lyon"),
            _make_node_dict("C", "Nice"),
            _make_node_dict("D", "Milan"),
            _make_node_dict("E", "Rome"),
        ]
        edges = [
            _make_edge_dict("A", "D", 2),
            _make_edge_dict("B", "D", 3),
            _make_edge_dict("C", "D", 1),
            _make_edge_dict("D", "E", 4),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "D")

        assert result["deleted_edge_count"] == 4
        assert len(result["reconnected_edges"]) == 3
        reconnected_pairs = {
            (e["from_node_id"], e["to_node_id"])
            for e in result["reconnected_edges"]
        }
        assert reconnected_pairs == {("A", "E"), ("B", "E"), ("C", "E")}
        # Backward compat: reconnected_edge is the first one
        assert result["reconnected_edge"] is not None

    @pytest.mark.asyncio
    async def test_delete_divergence_node_reconnects_all_successors(self):
        """Deleting a divergence node with 1 incoming, N outgoing reconnects all.

        DAG: A -> D, D -> B, D -> C. Delete D =>
        reconnect A->B, A->C.
        """
        nodes = [
            _make_node_dict("A", "Paris"),
            _make_node_dict("B", "Lyon"),
            _make_node_dict("C", "Nice"),
            _make_node_dict("D", "Milan"),
        ]
        edges = [
            _make_edge_dict("A", "D", 2),
            _make_edge_dict("D", "B", 3),
            _make_edge_dict("D", "C", 1),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "D")

        assert result["deleted_edge_count"] == 3
        assert len(result["reconnected_edges"]) == 2
        reconnected_pairs = {
            (e["from_node_id"], e["to_node_id"])
            for e in result["reconnected_edges"]
        }
        assert reconnected_pairs == {("A", "B"), ("A", "C")}
        assert result["reconnected_edge"] is not None

    @pytest.mark.asyncio
    async def test_delete_multi_in_multi_out_no_reconnect(self):
        """Deleting a node with N incoming and M outgoing (N>1, M>1) is ambiguous.

        DAG: A -> D, B -> D, D -> E, D -> F. Delete D => no reconnect.
        """
        edges = [
            _make_edge_dict("A", "D", 2),
            _make_edge_dict("B", "D", 3),
            _make_edge_dict("D", "E", 1),
            _make_edge_dict("D", "F", 4),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "D")

        assert result["deleted_edge_count"] == 4
        assert result["reconnected_edge"] is None
        assert result["reconnected_edges"] == []


# ── Delete node: route data on reconnect ──────────────────────────
class TestDeleteNodeRouteData:
    """Verify that delete_node passes coordinates and departure time when
    reconnecting edges, so the Routes API returns a real polyline instead
    of a flat line.
    """

    @pytest.mark.asyncio
    async def test_reconnect_passes_from_to_latlng(self):
        """Deleting B from A->B->C: the reconnected A->C edge must receive
        both nodes' lat_lng so the route service can fetch a real polyline.
        K=1 reconnections fetch synchronously (audit #7) so we assert on
        ``get_route_data`` rather than the background-task entry point."""
        nodes = [
            {**_make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", arrival="2026-06-02T10:00:00+00:00"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("C", "Nice", arrival="2026-06-03T10:00:00+00:00"),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("A", "B", 4),
            _make_edge_dict("B", "C", 5),
        ]

        mock_route_service = AsyncMock()
        mock_route_service.get_route_data = AsyncMock(return_value=None)
        mock_route_service.fetch_and_patch_polyline = AsyncMock()

        svc = _make_service()
        svc._route_service = mock_route_service
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["reconnected_edge"] is not None
        assert result["reconnected_edge"]["from_node_id"] == "A"
        assert result["reconnected_edge"]["to_node_id"] == "C"

        mock_route_service.get_route_data.assert_awaited_once()
        call_args = mock_route_service.get_route_data.call_args
        assert call_args.args[0] == {"lat": 48.86, "lng": 2.35}
        assert call_args.args[1] == {"lat": 43.71, "lng": 7.26}

    @pytest.mark.asyncio
    async def test_reconnect_passes_departure_time(self):
        """The reconnected edge should receive the from-node's departure time
        for traffic-aware routing. K=1 path fetches synchronously."""
        nodes = [
            {**_make_node_dict("A", "Paris",
                               arrival="2026-06-01T10:00:00+00:00",
                               departure="2026-06-02T08:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", arrival="2026-06-02T12:00:00+00:00"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("C", "Nice", arrival="2026-06-03T10:00:00+00:00"),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("A", "B", 4),
            _make_edge_dict("B", "C", 5),
        ]

        mock_route_service = AsyncMock()
        mock_route_service.get_route_data = AsyncMock(return_value=None)
        mock_route_service.fetch_and_patch_polyline = AsyncMock()

        svc = _make_service()
        svc._route_service = mock_route_service
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        await svc.delete_node("trip1", "plan1", "B")

        call_args = mock_route_service.get_route_data.call_args
        assert call_args.args[3] == datetime(2026, 6, 2, 8, 0, tzinfo=UTC)

    @pytest.mark.asyncio
    async def test_reconnect_no_route_fetch_without_route_service(self):
        """When no route service is configured, reconnection still works
        (edge created without polyline, no error)."""
        nodes = [
            {**_make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", arrival="2026-06-02T10:00:00+00:00"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("C", "Nice", arrival="2026-06-03T10:00:00+00:00"),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("A", "B", 4),
            _make_edge_dict("B", "C", 5),
        ]

        svc = _make_service()
        assert svc._route_service is None
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        result = await svc.delete_node("trip1", "plan1", "B")

        assert result["reconnected_edge"] is not None
        svc._test_batch.set.assert_called_once()

    @pytest.mark.asyncio
    async def test_reconnect_uses_enriched_departure(self):
        """When the from-node has no explicit departure_time, enrichment
        derives it from arrival_time + duration_minutes; the route request
        should use that enriched departure. K=1 path fetches synchronously."""
        nodes = [
            {**_make_node_dict("A", "Paris", duration_minutes=480),
             "lat_lng": {"lat": 48.86, "lng": 2.35},
             "arrival_time": "2026-06-01T10:00:00+00:00",
             "departure_time": None},
            {**_make_node_dict("B", "Lyon", duration_minutes=120),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("C", "Nice", duration_minutes=120),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("A", "B", 4),
            _make_edge_dict("B", "C", 5),
        ]

        mock_route_service = AsyncMock()
        mock_route_service.get_route_data = AsyncMock(return_value=None)
        mock_route_service.fetch_and_patch_polyline = AsyncMock()

        svc = _make_service()
        svc._route_service = mock_route_service
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.delete_edge = AsyncMock()
        svc._edge_repo.create_edge = AsyncMock()
        svc._node_repo.delete_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._node_repo.update_node = AsyncMock()

        await svc.delete_node("trip1", "plan1", "B")

        # A.arrival=10:00 + duration=480min → enriched departure 18:00
        call_args = mock_route_service.get_route_data.call_args
        assert call_args.args[3] == datetime(2026, 6, 1, 18, 0, tzinfo=UTC)

    @pytest.mark.asyncio
    async def test_delete_node_k1_fetches_polyline_synchronously(self):
        """Audit #7: K=1 reconnect must populate the new edge with the
        fetched polyline before the batch commits, and must NOT queue a
        background polyline-patch job."""
        from shared.services.route_service import RouteData

        nodes = [
            {**_make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", arrival="2026-06-02T10:00:00+00:00"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("C", "Nice", arrival="2026-06-03T10:00:00+00:00"),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("A", "B", 4),
            _make_edge_dict("B", "C", 5),
        ]

        mock_route_service = AsyncMock()
        mock_route_service.get_route_data = AsyncMock(return_value=RouteData(
            polyline="encoded_polyline_xyz",
            duration_seconds=7200,    # 2.0h
            distance_meters=180_000,  # 180.0km
        ))
        mock_route_service.fetch_and_patch_polyline = AsyncMock()

        svc = _make_service()
        svc._route_service = mock_route_service
        svc._spawn_background = MagicMock()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)

        result = await svc.delete_node("trip1", "plan1", "B")

        # Sync fetch happened exactly once; no background job spawned.
        mock_route_service.get_route_data.assert_awaited_once()
        svc._spawn_background.assert_not_called()

        # The reconnected edge's response payload carries the fetched data.
        reconnected = result["reconnected_edge"]
        assert reconnected["route_polyline"] == "encoded_polyline_xyz"
        assert reconnected["travel_time_hours"] == 2.0
        assert reconnected["distance_km"] == 180.0

    @pytest.mark.asyncio
    async def test_delete_node_k_gt_1_still_backgrounds(self):
        """Audit #7: K>1 reconnections (multiple incoming + 1 outgoing)
        keep the background-fetch path so the delete handler stays fast."""
        # X→T, Y→T, T→Z. Deleting T → 2 reconnections (X→Z, Y→Z) → K=2.
        nodes = [
            {**_make_node_dict("X", "X", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("Y", "Y", arrival="2026-06-01T11:00:00+00:00"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("T", "T", arrival="2026-06-02T10:00:00+00:00"),
             "lat_lng": {"lat": 44.00, "lng": 5.00}},
            {**_make_node_dict("Z", "Z", arrival="2026-06-03T10:00:00+00:00"),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("X", "T", 2),
            _make_edge_dict("Y", "T", 3),
            _make_edge_dict("T", "Z", 4),
        ]

        mock_route_service = AsyncMock()
        mock_route_service.get_route_data = AsyncMock()  # must NOT be called
        mock_route_service.fetch_and_patch_polyline = AsyncMock()

        svc = _make_service()
        svc._route_service = mock_route_service
        svc._spawn_background = MagicMock()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)

        result = await svc.delete_node("trip1", "plan1", "T")

        # No synchronous fetch; both reconnections went to background.
        mock_route_service.get_route_data.assert_not_awaited()
        assert svc._spawn_background.call_count == 2

        # Reconnected edges in the response carry no polyline yet.
        for re in result["reconnected_edges"]:
            assert re.get("route_polyline") is None


# ── Cleanup stale participant_ids ──────────────────────────────────
class TestCleanupStaleParticipantIds:
    """Test cleanup_stale_participant_ids multi-root handling."""

    @pytest.mark.asyncio
    async def test_preserves_participant_ids_on_multi_root_dag(self):
        """Multi-root DAG (R1, R2 → tail): cleanup must NOT fire."""
        nodes = [
            {**_make_node_dict("R1", "Rome"), "participant_ids": ["user_a"]},
            {**_make_node_dict("R2", "Milan"), "participant_ids": ["user_b"]},
            _make_node_dict("T", "Tail"),
        ]
        edges = [
            _make_edge_dict("R1", "T", 2),
            _make_edge_dict("R2", "T", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 0
        svc._node_repo.list_by_plan.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cleans_participant_ids_on_linear_single_root_dag(self):
        """Single-root linear DAG with stale IDs: cleanup should fire."""
        nodes = [
            {**_make_node_dict("A", "Paris"), "participant_ids": ["user_a"]},
            _make_node_dict("B", "Lyon"),
        ]
        edges = [_make_edge_dict("A", "B", 2)]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)

        mock_col = MagicMock()
        svc._node_repo._collection = MagicMock(return_value=mock_col)
        mock_batch = MagicMock()
        mock_batch.commit = AsyncMock()
        svc._node_repo._db = MagicMock()
        svc._node_repo._db.batch = MagicMock(return_value=mock_batch)

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 1
        mock_batch.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skips_cleanup_on_out_degree_divergence(self):
        """DAG with out-degree>1: cleanup must NOT fire."""
        nodes = [
            {**_make_node_dict("A", "Paris"), "participant_ids": ["user_a"]},
            _make_node_dict("B", "Lyon"),
            _make_node_dict("C", "Nice"),
        ]
        edges = [
            _make_edge_dict("A", "B", 2),
            _make_edge_dict("A", "C", 3),
        ]
        svc = _make_service()
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)

        cleaned = await svc.cleanup_stale_participant_ids("trip1", "plan1")

        assert cleaned == 0


# ── _build_departure_map ─────────────────────────────────────────
class TestBuildDepartureMap:
    """Verify the fallback chain: departure → arrival → trip root departure."""

    def test_flex_node_inherits_trip_root_departure(self):
        """A duration-only node with no arrival/departure should get the
        trip root's departure_time from the map."""
        nodes = [
            _make_node_dict(
                "root", "Denver",
                arrival="2026-07-25T10:00:00+00:00",
                departure="2026-07-25T18:00:00+00:00",
            ),
            _make_node_dict("flex", "Old Faithful", duration_minutes=120),
        ]
        edges = [_make_edge_dict("root", "flex")]

        result = _build_departure_map(nodes, edges)

        assert result["root"] == datetime(2026, 7, 25, 18, 0, tzinfo=UTC)
        # root dep 18:00 + 2h travel → flex arrival 20:00 + 120min duration
        # → enriched flex departure 22:00
        assert result["flex"] == datetime(2026, 7, 25, 22, 0, tzinfo=UTC)

    def test_node_with_arrival_uses_arrival(self):
        nodes = [
            _make_node_dict("A", "A",
                            arrival="2026-07-25T10:00:00+00:00",
                            departure="2026-07-25T18:00:00+00:00"),
            _make_node_dict("B", "B", duration_minutes=120),
        ]
        nodes[1]["arrival_time"] = "2026-07-26T12:00:00+00:00"
        edges = [_make_edge_dict("A", "B")]

        result = _build_departure_map(nodes, edges)

        # B.arrival=12:00 + duration=120min → enriched departure 14:00
        assert result["B"] == datetime(2026, 7, 26, 14, 0, tzinfo=UTC)

    def test_all_flex_nodes_returns_empty(self):
        """When no node has any time at all, map should be empty."""
        nodes = [
            _make_node_dict("A", "A", duration_minutes=120),
            _make_node_dict("B", "B", duration_minutes=60),
        ]
        edges = [_make_edge_dict("A", "B")]

        result = _build_departure_map(nodes, edges)

        assert result == {}


# ── Departure-time fallback for Routes API ───────────────────────

TRIP_ROOT_DEPARTURE = "2026-07-25T18:00:00+00:00"
# Enriched departure for flex node B in _flex_dag_nodes_and_edges():
# A.dep=18:00 + 6h travel → B.arrival=00:00 next day + 120min duration
# → B.dep=02:00 next day. This is what enrich_dag_times produces for
# flex downstream of a timed source.
FLEX_B_ENRICHED_DEPARTURE = datetime(2026, 7, 26, 2, 0, tzinfo=UTC)
# Enriched departure for flex node C: B.dep=02:00 + 2h travel
# → C.arrival=04:00 + 60min duration → C.dep=05:00.
FLEX_C_ENRICHED_DEPARTURE = datetime(2026, 7, 26, 5, 0, tzinfo=UTC)


def _make_node_model(
    id: str, name: str, lat: float = 0, lng: float = 0,
    arrival_time: datetime | None = None,
    departure_time: datetime | None = None,
    duration_minutes: int | None = None,
) -> Node:
    return Node(
        id=id, name=name, type="city",
        lat_lng=LatLng(lat=lat, lng=lng),
        arrival_time=arrival_time,
        departure_time=departure_time,
        duration_minutes=duration_minutes,
        created_by="user_1",
    )


def _flex_dag_nodes_and_edges():
    """A->B->C where A has explicit times but B and C are flex (duration-only).

    Simulates a trip departing Denver on Jul 25, driving through Yellowstone
    flex stops. The departure map should resolve B and C to A's departure.
    """
    nodes = [
        {**_make_node_dict("A", "Denver",
                           arrival="2026-07-25T10:00:00+00:00",
                           departure=TRIP_ROOT_DEPARTURE),
         "lat_lng": {"lat": 39.74, "lng": -104.99}},
        {**_make_node_dict("B", "Old Faithful", duration_minutes=120),
         "lat_lng": {"lat": 44.46, "lng": -110.83}},
        {**_make_node_dict("C", "Moran", duration_minutes=60),
         "lat_lng": {"lat": 43.85, "lng": -110.60}},
    ]
    edges = [
        _make_edge_dict("A", "B", 6),
        _make_edge_dict("B", "C", 2),
    ]
    return nodes, edges


def _setup_route_service(svc):
    """Attach a mock route service and return it for assertions."""
    mock_rs = AsyncMock()
    mock_rs.fetch_and_patch_polyline = AsyncMock()
    mock_rs.get_route_data = AsyncMock(return_value=None)
    svc._route_service = mock_rs
    return mock_rs


class TestDepartureTimeFallbackCreateNode:
    """create_node should fall back to trip root departure when the source
    node (connect_after) or new node (connect_before) is flex."""

    @pytest.mark.asyncio
    async def test_connect_after_flex_source_uses_trip_root_departure(self):
        nodes, edges = _flex_dag_nodes_and_edges()
        # Source is B (flex -- no departure_time, no arrival_time)
        source_model = _make_node_model(
            "B", "Old Faithful", lat=44.46, lng=-110.83,
            duration_minutes=120,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=source_model)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo._collection = MagicMock(return_value=MagicMock())
        svc._edge_repo._collection = MagicMock(return_value=MagicMock())

        await svc.create_node(
            trip_id="trip1", plan_id="plan1",
            name="Moran", node_type="city", lat=43.85, lng=-110.60,
            travel_mode="drive", travel_time_hours=2, distance_km=80,
            created_by="user_1",
            connect_after_node_id="B",
        )
        await asyncio.sleep(0)

        # B is flex; enrichment derives its departure from A.dep + travel_time + duration
        call_kwargs = mock_rs.fetch_and_patch_polyline.call_args
        assert call_kwargs.kwargs["departure_time"] == FLEX_B_ENRICHED_DEPARTURE

    @pytest.mark.asyncio
    async def test_connect_before_flex_new_node_uses_trip_root_departure(self):
        nodes, edges = _flex_dag_nodes_and_edges()
        # before_node is C (flex)
        before_model = _make_node_model(
            "C", "Moran", lat=43.85, lng=-110.60,
            duration_minutes=60,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=before_model)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo._collection = MagicMock(return_value=MagicMock())
        svc._edge_repo._collection = MagicMock(return_value=MagicMock())

        await svc.create_node(
            trip_id="trip1", plan_id="plan1",
            name="West Thumb", node_type="place", lat=44.42, lng=-110.57,
            connect_after_node_id=None,
            travel_mode="drive", travel_time_hours=1, distance_km=30,
            created_by="user_1",
            connect_before_node_id="C",
        )
        await asyncio.sleep(0)

        # New node inserted before C; C is flex so its enriched arrival
        # propagates. Enrichment yields departure 2026-07-26T05:00:00+00:00.
        call_kwargs = mock_rs.fetch_and_patch_polyline.call_args
        assert call_kwargs.kwargs["departure_time"] == FLEX_C_ENRICHED_DEPARTURE

    @pytest.mark.asyncio
    async def test_connect_after_timed_source_uses_direct_departure(self):
        """When the source node HAS a departure_time, use it directly
        (no extra list_by_plan call needed)."""
        dep_dt = datetime(2026, 7, 28, 8, 0, tzinfo=UTC)
        source_model = _make_node_model(
            "A", "Denver", lat=39.74, lng=-104.99,
            arrival_time=datetime(2026, 7, 25, 10, 0, tzinfo=UTC),
            departure_time=dep_dt,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=source_model)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])
        svc._node_repo._collection = MagicMock(return_value=MagicMock())
        svc._edge_repo._collection = MagicMock(return_value=MagicMock())

        await svc.create_node(
            trip_id="trip1", plan_id="plan1",
            name="Old Faithful", node_type="city", lat=44.46, lng=-110.83,
            travel_mode="drive", travel_time_hours=6, distance_km=500,
            created_by="user_1",
            connect_after_node_id="A",
        )
        await asyncio.sleep(0)

        call_kwargs = mock_rs.fetch_and_patch_polyline.call_args
        assert call_kwargs.kwargs["departure_time"] == dep_dt


class TestDepartureTimeFallbackCreateBranch:
    """create_branch should fall back to trip root departure when the
    source node is flex."""

    @pytest.mark.asyncio
    async def test_flex_source_uses_trip_root_departure(self):
        nodes, edges = _flex_dag_nodes_and_edges()
        source_model = _make_node_model(
            "B", "Old Faithful", lat=44.46, lng=-110.83,
            duration_minutes=120,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=source_model)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo._collection = MagicMock(return_value=MagicMock())
        svc._edge_repo._collection = MagicMock(return_value=MagicMock())

        await svc.create_branch(
            trip_id="trip1", plan_id="plan1",
            from_node_id="B",
            name="Canyon Village", node_type="place",
            lat=44.73, lng=-110.50,
            travel_mode="drive", travel_time_hours=1.5, distance_km=60,
            connect_to_node_id=None, created_by="user_1",
        )
        await asyncio.sleep(0)

        call_kwargs = mock_rs.fetch_and_patch_polyline.call_args
        assert call_kwargs.kwargs["departure_time"] == FLEX_B_ENRICHED_DEPARTURE

    @pytest.mark.asyncio
    async def test_flex_merge_edge_uses_trip_root_departure(self):
        """When branching with a merge-back edge, and both source and new node
        are flex, the merge edge should also get the trip root departure."""
        nodes, edges = _flex_dag_nodes_and_edges()
        source_model = _make_node_model(
            "B", "Old Faithful", lat=44.46, lng=-110.83,
            duration_minutes=120,
        )
        merge_target = _make_node_model(
            "C", "Moran", lat=43.85, lng=-110.60,
            duration_minutes=60,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(
            side_effect=lambda _t, _p, nid: source_model if nid == "B" else merge_target
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._node_repo._collection = MagicMock(return_value=MagicMock())
        svc._edge_repo._collection = MagicMock(return_value=MagicMock())

        await svc.create_branch(
            trip_id="trip1", plan_id="plan1",
            from_node_id="B",
            name="Canyon Village", node_type="place",
            lat=44.73, lng=-110.50,
            travel_mode="drive", travel_time_hours=1.5, distance_km=60,
            connect_to_node_id="C", created_by="user_1",
        )
        await asyncio.sleep(0)

        # Both branch and merge edges originate from flex B; enrichment
        # derives B's departure from A.dep + travel_time + duration.
        calls = mock_rs.fetch_and_patch_polyline.call_args_list
        assert len(calls) == 2
        assert calls[0].kwargs["departure_time"] == FLEX_B_ENRICHED_DEPARTURE
        assert calls[1].kwargs["departure_time"] == FLEX_B_ENRICHED_DEPARTURE


class TestDepartureTimeFallbackCreateStandaloneEdge:
    """create_standalone_edge should fall back to trip root departure for
    both the synchronous get_route_data call and the _create_edge_if_new
    background retry."""

    @pytest.mark.asyncio
    async def test_flex_from_node_sync_fetch_uses_trip_root_departure(self):
        """The synchronous get_route_data call should receive the trip root's
        departure, not None, when the from_node is flex."""
        nodes, edges = _flex_dag_nodes_and_edges()
        from_model = _make_node_model(
            "B", "Old Faithful", lat=44.46, lng=-110.83,
            duration_minutes=120,
        )
        to_model = _make_node_model(
            "C", "Moran", lat=43.85, lng=-110.60,
            duration_minutes=60,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(
            side_effect=lambda _t, _p, nid: from_model if nid == "B" else to_model
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.create_edge = AsyncMock()

        await svc.create_standalone_edge(
            trip_id="trip1", plan_id="plan1",
            from_node_id="B", to_node_id="C",
            travel_mode="drive",
        )

        # Sync get_route_data receives B's enriched departure (flex → derived)
        call_kwargs = mock_rs.get_route_data.call_args
        assert call_kwargs[0][3] == FLEX_B_ENRICHED_DEPARTURE

    @pytest.mark.asyncio
    async def test_flex_from_node_background_retry_uses_trip_root_departure(self):
        """When the sync fetch returns None (no route found), the background
        retry via _create_edge_if_new should also use the trip root departure."""
        # Use A->B only (no B->C edge), so creating B->C is new
        nodes = [
            {**_make_node_dict("A", "Denver",
                               arrival="2026-07-25T10:00:00+00:00",
                               departure=TRIP_ROOT_DEPARTURE),
             "lat_lng": {"lat": 39.74, "lng": -104.99}},
            {**_make_node_dict("B", "Old Faithful", duration_minutes=120),
             "lat_lng": {"lat": 44.46, "lng": -110.83}},
            {**_make_node_dict("C", "Moran", duration_minutes=60),
             "lat_lng": {"lat": 43.85, "lng": -110.60}},
        ]
        edges = [_make_edge_dict("A", "B", 6)]  # no B->C edge

        from_model = _make_node_model(
            "B", "Old Faithful", lat=44.46, lng=-110.83,
            duration_minutes=120,
        )
        to_model = _make_node_model(
            "C", "Moran", lat=43.85, lng=-110.60,
            duration_minutes=60,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        # Sync fetch returns None -> edge created without polyline ->
        # _create_edge_if_new fires background fetch_and_patch_polyline
        mock_rs.get_route_data = AsyncMock(return_value=None)
        svc._node_repo.get_node_or_raise = AsyncMock(
            side_effect=lambda _t, _p, nid: from_model if nid == "B" else to_model
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        svc._edge_repo.create_edge = AsyncMock()

        await svc.create_standalone_edge(
            trip_id="trip1", plan_id="plan1",
            from_node_id="B", to_node_id="C",
            travel_mode="drive",
        )
        await asyncio.sleep(0)

        call_kwargs = mock_rs.fetch_and_patch_polyline.call_args
        assert call_kwargs.kwargs["departure_time"] == FLEX_B_ENRICHED_DEPARTURE


class TestStandaloneEdgeDatetimeContract:
    """Lock in the datetime contract at the DAGService → RouteService boundary.

    Before this was enforced, callers could pass either a datetime (from
    Pydantic Node fields) or an ISO string (from _build_departure_map),
    and the mismatch only surfaced at the httpx JSON-encoding boundary as
    INTERNAL_ERROR — masked by mcpserver's tool_error_guard. Fixing the
    type contract means any regression back to string must fail this test.
    """

    @pytest.mark.asyncio
    async def test_create_standalone_edge_forwards_datetime_to_route_service(self):
        """from_node.departure_time is a pydantic datetime; it must reach
        get_route_data as a datetime, not a pre-serialized string."""
        dep_dt = datetime(2026, 5, 1, 10, 0, tzinfo=UTC)
        from_model = _make_node_model(
            "A", "Tokyo", lat=35.67, lng=139.65,
            departure_time=dep_dt,
            duration_minutes=1440,
        )
        to_model = _make_node_model(
            "B", "Kyoto", lat=35.01, lng=135.77,
            duration_minutes=2880,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(
            side_effect=lambda _t, _p, nid: from_model if nid == "A" else to_model
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=[])
        svc._edge_repo.list_by_plan = AsyncMock(return_value=[])
        svc._edge_repo.create_edge = AsyncMock()

        await svc.create_standalone_edge(
            trip_id="trip1", plan_id="plan1",
            from_node_id="A", to_node_id="B",
            travel_mode="transit",
        )

        call_args = mock_rs.get_route_data.call_args
        forwarded = call_args[0][3] if len(call_args.args) > 3 else call_args.kwargs.get("departure_time")
        assert isinstance(forwarded, datetime), (
            f"expected datetime, got {type(forwarded).__name__}: {forwarded!r}. "
            "Re-introducing .isoformat() at the dag_service layer will silently "
            "break httpx JSON encoding in production — keep the conversion at "
            "the _call_routes_api wire boundary only."
        )
        assert forwarded == dep_dt


class TestDepartureTimeFallbackSplitEdge:
    """split_edge should fall back to trip root departure when the from_node
    of the original edge is flex."""

    @pytest.mark.asyncio
    async def test_flex_from_node_uses_trip_root_departure(self):
        nodes, edges = _flex_dag_nodes_and_edges()
        # Splitting the B->C edge by inserting a new node between them
        from_model = _make_node_model(
            "B", "Old Faithful", lat=44.46, lng=-110.83,
            duration_minutes=120,
        )
        to_model = _make_node_model(
            "C", "Moran", lat=43.85, lng=-110.60,
            duration_minutes=60,
        )
        original_edge = Edge(
            id="e_B_C", from_node_id="B", to_node_id="C",
            travel_mode=TravelMode.DRIVE,
            travel_time_hours=2, distance_km=80,
        )

        svc = _make_service()
        mock_rs = _setup_route_service(svc)
        svc._edge_repo.get_edge = AsyncMock(return_value=original_edge)
        svc._node_repo.get_node_or_raise = AsyncMock(
            side_effect=lambda _t, _p, nid: from_model if nid == "B" else to_model
        )
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)
        # _collection mocks for the batch write
        svc._edge_repo._collection = MagicMock(return_value=MagicMock())
        svc._node_repo._collection = MagicMock(return_value=MagicMock())

        await svc.split_edge(
            trip_id="trip1", plan_id="plan1",
            split_edge_id="e_B_C",
            name="West Thumb", node_type="place",
            lat=44.42, lng=-110.57, created_by="user_1",
        )
        await asyncio.sleep(0)

        # Both edge_a (B->new) and edge_b (new->C) originate from flex B's
        # enriched departure (new split node has no times of its own).
        calls = mock_rs.fetch_and_patch_polyline.call_args_list
        assert len(calls) == 2
        dep_a = calls[0].kwargs.get("departure_time")
        dep_b = calls[1].kwargs.get("departure_time")
        assert dep_a == FLEX_B_ENRICHED_DEPARTURE
        assert dep_b == FLEX_B_ENRICHED_DEPARTURE


# ── Read-amplification regression tests ──────────────────────────
# Pin the optimization that lets ``update_node_with_impact_preview`` reuse
# the pre-fetched nodes/edges snapshot when calling
# ``_recalculate_connected_polylines``. A regression here re-introduces two
# Firestore reads (nodes + edges) per location-changing node edit on the
# REST path, plus one extra get_node_or_raise per connected edge.
class TestUpdateNodeImpactPreviewReadCount:
    @pytest.mark.asyncio
    async def test_lat_lng_change_reads_nodes_and_edges_once_each(self):
        """A location edit must call list_by_plan exactly once on each repo,
        regardless of how many connected edges fan out from the edited node.
        Pre-fix: list_by_plan was called twice (once for the impact preview,
        once again inside _recalculate_connected_polylines)."""
        nodes = [
            {**_make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", duration_minutes=120),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
            {**_make_node_dict("C", "Nice", duration_minutes=120),
             "lat_lng": {"lat": 43.71, "lng": 7.26}},
        ]
        edges = [
            _make_edge_dict("A", "B", 4),
            _make_edge_dict("B", "C", 5),
        ]
        svc = _make_service()
        _setup_route_service(svc)

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[1]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        await svc.update_node_with_impact_preview(
            "trip1", "plan1", "B",
            {"lat_lng": {"lat": 46.00, "lng": 5.00}},
            trip_settings={},
        )
        await asyncio.sleep(0)

        # The whole point: exactly one list call per repo, even though the
        # location change triggers a polyline recompute that historically
        # re-fetched both lists.
        assert svc._node_repo.list_by_plan.await_count == 1
        assert svc._edge_repo.list_by_plan.await_count == 1

    @pytest.mark.asyncio
    async def test_non_location_change_skips_polyline_fetches(self):
        """Name-only edits should still only read nodes+edges once each — the
        polyline branch is skipped entirely, but the impact preview snapshot
        is unconditional."""
        nodes = [
            {**_make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", duration_minutes=120),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
        ]
        edges = [_make_edge_dict("A", "B", 4)]
        svc = _make_service()
        _setup_route_service(svc)

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[1]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        await svc.update_node_with_impact_preview(
            "trip1", "plan1", "B",
            {"name": "Lyon Centre"},
            trip_settings={},
        )

        assert svc._node_repo.list_by_plan.await_count == 1
        assert svc._edge_repo.list_by_plan.await_count == 1

    @pytest.mark.asyncio
    async def test_polyline_recompute_uses_new_lat_lng_from_snapshot(self):
        """The post-update snapshot we hand to _recalculate_connected_polylines
        must contain the edited node's NEW coordinates — otherwise the route
        fetch goes from old coords to other-endpoint and the polyline is wrong.
        """
        nodes = [
            {**_make_node_dict("A", "Paris",
                               arrival="2026-06-01T10:00:00+00:00",
                               departure="2026-06-01T18:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", duration_minutes=120),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
        ]
        edges = [_make_edge_dict("A", "B", 4)]
        svc = _make_service()
        mock_rs = _setup_route_service(svc)

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[1]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        new_coords = {"lat": 46.20, "lng": 6.15}
        await svc.update_node_with_impact_preview(
            "trip1", "plan1", "B",
            {"lat_lng": new_coords},
            trip_settings={},
        )
        await asyncio.sleep(0)

        # B is the to_node on edge A->B; the recompute must pass B's NEW
        # coords as to_latlng. A's coords are unchanged.
        mock_rs.fetch_and_patch_polyline.assert_awaited_once()
        call = mock_rs.fetch_and_patch_polyline.call_args
        assert call.kwargs["from_latlng"] == {"lat": 48.86, "lng": 2.35}
        assert call.kwargs["to_latlng"] == new_coords

    @pytest.mark.asyncio
    async def test_unchanged_lat_lng_skips_polyline_recompute(self):
        """If the new lat_lng equals the old, no polyline recompute fires —
        no extra Firestore reads and no background route fetch."""
        nodes = [
            {**_make_node_dict("A", "Paris", arrival="2026-06-01T10:00:00+00:00"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon", duration_minutes=120),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
        ]
        edges = [_make_edge_dict("A", "B", 4)]
        svc = _make_service()
        mock_rs = _setup_route_service(svc)

        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[1]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        # Same coords as B in the snapshot.
        await svc.update_node_with_impact_preview(
            "trip1", "plan1", "B",
            {"lat_lng": {"lat": 45.76, "lng": 4.84}},
            trip_settings={},
        )

        mock_rs.fetch_and_patch_polyline.assert_not_called()
        # And we still only did the one snapshot read for the impact preview.
        assert svc._node_repo.list_by_plan.await_count == 1
        assert svc._edge_repo.list_by_plan.await_count == 1


class TestRecalculatePolylinesSnapshotPassthrough:
    """Pin the contract on `_recalculate_connected_polylines`:
    when callers pass `existing_nodes` / `existing_edges`, the method must
    NOT issue its own Firestore reads. When callers omit them, lazy fetch
    still works (the path used by `update_node_only`)."""

    @pytest.mark.asyncio
    async def test_with_snapshots_skips_repo_reads(self):
        nodes = [
            {**_make_node_dict("A", "Paris"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
        ]
        edges = [_make_edge_dict("A", "B", 4)]
        svc = _make_service()
        _setup_route_service(svc)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        await svc._recalculate_connected_polylines(
            "trip1", "plan1", "B",
            new_latlng={"lat": 46.00, "lng": 5.00},
            existing_nodes=nodes,
            existing_edges=edges,
        )
        await asyncio.sleep(0)

        svc._node_repo.list_by_plan.assert_not_called()
        svc._edge_repo.list_by_plan.assert_not_called()

    @pytest.mark.asyncio
    async def test_without_snapshots_lazy_fetches(self):
        """``update_node_only`` doesn't pre-fetch; the recompute method has
        to fall back to its own list_by_plan calls."""
        nodes = [
            {**_make_node_dict("A", "Paris"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
        ]
        edges = [_make_edge_dict("A", "B", 4)]
        svc = _make_service()
        _setup_route_service(svc)
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        await svc._recalculate_connected_polylines(
            "trip1", "plan1", "B",
            new_latlng={"lat": 46.00, "lng": 5.00},
        )
        await asyncio.sleep(0)

        assert svc._node_repo.list_by_plan.await_count == 1
        assert svc._edge_repo.list_by_plan.await_count == 1

    @pytest.mark.asyncio
    async def test_no_route_service_returns_immediately_without_reads(self):
        """No route service ⇒ method short-circuits before touching repos
        even if snapshots are absent. Guards against ever turning the early
        return into a fetch-then-skip ordering."""
        nodes = [{**_make_node_dict("A", "Paris"),
                  "lat_lng": {"lat": 48.86, "lng": 2.35}}]
        edges: list[dict] = []
        svc = _make_service()
        assert svc._route_service is None
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        await svc._recalculate_connected_polylines(
            "trip1", "plan1", "A", new_latlng={"lat": 0, "lng": 0}
        )

        svc._node_repo.list_by_plan.assert_not_called()
        svc._edge_repo.list_by_plan.assert_not_called()

    @pytest.mark.asyncio
    async def test_update_node_only_uses_lazy_fetch_path(self):
        """End-to-end: ``update_node_only`` (MCP / agent path) does NOT
        pre-fetch a snapshot, so it still relies on the lazy-fetch fallback
        inside _recalculate_connected_polylines. Pin the read counts so a
        future refactor doesn't accidentally double-read here either."""
        nodes = [
            {**_make_node_dict("A", "Paris"),
             "lat_lng": {"lat": 48.86, "lng": 2.35}},
            {**_make_node_dict("B", "Lyon"),
             "lat_lng": {"lat": 45.76, "lng": 4.84}},
        ]
        edges = [_make_edge_dict("A", "B", 4)]
        svc = _make_service()
        _setup_route_service(svc)
        svc._node_repo.get_node_or_raise = AsyncMock(return_value=Node(**nodes[1]))
        svc._node_repo.update_node = AsyncMock()
        svc._node_repo.list_by_plan = AsyncMock(return_value=nodes)
        svc._edge_repo.list_by_plan = AsyncMock(return_value=edges)

        await svc.update_node_only(
            "trip1", "plan1", "B",
            {"lat_lng": {"lat": 46.00, "lng": 5.00}},
        )
        await asyncio.sleep(0)

        # Lazy fetch path: each list called exactly once by the recompute.
        assert svc._node_repo.list_by_plan.await_count == 1
        assert svc._edge_repo.list_by_plan.await_count == 1
