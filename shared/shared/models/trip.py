from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class TripRole(StrEnum):
    ADMIN = "admin"
    PLANNER = "planner"
    VIEWER = "viewer"


class Participant(BaseModel):
    role: TripRole
    display_name: str = ""
    joined_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class DateTimeFormat(StrEnum):
    H12 = "12h"
    H24 = "24h"


class DateFormat(StrEnum):
    US = "us"        # MM/DD/YYYY — Jun 15, 2026
    EU = "eu"        # DD/MM/YYYY — 15 Jun 2026
    ISO = "iso"      # YYYY-MM-DD — 2026-06-15
    SHORT = "short"  # Mon, Jun 15


class DistanceUnit(StrEnum):
    KM = "km"
    MI = "mi"


class TripSettings(BaseModel):
    datetime_format: DateTimeFormat = DateTimeFormat.H24
    date_format: DateFormat = DateFormat.EU
    distance_unit: DistanceUnit = DistanceUnit.KM


class Trip(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=200)
    created_by: str
    active_plan_id: str | None = None
    participants: dict[str, Participant] = Field(default_factory=dict)
    settings: TripSettings = Field(default_factory=TripSettings)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
