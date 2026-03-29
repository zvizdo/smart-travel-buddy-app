from datetime import UTC, datetime

from pydantic import BaseModel, Field


class ApiKey(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=100)
    key_hash: str
    key_prefix: str
    is_active: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_used_at: datetime | None = None
