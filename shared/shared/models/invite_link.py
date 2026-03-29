from datetime import UTC, datetime

from pydantic import BaseModel, Field

from shared.models.trip import TripRole


class InviteLink(BaseModel):
    id: str
    role: TripRole
    created_by: str
    expires_at: datetime
    is_active: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
