from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class NodeType(StrEnum):
    CITY = "city"
    HOTEL = "hotel"
    RESTAURANT = "restaurant"
    PLACE = "place"
    ACTIVITY = "activity"


class LatLng(BaseModel):
    lat: float
    lng: float


class Node(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=500)
    type: NodeType
    lat_lng: LatLng
    arrival_time: datetime
    departure_time: datetime | None = None
    timezone: str | None = None  # IANA timezone, e.g., "Europe/Paris"
    participant_ids: list[str] | None = None
    order_index: int
    place_id: str | None = None
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
