"""Regression tests for `McpTripService.get_trip_context`.

Pins two contract points in the node dict returned to MCP clients:
  1. `duration_minutes` is preserved from the stored node.
  2. `duration_hours` is NOT present on the returned node.

Bug history: the service previously emitted `"duration_hours": n.get("duration_hours")`.
`Node` has `duration_minutes`, not `duration_hours`, so the field was always
None. `build_agent_trip_context` then ran `enrich_dag_times` on the stripped
dict and saw no user-set duration, silently breaking drive-cap propagation
and overnight-hold detection for every trip viewed via MCP.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from mcpserver.src.services.trip_service import TripService


def _make_service(
    nodes: list[dict],
    edges: list[dict] | None = None,
    trip_doc: dict | None = None,
    plan_doc: dict | None = None,
    actions_by_node: dict[str, list[dict]] | None = None,
) -> TripService:
    trip_doc = trip_doc or {
        "id": "t_1",
        "name": "Italy 2026",
        "active_plan_id": "p_1",
        "participants": {"u1": {"role": "admin", "display_name": "A"}},
        "settings": {},
    }
    plan_doc = plan_doc or {"id": "p_1", "name": "Main Route", "status": "active"}
    actions_by_node = actions_by_node or {}

    trip_repo = MagicMock()
    plan_repo = MagicMock()
    node_repo = MagicMock()
    edge_repo = MagicMock()
    action_repo = MagicMock()
    location_repo = MagicMock()
    user_repo = MagicMock()

    trip_repo.get_or_raise = AsyncMock(return_value=trip_doc)
    plan_repo.get_or_raise = AsyncMock(return_value=plan_doc)
    node_repo.list_by_plan = AsyncMock(return_value=nodes)
    edge_repo.list_by_plan = AsyncMock(return_value=edges or [])
    action_repo.list_by_node = AsyncMock(
        side_effect=lambda trip_id, plan_id, node_id: actions_by_node.get(node_id, [])
    )
    location_repo.get_all_locations = AsyncMock(return_value=[])

    return TripService(
        trip_repo=trip_repo,
        plan_repo=plan_repo,
        node_repo=node_repo,
        edge_repo=edge_repo,
        action_repo=action_repo,
        location_repo=location_repo,
        user_repo=user_repo,
    )


class TestDurationFieldPreservation:
    @pytest.mark.asyncio
    async def test_duration_minutes_preserved(self):
        svc = _make_service(nodes=[{
            "id": "n_1",
            "name": "Florence",
            "type": "city",
            "lat_lng": {"lat": 43.77, "lng": 11.25},
            "duration_minutes": 120,
        }])

        result = await svc.get_trip_context("t_1", "u1")

        enriched = result["trip"]["plan"]["nodes"][0]
        assert enriched["duration_minutes"] == 120

    @pytest.mark.asyncio
    async def test_duration_hours_key_not_emitted(self):
        # The bug put `duration_hours` on the output dict (always None).
        # Guarding against the exact key name — if someone renames the field
        # back, this test fails immediately.
        svc = _make_service(nodes=[{
            "id": "n_1",
            "name": "Florence",
            "type": "city",
            "lat_lng": {"lat": 43.77, "lng": 11.25},
            "duration_minutes": 120,
        }])

        result = await svc.get_trip_context("t_1", "u1")

        enriched = result["trip"]["plan"]["nodes"][0]
        assert "duration_hours" not in enriched, (
            "Node dict must expose `duration_minutes`, not `duration_hours`. "
            "`enrich_dag_times` reads `duration_minutes` — emitting the wrong "
            "key silently breaks drive-cap and overnight-hold propagation."
        )

    @pytest.mark.asyncio
    async def test_missing_duration_is_none_not_missing(self):
        # Nodes without a stored duration should still have the key present
        # as None so downstream consumers don't need a `hasattr` check.
        svc = _make_service(nodes=[{
            "id": "n_1",
            "name": "Florence",
            "type": "city",
            "lat_lng": {"lat": 43.77, "lng": 11.25},
        }])

        result = await svc.get_trip_context("t_1", "u1")

        enriched = result["trip"]["plan"]["nodes"][0]
        assert enriched["duration_minutes"] is None
