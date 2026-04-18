"""Contract test: lock the unified response shapes across MCP tools.

Every mutation tool must follow one of four shapes so agents can parse
responses generically:

- Creates/updates: ``{<resource>: {id, ...}}`` (optionally plus metadata)
- Deletes:         ``{deleted: true, <resource>_id: "..."}`` (optionally
                   plus side-effect counts)
- Lists:           ``{<resources>: [...]}``
- Searches:        ``{<field>: [structured list]}``

These tests build mock services that return shapes the real backend
produces, then invoke each tool directly and assert on the envelope.
They do NOT hit Firestore, fastmcp's dispatcher, or a network; they
isolate the tool-wrapper layer where response-shape transformations live.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _ctx(app: MagicMock) -> MagicMock:
    c = MagicMock()
    c.lifespan_context = app
    return c


def _auth_patch(*paths: str):
    """Patch the auth gate at every caller so none of them touches fastmcp."""

    class _Stack:
        def __init__(self, paths):
            self._patches = [
                patch(p, new=AsyncMock(return_value=("u1", "p_1", "trip-name")))
                for p in paths
            ]

        def __enter__(self):
            for p in self._patches:
                p.__enter__()
            return self

        def __exit__(self, *a):
            for p in reversed(self._patches):
                p.__exit__(*a)

    return _Stack(paths)


# =================  delete_* : {deleted: true, <resource>_id, ...}  =============


@pytest.mark.asyncio
async def test_delete_trip_returns_standard_shape():
    app = MagicMock()
    app.trip_service.delete_trip = AsyncMock(return_value={"trip_id": "t_1", "deleted": True})

    from mcpserver.src.tools.trips import delete_trip

    with patch(
        "mcpserver.src.tools.trips.resolve_trip_admin",
        new=AsyncMock(return_value=("u1", "t_1")),
    ):
        r = await delete_trip(trip_id="t_1", ctx=_ctx(app))

    assert r == {"deleted": True, "trip_id": "t_1"}


@pytest.mark.asyncio
async def test_delete_plan_returns_standard_shape():
    app = MagicMock()
    app.plan_service.delete_plan = AsyncMock(return_value=None)

    from mcpserver.src.tools.plans import delete_plan

    with patch(
        "mcpserver.src.tools.plans.resolve_trip_plan",
        new=AsyncMock(return_value=("u1", "p_1", "trip")),
    ):
        r = await delete_plan(trip_id="t_1", plan_id="p_2", ctx=_ctx(app))

    assert r == {"deleted": True, "plan_id": "p_2"}


@pytest.mark.asyncio
async def test_delete_node_returns_standard_shape():
    app = MagicMock()
    app.dag_service.delete_node = AsyncMock(return_value={
        "deleted_node_id": "n_1",
        "deleted_edge_count": 2,
        "reconnected_edge": None,
        "reconnected_edges": [],
        "participant_ids_cleaned": 3,
    })

    from mcpserver.src.tools.nodes import delete_node

    with patch(
        "mcpserver.src.tools.nodes.resolve_trip_plan",
        new=AsyncMock(return_value=("u1", "p_1", "trip")),
    ):
        r = await delete_node(trip_id="t_1", node_id="n_1", ctx=_ctx(app))

    assert r["deleted"] is True
    assert r["node_id"] == "n_1"
    assert r["deleted_edge_count"] == 2
    assert r["reconnected_edges"] == []
    assert r["participant_ids_cleaned"] == 3
    # Drop the legacy singular `reconnected_edge` field (redundant with the list)
    assert "reconnected_edge" not in r


@pytest.mark.asyncio
async def test_delete_edge_returns_standard_shape():
    app = MagicMock()
    app.dag_service.delete_edge_by_id = AsyncMock(return_value={"deleted_edge_id": "e_1"})

    from mcpserver.src.tools.edges import delete_edge

    with patch(
        "mcpserver.src.tools.edges.resolve_trip_plan",
        new=AsyncMock(return_value=("u1", "p_1", "trip")),
    ):
        r = await delete_edge(trip_id="t_1", edge_id="e_1", ctx=_ctx(app))

    assert r == {"deleted": True, "edge_id": "e_1"}


@pytest.mark.asyncio
async def test_delete_action_returns_standard_shape():
    app = MagicMock()
    app.trip_service.delete_action = AsyncMock(return_value={
        "action_id": "a_1", "type": "note", "node_id": "n_1",
    })

    from mcpserver.src.tools.actions import delete_action

    with patch(
        "mcpserver.src.tools.actions.resolve_trip_participant",
        new=AsyncMock(return_value=("u1", "p_1", "trip")),
    ):
        r = await delete_action(
            trip_id="t_1", node_id="n_1", action_id="a_1", ctx=_ctx(app),
        )

    assert r["deleted"] is True
    assert r["action_id"] == "a_1"
    assert r["node_id"] == "n_1"


# =================  create/update : {<resource>: {id, ...}}  ===================


@pytest.mark.asyncio
async def test_create_trip_returns_nested_envelope():
    app = MagicMock()
    app.trip_service.create_trip = AsyncMock(return_value={
        "id": "t_1",
        "name": "Italy",
        "active_plan_id": "p_1",
        "plan": {"id": "p_1", "name": "Main Route", "status": "active"},
    })

    from mcpserver.src.tools.trips import create_trip

    with patch(
        "mcpserver.src.tools.trips.resolve_authenticated",
        new=AsyncMock(return_value="u1"),
    ):
        r = await create_trip(name="Italy", ctx=_ctx(app))

    assert set(r.keys()) == {"trip", "plan"}
    assert r["trip"]["id"] == "t_1"
    assert r["trip"]["name"] == "Italy"
    # `plan` must be a sibling, not nested inside `trip`
    assert "plan" not in r["trip"]
    assert r["plan"]["id"] == "p_1"


@pytest.mark.asyncio
async def test_add_edge_wraps_in_edge_envelope():
    app = MagicMock()
    app.dag_service.create_standalone_edge = AsyncMock(return_value={
        "id": "e_1",
        "from_node_id": "n_1",
        "to_node_id": "n_2",
        "travel_mode": "drive",
        "travel_time_hours": 1.5,
        "distance_km": 100.0,
        "route_polyline": "xyz",
        "notes": None,
    })

    from mcpserver.src.tools.edges import add_edge

    with patch(
        "mcpserver.src.tools.edges.resolve_trip_plan",
        new=AsyncMock(return_value=("u1", "p_1", "trip")),
    ):
        r = await add_edge(
            trip_id="t_1", from_node_id="n_1", to_node_id="n_2", ctx=_ctx(app),
        )

    assert "edge" in r
    assert r["edge"]["id"] == "e_1"
    assert r["edge"]["from_node_id"] == "n_1"


@pytest.mark.asyncio
async def test_add_action_wraps_in_action_envelope_with_id():
    app = MagicMock()
    app.trip_service.add_action = AsyncMock(return_value={
        "action_id": "a_1",
        "type": "note",
        "content": "hi",
        "node_id": "n_1",
        "created_at": "2026-01-01T00:00:00Z",
    })

    from mcpserver.src.tools.actions import add_action

    with patch(
        "mcpserver.src.tools.actions.resolve_trip_participant",
        new=AsyncMock(return_value=("u1", "p_1", "trip")),
    ):
        r = await add_action(
            trip_id="t_1", node_id="n_1", type="note",
            content="hi", ctx=_ctx(app),
        )

    assert "action" in r
    # Renamed action_id → id so add_node / add_edge / add_action all expose
    # their primary identifier as `<resource>.id`.
    assert r["action"]["id"] == "a_1"
    assert "action_id" not in r["action"]
    assert r["action"]["type"] == "note"


# =================  misc  ==================================================


@pytest.mark.asyncio
async def test_promote_plan_renames_previous_active():
    app = MagicMock()
    app.plan_service.promote_plan = AsyncMock(return_value={
        "plan_id": "p_2", "status": "active", "previous_active": "p_1",
    })

    from mcpserver.src.tools.plans import promote_plan

    with patch(
        "mcpserver.src.tools.plans.resolve_trip_admin",
        new=AsyncMock(return_value=("u1", "t_1")),
    ):
        r = await promote_plan(trip_id="t_1", plan_id="p_2", ctx=_ctx(app))

    assert r["plan_id"] == "p_2"
    assert r["status"] == "active"
    assert r["previous_active_plan_id"] == "p_1"
    assert "previous_active" not in r


@pytest.mark.asyncio
async def test_update_trip_settings_wraps_settings():
    app = MagicMock()
    app.trip_service.update_trip_settings = AsyncMock(return_value={
        "datetime_format": "24h", "date_format": "eu",
        "distance_unit": "km",
        "no_drive_window": None, "max_drive_hours_per_day": 6.0,
    })

    from mcpserver.src.tools.trips import update_trip_settings

    with patch(
        "mcpserver.src.tools.trips.resolve_trip_admin",
        new=AsyncMock(return_value=("u1", "t_1")),
    ):
        r = await update_trip_settings(
            trip_id="t_1", ctx=_ctx(app), max_drive_hours_per_day=6.0,
        )

    assert r["trip_id"] == "t_1"
    assert r["settings"]["max_drive_hours_per_day"] == 6.0
