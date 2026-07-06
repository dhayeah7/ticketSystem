import { Pool, PoolClient } from "pg";
import { pool } from "../db";
import { Agent, AgentWithShifts } from "../domain/types";
import { Shift } from "../domain/availability";

type Queryable = Pool | PoolClient;

interface AgentShiftRow {
  id: string;
  company_id: string;
  name: string;
  timezone: string;
  active: boolean;
  day_of_week: number | null;
  start_minute: number | null;
  end_minute: number | null;
  crosses_midnight: boolean | null;
}

interface AgentRow {
  id: string;
  company_id: string;
  name: string;
  timezone: string;
  active: boolean;
}

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    timezone: row.timezone,
    active: row.active,
  };
}

async function queryAgentsWithShifts(
  db: Queryable,
  companyId: string,
  activeOnly: boolean
): Promise<AgentWithShifts[]> {
  const { rows } = await db.query<AgentShiftRow>(
    `SELECT a.id, a.company_id, a.name, a.timezone, a.active,
            s.day_of_week, s.start_minute, s.end_minute, s.crosses_midnight
       FROM agents a
       LEFT JOIN shifts s ON s.agent_id = a.id
      WHERE a.company_id = $1 ${activeOnly ? "AND a.active = true" : ""}
      ORDER BY a.id`,
    [companyId]
  );

  const byId = new Map<string, AgentWithShifts>();
  for (const r of rows) {
    let agent = byId.get(r.id);
    if (!agent) {
      agent = { ...mapAgent(r), shifts: [] };
      byId.set(r.id, agent);
    }
    if (r.day_of_week !== null) {
      agent.shifts.push({
        dayOfWeek: r.day_of_week,
        startMinute: r.start_minute as number,
        endMinute: r.end_minute as number,
        crossesMidnight: r.crosses_midnight as boolean,
      });
    }
  }
  return [...byId.values()];
}

/** Active agents with shifts — the pool for assignment. */
export function getActiveAgentsWithShifts(
  db: Queryable,
  companyId: string
): Promise<AgentWithShifts[]> {
  return queryAgentsWithShifts(db, companyId, true);
}

/** All agents (active + inactive) with shifts — for the management UI. */
export function getAgentsWithShifts(
  db: Queryable,
  companyId: string
): Promise<AgentWithShifts[]> {
  return queryAgentsWithShifts(db, companyId, false);
}

/** Open (unclosed) assignment counts per agent for a company. */
export async function getOpenTicketCounts(
  db: Queryable,
  companyId: string
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ agent_id: string; open_count: number }>(
    `SELECT agent_id, count(*)::int AS open_count
       FROM assignments
      WHERE company_id = $1 AND closed_at IS NULL
      GROUP BY agent_id`,
    [companyId]
  );
  return new Map(rows.map((r) => [r.agent_id, r.open_count]));
}

export async function getAgentById(
  db: Queryable,
  id: string
): Promise<Agent | null> {
  const { rows } = await db.query<AgentRow>(
    "SELECT id, company_id, name, timezone, active FROM agents WHERE id = $1",
    [id]
  );
  return rows.length ? mapAgent(rows[0]) : null;
}

export async function getShiftsByAgentId(
  db: Queryable,
  id: string
): Promise<Shift[]> {
  const { rows } = await db.query<{
    day_of_week: number;
    start_minute: number;
    end_minute: number;
    crosses_midnight: boolean;
  }>(
    `SELECT day_of_week, start_minute, end_minute, crosses_midnight
       FROM shifts WHERE agent_id = $1`,
    [id]
  );
  return rows.map((r) => ({
    dayOfWeek: r.day_of_week,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
    crossesMidnight: r.crosses_midnight,
  }));
}

export async function insertAgent(
  db: Queryable,
  companyId: string,
  name: string,
  timezone: string
): Promise<Agent> {
  const { rows } = await db.query<AgentRow>(
    `INSERT INTO agents (company_id, name, timezone)
     VALUES ($1, $2, $3)
     RETURNING id, company_id, name, timezone, active`,
    [companyId, name, timezone]
  );
  return mapAgent(rows[0]);
}

export interface AgentPatch {
  name?: string;
  timezone?: string;
  active?: boolean;
}

export async function updateAgentRow(
  db: Queryable,
  id: string,
  patch: AgentPatch
): Promise<Agent | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(patch.name);
  }
  if (patch.timezone !== undefined) {
    sets.push(`timezone = $${i++}`);
    params.push(patch.timezone);
  }
  if (patch.active !== undefined) {
    sets.push(`active = $${i++}`);
    params.push(patch.active);
  }
  if (sets.length === 0) {
    return getAgentById(db, id);
  }
  params.push(id);
  const { rows } = await db.query<AgentRow>(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $${i}
     RETURNING id, company_id, name, timezone, active`,
    params
  );
  return rows.length ? mapAgent(rows[0]) : null;
}

/**
 * Replace an agent's entire shift list atomically (delete-all + insert-all in
 * one transaction). Returns the agent, or null if it doesn't exist.
 */
export async function replaceShifts(
  id: string,
  shifts: Shift[]
): Promise<Agent | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const agent = await getAgentById(client, id);
    if (!agent) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("DELETE FROM shifts WHERE agent_id = $1", [id]);
    for (const s of shifts) {
      await client.query(
        `INSERT INTO shifts (agent_id, day_of_week, start_minute, end_minute, crosses_midnight)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, s.dayOfWeek, s.startMinute, s.endMinute, s.crossesMidnight]
      );
    }
    await client.query("COMMIT");
    return agent;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
