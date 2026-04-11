"""Preference repository for agent-extracted travel rules."""

from shared.models import Preference
from shared.repositories.base_repository import BaseRepository


class PreferenceRepository(BaseRepository):
    """CRUD for trips/{trip_id}/preferences subcollection."""

    @property
    def collection_path(self) -> str:
        return "trips/{trip_id}/preferences"

    async def create_preference(self, trip_id: str, preference: Preference) -> dict:
        return await self.create(preference, trip_id=trip_id)

    async def batch_create_preferences(
        self, trip_id: str, preferences: list[Preference]
    ) -> list[dict]:
        """Create multiple preferences in a single Firestore batch write."""
        if not preferences:
            return []
        collection = self._collection(trip_id=trip_id)
        results: list[dict] = []
        batch_size = 500
        for i in range(0, len(preferences), batch_size):
            chunk = preferences[i : i + batch_size]
            batch = self._db.batch()
            for pref in chunk:
                doc_dict = pref.model_dump(mode="json")
                batch.set(collection.document(pref.id), doc_dict)
                results.append(doc_dict)
            await batch.commit()
        return results

    async def list_by_trip(self, trip_id: str) -> list[dict]:
        return await self.list_all(trip_id=trip_id)
