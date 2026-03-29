from datetime import UTC, datetime

from pydantic import BaseModel, Field


class Location(BaseModel):
    user_id: str
    coords: dict[str, float]  # {"lat": ..., "lng": ...}
    heading: float = 0
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
