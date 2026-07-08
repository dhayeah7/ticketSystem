import { Shift, isValidTimeZone } from "./availability";
import { ValidationError } from "../errors";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/** A non-empty name, trimmed. */
export function validateName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new ValidationError("name is required");
  }
  return name.trim();
}

/** A valid IANA time zone. */
export function validateTimezone(timezone: unknown): string {
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) {
    throw new ValidationError(`invalid timezone: ${String(timezone)}`);
  }
  return timezone;
}

/**
 * Opaque caller-supplied identifiers (company_id, ticket_id) are capped to a
 * sane length so unbounded input can't be stored. The value is otherwise
 * treated as opaque — not trimmed or normalized — so idempotency keys match
 * exactly what the caller sent.
 */
const MAX_ID_LENGTH = 255;

function validateOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} is required`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new ValidationError(`${field} must be at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

export function validateCompanyId(value: unknown): string {
  return validateOpaqueId(value, "company_id");
}

/**
 * Pagination for list endpoints. `page` is 0-based; `pageSize` is capped so a
 * caller can't request an unbounded slab. `limit`/`offset` are derived for SQL.
 */
export interface Pagination {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

// Query values arrive as strings (or string[] for repeated keys). Accept a
// single non-negative integer; anything else is a client error.
function parseNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }
  return Number(raw);
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = parseNonNegativeInt(query.page, "page") ?? 0;
  const pageSize =
    parseNonNegativeInt(query.pageSize, "pageSize") ?? DEFAULT_PAGE_SIZE;
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new ValidationError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return { page, pageSize, limit: pageSize, offset: page * pageSize };
}

export function validateTicketId(value: unknown): string {
  return validateOpaqueId(value, "ticket_id");
}

/**
 * Parse and validate one shift from the API (snake_case) into a domain Shift.
 * Enforces minute ranges and the crosses_midnight window rule; the DB CHECK is
 * a backstop, but we validate here to return 422 with a clear message.
 */
export function parseShift(raw: unknown): Shift {
  const r = (raw ?? {}) as Record<string, unknown>;
  const dayOfWeek = r.day_of_week;
  const startMinute = r.start_minute;
  const endMinute = r.end_minute;
  const crossesMidnight = r.crosses_midnight ?? false;

  if (!isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new ValidationError("day_of_week must be an integer 0..6");
  }
  if (!isInteger(startMinute) || startMinute < 0 || startMinute > 1439) {
    throw new ValidationError("start_minute must be an integer 0..1439");
  }
  if (!isInteger(endMinute) || endMinute < 1 || endMinute > 1440) {
    throw new ValidationError("end_minute must be an integer 1..1440");
  }
  if (typeof crossesMidnight !== "boolean") {
    throw new ValidationError("crosses_midnight must be a boolean");
  }
  if (!crossesMidnight && startMinute >= endMinute) {
    throw new ValidationError(
      "start_minute must be before end_minute (or set crosses_midnight)"
    );
  }
  // A single window is always under 24h (implementation.md §1). The only
  // non-crossing window that reaches exactly 24h is 0..1440; longer/full-day
  // coverage is expressed as multiple rows. (Crossing windows are always <24h.)
  if (!crossesMidnight && endMinute - startMinute >= 1440) {
    throw new ValidationError(
      "a single shift window must be under 24h; split a full-day shift into multiple rows"
    );
  }
  if (crossesMidnight && endMinute >= startMinute) {
    throw new ValidationError(
      "a crosses_midnight shift requires end_minute before start_minute"
    );
  }
  return { dayOfWeek, startMinute, endMinute, crossesMidnight };
}

export function parseShifts(raw: unknown): Shift[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError("shifts must be an array");
  }
  return raw.map(parseShift);
}
