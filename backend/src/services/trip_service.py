"""Trip service: create and retrieve trips with participant checks."""

import uuid
from datetime import UTC, datetime

from backend.src.repositories.trip_repository import TripRepository

from shared.models import Participant, Trip, TripRole


class TripService:
    def __init__(self, trip_repo: TripRepository):
        self._trip_repo = trip_repo

    async def create_trip(
        self, name: str, user_id: str, user_display_name: str = ""
    ) -> Trip:
        """Create a new trip. The caller becomes Admin."""
        trip = Trip(
            id=str(uuid.uuid4()),
            name=name,
            created_by=user_id,
            active_plan_id=None,
            participants={
                user_id: Participant(
                    role=TripRole.ADMIN,
                    display_name=user_display_name or user_id,
                    joined_at=datetime.now(UTC),
                )
            },
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        await self._trip_repo.create(trip)
        return trip

    async def get_trip(self, trip_id: str, user_id: str) -> Trip:
        """Get a trip, verifying the user is a participant."""
        trip = await self._trip_repo.get_trip_or_raise(trip_id)
        if user_id not in trip.participants:
            raise PermissionError("You are not a participant of this trip")
        return trip

    async def delete_trip(self, trip_id: str, user_id: str) -> None:
        """Delete a trip. Only the admin can delete."""
        trip = await self.get_trip(trip_id, user_id)
        if trip.participants.get(user_id) is None or trip.participants[user_id].role != TripRole.ADMIN:
            raise PermissionError("Only the trip admin can delete this trip")
        await self._trip_repo.delete(trip_id)

    async def list_trips(self, user_id: str) -> list[dict]:
        """List all trips for a user, including their role."""
        trips = await self._trip_repo.list_by_user(user_id)
        results = []
        for t in trips:
            participant = t.get("participants", {}).get(user_id, {})
            results.append({
                "id": t["id"],
                "name": t["name"],
                "role": participant.get("role"),
                "active_plan_id": t.get("active_plan_id"),
            })
        return results
