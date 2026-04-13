"""Notification endpoints: list and mark read."""

from backend.src.auth.firebase_auth import get_current_user
from backend.src.deps import get_notification_repo, get_trip_service
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from shared.repositories.notification_repository import NotificationRepository

router = APIRouter(tags=["notifications"])


class MarkReadRequest(BaseModel):
    is_read: bool


@router.get("/trips/{trip_id}/notifications")
async def list_notifications(
    trip_id: str,
    unread_only: bool = Query(False),
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    notification_repo: NotificationRepository = Depends(get_notification_repo),
):
    """List notifications for the authenticated user in this trip."""
    await trip_service.get_trip(trip_id, user["uid"])

    notifications = await notification_repo.list_by_user(
        trip_id, user["uid"], unread_only=unread_only
    )

    result = []
    for n in notifications:
        result.append({
            "id": n["id"],
            "type": n["type"],
            "message": n["message"],
            "is_read": user["uid"] in n.get("read_by", []),
            "related_entity": n.get("related_entity"),
            "created_at": n.get("created_at"),
        })

    return {"notifications": result}


@router.patch("/trips/{trip_id}/notifications/{notification_id}")
async def mark_notification_read(
    trip_id: str,
    notification_id: str,
    body: MarkReadRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    notification_repo: NotificationRepository = Depends(get_notification_repo),
):
    """Mark a notification as read."""
    await trip_service.get_trip(trip_id, user["uid"])

    if body.is_read:
        await notification_repo.mark_read(trip_id, notification_id, user["uid"])

    return {"id": notification_id, "is_read": body.is_read}
