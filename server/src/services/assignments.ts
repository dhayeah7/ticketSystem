import { pool } from "../db";
import { getActiveAgentsWithShifts } from "../db/agents";
import { isAvailableAt } from "../domain/availability";

export interface AssignedAgent {
  id: string;
  name: string;
  timezone: string;
}

export type AssignmentResult =
  | { status: "assigned" | "already_assigned"; agent: AssignedAgent; assignedAt: string }
  | { status: "no_one_available" };

export type CloseResult =
  | { status: "closed"; closedAt: string }
  | { status: "ticket_not_assigned" };

/**
 * Assign a ticket to exactly one available agent, or report no_one_available.
 * Availability is judged as of requestReceivedAt (see prd.md/implementation.md).
 */
export async function assignTicket(
  companyId: string,
  ticketId: string,
  requestReceivedAt: Date
): Promise<AssignmentResult> {
  const client = await pool.connect();
  try {
    // Availability is computed before the lock, so the lock spans only the
    // select/insert. The result depends only on requestReceivedAt.
    const agents = await getActiveAgentsWithShifts(client, companyId);
    const availableIds = agents
      .filter((a) => isAvailableAt(requestReceivedAt, a.timezone, a.shifts))
      .map((a) => a.id);

    await client.query("BEGIN");

    // Serialize per company; other companies proceed in parallel.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [companyId]);

    const existing = await findAssignment(client, companyId, ticketId);
    if (existing) {
      await client.query("COMMIT");
      return { status: "already_assigned", agent: existing.agent, assignedAt: existing.assignedAt };
    }

    if (availableIds.length === 0) {
      await client.query("COMMIT");
      return { status: "no_one_available" };
    }

    // fewest open tickets -> least recently assigned (never-assigned first) -> id.
    // last_assigned spans all assignments incl. closed.
    const selected = await client.query<AssignedAgent>(
      `SELECT a.id, a.name, a.timezone
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE s.closed_at IS NULL) AS open_count,
                  max(s.assigned_at) AS last_assigned
             FROM assignments s
            WHERE s.agent_id = a.id
         ) t ON true
        WHERE a.id = ANY($1::uuid[])
        ORDER BY t.open_count ASC, t.last_assigned ASC NULLS FIRST, a.id ASC
        LIMIT 1`,
      [availableIds]
    );
    const agent = selected.rows[0];

    // 5. Insert, stamping assigned_at with clock_timestamp() (true wall-clock at
    //    write time, not transaction-start).
    const inserted = await client.query<{ assigned_at: Date }>(
      `INSERT INTO assignments (company_id, ticket_id, agent_id, assigned_at)
       VALUES ($1, $2, $3, clock_timestamp())
       ON CONFLICT (company_id, ticket_id) DO NOTHING
       RETURNING assigned_at`,
      [companyId, ticketId, agent.id]
    );

    if (inserted.rows.length === 0) {
      // Lost an insert race (shouldn't happen under the lock) — return the winner.
      const winner = await findAssignment(client, companyId, ticketId);
      await client.query("COMMIT");
      return { status: "already_assigned", agent: winner!.agent, assignedAt: winner!.assignedAt };
    }

    await client.query("COMMIT");
    return {
      status: "assigned",
      agent,
      assignedAt: inserted.rows[0].assigned_at.toISOString(),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function findAssignment(
  client: import("pg").PoolClient,
  companyId: string,
  ticketId: string
): Promise<{ agent: AssignedAgent; assignedAt: string } | null> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    timezone: string;
    assigned_at: Date;
  }>(
    `SELECT a.id, a.name, a.timezone, ass.assigned_at
       FROM assignments ass
       JOIN agents a ON a.id = ass.agent_id
      WHERE ass.company_id = $1 AND ass.ticket_id = $2`,
    [companyId, ticketId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    agent: { id: r.id, name: r.name, timezone: r.timezone },
    assignedAt: r.assigned_at.toISOString(),
  };
}

/**
 * Close a ticket. Idempotent: the conditional UPDATE only fires while the
 * ticket is open, so a second close leaves the original closed_at untouched.

 */
export async function closeTicket(
  companyId: string,
  ticketId: string
): Promise<CloseResult> {
  const updated = await pool.query<{ closed_at: Date }>(
    `UPDATE assignments
        SET closed_at = clock_timestamp()
      WHERE company_id = $1 AND ticket_id = $2 AND closed_at IS NULL
      RETURNING closed_at`,
    [companyId, ticketId]
  );
  if (updated.rows.length > 0) {
    return { status: "closed", closedAt: updated.rows[0].closed_at.toISOString() };
  }

  // Not updated: either already closed (return original) or never assigned (404).
  const existing = await pool.query<{ closed_at: Date | null }>(
    `SELECT closed_at FROM assignments WHERE company_id = $1 AND ticket_id = $2`,
    [companyId, ticketId]
  );
  if (existing.rows.length === 0) {
    return { status: "ticket_not_assigned" };
  }
  return {
    status: "closed",
    closedAt: (existing.rows[0].closed_at as Date).toISOString(),
  };
}

export interface TicketRecord {
  ticket_id: string;
  agent_id: string;
  agent_name: string;
  assigned_at: string;
  closed_at: string | null;
}

export interface TicketPage {
  tickets: TicketRecord[];
  total: number;
}

/**
 * One page of a company's tickets (assignments), newest first — powers the UI
 * history. `total` is the full unpaged count so the client can render page
 * controls. Ordered by assigned_at DESC with `id` as a stable tiebreaker so
 * rows don't shift between pages when timestamps collide.
 */
export async function listCompanyTickets(
  companyId: string,
  page: { limit: number; offset: number }
): Promise<TicketPage> {
  const totalRes = await pool.query<{ count: string }>(
    `SELECT count(*)::bigint AS count FROM assignments WHERE company_id = $1`,
    [companyId]
  );
  const total = Number(totalRes.rows[0].count);

  const { rows } = await pool.query<{
    ticket_id: string;
    agent_id: string;
    agent_name: string;
    assigned_at: Date;
    closed_at: Date | null;
  }>(
    `SELECT ass.ticket_id, ass.agent_id, a.name AS agent_name,
            ass.assigned_at, ass.closed_at
       FROM assignments ass
       JOIN agents a ON a.id = ass.agent_id
      WHERE ass.company_id = $1
      ORDER BY ass.assigned_at DESC, ass.id DESC
      LIMIT $2 OFFSET $3`,
    [companyId, page.limit, page.offset]
  );
  const tickets = rows.map((r) => ({
    ticket_id: r.ticket_id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    assigned_at: r.assigned_at.toISOString(),
    closed_at: r.closed_at ? r.closed_at.toISOString() : null,
  }));
  return { tickets, total };
}
