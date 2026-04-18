"""Tests for airport_resolver: IATA resolution via Places API + fli matching."""

import json
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from shared.tools.airport_resolver import (
    _match_iata,
    _normalize,
    _token_set_ratio,
    extract_flight_date,
    haversine_m,
    resolve_nearest_airport,
)


# ---- _normalize ----


def test_normalize_strips_punctuation():
    result = _normalize("John F. Kennedy International Airport")
    assert result == "john f kennedy international airport"


def test_normalize_handles_dashes_and_commas():
    result = _normalize("Charles de Gaulle - Roissy, Paris")
    assert "charles" in result
    assert "de" in result
    assert "gaulle" in result


def test_normalize_collapses_whitespace():
    result = _normalize("  multiple   spaces  here  ")
    assert result == "multiple spaces here"


# ---- _token_set_ratio ----


def test_token_set_ratio_identical():
    score = _token_set_ratio("heathrow airport", "heathrow airport")
    assert score == 1.0


def test_token_set_ratio_subset():
    # "heathrow airport" is a subset of "london heathrow airport"
    score = _token_set_ratio("heathrow airport", "london heathrow airport")
    assert score >= 0.80


def test_token_set_ratio_no_overlap():
    score = _token_set_ratio("random words", "completely different")
    assert score == 0.0


# ---- _match_iata ----


def test_match_jfk():
    assert _match_iata("John F. Kennedy International Airport") == "JFK"


def test_match_lhr():
    # Places may return "Heathrow Airport" while fli has "London Heathrow Airport"
    assert _match_iata("Heathrow Airport") == "LHR"


def test_match_cdg():
    assert _match_iata("Charles de Gaulle Airport") == "CDG"


def test_match_ohare():
    assert _match_iata("O'Hare International Airport") == "ORD"


def test_no_match_for_garbage():
    assert _match_iata("Random Small Airstrip XYZ") is None


def test_no_match_for_empty():
    assert _match_iata("") is None


def test_no_match_generic_words_only():
    # Only noise words — should not match any airport
    assert _match_iata("International Airport") is None


# ---- extract_flight_date ----


def test_extract_date_from_datetime():
    assert extract_flight_date(datetime(2026, 6, 15, 10, 0, tzinfo=UTC)) == "2026-06-15"


def test_extract_date_fallback():
    expected = (date.today() + timedelta(days=14)).isoformat()
    assert extract_flight_date(None) == expected


# ---- haversine_m ----


def test_haversine_jfk_to_lhr():
    # JFK (40.6413, -73.7781) to LHR (51.4700, -0.4543) ≈ 5,540 km
    dist_m = haversine_m(40.6413, -73.7781, 51.4700, -0.4543)
    dist_km = dist_m / 1000
    assert 5400 < dist_km < 5700


def test_haversine_same_point():
    assert haversine_m(0, 0, 0, 0) == 0.0


# ---- resolve_nearest_airport ----


def _mock_places_response(places: list[dict], status_code: int = 200):
    """Build a mock httpx response for Places API."""
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = {"places": places}
    response.text = json.dumps({"places": places})
    client = AsyncMock()
    client.post = AsyncMock(return_value=response)
    return client


def _mock_credentials():
    """Build mock ADC credentials."""
    creds = MagicMock()
    creds.valid = True
    creds.token = "mock-token"
    return creds


@pytest.mark.asyncio
async def test_resolve_jfk():
    client = _mock_places_response([
        {"displayName": {"text": "John F. Kennedy International Airport"}},
    ])
    creds = _mock_credentials()

    iata = await resolve_nearest_airport(40.6413, -73.7781, client, creds)
    assert iata == "JFK"

    # Verify API request body includes improved params
    call_kwargs = client.post.call_args
    body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
    assert body["locationRestriction"]["circle"]["radius"] == 48_000
    assert body["rankPreference"] == "DISTANCE"
    assert body["languageCode"] == "en"
    # Must filter by primary type (not "includedTypes") to exclude FBOs,
    # helicopter tour operators, etc. that have "airport" as a secondary type.
    assert body["includedPrimaryTypes"] == ["airport"]
    assert "includedTypes" not in body
    assert body["maxResultCount"] == 20


@pytest.mark.asyncio
async def test_resolve_no_match():
    client = _mock_places_response([
        {"displayName": {"text": "Private Landing Strip"}},
    ])
    creds = _mock_credentials()

    iata = await resolve_nearest_airport(0.0, 0.0, client, creds)
    assert iata is None


@pytest.mark.asyncio
async def test_resolve_empty_response():
    client = _mock_places_response([])
    creds = _mock_credentials()

    iata = await resolve_nearest_airport(0.0, 0.0, client, creds)
    assert iata is None


@pytest.mark.asyncio
async def test_resolve_api_failure():
    client = _mock_places_response([], status_code=500)
    creds = _mock_credentials()

    iata = await resolve_nearest_airport(0.0, 0.0, client, creds)
    assert iata is None


@pytest.mark.asyncio
async def test_resolve_http_exception():
    """HTTP transport error should return None, not raise."""
    client = AsyncMock()
    client.post = AsyncMock(side_effect=Exception("connection refused"))
    creds = _mock_credentials()

    iata = await resolve_nearest_airport(0.0, 0.0, client, creds)
    assert iata is None


@pytest.mark.asyncio
async def test_resolve_picks_first_match():
    """When multiple airports are returned, pick the first that matches."""
    client = _mock_places_response([
        {"displayName": {"text": "Teterboro Airport"}},  # TEB
        {"displayName": {"text": "John F. Kennedy International Airport"}},  # JFK
    ])
    creds = _mock_credentials()

    iata = await resolve_nearest_airport(40.6413, -73.7781, client, creds)
    # Teterboro should match TEB, which comes first
    assert iata == "TEB"
