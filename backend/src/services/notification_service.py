"""Notification service: create and fan-out notifications."""

import uuid
from datetime import UTC, datetime

from backend.src.repositories.notification_repository import NotificationRepository

from shared.models import Notification, NotificationType, RelatedEntity


class NotificationService:
    def __init__(self, notification_repo: NotificationRepository):
        self._notification_repo = notification_repo

    async def create_notification(
        self,
        trip_id: str,
        notification_type: NotificationType,
        message: str,
        target_user_ids: list[str],
        related_entity: RelatedEntity | None = None,
    ) -> dict:
        """Create and persist a notification."""
        notification = Notification(
            id=str(uuid.uuid4()),
            type=notification_type,
            message=message,
            target_user_ids=target_user_ids,
            read_by=[],
            related_entity=related_entity,
            created_at=datetime.now(UTC),
        )
        return await self._notification_repo.create_notification(trip_id, notification)

    async def notify_member_joined(
        self,
        trip_id: str,
        joined_user_name: str,
        all_participant_ids: list[str],
        joined_user_id: str,
    ) -> dict:
        """Create a notification when a new member joins the trip."""
        targets = [uid for uid in all_participant_ids if uid != joined_user_id]
        if not targets:
            return {}
        return await self.create_notification(
            trip_id=trip_id,
            notification_type=NotificationType.MEMBER_JOINED,
            message=f"{joined_user_name} joined the trip",
            target_user_ids=targets,
        )

    async def notify_member_removed(
        self,
        trip_id: str,
        removed_user_name: str,
        remaining_participant_ids: list[str],
        self_removal: bool,
    ) -> dict:
        """Create a notification when a member is removed or leaves."""
        if not remaining_participant_ids:
            return {}
        message = (
            f"{removed_user_name} left the trip"
            if self_removal
            else f"{removed_user_name} was removed from the trip"
        )
        return await self.create_notification(
            trip_id=trip_id,
            notification_type=NotificationType.MEMBER_REMOVED,
            message=message,
            target_user_ids=remaining_participant_ids,
        )

    async def notify_role_changed(
        self,
        trip_id: str,
        target_user_name: str,
        actor_user_name: str,
        new_role: str,
        all_participant_ids: list[str],
    ) -> dict:
        """Create a notification when a participant's role is changed."""
        if not all_participant_ids:
            return {}
        return await self.create_notification(
            trip_id=trip_id,
            notification_type=NotificationType.ROLE_CHANGED,
            message=f"{actor_user_name} changed {target_user_name}'s role to {new_role}",
            target_user_ids=all_participant_ids,
        )

