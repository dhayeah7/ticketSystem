import request from "supertest";
import { app } from "../index";
import { closePool, migrateTestDb, resetDb } from "../../test/db";

const NONEXISTENT_UUID = "00000000-0000-0000-0000-000000000000";

function createAgent(companyId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/companies/${companyId}/agents`).send(body);
}
function listAgents(companyId: string) {
  return request(app).get(`/api/companies/${companyId}/agents`);
}
function patchAgent(id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/agents/${id}`).send(body);
}
function putShifts(id: string, shifts: unknown) {
  return request(app).put(`/api/agents/${id}/shifts`).send({ shifts });
}

// Shift windows (snake_case, as the API accepts them). A full day is expressed
// as two sub-24h windows [00:00,12:00) + [12:00,24:00) — a single window is
// always under 24h (implementation.md §1), so we never send a lone 0..1440 row.
function allDays() {
  return [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [
    { day_of_week: d, start_minute: 0, end_minute: 720, crosses_midnight: false },
    { day_of_week: d, start_minute: 720, end_minute: 1440, crosses_midnight: false },
  ]);
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

describe("POST /api/companies/:companyId/agents", () => {
  it("creates an agent (201) with no shifts and on_shift_now false", async () => {
    const res = await createAgent("acme", { name: "Ada", timezone: "Asia/Kolkata" });
    expect(res.status).toBe(201);
    expect(res.body.agent.id).toBeDefined();
    expect(res.body.agent.name).toBe("Ada");
    expect(res.body.agent.timezone).toBe("Asia/Kolkata");
    expect(res.body.agent.active).toBe(true);
    expect(res.body.agent.on_shift_now).toBe(false);
    expect(res.body.agent.shifts).toEqual([]);
  });

  it("rejects an invalid timezone (422)", async () => {
    const res = await createAgent("acme", { name: "Ada", timezone: "Mars/Phobos" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("rejects a missing name (422)", async () => {
    const res = await createAgent("acme", { timezone: "UTC" });
    expect(res.status).toBe(422);
  });
});

describe("GET /api/companies/:companyId/agents", () => {
  it("lists agents including inactive ones", async () => {
    const a = await createAgent("acme", { name: "Active", timezone: "UTC" });
    const b = await createAgent("acme", { name: "Gone", timezone: "UTC" });
    await patchAgent(b.body.agent.id, { active: false });

    const res = await listAgents("acme");
    expect(res.status).toBe(200);
    const names = res.body.agents.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(["Active", "Gone"]);
    const inactive = res.body.agents.find((x: { id: string }) => x.id === b.body.agent.id);
    expect(inactive.active).toBe(false);
    expect(a.body.agent.id).toBeDefined();
  });

  it("returns an empty list for an unknown company", async () => {
    const res = await listAgents("nobody");
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
  });
});

describe("PATCH /api/agents/:id", () => {
  it("updates the name", async () => {
    const created = await createAgent("acme", { name: "Old", timezone: "UTC" });
    const res = await patchAgent(created.body.agent.id, { name: "New" });
    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe("New");
  });

  it("deactivating forces on_shift_now false even with a covering shift", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const id = created.body.agent.id;
    await putShifts(id, allDays());

    const on = await listAgents("acme");
    expect(on.body.agents[0].on_shift_now).toBe(true);

    await patchAgent(id, { active: false });
    const off = await listAgents("acme");
    expect(off.body.agents[0].active).toBe(false);
    expect(off.body.agents[0].on_shift_now).toBe(false);
  });

  it("rejects an invalid timezone (422)", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const res = await patchAgent(created.body.agent.id, { timezone: "Nowhere/Land" });
    expect(res.status).toBe(422);
  });

  it("rejects an empty patch (422)", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const res = await patchAgent(created.body.agent.id, {});
    expect(res.status).toBe(422);
  });

  it("returns 404 for a nonexistent agent", async () => {
    const res = await patchAgent(NONEXISTENT_UUID, { name: "Ghost" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("returns 404 for a non-uuid id", async () => {
    const res = await patchAgent("not-a-uuid", { name: "Ghost" });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/agents/:id/shifts", () => {
  it("replaces the shift list atomically", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const id = created.body.agent.id;

    const first = await putShifts(id, [
      { day_of_week: 0, start_minute: 540, end_minute: 1020, crosses_midnight: false },
    ]);
    expect(first.status).toBe(200);
    expect(first.body.agent.shifts).toHaveLength(1);

    // A second PUT fully replaces the previous list.
    const second = await putShifts(id, [
      { day_of_week: 2, start_minute: 60, end_minute: 120, crosses_midnight: false },
      { day_of_week: 3, start_minute: 60, end_minute: 120, crosses_midnight: false },
    ]);
    expect(second.body.agent.shifts).toHaveLength(2);

    const listed = await listAgents("acme");
    const days = listed.body.agents[0].shifts
      .map((s: { day_of_week: number }) => s.day_of_week)
      .sort();
    expect(days).toEqual([2, 3]);
  });

  it("accepts a valid overnight shift", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const res = await putShifts(created.body.agent.id, [
      { day_of_week: 4, start_minute: 1320, end_minute: 360, crosses_midnight: true },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.agent.shifts[0].crosses_midnight).toBe(true);
  });

  it("rejects out-of-range minutes (422)", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const res = await putShifts(created.body.agent.id, [
      { day_of_week: 0, start_minute: 0, end_minute: 1500, crosses_midnight: false },
    ]);
    expect(res.status).toBe(422);
  });

  it("rejects start >= end without crosses_midnight (422)", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const res = await putShifts(created.body.agent.id, [
      { day_of_week: 0, start_minute: 1020, end_minute: 540, crosses_midnight: false },
    ]);
    expect(res.status).toBe(422);
  });

  it("rejects end >= start with crosses_midnight (422)", async () => {
    const created = await createAgent("acme", { name: "Ada", timezone: "UTC" });
    const res = await putShifts(created.body.agent.id, [
      { day_of_week: 0, start_minute: 540, end_minute: 1020, crosses_midnight: true },
    ]);
    expect(res.status).toBe(422);
  });

  it("returns 404 for a nonexistent agent", async () => {
    const res = await putShifts(NONEXISTENT_UUID, allDays());
    expect(res.status).toBe(404);
  });
});
