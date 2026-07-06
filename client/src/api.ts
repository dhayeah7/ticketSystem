import type {
  AgentView,
  AssignmentResult,
  CloseResult,
  ShiftView,
  TicketView,
} from "./types";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.message ?? `request failed (${res.status})`;
    throw new ApiError(res.status, message, body?.error?.code);
  }
  return body as T;
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export const api = {
  listAgents(companyId: string) {
    return req<{ agents: AgentView[] }>(
      `/companies/${encodeURIComponent(companyId)}/agents`
    );
  },
  listTickets(companyId: string) {
    return req<{ tickets: TicketView[] }>(
      `/companies/${encodeURIComponent(companyId)}/tickets`
    );
  },
  createAgent(companyId: string, name: string, timezone: string) {
    return req<{ agent: AgentView }>(
      `/companies/${encodeURIComponent(companyId)}/agents`,
      { method: "POST", body: JSON.stringify({ name, timezone }) }
    );
  },
  updateAgent(
    id: string,
    patch: { name?: string; timezone?: string; active?: boolean }
  ) {
    return req<{ agent: AgentView }>(`/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
  replaceShifts(id: string, shifts: ShiftView[]) {
    return req<{ agent: AgentView }>(`/agents/${id}/shifts`, {
      method: "PUT",
      body: JSON.stringify({ shifts }),
    });
  },
  assign(companyId: string, ticketId: string) {
    return req<AssignmentResult>(`/assignments`, {
      method: "POST",
      body: JSON.stringify({ company_id: companyId, ticket_id: ticketId }),
    });
  },
  close(companyId: string, ticketId: string) {
    return req<CloseResult>(`/tickets/close`, {
      method: "POST",
      body: JSON.stringify({ company_id: companyId, ticket_id: ticketId }),
    });
  },
};
