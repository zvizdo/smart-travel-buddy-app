import time
from typing import Any

from google.cloud.firestore import AsyncClient

from shared.models import Trip
from shared.repositories.base_repository import BaseRepository

_DEFAULT_CACHE_TTL_SECONDS = 30.0
_DEFAULT_CACHE_MAX_SIZE = 1000


class TripRepository(BaseRepository):
    collection_path = "trips"

    def __init__(
        self,
        db: AsyncClient,
        cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS,
        cache_max_size: int = _DEFAULT_CACHE_MAX_SIZE,
    ):
        super().__init__(db)
        # In-process trip-doc cache: trip_id -> (expires_at_monotonic, Trip).
        # Avoids re-reading the trip doc on every authenticated request,
        # since most endpoints call TripService.get_trip purely as a
        # participant-membership gate.
        #
        # Invalidated on every write through this repo. Multi-instance
        # deployments (Cloud Run) will see stale data on instances that
        # didn't perform the write for up to TTL seconds — that's the
        # accepted tradeoff. Pass cache_ttl_seconds=0 to disable.
        self._cache: dict[str, tuple[float, Trip]] = {}
        self._cache_ttl_seconds = cache_ttl_seconds
        self._cache_max_size = cache_max_size

    def invalidate(self, trip_id: str) -> None:
        """Drop the cached trip doc.

        Call after any write that bypasses ``update_trip`` / ``update`` /
        ``delete`` on this repo (e.g. transactional or batched writes that
        target the raw Firestore doc ref directly).
        """
        self._cache.pop(trip_id, None)

    def _cache_get(self, trip_id: str) -> Trip | None:
        if self._cache_ttl_seconds <= 0:
            return None
        entry = self._cache.get(trip_id)
        if entry is None:
            return None
        expires_at, trip = entry
        if expires_at <= time.monotonic():
            self._cache.pop(trip_id, None)
            return None
        return trip

    def _cache_put(self, trip_id: str, trip: Trip) -> None:
        if self._cache_ttl_seconds <= 0:
            return
        if (
            len(self._cache) >= self._cache_max_size
            and trip_id not in self._cache
        ):
            # Evict the entry with the soonest expiry. Cheap because the
            # cache is small (capped at max_size, default 1000 entries).
            oldest_key = min(self._cache, key=lambda k: self._cache[k][0])
            self._cache.pop(oldest_key, None)
        self._cache[trip_id] = (
            time.monotonic() + self._cache_ttl_seconds, trip,
        )

    async def create(self, trip: Trip, **path_params: str) -> dict[str, Any]:
        return await super().create(trip)

    async def get_trip(self, trip_id: str) -> Trip | None:
        cached = self._cache_get(trip_id)
        if cached is not None:
            return cached
        data = await self.get(trip_id)
        if data is None:
            return None
        trip = Trip(**data)
        self._cache_put(trip_id, trip)
        return trip

    async def get_trip_or_raise(self, trip_id: str) -> Trip:
        cached = self._cache_get(trip_id)
        if cached is not None:
            return cached
        data = await self.get_or_raise(trip_id)
        trip = Trip(**data)
        self._cache_put(trip_id, trip)
        return trip

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """List all trips where the user is a participant."""
        from google.cloud.firestore_v1.base_query import FieldFilter

        docs = self._collection().where(
            filter=FieldFilter(f"participants.{user_id}.role", ">=", "")
        ).stream()
        return [doc.to_dict() async for doc in docs]

    async def update_trip(self, trip_id: str, updates: dict[str, Any]) -> None:
        await self.update(trip_id, updates)

    async def update(
        self, doc_id: str, updates: dict[str, Any], **path_params: str
    ) -> None:
        await super().update(doc_id, updates, **path_params)
        self.invalidate(doc_id)

    async def delete(self, doc_id: str, **path_params: str) -> None:
        await super().delete(doc_id, **path_params)
        self.invalidate(doc_id)
