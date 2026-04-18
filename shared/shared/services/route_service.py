"""Route service: fetch route data (polyline, duration, distance) from the Routes API.

Also handles flight durations via FlightService + airport IATA resolution.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import google.auth
import google.auth.transport.requests
import httpx

from shared.tools.airport_resolver import (
    extract_flight_date,
    haversine_m,
    resolve_nearest_airport,
)

if TYPE_CHECKING:
    from shared.services.flight_service import FlightService

logger = logging.getLogger(__name__)

_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
# Field mask covers DRIVE/WALK plus TRANSIT-specific fields. The Routes API
# rejects masks that reference fields incompatible with the requested
# travelMode, but it accepts masks that request MORE than a mode produces —
# superset is safe. `routes.legs.steps.transitDetails` is needed so the API
# materialises a transit response body; without it, TRANSIT requests can
# come back with an empty `routes` array.
_FIELD_MASK = (
    "routes.polyline.encodedPolyline,"
    "routes.duration,"
    "routes.distanceMeters,"
    "routes.legs.steps.navigationInstruction,"
    "routes.legs.steps.travelMode,"
    "routes.legs.steps.transitDetails"
)

_TRAVEL_MODE_MAP = {
    "drive": "DRIVE",
    "transit": "TRANSIT",
    "walk": "WALK",
}

# The flight-duration estimate is placed on its own line inside edge.notes,
# prefixed with "Flight estimate:" so refreshes can surgically replace it
# without disturbing other notes (road advisories, user-entered content).
_FLIGHT_ESTIMATE_PREFIX = "Flight estimate:"
# One-time migration: older deployments wrote the estimate wrapped in
# [flight-estimate]...[/flight-estimate] sentinels. Strip those on read so
# they don't linger forever.
_LEGACY_SENTINEL_RE = re.compile(
    r"\s*\[flight-estimate\].*?\[/flight-estimate\]\s*", re.DOTALL,
)

# Sentinel for the optional ``existing_notes`` parameter: ``None`` is a real
# value (the edge has no notes), so we need a distinct "not provided" marker
# that triggers a fetch from Firestore. Anything `is _NOTES_UNSET` means the
# caller didn't pass notes; any other value (including ``None``) is trusted.
_NOTES_UNSET: object = object()

# Same pattern for ``existing_route``. Background callers (freshly-created
# edges with no stored route fields yet) leave it unset and we write
# everything we fetch. Foreground refresh callers that already loaded the
# edge pass the stored route so we can skip writes whose value is unchanged.
_ROUTE_UNSET: object = object()


def _merge_flight_estimate_note(
    existing: str | None, new_estimate: str | None,
) -> str | None:
    """Replace any existing ``Flight estimate: ...`` line (or legacy sentinel).

    Keeps other content (road advisories, manual notes) intact. If
    ``new_estimate`` is None, just strips the stale estimate.
    """
    text = _LEGACY_SENTINEL_RE.sub("\n", existing or "")
    # Drop any prior "Flight estimate: ..." line; preserve the rest verbatim.
    kept = [
        line for line in text.split("\n")
        if not line.strip().startswith(_FLIGHT_ESTIMATE_PREFIX)
    ]
    stripped = "\n".join(line for line in kept if line.strip()).strip()
    if new_estimate:
        new_line = f"{_FLIGHT_ESTIMATE_PREFIX} {new_estimate}"
        return f"{stripped}\n{new_line}" if stripped else new_line
    return stripped or None


def _format_duration_hm(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    if h == 0:
        return f"{m}m"
    if m == 0:
        return f"{h}h"
    return f"{h}h {m}m"


def _stops_label(stops: int) -> str:
    if stops == 0:
        return "nonstop"
    if stops == 1:
        return "1-stop"
    return f"{stops}-stop"


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
    def __init__(
        self,
        http_client: httpx.AsyncClient,
        flight_service: FlightService | None = None,
    ):
        self._http = http_client
        self._flight_service = flight_service
        self._credentials: google.auth.credentials.Credentials | None = None
        self._auth_req = google.auth.transport.requests.Request()

    async def get_route_data(
        self,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
        departure_time: datetime | None = None,
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
        if travel_mode == "ferry":
            return None
        if travel_mode == "flight":
            return await self._get_flight_route_data(
                from_latlng, to_latlng, departure_time,
            )

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
        departure_time: datetime | None,
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
            if api_mode == "DRIVE":
                # routingPreference is DRIVE-only. TRANSIT rejects
                # TRAFFIC_AWARE_OPTIMAL and returns an empty `routes` array
                # when it sees the field, which is how this class of failure
                # used to surface as `{travel_time_hours: 0.0}` edges.
                if departure_time:
                    body["routingPreference"] = "TRAFFIC_AWARE_OPTIMAL"
                    body["departureTime"] = departure_time.isoformat()
                else:
                    body["routingPreference"] = "TRAFFIC_UNAWARE"
            elif api_mode == "TRANSIT" and departure_time:
                # Transit still benefits from departureTime for schedule
                # lookup, but must not send routingPreference.
                body["departureTime"] = departure_time.isoformat()
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
            logger.warning(
                "Routes API returned no %s routes for %r -> %r",
                api_mode, origin, destination,
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

    async def _get_flight_route_data(
        self,
        from_latlng: dict | None,
        to_latlng: dict | None,
        departure_time: datetime | None,
    ) -> RouteData | None:
        """Resolve airports and search flights to get real duration.

        Returns RouteData with duration and haversine distance (no polyline),
        or None if resolution/search fails. Never raises.
        """
        if self._flight_service is None:
            return None
        if not from_latlng or not to_latlng:
            return None

        try:
            # Ensure credentials are fresh
            if self._credentials is None:
                self._credentials, _ = google.auth.default(
                    scopes=["https://www.googleapis.com/auth/cloud-platform"]
                )
            if not self._credentials.valid:
                self._credentials.refresh(self._auth_req)

            origin_iata = await resolve_nearest_airport(
                from_latlng["lat"], from_latlng["lng"],
                self._http, self._credentials, self._auth_req,
            )
            if not origin_iata:
                return None

            dest_iata = await resolve_nearest_airport(
                to_latlng["lat"], to_latlng["lng"],
                self._http, self._credentials, self._auth_req,
            )
            if not dest_iata:
                return None

            flight_date = extract_flight_date(departure_time)
            result = await self._flight_service.search(
                origin=origin_iata,
                destination=dest_iata,
                date=flight_date,
                max_results=15,
            )

            if not result.outbound:
                logger.warning(
                    "No flights found %s → %s on %s",
                    origin_iata, dest_iata, flight_date,
                )
                return None

            # Bucket by stop count and pick the LOWEST-stops bucket present.
            # Most travelers pick the itinerary with the fewest stops whenever
            # it exists, even if cheaper multi-stop flights dominate the
            # results — and the total_duration_minutes for multi-stop flights
            # is padded by long layovers that misrepresent actual travel time.
            buckets: dict[int, list[int]] = {}
            for f in result.outbound:
                buckets.setdefault(f.stops, []).append(f.total_duration_minutes)
            chosen_stops = min(buckets)
            durations = buckets[chosen_stops]
            avg_minutes = round(sum(durations) / len(durations))

            distance_meters = round(haversine_m(
                from_latlng["lat"], from_latlng["lng"],
                to_latlng["lat"], to_latlng["lng"],
            ))

            estimate_note = (
                f"Avg {_format_duration_hm(avg_minutes)} across {len(durations)} "
                f"{_stops_label(chosen_stops)} options ({flight_date})"
            )
            logger.info(
                "Flight %s → %s: %d min avg across %d %s options (%.0f km)",
                origin_iata, dest_iata,
                avg_minutes, len(durations), _stops_label(chosen_stops),
                distance_meters / 1000,
            )
            return RouteData(
                polyline=None,
                duration_seconds=avg_minutes * 60,
                distance_meters=distance_meters,
                warnings=[estimate_note],
            )

        except Exception:
            logger.warning(
                "Flight route data failed for (%.2f,%.2f) → (%.2f,%.2f)",
                from_latlng.get("lat", 0), from_latlng.get("lng", 0),
                to_latlng.get("lat", 0), to_latlng.get("lng", 0),
                exc_info=True,
            )
            return None

    async def fetch_and_patch_route_data(
        self,
        trip_id: str,
        plan_id: str,
        edge_id: str,
        from_latlng: dict | None,
        to_latlng: dict | None,
        travel_mode: str,
        edge_repo,
        departure_time: datetime | None = None,
        from_name: str | None = None,
        to_name: str | None = None,
        from_place_id: str | None = None,
        to_place_id: str | None = None,
        existing_notes: str | None = _NOTES_UNSET,  # type: ignore[assignment]
        existing_route: dict | None = _ROUTE_UNSET,  # type: ignore[assignment]
    ) -> None:
        """Fetch route data and patch the edge document.

        Intended to be run as a background task. Always writes to the edge
        (including on failure) so the frontend's onSnapshot can detect
        completion and clear the "recalculating" shimmer.

        ``existing_route`` (when provided) is a dict of the currently stored
        ``{route_polyline, travel_time_hours, distance_km}`` values. When the
        freshly-fetched route data matches, those fields are dropped from the
        write — only ``route_updated_at`` is bumped so the shimmer clears.
        """
        try:
            route_data = await self.get_route_data(
                from_latlng, to_latlng, travel_mode, departure_time,
                from_name=from_name, to_name=to_name,
                from_place_id=from_place_id, to_place_id=to_place_id,
            )
            updates: dict = {
                "route_updated_at": datetime.now(UTC).isoformat(),
            }
            if route_data:
                if route_data.polyline:
                    updates["route_polyline"] = route_data.polyline
                if route_data.travel_time_hours is not None:
                    updates["travel_time_hours"] = route_data.travel_time_hours
                if route_data.distance_km is not None:
                    updates["distance_km"] = route_data.distance_km

            # Drop fields whose new value matches the caller-supplied stored
            # value. Skips the redundant per-edge writes that fire on every
            # node-move recalculation when the polyline is unchanged.
            if existing_route is not _ROUTE_UNSET and existing_route is not None:
                stored_map = {
                    "route_polyline": existing_route.get("route_polyline"),
                    "travel_time_hours": existing_route.get("travel_time_hours"),
                    "distance_km": existing_route.get("distance_km"),
                }
                for field, stored in stored_map.items():
                    if field in updates and updates[field] == stored:
                        del updates[field]

            # Notes handling diverges by mode:
            # - Flights: merge the sentinel-wrapped estimate into existing notes
            #   so road advisories / manual notes survive refreshes.
            # - Other modes: current behavior (overwrite only when route_data
            #   carried fresh advisory notes).
            if travel_mode == "flight":
                if existing_notes is _NOTES_UNSET:
                    existing_edge = await edge_repo.get_or_raise(
                        edge_id, trip_id=trip_id, plan_id=plan_id,
                    )
                    current_notes = existing_edge.get("notes")
                else:
                    current_notes = existing_notes
                merged = _merge_flight_estimate_note(
                    current_notes,
                    route_data.notes if route_data else None,
                )
                if merged != current_notes:
                    updates["notes"] = merged
            elif route_data and route_data.notes:
                updates["notes"] = route_data.notes

            if not route_data:
                # Clear stale polyline — the old route no longer applies
                updates["route_polyline"] = None

            await edge_repo.update_edge(
                trip_id, plan_id, edge_id, updates
            )
        except Exception:
            logger.warning(
                "fetch_and_patch_route_data failed for edge %s",
                edge_id,
                exc_info=True,
            )
            # Best-effort signal so the frontend can clear the shimmer
            try:
                await edge_repo.update_edge(
                    trip_id, plan_id, edge_id,
                    {
                        "route_updated_at": datetime.now(UTC).isoformat(),
                        "route_polyline": None,
                    },
                )
            except Exception:
                pass

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
        departure_time: datetime | None = None,
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
