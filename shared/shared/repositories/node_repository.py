from typing import Any

from google.cloud.firestore import AsyncClient

from shared.models import Node
from shared.repositories.base_repository import BaseRepository


class NodeRepository(BaseRepository):
    collection_path = "trips/{trip_id}/plans/{plan_id}/nodes"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_node(
        self, trip_id: str, plan_id: str, node: Node
    ) -> dict[str, Any]:
        return await self.create(node, trip_id=trip_id, plan_id=plan_id)

    async def get_node(
        self, trip_id: str, plan_id: str, node_id: str
    ) -> Node | None:
        data = await self.get(node_id, trip_id=trip_id, plan_id=plan_id)
        if data is None:
            return None
        return Node(**data)

    async def get_node_or_raise(
        self, trip_id: str, plan_id: str, node_id: str
    ) -> Node:
        data = await self.get_or_raise(node_id, trip_id=trip_id, plan_id=plan_id)
        return Node(**data)

    async def list_by_plan(
        self, trip_id: str, plan_id: str
    ) -> list[dict[str, Any]]:
        return await self.list_all(trip_id=trip_id, plan_id=plan_id)

    async def update_node(
        self, trip_id: str, plan_id: str, node_id: str, updates: dict[str, Any]
    ) -> None:
        await self.update(node_id, updates, trip_id=trip_id, plan_id=plan_id)

    async def delete_node(
        self, trip_id: str, plan_id: str, node_id: str
    ) -> None:
        await self.delete(node_id, trip_id=trip_id, plan_id=plan_id)

    async def batch_create(
        self, trip_id: str, plan_id: str, nodes: list[Node]
    ) -> list[dict[str, Any]]:
        """Create multiple nodes in a batch write."""
        batch = self._db.batch()
        results = []
        for node in nodes:
            doc_dict = node.model_dump(mode="json")
            doc_ref = self._collection(
                trip_id=trip_id, plan_id=plan_id
            ).document(node.id)
            batch.set(doc_ref, doc_dict)
            results.append(doc_dict)
        await batch.commit()
        return results
