import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../api";
import type { AgentView, TicketView } from "../types";
import { shortZone } from "../lib/time";
import { usePolling } from "../lib/usePolling";

type LastResult =
  | { kind: "assigned" | "already_assigned"; agentName: string }
  | { kind: "no_one_available" };

const TICKETS_PER_PAGE = 10;

/**
 * Ticket-posting page. Assignment is automatic (the server picks the
 * least-loaded on-shift agent); this page shows the available agents with their
 * live open-ticket counts, plus the full ticket history for the team so any
 * ticket can be closed.
 */
export function AssignPage({ companyId }: { companyId: string }) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ticketId, setTicketId] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentsRes, ticketsRes] = await Promise.all([
        api.listAgents(companyId),
        api.listTickets(companyId),
      ]);
      setAgents(agentsRes.agents);
      setTickets(ticketsRes.tickets);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep counts, availability, and the history roughly live.
  usePolling(() => void load(), 30000);

  const available = agents.filter((a) => a.on_shift_now);

  // Client-side pagination for the ticket history. Clamp the current page so a
  // shrinking list (e.g. after a background refresh) never leaves us stranded
  // on an empty page.
  const pageCount = Math.max(1, Math.ceil(tickets.length / TICKETS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedTickets = tickets.slice(
    currentPage * TICKETS_PER_PAGE,
    currentPage * TICKETS_PER_PAGE + TICKETS_PER_PAGE
  );

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    const id = ticketId.trim();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.assign(companyId, id);
      setLastResult(
        res.status === "no_one_available"
          ? { kind: "no_one_available" }
          : { kind: res.status, agentName: res.agent.name }
      );
      setTicketId("");
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function closeTicket(id: string) {
    setError(null);
    try {
      await api.close(companyId, id);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <section className="panel">
        <h2>
          Available now{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            ({companyId}) {loading ? "· loading…" : null}
          </span>
        </h2>
        <p className="hint">
          On-shift agents and their current open-ticket load. Assignment is
          automatic — post a ticket below and it goes to the least-loaded agent.
        </p>
        {available.length === 0 && !loading ? (
          <p className="hint">No agents are on shift right now.</p>
        ) : (
          <div className="agent-cards">
            {available.map((a) => (
              <div key={a.id} className="agent-card">
                <div className="agent-card-head">
                  <span className="dot on" title="On shift now" />
                  <span className="agent-card-name">{a.name}</span>
                </div>
                <div className="agent-card-open">
                  <span className="open-num">{a.open_tickets}</span>
                  <span className="open-label">
                    open ticket{a.open_tickets === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="meta">
                  <span className="tz" title={a.timezone}>
                    {shortZone(a.timezone)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Post a ticket</h2>
        <form className="row" onSubmit={assign}>
          <input
            aria-label="Ticket id"
            placeholder="Ticket id (e.g. T-1042)"
            value={ticketId}
            onChange={(e) => setTicketId(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Assigning…" : "Assign"}
          </button>
        </form>
        {lastResult && (
          <div className="result">
            {lastResult.kind === "no_one_available" ? (
              <span>No one is available right now.</span>
            ) : (
              <span>
                {lastResult.kind === "already_assigned"
                  ? "Already assigned to "
                  : "Assigned to "}
                <strong>{lastResult.agentName}</strong>
              </span>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>
          Ticket history{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            {tickets.length > 0 ? `· ${tickets.length}` : null}
          </span>
        </h2>
        {tickets.length === 0 ? (
          <p className="hint">No tickets posted yet.</p>
        ) : (
          <>
            <table className="tickets">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Agent</th>
                  <th>Assigned</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pagedTickets.map((t) => {
                  const open = t.closed_at === null;
                  return (
                    <tr key={t.ticket_id}>
                      <td>{t.ticket_id}</td>
                      <td>{t.agent_name}</td>
                      <td>{new Date(t.assigned_at).toLocaleString()}</td>
                      <td>
                        {open ? (
                          <span className="badge-open">open</span>
                        ) : (
                          <span className="muted">closed</span>
                        )}
                      </td>
                      <td>
                        {open && (
                          <button
                            className="secondary"
                            onClick={() => closeTicket(t.ticket_id)}
                            type="button"
                          >
                            Close
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pageCount > 1 && (
              <div className="pagination">
                <button
                  className="secondary"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                  type="button"
                >
                  Previous
                </button>
                <span className="muted">
                  Page {currentPage + 1} of {pageCount}
                </span>
                <button
                  className="secondary"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage(currentPage + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
