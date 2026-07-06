# Ticket System — Automatic Support Ticket Assignment

Assigns each incoming support ticket to an available agent on the right team,
spreading work fairly across whoever is on shift. Teams manage their agents and
weekly, timezone-aware availability through a small web UI; an API auto-assigns
a given ticket to the least-loaded on-shift agent (or reports that no one is
available).

- **Problem, users, scope, assumptions:** [`prd.md`](./prd.md)
- **Data model, API, algorithm, edge cases, test plan:** [`implementation.md`](./implementation.md)

## Stack

- **API:** Node + Express + TypeScript, PostgreSQL (raw SQL via `pg`), timezones via Luxon
- **UI:** React + Vite + TypeScript
- **Tests:** Jest + Supertest (unit + integration against real Postgres)
- **Lint:** ESLint (flat config) + typescript-eslint, with React Hooks rules on the client
- **Postgres:** runs in Docker

## Prerequisites

- **Docker** (for Postgres) — Docker Desktop running
- **Node 20+** and npm

## Quick start

Three moving parts: Postgres (Docker), the API (`server/`), and the UI (`client/`).
Run each block from the repo root.

### 1. Start Postgres

```bash
docker compose up -d
```

This starts Postgres 16 on `localhost:5432` and creates two databases:
`ticketsystem` (dev) and `ticketsystem_test` (used by the integration tests).

### 2. Start the API

```bash
cd server
npm install
npm run migrate      # create tables in the dev database
npm run dev          # http://localhost:3001
```

### 3. Start the UI

In a second terminal:

```bash
cd client
npm install
npm run dev          # http://localhost:5173
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` to the API on
`:3001`, so you only interact with one origin.

## Manual UI walkthrough

A two-minute tour that exercises the whole system:

1. Open http://localhost:5173 and enter a **company** id (e.g. `acme`), then click
   **Open**. Both the company and the active tab are stored in the URL
   (`?company=acme&view=team`), so the view is shareable and survives back/forward
   navigation. A company exists implicitly as soon as it has an agent — there is
   no separate "create company" step.
2. On the **Team** tab, under **Add agent**, enter a name, pick a timezone (e.g.
   `Asia/Kolkata`), and click **Add**.
3. Click **Edit** on the new agent. Add a few weekly shifts (day + start + end).
   If you set an end time earlier than the start, the row shows
   **"→ ends next day (+1)"** and is stored as an overnight (crosses-midnight)
   shift. Status is toggled with the **Active / Deactivated** switch. Click **Save**.
4. Each agent shows as a card with an **on shift / off shift** pill (evaluated in
   the agent's own timezone), an **inactive** badge when deactivated, its current
   **open-ticket count**, and a summary of its weekly shifts. The list refreshes
   every 30 seconds.
5. Switch to the **Assign tickets** tab. The **Available now** panel lists the
   agents on shift right now (each with a green dot and its live open-ticket
   count). Under **Post a ticket**, enter a ticket id (e.g. `T-1042`) and click
   **Assign** — the ticket is auto-assigned to the least-loaded on-shift agent,
   and you'll see who got it (or "No one is available right now"). Post a few and
   watch the counts spread.
6. The **Ticket history** panel below lists every ticket for the team, newest
   first. Click **Close** on an open ticket to resolve it; the agent's open count
   drops, freeing them for new work.
7. Back on **Team**, edit an agent and flip the switch to **Deactivated**. They
   grey out (with an "inactive" badge) and stop receiving new tickets, but
   existing assignments are kept.

## Running the tests

Integration tests run against the real `ticketsystem_test` database, so Postgres
must be up (`docker compose up -d`). From `server/`:

```bash
npm test
```

This runs the availability unit tests (pure timezone/shift logic) and the API
integration tests (assignment fairness and selection ordering, idempotency,
concurrency, close semantics, validation) via Supertest against Postgres.

## Linting

Both packages use ESLint (flat config) with typescript-eslint; the client also
enables the React Hooks rules. Run from `server/` or `client/`:

```bash
npm run lint
```

## Try the API with curl

```bash
# Create an agent
curl -s -X POST http://localhost:3001/api/companies/acme/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","timezone":"UTC"}'

# Assign a ticket
curl -s -X POST http://localhost:3001/api/assignments \
  -H 'Content-Type: application/json' \
  -d '{"company_id":"acme","ticket_id":"T-1042"}'

# Close a ticket
curl -s -X POST http://localhost:3001/api/tickets/close \
  -H 'Content-Type: application/json' \
  -d '{"company_id":"acme","ticket_id":"T-1042"}'
```

## API reference

The table below is the complete, authoritative list of HTTP endpoints. `implementation.md`
covers the data model and design rationale and describes the core assignment/closure
API in depth, but it intentionally omits some UI-support endpoints (e.g. the ticket
history read) — for the request/response contract, this table is the source of truth.

| Method & path | Purpose |
|---|---|
| `POST /api/assignments` | Auto-assign a ticket to the least-loaded on-shift agent. `201 assigned` / `200 already_assigned` / `200 no_one_available` |
| `POST /api/tickets/close` | Close a ticket (idempotent). `200 closed` / `404 ticket_not_assigned` |
| `GET /api/companies/:companyId/agents` | List agents with shifts, `active`, computed `on_shift_now`, and `open_tickets` |
| `POST /api/companies/:companyId/agents` | Create an agent (`name`, `timezone`) |
| `GET /api/companies/:companyId/tickets` | List a company's tickets (assignments) newest-first — powers the UI ticket history. Paginated: `?page=` (0-based, default 0) `&pageSize=` (1–100, default 10). Responds `{ tickets, total, page, pageSize }` |
| `PATCH /api/agents/:id` | Partial update of `name`, `timezone`, or `active` |
| `PUT /api/agents/:id` | Replace an agent's full editable config (`name`, `timezone`, `active`, and `shifts`) in one transaction — the editor's Save uses this so fields and shifts commit together or not at all |
| `PUT /api/agents/:id/shifts` | Replace only an agent's weekly shift list. `200 { agent }` |
| `GET /health` | Liveness + DB connectivity check (not under `/api`). `200 {"status":"ok"}` / `503 {"status":"db_unavailable"}` |

### Request bodies

- `POST /api/assignments`, `POST /api/tickets/close` — `{ "company_id", "ticket_id" }`.
  Both ids are required opaque strings (non-empty, max 255 chars); they are stored
  verbatim (not trimmed) so idempotency keys match exactly what the caller sent.
- `POST /api/companies/:companyId/agents` — `{ "name", "timezone" }`; returns `201 { agent }`.
- `PATCH /api/agents/:id` — any subset of `{ "name", "timezone", "active" }`
  (at least one required); returns `200 { agent }`.
- `PUT /api/agents/:id` — `{ "name", "timezone", "shifts", "active"? }`
  (`name`/`timezone`/`shifts` required, `active` optional); returns `200 { agent }`.
- `PUT /api/agents/:id/shifts` — `{ "shifts": [...] }`; returns `200 { agent }`.

### Response shapes

Single-agent responses are wrapped as `{ "agent": AgentView }`; the list endpoint
returns `{ "agents": AgentView[] }`.

```jsonc
// AgentView
{
  "id": "uuid",
  "name": "Ada",
  "timezone": "UTC",
  "active": true,
  "on_shift_now": true,      // always false when active is false
  "open_tickets": 3,         // unclosed assignments
  "shifts": [
    { "day_of_week": 0, "start_minute": 540, "end_minute": 1020, "crosses_midnight": false }
  ]
}

// Ticket record (items in GET /api/companies/:companyId/tickets → tickets[])
{
  "ticket_id": "T-1042",
  "agent_id": "uuid",
  "agent_name": "Ada",
  "assigned_at": "2026-07-06T09:00:00.000Z",
  "closed_at": null          // ISO timestamp once closed, else null
}
```

Timestamps (`assigned_at`, `closed_at`) are ISO-8601 UTC strings.

### Shift fields

`day_of_week` (0 = Mon … 6 = Sun), `start_minute` (0–1439, inclusive),
`end_minute` (1–1440, exclusive), `crosses_midnight` (bool). Without
`crosses_midnight`, `start_minute < end_minute` and the window must be under 24h;
with it, `end_minute < start_minute` (the window runs into the next day).

### Error responses

All errors share the shape `{ "error": { "code", "message" } }`:

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_json` | Request body is not valid JSON |
| `404` | `not_found` | `PATCH`/`PUT /api/agents/:id[/shifts]` on an unknown/invalid agent id |
| `404` | `ticket_not_assigned` | `POST /api/tickets/close` for a ticket that was never assigned |
| `422` | `invalid_request` | Validation failure (bad timezone, out-of-range shift minutes, missing/invalid fields, bad pagination params) |
| `500` | `internal_error` | Unexpected server error |

## Project structure

```
.
├── docker-compose.yml       # Postgres + test database
├── prd.md                   # product requirements
├── implementation.md        # technical design
├── server/                  # Express + TypeScript API
│   ├── migrations/          # SQL migrations
│   ├── docker/initdb/       # creates the test database on first boot
│   ├── src/
│   │   ├── domain/          # availability engine + validation (pure logic)
│   │   ├── db/              # SQL data-access layer
│   │   ├── services/        # assignment + agent business logic
│   │   ├── routes/          # Express routers
│   │   ├── db.ts            # pg connection pool
│   │   ├── config.ts        # env-backed config (defaults match compose)
│   │   ├── migrate.ts       # migration runner
│   │   └── index.ts         # app + server entry
│   └── test/                # test helpers (test DB setup, seeding)
└── client/                  # React + Vite UI
    └── src/
        ├── components/      # TeamPage, AgentEditor, AssignPage
        ├── lib/             # time/timezone helpers
        ├── api.ts           # typed API client
        ├── types.ts         # shared view types
        └── App.tsx          # company selection + tab layout
```

## Configuration

The defaults match `docker-compose.yml`, so no `.env` is needed for local use.
To override, copy `server/.env.example` to `server/.env`:

- `DATABASE_URL` — dev database connection string
- `TEST_DATABASE_URL` — database used by integration tests
- `PORT` — API port (default `3001`)

## Notes and simplifications

- **Availability** is modeled as recurring weekly shifts in each agent's local
  timezone, evaluated with Luxon (DST-correct). One-off overrides and holiday
  calendars are out of scope.
- **Fairness** is load-balancing on open ticket count (fewest open tickets →
  least recently assigned → lowest id), not per-hour quotas. See `prd.md`.
- **Concurrency:** assignment serializes per company with a Postgres advisory
  lock; `assigned_at` uses `clock_timestamp()` so the tie-break ordering is stable.
- Availability is computed in Node (clear and unit-testable); at scale it would
  move into SQL.
- The shift editor uses a native time picker (1-minute granularity) in the UI;
  the API accepts any minute.
- No auth, roles, or rate limiting — per the trial scope, whoever uses the UI is
  assumed authorized.

## What I'd build next

- **Manual reassignment** — let a lead move a ticket off an agent (e.g. when
  someone goes offline mid-shift); the most-requested follow-up.
- **Age open tickets out of the fairness count** after N days, so a forgotten
  unclosed ticket doesn't permanently skew an agent's load.
- **Auth and roles** — real authentication and per-company authorization.
- **One-off overrides and holidays** — time off and exceptions on top of the
  recurring schedule.
- **Move availability filtering into SQL** and add indexing/pagination for
  larger teams.
- **Observability** — metrics on assignment latency, per-agent distribution, and
  `no_one_available` rates.
