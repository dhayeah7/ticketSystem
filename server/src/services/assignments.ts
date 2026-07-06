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
 *
 * Correctness hinges on two timestamps for two different jobs:
 *  - request_received_at is captured HERE, before the lock wait, so a request
 *    that queues on the advisory lock is still judged for availability as of
 *    the moment we received it (not after it finally runs).
 *  - assigned_at is stamped with clock_timestamp() inside the locked section
 *    (see the INSERT) so timestamps reflect true serialized order and can't
 *    invert the last_assigned tie-break.
 */
export async function assignTicket(
  companyId: string,
  ticketId: string
): Promise<AssignmentResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 0. Capture request_received_at via clock_timestamp() (true wall-clock, not
    //    transaction-start time) BEFORE the lock wait, so a request received at
    //    16:59:58 is judged for availability as of receipt, not re-judged after
    //    17:00 just because it queued on the advisory lock.
    const { rows: receiptRows } = await client.query<{ received_at: Date }>(
      "SELECT clock_timestamp() AS received_at"
    );
    const requestReceivedAt = receiptRows[0].received_at;

    // 1. Serialize per company: concurrent requests for the same company run
    //    one at a time; other companies proceed in parallel. Transaction-scoped,
    //    so it releases on commit/rollback even if the request crashes.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [companyId]);

    // 2. Idempotency: an existing assignment is returned verbatim, never re-evaluated.
    const existing = await findAssignment(client, companyId, ticketId);
    if (existing) {
      await client.query("COMMIT");
      return { status: "already_assigned", agent: existing.agent, assignedAt: existing.assignedAt };
    }

    // 3. Availability: filter active agents by their shift windows as of receipt.
    const agents = await getActiveAgentsWithShifts(client, companyId);
    const availableIds = agents
      .filter((a) => isAvailableAt(requestReceivedAt, a.timezone, a.shifts))
      .map((a) => a.id);

    if (availableIds.length === 0) {
      await client.query("COMMIT"); // no assignment stored; retry may re-evaluate
      return { status: "no_one_available" };
    }

    // 4. Select one: fewest open tickets -> least recently assigned
    //    (never-assigned first) -> lowest id. open_count is live load (open only);
    //    last_assigned spans all assignments incl. closed, so closing never
    //    jumps an agent forward in the rotation.
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
    //    write time, not transaction-start). The ON CONFLICT is a backstop for
    //    the UNIQUE(company_id, ticket_id) guarantee.
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
 * Unknown ticket -> ticket_not_assigned (a caller error, surfaced as 404).
 * The close is a single conditional UPDATE; a follow-up SELECT runs only when
 * nothing was updated, to distinguish "already closed" (return the original
 * closed_at) from "never assigned" (404). Deliberately does not serialize
 * against assignment (no advisory lock).
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

/** All tickets (assignments) for a company, newest first — powers the UI history. */
export async function listCompanyTickets(
  companyId: string
): Promise<TicketRecord[]> {
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
      ORDER BY ass.assigned_at DESC`,
    [companyId]
  );
  return rows.map((r) => ({
    ticket_id: r.ticket_id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    assigned_at: r.assigned_at.toISOString(),
    closed_at: r.closed_at ? r.closed_at.toISOString() : null,
  }));
}
