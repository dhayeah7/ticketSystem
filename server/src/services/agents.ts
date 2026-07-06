import { pool } from "../db";
import {
  AgentPatch,
  getAgentsWithShifts,
  getOpenTicketCounts,
  getShiftsByAgentId,
  insertAgent,
  replaceShifts,
  updateAgentRow,
} from "../db/agents";
import { Shift, isAvailableAt } from "../domain/availability";
import { Agent } from "../domain/types";
import { NotFoundError, ValidationError } from "../errors";
import {
  isUuid,
  parseShifts,
  validateCompanyId,
  validateName,
  validateTimezone,
} from "../domain/validation";

interface ShiftView {
  day_of_week: number;
  start_minute: number;
  end_minute: number;
  crosses_midnight: boolean;
}

export interface AgentView {
  id: string;
  name: string;
  timezone: string;
  active: boolean;
  on_shift_now: boolean;
  open_tickets: number;
  shifts: ShiftView[];
}

function toShiftView(s: Shift): ShiftView {
  return {
    day_of_week: s.dayOfWeek,
    start_minute: s.startMinute,
    end_minute: s.endMinute,
    crosses_midnight: s.crossesMidnight,
  };
}

/** Present an agent for the API, computing on_shift_now (always false if inactive). */
function toAgentView(
  agent: Agent,
  shifts: Shift[],
  openTickets: number
): AgentView {
  return {
    id: agent.id,
    name: agent.name,
    timezone: agent.timezone,
    active: agent.active,
    on_shift_now: agent.active && isAvailableAt(new Date(), agent.timezone, shifts),
    open_tickets: openTickets,
    shifts: shifts.map(toShiftView),
  };
}

export async function listAgents(companyId: string): Promise<AgentView[]> {
  const agents = await getAgentsWithShifts(pool, companyId);
  const openCounts = await getOpenTicketCounts(pool, companyId);
  return agents.map((a) => toAgentView(a, a.shifts, openCounts.get(a.id) ?? 0));
}

export async function createAgent(
  companyId: string,
  nameRaw: unknown,
  timezoneRaw: unknown
): Promise<AgentView> {
  const company = validateCompanyId(companyId);
  const name = validateName(nameRaw);
  const timezone = validateTimezone(timezoneRaw);
  const agent = await insertAgent(pool, company, name, timezone);
  return toAgentView(agent, [], 0);
}

export async function updateAgent(
  id: string,
  body: Record<string, unknown>
): Promise<AgentView> {
  if (!isUuid(id)) {
    throw new NotFoundError("agent not found");
  }

  const patch: AgentPatch = {};
  if (body.name !== undefined) patch.name = validateName(body.name);
  if (body.timezone !== undefined) patch.timezone = validateTimezone(body.timezone);
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      throw new ValidationError("active must be a boolean");
    }
    patch.active = body.active;
  }
  if (
    patch.name === undefined &&
    patch.timezone === undefined &&
    patch.active === undefined
  ) {
    throw new ValidationError("provide at least one of name, timezone, active");
  }

  const agent = await updateAgentRow(pool, id, patch);
  if (!agent) {
    throw new NotFoundError("agent not found");
  }
  const shifts = await getShiftsByAgentId(pool, id);
  const openCounts = await getOpenTicketCounts(pool, agent.companyId);
  return toAgentView(agent, shifts, openCounts.get(id) ?? 0);
}

export async function replaceAgentShifts(
  id: string,
  shiftsRaw: unknown
): Promise<AgentView> {
  if (!isUuid(id)) {
    throw new NotFoundError("agent not found");
  }
  const shifts = parseShifts(shiftsRaw);
  const agent = await replaceShifts(id, shifts);
  if (!agent) {
    throw new NotFoundError("agent not found");
  }
  const openCounts = await getOpenTicketCounts(pool, agent.companyId);
  return toAgentView(agent, shifts, openCounts.get(id) ?? 0);
}
