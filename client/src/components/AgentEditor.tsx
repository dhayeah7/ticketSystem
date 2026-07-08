import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import type { AgentView, ShiftView } from "../types";
import { DAY_NAMES, parseTimeInput, toTimeInputValue } from "../lib/time";

interface ShiftDraft {
  day: number;
  start: number;
  end: number;
}

function toDraft(s: ShiftView): ShiftDraft {
  return { day: s.day_of_week, start: s.start_minute, end: s.end_minute };
}

// end < start means the window runs into the next day; end === start is invalid
// (a single window is always under 24h).
function crossesMidnight(d: ShiftDraft): boolean {
  return d.end < d.start;
}
// Returns a human message when the window is invalid, or null when it's fine.
// Mirrors the server rule: a single window can't be zero-length or >= 24h
// (a full day is expressed as two shifts).
function draftError(d: ShiftDraft): string | null {
  if (d.end === d.start) return "start and end can't be equal";
  if (!crossesMidnight(d) && d.end - d.start >= 1440) {
    return "a shift must be under 24h — split a full day into two shifts";
  }
  return null;
}
function isValidDraft(d: ShiftDraft): boolean {
  return draftError(d) === null;
}

export function AgentEditor({
  agent,
  timeZones,
  onClose,
  onSaved,
}: {
  agent: AgentView;
  timeZones: string[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [timezone, setTimezone] = useState(agent.timezone);
  const [active, setActive] = useState(agent.active);
  const [shifts, setShifts] = useState<ShiftDraft[]>(agent.shifts.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  // Keep the latest onClose in a ref so the mount-only effect below never needs
  // it as a dependency (TeamPage passes a new inline onClose each render, which
  // would otherwise re-run the effect and call showModal() on an already-open
  // dialog — an InvalidStateError).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Open as a true modal: showModal() provides dialog semantics, a focus trap,
  // an inert background, focus restoration on close, and native Escape-to-close.
  // Every close path (Escape, backdrop, Cancel) funnels through the dialog's
  // `close` event so React state stays in sync.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const handleClose = () => onCloseRef.current();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, []);

  function requestClose() {
    dialogRef.current?.close();
  }

  // Native <dialog> doesn't close on backdrop click, so replicate it: a click
  // whose coordinates fall outside the content box is a backdrop click. Using
  // the bounding rect (rather than `e.target === dialog`) keeps this correct
  // regardless of how the dialog is centered, and ignores clicks that start on
  // in-modal controls like the day/time selects.
  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    if (!inside) requestClose();
  }

  const allValid = shifts.every(isValidDraft) && name.trim() !== "";

  function updateShift(index: number, patch: Partial<ShiftDraft>) {
    setShifts((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...patch } : s))
    );
  }
  function addShift() {
    setShifts((prev) => [...prev, { day: 0, start: 540, end: 1020 }]);
  }
  function removeShift(index: number) {
    setShifts((prev) => prev.filter((_, i) => i !== index));
  }

  async function save() {
    if (!allValid) return;
    setSaving(true);
    setError(null);
    try {
      // One transactional write: fields and the full shift list commit together
      // server-side, so a failure can't leave a partial save behind.
      await api.saveAgent(agent.id, {
        name: name.trim(),
        timezone,
        active,
        shifts: shifts.map((d) => ({
          day_of_week: d.day,
          start_minute: d.start,
          end_minute: d.end,
          crosses_midnight: crossesMidnight(d),
        })),
      });
      await onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="modal-dialog" onClick={onDialogClick}>
      <div className="modal">
        <h2>Edit agent</h2>
        {error && <div className="error">{error}</div>}

        <div className="field">
          <label htmlFor="ed-name">Name</label>
          <input
            id="ed-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="ed-tz">Timezone</label>
          <select
            id="ed-tz"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {timeZones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ed-active">Status</label>
          <div className="toggle-field">
            <label className="switch">
              <input
                id="ed-active"
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </label>
            <span className={active ? "toggle-state on" : "toggle-state off"}>
              {active ? "Active" : "Deactivated"}
            </span>
            <span className="muted toggle-help">
              {active
                ? "Receiving new tickets"
                : "Receives no new tickets"}
            </span>
          </div>
        </div>

        <div className="field">
          <label>Weekly shifts (agent-local time)</label>
          {shifts.length === 0 && (
            <span className="muted">No shifts. Add one below.</span>
          )}
          {shifts.map((s, i) => {
            const crosses = crossesMidnight(s);
            const err = draftError(s);
            return (
              <div key={i}>
                <div className="shift-row">
                  <select
                    aria-label="Day"
                    value={s.day}
                    onChange={(e) =>
                      updateShift(i, { day: Number(e.target.value) })
                    }
                  >
                    {DAY_NAMES.map((d, idx) => (
                      <option key={d} value={idx}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    step={60}
                    aria-label="Start"
                    value={toTimeInputValue(s.start)}
                    onChange={(e) => {
                      const min = parseTimeInput(e.target.value);
                      if (min !== null) updateShift(i, { start: min });
                    }}
                  />
                  <span
                    className={crosses ? "shift-arrow crosses" : "shift-arrow"}
                    aria-hidden="true"
                    title={crosses ? "Ends the next day" : undefined}
                  >
                    →
                  </span>
                  <input
                    type="time"
                    step={60}
                    aria-label="End"
                    value={toTimeInputValue(s.end)}
                    onChange={(e) => {
                      const min = parseTimeInput(e.target.value);
                      // A time field can't show 24:00, so an end of 00:00 means
                      // end-of-day (1440) — the inverse of toTimeInputValue.
                      if (min !== null) {
                        updateShift(i, { end: min === 0 ? 1440 : min });
                      }
                    }}
                  />
                  <button
                    className="danger"
                    onClick={() => removeShift(i)}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
                {crosses && !err && (
                  <div className="next-day">
                    <span className="next-day-pill">→ ends next day (+1)</span>
                  </div>
                )}
                {err && (
                  <div className="shift-invalid">
                    {err}
                  </div>
                )}
              </div>
            );
          })}
          <button className="secondary" onClick={addShift} type="button">
            + Add shift
          </button>
        </div>

        <div className="modal-actions">
          <button className="secondary" onClick={requestClose} type="button">
            Cancel
          </button>
          <button onClick={save} disabled={!allValid || saving} type="button">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
