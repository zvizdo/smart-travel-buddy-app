# Routing & Route Data Flow

## Route Data Flow

`create_standalone_edge()` fetches route data synchronously for drive/transit/walk; uses haversine estimation for flight (~800 km/h) and ferry (~40 km/h) as immediate placeholder. Background task (`fetch_and_patch_route_data`) then patches real data via `get_route_data()` — for flights this resolves IATA codes via `airport_resolver` + `FlightService.search()` (requests 15 results, buckets by `stops`, picks the **lowest-stops bucket present** — tie-break is not a concern since `min()` is unambiguous — and averages `total_duration_minutes` across just that bucket; `total_duration_minutes` includes layover time, so using a single "best" result or averaging all stop counts inflates duration dramatically — e.g. LAS→SEA nonstop is ~2.5h but a 1-stop can be 8h+).

## Flight Estimate Notes

Flight duration estimates are written as a `Flight estimate: Avg Xh Ym across N nonstop options (YYYY-MM-DD)` line inside `edge.notes`; `_merge_flight_estimate_note()` in `route_service.py` replaces this line on refresh while preserving all other content (road advisories, manual notes) and one-time-migrates a legacy `[flight-estimate]...[/flight-estimate]` sentinel format from earlier deployments. Route advisory warnings (seasonal closures, tolls) are auto-extracted from Routes API `legs.steps.navigationInstruction` and stored in `edge.notes`.

## Polyline Recalculation

`_recalculate_connected_polylines()` only fires when `lat_lng` actually changes (old vs new comparison) and skips only ferry edges (flights are handled).

## Completion Signaling

`fetch_and_patch_route_data` always writes `route_updated_at` to the edge — on success with route data, on failure with `route_polyline: None` to clear stale data. Exception handler has a best-effort write fallback. Frontend `recalculatingEdges` shimmer tracks a composite key (`route_polyline|travel_time_hours|distance_km|route_updated_at`) — any route-related field change from `onSnapshot` clears the shimmer.

## RouteService Departure Time

`RouteService.get_route_data()` accepts `departure_time: str | None` — when provided with DRIVE/TRANSIT mode, sends `routingPreference: "TRAFFIC_AWARE_OPTIMAL"` + `departureTime` to Google Routes API v2 for time-of-day traffic estimates. `routingPreference` is ONLY sent for DRIVE/TRANSIT — sending it for WALK causes empty `{}` responses. Always sends `languageCode: "en"` so route warnings are in English regardless of region.

Field mask: `routes.polyline.encodedPolyline,routes.duration,routes.distanceMeters,routes.legs.steps.navigationInstruction` — do NOT add `routes.warnings` (not a valid v2 field path, causes the API to return `{}`).

All DAG call sites pass departure time via `_build_departure_map()`, which runs `enrich_dag_times` over the DAG and returns each node's enriched departure (falling back to enriched `arrival_time` when departure isn't set). This means route fetches for downstream flex nodes see propagated times (e.g. A dep 18:00 + 6h travel + 2h dur at B → B's outbound fetch uses 02:00 next day), not the raw trip-root departure. Tests asserting the old trip-root-only fallback are stale.

## Place ID / Name Fallback Waypoints

`get_route_data()` also accepts `from_place_id`/`to_place_id` and `from_name`/`to_name` — when coordinate-based routing returns no results (off-road centroids from Google Places), retries with Google Place IDs as `placeId` waypoints (preferred) or node names as `address` waypoints (last resort). All DAG call sites pass both place IDs and node names through.

## Airport Resolver (`shared/shared/tools/airport_resolver.py`)

`resolve_nearest_airport(lat, lng, http_client, credentials)` → IATA code via Google Places API `searchNearby` (48km radius, `rankPreference: "DISTANCE"`, `languageCode: "en"`, `maxResultCount: 20`) + two-phase fuzzy matching (word-set pre-filter then `SequenceMatcher` token-set ratio) against `fli.models.Airport` enum (~7,900 entries).

**Must use `includedPrimaryTypes: ["airport"]`, NOT `includedTypes`** — the latter returns places whose `airport` type is secondary (FBOs, helicopter tour companies, aviation-service shipping agents), which crowd out the real hub airport at short result counts and fail fuzzy matching. Tie-break on equal fuzzy score prefers exact word-set match (so "North Las Vegas Airport" → `VGT`, not `LCF` "Las Vegas Airport"). Failure paths log at WARNING with candidate display names so silent refresh failures are diagnosable. Also exports `extract_flight_date()` and `haversine_m()`.
