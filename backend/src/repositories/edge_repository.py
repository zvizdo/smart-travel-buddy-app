from typing import Any

from backend.src.repositories.base_repository import BaseRepository
from google.cloud.firestore import AsyncClient

from shared.models import Edge


class EdgeRepository(BaseRepository):
    collection_path = "trips/{trip_id}/plans/{plan_id}/edges"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_edge(
        self, trip_id: str, plan_id: str, edge: Edge
    ) -> dict[str, Any]:
        return await self.create(edge, trip_id=trip_id, plan_id=plan_id)

    async def get_edge(
        self, trip_id: str, plan_id: str, edge_id: str
    ) -> Edge | None:
        data = await self.get(edge_id, trip_id=trip_id, plan_id=plan_id)
        if data is None:
            return None
        return Edge(**data)

    async def list_by_plan(
        self, trip_id: str, plan_id: str
    ) -> list[dict[str, Any]]:
        return await self.list_all(trip_id=trip_id, plan_id=plan_id)

    async def update_edge(
        self, trip_id: str, plan_id: str, edge_id: str, updates: dict[str, Any]
    ) -> None:
        await self.update(edge_id, updates, trip_id=trip_id, plan_id=plan_id)

    async def delete_edge(
        self, trip_id: str, plan_id: str, edge_id: str
    ) -> None:
        await self.delete(edge_id, trip_id=trip_id, plan_id=plan_id)

    async def batch_create(
        self, trip_id: str, plan_id: str, edges: list[Edge]
    ) -> list[dict[str, Any]]:
        """Create multiple edges in a batch write."""
        batch = self._db.batch()
        results = []
        for edge in edges:
            doc_dict = edge.model_dump(mode="json")
            doc_ref = self._collection(
                trip_id=trip_id, plan_id=plan_id
            ).document(edge.id)
            batch.set(doc_ref, doc_dict)
            results.append(doc_dict)
        await batch.commit()
        return results
