import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../api";
import type { AgentView } from "../types";
import { describeShift, getTimeZones, guessZone, shortZone } from "../lib/time";
import { usePolling } from "../lib/usePolling";
import { AgentEditor } from "./AgentEditor";

const TIME_ZONES = getTimeZones();

export function TeamPage({ companyId }: { companyId: string }) {
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentView | null>(null);

  const [newName, setNewName] = useState("");
  const [newTz, setNewTz] = useState(guessZone());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listAgents(companyId);
      setAgents(res.agents);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh periodically so the "on shift now" indicator stays roughly live.
  // `load` is useCallback-stable, so pass it directly (see usePolling's
  // contract) — an inline wrapper would reset the interval every render.
  usePolling(load, 30000);

  async function addAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setError(null);
    try {
      await api.createAgent(companyId, newName.trim(), newTz);
      setNewName("");
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <section className="panel">
        <h2>Add agent</h2>
        <form className="row" onSubmit={addAgent}>
          <input
            aria-label="Agent name"
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select
            aria-label="Timezone"
            value={newTz}
            onChange={(e) => setNewTz(e.target.value)}
          >
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <button type="submit">Add</button>
        </form>
      </section>

      <section className="panel">
        <h2>
          Team{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            ({companyId}) {loading ? "· loading…" : null}
          </span>
        </h2>

        {agents.length === 0 && !loading ? (
          <p className="hint">No agents yet. Add one above.</p>
        ) : (
          <div className="agent-cards">
            {agents.map((a) => (
              <div
                key={a.id}
                className={`agent-card ${a.active ? "" : "inactive"}`}
              >
                <div className="agent-card-head">
                  <span className="agent-card-name">{a.name}</span>
                  {!a.active && (
                    <span className="badge inactive">inactive</span>
                  )}
                  <span
                    className={`status-pill ${a.on_shift_now ? "on" : "off"}`}
                  >
                    {a.on_shift_now ? "on shift" : "off shift"}
                  </span>
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

                <div className="schedule">
                  {a.shifts.length === 0 ? (
                    <span className="muted">No shifts set</span>
                  ) : (
                    a.shifts
                      .slice()
                      .sort(
                        (x, y) =>
                          x.day_of_week - y.day_of_week ||
                          x.start_minute - y.start_minute
                      )
                      .map((s, i) => <div key={i}>{describeShift(s)}</div>)
                  )}
                </div>

                <button
                  className="secondary agent-card-edit"
                  onClick={() => setEditing(a)}
                  type="button"
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <AgentEditor
          agent={editing}
          timeZones={TIME_ZONES}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
