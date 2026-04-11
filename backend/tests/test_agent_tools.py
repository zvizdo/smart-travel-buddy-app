"""Tests for backend.src.services.agent_tools.

These tests guard against a class of regression where the Gemini SDK's
Automatic Function Calling cannot introspect a tool's signature. The
trigger we hit in production: adding `from __future__ import annotations`
turned every parameter annotation into a string, which crashes the SDK's
`isinstance(value, annotation)` check inside `convert_argument_from_function`
the moment the LLM tries to call any tool.

Each test below runs every tool through the actual SDK code paths used at
AFC time, so a similar regression surfaces here instead of as a silent
"I'm having a technical issue" message inside an LLM session.
"""

import inspect
from unittest.mock import MagicMock

import pytest
from google.genai._automatic_function_calling_util import _parse_schema_from_parameter
from google.genai._extra_utils import convert_argument_from_function

from backend.src.services.agent_tools import (
    create_agent_tools,
    create_build_tools,
    create_search_tools,
)
from backend.src.services.tool_executor import ToolExecutor


# Realistic call shapes for every tool — mirror what Gemini emits at runtime.
# A new tool MUST get a fixture here or test_all_tools_have_fixtures fails.
TOOL_CALL_FIXTURES: dict[str, dict] = {
    "add_node": {
        "name": "Renton, WA",
        "type": "city",
        "lat": 47.4829,
        "lng": -122.2171,
        "place_id": "ChIJabcdef",
        "arrival_time": "2026-08-02T03:00:00Z",
        "departure_time": "2026-08-02T04:00:00Z",
        "duration_minutes": 120,
    },
    "update_node": {
        "node_id": "n_hh61r82c",
        "arrival_time": "2026-08-02T03:00:00Z",
        "departure_time": "2026-08-02T04:00:00Z",
        "duration_minutes": 180,
    },
    "delete_node": {"node_id": "n_hh61r82c"},
    "add_edge": {
        "from_node_id": "n_v4s2oa7t",
        "to_node_id": "n_hh61r82c",
        "travel_mode": "drive",
        "notes": "scenic detour",
    },
    "delete_edge": {"edge_id": "e_xxxx1234"},
    "get_plan": {},
    "find_flights": {
        "origin": "SEA",
        "destination": "LHR",
        "date": "2026-08-02",
        "return_date": "2026-08-15",
        "cabin": "economy",
    },
}


def _all_tools() -> dict:
    executor = MagicMock(spec=ToolExecutor)
    flight_service = MagicMock()
    callables = (
        create_agent_tools(executor, can_mutate=True)
        + create_build_tools(executor)
        + create_search_tools(flight_service)
    )
    return {fn.__name__: fn for fn in callables}


@pytest.mark.parametrize("tool_name", list(TOOL_CALL_FIXTURES))
def test_tool_signature_has_no_string_annotations(tool_name: str):
    # PEP 563 / `from __future__ import annotations` turns every annotation
    # into a string and crashes the SDK's isinstance() check at runtime.
    tool = _all_tools()[tool_name]
    for param_name, param in inspect.signature(tool).parameters.items():
        assert not isinstance(param.annotation, str), (
            f"{tool_name}.{param_name}: annotation is the string "
            f"{param.annotation!r}. Remove `from __future__ import annotations` "
            f"from agent_tools.py or replace it with real type imports."
        )


@pytest.mark.parametrize("tool_name", list(TOOL_CALL_FIXTURES))
def test_tool_signature_parses_into_gemini_schema(tool_name: str):
    # Schema generation happens when the tool is registered with Gemini —
    # if a parameter is unparseable, the whole generate_content call dies.
    tool = _all_tools()[tool_name]
    for param_name, param in inspect.signature(tool).parameters.items():
        try:
            _parse_schema_from_parameter("GEMINI_API", param, tool_name)
        except Exception as e:
            pytest.fail(
                f"{tool_name}.{param_name} failed Gemini schema generation: {e}"
            )


@pytest.mark.parametrize(
    "tool_name,call_args",
    list(TOOL_CALL_FIXTURES.items()),
)
def test_tool_argument_conversion_matches_sdk_runtime(
    tool_name: str, call_args: dict
):
    # The exact code path the SDK runs after the LLM emits a function call.
    # This is the test that would have caught the original regression.
    tool = _all_tools()[tool_name]
    converted = convert_argument_from_function(call_args, tool)
    for k, v in call_args.items():
        assert converted[k] == v, (
            f"{tool_name}: arg {k} round-tripped to {converted[k]!r}, expected {v!r}"
        )


def test_all_tools_have_fixtures():
    # Forces anyone adding a new tool to also add a conversion fixture above,
    # keeping the SDK-compatibility check exhaustive.
    expected = set(TOOL_CALL_FIXTURES)
    actual = set(_all_tools())
    missing = actual - expected
    assert not missing, (
        f"New tool(s) {missing} need entries in TOOL_CALL_FIXTURES so the "
        f"SDK conversion test stays exhaustive."
    )
    stale = expected - actual
    assert not stale, (
        f"Fixture(s) {stale} no longer correspond to a real tool — remove them."
    )
