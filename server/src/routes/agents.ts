import { NextFunction, Response, Router } from "express";
import {
  createAgent,
  listAgents,
  replaceAgentShifts,
  updateAgent,
} from "../services/agents";
import { NotFoundError, ValidationError } from "../errors";

export const agentsRouter = Router();

// Map domain errors to HTTP; anything else bubbles to the central handler.
function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ValidationError) {
    res.status(422).json({ error: { code: "invalid_request", message: err.message } });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: { code: "not_found", message: err.message } });
    return;
  }
  next(err);
}

// GET /api/companies/:companyId/agents — all agents with shifts + on_shift_now.
agentsRouter.get("/companies/:companyId/agents", async (req, res, next) => {
  try {
    const agents = await listAgents(req.params.companyId);
    res.json({ agents });
  } catch (err) {
    handleError(err, res, next);
  }
});

// POST /api/companies/:companyId/agents — create an agent.
agentsRouter.post("/companies/:companyId/agents", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agent = await createAgent(req.params.companyId, body.name, body.timezone);
    res.status(201).json({ agent });
  } catch (err) {
    handleError(err, res, next);
  }
});

// PATCH /api/agents/:id — update name, timezone, or active.
agentsRouter.patch("/agents/:id", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agent = await updateAgent(req.params.id, body);
    res.json({ agent });
  } catch (err) {
    handleError(err, res, next);
  }
});

// PUT /api/agents/:id/shifts — replace the weekly shift list atomically.
agentsRouter.put("/agents/:id/shifts", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agent = await replaceAgentShifts(req.params.id, body.shifts);
    res.json({ agent });
  } catch (err) {
    handleError(err, res, next);
  }
});
