# PRD: Automatic Support Ticket Assignment

## Problem

Support teams distribute incoming tickets manually. A team lead watches the queue and assigns each ticket to whoever they know is on shift. This breaks as teams grow:

- Tickets arriving while the lead is offline sit unassigned for hours.
- The lead becomes a full-time dispatcher instead of doing their own work.
- Distribution is uneven: some agents get buried while others sit idle.

The root cause is that assignment depends on one person's real-time knowledge of who is working. That knowledge should live in the system.

## Target user

Two personas at each customer company:

1. **Team lead / ops manager** — sets up the team's availability once, keeps it current as schedules change, and stops triaging. Uses the UI.
2. **The customer's ticketing system** — calls our API when a new ticket arrives and receives the agent to assign. Ticket closure is also handled here.

## What we're building

1. **Availability management UI.** A team lead defines each agent, the agent's timezone, and the agent's recurring weekly shifts (e.g., Mon–Fri 09:00–17:00 in `Asia/Kolkata`). Agents can be added, edited, and deactivated.
2. **Assignment API.** `POST` with a `company_id` and `ticket_id` returns the agent who should take the ticket, or an explicit "no one is available" response.

## How assignment works

When a ticket arrives:

1. Find all **active agents** on the company's team whose shift windows cover the current moment, evaluated in each agent's own timezone.
2. Among them, pick the agent with the **fewest open tickets**.
3. Break ties by **least recently assigned**, then by agent ID (deterministic).
4. If no agent is available, say so explicitly; the caller decides what to do with the unassigned ticket.

## What "available" means

An agent is available if the current moment falls inside one of their recurring weekly shift windows, in their local timezone.

Availability is checked against the time we receive the assignment request — not re-evaluated afterward, so if an agent's shift ends five minutes after they receive a ticket, the ticket stays with them. Retries return the original assignment rather than re-evaluating, and delayed or backfilled tickets go to whoever is on shift when the request arrives.

## What "fair" means

- **Fairness is equal expected tickets per available hour, not per agent.** An agent scheduled for 40 hours a week receives proportionally more tickets than one scheduled for 10.
- New tickets go to whoever has the fewest open tickets right now.
- **Overlapping shifts dilute per-agent rate by design.** When two regions' shifts overlap, the pool is larger and each agent receives fewer tickets per hour.

## Scope

**In scope**
- Agent and weekly shift management UI
- Assignment API
- Timezone-correct availability, including overnight shifts
- Idempotent, concurrency-safe assignment

**Out of scope**
- Login, roles, billing, account management
- Holiday calendars, one-off overrides, mobile
- History and open tickets preservation when agents are deactivated
- Third-party integrations (PagerDuty, Opsgenie, etc.)
- Reassignment of tickets when an agent is deactivated mid-shift or goes offline — their open tickets remain assigned.
- Ticket content, priority, or routing by skill — we assign a person, nothing more

## Assumptions

- `company_id` and `ticket_id` are opaque identifiers supplied by the caller; we do not manage the lifecycle of companies or tickets. Agents and their shifts are the only entities our system creates and manages.
- All tickets weigh the same. The system has no signal about ticket difficulty.
- One agent per ticket; no team assignments or reassignment.
- Multiple tickets can be assigned to a single agent while they are on shift.

## Success criteria

- Every assignment request, at any hour, returns in one API call either an assigned agent or a first-class "no one available" response — never a hang, a silent failure, or a wait for a human.
- Over a steady stream of tickets, agents with identical shifts receive ticket counts within ±1 of each other.
- The same ticket submitted twice never produces two assignments.