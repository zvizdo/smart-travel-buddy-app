/**
 * Centralized date formatting utilities.
 *
 * All dates are stored as UTC ISO strings. These helpers convert
 * to a display timezone (node's IANA timezone or browser local) and back to UTC.
 */

const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Format a UTC ISO string as a short date.
 * Uses the node's timezone if provided, otherwise browser local.
 * Example: "Mon, Jun 1"
 */
export function formatDate(
  iso: string | null | undefined,
  timezone?: string,
): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timezone || browserTz(),
  }).format(new Date(iso));
}

/**
 * Format a UTC ISO string as date + time.
 * Uses the node's timezone if provided, otherwise browser local.
 * Example: "Jun 1, 10:00 AM"
 */
export function formatDateTime(
  iso: string | null | undefined,
  timezone?: string,
): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone || browserTz(),
  }).format(new Date(iso));
}

/**
 * Format a UTC ISO string as a relative date for notifications.
 * Example: "Jun 1, 2026"
 */
export function formatNotificationDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(new Date(iso));
}

/**
 * Convert a UTC ISO string to a value suitable for <input type="datetime-local">.
 * When timezone is provided, formats in that timezone; otherwise browser local.
 */
export function utcToLocalInput(
  iso: string | null | undefined,
  timezone?: string,
): string {
  if (!iso) return "";
  const date = new Date(iso);
  const tz = timezone || browserTz();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * Convert a datetime-local input value back to a UTC ISO string.
 * When timezone is provided, interprets the input as that timezone; otherwise browser local.
 */
export function localInputToUtc(
  localDatetime: string,
  timezone?: string,
): string {
  if (!localDatetime) return "";
  if (!timezone) {
    // Original behavior: interpret as browser local
    return new Date(localDatetime).toISOString();
  }
  // Interpret localDatetime as being in the given timezone:
  // 1. Parse components and create a UTC Date with those values
  const [datePart, timePart] = localDatetime.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);

  // 2. See what that UTC instant looks like in the target timezone
  const inTz = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcGuess));

  const get = (type: string) =>
    Number(inTz.find((p) => p.type === type)?.value ?? 0);
  const got = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
  );

  // 3. The difference is the timezone offset; adjust to get correct UTC
  return new Date(utcGuess - (got - utcGuess)).toISOString();
}

/**
 * Date format options for trip settings.
 * - "us"    → Jun 15, 2026  (month first)
 * - "eu"    → 15 Jun 2026   (day first)
 * - "iso"   → 2026-06-15    (YYYY-MM-DD)
 * - "short" → Mon, Jun 15   (weekday + month/day)
 */
export type DateFormatPreference = "us" | "eu" | "iso" | "short";

function formatDateOnly(
  date: Date,
  dateFormat: DateFormatPreference,
  tz: string,
): string {
  switch (dateFormat) {
    case "us":
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: tz,
      }).format(date);
    case "eu":
      return new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: tz,
      }).format(date);
    case "iso": {
      const parts = new Intl.DateTimeFormat("sv-SE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone: tz,
      }).formatToParts(date);
      const get = (type: string) =>
        parts.find((p) => p.type === type)?.value ?? "";
      return `${get("year")}-${get("month")}-${get("day")}`;
    }
    case "short":
      return new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: tz,
      }).format(date);
    default:
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: tz,
      }).format(date);
  }
}

function formatTimeOnly(date: Date, hour12: boolean, tz: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
    timeZone: tz,
  }).format(date);
}

/**
 * Format a UTC ISO string as date + time respecting the trip's preferences.
 * Uses the node's timezone if provided, otherwise browser local.
 */
export function formatDateTimeWithPreference(
  iso: string | null | undefined,
  timeFormat: "12h" | "24h" = "24h",
  dateFormat: DateFormatPreference = "eu",
  timezone?: string,
): string {
  if (!iso) return "-";
  const date = new Date(iso);
  const tz = timezone || browserTz();
  const datePart = formatDateOnly(date, dateFormat, tz);
  const timePart = formatTimeOnly(date, timeFormat === "12h", tz);
  return `${datePart}, ${timePart}`;
}

/**
 * Format a distance value respecting the trip's km/mi preference.
 */
export function formatDistance(
  km: number | null | undefined,
  unit: "km" | "mi" = "km",
): string {
  if (km == null) return "";
  if (unit === "mi") {
    const miles = km * 0.621371;
    return `${Math.round(miles)} mi`;
  }
  return `${Math.round(km)} km`;
}

/**
 * Format a travel time in hours to a human-readable string.
 */
export function formatTravelTime(hours: number): string {
  if (hours >= 1) {
    return `${Math.round(hours * 10) / 10}h`;
  }
  return `${Math.round(hours * 60)} min`;
}
