from enum import StrEnum

from pydantic import BaseModel


class TravelMode(StrEnum):
    DRIVE = "drive"
    FERRY = "ferry"
    FLIGHT = "flight"
    TRANSIT = "transit"
    WALK = "walk"


class Edge(BaseModel):
    id: str
    from_node_id: str
    to_node_id: str
    travel_mode: TravelMode = TravelMode.DRIVE
    travel_time_hours: float = 0
    distance_km: float | None = None
    route_polyline: str | None = None
    notes: str | None = None
