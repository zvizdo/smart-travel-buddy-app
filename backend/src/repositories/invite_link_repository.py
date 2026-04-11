from typing import Any

from google.cloud.firestore import AsyncClient

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

