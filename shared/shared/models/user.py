from datetime import UTC, datetime

from pydantic import BaseModel, Field


class User(BaseModel):
    id: str
    display_name: str
    email: str
    location_tracking_enabled: bool = False
    analytics_enabled: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
