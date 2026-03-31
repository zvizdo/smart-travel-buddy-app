"""MCP TripService: thin composition layer over shared repos + DAG algorithms."""

import math
from datetime import UTC, datetime
from typing import Any

from shared.dag.cascade import compute_cascade, parse_dt
from shared.dag.paths import compute_participant_paths
from shared.models import (
    Action,
    Edge,
    Node,
    NodeType,
    Plan,
    PlanStatus,
    TravelMode,
)
from shared.repositories import (
    ActionRepository,
    EdgeRepository,
    LocationRepository,
    NodeRepository,
    PlanRepository,
    TripRepository,
    UserRepository,
)
from shared.tools.id_gen import action_id, edge_id, generate_id, node_id
from shared.tools.timezone import resolve_timezone


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

    async def create_or_modify_trip(
        self,
        user_id: str,
        trip_id: str,
        plan_id: str | None = None,
        plan_name: str | None = None,
        nodes_to_add: list[dict] | None = None,
        nodes_to_update: list[dict] | None = None,
        nodes_to_remove: list[str] | None = None,
        edges_to_add: list[dict] | None = None,
        edges_to_update: list[dict] | None = None,
        edges_to_remove: list[str] | None = None,
    ) -> dict:
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        role = self._verify_participant(trip_data, user_id)
        self._require_editor(role)

        # Resolve or create plan
        if plan_id:
            await self._plan_repo.get_or_raise(plan_id, trip_id=trip_id)
        else:
            plan_id = trip_data.get("active_plan_id")
            if not plan_id:
                plan = Plan(
                    id=generate_id("p"),
                    name=plan_name or "Main Route",
                    status=PlanStatus.ACTIVE,
                    created_by=user_id,
                )
                await self._plan_repo.create_plan(trip_id, plan)
                await self._trip_repo.update_trip(
                    trip_id, {"active_plan_id": plan.id}
                )
                plan_id = plan.id

        stats = {
            "plan_id": plan_id,
            "nodes_added": 0,
            "nodes_updated": 0,
            "nodes_removed": 0,
            "edges_added": 0,
            "edges_updated": 0,
            "edges_removed": 0,
            "cascade_applied": False,
            "affected_downstream_nodes": 0,
        }

        # Track name -> real ID mapping for temp IDs in edges
        name_to_id: dict[str, str] = {}
        timing_changed_node_ids: list[str] = []

        # --- nodes_to_add ---
        if nodes_to_add:
            existing_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
            max_order = max((n.get("order_index", 0) for n in existing_nodes), default=0)

            for i, nd in enumerate(nodes_to_add):
                nid = node_id()
                name_to_id[nd["name"]] = nid

                lat = nd.get("lat", 0)
                lng = nd.get("lng", 0)
                tz = resolve_timezone(lat, lng) if lat and lng else None

                node = Node(
                    id=nid,
                    name=nd["name"],
                    type=NodeType(nd.get("type", "place")),
                    lat_lng={"lat": lat, "lng": lng},
                    arrival_time=nd.get("arrival_time"),
                    departure_time=nd.get("departure_time"),
                    duration_hours=nd.get("duration_hours"),
                    participant_ids=nd.get("participant_ids"),
                    order_index=nd.get("order_index", max_order + i + 1),
                    created_by=user_id,
                    timezone=tz,
                )
                await self._node_repo.create_node(trip_id, plan_id, node)
                stats["nodes_added"] += 1

        # --- nodes_to_update ---
        if nodes_to_update:
            for nu in nodes_to_update:
                node_id = nu["id"]
                await self._node_repo.get_node_or_raise(
                    trip_id, plan_id, node_id
                )
                updates: dict[str, Any] = {}
                for field in (
                    "name", "type", "arrival_time", "departure_time",
                    "duration_hours", "participant_ids",
                ):
                    if field in nu and nu[field] is not None:
                        updates[field] = nu[field]

                if "lat" in nu and "lng" in nu:
                    updates["lat_lng"] = {"lat": nu["lat"], "lng": nu["lng"]}
                    tz = resolve_timezone(nu["lat"], nu["lng"])
                    if tz:
                        updates["timezone"] = tz

                if "arrival_time" in updates or "departure_time" in updates:
                    timing_changed_node_ids.append(node_id)

                updates["updated_at"] = datetime.now(UTC).isoformat()
                await self._node_repo.update_node(
                    trip_id, plan_id, node_id, updates
                )
                stats["nodes_updated"] += 1

        # --- nodes_to_remove ---
        if nodes_to_remove:
            all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
            for node_id in nodes_to_remove:
                incoming = [e for e in all_edges if e["to_node_id"] == node_id]
                outgoing = [e for e in all_edges if e["from_node_id"] == node_id]

                for e in incoming + outgoing:
                    await self._edge_repo.delete_edge(trip_id, plan_id, e["id"])

                # Reconnect if exactly 1 in + 1 out
                if len(incoming) == 1 and len(outgoing) == 1:
                    new_edge = Edge(
                        id=edge_id(),
                        from_node_id=incoming[0]["from_node_id"],
                        to_node_id=outgoing[0]["to_node_id"],
                        travel_mode=TravelMode(
                            incoming[0].get("travel_mode", "drive")
                        ),
                        travel_time_hours=(
                            incoming[0].get("travel_time_hours", 0)
                            + outgoing[0].get("travel_time_hours", 0)
                        ),
                    )
                    await self._edge_repo.create_edge(trip_id, plan_id, new_edge)

                await self._node_repo.delete_node(trip_id, plan_id, node_id)
                # Remove from all_edges for subsequent iterations
                all_edges = [
                    e for e in all_edges
                    if e["from_node_id"] != node_id and e["to_node_id"] != node_id
                ]
                stats["nodes_removed"] += 1

        # --- edges_to_add ---
        if edges_to_add:
            for ea in edges_to_add:
                from_id = name_to_id.get(ea["from_node_id"], ea["from_node_id"])
                to_id = name_to_id.get(ea["to_node_id"], ea["to_node_id"])

                # Dedup check
                existing_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
                already_exists = any(
                    e["from_node_id"] == from_id and e["to_node_id"] == to_id
                    for e in existing_edges
                )
                if already_exists:
                    continue

                edge = Edge(
                    id=edge_id(),
                    from_node_id=from_id,
                    to_node_id=to_id,
                    travel_mode=TravelMode(ea.get("travel_mode", "drive")),
                    travel_time_hours=ea.get("travel_time_hours"),
                    distance_km=ea.get("distance_km"),
                )
                await self._edge_repo.create_edge(trip_id, plan_id, edge)
                stats["edges_added"] += 1

        # --- edges_to_update ---
        if edges_to_update:
            for eu in edges_to_update:
                updates = {}
                for field in ("travel_mode", "travel_time_hours", "distance_km"):
                    if field in eu and eu[field] is not None:
                        updates[field] = eu[field]
                if updates:
                    await self._edge_repo.update_edge(
                        trip_id, plan_id, eu["id"], updates
                    )
                    stats["edges_updated"] += 1

        # --- edges_to_remove ---
        if edges_to_remove:
            for edge_id in edges_to_remove:
                await self._edge_repo.delete_edge(trip_id, plan_id, edge_id)
                stats["edges_removed"] += 1

        # --- Auto-cascade ---
        if timing_changed_node_ids:
            all_nodes = await self._node_repo.list_by_plan(trip_id, plan_id)
            all_edges = await self._edge_repo.list_by_plan(trip_id, plan_id)
            total_affected = 0

            for node_id in timing_changed_node_ids:
                node_data = next(
                    (n for n in all_nodes if n["id"] == node_id), None
                )
                if not node_data:
                    continue

                dep_str = node_data.get("departure_time") or node_data.get("arrival_time")
                if not dep_str:
                    continue

                departure = parse_dt(dep_str)
                preview = compute_cascade(node_id, departure, all_nodes, all_edges)
                affected = preview["affected_nodes"]
                if not affected:
                    continue

                now = datetime.now(UTC).isoformat()
                for entry in affected:
                    await self._node_repo.update_node(
                        trip_id, plan_id, entry["id"],
                        {
                            "arrival_time": entry["new_arrival"],
                            "departure_time": entry["new_departure"],
                            "updated_at": now,
                        },
                    )
                total_affected += len(affected)

            if total_affected:
                stats["cascade_applied"] = True
                stats["affected_downstream_nodes"] = total_affected

        # Summary
        all_nodes_final = await self._node_repo.list_by_plan(trip_id, plan_id)
        all_edges_final = await self._edge_repo.list_by_plan(trip_id, plan_id)
        stats["updated_plan_summary"] = {
            "total_nodes": len(all_nodes_final),
            "total_edges": len(all_edges_final),
        }
        return stats

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
