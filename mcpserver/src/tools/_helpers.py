"""Shared helpers for MCP tool handlers.

- Gate A (editor):      resolve_trip_plan — admin or planner, plan resolution.
- Gate B (participant): resolve_trip_participant — any participant, plan resolution.
- Gate C (admin):       resolve_trip_admin — admin only, no plan resolution.
- Gate D (auth):        resolve_authenticated — any authenticated user.

Every @mcp.tool() must call exactly one gate on its first executable line.
Analytics (``mcp_tool_called``) is fired by ``AnalyticsMiddleware`` around
every call, not by these gates.
"""

import functools
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastmcp import Context
from mcpserver.src.auth.api_key_auth import RateLimitError, get_user_id
from mcpserver.src.main import AppContext

from shared.dag.cycle import CycleDetectedError

logger = logging.getLogger(__name__)


def tool_error_guard[F: Callable[..., Awaitable[Any]]](func: F) -> F:
    """Decorator for dict-returning MCP tools — catches domain exceptions.

    Without this, any `PermissionError` / `LookupError` / `ValueError` /
    `CycleDetectedError` raised from a service call would bubble out of the
    tool handler as an unhandled Python exception. That surfaces as a raw
    JSON-RPC error with the bare message — no structure, no error code.

    Wrap every dict-returning @mcp.tool() with this so tools return the
    same shape on success and failure: either the normal dict or
    ``{"error": {...}}``.
    """

    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await func(*args, **kwargs)
        except RateLimitError as exc:
            return {"error": {"code": "RATE_LIMITED", "message": str(exc)}}
        except PermissionError as exc:
            return {"error": {"code": "FORBIDDEN", "message": str(exc)}}
        except LookupError as exc:
            return {"error": {"code": "NOT_FOUND", "message": str(exc)}}
        except CycleDetectedError as exc:
            return {
                "error": {
                    "code": "CYCLE_DETECTED",
                    "message": str(exc),
                    "cycle_path": exc.cycle_path,
                },
            }
        except ValueError as exc:
            return {"error": {"code": "VALIDATION_ERROR", "message": str(exc)}}
        except Exception:
            # Log with full traceback for operators, return a generic message
            # to the caller so nothing sensitive leaks into the MCP response.
            logger.exception("Unhandled error in MCP tool %s", func.__name__)
            return {
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Internal error while handling request",
                },
            }

    return wrapper  # type: ignore[return-value]


def tool_error_guard_text[F: Callable[..., Awaitable[Any]]](func: F) -> F:
    """Decorator for text-returning MCP tools — same as tool_error_guard but
    returns a short error string instead of a dict on failure, keeping the
    function's return type consistent on both paths.
    """

    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return await func(*args, **kwargs)
        except RateLimitError as exc:
            return f"Error: rate limit exceeded — {exc}"
        except PermissionError as exc:
            return f"Error: forbidden — {exc}"
        except LookupError as exc:
            return f"Error: not found — {exc}"
        except CycleDetectedError as exc:
            return f"Error: cycle detected — {exc}"
        except ValueError as exc:
            return f"Error: invalid input — {exc}"
        except Exception:
            logger.exception("Unhandled error in MCP tool %s", func.__name__)
            return "Error: internal server error."

    return wrapper  # type: ignore[return-value]


async def _resolve_trip_and_role(
    ctx: Context,
    trip_id: str,
) -> tuple[str, dict, str]:
    """Internal: resolve user, fetch trip, and verify participant membership.

    Returns (user_id, trip_data, participant_role). Raises PermissionError
    if the caller is not a participant of this trip, LookupError if the
    trip does not exist.
    """
    user_id = get_user_id(ctx)
    app: AppContext = ctx.lifespan_context

    trip_data, role = await app.trip_service.resolve_participant(trip_id, user_id)
    return user_id, trip_data, role


def _resolve_plan(trip_data: dict, plan_id: str | None) -> str:
    """Return ``plan_id`` or the trip's active plan; raise if neither is set."""
    resolved = plan_id or trip_data.get("active_plan_id")
    if not resolved:
        raise ValueError("Trip has no active plan and no plan_id was provided")
    return resolved


async def resolve_trip_plan(
    ctx: Context,
    trip_id: str,
    plan_id: str | None = None,
) -> tuple[str, str, str]:
    """Resolve user_id, verify participant + editor role, and resolve plan_id.

    Returns (user_id, plan_id, trip_name).
    Raises PermissionError if user is not an admin/planner.
    Raises ValueError if trip has no active plan and no plan_id provided.
    """
    user_id, trip_data, role = await _resolve_trip_and_role(ctx, trip_id)
    app: AppContext = ctx.lifespan_context
    app.trip_service.require_editor(role)
    resolved_plan_id = _resolve_plan(trip_data, plan_id)
    return user_id, resolved_plan_id, trip_data.get("name", trip_id)


async def resolve_trip_participant(
    ctx: Context,
    trip_id: str,
    plan_id: str | None = None,
) -> tuple[str, str, str]:
    """Resolve user_id, verify the caller is any trip participant, and resolve plan_id.

    Returns (user_id, plan_id, trip_name).
    Raises PermissionError if user is not a participant.
    Raises ValueError if trip has no active plan and no plan_id provided.
    """
    user_id, trip_data, _role = await _resolve_trip_and_role(ctx, trip_id)
    resolved_plan_id = _resolve_plan(trip_data, plan_id)
    return user_id, resolved_plan_id, trip_data.get("name", trip_id)


async def resolve_trip_admin(
    ctx: Context,
    trip_id: str,
) -> tuple[str, str]:
    """Resolve user_id and verify the caller is a trip admin.

    Returns (user_id, trip_name).
    Raises PermissionError if the user is not a participant or not an admin.
    """
    user_id, trip_data, role = await _resolve_trip_and_role(ctx, trip_id)
    app: AppContext = ctx.lifespan_context
    app.trip_service.require_admin(role)
    return user_id, trip_data.get("name", trip_id)


async def resolve_authenticated(ctx: Context) -> str:
    """Gate D: authenticated-only tools (``create_trip``, ``find_places``,
    ``find_flights``, simple trip listings). Returns the user_id.
    """
    return get_user_id(ctx)
