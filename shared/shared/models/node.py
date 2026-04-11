from datetime import UTC, datetime
from enum import StrEnum
from typing import Self

from pydantic import BaseModel, Field, model_validator


class NodeType(StrEnum):
    CITY = "city"
    HOTEL = "hotel"
    RESTAURANT = "restaurant"
    PLACE = "place"
    ACTIVITY = "activity"


class LatLng(BaseModel):
    lat: float
    lng: float


_DURATION_MAX_MINUTES = 60 * 24 * 14  # 14 days


class Node(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=500)
    type: NodeType
    lat_lng: LatLng
    arrival_time: datetime | None = None
    departure_time: datetime | None = None
    duration_minutes: int | None = Field(default=None, ge=1, le=_DURATION_MAX_MINUTES)
    timezone: str | None = None  # IANA timezone, e.g., "Europe/Paris"
    participant_ids: list[str] | None = None
    order_index: int
    place_id: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def _departure_after_arrival(self) -> Self:
        if (
            self.arrival_time is not None
            and self.departure_time is not None
            and self.departure_time <= self.arrival_time
        ):
            raise ValueError("departure_time must be after arrival_time")
        return self
