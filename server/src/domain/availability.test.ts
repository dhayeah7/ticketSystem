import { DateTime } from "luxon";
import {
  Shift,
  isAvailableAt,
  isValidTimeZone,
  localParts,
  luxonWeekdayToDayOfWeek,
} from "./availability";

// Day-of-week constants in our 0 = Mon .. 6 = Sun encoding.
const MON = 0;
const FRI = 4;
const SUN = 6;

// Build a shift with sensible defaults.
function shift(partial: Partial<Shift>): Shift {
  return {
    dayOfWeek: MON,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    crossesMidnight: false,
    ...partial,
  };
}

// An absolute instant expressed as a wall-clock time in a given zone.
function atLocal(iso: string, zone: string): Date {
  return DateTime.fromISO(iso, { zone }).toJSDate();
}

// An absolute instant from an explicit UTC ISO string (for DST precision).
function atUtc(iso: string): Date {
  return new Date(iso);
}

describe("luxonWeekdayToDayOfWeek", () => {
  it("maps all seven Luxon weekdays (1..7) to 0..6", () => {
    expect(luxonWeekdayToDayOfWeek(1)).toBe(0); // Mon
    expect(luxonWeekdayToDayOfWeek(2)).toBe(1); // Tue
    expect(luxonWeekdayToDayOfWeek(3)).toBe(2); // Wed
    expect(luxonWeekdayToDayOfWeek(4)).toBe(3); // Thu
    expect(luxonWeekdayToDayOfWeek(5)).toBe(4); // Fri
    expect(luxonWeekdayToDayOfWeek(6)).toBe(5); // Sat
    expect(luxonWeekdayToDayOfWeek(7)).toBe(6); // Sun
  });

  it("rejects out-of-range weekdays", () => {
    expect(() => luxonWeekdayToDayOfWeek(0)).toThrow();
    expect(() => luxonWeekdayToDayOfWeek(8)).toThrow();
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects nonsense zones", () => {
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("isAvailableAt - normal windows", () => {
  const shifts = [shift({ dayOfWeek: MON })]; // Mon 09:00-17:00

  it("is available inside the window", () => {
    expect(isAvailableAt(atLocal("2025-01-06T10:00", "UTC"), "UTC", shifts)).toBe(
      true
    );
  });

  it("is not available before the window", () => {
    expect(isAvailableAt(atLocal("2025-01-06T08:00", "UTC"), "UTC", shifts)).toBe(
      false
    );
  });

  it("is not available on a different day", () => {
    // Tuesday 10:00
    expect(isAvailableAt(atLocal("2025-01-07T10:00", "UTC"), "UTC", shifts)).toBe(
      false
    );
  });

  it("is not available with no shifts", () => {
    expect(isAvailableAt(atLocal("2025-01-06T10:00", "UTC"), "UTC", [])).toBe(
      false
    );
  });
});

describe("isAvailableAt - boundaries (start inclusive, end exclusive)", () => {
  const shifts = [shift({ dayOfWeek: MON })]; // Mon 09:00-17:00

  it("includes the exact start minute", () => {
    expect(isAvailableAt(atLocal("2025-01-06T09:00", "UTC"), "UTC", shifts)).toBe(
      true
    );
  });

  it("excludes the exact end minute", () => {
    expect(isAvailableAt(atLocal("2025-01-06T17:00", "UTC"), "UTC", shifts)).toBe(
      false
    );
  });

  it("includes one minute before end", () => {
    expect(isAvailableAt(atLocal("2025-01-06T16:59", "UTC"), "UTC", shifts)).toBe(
      true
    );
  });

  it("back-to-back shifts never double-match at the seam", () => {
    // 09:00-12:00 and 12:00-15:00; at exactly 12:00 only the second is active.
    const back2back = [
      shift({ dayOfWeek: MON, startMinute: 540, endMinute: 720 }),
      shift({ dayOfWeek: MON, startMinute: 720, endMinute: 900 }),
    ];
    expect(
      isAvailableAt(atLocal("2025-01-06T12:00", "UTC"), "UTC", back2back)
    ).toBe(true);
    // Sanity: 11:59 (first) and 14:59 (second) both covered.
    expect(
      isAvailableAt(atLocal("2025-01-06T11:59", "UTC"), "UTC", back2back)
    ).toBe(true);
    expect(
      isAvailableAt(atLocal("2025-01-06T14:59", "UTC"), "UTC", back2back)
    ).toBe(true);
  });
});

describe("isAvailableAt - overnight (crosses_midnight)", () => {
  // Fri 22:00 -> Sat 06:00, one row on Friday.
  const overnight = [
    shift({
      dayOfWeek: FRI,
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      crossesMidnight: true,
    }),
  ];

  it("matches the Friday evening portion", () => {
    // 2025-01-10 is a Friday.
    expect(
      isAvailableAt(atLocal("2025-01-10T23:00", "UTC"), "UTC", overnight)
    ).toBe(true);
  });

  it("includes the exact start on Friday", () => {
    expect(
      isAvailableAt(atLocal("2025-01-10T22:00", "UTC"), "UTC", overnight)
    ).toBe(true);
  });

  it("matches the early Saturday morning portion", () => {
    // 2025-01-11 is a Saturday.
    expect(
      isAvailableAt(atLocal("2025-01-11T05:00", "UTC"), "UTC", overnight)
    ).toBe(true);
  });

  it("is seamless across midnight (00:00 Saturday covered)", () => {
    expect(
      isAvailableAt(atLocal("2025-01-11T00:00", "UTC"), "UTC", overnight)
    ).toBe(true);
  });

  it("excludes the exact end on Saturday", () => {
    expect(
      isAvailableAt(atLocal("2025-01-11T06:00", "UTC"), "UTC", overnight)
    ).toBe(false);
  });

  it("is off before the start Friday and after the end Saturday", () => {
    expect(
      isAvailableAt(atLocal("2025-01-10T21:00", "UTC"), "UTC", overnight)
    ).toBe(false);
    expect(
      isAvailableAt(atLocal("2025-01-11T07:00", "UTC"), "UTC", overnight)
    ).toBe(false);
  });

  it("wraps the week boundary (Sun 22:00 -> Mon 06:00)", () => {
    const sunToMon = [
      shift({
        dayOfWeek: SUN,
        startMinute: 22 * 60,
        endMinute: 6 * 60,
        crossesMidnight: true,
      }),
    ];
    // 2025-01-12 Sunday 23:00, 2025-01-13 Monday 05:00.
    expect(
      isAvailableAt(atLocal("2025-01-12T23:00", "UTC"), "UTC", sunToMon)
    ).toBe(true);
    expect(
      isAvailableAt(atLocal("2025-01-13T05:00", "UTC"), "UTC", sunToMon)
    ).toBe(true);
  });
});

describe("isAvailableAt - agent zone differs from server/UTC", () => {
  const shifts = [shift({ dayOfWeek: MON })]; // Mon 09:00-17:00 local

  it("evaluates in the agent's zone (Asia/Kolkata 09:15 local)", () => {
    const instant = atLocal("2025-01-06T09:15", "Asia/Kolkata");
    // 09:15 IST is 03:45 UTC the same date.
    expect(instant.toISOString()).toBe("2025-01-06T03:45:00.000Z");
    expect(isAvailableAt(instant, "Asia/Kolkata", shifts)).toBe(true);
  });

  it("uses the agent-local day, not the UTC day", () => {
    // Monday 00:30 IST is Sunday 19:00 UTC. A Mon 00:00-06:00 shift must match.
    const earlyMon = [shift({ dayOfWeek: MON, startMinute: 0, endMinute: 360 })];
    const instant = atLocal("2025-01-06T00:30", "Asia/Kolkata");
    expect(instant.toISOString()).toBe("2025-01-05T19:00:00.000Z"); // Sunday in UTC
    expect(isAvailableAt(instant, "Asia/Kolkata", earlyMon)).toBe(true);
  });
});

describe("localParts / isAvailableAt - DST", () => {
  const zone = "America/New_York";

  it("spring-forward: the skipped 02:00-03:00 hour never occurs", () => {
    // 2025-03-09: clocks jump 02:00 EST -> 03:00 EDT.
    // 06:30Z is still EST (-5) -> 01:30 local.
    expect(localParts(atUtc("2025-03-09T06:30:00Z"), zone).minuteOfDay).toBe(90);
    // 07:00Z is the transition instant -> 03:00 EDT (-4), not 02:00.
    expect(localParts(atUtc("2025-03-09T07:00:00Z"), zone).minuteOfDay).toBe(180);

    const skipped = [
      shift({ dayOfWeek: SUN, startMinute: 120, endMinute: 180 }), // 02:00-03:00
    ];
    // No instant around the transition lands in the skipped window.
    expect(isAvailableAt(atUtc("2025-03-09T06:30:00Z"), zone, skipped)).toBe(
      false
    );
    expect(isAvailableAt(atUtc("2025-03-09T07:00:00Z"), zone, skipped)).toBe(
      false
    );

    // A 03:00-04:00 shift is active right at the post-jump instant.
    const afterJump = [
      shift({ dayOfWeek: SUN, startMinute: 180, endMinute: 240 }),
    ];
    expect(isAvailableAt(atUtc("2025-03-09T07:00:00Z"), zone, afterJump)).toBe(
      true
    );
  });

  it("fall-back: the repeated 01:00-02:00 hour matches twice", () => {
    // 2025-11-02: clocks fall 02:00 EDT -> 01:00 EST. Local 01:30 happens twice.
    const first = atUtc("2025-11-02T05:30:00Z"); // 01:30 EDT (-4)
    const second = atUtc("2025-11-02T06:30:00Z"); // 01:30 EST (-5)
    expect(localParts(first, zone).minuteOfDay).toBe(90);
    expect(localParts(second, zone).minuteOfDay).toBe(90);

    const repeated = [
      shift({ dayOfWeek: SUN, startMinute: 60, endMinute: 120 }), // 01:00-02:00
    ];
    expect(isAvailableAt(first, zone, repeated)).toBe(true);
    expect(isAvailableAt(second, zone, repeated)).toBe(true);
  });
});

describe("localParts - invalid zone", () => {
  it("throws on an unsupported zone", () => {
    expect(() => localParts(new Date(), "Mars/Phobos")).toThrow();
  });
});
