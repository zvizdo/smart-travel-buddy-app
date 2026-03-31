"""Plan service: deep clone plans, promote alternatives, manage plan versions."""

import asyncio
from datetime import UTC, datetime

from backend.src.services.notification_service import NotificationService
from shared.tools.id_gen import action_id, edge_id, node_id, plan_id

from shared.models import (
    Action,
    Edge,
    Node,
    NotificationType,
    Plan,
    PlanStatus,
    RelatedEntity,
)
from shared.repositories.action_repository import ActionRepository
from shared.repositories.edge_repository import EdgeRepository
from shared.repositories.node_repository import NodeRepository
from shared.repositories.plan_repository import PlanRepository
from shared.repositories.trip_repository import TripRepository


class PlanService:
    def __init__(
        self,
        trip_repo: TripRepository,
        plan_repo: PlanRepository,
        node_repo: NodeRepository,
        edge_repo: EdgeRepository,
        notification_service: NotificationService,
        action_repo: ActionRepository,
    ):
        self._trip_repo = trip_repo
        self._plan_repo = plan_repo
        self._node_repo = node_repo
        self._edge_repo = edge_repo
        self._notification_service = notification_service
        self._action_repo = action_repo

    async def clone_plan(
        self,
        trip_id: str,
        source_plan_id: str,
        name: str,
        created_by: str,
        include_actions: bool = False,
    ) -> dict:
        """Deep clone a plan: copy all nodes and edges with new IDs.

        The cloned plan starts as a draft.
        When include_actions is True, also copies all actions under each node.
        """
        # Verify source plan exists
        await self._plan_repo.get_plan_or_raise(trip_id, source_plan_id)

        # Load all nodes and edges from source plan
        source_nodes = await self._node_repo.list_by_plan(trip_id, source_plan_id)
        source_edges = await self._edge_repo.list_by_plan(trip_id, source_plan_id)

        # Create new plan
        new_plan = Plan(
            id=plan_id(),
            name=name,
            status=PlanStatus.DRAFT,
            created_by=created_by,
            parent_plan_id=source_plan_id,
            created_at=datetime.now(UTC),
        )
        await self._plan_repo.create_plan(trip_id, new_plan)

        # Build node ID mapping (old -> new) for edge remapping
        node_id_map: dict[str, str] = {}
        new_nodes: list[Node] = []
        for n in source_nodes:
            new_id = node_id()
            node_id_map[n["id"]] = new_id
            new_nodes.append(Node(
                **{**n, "id": new_id, "created_at": datetime.now(UTC), "updated_at": datetime.now(UTC)},
            ))

        # Clone edges with remapped node IDs
        new_edges: list[Edge] = []
        for e in source_edges:
            new_from = node_id_map.get(e["from_node_id"], e["from_node_id"])
            new_to = node_id_map.get(e["to_node_id"], e["to_node_id"])
            new_edges.append(Edge(
                id=edge_id(),
                from_node_id=new_from,
                to_node_id=new_to,
                travel_mode=e["travel_mode"],
                travel_time_hours=e.get("travel_time_hours", 0),
                distance_km=e.get("distance_km"),
                route_polyline=e.get("route_polyline"),
            ))

        # Batch write cloned nodes and edges
        if new_nodes:
            await self._node_repo.batch_create(trip_id, new_plan.id, new_nodes)
        if new_edges:
            await self._edge_repo.batch_create(trip_id, new_plan.id, new_edges)

        # Clone actions if requested
        actions_cloned = 0
        if include_actions:
            for old_node_id, new_node_id in node_id_map.items():
                source_actions = await self._action_repo.list_by_node(
                    trip_id, source_plan_id, old_node_id
                )
                for a in source_actions:
                    new_action = Action(
                        **{
                            **a,
                            "id": action_id(),
                            "created_at": datetime.now(UTC),
                        },
                    )
                    await self._action_repo.create_action(
                        trip_id, new_plan.id, new_node_id, new_action
                    )
                    actions_cloned += 1

        return {
            "plan": new_plan.model_dump(mode="json"),
            "nodes_cloned": len(new_nodes),
            "edges_cloned": len(new_edges),
            "actions_cloned": actions_cloned,
        }

    async def promote_plan(
        self,
        trip_id: str,
        plan_id: str,
        promoted_by: str,
    ) -> dict:
        """Promote a plan to active. Demote the current active plan to draft.

        Sends plan_promoted notification to all participants.
        """
        trip = await self._trip_repo.get_trip_or_raise(trip_id)

        # Verify plan exists and isn't already active
        plan = await self._plan_repo.get_plan_or_raise(trip_id, plan_id)
        if plan.status == PlanStatus.ACTIVE and plan.id == trip.active_plan_id:
            raise ValueError("This plan is already the active plan")

        previous_active_id = trip.active_plan_id

        # Demote the current active plan to draft so it can be promoted again later
        if previous_active_id:
            await self._plan_repo.update_plan(
                trip_id, previous_active_id, {"status": PlanStatus.DRAFT.value}
            )

        # Promote the new plan
        await self._plan_repo.update_plan(
            trip_id, plan_id, {"status": PlanStatus.ACTIVE.value}
        )
        await self._trip_repo.update_trip(trip_id, {
            "active_plan_id": plan_id,
            "updated_at": datetime.now(UTC).isoformat(),
        })

        # Notify all participants
        participant_ids = list(trip.participants.keys())
        if participant_ids:
            await self._notification_service.create_notification(
                trip_id=trip_id,
                notification_type=NotificationType.PLAN_PROMOTED,
                message=f"Plan '{plan.name}' has been promoted to the active plan",
                target_user_ids=participant_ids,
                related_entity=RelatedEntity(type="plan", id=plan_id),
            )

        return {
            "plan_id": plan_id,
            "status": "active",
            "previous_active": previous_active_id,
        }

    async def delete_plan(
        self,
        trip_id: str,
        plan_id: str,
    ) -> None:
        """Delete a non-active plan and all its nodes, edges, and actions."""
        trip = await self._trip_repo.get_trip_or_raise(trip_id)
        if trip.active_plan_id == plan_id:
            raise ValueError("Cannot delete the active plan")

        # Verify plan exists
        await self._plan_repo.get_plan_or_raise(trip_id, plan_id)

        # Phase 1: Parallel reads
        edges, nodes = await asyncio.gather(
            self._edge_repo.list_by_plan(trip_id, plan_id),
            self._node_repo.list_by_plan(trip_id, plan_id),
        )
        action_lists = await asyncio.gather(
            *[
                self._action_repo.list_by_node(trip_id, plan_id, n["id"])
                for n in nodes
            ]
        ) if nodes else []

        # Phase 2: Collect all document refs for batched delete
        refs = []
        edge_col = self._edge_repo._collection(trip_id=trip_id, plan_id=plan_id)
        for e in edges:
            refs.append(edge_col.document(e["id"]))

        node_col = self._node_repo._collection(trip_id=trip_id, plan_id=plan_id)
        for node, actions in zip(nodes, action_lists):
            action_col = self._action_repo._collection(
                trip_id=trip_id, plan_id=plan_id, node_id=node["id"]
            )
            for a in actions:
                refs.append(action_col.document(a["id"]))
            refs.append(node_col.document(node["id"]))

        # Plan doc last — if a batch fails mid-way, plan still exists for retry
        refs.append(
            self._plan_repo._collection(trip_id=trip_id).document(plan_id)
        )

        # Phase 3: Chunked batch commits (Firestore limit: 500 ops per batch)
        batch_size = 500
        db = self._node_repo._db
        for i in range(0, len(refs), batch_size):
            batch = db.batch()
            for ref in refs[i : i + batch_size]:
                batch.delete(ref)
            await batch.commit()

    async def list_plans(self, trip_id: str) -> list[dict]:
        """List all plans for a trip."""
        return await self._plan_repo.list_by_trip(trip_id)
