"""Backend trip service.

Extends the shared ``TripService`` with backend-only participant-management
methods. Lifecycle (create/get/list/delete/update_settings) lives in
``shared/shared/services/trip_service.py`` and is reused verbatim.
"""

import asyncio
from datetime import UTC, datetime

from backend.src.errors import ConflictError
from google.cloud.firestore_v1.transforms import DELETE_FIELD

from shared.models import TripRole
from shared.repositories.action_repository import ActionRepository
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.invite_link_repository import InviteLinkRepository
from shared.repositories.location_repository import LocationRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.notification_repository import NotificationRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.preference_repository import PreferenceRepository
from shared.repositories.trip_repository import TripRepository
from shared.services.trip_service import TripService as SharedTripService


class TripService(SharedTripService):
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

            for plan, nodes in zip(plans, nodes_per_plan, strict=True):
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

        # Location cleanup. Firestore delete is idempotent, so a missing doc
        # is a no-op — any error here should propagate instead of leaving
        # the removed participant's location data behind.
        await self._location_repo.delete(target_user_id, trip_id=trip_id)

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
