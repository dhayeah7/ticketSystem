import request from "supertest";
import { DateTime } from "luxon";
import { app } from "../index";
import { pool } from "../db";
import {
  SeedShift,
  closePool,
  migrateTestDb,
  openCountsByAgent,
  resetDb,
  seedAgent,
} from "../../test/db";
import { luxonWeekdayToDayOfWeek } from "../domain/availability";

// A full day of availability expressed as two sub-24h windows — a single window
// is always under 24h (implementation.md §1), so we avoid a lone 0..1440 row.
function fullDay(d: number): SeedShift[] {
  return [
    { dayOfWeek: d, startMinute: 0, endMinute: 720 },
    { dayOfWeek: d, startMinute: 720, endMinute: 1440 },
  ];
}

// Shifts covering every day — an agent who is always on shift.
function allDays(): SeedShift[] {
  return [0, 1, 2, 3, 4, 5, 6].flatMap(fullDay);
}

// A full day on a day that is NOT today (UTC) — agent exists but is off now.
function offTodayShift(): SeedShift[] {
  const today = luxonWeekdayToDayOfWeek(DateTime.utc().weekday);
  return fullDay((today + 3) % 7);
}

function assign(companyId: string, ticketId: string) {
  return request(app)
    .post("/api/assignments")
    .send({ company_id: companyId, ticket_id: ticketId });
}

function close(companyId: string, ticketId: string) {
  return request(app)
    .post("/api/tickets/close")
    .send({ company_id: companyId, ticket_id: ticketId });
}

async function rowCount(where: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM assignments WHERE ${where}`,
    params
  );
  return rows[0].c;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closePool();
});
beforeEach(async () => {
  await resetDb();
});

describe("POST /api/assignments - happy path & idempotency", () => {
  it("assigns to an available agent (201)", async () => {
    const agentId = await seedAgent({
      companyId: "acme",
      name: "Ada",
      shifts: allDays(),
    });
    const res = await assign("acme", "T-1");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("assigned");
    expect(res.body.agent.id).toBe(agentId);
    expect(res.body.agent.name).toBe("Ada");
    expect(res.body.assigned_at).toBeDefined();
  });

  it("resubmit returns the same assignment (200), no new row", async () => {
    const agentId = await seedAgent({ companyId: "acme", shifts: allDays() });
    const first = await assign("acme", "T-1");
    const second = await assign("acme", "T-1");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already_assigned");
    expect(second.body.agent.id).toBe(agentId);
    expect(second.body.assigned_at).toBe(first.body.assigned_at);
    expect(await rowCount("company_id=$1 AND ticket_id=$2", ["acme", "T-1"])).toBe(1);
  });

  it("N concurrent requests for the same ticket create exactly one assignment", async () => {
    await seedAgent({ companyId: "acme", shifts: allDays() });
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => assign("acme", "T-dup"))
    );
    const created = results.filter((r) => r.status === 201);
    const dup = results.filter(
      (r) => r.status === 200 && r.body.status === "already_assigned"
    );
    expect(created.length).toBe(1);
    expect(dup.length).toBe(N - 1);
    expect(new Set(results.map((r) => r.body.agent.id)).size).toBe(1);
    expect(await rowCount("ticket_id=$1", ["T-dup"])).toBe(1);
  });
});

describe("fairness", () => {
  it("spreads N tickets within +/-1 across two identical agents", async () => {
    const a = await seedAgent({ companyId: "acme", name: "A", shifts: allDays() });
    const b = await seedAgent({ companyId: "acme", name: "B", shifts: allDays() });
    const N = 6;
    await Promise.all(
      Array.from({ length: N }, (_, i) => assign("acme", `T-${i}`))
    );
    const counts = await openCountsByAgent("acme");
    const ca = counts.get(a) ?? 0;
    const cb = counts.get(b) ?? 0;
    expect(ca + cb).toBe(N);
    expect(Math.abs(ca - cb)).toBeLessThanOrEqual(1);
  });

  it("unequal schedules: during overlap, the agent with fewer open tickets wins", async () => {
    const today = luxonWeekdayToDayOfWeek(DateTime.utc().weekday);
    // "Broad" works all week; "Narrow" works only today. Their schedules differ,
    // but both are on shift at this instant — the overlap the doc describes.
    const broad = await seedAgent({
      companyId: "acme",
      name: "Broad",
      shifts: allDays(),
    });
    const narrow = await seedAgent({
      companyId: "acme",
      name: "Narrow",
      shifts: fullDay(today),
    });

    // Give the broad agent a head start of open work.
    await pool.query(
      "INSERT INTO assignments (company_id, ticket_id, agent_id) VALUES ($1, $2, $3)",
      ["acme", "PRE-1", broad]
    );

    // Schedule breadth is irrelevant during the overlap: the ticket goes to the
    // agent carrying fewer open tickets right now.
    const res = await assign("acme", "T-1");
    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe(narrow);
  });
});

// implementation.md §6 "Unit — selection": fewest wins; tie -> least recently
// assigned, never-assigned first; final tie -> lowest id, stable across runs.
// The selector lives in SQL, so these are asserted here against real Postgres
// with sequential (deterministic) assigns rather than as pure unit tests.
describe("selection order", () => {
  it("final tie (equal open, never assigned) -> lowest id wins, deterministically", async () => {
    const id1 = await seedAgent({ companyId: "acme", name: "A", shifts: allDays() });
    const id2 = await seedAgent({ companyId: "acme", name: "B", shifts: allDays() });
    const lowest = [id1, id2].sort()[0];

    const res = await assign("acme", "T-1");
    expect(res.status).toBe(201);
    // Both agents are perfectly tied (0 open, never assigned), so the only
    // deciding factor is `a.id ASC` — the same agent every time.
    expect(res.body.agent.id).toBe(lowest);
  });

  it("orders by fewest-open, then never-assigned/least-recently, then id", async () => {
    const ids = [
      await seedAgent({ companyId: "acme", name: "A", shifts: allDays() }),
      await seedAgent({ companyId: "acme", name: "B", shifts: allDays() }),
      await seedAgent({ companyId: "acme", name: "C", shifts: allDays() }),
    ];
    const [s0, s1, s2] = [...ids].sort(); // ascending id order

    // All three tied -> lowest id.
    const r1 = await assign("acme", "T-1");
    expect(r1.body.agent.id).toBe(s0);

    // s1 & s2 still have 0 open (never assigned); tie broken by lowest id.
    const r2 = await assign("acme", "T-2");
    expect(r2.body.agent.id).toBe(s1);

    // s2 alone has 0 open -> fewest wins outright.
    const r3 = await assign("acme", "T-3");
    expect(r3.body.agent.id).toBe(s2);

    // Now all three hold 1 open. Tie -> least recently assigned = s0 (got T-1,
    // the earliest), proving the last_assigned tiebreak precedes id here.
    const r4 = await assign("acme", "T-4");
    expect(r4.body.agent.id).toBe(s0);
  });
});

describe("availability filtering", () => {
  it("returns no_one_available for an unknown company", async () => {
    const res = await assign("unknown-co", "T-1");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_one_available");
  });

  it("returns no_one_available when the only agent has no shifts", async () => {
    await seedAgent({ companyId: "acme", shifts: [] });
    const res = await assign("acme", "T-1");
    expect(res.body.status).toBe("no_one_available");
  });

  it("excludes an agent whose shift is on another day", async () => {
    await seedAgent({ companyId: "acme", shifts: offTodayShift() });
    const res = await assign("acme", "T-1");
    expect(res.body.status).toBe("no_one_available");
  });

  it("never assigns to a deactivated agent, even if on shift", async () => {
    const active = await seedAgent({
      companyId: "acme",
      name: "Active",
      shifts: allDays(),
    });
    await seedAgent({
      companyId: "acme",
      name: "Inactive",
      active: false,
      shifts: allDays(),
    });
    const res = await assign("acme", "T-1");
    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBe(active);
  });

  it("returns no_one_available when the only on-shift agent is deactivated", async () => {
    await seedAgent({ companyId: "acme", active: false, shifts: allDays() });
    const res = await assign("acme", "T-1");
    expect(res.body.status).toBe("no_one_available");
  });
});

describe("close", () => {
  it("closing frees the agent so they're preferred for the next ticket", async () => {
    await seedAgent({ companyId: "acme", name: "A", shifts: allDays() });
    await seedAgent({ companyId: "acme", name: "B", shifts: allDays() });

    const r1 = await assign("acme", "T-1");
    const first = r1.body.agent.id;
    await assign("acme", "T-2"); // -> the other agent
    await assign("acme", "T-3"); // tie -> least recently assigned = first

    let counts = await openCountsByAgent("acme");
    expect(counts.get(first)).toBe(2);

    await close("acme", "T-1");
    await close("acme", "T-3");
    counts = await openCountsByAgent("acme");
    expect(counts.get(first) ?? 0).toBe(0);

    const r4 = await assign("acme", "T-4");
    expect(r4.body.agent.id).toBe(first); // fewest open now
  });

  it("does not advance last_assigned (closing can't jump the queue)", async () => {
    await seedAgent({ companyId: "acme", name: "A", shifts: allDays() });
    const r1 = await assign("acme", "T-1");
    const agentId = r1.body.agent.id;
    const assignedAt = r1.body.assigned_at;

    await close("acme", "T-1");

    const { rows } = await pool.query<{ la: Date }>(
      "SELECT max(assigned_at) AS la FROM assignments WHERE agent_id=$1",
      [agentId]
    );
    expect(rows[0].la.toISOString()).toBe(assignedAt);
  });

  it("double close returns 200 with unchanged closed_at", async () => {
    await seedAgent({ companyId: "acme", shifts: allDays() });
    await assign("acme", "T-1");
    const c1 = await close("acme", "T-1");
    const c2 = await close("acme", "T-1");
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(c2.body.closed_at).toBe(c1.body.closed_at);
  });

  it("closing a never-assigned ticket returns 404", async () => {
    const res = await close("acme", "ghost");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ticket_not_assigned");
  });

  it("close then resubmit returns the original assignment, no new row", async () => {
    const agentId = await seedAgent({ companyId: "acme", shifts: allDays() });
    const first = await assign("acme", "T-1");
    await close("acme", "T-1");
    const again = await assign("acme", "T-1");
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("already_assigned");
    expect(again.body.agent.id).toBe(agentId);
    expect(again.body.assigned_at).toBe(first.body.assigned_at);
    expect(await rowCount("ticket_id=$1", ["T-1"])).toBe(1);
  });
});

describe("validation", () => {
  it("assignment requires company_id and ticket_id (422)", async () => {
    const res = await request(app)
      .post("/api/assignments")
      .send({ company_id: "acme" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("close requires company_id and ticket_id (422)", async () => {
    const res = await request(app)
      .post("/api/tickets/close")
      .send({ ticket_id: "T-1" });
    expect(res.status).toBe(422);
  });
});
