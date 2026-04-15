"""FastMCP middleware that fires a GA4 ``mcp_tool_called`` event per tool call.

Sits in the ``on_call_tool`` hook so analytics stays out of the auth gates
and tool bodies. The POST is scheduled via ``asyncio.create_task`` so the
tool response does not wait on the GA4 round-trip.
"""

import asyncio
import logging
from typing import Any

from fastmcp.server.dependencies import get_access_token
from fastmcp.server.middleware import Middleware, MiddlewareContext

from mcpserver.src.main import AppContext

logger = logging.getLogger(__name__)

# Strong references to in-flight analytics tasks. asyncio.create_task only
# holds a weak reference, so the event loop GC can collect tasks mid-flight
# (stdlib docs call this out). The done callback removes finished entries.
_PENDING_TRACKING_TASKS: set[asyncio.Task[None]] = set()


def _on_tracking_task_done(task: asyncio.Task[None]) -> None:
    _PENDING_TRACKING_TASKS.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.warning(
            "Background analytics task raised: %s", exc, exc_info=exc,
        )


class AnalyticsMiddleware(Middleware):
    """Fires ``mcp_tool_called`` for every ``@mcp.tool()`` invocation.

    The AnalyticsService is read from the lifespan context at call time so
    the middleware shares the app's single httpx client. If auth failed
    earlier in the chain, ``get_access_token()`` returns ``None`` and the
    event is skipped — FastMCP's BearerAuthBackend would have already
    rejected the request before we got here.
    """

    async def on_call_tool(
        self,
        context: MiddlewareContext[Any],
        call_next: Any,
    ) -> Any:
        status = "success"
        try:
            return await call_next(context)
        except Exception:
            status = "error"
            raise
        finally:
            self._dispatch(context, status)

    def _dispatch(self, context: MiddlewareContext[Any], status: str) -> None:
        fastmcp_context = context.fastmcp_context
        if fastmcp_context is None:
            return

        token = get_access_token()
        if token is None or not token.client_id:
            return

        app: AppContext = fastmcp_context.lifespan_context
        args = context.message.arguments or {}

        params: dict[str, Any] = {
            "tool_name": context.message.name,
            "result": status,
        }
        if trip_id := args.get("trip_id"):
            params["trip_id"] = trip_id
        if plan_id := args.get("plan_id"):
            params["plan_id"] = plan_id

        task = asyncio.create_task(
            app.analytics_service.track_event(
                token.client_id, "mcp_tool_called", params,
            ),
        )
        _PENDING_TRACKING_TASKS.add(task)
        task.add_done_callback(_on_tracking_task_done)
