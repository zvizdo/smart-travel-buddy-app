"""Contract test for the ``find_places`` MCP tool.

Pins the structured-JSON return shape (issue #2 from MCP integration test).
Before this fix the tool returned a markdown ``str``, forcing agents to regex
``place_id`` out of prose before calling ``add_action(type='place')``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_find_places_returns_structured_dict():
    # Stub PlacesService.search_text — the service-layer shape is already
    # a list[dict]; the tool just needs to wrap it.
    fake_places = [
        {
            "name": "Trattoria XYZ",
            "place_id": "ChIJ_fake_1",
            "lat": 35.6812,
            "lng": 139.7671,
            "rating": 4.5,
            "types": ["restaurant", "italian_restaurant"],
            "address": "123 Example St, Tokyo",
        },
        {
            "name": "Osteria Foo",
            "place_id": "ChIJ_fake_2",
            "lat": 35.6820,
            "lng": 139.7680,
            "rating": 4.2,
            "types": ["restaurant"],
            "address": "45 Example Ave, Tokyo",
        },
    ]

    app = MagicMock()
    app.places_service = MagicMock()
    app.places_service.search_text = AsyncMock(return_value=fake_places)

    ctx = MagicMock()
    ctx.lifespan_context = app

    # ``resolve_authenticated`` reaches into fastmcp's auth context; bypass it
    # and the AppContext wiring by patching at the tool module's import site.
    with patch(
        "mcpserver.src.tools.places.resolve_authenticated",
        new=AsyncMock(return_value="u1"),
    ):
        from mcpserver.src.tools.places import find_places

        # The @mcp.tool() + @tool_error_guard decorators wrap the function but
        # the actual callable is still invocable with the same signature.
        result = await find_places(
            query="Italian restaurant",
            lat=35.6812,
            lng=139.7671,
            ctx=ctx,
            radius_km=2,
        )

    assert isinstance(result, dict), (
        "find_places must return a dict (issue #2). "
        "Previously returned markdown str, forcing agents to regex place_id."
    )
    assert result["query"] == "Italian restaurant"
    assert result["center"] == {"lat": 35.6812, "lng": 139.7671}
    assert result["places"] == fake_places
    # Critical: place_id is a direct top-level field on each record so agents
    # can pass it straight to add_action(type='place', place_id=...).
    assert result["places"][0]["place_id"] == "ChIJ_fake_1"
    assert result["places"][0]["lat"] == 35.6812


@pytest.mark.asyncio
async def test_find_places_empty_results():
    app = MagicMock()
    app.places_service = MagicMock()
    app.places_service.search_text = AsyncMock(return_value=[])
    ctx = MagicMock()
    ctx.lifespan_context = app

    with patch(
        "mcpserver.src.tools.places.resolve_authenticated",
        new=AsyncMock(return_value="u1"),
    ):
        from mcpserver.src.tools.places import find_places

        result = await find_places(
            query="nonexistent",
            lat=0.0,
            lng=0.0,
            ctx=ctx,
        )

    assert result["places"] == []
    assert result["query"] == "nonexistent"
