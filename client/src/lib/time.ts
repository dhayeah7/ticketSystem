import type { ShiftView } from "../types";

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Minutes-from-midnight to "HH:MM" (1440 renders as "24:00"). */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Value for a native `<input type="time">`, which can't represent 24:00 — an
 * end-of-day `end_minute` (1440) is shown as "00:00".
 */
export function toTimeInputValue(min: number): string {
  return formatMinutes(min === 1440 ? 0 : min);
}

/**
 * Parse "HH:MM" from a time input into minutes-from-midnight (0..1439), or null
 * if the field is empty/malformed. The API accepts any minute, so there is no
 * rounding — every minute is selectable.
 */
export function parseTimeInput(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Human-readable summary of one shift. */
export function describeShift(s: ShiftView): string {
  const day = DAY_NAMES[s.day_of_week] ?? "?";
  const start = formatMinutes(s.start_minute);
  const end = formatMinutes(s.end_minute);
  return s.crosses_midnight
    ? `${day} ${start} → ${end} (+1 day)`
    : `${day} ${start}–${end}`;
}

/**
 * Short, readable label for a zone: the city part of an IANA id with
 * underscores as spaces (e.g. "America/New_York" -> "New York"). Falls back to
 * the raw value for single-segment zones like "UTC".
 */
export function shortZone(tz: string): string {
  const parts = tz.split("/");
  const city = parts[parts.length - 1] || tz;
  return city.replace(/_/g, " ");
}

/** Best-effort list of IANA time zones for the dropdown. */
export function getTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    if (typeof intl.supportedValuesOf === "function") {
      return intl.supportedValuesOf("timeZone");
    }
  } catch {
    // fall through to the curated list
  }
  return [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
}

/** The browser's current zone, defaulting to UTC. */
export function guessZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
