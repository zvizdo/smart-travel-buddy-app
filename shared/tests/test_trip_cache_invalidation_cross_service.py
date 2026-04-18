"""Cross-service trip-cache invalidation tests.

`TripRepository.update` / `update_trip` / `delete` auto-invalidate the
in-process trip cache. Two write paths bypass these wrappers and write
directly to raw Firestore doc refs:

  1. ``PlanService.promote_plan`` — atomic transaction touching the trip doc.
  2. ``TripService.delete_trip``  — chunked batch delete that includes the
                                    trip doc as the final ref.

Both must call ``trip_repo.invalidate(trip_id)`` after the bypassing write,
or the next read on the same instance returns a stale (or ghost) trip for
up to TTL seconds. These tests pin that contract end-to-end using a real
TripRepository (so a regression that drops the invalidate call is caught
even if the dedicated cache tests still pass).
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import Participant, Plan, PlanStatus, Trip, TripRole
from shared.repositories.trip_repository import TripRepository
from shared.services.plan_service import PlanService
from shared.services.trip_service import TripService


def _make_trip(
    trip_id: str = "t_abc",
    active_plan_id: str | None = "p_active",
) -> Trip:
    return Trip(
        id=trip_id,
        name="Italy",
        created_by="user_1",
        active_plan_id=active_plan_id,
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


def _make_plan(
    plan_id: str = "p_new", status: PlanStatus = PlanStatus.DRAFT,
) -> Plan:
    return Plan(
        id=plan_id,
        name="Plan B",
        status=status,
        created_by="user_1",
        parent_plan_id=None,
        created_at=datetime.now(UTC),
    )


def _real_trip_repo(trip: Trip, ttl: float = 30.0) -> TripRepository:
    """A TripRepository wired with a mock Firestore client + a real cache.

    The inherited ``get`` is replaced with an AsyncMock so we can pre-warm
    the cache via ``get_trip_or_raise`` without hitting Firestore. ``_db``
    and ``_collection`` are MagicMocks because both services reach for the
    raw doc refs (``trip_repo._db``, ``trip_repo._collection().document``).
    """
    repo = TripRepository(db=MagicMock(), cache_ttl_seconds=ttl)
    repo.get = AsyncMock(return_value=trip.model_dump(mode="json"))  # type: ignore[method-assign]
    repo._collection = MagicMock(return_value=MagicMock())  # type: ignore[method-assign]
    return repo


# ── PlanService.promote_plan ─────────────────────────────────────


class TestPromotePlanInvalidatesTripCache:
    @pytest.mark.asyncio
    async def test_promote_drops_cached_trip_entry(self):
        """After ``promote_plan`` commits the trip-pointer transaction,
        the next read on the same repo instance must hit Firestore again,
        not return the pre-promotion cached trip with the stale
        ``active_plan_id``."""
        trip = _make_trip(active_plan_id="p_old")
        trip_repo = _real_trip_repo(trip)

        # Pre-warm the cache.
        await trip_repo.get_trip_or_raise(trip.id)
        assert trip.id in trip_repo._cache

        plan_repo = MagicMock()
        plan_repo.get_plan_or_raise = AsyncMock(
            return_value=_make_plan(plan_id="p_new", status=PlanStatus.DRAFT)
        )
        plan_repo._collection = MagicMock(return_value=MagicMock())

        svc = PlanService(
            trip_repo=trip_repo,
            plan_repo=plan_repo,
            node_repo=MagicMock(),
            edge_repo=MagicMock(),
        )

        # Patch the firestore.async_transactional decorator to identity so
        # ``_commit`` runs as a plain async function against a mock txn.
        with patch(
            "shared.services.plan_service.firestore.async_transactional",
            lambda f: f,
        ):
            await svc.promote_plan(trip.id, "p_new", promoted_by="user_1")

        assert trip.id not in trip_repo._cache, (
            "promote_plan must call trip_repo.invalidate(trip_id) after the "
            "transaction — otherwise the cached trip keeps the stale "
            "active_plan_id for up to TTL seconds."
        )

    @pytest.mark.asyncio
    async def test_promote_with_no_previous_active_still_invalidates(self):
        """First-ever promotion (active_plan_id was None) still bypasses the
        repo, so the cache still has to be dropped."""
        trip = _make_trip(active_plan_id=None)
        trip_repo = _real_trip_repo(trip)
        await trip_repo.get_trip_or_raise(trip.id)

        plan_repo = MagicMock()
        plan_repo.get_plan_or_raise = AsyncMock(
            return_value=_make_plan(plan_id="p_first", status=PlanStatus.DRAFT)
        )
        plan_repo._collection = MagicMock(return_value=MagicMock())

        svc = PlanService(
            trip_repo=trip_repo,
            plan_repo=plan_repo,
            node_repo=MagicMock(),
            edge_repo=MagicMock(),
        )

        with patch(
            "shared.services.plan_service.firestore.async_transactional",
            lambda f: f,
        ):
            await svc.promote_plan(trip.id, "p_first", promoted_by="user_1")

        assert trip.id not in trip_repo._cache

    @pytest.mark.asyncio
    async def test_promote_already_active_does_not_touch_cache(self):
        """Re-promoting the already-active plan raises before any write —
        cache entry should remain (no bypassing write happened)."""
        trip = _make_trip(active_plan_id="p_current")
        trip_repo = _real_trip_repo(trip)
        await trip_repo.get_trip_or_raise(trip.id)

        plan_repo = MagicMock()
        plan_repo.get_plan_or_raise = AsyncMock(
            return_value=_make_plan(
                plan_id="p_current", status=PlanStatus.ACTIVE
            )
        )
        plan_repo._collection = MagicMock(return_value=MagicMock())

        svc = PlanService(
            trip_repo=trip_repo,
            plan_repo=plan_repo,
            node_repo=MagicMock(),
            edge_repo=MagicMock(),
        )

        with patch(
            "shared.services.plan_service.firestore.async_transactional",
            lambda f: f,
        ):
            with pytest.raises(ValueError, match="already the active plan"):
                await svc.promote_plan(
                    trip.id, "p_current", promoted_by="user_1"
                )

        # No bypassing write happened; the cached trip stays.
        assert trip.id in trip_repo._cache


# ── TripService.delete_trip ──────────────────────────────────────


class TestDeleteTripInvalidatesTripCache:
    @pytest.mark.asyncio
    async def test_delete_drops_cached_trip_entry(self):
        """delete_trip uses raw batch.delete on the trip doc ref, bypassing
        the repo's auto-invalidating ``delete``. Without an explicit
        invalidate call the cache would happily serve a deleted trip
        (a "ghost trip") for up to TTL seconds."""
        trip = _make_trip(active_plan_id=None)
        trip_repo = _real_trip_repo(trip)
        await trip_repo.get_trip_or_raise(trip.id)
        assert trip.id in trip_repo._cache

        # Wire the batch the service uses for the chunked delete.
        batch = MagicMock()
        batch.commit = AsyncMock()
        batch.delete = MagicMock()
        trip_repo._db.batch = MagicMock(return_value=batch)

        # Subcollection repos: return empty lists so refs == [trip doc].
        plan_repo = MagicMock()
        plan_repo.list_all = AsyncMock(return_value=[])
        plan_repo._collection = MagicMock(return_value=MagicMock())
        location_repo = MagicMock()
        location_repo.list_all = AsyncMock(return_value=[])
        location_repo._collection = MagicMock(return_value=MagicMock())

        svc = TripService(
            trip_repo=trip_repo,
            plan_repo=plan_repo,
            node_repo=MagicMock(),
            edge_repo=MagicMock(),
            action_repo=MagicMock(),
            location_repo=location_repo,
        )

        await svc.delete_trip(trip.id, "user_1")

        assert trip.id not in trip_repo._cache, (
            "delete_trip must call trip_repo.invalidate(trip_id) after the "
            "batch commit — the trip doc is deleted via raw batch.delete, "
            "which bypasses TripRepository.delete and its auto-invalidate."
        )
        batch.commit.assert_awaited()

    @pytest.mark.asyncio
    async def test_delete_invalidates_even_with_subcollections(self):
        """Same contract holds when the trip has plans/locations to cascade
        through — ensures the invalidate call sits AFTER the loop, not
        guarded by an early-return path that fires only for empty trips."""
        trip = _make_trip(active_plan_id="p_active")
        trip_repo = _real_trip_repo(trip)
        await trip_repo.get_trip_or_raise(trip.id)

        batch = MagicMock()
        batch.commit = AsyncMock()
        batch.delete = MagicMock()
        trip_repo._db.batch = MagicMock(return_value=batch)

        plan_repo = MagicMock()
        plan_repo.list_all = AsyncMock(return_value=[{"id": "p_active"}])
        plan_repo._collection = MagicMock(return_value=MagicMock())

        node_repo = MagicMock()
        node_repo.list_by_plan = AsyncMock(return_value=[{"id": "n_1"}])
        node_repo._collection = MagicMock(return_value=MagicMock())

        edge_repo = MagicMock()
        edge_repo.list_by_plan = AsyncMock(return_value=[])
        edge_repo._collection = MagicMock(return_value=MagicMock())

        action_repo = MagicMock()
        action_repo.list_by_node = AsyncMock(return_value=[])
        action_repo._collection = MagicMock(return_value=MagicMock())

        location_repo = MagicMock()
        location_repo.list_all = AsyncMock(return_value=[])
        location_repo._collection = MagicMock(return_value=MagicMock())

        svc = TripService(
            trip_repo=trip_repo,
            plan_repo=plan_repo,
            node_repo=node_repo,
            edge_repo=edge_repo,
            action_repo=action_repo,
            location_repo=location_repo,
        )

        await svc.delete_trip(trip.id, "user_1")

        assert trip.id not in trip_repo._cache

    @pytest.mark.asyncio
    async def test_failed_admin_check_does_not_touch_cache(self):
        """Non-admin attempting delete fails the role check before any write.
        The cache should stay intact — invalidating on a refused delete
        would needlessly waste the warm entry on a permission error."""
        trip = _make_trip()
        trip_repo = _real_trip_repo(trip)
        await trip_repo.get_trip_or_raise(trip.id)

        svc = TripService(
            trip_repo=trip_repo,
            plan_repo=MagicMock(),
            node_repo=MagicMock(),
            edge_repo=MagicMock(),
            action_repo=MagicMock(),
            location_repo=MagicMock(),
        )

        with pytest.raises(PermissionError):
            # "user_2" is not a participant; get_trip raises before
            # the admin check or any batch write.
            await svc.delete_trip(trip.id, "user_2")

        assert trip.id in trip_repo._cache
