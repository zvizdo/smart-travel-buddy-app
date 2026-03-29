"""Google Places API (New) integration for MCP tools."""

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_SEARCH_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby"
_SEARCH_TEXT_URL = "https://places.googleapis.com/v1/places:searchText"
_FIELD_MASK = "places.displayName,places.location,places.rating,places.types,places.id,places.formattedAddress"

# Map user-facing categories to Google Places API types
_CATEGORY_TYPES = {
    "restaurant": ["restaurant"],
    "hotel": ["hotel", "lodging"],
    "attraction": ["tourist_attraction"],
}


class PlacesService:
    def __init__(self, api_key: str):
        self._api_key = api_key
        self._client = httpx.AsyncClient(timeout=15.0)

    async def search_nearby(
        self,
        lat: float,
        lng: float,
        category: str,
        preferences: str | None = None,
        radius_m: float = 10000,
    ) -> list[dict]:
        """Search for places near a location by category.

        If preferences are provided, uses text search instead for better matching.
        """
        if preferences:
            return await self.search_text(
                query=f"{category} {preferences}",
                lat=lat,
                lng=lng,
                radius_km=radius_m / 1000,
            )

        included_types = _CATEGORY_TYPES.get(category, [category])

        body: dict[str, Any] = {
            "includedTypes": included_types,
            "locationRestriction": {
                "circle": {
                    "center": {"latitude": lat, "longitude": lng},
                    "radius": radius_m,
                }
            },
            "maxResultCount": 10,
        }

        resp = await self._client.post(
            _SEARCH_NEARBY_URL,
            json=body,
            headers={
                "X-Goog-Api-Key": self._api_key,
                "X-Goog-FieldMask": _FIELD_MASK,
            },
        )
        resp.raise_for_status()
        return self._format_results(resp.json())

    async def search_text(
        self,
        query: str,
        lat: float | None = None,
        lng: float | None = None,
        radius_km: float = 5,
    ) -> list[dict]:
        """Search for places by text query, optionally biased to a location."""
        body: dict[str, Any] = {
            "textQuery": query,
            "maxResultCount": 10,
        }

        if lat is not None and lng is not None:
            body["locationBias"] = {
                "circle": {
                    "center": {"latitude": lat, "longitude": lng},
                    "radius": radius_km * 1000,
                }
            }

        resp = await self._client.post(
            _SEARCH_TEXT_URL,
            json=body,
            headers={
                "X-Goog-Api-Key": self._api_key,
                "X-Goog-FieldMask": _FIELD_MASK,
            },
        )
        resp.raise_for_status()
        return self._format_results(resp.json())

    def _format_results(self, data: dict) -> list[dict]:
        """Format Google Places API response into contract format."""
        results = []
        for place in data.get("places", []):
            loc = place.get("location", {})
            results.append({
                "name": place.get("displayName", {}).get("text", ""),
                "place_id": place.get("id", ""),
                "lat": loc.get("latitude"),
                "lng": loc.get("longitude"),
                "rating": place.get("rating"),
                "types": place.get("types", []),
                "address": place.get("formattedAddress", ""),
            })
        return results

    async def close(self) -> None:
        await self._client.aclose()
