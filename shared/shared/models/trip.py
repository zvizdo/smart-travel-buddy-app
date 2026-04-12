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


class NoDriveWindow(BaseModel):
    """Hour-of-day window during which drive/walk edges should not be scheduled.

    Evaluated in the departure node's local timezone. A window that crosses midnight
    (e.g. 22→6) is supported. Setting `TripSettings.no_drive_window = None` disables
    the rule entirely.
    """

    start_hour: int = Field(default=22, ge=0, le=23)
    end_hour: int = Field(default=6, ge=0, le=23)


class TripSettings(BaseModel):
    datetime_format: DateTimeFormat = DateTimeFormat.H24
    date_format: DateFormat = DateFormat.EU
    distance_unit: DistanceUnit = DistanceUnit.KM
    no_drive_window: NoDriveWindow | None = Field(default=None)
    max_drive_hours_per_day: float | None = Field(default=None, ge=1.0, le=24.0)


class Trip(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=200)
    created_by: str
    active_plan_id: str | None = None
    participants: dict[str, Participant] = Field(default_factory=dict)
    settings: TripSettings = Field(default_factory=TripSettings)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
