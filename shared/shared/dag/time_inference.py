"""Read-time enrichment for flex-planning node timings.

``enrich_dag_times`` takes raw nodes and edges from Firestore plus the
parent trip's settings and returns the same nodes with inferred
``arrival_time`` / ``departure_time`` / ``duration_minutes`` filled in,
plus a set of flags describing how each value was produced.

The algorithm is pure — no I/O, no ``datetime.now()`` — so both the
backend and the TypeScript mirror in ``frontend/lib/time-inference.ts``
can stay in lockstep via a shared JSON fixture.

Design notes:
- Time-bound nodes (user set both arrival and departure) act as hard
  anchors: the pass respects them as-is and surfaces a ``timing_conflict``
  warning if an upstream chain would propagate a different arrival.
- Duration-bound nodes inherit arrival from their parents' projected
  departure + the incoming edge's travel time, then derive departure as
  arrival + duration. Missing duration defaults to 30 min.
- Mixed-bound nodes combine a user-set arrival OR departure with a
  duration. The missing side is computed, never overwritten.
- A "no-drive window" (default 22:00→06:00 local) and a max-drive-hours
  cap (default 10 h / day) flag drives that cross the window or exceed
  the cap. When either rule fires, the child node at the far end of the
  offending edge gets ``drive_cap_warning = True`` and ``hold_reason``
  set to ``"night_drive"`` or ``"max_drive_hours"`` — a passive warning
  the UI can surface as an "add hotel?" affordance. When both rules fire
  on the same edge, ``night_drive`` takes precedence. Drive-hours reset
  at any ``type ∈ {'hotel','city'}`` node or at any node with
  ``duration_minutes >= 360`` (6 h) — users commonly mark "stay in
  Vienna" as a city node with the hotel attached as an action.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from shared.dag._internals import build_adjacency, parse_dt, toposort

DEFAULT_DURATION_MINUTES = 30
_REST_NODE_TYPES = frozenset({"hotel", "city"})
_REST_DURATION_MINUTES = 360  # 6 hours
_DRIVE_MODES = frozenset({"drive", "walk"})
_CONFLICT_TOLERANCE_SECONDS = 60
# Arriving early is usually fine; only surface once the buffer gets big enough
# to matter. Anything below this is suppressed entirely. Above it, an info
# chip shows the slack. Past EARLY_ADVISORY_MINUTES the gap is large enough
# that it's likely unintentional (missing intermediate stop, upstream typo).
_EARLY_SUPPRESS_MINUTES = 30
_EARLY_ADVISORY_MINUTES = 120


@dataclass(frozen=True)
class _NoDriveWindow:
    start_hour: int
    end_hour: int

    @property
    def crosses_midnight(self) -> bool:
        return self.start_hour >= self.end_hour


@dataclass(frozen=True)
class _TripRules:
    no_drive_window: _NoDriveWindow | None
    max_drive_hours_per_day: float | None
    default_tz: str | None


def enrich_dag_times(
    nodes: list[dict],
    edges: list[dict],
    trip_settings: dict | None = None,
) -> list[dict]:
    """Return a copy of ``nodes`` with inferred timing fields filled in.

    The returned list preserves input order so callers that render directly
    on top of Firestore snapshots don't have to re-sort. Each enriched node
    is a new dict (the input is never mutated) with these additions:

    - ``arrival_time`` / ``departure_time`` — always populated when
      derivable, otherwise left ``None``.
    - ``duration_minutes`` — always populated (user value or default).
    - ``arrival_time_estimated`` / ``departure_time_estimated`` /
      ``duration_estimated`` — booleans describing which fields were
      synthesized vs. user-set.
    - ``is_start`` / ``is_end`` — topology-derived flags (no incoming /
      outgoing edges).
    - ``timing_conflict`` — human readable message when a user-set time
      disagrees with what propagation would produce, otherwise ``None``.
      Pairs with ``timing_conflict_severity`` (``"info"`` | ``"advisory"``
      | ``"error"`` | ``None``): ``error`` = you'll be late, ``advisory`` =
      unusually large early buffer (≥2h), ``info`` = modest early buffer
      (30m–2h). Anything under 30m early is suppressed entirely to avoid
      false-positive noise that trains users to ignore the badge.
    - ``drive_cap_warning`` / ``hold_reason`` — set on the child of any
      edge whose drive crosses the no-drive window or exceeds the
      per-day cap. Night takes precedence when both rules fire.

    If ``edges`` contains a cycle, the pass is a no-op: each node keeps
    its user-set values, ``duration_minutes`` defaults to 30 when missing,
    topology flags are not set, and nothing is estimated. This is the
    same conservative fallback ``paths.py`` uses.
    """
    rules = _extract_rules(trip_settings or {})
    forward_adj, reverse_adj = build_adjacency(edges)
    order = toposort(nodes, forward_adj, reverse_adj)

    drafts: dict[str, dict] = {n["id"]: _draft_node(n, forward_adj, reverse_adj) for n in nodes}

    if order is None:
        # Cycle → bail out safely, still fill defaults for duration.
        return [drafts[n["id"]] for n in nodes]

    acc_drive_hours: dict[str, float] = defaultdict(float)

    for node_id in order:
        draft = drafts[node_id]
        parents = reverse_adj.get(node_id, [])

        # (a) Effective arrival. Always compute what propagation would say so
        # we can flag conflicts even when the user has pinned a time.
        propagated, per_parent_arrivals = _propagate_arrival(parents, drafts)
        user_arrival = parse_dt(draft.get("arrival_time"))
        if user_arrival is not None:
            if propagated is not None:
                _check_arrival_conflict(draft, user_arrival, propagated)
        elif propagated is not None:
            draft["arrival_time"] = propagated.isoformat()
            draft["arrival_time_estimated"] = True

        if per_parent_arrivals is not None:
            draft["per_parent_arrivals"] = per_parent_arrivals

        # (b) Effective departure
        user_departure = parse_dt(draft.get("departure_time"))
        eff_departure = _resolve_departure(draft, user_departure)
        if eff_departure is not None and user_departure is None:
            draft["departure_time"] = eff_departure.isoformat()
            draft["departure_time_estimated"] = True

        # Start node special case: departure is a point-in-time. With no
        # arrival user set, we also publish it as the effective arrival so
        # downstream edges can project off a concrete timestamp.
        if (
            draft["is_start"]
            and draft.get("arrival_time") is None
            and eff_departure is not None
        ):
            draft["arrival_time"] = eff_departure.isoformat()
            draft["arrival_time_estimated"] = True

        if _is_rest_node(draft):
            acc_drive_hours[node_id] = 0.0

        # (c) Apply night / max-drive-hours rules to outgoing drive edges and propagate
        outgoing = forward_adj.get(node_id, [])
        tz_name = draft.get("timezone") or rules.default_tz
        tz = _resolve_zone(tz_name)
        departure = parse_dt(draft.get("departure_time"))

        for edge in outgoing:
            child_id = edge["to_node_id"]
            child = drafts.get(child_id)
            if child is None:
                continue

            mode = edge.get("travel_mode")
            travel_hours = _effective_travel_hours(edge)

            hold_reason = None
            if mode in _DRIVE_MODES:
                if (
                    rules.max_drive_hours_per_day is not None
                    and acc_drive_hours[node_id] + travel_hours > rules.max_drive_hours_per_day
                ):
                    hold_reason = "max_drive_hours"

                if tz is not None and rules.no_drive_window is not None and departure is not None:
                    projected_arrival = departure + timedelta(hours=travel_hours)
                    if _overlaps_window(departure, projected_arrival, rules.no_drive_window, tz):
                        # Night-drive takes precedence when both rules fire on the same edge.
                        hold_reason = "night_drive"

            if hold_reason is not None:
                child["drive_cap_warning"] = True
                child["hold_reason"] = hold_reason

            # (d) Propagate drive-hours to each child.
            carry = acc_drive_hours[node_id]
            new_acc = carry + travel_hours if mode in _DRIVE_MODES else carry
            acc_drive_hours[child_id] = max(acc_drive_hours[child_id], new_acc)

    return [drafts[n["id"]] for n in nodes]


def _extract_rules(trip_settings: dict) -> _TripRules:
    raw_window = trip_settings.get("no_drive_window")
    window: _NoDriveWindow | None = None
    if raw_window is not None:
        window = _NoDriveWindow(
            start_hour=int(raw_window.get("start_hour", 22)),
            end_hour=int(raw_window.get("end_hour", 6)),
        )
    max_hours = trip_settings.get("max_drive_hours_per_day")
    max_hours_float = float(max_hours) if max_hours is not None else None
    return _TripRules(
        no_drive_window=window,
        max_drive_hours_per_day=max_hours_float,
        default_tz=trip_settings.get("default_timezone"),
    )


def _draft_node(
    node: dict,
    forward_adj: dict[str, list[dict]],
    reverse_adj: dict[str, list[dict]],
) -> dict:
    node_id = node["id"]
    duration = node.get("duration_minutes")
    duration_estimated = False
    if duration is None:
        duration = DEFAULT_DURATION_MINUTES
        duration_estimated = True

    draft = dict(node)
    draft.setdefault("arrival_time", None)
    draft.setdefault("departure_time", None)
    draft["duration_minutes"] = duration
    draft["duration_estimated"] = duration_estimated
    draft["arrival_time_estimated"] = False
    draft["departure_time_estimated"] = False
    draft["is_start"] = node_id not in reverse_adj
    draft["is_end"] = node_id not in forward_adj
    draft["timing_conflict"] = None
    draft["timing_conflict_severity"] = None
    draft["hold_reason"] = None
    draft["drive_cap_warning"] = False
    return draft


def _propagate_arrival(
    parents: list[dict],
    drafts: dict[str, dict],
) -> tuple[datetime | None, dict[str, str] | None]:
    """Compute propagated arrival from resolved parent departures.

    Returns ``(best_arrival, per_parent_arrivals)`` where:

    - ``best_arrival`` is ``max(parent.departure + edge.travel)`` across
      parents (the joint-start semantics used by drive-cap, conflict
      checks, and downstream propagation). ``None`` when any parent has
      no effective departure yet — the downstream node stays floating
      rather than guessing.
    - ``per_parent_arrivals`` is a ``{edge_key: iso_string}`` map emitted
      only when the node has ≥2 parents whose arrivals differ by more
      than ``_CONFLICT_TOLERANCE_SECONDS``. ``None`` otherwise. The
      ``edge_key`` is ``edge["id"]`` when present, else
      ``"{from_node_id}->{to_node_id}"`` — stable across Python/TS.
    """
    if not parents:
        return None, None
    best: datetime | None = None
    per_parent: dict[str, datetime] = {}
    for edge in parents:
        parent = drafts.get(edge["from_node_id"])
        if parent is None:
            continue
        parent_departure = parse_dt(parent.get("departure_time"))
        if parent_departure is None:
            return None, None
        travel_hours = _effective_travel_hours(edge)
        candidate = parent_departure + timedelta(hours=travel_hours)
        key = edge.get("id") or f"{edge['from_node_id']}->{edge['to_node_id']}"
        per_parent[key] = candidate
        if best is None or candidate > best:
            best = candidate
    if len(per_parent) < 2:
        return best, None
    values = list(per_parent.values())
    span = max(values) - min(values)
    if span.total_seconds() <= _CONFLICT_TOLERANCE_SECONDS:
        return best, None
    return best, {k: v.isoformat() for k, v in per_parent.items()}


def _resolve_departure(draft: dict, user_departure: datetime | None) -> datetime | None:
    if user_departure is not None:
        return user_departure
    arrival = parse_dt(draft.get("arrival_time"))
    if arrival is None:
        return None
    duration = int(draft["duration_minutes"])
    return arrival + timedelta(minutes=duration)


def _check_arrival_conflict(
    draft: dict,
    user_arrival: datetime,
    propagated: datetime,
) -> None:
    delta = abs((propagated - user_arrival).total_seconds())
    if delta <= _CONFLICT_TOLERANCE_SECONDS:
        return
    direction = "early" if propagated < user_arrival else "late"
    delta_minutes = delta / 60
    if direction == "early":
        if delta_minutes < _EARLY_SUPPRESS_MINUTES:
            return
        severity = "info" if delta_minutes < _EARLY_ADVISORY_MINUTES else "advisory"
    else:
        severity = "error"
    draft["timing_conflict"] = (
        f"Propagated arrival {propagated.isoformat()} is "
        f"{_format_delta(delta)} {direction} vs user arrival "
        f"{user_arrival.isoformat()}"
    )
    draft["timing_conflict_severity"] = severity


def _format_delta(seconds: float) -> str:
    minutes = int(round(seconds / 60))
    if minutes < 60:
        return f"{minutes}m"
    hours, rem = divmod(minutes, 60)
    if rem == 0:
        return f"{hours}h"
    return f"{hours}h{rem:02d}m"


_MODE_SPEEDS_KMH: dict[str, float] = {
    "drive": 80.0,
    "walk": 5.0,
    "transit": 30.0,
    "ferry": 40.0,
    "flight": 800.0,
}


def _effective_travel_hours(edge: dict) -> float:
    """Return travel_time_hours, estimating from distance when the value is 0/missing."""
    hours = float(edge.get("travel_time_hours") or 0)
    if hours > 0:
        return hours
    distance_km = edge.get("distance_km")
    if distance_km is None:
        return 0.0
    mode = edge.get("travel_mode", "drive")
    speed = _MODE_SPEEDS_KMH.get(mode, 80.0)
    return float(distance_km) / speed


def _resolve_zone(tz_name: str | None) -> ZoneInfo | None:
    if not tz_name:
        return None
    try:
        return ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return None


def _overlaps_window(
    start: datetime,
    end: datetime,
    window: _NoDriveWindow,
    tz: ZoneInfo,
) -> bool:
    """Return True if any portion of ``[start, end]`` falls inside the window.

    Walks the range by calendar day in the local timezone and checks whether
    each day's window intersects the interval. This correctly handles trips
    that cross midnight or span multiple days.
    """
    local_start = start.astimezone(tz)
    local_end = end.astimezone(tz)
    day = local_start.date() - timedelta(days=1)
    end_day = local_end.date()
    while day <= end_day + timedelta(days=1):
        for interval_start, interval_end in _window_intervals(day, window, tz):
            if interval_start < local_end and interval_end > local_start:
                return True
        day = day + timedelta(days=1)
    return False


def _window_intervals(
    day,
    window: _NoDriveWindow,
    tz: ZoneInfo,
) -> list[tuple[datetime, datetime]]:
    """Return concrete datetime intervals for the window on a given local day."""
    if window.crosses_midnight:
        evening_start = datetime.combine(day, time(hour=window.start_hour), tzinfo=tz)
        next_morning = datetime.combine(day + timedelta(days=1), time(hour=window.end_hour), tzinfo=tz)
        return [(evening_start, next_morning)]
    start = datetime.combine(day, time(hour=window.start_hour), tzinfo=tz)
    end = datetime.combine(day, time(hour=window.end_hour), tzinfo=tz)
    return [(start, end)]


def _is_rest_node(draft: dict) -> bool:
    node_type = draft.get("type")
    if node_type in _REST_NODE_TYPES:
        return True
        
    arr = parse_dt(draft.get("arrival_time"))
    dep = parse_dt(draft.get("departure_time"))
    if arr is not None and dep is not None:
        tz = _resolve_zone(draft.get("timezone") or "UTC")
        if tz is not None:
            if arr.astimezone(tz).date() != dep.astimezone(tz).date():
                return True
                
        effective_minutes = (dep - arr).total_seconds() / 60.0
        if effective_minutes >= _REST_DURATION_MINUTES:
            return True

    duration = draft.get("duration_minutes") or 0
    return int(duration) >= _REST_DURATION_MINUTES
