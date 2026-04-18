"""Shared trip lifecycle service.

Holds the logic that backend and MCP both need: create_trip, get_trip (with
participant auth), list_trips, update_trip_settings, and the cascading
delete_trip. Callers subclass to add their own extras (backend: participant
management; MCP: read-context helpers and the bundled Main Route plan on
create).

Notification/invite/preference repositories are optional — a caller that
doesn't inject them skips those subcollections during cascading delete.
"""

import asyncio
from datetime import UTC, datetime

from shared.models import Participant, Trip, TripRole
from shared.repositories.action_repository import ActionRepository
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.invite_link_repository import InviteLinkRepository
from shared.repositories.location_repository import LocationRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.notification_repository import NotificationRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.preference_repository import PreferenceRepository
from shared.repositories.trip_repository import TripRepository
from shared.tools.id_gen import trip_id as gen_trip_id


class TripService:
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        action_repo: ActionRepository,
        location_repo: LocationRepository,
        notification_repo: NotificationRepository | None = None,
        invite_link_repo: InviteLinkRepository | None = None,
        preference_repo: PreferenceRepository | None = None,
    ):
        self._trip_repo = trip_repo
        self._plan_repo = plan_repo
        self._node_repo = node_repo
        self._edge_repo = edge_repo
        self._action_repo = action_repo
        self._location_repo = location_repo
        self._notification_repo = notification_repo
        self._invite_link_repo = invite_link_repo
        self._preference_repo = preference_repo

    async def create_trip(
        self, name: str, user_id: str, user_display_name: str = ""
    ) -> Trip:
        """Create a new trip. The caller becomes Admin."""
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
        return trip

    async def get_trip(self, trip_id: str, user_id: str) -> Trip:
        """Get a trip, verifying the user is a participant."""
        trip = await self._trip_repo.get_trip_or_raise(trip_id)
        if user_id not in trip.participants:
            raise PermissionError("You are not a participant of this trip")
        return trip

    # ---- Role gates (used by both backend callers and MCP tool helpers) -----
    # These three methods are intentionally part of the public API despite the
    # authorization-sensitive nature of the checks: MCP's gate helpers in
    # mcpserver/src/tools/_helpers.py call them directly. Do NOT prefix with
    # underscore or delete during refactors — see the regression history in
    # shared/tests/test_trip_service_role_gates.py.

    def verify_participant(self, trip: dict, user_id: str) -> str:
        """Return the caller's role string, or raise PermissionError."""
        participants = trip.get("participants", {})
        entry = participants.get(user_id)
        if entry is None:
            raise PermissionError("You are not a participant of this trip")
        return entry["role"]

    def require_editor(self, role: str) -> None:
        """Allow admin + planner. Raise PermissionError otherwise."""
        if role not in (TripRole.ADMIN.value, TripRole.PLANNER.value):
            raise PermissionError(
                "This action requires one of the following roles: admin, planner"
            )

    def require_admin(self, role: str) -> None:
        """Allow admin only. Raise PermissionError otherwise."""
        if role != TripRole.ADMIN.value:
            raise PermissionError(
                "This action requires the admin role"
            )

    async def resolve_participant(
        self, trip_id: str, user_id: str
    ) -> tuple[dict, str]:
        """Fetch the trip as a dict, verify participation, return (trip, role).

        Consolidates the "load trip + gate" pattern that both the MCP tool
        helpers and this service's own methods were duplicating.
        """
        trip_data = await self._trip_repo.get_or_raise(trip_id)
        role = self.verify_participant(trip_data, user_id)
        return trip_data, role

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

    async def update_trip_settings(
        self,
        trip_id: str,
        user_id: str,
        *,
        datetime_format: str | None = None,
        date_format: str | None = None,
        distance_unit: str | None = None,
        no_drive_window: dict | None = None,
        clear_no_drive_window: bool = False,
        max_drive_hours_per_day: float | None = None,
        clear_max_drive_hours: bool = False,
    ) -> dict:
        """Merge + persist trip-level settings. Admin only.

        The ``clear_*`` booleans distinguish "explicitly disable" from "leave
        unchanged" — Firestore's nested ``settings`` dict is replaced wholesale,
        so we must rebuild it from the stored value on every write.
        """
        trip = await self.get_trip(trip_id, user_id)
        if trip.participants[user_id].role != TripRole.ADMIN:
            raise PermissionError("Only the trip admin can update settings")

        current = trip.settings.model_dump()
        if datetime_format is not None:
            current["datetime_format"] = datetime_format
        if date_format is not None:
            current["date_format"] = date_format
        if distance_unit is not None:
            current["distance_unit"] = distance_unit
        if clear_no_drive_window:
            current["no_drive_window"] = None
        elif no_drive_window is not None:
            current["no_drive_window"] = no_drive_window
        if clear_max_drive_hours:
            current["max_drive_hours_per_day"] = None
        elif max_drive_hours_per_day is not None:
            current["max_drive_hours_per_day"] = max_drive_hours_per_day

        await self._trip_repo.update(trip_id, {"settings": current})
        return current

    async def delete_trip(self, trip_id: str, user_id: str) -> None:
        """Cascading delete of a trip and every subcollection. Admin only.

        Performs a cascading delete in phases:
        1. List all top-level subcollections in parallel.
        2. For each plan, list nested nodes/edges; for each node, list actions.
        3. Collect all document refs (innermost first for safe retry).
        4. Chunked batch delete (500 ops per Firestore batch).

        Notification/invite/preference subcollections are purged only when the
        corresponding repo was injected.
        """
        trip = await self.get_trip(trip_id, user_id)
        if trip.participants[user_id].role != TripRole.ADMIN:
            raise PermissionError("Only the trip admin can delete this trip")

        # Phase 1: Parallel list all top-level subcollections
        top_level_tasks = [
            self._plan_repo.list_all(trip_id=trip_id),
            self._location_repo.list_all(trip_id=trip_id),
        ]
        if self._notification_repo is not None:
            top_level_tasks.append(self._notification_repo.list_all(trip_id=trip_id))
        if self._invite_link_repo is not None:
            top_level_tasks.append(self._invite_link_repo.list_all(trip_id=trip_id))
        if self._preference_repo is not None:
            top_level_tasks.append(self._preference_repo.list_all(trip_id=trip_id))

        results = await asyncio.gather(*top_level_tasks)
        plans, locations = results[0], results[1]
        idx = 2
        notifications = (
            results[idx] if self._notification_repo is not None else []
        )
        if self._notification_repo is not None:
            idx += 1
        invite_links = (
            results[idx] if self._invite_link_repo is not None else []
        )
        if self._invite_link_repo is not None:
            idx += 1
        preferences = (
            results[idx] if self._preference_repo is not None else []
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

        # Phase 3: Collect all document refs (innermost first)
        refs = []

        for plan_idx, plan in enumerate(plans):
            plan_id = plan["id"]
            nodes, edges = plan_nodes_edges[plan_idx]
            actions_lists = plan_actions[plan_idx]

            # Actions (innermost)
            for node, actions in zip(nodes, actions_lists, strict=True):
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

        if self._notification_repo is not None:
            notif_col = self._notification_repo._collection(trip_id=trip_id)
            for n in notifications:
                refs.append(notif_col.document(n["id"]))

        loc_col = self._location_repo._collection(trip_id=trip_id)
        for loc in locations:
            refs.append(loc_col.document(loc["id"]))

        if self._invite_link_repo is not None:
            invite_col = self._invite_link_repo._collection(trip_id=trip_id)
            for inv in invite_links:
                refs.append(invite_col.document(inv["id"]))

        if self._preference_repo is not None:
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

        # Trip doc was deleted via the batch, bypassing the repo's
        # cache-invalidating wrappers. Drop the cached entry so a future
        # read on the same instance doesn't return a ghost trip.
        self._trip_repo.invalidate(trip_id)
