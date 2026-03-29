from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class PreferenceCategory(StrEnum):
    TRAVEL_RULE = "travel_rule"
    ACCOMMODATION = "accommodation"
    FOOD = "food"
    BUDGET = "budget"
    SCHEDULE = "schedule"
    ACTIVITY = "activity"
    GENERAL = "general"


class Preference(BaseModel):
    id: str
    content: str = Field(min_length=1, max_length=500)
    category: PreferenceCategory
    extracted_from: str
    created_by: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
