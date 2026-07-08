import { DateTime, IANAZone } from "luxon";

/**
 * A recurring weekly shift window in the agent's LOCAL time.
 * Mirrors the `shifts` table but in camelCase domain form.
 *
 *  - dayOfWeek: 0 = Mon .. 6 = Sun, the day the window STARTS (agent-local)
 *  - startMinute: minutes from local midnight, inclusive (0..1439)
 *  - endMinute: exclusive (1..1440)
 *  - crossesMidnight: if true, the window runs to `endMinute` on the NEXT day
 *    (e.g. Fri 22:00 -> Sat 06:00 is one row with dayOfWeek = Fri)
 */
export interface Shift {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
}

/**
 * Luxon reports weekdays as 1 = Mon .. 7 = Sun. Our storage uses 0 = Mon .. 6 =
 * Sun. This is the single conversion point referenced by the design.
 */
export function luxonWeekdayToDayOfWeek(weekday: number): number {
  if (weekday < 1 || weekday > 7) {
    throw new Error(`Expected a Luxon weekday 1..7, got ${weekday}`);
  }
  return weekday - 1;
}

/** True if `timeZone` is a valid IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  return IANAZone.isValidZone(timeZone);
}

/**
 * Map an absolute instant to the agent-local weekday and minute-of-day.
 *
 * Because we convert a real instant into the zone, DST falls out naturally:
 * a wall-clock time inside a spring-forward gap is never produced by any
 * instant, and a fall-back hour is produced by two distinct instants.
 * Seconds are truncated — shifts are minute-granular.
 */
export function localParts(
  instant: Date,
  timeZone: string
): { dayOfWeek: number; minuteOfDay: number } {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  if (!local.isValid) {
    throw new Error(
      `Invalid time zone "${timeZone}": ${local.invalidReason ?? "unknown"}`
    );
  }
  return {
    dayOfWeek: luxonWeekdayToDayOfWeek(local.weekday),
    minuteOfDay: local.hour * 60 + local.minute,
  };
}

/** Does a single shift window cover the given local weekday + minute-of-day? */
function shiftCovers(
  shift: Shift,
  dayOfWeek: number,
  minuteOfDay: number
): boolean {
  if (!shift.crossesMidnight) {
    return (
      dayOfWeek === shift.dayOfWeek &&
      minuteOfDay >= shift.startMinute &&
      minuteOfDay < shift.endMinute
    );
  }

  // Overnight window: split across two calendar days.
  //  - start day: from startMinute (inclusive) to end of day
  //  - next day:  from midnight to endMinute (exclusive)
  // The two halves meet exactly at midnight, so there is no gap or overlap.
  const nextDay = (shift.dayOfWeek + 1) % 7;
  const onStartDay =
    dayOfWeek === shift.dayOfWeek && minuteOfDay >= shift.startMinute;
  const onNextDay = dayOfWeek === nextDay && minuteOfDay < shift.endMinute;
  return onStartDay || onNextDay;
}

/**
 * Is the agent available at `instant`? True if the instant, expressed in the
 * agent's local zone, falls inside any of their shift windows. Availability is
 * boolean, so overlapping shifts never double-count.
 */
export function isAvailableAt(
  instant: Date,
  timeZone: string,
  shifts: Shift[]
): boolean {
  const { dayOfWeek, minuteOfDay } = localParts(instant, timeZone);
  return shifts.some((shift) => shiftCovers(shift, dayOfWeek, minuteOfDay));
}
