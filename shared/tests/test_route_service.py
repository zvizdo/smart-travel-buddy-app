"""Tests for RouteService: departureTime and languageCode handling."""

import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from shared.services.route_service import RouteService


def _mock_http_client(status_code: int = 200, body: dict | None = None):
    """Create a mock httpx.AsyncClient that captures the request."""
    if body is None:
        body = {
            "routes": [{
                "polyline": {"encodedPolyline": "abc123"},
                "duration": "3600s",
                "distanceMeters": 50000,
                "warnings": [],
                "legs": [],
            }]
        }
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = body
    response.text = json.dumps(body)

    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(return_value=response)
    return client


@pytest.mark.asyncio
async def test_departure_time_included():
    client = _mock_http_client()
    svc = RouteService(client)

    await svc.get_route_data(
        {"lat": 48.8, "lng": 2.3},
        {"lat": 45.7, "lng": 4.8},
        "drive",
        departure_time="2027-01-15T08:00:00Z",
    )

    call_kwargs = client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["departureTime"] == "2027-01-15T08:00:00Z"
    assert body["routingPreference"] == "TRAFFIC_AWARE_OPTIMAL"


@pytest.mark.asyncio
async def test_language_code_always_english():
    client = _mock_http_client()
    svc = RouteService(client)

    await svc.get_route_data(
        {"lat": 48.8, "lng": 2.3},
        {"lat": 45.7, "lng": 4.8},
        "drive",
    )

    call_kwargs = client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["languageCode"] == "en"


@pytest.mark.asyncio
async def test_none_departure_falls_back_traffic_unaware():
    client = _mock_http_client()
    svc = RouteService(client)

    await svc.get_route_data(
        {"lat": 48.8, "lng": 2.3},
        {"lat": 45.7, "lng": 4.8},
        "drive",
        departure_time=None,
    )

    call_kwargs = client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert "departureTime" not in body
    assert body["routingPreference"] == "TRAFFIC_UNAWARE"


@pytest.mark.asyncio
async def test_walk_mode_omits_routing_preference():
    """WALK mode must NOT send routingPreference — it's only valid for
    DRIVE/TWO_WHEELER. Sending it can cause empty route responses."""
    client = _mock_http_client()
    svc = RouteService(client)

    await svc.get_route_data(
        {"lat": 48.8, "lng": 2.3},
        {"lat": 45.7, "lng": 4.8},
        "walk",
        departure_time="2027-01-15T08:00:00Z",
    )

    call_kwargs = client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert "departureTime" not in body
    assert "routingPreference" not in body


@pytest.mark.asyncio
async def test_transit_mode_gets_departure_time():
    client = _mock_http_client()
    svc = RouteService(client)

    await svc.get_route_data(
        {"lat": 48.8, "lng": 2.3},
        {"lat": 45.7, "lng": 4.8},
        "transit",
        departure_time="2027-01-15T08:00:00Z",
    )

    call_kwargs = client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["departureTime"] == "2027-01-15T08:00:00Z"
    assert body["routingPreference"] == "TRAFFIC_AWARE_OPTIMAL"


# --- Fallback waypoint tests ---


@pytest.mark.asyncio
async def test_place_id_fallback_when_coordinates_fail():
    """When coordinate-based routing returns no routes, the retry should
    use placeId waypoints (preferred over address/name)."""
    # First call returns no routes; second succeeds
    no_routes_resp = MagicMock()
    no_routes_resp.status_code = 200
    no_routes_resp.json.return_value = {"routes": []}

    ok_resp = MagicMock()
    ok_resp.status_code = 200
    ok_resp.json.return_value = {
        "routes": [{
            "polyline": {"encodedPolyline": "retry_poly"},
            "duration": "1800s",
            "distanceMeters": 25000,
            "warnings": [],
            "legs": [],
        }]
    }

    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(side_effect=[no_routes_resp, ok_resp])
    svc = RouteService(client)

    result = await svc.get_route_data(
        {"lat": 45.0, "lng": -109.5},
        {"lat": 45.1, "lng": -109.9},
        "drive",
        from_place_id="ChIJfrom123",
        to_place_id="ChIJto456",
        from_name="Beartooth Highway",
        to_name="Cooke City",
    )

    assert result is not None
    assert result.polyline == "retry_poly"

    # Verify the first call used placeId
    first_call = client.post.call_args_list[0]
    first_body = first_call.kwargs.get("json") or first_call[1].get("json")
    assert first_body["origin"]["placeId"] == "ChIJfrom123"
    assert first_body["destination"]["placeId"] == "ChIJto456"


@pytest.mark.asyncio
async def test_address_fallback_when_no_place_id():
    """When coordinate routing fails and no placeId is available,
    fall back to address (node name)."""
    no_routes_resp = MagicMock()
    no_routes_resp.status_code = 200
    no_routes_resp.json.return_value = {"routes": []}

    ok_resp = MagicMock()
    ok_resp.status_code = 200
    ok_resp.json.return_value = {
        "routes": [{
            "polyline": {"encodedPolyline": "addr_poly"},
            "duration": "900s",
            "distanceMeters": 10000,
            "warnings": [],
            "legs": [],
        }]
    }

    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(side_effect=[no_routes_resp, ok_resp])
    svc = RouteService(client)

    result = await svc.get_route_data(
        {"lat": 45.0, "lng": -109.5},
        {"lat": 45.1, "lng": -109.9},
        "drive",
        from_name="Billings, MT",
        to_name="Cooke City, MT",
    )

    assert result is not None
    assert result.polyline == "addr_poly"

    retry_call = client.post.call_args_list[1]
    retry_body = retry_call.kwargs.get("json") or retry_call[1].get("json")
    assert retry_body["origin"] == {"address": "Billings, MT"}
    assert retry_body["destination"] == {"address": "Cooke City, MT"}


@pytest.mark.asyncio
async def test_mixed_fallback_place_id_and_address():
    """When one endpoint has a placeId and the other only has a name,
    use placeId for the one and address for the other."""
    no_routes_resp = MagicMock()
    no_routes_resp.status_code = 200
    no_routes_resp.json.return_value = {"routes": []}

    ok_resp = MagicMock()
    ok_resp.status_code = 200
    ok_resp.json.return_value = {
        "routes": [{
            "polyline": {"encodedPolyline": "mixed_poly"},
            "duration": "1200s",
            "distanceMeters": 15000,
            "warnings": [],
            "legs": [],
        }]
    }

    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(side_effect=[no_routes_resp, ok_resp])
    svc = RouteService(client)

    result = await svc.get_route_data(
        {"lat": 45.0, "lng": -109.5},
        {"lat": 45.1, "lng": -109.9},
        "drive",
        from_place_id="ChIJfrom123",
        to_name="Cooke City, MT",
    )

    assert result is not None

    # Mixed fallback: Place ID for from, Coordinate for to, then Address for to
    first_call = client.post.call_args_list[0]
    first_body = first_call.kwargs.get("json") or first_call[1].get("json")
    assert first_body["origin"]["placeId"] == "ChIJfrom123"
    assert "address" not in first_body["destination"]


@pytest.mark.asyncio
async def test_no_fallback_when_no_identifiers():
    """When coordinate routing fails and there's no placeId or name,
    return None without retrying."""
    no_routes_resp = MagicMock()
    no_routes_resp.status_code = 200
    no_routes_resp.json.return_value = {"routes": []}

    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(return_value=no_routes_resp)
    svc = RouteService(client)

    result = await svc.get_route_data(
        {"lat": 45.0, "lng": -109.5},
        {"lat": 45.1, "lng": -109.9},
        "drive",
    )

    assert result is None
    assert client.post.call_count == 1  # Only the coordinate attempt
