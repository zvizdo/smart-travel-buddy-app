from typing import Any

from backend.src.repositories.base_repository import BaseRepository
from google.cloud.firestore import AsyncClient

from shared.models import Plan


class PlanRepository(BaseRepository):
    collection_path = "trips/{trip_id}/plans"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_plan(self, trip_id: str, plan: Plan) -> dict[str, Any]:
        return await self.create(plan, trip_id=trip_id)

    async def get_plan(self, trip_id: str, plan_id: str) -> Plan | None:
        data = await self.get(plan_id, trip_id=trip_id)
        if data is None:
            return None
        return Plan(**data)

    async def get_plan_or_raise(self, trip_id: str, plan_id: str) -> Plan:
        data = await self.get_or_raise(plan_id, trip_id=trip_id)
        return Plan(**data)

    async def list_by_trip(self, trip_id: str) -> list[dict[str, Any]]:
        return await self.list_all(trip_id=trip_id)

    async def update_plan(
        self, trip_id: str, plan_id: str, updates: dict[str, Any]
    ) -> None:
        await self.update(plan_id, updates, trip_id=trip_id)
