from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class PlanStatus(StrEnum):
    ACTIVE = "active"
    DRAFT = "draft"
    ARCHIVED = "archived"


class Plan(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=200)
    status: PlanStatus = PlanStatus.DRAFT
    created_by: str
    parent_plan_id: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
