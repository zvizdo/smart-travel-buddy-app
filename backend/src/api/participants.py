"""Participant management endpoints: remove and change role."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.deps import get_notification_service, get_trip_service
from backend.src.services.notification_service import NotificationService
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel

router = APIRouter(tags=["participants"])


class ChangeRoleRequest(BaseModel):
    role: str


@router.delete("/trips/{trip_id}/participants/{user_id}")
async def remove_participant(
    trip_id: str,
    user_id: str,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    notification_service: NotificationService = Depends(get_notification_service),
):
    """Remove a participant from a trip. Admins can remove anyone; any participant can remove themselves."""
    # Capture trip state before removal for notifications
    trip = await trip_service.get_trip(trip_id, user["uid"])
    target_name = trip.participants[user_id].display_name if user_id in trip.participants else "Unknown"
    remaining_ids = [uid for uid in trip.participants if uid != user_id]

    result = await trip_service.remove_participant(trip_id, user_id, user["uid"])

    await notification_service.notify_member_removed(
        trip_id=trip_id,
        removed_user_name=target_name,
        remaining_participant_ids=remaining_ids,
        self_removal=result["self_removal"],
    )

    return result


@router.patch("/trips/{trip_id}/participants/{user_id}")
async def change_participant_role(
    trip_id: str,
    user_id: str,
    body: ChangeRoleRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    notification_service: NotificationService = Depends(get_notification_service),
):
    """Change a participant's role. Admin only."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    target_name = trip.participants[user_id].display_name if user_id in trip.participants else "Unknown"
    actor_name = trip.participants[user["uid"]].display_name if user["uid"] in trip.participants else "Unknown"

    result = await trip_service.change_participant_role(trip_id, user_id, body.role, user["uid"])

    await notification_service.notify_role_changed(
        trip_id=trip_id,
        target_user_name=target_name,
        actor_user_name=actor_name,
        new_role=result["new_role"],
        all_participant_ids=list(trip.participants.keys()),
    )

    return result
