from typing import Any

from google.cloud.firestore import AsyncClient

from shared.models import ApiKey, User
from shared.repositories.base_repository import BaseRepository


class UserRepository(BaseRepository):
    collection_path = "users"

    def __init__(self, db: AsyncClient):
        super().__init__(db)

    async def create_or_update(self, user: User) -> dict[str, Any]:
        """Upsert user document."""
        doc_dict = user.model_dump(mode="json")
        await self._collection().document(user.id).set(doc_dict, merge=True)
        return doc_dict

    async def get_user(self, user_id: str) -> User | None:
        data = await self.get(user_id)
        if data is None:
            return None
        return User(**data)

    async def get_user_or_raise(self, user_id: str) -> User:
        data = await self.get_or_raise(user_id)
        return User(**data)

    async def get_users_by_ids(self, user_ids: list[str]) -> dict[str, User]:
        """Fetch multiple users in parallel. Missing users are simply absent.

        Uses asyncio.gather over individual ``get`` calls — the async
        Firestore client doesn't expose ``get_all`` over documents in a
        single subcollection, but parallel reads still avoid the serial
        latency of an N+1 loop.
        """
        if not user_ids:
            return {}

        import asyncio

        results = await asyncio.gather(*[self.get(uid) for uid in user_ids])
        return {
            uid: User(**data)
            for uid, data in zip(user_ids, results, strict=True)
            if data is not None
        }

    async def create_api_key(self, user_id: str, api_key: ApiKey) -> dict[str, Any]:
        """Store an API key in the user's api_keys subcollection."""
        doc_dict = api_key.model_dump(mode="json")
        ref = self._db.collection(f"users/{user_id}/api_keys").document(api_key.id)
        await ref.set(doc_dict)
        return doc_dict

    async def list_api_keys(self, user_id: str) -> list[dict[str, Any]]:
        """List all API keys for a user."""
        docs = self._db.collection(f"users/{user_id}/api_keys").stream()
        return [doc.to_dict() async for doc in docs]

    async def deactivate_api_key(self, user_id: str, key_id: str) -> None:
        """Deactivate an API key."""
        await self._db.collection(f"users/{user_id}/api_keys").document(
            key_id
        ).update({"is_active": False})
