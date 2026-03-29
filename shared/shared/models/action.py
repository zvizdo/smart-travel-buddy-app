from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class ActionType(StrEnum):
    NOTE = "note"
    TODO = "todo"
    PLACE = "place"


class PlaceData(BaseModel):
    name: str
    lat_lng: dict[str, float] | None = None
    place_id: str | None = None
    category: str | None = None


class Action(BaseModel):
    id: str
    type: ActionType
    content: str = Field(min_length=1, max_length=2000)
    place_data: PlaceData | None = None
    is_completed: bool = False
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
