import { Router, Response } from "express";
import {
  assignTicket,
  closeTicket,
  listCompanyTickets,
} from "../services/assignments";
import { validateCompanyId, validateTicketId, parsePagination } from "../domain/validation";
import { ValidationError } from "../errors";

export const assignmentsRouter = Router();

function readCompanyTicket(body: unknown): {
  companyId: string;
  ticketId: string;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    companyId: validateCompanyId(b.company_id),
    ticketId: validateTicketId(b.ticket_id),
  };
}

// Map a ValidationError to a 422; returns true if it handled the error.
function sendValidationError(res: Response, err: unknown): boolean {
  if (err instanceof ValidationError) {
    res
      .status(422)
      .json({ error: { code: "invalid_request", message: err.message } });
    return true;
  }
  return false;
}

// POST /api/assignments — assign a ticket to an available agent.
assignmentsRouter.post("/assignments", async (req, res, next) => {
  // Capture receipt time at handler entry, before any awaited I/O (body is
  // already parsed; validation and pool.connect() come after). Availability is
  // judged as of this instant so a request that later queues on the pool or the
  // advisory lock is still evaluated against when it actually arrived — not when
  // it happens to reach the DB. See assignTicket for why this is a Node clock.
  const receivedAt = new Date();
  try {
    const input = readCompanyTicket(req.body);

    const result = await assignTicket(
      input.companyId,
      input.ticketId,
      receivedAt
    );
    if (result.status === "no_one_available") {
      return res.status(200).json({ status: "no_one_available" });
    }
    return res.status(result.status === "assigned" ? 201 : 200).json({
      status: result.status,
      agent: result.agent,
      assigned_at: result.assignedAt,
    });
  } catch (err) {
    if (sendValidationError(res, err)) return;
    next(err);
  }
});

// POST /api/tickets/close — mark a ticket closed (idempotent).
assignmentsRouter.post("/tickets/close", async (req, res, next) => {
  try {
    const input = readCompanyTicket(req.body);

    const result = await closeTicket(input.companyId, input.ticketId);
    if (result.status === "ticket_not_assigned") {
      return res.status(404).json({
        error: {
          code: "ticket_not_assigned",
          message: "no assignment exists for this ticket",
        },
      });
    }
    return res.status(200).json({ status: "closed", closed_at: result.closedAt });
  } catch (err) {
    if (sendValidationError(res, err)) return;
    next(err);
  }
});

// GET /api/companies/:companyId/tickets — one page of a team's tickets (newest
// first). Optional query: page (0-based, default 0), pageSize (1..100, default
// 10). Responds { tickets, total, page, pageSize }.
assignmentsRouter.get(
  "/companies/:companyId/tickets",
  async (req, res, next) => {
    try {
      const { page, pageSize, limit, offset } = parsePagination(
        req.query as Record<string, unknown>
      );
      const { tickets, total } = await listCompanyTickets(
        req.params.companyId,
        { limit, offset }
      );
      res.json({ tickets, total, page, pageSize });
    } catch (err) {
      if (sendValidationError(res, err)) return;
      next(err);
    }
  }
);
