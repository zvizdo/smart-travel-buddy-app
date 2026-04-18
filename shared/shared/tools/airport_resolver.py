"""Resolve lat/lng coordinates to IATA airport codes.

Uses Google Places API (New) to find nearby airports, then fuzzy-matches
the display name against the ``fli.models.Airport`` enum to get the IATA code.
"""

import logging
import math
import os
import re
from datetime import date, datetime, timedelta
from difflib import SequenceMatcher

import google.auth.credentials
import httpx
from fli.models import Airport

logger = logging.getLogger(__name__)

_PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby"
_FIELD_MASK = "places.displayName"
_SEARCH_RADIUS_M = 48_000  # 50 km (API max)

# ---- Import-time index: normalized airport name → IATA code ----

_STRIP_RE = re.compile(r"[.\-,/()'\"]")

# Words too generic to count as meaningful overlap during pre-filtering
_NOISE_WORDS = frozenset({
    "airport", "international", "regional", "municipal", "landing",
    "strip", "airstrip", "airfield", "aerodrome", "field", "air",
    "base", "private", "domestic",
})


def _normalize(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    cleaned = _STRIP_RE.sub(" ", name.lower())
    return " ".join(cleaned.split())


# Build once at import time.  ~7 900 entries, takes <50 ms.
_AIRPORT_NAMES: dict[str, str] = {}          # IATA → normalized full name
_AIRPORT_WORDS: dict[str, frozenset[str]] = {}  # IATA → word set (pre-filter)
for _code in Airport.__members__:
    _norm = _normalize(Airport[_code].value)
    if _norm:
        _AIRPORT_NAMES[_code] = _norm
        _AIRPORT_WORDS[_code] = frozenset(_norm.split())


def _token_set_ratio(s1: str, s2: str) -> float:
    """Token-set fuzzy ratio using SequenceMatcher (stdlib).

    Handles word subsets and order differences naturally:
    "heathrow airport" vs "london heathrow airport" → 0.87.
    """
    tokens1, tokens2 = set(s1.split()), set(s2.split())
    common = sorted(tokens1 & tokens2)
    if not common:
        return 0.0
    rest1 = sorted(tokens1 - tokens2)
    rest2 = sorted(tokens2 - tokens1)
    base = " ".join(common)
    combined1 = " ".join(common + rest1)
    combined2 = " ".join(common + rest2)
    return max(
        SequenceMatcher(None, base, combined1).ratio(),
        SequenceMatcher(None, base, combined2).ratio(),
        SequenceMatcher(None, combined1, combined2).ratio(),
    )


def _match_iata(display_name: str) -> str | None:
    """Find the best IATA match for a Places API display name.

    Two-phase: cheap word-set pre-filter (must share >=1 meaningful word),
    then token-set ratio ranking via SequenceMatcher for precision.
    """
    query = _normalize(display_name)
    if not query:
        return None
    query_words = set(query.split())

    # Phase 1: pre-filter — must share at least 1 meaningful word
    candidates = [
        code for code, words in _AIRPORT_WORDS.items()
        if (query_words & words) - _NOISE_WORDS
    ]
    if not candidates:
        return None

    # Phase 2: rank by token-set ratio.
    # Token-set ratio scores a subset match (e.g. "las vegas airport") identically
    # to the full match ("north las vegas airport") when the query is the longer
    # string — both hit 1.0. Break ties in favor of the candidate whose word set
    # equals the query's, so "North Las Vegas Airport" resolves to VGT, not LCF.
    best_code: str | None = None
    best_score: float = 0.0
    best_is_exact = False
    for code in candidates:
        score = _token_set_ratio(query, _AIRPORT_NAMES[code])
        is_exact = _AIRPORT_WORDS[code] == query_words
        if score > best_score or (
            score == best_score and is_exact and not best_is_exact
        ):
            best_score = score
            best_code = code
            best_is_exact = is_exact

    return best_code if best_score >= 0.70 else None


async def resolve_nearest_airport(
    lat: float,
    lng: float,
    http_client: httpx.AsyncClient,
    credentials: google.auth.credentials.Credentials,
    auth_request=None,
) -> str | None:
    """Resolve coordinates to the nearest airport's IATA code.

    Calls Google Places API (New) ``searchNearby`` with ``includedTypes:
    ["airport"]``, then fuzzy-matches each result against the ``fli``
    Airport enum.

    Returns the IATA code (e.g. ``"JFK"``) or ``None`` if resolution fails.
    """
    try:
        if not credentials.valid:
            if auth_request is None:
                import google.auth.transport.requests
                auth_request = google.auth.transport.requests.Request()
            credentials.refresh(auth_request)

        # includedPrimaryTypes (not includedTypes) restricts to places whose
        # PRIMARY type is "airport". Without this, Places returns FBOs,
        # helicopter tour operators, and aviation-service companies that have
        # "airport" as a secondary type — e.g. near Luxor Hotel (LAS): "5 Star
        # Helicopter Tours", "Mgm International Aviation". These crowd out the
        # real airport at maxResultCount=5 and fail fuzzy matching against fli.
        body = {
            "includedPrimaryTypes": ["airport"],
            "locationRestriction": {
                "circle": {
                    "center": {"latitude": lat, "longitude": lng},
                    "radius": _SEARCH_RADIUS_M,
                }
            },
            "maxResultCount": 20,
            "rankPreference": "DISTANCE",
            "languageCode": "en",
        }
        headers = {
            "Authorization": f"Bearer {credentials.token}",
            "X-Goog-FieldMask": _FIELD_MASK,
            "Content-Type": "application/json",
            "x-goog-user-project": os.environ.get("GOOGLE_CLOUD_PROJECT", ""),
        }

        response = await http_client.post(
            _PLACES_NEARBY_URL, json=body, headers=headers, timeout=5.0,
        )
        if response.status_code != 200:
            logger.warning(
                "Places API returned %d for airport search near (%.2f, %.2f): %s",
                response.status_code, lat, lng, response.text[:300],
            )
            return None

        data = response.json()
        places = data.get("places", [])
        if not places:
            logger.warning("No airports found near (%.4f, %.4f)", lat, lng)
            return None

        for place in places:
            name = place.get("displayName", {}).get("text", "")
            if not name:
                continue
            iata = _match_iata(name)
            if iata:
                logger.info(
                    "Resolved (%.4f, %.4f) → %s (%s)", lat, lng, iata, name,
                )
                return iata

        logger.warning(
            "No IATA match for airports near (%.4f, %.4f); candidates: %s",
            lat, lng,
            [p.get("displayName", {}).get("text", "") for p in places],
        )
        return None

    except Exception:
        logger.warning(
            "Airport resolution failed for (%.2f, %.2f)", lat, lng,
            exc_info=True,
        )
        return None


def extract_flight_date(departure_time: datetime | None) -> str:
    """Extract a YYYY-MM-DD date string for flight search.

    Falls back to 14 days from today when ``departure_time`` is None.
    """
    if departure_time is not None:
        return departure_time.date().isoformat()
    return (date.today() + timedelta(days=14)).isoformat()


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres between two points."""
    R = 6_371_000.0
    dLat = math.radians(lat2 - lat1)
    dLng = math.radians(lng2 - lng1)
    a = (
        math.sin(dLat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dLng / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
