"""Pulse check-in endpoint: broadcast GPS location to trip group."""

from datetime import UTC, datetime

from backend.src.auth.firebase_auth import get_current_user
from backend.src.deps import get_location_repo, get_trip_service, get_user_service
from backend.src.repositories.location_repository import LocationRepository
from backend.src.services.trip_service import TripService
from backend.src.services.user_service import UserService
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from shared.models import Location

router = APIRouter(tags=["pulse"])


class PulseRequest(BaseModel):
    lat: float
    lng: float
    heading: float = 0


@router.post("/trips/{trip_id}/pulse")
async def submit_pulse(
    trip_id: str,
    body: PulseRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    location_repo: LocationRepository = Depends(get_location_repo),
    user_service: UserService = Depends(get_user_service),
):
    """Submit a Pulse check-in with current GPS coordinates."""
    await trip_service.get_trip(trip_id, user["uid"])

    # Check if user has location sharing enabled
    user_profile = await user_service.get_user(user["uid"])
    if user_profile and not user_profile.location_tracking_enabled:
        raise ValueError("Location sharing is disabled in your profile settings")

    location = Location(
        user_id=user["uid"],
        coords={"lat": body.lat, "lng": body.lng},
        heading=body.heading,
        updated_at=datetime.now(UTC),
    )
    await location_repo.upsert(trip_id, location)

    return {"updated_at": location.updated_at.isoformat()}
