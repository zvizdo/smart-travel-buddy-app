"""Tests for RouteService: departureTime, languageCode, and fetch_and_patch_route_data."""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from shared.services.route_service import RouteData, RouteService


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


# --- Flight route data tests ---


@pytest.mark.asyncio
async def test_flight_returns_none_without_flight_service():
    """Flight mode with no flight_service should return None."""
    client = _mock_http_client()
    svc = RouteService(client)  # no flight_service

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
    )
    assert result is None


@pytest.mark.asyncio
async def test_flight_returns_route_data_on_success(monkeypatch):
    """Flight mode averages the modal-stops bucket and emits a sentinel note."""
    from unittest.mock import AsyncMock as AM
    from shared.services.flight_service import FlightOption, FlightSearchResult

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    # 15 nonstop results with durations centered on 420 min (7h).
    durations = [400, 410, 420, 430, 440] * 3  # avg = 420
    mock_fs = MagicMock()
    mock_fs.search = AM(return_value=FlightSearchResult(
        origin="JFK", destination="LHR", date="2026-06-15",
        return_date=None,
        outbound=[
            FlightOption(price=500, currency="USD",
                         total_duration_minutes=d, stops=0)
            for d in durations
        ],
    ))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
        departure_time="2026-06-15T10:00:00Z",
    )

    assert result is not None
    assert result.travel_time_hours == 7.0  # 420 min avg
    assert result.polyline is None
    assert result.distance_km is not None and result.distance_km > 5000

    # Verify the estimate note carries the stop-class label and bucket size.
    # Sentinel wrapping happens at the edge-merge step, not inside RouteData.
    assert result.notes is not None
    assert "nonstop" in result.notes
    assert "15" in result.notes  # bucket size

    # And max_results was bumped to 15
    assert mock_fs.search.call_args.kwargs.get("max_results") == 15


@pytest.mark.asyncio
async def test_flight_picks_lowest_stops_bucket_even_when_rare(monkeypatch):
    """Even a minority of nonstop flights wins over many multi-stop flights."""
    from shared.services.flight_service import FlightOption, FlightSearchResult

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    # 10 one-stops @ 8h (480 min), 5 nonstops @ 3h (180 min)
    # — nonstops are the MINORITY but still win because most travelers
    # pick nonstop whenever it exists.
    outbound = (
        [FlightOption(price=500, currency="USD",
                      total_duration_minutes=480, stops=1)] * 10
        + [FlightOption(price=500, currency="USD",
                        total_duration_minutes=180, stops=0)] * 5
    )
    mock_fs = MagicMock()
    mock_fs.search = AsyncMock(return_value=FlightSearchResult(
        origin="JFK", destination="LHR", date="2026-06-15",
        return_date=None, outbound=outbound,
    ))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
    )

    assert result is not None
    assert result.travel_time_hours == 3.0  # nonstop bucket avg
    assert result.notes is not None
    assert "nonstop" in result.notes
    assert "5" in result.notes  # bucket size


@pytest.mark.asyncio
async def test_flight_falls_back_to_next_lowest_when_no_nonstop(monkeypatch):
    """With no nonstops in the results, use the 1-stop bucket."""
    from shared.services.flight_service import FlightOption, FlightSearchResult

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    # 10 one-stops @ 7h, 5 two-stops @ 12h — no nonstops in the results
    outbound = (
        [FlightOption(price=500, currency="USD",
                      total_duration_minutes=420, stops=1)] * 10
        + [FlightOption(price=500, currency="USD",
                        total_duration_minutes=720, stops=2)] * 5
    )
    mock_fs = MagicMock()
    mock_fs.search = AsyncMock(return_value=FlightSearchResult(
        origin="JFK", destination="LHR", date="2026-06-15",
        return_date=None, outbound=outbound,
    ))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
    )

    assert result is not None
    assert result.travel_time_hours == 7.0  # 1-stop bucket avg
    assert result.notes is not None
    assert "1-stop" in result.notes


@pytest.mark.asyncio
async def test_flight_single_result_is_own_bucket(monkeypatch):
    """A single result becomes the modal bucket; no div-by-zero."""
    from shared.services.flight_service import FlightOption, FlightSearchResult

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    mock_fs = MagicMock()
    mock_fs.search = AsyncMock(return_value=FlightSearchResult(
        origin="JFK", destination="LHR", date="2026-06-15",
        return_date=None,
        outbound=[FlightOption(
            price=500, currency="USD",
            total_duration_minutes=210, stops=0,
        )],
    ))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
    )

    assert result is not None
    assert result.travel_time_hours == 3.5
    assert "1 nonstop" in (result.notes or "")


@pytest.mark.asyncio
async def test_flight_empty_results_returns_none(monkeypatch):
    """Empty outbound list → None, no crash."""
    from shared.services.flight_service import FlightSearchResult

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    mock_fs = MagicMock()
    mock_fs.search = AsyncMock(return_value=FlightSearchResult(
        origin="JFK", destination="LHR", date="2026-06-15",
        return_date=None, outbound=[],
    ))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
    )
    assert result is None


@pytest.mark.asyncio
async def test_flight_returns_none_on_airport_failure(monkeypatch):
    """If airport resolution fails, return None gracefully."""
    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return None

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    mock_fs = MagicMock()
    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 0.0, "lng": 0.0},
        {"lat": 1.0, "lng": 1.0},
        "flight",
    )
    assert result is None
    # Flight service should NOT have been called
    mock_fs.search.assert_not_called()


@pytest.mark.asyncio
async def test_flight_returns_none_on_search_failure(monkeypatch):
    """If flight search raises, return None gracefully."""
    from shared.services.flight_service import FlightSearchError

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    mock_fs = MagicMock()
    mock_fs.search = AsyncMock(side_effect=FlightSearchError("No flights"))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
    )
    assert result is None


@pytest.mark.asyncio
async def test_flight_uses_synthetic_date_when_none(monkeypatch):
    """When departure_time is None, should use today + 14 days."""
    from datetime import date, timedelta
    from shared.services.flight_service import FlightOption, FlightSearchResult

    async def mock_resolve(lat, lng, http, creds, auth_req=None):
        return "JFK" if abs(lat - 40.6) < 1 else "LHR"

    monkeypatch.setattr(
        "shared.services.route_service.resolve_nearest_airport", mock_resolve
    )

    expected_date = (date.today() + timedelta(days=14)).isoformat()
    mock_fs = MagicMock()
    mock_fs.search = AsyncMock(return_value=FlightSearchResult(
        origin="JFK", destination="LHR", date=expected_date,
        return_date=None,
        outbound=[FlightOption(
            price=500, currency="USD",
            total_duration_minutes=420,
            stops=0,
        )],
    ))

    client = _mock_http_client()
    svc = RouteService(client, flight_service=mock_fs)
    svc._credentials = MagicMock()
    svc._credentials.valid = True

    result = await svc.get_route_data(
        {"lat": 40.6, "lng": -73.8},
        {"lat": 51.5, "lng": -0.5},
        "flight",
        departure_time=None,  # No date
    )

    assert result is not None
    # Verify the search was called with the synthetic date
    mock_fs.search.assert_called_once()
    call_kwargs = mock_fs.search.call_args
    assert call_kwargs.kwargs.get("date") == expected_date


@pytest.mark.asyncio
async def test_ferry_still_returns_none():
    """Ferry mode should still return None (unchanged behavior)."""
    client = _mock_http_client()
    svc = RouteService(client)

    result = await svc.get_route_data(
        {"lat": 48.8, "lng": 2.3},
        {"lat": 51.5, "lng": -0.1},
        "ferry",
    )
    assert result is None


# --- fetch_and_patch_route_data tests ---


@pytest.mark.asyncio
async def test_fetch_and_patch_writes_route_data_on_success():
    """On success, writes route fields and route_updated_at to the edge."""
    client = _mock_http_client()
    svc = RouteService(client)
    edge_repo = AsyncMock()

    await svc.fetch_and_patch_route_data(
        trip_id="t_1", plan_id="p_1", edge_id="e_1",
        from_latlng={"lat": 48.8, "lng": 2.3},
        to_latlng={"lat": 45.7, "lng": 4.8},
        travel_mode="drive",
        edge_repo=edge_repo,
    )

    edge_repo.update_edge.assert_called_once()
    call_args = edge_repo.update_edge.call_args
    updates = call_args[0][3] if len(call_args[0]) > 3 else call_args[1].get("updates", call_args[0][3])
    assert "route_updated_at" in updates
    assert updates.get("route_polyline") == "abc123"
    assert updates.get("travel_time_hours") == 1.0
    assert updates.get("distance_km") == 50.0


@pytest.mark.asyncio
async def test_fetch_and_patch_signals_on_failure():
    """When route resolution returns None, still writes route_updated_at
    and clears stale polyline so the frontend can detect completion."""
    # API returns no routes
    no_routes_resp = MagicMock()
    no_routes_resp.status_code = 200
    no_routes_resp.json.return_value = {"routes": []}
    client = AsyncMock(spec=httpx.AsyncClient)
    client.post = AsyncMock(return_value=no_routes_resp)

    svc = RouteService(client)
    edge_repo = AsyncMock()

    await svc.fetch_and_patch_route_data(
        trip_id="t_1", plan_id="p_1", edge_id="e_1",
        from_latlng={"lat": 48.8, "lng": 2.3},
        to_latlng={"lat": 45.7, "lng": 4.8},
        travel_mode="drive",
        edge_repo=edge_repo,
    )

    edge_repo.update_edge.assert_called_once()
    updates = edge_repo.update_edge.call_args[0][3]
    assert "route_updated_at" in updates
    assert updates["route_polyline"] is None


@pytest.mark.asyncio
async def test_fetch_and_patch_signals_on_exception():
    """When get_route_data raises, best-effort write still signals completion."""
    client = AsyncMock(spec=httpx.AsyncClient)
    svc = RouteService(client)
    edge_repo = AsyncMock()

    # Force get_route_data to raise by making _call_routes_api fail
    with patch.object(svc, "get_route_data", side_effect=RuntimeError("boom")):
        await svc.fetch_and_patch_route_data(
            trip_id="t_1", plan_id="p_1", edge_id="e_1",
            from_latlng={"lat": 48.8, "lng": 2.3},
            to_latlng={"lat": 45.7, "lng": 4.8},
            travel_mode="drive",
            edge_repo=edge_repo,
        )

    # Best-effort write should have fired
    edge_repo.update_edge.assert_called_once()
    updates = edge_repo.update_edge.call_args[0][3]
    assert "route_updated_at" in updates
    assert updates["route_polyline"] is None


# --- Flight-estimate note merging ---


def test_merge_flight_estimate_on_empty_notes():
    """With no existing notes, returns the 'Flight estimate: ...' line alone."""
    from shared.services.route_service import _merge_flight_estimate_note

    merged = _merge_flight_estimate_note(None, "Avg 3h across 10 nonstop options (2026-06-15)")
    assert merged == "Flight estimate: Avg 3h across 10 nonstop options (2026-06-15)"


def test_merge_flight_estimate_preserves_other_notes():
    """Existing non-flight notes (road advisories) survive; estimate on its own line."""
    from shared.services.route_service import _merge_flight_estimate_note

    existing = "Parts of this road may be closed"
    merged = _merge_flight_estimate_note(existing, "Avg 3h across 10 nonstop options (2026-06-15)")
    assert merged is not None
    assert "Parts of this road may be closed" in merged
    assert "Flight estimate: Avg 3h across 10 nonstop options (2026-06-15)" in merged
    # Estimate is on a new line, not joined inline.
    assert "\n" in merged
    # Existing text comes first, estimate line last.
    assert merged.index("Parts of this road") < merged.index("Flight estimate:")


def test_merge_flight_estimate_replaces_stale_line():
    """A prior 'Flight estimate: ...' line is stripped and replaced."""
    from shared.services.route_service import _merge_flight_estimate_note

    existing = (
        "Parts of this road may be closed\n"
        "Flight estimate: Avg 8h 30m across 1 1-stop options (2026-01-01)"
    )
    merged = _merge_flight_estimate_note(
        existing, "Avg 3h across 10 nonstop options (2026-06-15)",
    )
    assert merged is not None
    # Old estimate is gone
    assert "8h 30m" not in merged
    assert "2026-01-01" not in merged
    # Other text survives
    assert "Parts of this road may be closed" in merged
    # New estimate present, exactly once
    assert merged.count("Flight estimate:") == 1
    assert "nonstop" in merged
    assert "2026-06-15" in merged


def test_merge_flight_estimate_migrates_legacy_sentinel():
    """Legacy [flight-estimate]...[/flight-estimate] blocks are stripped on read."""
    from shared.services.route_service import _merge_flight_estimate_note

    existing = (
        "[flight-estimate] Avg 8h 30m across 1 1-stop options (2026-01-01) [/flight-estimate] "
        "Parts of this road may be closed"
    )
    merged = _merge_flight_estimate_note(
        existing, "Avg 3h across 10 nonstop options (2026-06-15)",
    )
    assert merged is not None
    # Legacy sentinel fully gone
    assert "[flight-estimate]" not in merged
    assert "[/flight-estimate]" not in merged
    assert "8h 30m" not in merged
    # Other text survives
    assert "Parts of this road may be closed" in merged
    # New line-style estimate present exactly once
    assert merged.count("Flight estimate:") == 1


def test_merge_flight_estimate_strips_line_when_estimate_missing():
    """No new estimate → strip any stale 'Flight estimate:' line, keep other text."""
    from shared.services.route_service import _merge_flight_estimate_note

    existing = "Flight estimate: Avg 8h across 1 1-stop options (2026-01-01)\nManual note"
    merged = _merge_flight_estimate_note(existing, None)
    assert merged == "Manual note"


@pytest.mark.asyncio
async def test_fetch_and_patch_flight_merges_note_preserving_existing():
    """Flight refresh preserves existing non-flight notes while updating estimate."""
    from shared.services.route_service import RouteData

    svc = RouteService(AsyncMock(spec=httpx.AsyncClient))
    edge_repo = AsyncMock()
    edge_repo.get_or_raise = AsyncMock(return_value={
        "id": "e_1",
        "notes": "Parts of this road may be closed\nFlight estimate: Avg 8h 30m across 1 1-stop options (2026-01-01)",
    })

    with patch.object(
        svc, "get_route_data",
        return_value=RouteData(
            polyline=None, duration_seconds=180 * 60, distance_meters=4_000_000,
            warnings=["Avg 3h across 10 nonstop options (2026-06-15)"],
        ),
    ):
        await svc.fetch_and_patch_route_data(
            trip_id="t_1", plan_id="p_1", edge_id="e_1",
            from_latlng={"lat": 36.08, "lng": -115.15},
            to_latlng={"lat": 47.45, "lng": -122.31},
            travel_mode="flight", edge_repo=edge_repo,
        )

    updates = edge_repo.update_edge.call_args[0][3]
    assert "notes" in updates
    assert "Parts of this road may be closed" in updates["notes"]
    assert "nonstop" in updates["notes"]
    assert "8h 30m" not in updates["notes"]
    assert updates["notes"].count("Flight estimate:") == 1
    # Estimate rendered on its own line
    assert "\nFlight estimate:" in updates["notes"]


@pytest.mark.asyncio
async def test_fetch_and_patch_non_flight_does_not_touch_flight_sentinel():
    """Non-flight refresh must not invoke the merge helper (defensive)."""
    svc = RouteService(_mock_http_client())
    edge_repo = AsyncMock()

    await svc.fetch_and_patch_route_data(
        trip_id="t_1", plan_id="p_1", edge_id="e_1",
        from_latlng={"lat": 48.8, "lng": 2.3},
        to_latlng={"lat": 45.7, "lng": 4.8},
        travel_mode="drive", edge_repo=edge_repo,
    )

    # get_or_raise should NOT have been called — non-flight path skips the merge
    edge_repo.get_or_raise.assert_not_called()
