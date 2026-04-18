"""Invite link endpoints: generate and claim."""

import logging

from backend.src.auth.firebase_auth import get_current_user
from backend.src.auth.permissions import require_role
from backend.src.deps import get_invite_service, get_notification_service, get_trip_service
from backend.src.services.invite_service import InviteService
from backend.src.services.notification_service import NotificationService
from backend.src.services.trip_service import TripService
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from shared.models import TripRole

logger = logging.getLogger(__name__)

router = APIRouter(tags=["invites"])


class CreateInviteRequest(BaseModel):
    role: str
    expires_in_hours: int = Field(default=72, ge=1, le=8760)


@router.post("/trips/{trip_id}/invites", status_code=201)
async def create_invite(
    trip_id: str,
    body: CreateInviteRequest,
    user: dict = Depends(get_current_user),
    trip_service: TripService = Depends(get_trip_service),
    invite_service: InviteService = Depends(get_invite_service),
):
    """Generate an invite link. Requires Admin role."""
    trip = await trip_service.get_trip(trip_id, user["uid"])
    require_role(trip, user["uid"], TripRole.ADMIN)

    role = TripRole(body.role)
    result = await invite_service.generate_invite(
        trip_id=trip_id,
        role=role,
        created_by=user["uid"],
        expires_in_hours=body.expires_in_hours,
    )
    return result


@router.post("/trips/{trip_id}/invites/{token}/claim")
async def claim_invite(
    trip_id: str,
    token: str,
    user: dict = Depends(get_current_user),
    invite_service: InviteService = Depends(get_invite_service),
    notification_service: NotificationService = Depends(get_notification_service),
):
    """Claim an invite link and join the trip."""
    result = await invite_service.claim_invite(
        trip_id=trip_id,
        token=token,
        user_id=user["uid"],
        user_display_name=user.get("name", ""),
    )

    participant_ids = result.pop("participant_ids", [])
    try:
        await notification_service.notify_member_joined(
            trip_id=result["trip_id"],
            joined_user_name=user.get("name", "New member"),
            all_participant_ids=participant_ids,
            joined_user_id=user["uid"],
        )
    except Exception:
        logger.warning(
            "notify_member_joined failed for trip=%s user=%s",
            result["trip_id"], user["uid"], exc_info=True,
        )

    return result
