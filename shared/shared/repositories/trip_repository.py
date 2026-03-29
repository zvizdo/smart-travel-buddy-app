from typing import Any

from google.cloud.firestore import AsyncClient

from shared.models import Trip
from shared.repositories.base_repository import BaseRepository


class TripRepository(BaseRepository):
    collection_path = "trips"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create(self, trip: Trip, **path_params: str) -> dict[str, Any]:
        return await super().create(trip)

    async def get_trip(self, trip_id: str) -> Trip | None:
        data = await self.get(trip_id)
        if data is None:
            return None
        return Trip(**data)

    async def get_trip_or_raise(self, trip_id: str) -> Trip:
        data = await self.get_or_raise(trip_id)
        return Trip(**data)

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """List all trips where the user is a participant."""
        from google.cloud.firestore_v1.base_query import FieldFilter

        docs = self._collection().where(
            filter=FieldFilter(f"participants.{user_id}.role", ">=", "")
        ).stream()
        return [doc.to_dict() async for doc in docs]

    async def update_trip(self, trip_id: str, updates: dict[str, Any]) -> None:
        await self.update(trip_id, updates)
