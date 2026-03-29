"""Route service: fetch encoded polylines from the Routes API using ADC credentials."""

import logging
import os

import google.auth
import google.auth.transport.requests
import httpx

logger = logging.getLogger(__name__)

_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
_FIELD_MASK = "routes.polyline.encodedPolyline"

_TRAVEL_MODE_MAP = {
    "drive": "DRIVE",
    "transit": "TRANSIT",
    "walk": "WALK",
}


class RouteService:
    def __init__(self, http_client: httpx.AsyncClient):
        self._http = http_client

    async def get_polyline(
        self,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
    ) -> str | None:
        """Return an encoded polyline string for the given route, or None.

        Returns None immediately for flight mode or when either latlng is absent.
        Logs warnings on API failure; never raises.
        """
        if travel_mode == "flight":
            return None

        if not from_latlng or not to_latlng:
            return None

        from_lat = from_latlng.get("lat")
        from_lng = from_latlng.get("lng")
        to_lat = to_latlng.get("lat")
        to_lng = to_latlng.get("lng")

        if from_lat is None or from_lng is None or to_lat is None or to_lng is None:
            return None

        api_mode = _TRAVEL_MODE_MAP.get(travel_mode)
        if api_mode is None:
            logger.warning("Unknown travel mode %r — skipping polyline fetch", travel_mode)
            return None

        try:
            credentials, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            auth_req = google.auth.transport.requests.Request()
            credentials.refresh(auth_req)
            token = credentials.token

            body = {
                "origin": {
                    "location": {
                        "latLng": {"latitude": from_lat, "longitude": from_lng}
                    }
                },
                "destination": {
                    "location": {
                        "latLng": {"latitude": to_lat, "longitude": to_lng}
                    }
                },
                "travelMode": api_mode,
            }
            headers = {
                "Authorization": f"Bearer {token}",
                "X-Goog-FieldMask": _FIELD_MASK,
                "Content-Type": "application/json",
                "x-goog-user-project": os.environ.get("GOOGLE_CLOUD_PROJECT", ""),
            }
            response = await self._http.post(
                _ROUTES_URL,
                json=body,
                headers=headers,
                timeout=5.0,
            )
            if response.status_code != 200:
                logger.warning(
                    "Routes API returned %d: %s",
                    response.status_code,
                    response.text[:200],
                )
                return None

            data = response.json()
            routes = data.get("routes")
            if not routes:
                logger.warning("Routes API returned no routes for %r -> %r", from_latlng, to_latlng)
                return None

            polyline = routes[0].get("polyline", {}).get("encodedPolyline")
            if not polyline:
                logger.warning("Routes API response missing encodedPolyline field")
                return None

            return polyline

        except Exception:
            logger.warning(
                "Failed to fetch polyline from %r to %r (mode=%r)",
                from_latlng,
                to_latlng,
                travel_mode,
                exc_info=True,
            )
            return None

    async def fetch_and_patch_polyline(
        self,
        trip_id: str,
        plan_id: str,
        edge_id: str,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
        edge_repo,
    ) -> None:
        """Fetch a polyline and patch the edge document if successful.

        Intended to be run as a background task. Swallows all exceptions.
        """
        try:
            polyline = await self.get_polyline(from_latlng, to_latlng, travel_mode)
            if polyline:
                await edge_repo.update_edge(
                    trip_id, plan_id, edge_id, {"route_polyline": polyline}
                )
        except Exception:
            logger.warning(
                "fetch_and_patch_polyline failed for edge %s",
                edge_id,
                exc_info=True,
            )
