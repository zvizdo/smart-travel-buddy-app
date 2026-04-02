from datetime import UTC, datetime, timedelta
from enum import StrEnum

from pydantic import BaseModel, Field

NOTIFICATION_TTL_DAYS = 7


class NotificationType(StrEnum):
    PLAN_PROMOTED = "plan_promoted"
    SCHEDULE_CHANGED = "schedule_changed"
    EDIT_CONFLICT = "edit_conflict"
    MEMBER_JOINED = "member_joined"
    MEMBER_REMOVED = "member_removed"
    ROLE_CHANGED = "role_changed"
    UNRESOLVED_PATH = "unresolved_path"


class RelatedEntity(BaseModel):
    type: str
    id: str


class Notification(BaseModel):
    id: str
    type: NotificationType
    message: str
    target_user_ids: list[str]
    read_by: list[str] = Field(default_factory=list)
    related_entity: RelatedEntity | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    expire_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC) + timedelta(days=NOTIFICATION_TTL_DAYS)
    )
