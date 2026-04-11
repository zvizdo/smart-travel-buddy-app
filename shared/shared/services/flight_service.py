"""Flight search service wrapping the fli (flights) library.

Provides async flight search via Google Flights. The fli library uses
synchronous curl_cffi under the hood, so all calls are bridged to async
via asyncio.to_thread().
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime

from fli.models import (
    Airport,
    FlightSearchFilters,
    FlightSegment,
    MaxStops,
    PassengerInfo,
    SeatType,
    TripType,
)
from fli.models.google_flights.base import FlightResult
from fli.search import SearchFlights

logger = logging.getLogger(__name__)

# --- Mapping dicts for string -> enum conversion ---

_CABIN_MAP: dict[str, SeatType] = {
    "economy": SeatType.ECONOMY,
    "premium_economy": SeatType.PREMIUM_ECONOMY,
    "business": SeatType.BUSINESS,
    "first": SeatType.FIRST,
}

_STOPS_MAP: dict[str, MaxStops] = {
    "any": MaxStops.ANY,
    "nonstop": MaxStops.NON_STOP,
    "one_stop": MaxStops.ONE_STOP_OR_FEWER,
    "two_stops": MaxStops.TWO_OR_FEWER_STOPS,
}

_CURRENCY_SYMBOLS: dict[str, str] = {
    "USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "CNY": "¥",
    "KRW": "₩", "INR": "₹", "RUB": "₽", "TRY": "₺", "BRL": "R$",
    "ZAR": "R", "CHF": "CHF", "SEK": "kr", "NOK": "kr", "DKK": "kr",
    "PLN": "zł", "CZK": "Kč", "HUF": "Ft", "AUD": "A$", "CAD": "C$",
    "NZD": "NZ$", "SGD": "S$", "HKD": "HK$", "MXN": "MX$", "THB": "฿",
}


class FlightSearchError(Exception):
    """Raised when flight search fails due to invalid input or upstream errors."""


# --- Result dataclasses ---


@dataclass(frozen=True)
class FlightLeg:
    airline: str
    flight_number: str
    departure_airport: str
    arrival_airport: str
    departure_time: datetime
    arrival_time: datetime
    duration_minutes: int


@dataclass(frozen=True)
class FlightOption:
    price: float
    currency: str
    total_duration_minutes: int
    stops: int
    legs: list[FlightLeg] = field(default_factory=list)


@dataclass
class FlightSearchResult:
    origin: str
    destination: str
    date: str
    return_date: str | None
    outbound: list[FlightOption] = field(default_factory=list)
    return_flights: list[FlightOption] = field(default_factory=list)


# --- Service ---


class FlightService:
    """Async flight search via Google Flights (fli library)."""

    def __init__(self) -> None:
        self._searcher = SearchFlights()

    async def search(
        self,
        origin: str,
        destination: str,
        date: str,
        return_date: str | None = None,
        cabin: str = "economy",
        max_stops: str = "any",
        max_results: int = 5,
        adults: int = 1,
    ) -> FlightSearchResult:
        """Search for flights between two airports.

        Args:
            origin: IATA airport code (e.g. "LHR").
            destination: IATA airport code (e.g. "JFK").
            date: Departure date as YYYY-MM-DD.
            return_date: Return date as YYYY-MM-DD for round-trips.
            cabin: Cabin class — economy, premium_economy, business, first.
            max_stops: Stop filter — any, nonstop, one_stop, two_stops.
            max_results: Max number of flight options to return (1-10).
            adults: Number of adult passengers (1-9).

        Returns:
            FlightSearchResult with outbound (and optionally return) flights.

        Raises:
            FlightSearchError: On invalid input or upstream failure.
        """
        # Validate IATA codes
        try:
            origin_airport = Airport[origin.upper()]
        except KeyError as exc:
            raise FlightSearchError(
                f"Unknown airport code: {origin.upper()}. Use IATA codes like JFK, LHR, CDG."
            ) from exc
        try:
            dest_airport = Airport[destination.upper()]
        except KeyError as exc:
            raise FlightSearchError(
                f"Unknown airport code: {destination.upper()}. Use IATA codes like JFK, LHR, CDG."
            ) from exc

        # Validate cabin and stops
        seat_type = _CABIN_MAP.get(cabin.lower())
        if seat_type is None:
            raise FlightSearchError(
                f"Unknown cabin class: {cabin}. Use: economy, premium_economy, business, first."
            )
        stops = _STOPS_MAP.get(max_stops.lower())
        if stops is None:
            raise FlightSearchError(
                f"Unknown stops filter: {max_stops}. Use: any, nonstop, one_stop, two_stops."
            )

        max_results = max(1, min(10, max_results))
        adults = max(1, min(9, adults))

        # Build segments
        segments = [
            FlightSegment(
                departure_airport=[[origin_airport, 0]],
                arrival_airport=[[dest_airport, 0]],
                travel_date=date,
            )
        ]
        trip_type = TripType.ONE_WAY
        if return_date:
            trip_type = TripType.ROUND_TRIP
            segments.append(
                FlightSegment(
                    departure_airport=[[dest_airport, 0]],
                    arrival_airport=[[origin_airport, 0]],
                    travel_date=return_date,
                )
            )

        filters = FlightSearchFilters(
            trip_type=trip_type,
            passenger_info=PassengerInfo(adults=adults),
            flight_segments=segments,
            seat_type=seat_type,
            stops=stops,
        )

        # Run synchronous fli search in a thread
        try:
            raw_results = await asyncio.to_thread(
                self._searcher.search, filters, max_results
            )
        except Exception as exc:
            logger.warning("Flight search failed: %s", exc, exc_info=True)
            raise FlightSearchError(
                "Flight search temporarily unavailable. Try again in a few minutes."
            ) from exc

        result = FlightSearchResult(
            origin=origin.upper(),
            destination=destination.upper(),
            date=date,
            return_date=return_date,
        )

        if not raw_results:
            return result

        if return_date:
            # Round-trip: raw_results is list of tuples (outbound, return)
            for combo in raw_results[:max_results]:
                if isinstance(combo, tuple) and len(combo) >= 2:
                    result.outbound.append(_convert_flight(combo[0]))
                    result.return_flights.append(_convert_flight(combo[1]))
        else:
            # One-way: raw_results is list of FlightResult
            for flight in raw_results[:max_results]:
                result.outbound.append(_convert_flight(flight))

        return result


def _convert_flight(fr: FlightResult) -> FlightOption:
    """Convert a fli FlightResult into our FlightOption dataclass."""
    legs = [
        FlightLeg(
            airline=leg.airline.value,  # human-readable name
            flight_number=f"{leg.airline.name}{leg.flight_number}",
            departure_airport=leg.departure_airport.name,
            arrival_airport=leg.arrival_airport.name,
            departure_time=leg.departure_datetime,
            arrival_time=leg.arrival_datetime,
            duration_minutes=leg.duration,
        )
        for leg in fr.legs
    ]
    return FlightOption(
        price=fr.price,
        currency=fr.currency or "USD",
        total_duration_minutes=fr.duration,
        stops=fr.stops,
        legs=legs,
    )


def format_flight_results(result: FlightSearchResult) -> str:
    """Format a FlightSearchResult into a human-readable string for tool output."""
    if not result.outbound:
        msg = f"No flights found from {result.origin} to {result.destination} on {result.date}."
        if result.return_date:
            msg += f" (return: {result.return_date})"
        return msg

    lines: list[str] = []

    if result.return_date:
        lines.append(
            f"Round-trip flights {result.origin} -> {result.destination} "
            f"({result.date} / {result.return_date}):"
        )
        for i, (out, ret) in enumerate(
            zip(result.outbound, result.return_flights, strict=False), 1
        ):
            combined_price = out.price + ret.price
            sym = _CURRENCY_SYMBOLS.get(out.currency, out.currency + " ")
            lines.append("")
            lines.append(
                f"{i}. {sym}{combined_price:,.0f} | "
                f"Outbound {_fmt_duration(out.total_duration_minutes)} "
                f"{'nonstop' if out.stops == 0 else f'{out.stops} stop{"s" if out.stops > 1 else ""}'}"
                f" + Return {_fmt_duration(ret.total_duration_minutes)} "
                f"{'nonstop' if ret.stops == 0 else f'{ret.stops} stop{"s" if ret.stops > 1 else ""}'}"
            )
            lines.append("   Outbound:")
            for leg in out.legs:
                lines.append(f"   {_fmt_leg(leg)}")
            lines.append("   Return:")
            for leg in ret.legs:
                lines.append(f"   {_fmt_leg(leg)}")
    else:
        lines.append(f"Flights from {result.origin} to {result.destination} on {result.date}:")
        for i, flight in enumerate(result.outbound, 1):
            sym = _CURRENCY_SYMBOLS.get(flight.currency, flight.currency + " ")
            stop_text = "nonstop" if flight.stops == 0 else (
                f"{flight.stops} stop{'s' if flight.stops > 1 else ''}"
            )
            lines.append("")
            lines.append(
                f"{i}. {sym}{flight.price:,.0f} | "
                f"{_fmt_duration(flight.total_duration_minutes)} | {stop_text}"
            )
            for leg in flight.legs:
                lines.append(f"   {_fmt_leg(leg)}")

    return "\n".join(lines)


def _fmt_duration(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    return f"{h}h {m:02d}m"


def _fmt_leg(leg: FlightLeg) -> str:
    dep = leg.departure_time.strftime("%H:%M")
    arr = leg.arrival_time.strftime("%H:%M %b %d")
    return f"{leg.departure_airport} {dep} -> {leg.arrival_airport} {arr} | {leg.airline} {leg.flight_number}"
