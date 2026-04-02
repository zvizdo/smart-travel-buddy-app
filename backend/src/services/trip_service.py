"""Trip service: create and retrieve trips with participant checks."""

import asyncio
from datetime import UTC, datetime

from google.cloud.firestore_v1.transforms import DELETE_FIELD

from backend.src.errors import ConflictError
from backend.src.repositories.invite_link_repository import InviteLinkRepository
from backend.src.repositories.notification_repository import NotificationRepository
from backend.src.repositories.preference_repository import PreferenceRepository
from shared.models import Participant, Trip, TripRole
from shared.repositories.action_repository import ActionRepository
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.location_repository import LocationRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.trip_repository import TripRepository
from shared.tools.id_gen import trip_id


class TripService:
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        action_repo: ActionRepository,
        notification_repo: NotificationRepository,
        location_repo: LocationRepository,
        invite_link_repo: InviteLinkRepository,
        preference_repo: PreferenceRepository,
    ):
        self._trip_repo = trip_repo
        self._plan_repo = plan_repo
        self._node_repo = node_repo
        self._edge_repo = edge_repo
        self._action_repo = action_repo
        self._notification_repo = notification_repo
        self._location_repo = location_repo
        self._invite_link_repo = invite_link_repo
        self._preference_repo = preference_repo

    async def create_trip(
        self, name: str, user_id: str, user_display_name: str = ""
    ) -> Trip:
        """Create a new trip. The caller becomes Admin."""
        trip = Trip(
            id=trip_id(),
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
        return trip

    async def get_trip(self, trip_id: str, user_id: str) -> Trip:
        """Get a trip, verifying the user is a participant."""
        trip = await self._trip_repo.get_trip_or_raise(trip_id)
        if user_id not in trip.participants:
            raise PermissionError("You are not a participant of this trip")
        return trip

    async def delete_trip(self, trip_id: str, user_id: str) -> None:
        """Delete a trip and all subcollections.

        Performs a cascading delete in phases:
        1. List all top-level subcollections in parallel.
        2. For each plan, list nested nodes/edges; for each node, list actions.
        3. Collect all document refs (innermost first for safe retry).
        4. Chunked batch delete (500 ops per Firestore batch).
        """
        trip = await self.get_trip(trip_id, user_id)
        if (
            trip.participants.get(user_id) is None
            or trip.participants[user_id].role != TripRole.ADMIN
        ):
            raise PermissionError("Only the trip admin can delete this trip")

        # Phase 1: Parallel list all top-level subcollections
        plans, notifications, locations, invite_links, preferences = (
            await asyncio.gather(
                self._plan_repo.list_all(trip_id=trip_id),
                self._notification_repo.list_all(trip_id=trip_id),
                self._location_repo.list_all(trip_id=trip_id),
                self._invite_link_repo.list_all(trip_id=trip_id),
                self._preference_repo.list_all(trip_id=trip_id),
            )
        )

        # Phase 2: For each plan, list nodes and edges in parallel
        plan_nodes_edges = await asyncio.gather(
            *[
                asyncio.gather(
                    self._node_repo.list_by_plan(trip_id, p["id"]),
                    self._edge_repo.list_by_plan(trip_id, p["id"]),
                )
                for p in plans
            ]
        ) if plans else []

        # For each plan's nodes, list actions in parallel
        plan_actions: list[list[list[dict]]] = []
        for nodes, _edges in plan_nodes_edges:
            if nodes:
                actions_per_node = await asyncio.gather(
                    *[
                        self._action_repo.list_by_node(
                            trip_id, plans[len(plan_actions)]["id"], n["id"]
                        )
                        for n in nodes
                    ]
                )
                plan_actions.append(list(actions_per_node))
            else:
                plan_actions.append([])

        # Phase 3: Collect all document refs (innermost first)
        refs = []

        for plan_idx, plan in enumerate(plans):
            plan_id = plan["id"]
            nodes, edges = plan_nodes_edges[plan_idx]
            actions_lists = plan_actions[plan_idx]

            # Actions (innermost)
            for node, actions in zip(nodes, actions_lists):
                action_col = self._action_repo._collection(
                    trip_id=trip_id, plan_id=plan_id, node_id=node["id"]
                )
                for a in actions:
                    refs.append(action_col.document(a["id"]))

            # Edges
            edge_col = self._edge_repo._collection(
                trip_id=trip_id, plan_id=plan_id
            )
            for e in edges:
                refs.append(edge_col.document(e["id"]))

            # Nodes
            node_col = self._node_repo._collection(
                trip_id=trip_id, plan_id=plan_id
            )
            for n in nodes:
                refs.append(node_col.document(n["id"]))

            # Plan doc
            refs.append(
                self._plan_repo._collection(trip_id=trip_id).document(plan_id)
            )

        # Notifications
        notif_col = self._notification_repo._collection(trip_id=trip_id)
        for n in notifications:
            refs.append(notif_col.document(n["id"]))

        # Locations
        loc_col = self._location_repo._collection(trip_id=trip_id)
        for loc in locations:
            refs.append(loc_col.document(loc["id"]))

        # Invite links
        invite_col = self._invite_link_repo._collection(trip_id=trip_id)
        for inv in invite_links:
            refs.append(invite_col.document(inv["id"]))

        # Preferences
        pref_col = self._preference_repo._collection(trip_id=trip_id)
        for pref in preferences:
            refs.append(pref_col.document(pref["id"]))

        # Trip document last — if a batch fails mid-way, trip still exists for retry
        refs.append(self._trip_repo._collection().document(trip_id))

        # Phase 4: Chunked batch delete (Firestore limit: 500 ops per batch)
        batch_size = 500
        db = self._trip_repo._db
        for i in range(0, len(refs), batch_size):
            batch = db.batch()
            for ref in refs[i : i + batch_size]:
                batch.delete(ref)
            await batch.commit()

    async def list_trips(self, user_id: str) -> list[dict]:
        """List all trips for a user, including their role."""
        trips = await self._trip_repo.list_by_user(user_id)
        results = []
        for t in trips:
            participant = t.get("participants", {}).get(user_id, {})
            results.append({
                "id": t["id"],
                "name": t["name"],
                "role": participant.get("role"),
                "active_plan_id": t.get("active_plan_id"),
            })
        return results

    async def remove_participant(
        self, trip_id: str, target_user_id: str, actor_user_id: str
    ) -> dict:
        """Remove a participant from a trip.

        Admins can remove anyone. Any participant can remove themselves (leave).
        Cleans up participant_ids on all nodes and deletes location data.
        """
        from backend.src.auth.permissions import require_role

        trip = await self.get_trip(trip_id, actor_user_id)

        if actor_user_id != target_user_id:
            require_role(trip, actor_user_id, TripRole.ADMIN)

        if target_user_id not in trip.participants:
            raise LookupError(f"User {target_user_id} is not a participant of this trip")

        # Last-admin guard
        if trip.participants[target_user_id].role == TripRole.ADMIN:
            admin_count = sum(
                1 for p in trip.participants.values() if p.role == TripRole.ADMIN
            )
            if admin_count <= 1:
                raise ConflictError(
                    "Cannot remove the last admin. Promote another participant to admin first, or delete the trip."
                )

        # Node cleanup: remove target from participant_ids across all plans
        plans = await self._plan_repo.list_all(trip_id=trip_id)
        nodes_cleaned = 0

        if plans:
            nodes_per_plan = await asyncio.gather(
                *[self._node_repo.list_by_plan(trip_id, p["id"]) for p in plans]
            )

            db = self._trip_repo._db
            batch = db.batch()
            batch_count = 0

            for plan, nodes in zip(plans, nodes_per_plan):
                plan_id = plan["id"]
                for node in nodes:
                    pids = node.get("participant_ids")
                    if pids and target_user_id in pids:
                        new_pids = [pid for pid in pids if pid != target_user_id]
                        node_ref = self._node_repo._collection(
                            trip_id=trip_id, plan_id=plan_id
                        ).document(node["id"])
                        batch.update(node_ref, {
                            "participant_ids": new_pids if new_pids else None
                        })
                        batch_count += 1
                        nodes_cleaned += 1

                        if batch_count >= 500:
                            await batch.commit()
                            batch = db.batch()
                            batch_count = 0

            if batch_count > 0:
                await batch.commit()

        # Location cleanup
        try:
            await self._location_repo.delete(target_user_id, trip_id=trip_id)
        except Exception:
            pass  # Location doc may not exist

        # Remove from trip participants map
        await self._trip_repo.update_trip(trip_id, {
            f"participants.{target_user_id}": DELETE_FIELD,
            "updated_at": datetime.now(UTC).isoformat(),
        })

        return {
            "removed_user_id": target_user_id,
            "self_removal": actor_user_id == target_user_id,
            "nodes_cleaned": nodes_cleaned,
        }

    async def change_participant_role(
        self, trip_id: str, target_user_id: str, new_role: str, actor_user_id: str
    ) -> dict:
        """Change a participant's role. Admin only. Cannot change own role."""
        from backend.src.auth.permissions import require_role

        trip = await self.get_trip(trip_id, actor_user_id)
        require_role(trip, actor_user_id, TripRole.ADMIN)

        if actor_user_id == target_user_id:
            raise ValueError("Cannot change your own role")

        if target_user_id not in trip.participants:
            raise LookupError(f"User {target_user_id} is not a participant of this trip")

        new_role_enum = TripRole(new_role)

        # Last-admin guard: prevent demoting the sole admin
        if (
            trip.participants[target_user_id].role == TripRole.ADMIN
            and new_role_enum != TripRole.ADMIN
        ):
            admin_count = sum(
                1 for p in trip.participants.values() if p.role == TripRole.ADMIN
            )
            if admin_count <= 1:
                raise ConflictError(
                    "Cannot demote the last admin. Promote another participant to admin first."
                )

        await self._trip_repo.update_trip(trip_id, {
            f"participants.{target_user_id}.role": new_role_enum.value,
            "updated_at": datetime.now(UTC).isoformat(),
        })

        return {"user_id": target_user_id, "new_role": new_role_enum.value}
