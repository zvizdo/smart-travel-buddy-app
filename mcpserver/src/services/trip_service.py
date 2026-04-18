"""MCP TripService: extends shared TripService with MCP-specific reads.

Lifecycle methods (create/get/list/delete/update_settings) come from
``shared/shared/services/trip_service.py``. The MCP-specific additions:

  * ``create_trip`` overrides to also create an initial active "Main Route"
    plan, so external agents can call ``add_node`` immediately — backend
    relies on ``import_build`` for that follow-up, MCP has no equivalent.
  * ``get_trips`` augments the shared ``list_trips`` shape with a
    participant_count — agents surface that number in tool results.
  * ``get_trip_plans`` / ``get_trip_context`` are read-context helpers used
    only by MCP tools (context-comprehension calls).
  * ``add_action`` / ``list_actions`` / ``delete_action`` live here because
    MCP exposes per-node actions as direct tools; the backend wraps them
    under chat/agent flows.
"""

import asyncio
from datetime import UTC, datetime
from typing import Any

from shared.dag.paths import compute_participant_paths
from shared.models import (
    Action,
    ActionType,
    PlaceData,
    Plan,
    PlanStatus,
)
from shared.repositories import (
    ActionRepository,
    EdgeRepository,
    InviteLinkRepository,
    LocationRepository,
    NodeRepository,
    NotificationRepository,
    PlanRepository,
    PreferenceRepository,
    TripRepository,
    UserRepository,
)
from shared.services.trip_service import TripService as SharedTripService
from shared.tools.airport_resolver import haversine_m
from shared.tools.id_gen import action_id
from shared.tools.id_gen import plan_id as gen_plan_id


class TripService(SharedTripService):
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        action_repo: ActionRepository,
        location_repo: LocationRepository,
        user_repo: UserRepository,
        notification_repo: NotificationRepository | None = None,
        invite_link_repo: InviteLinkRepository | None = None,
        preference_repo: PreferenceRepository | None = None,
    ):
        super().__init__(
            trip_repo=trip_repo,
            plan_repo=plan_repo,
            node_repo=node_repo,
            edge_repo=edge_repo,
            action_repo=action_repo,
            location_repo=location_repo,
            notification_repo=notification_repo,
            invite_link_repo=invite_link_repo,
            preference_repo=preference_repo,
        )
        self._user_repo = user_repo

    # ---- Lifecycle overrides -------------------------------------------------

    async def create_trip(
        self,
        user_id: str = "",
        name: str = "",
        user_display_name: str = "",
    ) -> dict:
        """Create a trip + an initial active "Main Route" plan.

        Keyword-only in practice because MCP tools call with kwargs. The
        initial plan bundling is MCP-specific: backend relies on import_build
        to create the first plan; the MCP server has no equivalent follow-up,
        so bundling removes the dead-end between create_trip and add_node.
        The plan name matches backend/src/api/agent.py so trips created via
        MCP and the web import flow look identical.
        """
        trip = await super().create_trip(
            name=name, user_id=user_id, user_display_name=user_display_name
        )

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

    async def delete_trip(self, trip_id: str, user_id: str) -> dict:
        """Delete trip + all subcollections. Returns a summary dict for the tool."""
        await super().delete_trip(trip_id, user_id)
        return {"trip_id": trip_id, "deleted": True}

    async def update_trip_settings(
        self,
        user_id: str = "",
        trip_id: str = "",
        datetime_format: str | None = None,
        date_format: str | None = None,
        distance_unit: str | None = None,
        no_drive_window: dict | None = None,
        clear_no_drive_window: bool = False,
        max_drive_hours_per_day: float | None = None,
        clear_max_drive_hours: bool = False,
    ) -> dict:
        """Keyword-first wrapper so MCP tools can call with kwargs in any order."""
        return await super().update_trip_settings(
            trip_id,
            user_id,
            datetime_format=datetime_format,
            date_format=date_format,
            distance_unit=distance_unit,
            no_drive_window=no_drive_window,
            clear_no_drive_window=clear_no_drive_window,
            max_drive_hours_per_day=max_drive_hours_per_day,
            clear_max_drive_hours=clear_max_drive_hours,
        )

    # ---- MCP-specific read methods ------------------------------------------

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
        self.verify_participant(trip_data, user_id)

        plans = await self._plan_repo.list_by_trip(trip_id)
        nodes_per_plan = await asyncio.gather(
            *[self._node_repo.list_by_plan(trip_id, p["id"]) for p in plans]
        ) if plans else []
        plan_summaries = [
            {
                "id": p["id"],
                "name": p["name"],
                "status": p["status"],
                "node_count": len(nodes),
            }
            for p, nodes in zip(plans, nodes_per_plan, strict=True)
        ]

        return {
            "trip_id": trip_id,
            "active_plan_id": trip_data.get("active_plan_id"),
            "plans": plan_summaries,
        }

    async def get_trip_context(
        self, trip_id: str, user_id: str, plan_id: str | None = None
    ) -> dict:
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        self.verify_participant(trip_data, user_id)

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
        actions_per_node = await asyncio.gather(
            *[
                self._action_repo.list_by_node(trip_id, plan_id, n["id"])
                for n in nodes_raw
            ]
        ) if nodes_raw else []
        enriched_nodes = []
        for n, actions in zip(nodes_raw, actions_per_node, strict=True):
            enriched_nodes.append({
                "id": n["id"],
                "name": n["name"],
                "type": n.get("type"),
                "lat": n.get("lat_lng", {}).get("lat"),
                "lng": n.get("lat_lng", {}).get("lng"),
                "arrival_time": n.get("arrival_time"),
                "departure_time": n.get("departure_time"),
                "duration_minutes": n.get("duration_minutes"),
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
                "settings": trip_data.get("settings") or {},
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
        # Fetch user profiles in parallel to check location_tracking_enabled
        # and get display names.
        user_ids = [loc.get("user_id") for loc in locations if loc.get("user_id")]
        user_profiles: dict[str, Any] = await self._user_repo.get_users_by_ids(
            user_ids
        )

        # Build list of nodes with lat/lng for distance computation
        node_points = []
        for n in nodes_raw:
            lat_lng = n.get("lat_lng", {})
            if lat_lng and lat_lng.get("lat") is not None:
                node_points.append({
                    "name": n.get("name", "Unknown"),
                    "lat": lat_lng["lat"],
                    "lng": lat_lng["lng"],
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
                d = haversine_m(lat, lng, np["lat"], np["lng"]) / 1000
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

    # ---- Actions -------------------------------------------------------------

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
