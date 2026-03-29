from typing import Any

from backend.src.repositories.base_repository import BaseRepository
from google.cloud.firestore import AsyncClient

from shared.models import Location


class LocationRepository(BaseRepository):
    collection_path = "trips/{trip_id}/locations"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def upsert(self, trip_id: str, location: Location) -> dict[str, Any]:
        """Upsert a location document using user_id as the document ID."""
        doc_dict = location.model_dump(mode="json")
        doc_ref = self._collection(trip_id=trip_id).document(location.user_id)
        await doc_ref.set(doc_dict)
        return doc_dict

    async def get_all_locations(self, trip_id: str) -> list[dict[str, Any]]:
        """Get all participant locations for a trip."""
        return await self.list_all(trip_id=trip_id)
