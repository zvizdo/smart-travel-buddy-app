"""Trip CRUD endpoints."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.deps import get_trip_service
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

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
):
    """Update trip-level settings (admin only)."""
    current = await trip_service.update_trip_settings(
        trip_id,
        user["uid"],
        datetime_format=body.datetime_format,
        date_format=body.date_format,
        distance_unit=body.distance_unit,
        no_drive_window=(
            body.no_drive_window.model_dump() if body.no_drive_window else None
        ),
        clear_no_drive_window=body.clear_no_drive_window,
        max_drive_hours_per_day=body.max_drive_hours_per_day,
        clear_max_drive_hours=body.clear_max_drive_hours,
    )
    return {"settings": current}
