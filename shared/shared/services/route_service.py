"""Route service: fetch route data (polyline, duration, distance) from the Routes API."""

import logging
import os
from dataclasses import dataclass

import google.auth
import google.auth.transport.requests
import httpx

logger = logging.getLogger(__name__)

_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
_FIELD_MASK = (
    "routes.polyline.encodedPolyline,"
    "routes.duration,"
    "routes.distanceMeters,"
    "routes.legs.steps.navigationInstruction"
)

_TRAVEL_MODE_MAP = {
    "drive": "DRIVE",
    "transit": "TRANSIT",
    "walk": "WALK",
}


@dataclass
class RouteData:
    """Route data returned by the Routes API."""

    polyline: str | None = None
    duration_seconds: int | None = None
    distance_meters: int | None = None
    warnings: list[str] | None = None

    @property
    def travel_time_hours(self) -> float | None:
        if self.duration_seconds is None:
            return None
        return round(self.duration_seconds / 3600, 2)

    @property
    def distance_km(self) -> float | None:
        if self.distance_meters is None:
            return None
        return round(self.distance_meters / 1000, 1)

    @property
    def notes(self) -> str | None:
        if not self.warnings:
            return None
        return " | ".join(self.warnings)


class RouteService:
    def __init__(self, http_client: httpx.AsyncClient):
        self._http = http_client
        self._credentials: google.auth.credentials.Credentials | None = None
        self._auth_req = google.auth.transport.requests.Request()

    async def get_route_data(
        self,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
        departure_time: str | None = None,
        from_name: str | None = None,
        to_name: str | None = None,
        from_place_id: str | None = None,
        to_place_id: str | None = None,
    ) -> RouteData | None:
        """Fetch polyline, duration, and distance for a route.

        Returns RouteData on success, None on failure or for flights.
        Attempts to find a route by iterating through available location types
        in order of preference: Place IDs > Lat/Lng > Address names.
        Logs warnings on API failure; never raises.
        """
        if travel_mode in ("flight", "ferry"):
            return None

        api_mode = _TRAVEL_MODE_MAP.get(travel_mode)
        if api_mode is None:
            logger.warning("Unknown travel mode %r — skipping route fetch", travel_mode)
            return None

        from_lat = from_latlng.get("lat") if from_latlng else None
        from_lng = from_latlng.get("lng") if from_latlng else None
        to_lat = to_latlng.get("lat") if to_latlng else None
        to_lng = to_latlng.get("lng") if to_latlng else None

        configs = []

        # 1. Place ID preferred. If missing, this falls through to coordinate, then address.
        orig1 = self._build_waypoint(from_place_id, from_lat, from_lng, from_name)
        dest1 = self._build_waypoint(to_place_id, to_lat, to_lng, to_name)
        if orig1 and dest1:
            configs.append((orig1, dest1))

        # 2. Coordinate fallback
        orig2 = self._build_waypoint(None, from_lat, from_lng, from_name)
        dest2 = self._build_waypoint(None, to_lat, to_lng, to_name)
        if orig2 and dest2 and (orig2, dest2) not in configs:
            configs.append((orig2, dest2))

        # 3. Address fallback as a last resort
        orig3 = self._build_waypoint(None, None, None, from_name)
        dest3 = self._build_waypoint(None, None, None, to_name)
        if orig3 and dest3 and (orig3, dest3) not in configs:
            configs.append((orig3, dest3))

        for orig, dest in configs:
            result = await self._call_routes_api(
                orig, dest, api_mode, departure_time
            )
            if result is not None:
                return result

            logger.info("Retrying route with next fallback: %r -> %r", orig, dest)

        return None

    @staticmethod
    def _build_waypoint(
        place_id: str | None,
        lat: float | None,
        lng: float | None,
        name: str | None,
    ) -> dict | None:
        """Build a waypoint using the best available data according to constraints.

        Routes API v2 'Waypoint' uses a oneOf for location, so we can only send
        exactly one: Place ID, LatLng, or Address.
        """
        if place_id:
            return {"placeId": place_id}
        if lat is not None and lng is not None:
            return {
                "location": {
                    "latLng": {"latitude": lat, "longitude": lng}
                }
            }
        if name:
            return {"address": name}
        return None

    async def _call_routes_api(
        self,
        origin: dict,
        destination: dict,
        api_mode: str,
        departure_time: str | None,
    ) -> RouteData | None:
        """Low-level Routes API call. Returns RouteData or None."""
        try:
            if self._credentials is None:
                self._credentials, _ = google.auth.default(
                    scopes=["https://www.googleapis.com/auth/cloud-platform"]
                )
            if not self._credentials.valid:
                self._credentials.refresh(self._auth_req)
            token = self._credentials.token

            body: dict = {
                "origin": origin,
                "destination": destination,
                "travelMode": api_mode,
                "languageCode": "en",
            }
            if api_mode in ("DRIVE", "TRANSIT"):
                if departure_time:
                    body["routingPreference"] = "TRAFFIC_AWARE_OPTIMAL"
                    body["departureTime"] = departure_time
                else:
                    body["routingPreference"] = "TRAFFIC_UNAWARE"
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
        except httpx.TimeoutException:
            logger.warning("Routes API timed out for %r -> %r", origin, destination)
            return None
        except httpx.HTTPError as exc:
            logger.warning("Routes API transport error: %s", exc)
            return None

        if response.status_code != 200:
            logger.warning(
                "Routes API returned %d: %s",
                response.status_code,
                response.text[:200],
            )
            return None

        try:
            data = response.json()
        except ValueError:
            logger.warning("Routes API returned non-JSON response")
            return None

        routes = data.get("routes")
        if not routes:
            logger.debug(
                "Routes API returned no routes for %r -> %r (mode=%s)",
                origin, destination, api_mode,
            )
            return None

        route = routes[0]
        polyline = route.get("polyline", {}).get("encodedPolyline")

        # Duration comes as "3600s" string
        duration_str = route.get("duration")
        duration_seconds: int | None = None
        if duration_str and isinstance(duration_str, str) and duration_str.endswith("s"):
            try:
                duration_seconds = int(duration_str[:-1])
            except ValueError:
                duration_seconds = None

        distance_meters = route.get("distanceMeters")

        # Extract route advisory warnings
        noise = {"This route includes a highway."}
        advisory_patterns = ("may be closed", "parts of this road")
        warnings: list[str] = []
        for w in route.get("warnings", []):
            if w not in noise:
                warnings.append(w)
        for leg in route.get("legs", []):
            for step in leg.get("steps", []):
                instr = (
                    step.get("navigationInstruction", {})
                    .get("instructions", "")
                )
                if (
                    any(p in instr.lower() for p in advisory_patterns)
                    and instr not in warnings
                ):
                    warnings.append(instr)

        return RouteData(
            polyline=polyline,
            duration_seconds=duration_seconds,
            distance_meters=distance_meters,
            warnings=warnings or None,
        )

    async def fetch_and_patch_route_data(
        self,
        trip_id: str,
        plan_id: str,
        edge_id: str,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
        edge_repo,
        departure_time: str | None = None,
        from_name: str | None = None,
        to_name: str | None = None,
        from_place_id: str | None = None,
        to_place_id: str | None = None,
    ) -> None:
        """Fetch route data and patch the edge document.

        Intended to be run as a background task. Swallows all exceptions.
        """
        try:
            route_data = await self.get_route_data(
                from_latlng, to_latlng, travel_mode, departure_time,
                from_name=from_name, to_name=to_name,
                from_place_id=from_place_id, to_place_id=to_place_id,
            )
            if route_data:
                updates: dict = {}
                if route_data.polyline:
                    updates["route_polyline"] = route_data.polyline
                if route_data.travel_time_hours is not None:
                    updates["travel_time_hours"] = route_data.travel_time_hours
                if route_data.distance_km is not None:
                    updates["distance_km"] = route_data.distance_km
                if route_data.notes:
                    updates["notes"] = route_data.notes
                if updates:
                    await edge_repo.update_edge(
                        trip_id, plan_id, edge_id, updates
                    )
        except Exception:
            logger.warning(
                "fetch_and_patch_route_data failed for edge %s",
                edge_id,
                exc_info=True,
            )

    # Keep old name as alias for backward compatibility with existing callers
    async def fetch_and_patch_polyline(
        self,
        trip_id: str,
        plan_id: str,
        edge_id: str,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
        edge_repo,
        departure_time: str | None = None,
        from_name: str | None = None,
        to_name: str | None = None,
        from_place_id: str | None = None,
        to_place_id: str | None = None,
    ) -> None:
        """Backward-compatible alias for fetch_and_patch_route_data."""
        await self.fetch_and_patch_route_data(
            trip_id, plan_id, edge_id, from_latlng, to_latlng, travel_mode, edge_repo,
            departure_time, from_name=from_name, to_name=to_name,
            from_place_id=from_place_id, to_place_id=to_place_id,
        )
