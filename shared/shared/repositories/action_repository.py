"""Repository for node actions (notes, todos, places)."""

from typing import Any

from google.cloud.firestore import AsyncClient

from shared.models import Action
from shared.repositories.base_repository import BaseRepository


class ActionRepository(BaseRepository):
    collection_path = "trips/{trip_id}/plans/{plan_id}/nodes/{node_id}/actions"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_action(
        self, trip_id: str, plan_id: str, node_id: str, action: Action
    ) -> dict[str, Any]:
        return await self.create(
            action, trip_id=trip_id, plan_id=plan_id, node_id=node_id
        )

    async def list_by_node(
        self, trip_id: str, plan_id: str, node_id: str
    ) -> list[dict[str, Any]]:
        return await self.list_all(
            trip_id=trip_id, plan_id=plan_id, node_id=node_id
        )

    async def update_action(
        self, trip_id: str, plan_id: str, node_id: str, action_id: str,
        updates: dict[str, Any]
    ) -> None:
        await self.update(
            action_id, updates,
            trip_id=trip_id, plan_id=plan_id, node_id=node_id
        )

    async def delete_action(
        self, trip_id: str, plan_id: str, node_id: str, action_id: str,
    ) -> None:
        await self.delete(
            action_id,
            trip_id=trip_id, plan_id=plan_id, node_id=node_id
        )
