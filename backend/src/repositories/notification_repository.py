from typing import Any

from backend.src.repositories.base_repository import BaseRepository
from google.cloud.firestore import AsyncClient

from shared.models import Notification


class NotificationRepository(BaseRepository):
    collection_path = "trips/{trip_id}/notifications"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_notification(
        self, trip_id: str, notification: Notification
    ) -> dict[str, Any]:
        return await self.create(notification, trip_id=trip_id)

    async def list_by_user(
        self, trip_id: str, user_id: str, unread_only: bool = False
    ) -> list[dict[str, Any]]:
        coll = self._collection(trip_id=trip_id)
        q = coll.where("target_user_ids", "array_contains", user_id)
        docs = [doc.to_dict() async for doc in q.stream()]
        if unread_only:
            docs = [d for d in docs if user_id not in d.get("read_by", [])]
        docs.sort(key=lambda d: d.get("created_at", ""), reverse=True)
        return docs

    async def mark_read(
        self, trip_id: str, notification_id: str, user_id: str
    ) -> None:
        from google.cloud.firestore import ArrayUnion

        await self.update(
            notification_id,
            {"read_by": ArrayUnion([user_id])},
            trip_id=trip_id,
        )
