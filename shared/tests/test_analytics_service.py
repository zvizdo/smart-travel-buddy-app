"""Tests for AnalyticsService: GA4 Measurement Protocol client."""

from unittest.mock import AsyncMock

import httpx
import pytest

from shared.services.analytics_service import AnalyticsService


def _mock_http_client() -> AsyncMock:
    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_noop_when_measurement_id_missing():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id=None, api_secret="secret")

    await svc.track_event("user_123", "mcp_tool_called", {"tool_name": "add_node"})

    assert not svc.enabled
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_noop_when_api_secret_missing():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret=None)

    await svc.track_event("user_123", "mcp_tool_called")

    assert not svc.enabled
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_noop_when_both_missing():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="", api_secret="")

    await svc.track_event("user_123", "mcp_tool_called")

    assert not svc.enabled
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_noop_when_analytics_disabled_for_user():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    await svc.track_event(
        "user_123", "mcp_tool_called", analytics_enabled=False,
    )

    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_noop_when_user_id_empty():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    await svc.track_event("", "mcp_tool_called")

    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_happy_path_posts_correct_payload():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    await svc.track_event(
        "user_123",
        "mcp_tool_called",
        {"tool_name": "add_node", "trip_id": "t_xyz", "result": "success"},
    )

    assert client.post.call_count == 1
    call = client.post.call_args
    assert call.args[0] == "https://www.google-analytics.com/mp/collect"
    assert call.kwargs["params"] == {
        "measurement_id": "G-ABC",
        "api_secret": "secret",
    }
    assert call.kwargs["timeout"] == 5.0
    payload = call.kwargs["json"]
    assert payload["client_id"] == "user_123"
    assert payload["user_id"] == "user_123"
    assert len(payload["events"]) == 1
    event = payload["events"][0]
    assert event["name"] == "mcp_tool_called"
    assert event["params"] == {
        "tool_name": "add_node",
        "trip_id": "t_xyz",
        "result": "success",
    }


@pytest.mark.asyncio
async def test_drops_none_params():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    await svc.track_event(
        "user_123",
        "mcp_tool_called",
        {"tool_name": "add_node", "trip_id": None, "plan_id": None},
    )

    event = client.post.call_args.kwargs["json"]["events"][0]
    assert event["params"] == {"tool_name": "add_node"}
    assert "trip_id" not in event["params"]


@pytest.mark.asyncio
async def test_never_raises_on_http_error():
    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(side_effect=httpx.TimeoutException("timed out"))
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    # Should NOT raise — fire-and-forget
    await svc.track_event("user_123", "mcp_tool_called", {"tool_name": "x"})

    client.post.assert_called_once()


@pytest.mark.asyncio
async def test_never_raises_on_unexpected_error():
    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(side_effect=RuntimeError("boom"))
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    await svc.track_event("user_123", "mcp_tool_called")

    client.post.assert_called_once()


@pytest.mark.asyncio
async def test_empty_params_works():
    client = _mock_http_client()
    svc = AnalyticsService(client, measurement_id="G-ABC", api_secret="secret")

    await svc.track_event("user_123", "mcp_tool_called")

    event = client.post.call_args.kwargs["json"]["events"][0]
    assert event["name"] == "mcp_tool_called"
    assert event["params"] == {}
