"""MCP TripService: thin composition layer over shared repos for read operations
plus trip lifecycle mutations (create, delete, settings update).

Trip lifecycle methods here intentionally mirror the backend's TripService
(backend/src/services/trip_service.py) without pulling in the backend-only
notification/invite/preference repositories. The backend remains the source of
truth; if the cascading delete logic changes there, update it here too.
"""

import asyncio
import math
from datetime import UTC, datetime
from typing import Any

from google.cloud.firestore_v1.transforms import DELETE_FIELD

from shared.dag.paths import compute_participant_paths
from shared.models import (
    Action,
    ActionType,
    Participant,
    PlaceData,
    Plan,
    PlanStatus,
    Trip,
    TripRole,
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
from shared.tools.id_gen import action_id, plan_id as gen_plan_id, trip_id as gen_trip_id


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

    def _require_admin(self, role: str) -> None:
        """Require admin role."""
        if role != "admin":
            raise PermissionError("Requires admin role")

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

    async def get_trip_plans(self, trip_id: str, user_id: str) -> dict:
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        self._verify_participant(trip_data, user_id)

        plans = await self._plan_repo.list_by_trip(trip_id)
        plan_summaries = []
        for p in plans:
            nodes = await self._node_repo.list_by_plan(trip_id, p["id"])
            plan_summaries.append({
                "id": p["id"],
                "name": p["name"],
                "status": p["status"],
                "node_count": len(nodes),
            })

        return {
            "trip_id": trip_id,
            "active_plan_id": trip_data.get("active_plan_id"),
            "plans": plan_summaries,
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

    async def create_trip(
        self,
        user_id: str,
        name: str,
        user_display_name: str = "",
    ) -> dict:
        """Create a new trip with the caller as the sole admin, plus an
        initial active plan named "Main Route".

        The initial plan bundling is MCP-specific: the backend's create_trip
        leaves the trip planless and relies on import_build to create the
        first plan. The MCP server has no equivalent follow-up, so bundling
        here removes the dead-end between create_trip and add_node. The plan
        name matches backend/src/api/agent.py:99 so trips created via MCP and
        the web import flow look identical.
        """
        trip = Trip(
            id=gen_trip_id(),
            name=name,
            created_by=user_id,
            active_plan_id=None,
            participants={
                user_id: Participant(
                    role=TripRole.ADMIN,
                    display_name=user_display_name or user_id,
                    joined_at=datetime.now(UTC),
                )
            },
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        await self._trip_repo.create(trip)

        # Create the initial active plan and point the trip at it.
        plan = Plan(
            id=gen_plan_id(),
            name="Main Route",
            status=PlanStatus.ACTIVE,
            created_by=user_id,
            created_at=datetime.now(UTC),
        )
        await self._plan_repo.create_plan(trip.id, plan)
        await self._trip_repo.update_trip(
            trip.id,
            {
                "active_plan_id": plan.id,
                "updated_at": datetime.now(UTC).isoformat(),
            },
        )

        trip_dict = trip.model_dump(mode="json")
        trip_dict["active_plan_id"] = plan.id
        trip_dict["plan"] = plan.model_dump(mode="json")
        return trip_dict

    async def update_trip_settings(
        self,
        user_id: str,
        trip_id: str,
        datetime_format: str | None = None,
        date_format: str | None = None,
        distance_unit: str | None = None,
    ) -> dict:
        """Update trip-level display settings. Admin only.

        The caller must already be resolved as admin via resolve_trip_admin;
        this method does not re-check the role. It does re-fetch the trip
        to merge settings cleanly.
        """
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        current = trip_data.get("settings") or {}
        if datetime_format is not None:
            current["datetime_format"] = datetime_format
        if date_format is not None:
            current["date_format"] = date_format
        if distance_unit is not None:
            current["distance_unit"] = distance_unit

        await self._trip_repo.update(
            trip_id,
            {
                "settings": current,
                "updated_at": datetime.now(UTC).isoformat(),
            },
        )
        return current

    async def delete_trip(self, trip_id: str, user_id: str) -> dict:
        """Cascading delete of a trip and every subcollection.

        Admin-only at the tool boundary (enforced by resolve_trip_admin).

        Mirrors backend TripService.delete_trip but uses raw Firestore
        collection walks for the backend-only subcollections (notifications,
        invite_links, preferences) since the MCP server doesn't have repos
        for those. Source of truth remains backend/src/services/trip_service.py;
        update both if the storage shape changes.
        """
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        participants = trip_data.get("participants", {})
        participant = participants.get(user_id)
        if participant is None or participant.get("role") != TripRole.ADMIN.value:
            raise PermissionError("Only the trip admin can delete this trip")

        db = self._trip_repo._db
        trip_doc_ref = self._trip_repo._collection().document(trip_id)

        # Phase 1: Parallel list all top-level subcollections
        plans, locations = await asyncio.gather(
            self._plan_repo.list_all(trip_id=trip_id),
            self._location_repo.list_all(trip_id=trip_id),
        )

        # Backend-only subcollections — walk raw Firestore collections.
        async def _list_subcollection_ids(name: str) -> list[str]:
            col = trip_doc_ref.collection(name)
            return [doc.id async for doc in col.stream()]

        notif_ids, invite_ids, pref_ids = await asyncio.gather(
            _list_subcollection_ids("notifications"),
            _list_subcollection_ids("invite_links"),
            _list_subcollection_ids("preferences"),
        )

        # Phase 2: For each plan, list nodes and edges in parallel
        plan_nodes_edges: list[tuple[list[dict], list[dict]]] = []
        if plans:
            plan_nodes_edges = list(
                await asyncio.gather(
                    *[
                        asyncio.gather(
                            self._node_repo.list_by_plan(trip_id, p["id"]),
                            self._edge_repo.list_by_plan(trip_id, p["id"]),
                        )
                        for p in plans
                    ]
                )
            )

        # For each plan's nodes, list actions in parallel
        plan_actions: list[list[list[dict]]] = []
        for plan_idx, (nodes, _edges) in enumerate(plan_nodes_edges):
            if nodes:
                actions_per_node = await asyncio.gather(
                    *[
                        self._action_repo.list_by_node(
                            trip_id, plans[plan_idx]["id"], n["id"]
                        )
                        for n in nodes
                    ]
                )
                plan_actions.append(list(actions_per_node))
            else:
                plan_actions.append([])

        # Phase 3: Collect all document refs (innermost first for safe retry)
        refs = []

        for plan_idx, plan in enumerate(plans):
            plan_id_val = plan["id"]
            nodes, edges = plan_nodes_edges[plan_idx]
            actions_lists = plan_actions[plan_idx]

            # Actions (innermost)
            for node, actions in zip(nodes, actions_lists):
                action_col = self._action_repo._collection(
                    trip_id=trip_id, plan_id=plan_id_val, node_id=node["id"]
                )
                for a in actions:
                    refs.append(action_col.document(a["id"]))

            # Edges
            edge_col = self._edge_repo._collection(
                trip_id=trip_id, plan_id=plan_id_val
            )
            for e in edges:
                refs.append(edge_col.document(e["id"]))

            # Nodes
            node_col = self._node_repo._collection(
                trip_id=trip_id, plan_id=plan_id_val
            )
            for n in nodes:
                refs.append(node_col.document(n["id"]))

            # Plan doc
            refs.append(
                self._plan_repo._collection(trip_id=trip_id).document(plan_id_val)
            )

        # Backend-only subcollection docs (raw refs via trip doc ref)
        for nid in notif_ids:
            refs.append(trip_doc_ref.collection("notifications").document(nid))
        for iid in invite_ids:
            refs.append(trip_doc_ref.collection("invite_links").document(iid))
        for pid in pref_ids:
            refs.append(trip_doc_ref.collection("preferences").document(pid))

        # Locations
        loc_col = self._location_repo._collection(trip_id=trip_id)
        for loc in locations:
            refs.append(loc_col.document(loc["id"]))

        # Trip document last — if a batch fails mid-way, trip still exists for retry
        refs.append(trip_doc_ref)

        # Phase 4: Chunked batch delete (Firestore limit: 500 ops per batch)
        batch_size = 500
        for i in range(0, len(refs), batch_size):
            batch = db.batch()
            for ref in refs[i : i + batch_size]:
                batch.delete(ref)
            await batch.commit()

        return {
            "trip_id": trip_id,
            "plans_deleted": len(plans),
            "docs_deleted": len(refs),
        }

    async def add_action(
        self,
        user_id: str,
        trip_id: str,
        plan_id: str,
        node_id: str,
        action_type: ActionType,
        content: str,
        place_data: PlaceData | None = None,
    ) -> dict:
        # Verify node exists on the target plan.
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

    async def list_actions(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
    ) -> list[dict[str, Any]]:
        # Verify node exists on the target plan so callers get a clean error
        # instead of a silently empty list when the node_id is wrong.
        await self._node_repo.get_or_raise(node_id, trip_id=trip_id, plan_id=plan_id)
        return await self._action_repo.list_by_node(trip_id, plan_id, node_id)

    async def delete_action(
        self,
        trip_id: str,
        plan_id: str,
        node_id: str,
        action_id: str,
    ) -> dict:
        # Verify node and action exist before deleting so we return a proper
        # LookupError (→ 404 on backend) rather than silently succeeding.
        await self._node_repo.get_or_raise(node_id, trip_id=trip_id, plan_id=plan_id)
        existing = await self._action_repo.get_or_raise(
            action_id, trip_id=trip_id, plan_id=plan_id, node_id=node_id
        )
        await self._action_repo.delete_action(trip_id, plan_id, node_id, action_id)
        return {
            "action_id": action_id,
            "type": existing.get("type"),
            "node_id": node_id,
        }
