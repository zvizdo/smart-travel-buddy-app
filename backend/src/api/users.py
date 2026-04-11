"""User endpoints: profile, API key management."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.deps import (
    get_location_repo,
    get_trip_service,
    get_user_service,
)
from backend.src.services.trip_service import TripService
from backend.src.services.user_service import UserService
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from shared.repositories.location_repository import LocationRepository

router = APIRouter(tags=["users"])


class UpdateProfileRequest(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=200)
    location_tracking_enabled: bool | None = None


class BatchUsersRequest(BaseModel):
    user_ids: list[str] = Field(max_length=50)


class CreateApiKeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.get("/users/me")
async def get_profile(
    user: dict = Depends(get_current_user),
    user_service: UserService = Depends(get_user_service),
):
    """Get or create user profile from Firebase token claims."""
    result = await user_service.ensure_user(
        uid=user["uid"],
        display_name=user.get("name", ""),
        email=user.get("email", ""),
    )
    return result


@router.patch("/users/me")
async def update_profile(
    body: UpdateProfileRequest,
    user: dict = Depends(get_current_user),
    user_service: UserService = Depends(get_user_service),
    trip_service: TripService = Depends(get_trip_service),
    location_repo: LocationRepository = Depends(get_location_repo),
):
    """Update user profile fields."""
    result = await user_service.update_user(
        uid=user["uid"],
        display_name=body.display_name,
        location_tracking_enabled=body.location_tracking_enabled,
    )

    # When disabling location tracking, delete all location docs for this user.
    # Firestore delete is idempotent, so a missing doc is a no-op — any error
    # here is a genuine failure that should propagate rather than leave stale
    # location data while reporting success.
    if body.location_tracking_enabled is False:
        trips = await trip_service.list_trips(user["uid"])
        for trip in trips:
            await location_repo.delete(
                user["uid"], trip_id=trip["id"]
            )

    return result


@router.post("/users/batch")
async def batch_users(
    body: BatchUsersRequest,
    user: dict = Depends(get_current_user),
    user_service: UserService = Depends(get_user_service),
):
    """Get display names for a batch of user IDs."""
    result = await user_service.get_users_batch(body.user_ids)
    return {"users": result}


@router.post("/users/me/api-keys", status_code=201)
async def create_api_key(
    body: CreateApiKeyRequest,
    user: dict = Depends(get_current_user),
    user_service: UserService = Depends(get_user_service),
):
    """Generate a new API key. The raw key is returned once and cannot be retrieved again."""
    return await user_service.create_api_key(user["uid"], body.name)


@router.get("/users/me/api-keys")
async def list_api_keys(
    user: dict = Depends(get_current_user),
    user_service: UserService = Depends(get_user_service),
):
    """List all API keys for the authenticated user."""
    keys = await user_service.list_api_keys(user["uid"])
    return {"api_keys": keys}


@router.delete("/users/me/api-keys/{key_id}", status_code=204)
async def revoke_api_key(
    key_id: str,
    user: dict = Depends(get_current_user),
    user_service: UserService = Depends(get_user_service),
):
    """Deactivate an API key."""
    await user_service.revoke_api_key(user["uid"], key_id)
    return Response(status_code=204)
