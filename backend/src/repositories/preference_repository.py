"""Preference repository for agent-extracted travel rules."""

from backend.src.repositories.base_repository import BaseRepository

from shared.models import Preference


class PreferenceRepository(BaseRepository):
    """CRUD for trips/{trip_id}/preferences subcollection."""

    @property
    def collection_path(self) -> str:
        return "trips/{trip_id}/preferences"

    async def create_preference(self, trip_id: str, preference: Preference) -> dict:
        return await self.create(preference, trip_id=trip_id)

    async def list_by_trip(self, trip_id: str) -> list[dict]:
        return await self.list_all(trip_id=trip_id)
