from typing import Any

from google.cloud.firestore import AsyncClient
from google.cloud.firestore_v1.base_query import FieldFilter

from shared.models import InviteLink
from shared.repositories.base_repository import BaseRepository


class InviteLinkRepository(BaseRepository):
    collection_path = "trips/{trip_id}/invite_links"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_invite(
        self, trip_id: str, invite: InviteLink
    ) -> dict[str, Any]:
        return await self.create(invite, trip_id=trip_id)

    async def get_invite(
        self, trip_id: str, token: str
    ) -> InviteLink | None:
        data = await self.get(token, trip_id=trip_id)
        if data is None:
            return None
        return InviteLink(**data)

    async def get_invite_or_raise(
        self, trip_id: str, token: str
    ) -> InviteLink:
        data = await self.get_or_raise(token, trip_id=trip_id)
        return InviteLink(**data)

    async def deactivate(self, trip_id: str, token: str) -> None:
        await self.update(token, {"is_active": False}, trip_id=trip_id)

    async def get_by_token_global(self, token: str) -> tuple[str, InviteLink] | None:
        """Search across all trips for an invite by token ID.

        Returns (trip_id, invite) or None. Uses collection group query.
        """
        query = self._db.collection_group("invite_links").where(filter=FieldFilter("id", "==", token))
        async for doc in query.stream():
            path_parts = doc.reference.path.split("/")
            trip_id = path_parts[1]
            return trip_id, InviteLink(**doc.to_dict())
        return None
