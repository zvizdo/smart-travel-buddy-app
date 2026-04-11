"""Trip CRUD endpoints."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_role
from backend.src.deps import get_trip_repo, get_trip_service
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from shared.models import TripRole
from shared.repositories.trip_repository import TripRepository

router = APIRouter(tags=["trips"])


class CreateTripRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class NoDriveWindowRequest(BaseModel):
    start_hour: int = Field(ge=0, le=23)
    end_hour: int = Field(ge=0, le=23)


class UpdateTripSettingsRequest(BaseModel):
    datetime_format: str | None = None
    date_format: str | None = None
    distance_unit: str | None = None
    # The outer field is optional (None = leave unchanged); the inner value
    # uses a sentinel to distinguish "disable the window" from "don't touch it".
    no_drive_window: NoDriveWindowRequest | None = Field(default=None)
    clear_no_drive_window: bool = False
    max_drive_hours_per_day: float | None = Field(default=None, ge=1.0, le=24.0)
    clear_max_drive_hours: bool = False


@router.post("/trips", status_code=201)
async def create_trip(
    body: CreateTripRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
):
    trip = await trip_service.create_trip(
        body.name, user["uid"], user_display_name=user.get("name", "")
    )
    return trip.model_dump(mode="json")


@router.get("/trips")
async def list_trips(
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
):
    trips = await trip_service.list_trips(user["uid"])
    return {"trips": trips}


@router.get("/trips/{trip_id}")
async def get_trip(
    trip_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
):
    trip = await trip_service.get_trip(trip_id, user["uid"])
    return trip.model_dump(mode="json")


@router.delete("/trips/{trip_id}", status_code=204)
async def delete_trip(
    trip_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
):
    """Delete a trip (admin only)."""
    await trip_service.delete_trip(trip_id, user["uid"])


@router.patch("/trips/{trip_id}/settings")
async def update_trip_settings(
    trip_id: str,
    body: UpdateTripSettingsRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    trip_repo: TripRepository = Depends(get_trip_repo),
):
    """Update trip-level settings (admin only)."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN)

    current = trip.settings.model_dump()
    if body.datetime_format is not None:
        current["datetime_format"] = body.datetime_format
    if body.date_format is not None:
        current["date_format"] = body.date_format
    if body.distance_unit is not None:
        current["distance_unit"] = body.distance_unit
    if body.clear_no_drive_window:
        current["no_drive_window"] = None
    elif body.no_drive_window is not None:
        current["no_drive_window"] = body.no_drive_window.model_dump()
    if body.clear_max_drive_hours:
        current["max_drive_hours_per_day"] = None
    elif body.max_drive_hours_per_day is not None:
        current["max_drive_hours_per_day"] = body.max_drive_hours_per_day

    await trip_repo.update(trip_id, {"settings": current})
    return {"settings": current}
