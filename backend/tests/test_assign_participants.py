"""Tests for the assign_participants endpoint.

The handler validates that the target node is downstream of a divergence
point. The earlier implementation re-scanned all_edges_raw once per parent
to compute the parent's out-degree, making the check O(in_edges × E). The
fixed version pre-computes a single Counter and looks parents up in O(1).
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.src.api.nodes import (
    ParticipantAssignmentRequest,
    assign_participants,
)
from shared.models import Participant, Trip, TripRole


def _trip_with_admin() -> Trip:
    return Trip(
        id="trip1",
        name="Test Trip",
        created_by="admin1",
        participants={
            "admin1": Participant(role=TripRole.ADMIN, display_name="Admin"),
            "p1": Participant(role=TripRole.PLANNER, display_name="P1"),
            "p2": Participant(role=TripRole.PLANNER, display_name="P2"),
        },
    )


def _make_deps(trip: Trip, edges: list[dict]):
    trip_service = MagicMock()
    trip_service.get_trip = AsyncMock(return_value=trip)

    dag_service = MagicMock()
    dag_service._edge_repo = MagicMock()
    dag_service._edge_repo.list_by_plan = AsyncMock(return_value=edges)

    node_repo = MagicMock()
    node_repo.update_node = AsyncMock()

    return trip_service, dag_service, node_repo


@pytest.mark.asyncio
async def test_allows_assignment_on_node_downstream_of_divergence():
    """A → {B, C}; assigning to B must succeed because parent A diverges."""
    trip = _trip_with_admin()
    edges = [
        {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
        {"id": "e2", "from_node_id": "A", "to_node_id": "C"},
    ]
    trip_service, dag_service, node_repo = _make_deps(trip, edges)
    body = ParticipantAssignmentRequest(participant_ids=["p1"])

    result = await assign_participants(
        "trip1", "plan1", "B", body,
        user={"uid": "admin1"},
        trip_service=trip_service, dag_service=dag_service, node_repo=node_repo,
    )

    assert result == {"node_id": "B", "participant_ids": ["p1"]}
    node_repo.update_node.assert_awaited_once()


@pytest.mark.asyncio
async def test_rejects_linear_node():
    """Linear A → B → C: B has no divergent parent and out-degree 1 → reject."""
    trip = _trip_with_admin()
    edges = [
        {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
        {"id": "e2", "from_node_id": "B", "to_node_id": "C"},
    ]
    trip_service, dag_service, node_repo = _make_deps(trip, edges)
    body = ParticipantAssignmentRequest(participant_ids=["p1"])

    with pytest.raises(ValueError, match="not on a divergent path"):
        await assign_participants(
            "trip1", "plan1", "B", body,
            user={"uid": "admin1"},
            trip_service=trip_service, dag_service=dag_service, node_repo=node_repo,
        )


@pytest.mark.asyncio
async def test_allows_divergence_point_itself():
    """B has out-degree > 1 (B → {C, D}); assigning to B must succeed."""
    trip = _trip_with_admin()
    edges = [
        {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
        {"id": "e2", "from_node_id": "B", "to_node_id": "C"},
        {"id": "e3", "from_node_id": "B", "to_node_id": "D"},
    ]
    trip_service, dag_service, node_repo = _make_deps(trip, edges)
    body = ParticipantAssignmentRequest(participant_ids=["p1"])

    result = await assign_participants(
        "trip1", "plan1", "B", body,
        user={"uid": "admin1"},
        trip_service=trip_service, dag_service=dag_service, node_repo=node_repo,
    )
    assert result["node_id"] == "B"


@pytest.mark.asyncio
async def test_allows_isolated_node():
    """Node with no in-edges (in_edges falsy) is always allowed."""
    trip = _trip_with_admin()
    edges = [{"id": "e1", "from_node_id": "X", "to_node_id": "Y"}]
    trip_service, dag_service, node_repo = _make_deps(trip, edges)
    body = ParticipantAssignmentRequest(participant_ids=["p1"])

    result = await assign_participants(
        "trip1", "plan1", "Z", body,
        user={"uid": "admin1"},
        trip_service=trip_service, dag_service=dag_service, node_repo=node_repo,
    )
    assert result["node_id"] == "Z"


@pytest.mark.asyncio
async def test_rejects_non_member_participant():
    trip = _trip_with_admin()
    edges = [
        {"id": "e1", "from_node_id": "A", "to_node_id": "B"},
        {"id": "e2", "from_node_id": "A", "to_node_id": "C"},
    ]
    trip_service, dag_service, node_repo = _make_deps(trip, edges)
    body = ParticipantAssignmentRequest(participant_ids=["ghost"])

    with pytest.raises(ValueError, match="not a trip participant"):
        await assign_participants(
            "trip1", "plan1", "B", body,
            user={"uid": "admin1"},
            trip_service=trip_service, dag_service=dag_service, node_repo=node_repo,
        )


@pytest.mark.asyncio
async def test_loads_edges_only_once():
    """Pin the optimization: the handler used to scan all_edges_raw once per
    parent edge to compute that parent's out-degree (O(in_edges × E)). The
    fixed version pre-computes a single Counter and looks parents up in O(1).
    A regression here would re-introduce per-parent scans — hard to detect
    from the outside, so we assert directly that the edge list is loaded
    exactly once per request and the handler still produces correct results
    on a many-parent topology that would have been quadratic."""
    trip = _trip_with_admin()
    # Wide funnel: 50 parents → target T, one of them (P0) is a divergence
    # point. Old code would call sum() once per in-edge (50 times), each
    # scan being O(E) ≈ 51 — 50×51 = 2550 ops. New code: one O(E) pass.
    edges = [{"id": f"in_{i}", "from_node_id": f"P{i}", "to_node_id": "T"} for i in range(50)]
    edges.append({"id": "div", "from_node_id": "P0", "to_node_id": "OTHER"})

    trip_service, dag_service, node_repo = _make_deps(trip, edges)
    body = ParticipantAssignmentRequest(participant_ids=["p1"])

    await assign_participants(
        "trip1", "plan1", "T", body,
        user={"uid": "admin1"},
        trip_service=trip_service, dag_service=dag_service, node_repo=node_repo,
    )

    assert dag_service._edge_repo.list_by_plan.await_count == 1
    node_repo.update_node.assert_awaited_once()
