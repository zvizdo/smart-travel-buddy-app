"""Invite service: generate, validate, and claim invite links."""

import secrets
from datetime import UTC, datetime, timedelta

from backend.src.repositories.invite_link_repository import InviteLinkRepository
from backend.src.repositories.trip_repository import TripRepository

from shared.models import InviteLink, Participant, TripRole


class InviteService:
    def __init__(
        self,
        invite_repo: InviteLinkRepository,
        trip_repo: TripRepository,
    ):
        self._invite_repo = invite_repo
        self._trip_repo = trip_repo

    async def generate_invite(
        self,
        trip_id: str,
        role: TripRole,
        created_by: str,
        expires_in_hours: int = 72,
    ) -> dict:
        """Generate an invite link token for a trip."""
        token = f"inv_{secrets.token_urlsafe(24)}"
        invite = InviteLink(
            id=token,
            role=role,
            created_by=created_by,
            expires_at=datetime.now(UTC) + timedelta(hours=expires_in_hours),
            is_active=True,
            created_at=datetime.now(UTC),
        )
        await self._invite_repo.create_invite(trip_id, invite)
        return {
            "token": token,
            "url": f"/invite/{trip_id}/{token}",
            "role": role.value,
            "expires_at": invite.expires_at.isoformat(),
        }

    async def claim_invite(
        self, trip_id: str, token: str, user_id: str, user_display_name: str = ""
    ) -> dict:
        """Claim an invite link, adding the user to the trip."""
        invite = await self._invite_repo.get_invite(trip_id, token)
        if invite is None:
            raise LookupError(
                "Invite link not found. It may have been deleted or the URL is incorrect."
            )

        if not invite.is_active:
            raise ValueError(
                "This invite link has been deactivated by the trip admin."
            )
        if invite.expires_at < datetime.now(UTC):
            raise ValueError(
                "This invite link has expired. Please ask the trip admin for a new link."
            )

        trip = await self._trip_repo.get_trip_or_raise(trip_id)
        if user_id in trip.participants:
            return {"trip_id": trip_id, "role": trip.participants[user_id].role.value}

        participant = Participant(
            role=invite.role,
            display_name=user_display_name or user_id,
            joined_at=datetime.now(UTC),
        )
        await self._trip_repo.update_trip(trip_id, {
            f"participants.{user_id}": participant.model_dump(mode="json"),
            "updated_at": datetime.now(UTC).isoformat(),
        })

        return {"trip_id": trip_id, "role": invite.role.value}
