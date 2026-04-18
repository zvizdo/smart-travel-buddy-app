"""Tests for the in-process trip-doc cache on TripRepository.

The cache exists to absorb the trip-as-authz read that fires on every
authenticated request. Tests verify hit/miss behavior, TTL expiry, and
invalidation on every code path that mutates the trip doc.
"""

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from shared.models import Participant, Trip, TripRole
from shared.repositories.trip_repository import TripRepository


def _make_trip(trip_id: str = "t_abc", name: str = "Italy") -> Trip:
    from datetime import UTC, datetime
    return Trip(
        id=trip_id,
        name=name,
        created_by="user_1",
        active_plan_id=None,
        participants={
            "user_1": Participant(
                role=TripRole.ADMIN,
                display_name="A",
                joined_at=datetime.now(UTC),
            )
        },
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )


def _make_repo(ttl: float = 30.0) -> TripRepository:
    repo = TripRepository(db=MagicMock(), cache_ttl_seconds=ttl)
    return repo


def _wire_get(repo: TripRepository, trip: Trip) -> MagicMock:
    """Replace the inherited `get` method with an AsyncMock that returns
    the trip dict and tracks call count."""
    mock = AsyncMock(return_value=trip.model_dump(mode="json"))
    repo.get = mock  # type: ignore[method-assign]
    return mock


@pytest.mark.asyncio
async def test_second_read_within_ttl_hits_cache():
    repo = _make_repo(ttl=30.0)
    trip = _make_trip()
    mock_get = _wire_get(repo, trip)

    first = await repo.get_trip_or_raise("t_abc")
    second = await repo.get_trip_or_raise("t_abc")

    assert first.id == "t_abc"
    assert second.id == "t_abc"
    assert mock_get.await_count == 1


@pytest.mark.asyncio
async def test_get_trip_uses_same_cache_as_get_trip_or_raise():
    repo = _make_repo(ttl=30.0)
    trip = _make_trip()
    mock_get = _wire_get(repo, trip)

    await repo.get_trip_or_raise("t_abc")
    await repo.get_trip("t_abc")

    assert mock_get.await_count == 1


@pytest.mark.asyncio
async def test_zero_ttl_disables_cache():
    repo = _make_repo(ttl=0.0)
    trip = _make_trip()
    mock_get = _wire_get(repo, trip)

    await repo.get_trip_or_raise("t_abc")
    await repo.get_trip_or_raise("t_abc")

    assert mock_get.await_count == 2


@pytest.mark.asyncio
async def test_expired_entry_refetches():
    repo = _make_repo(ttl=30.0)
    trip = _make_trip()
    mock_get = _wire_get(repo, trip)

    await repo.get_trip_or_raise("t_abc")
    # Force expiry by rewriting the entry's expires_at to the past.
    expires_at, cached_trip = repo._cache["t_abc"]
    repo._cache["t_abc"] = (time.monotonic() - 1, cached_trip)

    await repo.get_trip_or_raise("t_abc")

    assert mock_get.await_count == 2


@pytest.mark.asyncio
async def test_update_trip_invalidates_cache():
    repo = _make_repo(ttl=30.0)
    trip = _make_trip()
    mock_get = _wire_get(repo, trip)

    # Wire base-class update path so super().update doesn't blow up.
    doc_ref = MagicMock()
    doc_ref.update = AsyncMock()
    collection = MagicMock()
    collection.document = MagicMock(return_value=doc_ref)
    repo._collection = MagicMock(return_value=collection)  # type: ignore[method-assign]

    await repo.get_trip_or_raise("t_abc")
    assert mock_get.await_count == 1

    await repo.update_trip("t_abc", {"name": "Spain"})
    await repo.get_trip_or_raise("t_abc")

    # Update invalidated, so this fetched again.
    assert mock_get.await_count == 2


@pytest.mark.asyncio
async def test_delete_invalidates_cache():
    repo = _make_repo(ttl=30.0)
    trip = _make_trip()
    mock_get = _wire_get(repo, trip)

    doc_ref = MagicMock()
    doc_ref.delete = AsyncMock()
    collection = MagicMock()
    collection.document = MagicMock(return_value=doc_ref)
    repo._collection = MagicMock(return_value=collection)  # type: ignore[method-assign]

    await repo.get_trip_or_raise("t_abc")
    await repo.delete("t_abc")

    assert "t_abc" not in repo._cache


@pytest.mark.asyncio
async def test_explicit_invalidate_drops_entry():
    """Public invalidate() is the escape hatch for transactional and
    batched writes that bypass the repo's CRUD methods (plan promotion,
    cascading trip delete)."""
    repo = _make_repo(ttl=30.0)
    trip = _make_trip()
    _wire_get(repo, trip)

    await repo.get_trip_or_raise("t_abc")
    assert "t_abc" in repo._cache

    repo.invalidate("t_abc")
    assert "t_abc" not in repo._cache

    # Idempotent: second invalidate on a missing key is a no-op.
    repo.invalidate("t_abc")


@pytest.mark.asyncio
async def test_get_trip_does_not_cache_missing_doc():
    """get_trip returns None for a missing doc; we should not cache None
    (otherwise a trip created shortly after a 404 lookup wouldn't be
    visible until TTL expired)."""
    repo = _make_repo(ttl=30.0)
    mock_get = AsyncMock(return_value=None)
    repo.get = mock_get  # type: ignore[method-assign]

    result = await repo.get_trip("t_missing")

    assert result is None
    assert "t_missing" not in repo._cache


@pytest.mark.asyncio
async def test_cache_evicts_when_full():
    """When the cache is at max_size and a new trip is read, the entry
    with the soonest expiry is dropped to make room."""
    repo = TripRepository(
        db=MagicMock(), cache_ttl_seconds=30.0, cache_max_size=2,
    )

    async def fake_get(trip_id: str, **_):
        return _make_trip(trip_id=trip_id, name=trip_id).model_dump(mode="json")

    repo.get = AsyncMock(side_effect=fake_get)  # type: ignore[method-assign]

    await repo.get_trip_or_raise("t_a")
    await repo.get_trip_or_raise("t_b")
    assert set(repo._cache.keys()) == {"t_a", "t_b"}

    # Nudge t_a's expiry forward so t_b is "oldest" and gets evicted.
    expires_at_a, trip_a = repo._cache["t_a"]
    repo._cache["t_a"] = (expires_at_a + 100, trip_a)

    await repo.get_trip_or_raise("t_c")
    assert "t_b" not in repo._cache
    assert {"t_a", "t_c"} <= set(repo._cache.keys())
