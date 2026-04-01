"""Agent response schemas for structured Gemini output."""

from enum import StrEnum

from pydantic import BaseModel


class NoteCategory(StrEnum):
    DESTINATION = "destination"
    TIMING = "timing"
    ACTIVITY = "activity"
    BUDGET = "budget"
    PREFERENCE = "preference"
    ACCOMMODATION = "accommodation"
    BRANCHING = "branching"


class Confidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class ImportNote(BaseModel):
    category: NoteCategory
    content: str
    confidence: Confidence = Confidence.HIGH


class ImportChatResponse(BaseModel):
    reply: str
    notes: list[ImportNote] = []
    ready_to_build: bool = False


class ActionTaken(BaseModel):
    """An action the agent performed on the trip DAG."""

    type: str  # node_added, node_updated, node_deleted, cascade_applied, places_searched
    node_id: str | None = None
    description: str


class ExtractedPreference(BaseModel):
    """A travel preference extracted from the conversation."""

    content: str
    category: str  # maps to PreferenceCategory values


class AgentReply(BaseModel):
    """Structured reply from the ongoing agent.

    Used as response_schema for Gemini. Does NOT include actions_taken
    because those are tracked by the backend from real tool executions.
    """

    reply: str
    preferences_extracted: list[ExtractedPreference] = []


class OngoingChatResponse(BaseModel):
    """Full response returned to the frontend from the agent endpoint."""

    reply: str
    actions_taken: list[ActionTaken] = []
    preferences_extracted: list[ExtractedPreference] = []


class BuildDagReply(BaseModel):
    """Structured reply from the build agent.

    Used as response_schema for Gemini. Does NOT include actions_taken
    because those are tracked by the backend from real tool executions.
    """

    summary: str
    node_count: int
    edge_count: int


class BuildDagResponse(BaseModel):
    """Full response returned to the frontend from the build endpoint."""

    summary: str
    actions_taken: list[ActionTaken] = []
    node_count: int
    edge_count: int
