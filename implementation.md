# Technical Design: Automatic Support Ticket Assignment

**Stack:** Node + Express · React + Vite · PostgreSQL · Timezones via Luxon (IANA). Tests with Jest + Supertest.

Covers the data model, API, UI flow, edge cases, and test plan.

---

## 1. Data model

### `agents`

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | generated |
| `company_id` | `text` | indexed |
| `name` | `text` | |
| `timezone` | `text` | IANA name, validated on write |
| `active` | `boolean` | default `true`; deactivation is a soft delete — history preserved, agent stops receiving new tickets |
| `created_at` | `timestamptz` | |

### `shifts`

Recurring weekly windows in the agent's **local** time.

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | |
| `agent_id` | `uuid` FK → agents, `ON DELETE CASCADE` | |
| `day_of_week` | `smallint` (0 = Mon … 6 = Sun) | day the shift **starts**, agent-local |
| `start_minute` | `smallint` (0–1439) | minutes from local midnight, inclusive |
| `end_minute` | `smallint` (1–1440) | exclusive |
| `crosses_midnight` | `boolean` | if true, window runs to `end_minute` on the **next** day (Fri 22:00 → Sat 06:00 is one row) |

`day_of_week` (0 = Mon) matches neither Luxon (1–7) nor JS `Date` (0 = Sun); conversion lives in one unit-tested function.

**Validation** (`422` on violation): without `crosses_midnight`, `start < end`; with it, strictly `end < start` (`end = start` would encode an exact 24h shift — a single window is always under 24h; longer shifts are multiple rows). Overlapping rows per agent are allowed; availability is boolean, so overlaps never double-assign.

### `assignments`

One row per assigned ticket — who holds what and its open/closed state; open rows are the input to the fairness metric.

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | |
| `company_id` | `text` | |
| `ticket_id` | `text` | |
| `agent_id` | `uuid` FK → agents | |
| `assigned_at` | `timestamptz` | |
| `closed_at` | `timestamptz` nullable | `NULL` = open; set by the close endpoint. An assignment row is the ticket's lifecycle: assigned → closed |

**`UNIQUE (company_id, ticket_id)`** is the idempotency guarantee.

---

## 2. API

JSON in/out. Validation failures: `422` with `{ "error": { "code", "message" } }`.

### Assignment

```
POST /api/assignments
{ "company_id": "acme", "ticket_id": "T-1042" }
```

Resolves in one call to exactly one of:

| status | body | meaning |
|---|---|---|
| `201` | `{ "status": "assigned", "agent": { "id", "name", "timezone" }, "assigned_at" }` | newly assigned |
| `200` | same shape, `"status": "already_assigned"` | retry — original assignment returned, never re-evaluated |
| `200` | `{ "status": "no_one_available" }` | first-class outcome; nothing stored |

Companies are inferred from agents rather than explicitly stored, so an unknown company is simply treated as having no available agents.

### Closure

```
POST /api/tickets/close
{ "company_id": "acme", "ticket_id": "T-1042" }
```

Sets `closed_at = now()` on the matching assignment (`company_id` is required — ticket IDs are only unique per company). **Idempotent**: closing an already-closed ticket returns `200` with the original `closed_at`, unchanged — retries are safe and never shift the timestamp. Unknown `(company_id, ticket_id)` → `404` (`ticket_not_assigned`): closing a ticket we never assigned is a caller error worth surfacing, not a silent no-op. Tickets cannot be reopened in trial scope.

| status | body | meaning |
|---|---|---|
| `200` | `{ "status": "closed", "closed_at" }` | closed now, or already closed (same shape, original timestamp) |
| `404` | `{ "error": { "code": "ticket_not_assigned" } }` | no assignment exists for this ticket |

### Availability management (backs the UI)

- `GET  /api/companies/:companyId/agents` — agents with shifts, `active`, and computed `on_shift_now` (false when inactive)
- `POST /api/companies/:companyId/agents` — `{ name, timezone }`
- `PATCH /api/agents/:id` — update `name`, `timezone`, or `active` (deactivate/reactivate)
- `PUT  /api/agents/:id/shifts` — replace the weekly shift list atomically (the UI edits whole schedules, so whole-list replace beats per-shift CRUD)

---

## 3. Assignment algorithm

On `POST /api/assignments`, in one transaction:

1. **Serialize per company** — `pg_advisory_xact_lock(hashtext(company_id))`; concurrent requests per company run one at a time (the fairness race), other companies in parallel. The lock is transaction-scoped — released automatically at commit or rollback, so a crashed request never leaks it. (`hashtext` collisions only over-serialize — harmless.)
2. **Idempotency check** — if `(company_id, ticket_id)` exists, return it.
3. **Find available agents** — for each **active** agent, convert the request time to their zone with Luxon and test it against their shift windows (agent-local day); none available → `no_one_available`.
4. **Select one**: fewest open tickets → least recently assigned (never-assigned first) → lowest ID. One query:

   ```sql
   SELECT a.id
   FROM agents a
   LEFT JOIN LATERAL (
     SELECT count(*) FILTER (WHERE s.closed_at IS NULL) AS open_count,
            max(s.assigned_at) AS last_assigned
     FROM assignments s WHERE s.agent_id = a.id
   ) t ON true
   WHERE a.id = ANY($available_ids)
   ORDER BY t.open_count ASC, t.last_assigned ASC NULLS FIRST, a.id ASC
   LIMIT 1;
   ```

   `open_count` counts only unclosed assignments — closing a ticket immediately frees the agent for new ones, so the metric is live load, not lifetime volume. `last_assigned` deliberately spans **all** assignments, closed included: the tie-breaker is about recency of receiving work, and closing a ticket shouldn't jump an agent to the front of the queue.

5. **Insert and return** — write the assignment row. On backstop conflict, return the existing row.

**What this selector guarantees.** Fairness here is **load-balancing, not per-hour quotas**: each ticket goes to the available agent carrying the least open work right now. Agents with identical schedules and closure rates stay within ±1 of each other. Agents scheduled for more hours receive more total tickets by being available more often — but during overlapping windows the selector deliberately favors whoever is least loaded, regardless of scheduled hours.
---

## 4. UI flow

Single-page React app.

1. **Company selection** — `company_id` field, reflected in the URL.
2. **Team page** — agents with name, timezone, schedule summary, active status, and a live **"on shift now"** indicator using the same availability logic as the API (the UI doubles as a check on the core behavior). Inactive agents are greyed out, not hidden.
3. **Agent editor** — name, IANA timezone dropdown, deactivate/reactivate toggle, and a weekly shift editor (day + start + end, add/remove). End before start displays "→ next day" and stores `crosses_midnight`. Save replaces the list via `PUT`.

---

## 5. Edge cases

| case | behavior |
|---|---|
| Overnight shift (Fri 22:00–Sat 06:00) | one `crosses_midnight` row; matches Friday evening and early Saturday |
| Shift boundaries | start inclusive, end exclusive — at exactly 17:00 a 09:00–17:00 agent is off; back-to-back shifts never double-match |
| DST | evaluated via Luxon against the instant's local mapping; a window inside a skipped hour never matches that day, a repeated hour matches twice |
| Timezone edit | shifts are stored local, so a zone change **reinterprets** every window (Mon 09:00–17:00 stays 09:00–17:00 in the new zone) — intended: a relocating agent keeps their local hours; the UI says so |
| Deactivated agent | excluded from the pool immediately; open tickets stay assigned; reactivation restores eligibility with history intact (no fairness reset) |
| Duplicate / concurrent submits of a ticket | unique constraint + advisory lock → exactly one row, original returned every time |
| Duplicate close calls | idempotent — second close returns `200` with the original `closed_at`, unchanged |
| Close of a never-assigned ticket | `404 ticket_not_assigned` — a caller integration error surfaced |
| Close, then resubmit the same ticket | idempotency wins: the original assignment is returned; closing never re-opens a ticket for reassignment |
| Concurrent tickets, same company | serialized per company — no stale-count picks |
| No agent on shift, no shifts, or unknown `company_id` | `no_one_available`, nothing stored; retry re-evaluates |

Invalid writes (unknown timezone, out-of-range minutes, `crosses_midnight` inconsistencies either direction) → `422`; bad data never reaches assignment.

---

## 6. Test plan

**Unit — availability**: inside/outside a window; inclusive/exclusive boundaries; overnight shift from both the start day and next morning; agent zone ≠ server zone (UTC server, `Asia/Kolkata` agent at 09:15 local); DST spring-forward and fall-back; no shifts → never available; the `day_of_week` conversion for all seven Luxon weekdays.

**Unit — selection:** fewest wins; tie → least recently assigned, never-assigned first; final tie → lowest ID, stable across runs.

**Integration — real Postgres** (rolled-back transactions):
- happy path → `201` with the expected agent
- resubmit → `200`, identical agent, row count stays 1
- N parallel same-ticket requests → exactly one row
- N parallel tickets across two identical-shift agents → counts within ±1
- unequal schedules: during the overlap, tickets go to whichever agent has fewer open tickets at that moment — asserts the load-balancing behavior.
- deactivated on-shift agent never assigned; falls to next active agent or `no_one_available`
- deactivation leaves existing rows untouched; reactivation restores prior count
- close a ticket → that agent's open count drops and they become preferred for the next assignment
- double-close → `200`, `closed_at` unchanged; close of a never-assigned ticket → `404`
- close then resubmit the same ticket → original assignment returned, no new row
- closing tickets does not advance `last_assigned` — an agent can't jump the tie-break queue by closing
- `no_one_available` for uncovered times and unknown `company_id`
- validation errors: unknown timezone, out-of-range minutes, missing fields, both `crosses_midnight` inconsistencies

**UI:** smoke test — add agent, add overnight shift, check indicator, deactivate and check it turns off; manual walkthrough in the README.

---

## 7. Simplifications

- **Availability computed in Node, not SQL** — correct by construction with Luxon and unit-testable; at scale, move to Postgres.
- **Closure depends on the caller.** Open counts are only as accurate as the ticketing system's discipline in calling the close endpoint; a missed close permanently inflates an agent's load.
- **Whole-list shift replacement** — matches the UI, avoids partial-update states.
- No auth, roles, pagination, or rate limiting, per trial scope.