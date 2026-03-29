"""Timezone resolution from coordinates using timezonefinder."""

from timezonefinder import TimezoneFinder

_tf = TimezoneFinder()


def resolve_timezone(lat: float, lng: float) -> str | None:
    """Resolve IANA timezone string from lat/lng coordinates.

    Returns None if the location is over the ocean or otherwise unmapped.
    Examples: "Europe/Paris", "America/New_York", "Asia/Tokyo"
    """
    return _tf.timezone_at(lat=lat, lng=lng)
