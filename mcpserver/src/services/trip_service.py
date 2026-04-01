"""MCP TripService: thin composition layer over shared repos for read operations."""

import math
from typing import Any

from shared.dag.paths import compute_participant_paths
from shared.models import Action
from shared.repositories import (
    ActionRepository,
    EdgeRepository,
    LocationRepository,
    NodeRepository,
    PlanRepository,
    TripRepository,
    UserRepository,
)
from shared.tools.id_gen import action_id


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance in km between two lat/lng points."""
    r = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class TripService:
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        action_repo: ActionRepository,
        location_repo: LocationRepository,
        user_repo: UserRepository,
    ):
        self._trip_repo = trip_repo
        self._plan_repo = plan_repo
        self._node_repo = node_repo
        self._edge_repo = edge_repo
        self._action_repo = action_repo
        self._location_repo = location_repo
        self._user_repo = user_repo

    def _verify_participant(self, trip: dict, user_id: str) -> str:
        """Verify user is a participant and return their role."""
        participants = trip.get("participants", {})
        if user_id not in participants:
            raise PermissionError("Not a participant of this trip")
        return participants[user_id]["role"]

    def _require_editor(self, role: str) -> None:
        """Require admin or planner role."""
        if role not in ("admin", "planner"):
            raise PermissionError("Requires admin or planner role")

    async def get_trips(self, user_id: str) -> list[dict]:
        trips = await self._trip_repo.list_by_user(user_id)
        return [
            {
                "id": t["id"],
                "name": t["name"],
                "role": t["participants"][user_id]["role"],
                "active_plan_id": t.get("active_plan_id"),
                "participant_count": len(t.get("participants", {})),
            }
            for t in trips
        ]

    async def get_trip_versions(self, trip_id: str, user_id: str) -> dict:
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        self._verify_participant(trip_data, user_id)

        plans = await self._plan_repo.list_by_trip(trip_id)
        versions = []
        for p in plans:
            nodes = await self._node_repo.list_by_plan(trip_id, p["id"])
            versions.append({
                "id": p["id"],
                "name": p["name"],
                "status": p["status"],
                "node_count": len(nodes),
            })

        return {
            "trip_id": trip_id,
            "active_plan_id": trip_data.get("active_plan_id"),
            "versions": versions,
        }

    async def get_trip_context(
        self, trip_id: str, user_id: str, plan_id: str | None = None
    ) -> dict:
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        self._verify_participant(trip_data, user_id)

        plan_id = plan_id or trip_data.get("active_plan_id")
        if not plan_id:
            return {
                "trip": {
                    "id": trip_id,
                    "name": trip_data["name"],
                    "plan": None,
                    "participant_locations": [],
                }
            }

        plan_data = await self._plan_repo.get_or_raise(plan_id, trip_id=trip_id)
        nodes_raw = await self._node_repo.list_by_plan(trip_id, plan_id)
        edges_raw = await self._edge_repo.list_by_plan(trip_id, plan_id)

        # Enrich nodes with actions
        node_map = {n["id"]: n for n in nodes_raw}
        enriched_nodes = []
        for n in nodes_raw:
            actions = await self._action_repo.list_by_node(
                trip_id, plan_id, n["id"]
            )
            enriched_nodes.append({
                "id": n["id"],
                "name": n["name"],
                "type": n.get("type"),
                "lat": n.get("lat_lng", {}).get("lat"),
                "lng": n.get("lat_lng", {}).get("lng"),
                "arrival_time": n.get("arrival_time"),
                "departure_time": n.get("departure_time"),
                "duration_hours": n.get("duration_hours"),
                "order_index": n.get("order_index", 0),
                "timezone": n.get("timezone"),
                "participant_ids": n.get("participant_ids"),
                "actions": [
                    {
                        "id": a.get("id"),
                        "type": a.get("type"),
                        "content": a.get("content"),
                        "created_by": a.get("created_by"),
                    }
                    for a in actions
                ],
            })

        # Edges with node names for readability
        enriched_edges = []
        for e in edges_raw:
            from_name = node_map.get(e["from_node_id"], {}).get("name", e["from_node_id"])
            to_name = node_map.get(e["to_node_id"], {}).get("name", e["to_node_id"])
            enriched_edges.append({
                "id": e["id"],
                "from": from_name,
                "to": to_name,
                "from_node_id": e["from_node_id"],
                "to_node_id": e["to_node_id"],
                "travel_mode": e.get("travel_mode"),
                "travel_time_hours": e.get("travel_time_hours"),
                "distance_km": e.get("distance_km"),
            })

        # Compute participant paths
        participants = trip_data.get("participants", {})
        participant_ids = list(participants.keys())
        path_result = compute_participant_paths(nodes_raw, edges_raw, participant_ids)

        # Participant locations as human-readable references
        participant_locations = await self._build_location_descriptions(
            trip_id, trip_data, nodes_raw
        )

        # Build participant info with roles and display names
        enriched_participants = {}
        for uid, pdata in participants.items():
            enriched_participants[uid] = {
                "role": pdata.get("role", "viewer"),
                "display_name": pdata.get("display_name", uid),
            }

        return {
            "trip": {
                "id": trip_id,
                "name": trip_data["name"],
                "participants": enriched_participants,
                "plan": {
                    "id": plan_id,
                    "name": plan_data.get("name", ""),
                    "status": plan_data.get("status", ""),
                    "nodes": enriched_nodes,
                    "edges": enriched_edges,
                },
                "paths": {
                    uid: [node_map.get(nid, {}).get("name", nid) for nid in path]
                    for uid, path in path_result.paths.items()
                },
                "participant_locations": participant_locations,
            }
        }

    async def _build_location_descriptions(
        self, trip_id: str, trip_data: dict, nodes_raw: list[dict]
    ) -> list[dict]:
        """Build human-readable location descriptions relative to trip nodes.

        Only includes users with location_tracking_enabled=True.
        Returns descriptions like "~85 km from Paris, heading toward Lyon".
        """
        locations = await self._location_repo.get_all_locations(trip_id)
        if not locations:
            return []

        participants = trip_data.get("participants", {})
        # Fetch user profiles to check location_tracking_enabled and get names
        user_ids = [loc.get("user_id") for loc in locations if loc.get("user_id")]
        user_profiles: dict[str, Any] = {}
        for uid in user_ids:
            user = await self._user_repo.get_user(uid)
            if user:
                user_profiles[uid] = user

        # Build list of nodes with lat/lng for distance computation
        node_points = []
        for n in nodes_raw:
            lat_lng = n.get("lat_lng", {})
            if lat_lng and lat_lng.get("lat") is not None:
                node_points.append({
                    "name": n.get("name", "Unknown"),
                    "lat": lat_lng["lat"],
                    "lng": lat_lng["lng"],
                    "order": n.get("order_index", 0),
                })

        result = []
        for loc in locations:
            uid = loc.get("user_id")
            if not uid or uid not in user_profiles:
                continue

            user = user_profiles[uid]
            if not user.location_tracking_enabled:
                continue

            coords = loc.get("coords", {})
            lat = coords.get("lat") if isinstance(coords, dict) else None
            lng = coords.get("lng") if isinstance(coords, dict) else None
            if lat is None or lng is None:
                continue

            # Find nearest and second-nearest nodes
            distances = []
            for np in node_points:
                d = _haversine_km(lat, lng, np["lat"], np["lng"])
                distances.append((d, np))
            distances.sort(key=lambda x: x[0])

            if not distances:
                description = "Location unknown relative to trip"
            elif len(distances) == 1:
                d, nearest = distances[0]
                description = f"~{round(d)} km from {nearest['name']}"
            else:
                d1, nearest = distances[0]
                _, second = distances[1]
                description = f"~{round(d1)} km from {nearest['name']}, near {second['name']}"

            display_name = participants.get(uid, {}).get("display_name", user.display_name)
            result.append({
                "user_name": display_name,
                "description": description,
                "updated_at": loc.get("updated_at"),
            })

        return result

    async def add_action(
        self,
        user_id: str,
        trip_id: str,
        node_id: str,
        action_type: str,
        content: str,
        place_data: dict | None = None,
    ) -> dict:
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        self._verify_participant(trip_data, user_id)

        plan_id = trip_data.get("active_plan_id")
        if not plan_id:
            raise ValueError("Trip has no active plan")

        # Verify node exists
        await self._node_repo.get_or_raise(node_id, trip_id=trip_id, plan_id=plan_id)

        action = Action(
            id=action_id(),
            type=action_type,
            content=content,
            place_data=place_data,
            created_by=user_id,
        )
        result = await self._action_repo.create_action(
            trip_id, plan_id, node_id, action
        )
        return {
            "action_id": result["id"],
            "type": result["type"],
            "content": result["content"],
            "node_id": node_id,
            "created_at": result.get("created_at"),
        }
