export interface ShiftView {
  day_of_week: number; // 0 = Mon .. 6 = Sun
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

export type AssignmentResult =
  | { status: "assigned" | "already_assigned"; agent: { id: string; name: string; timezone: string }; assigned_at: string }
  | { status: "no_one_available" };

export interface CloseResult {
  status: "closed";
  closed_at: string;
}

export interface TicketView {
  ticket_id: string;
  agent_id: string;
  agent_name: string;
  assigned_at: string;
  closed_at: string | null;
}

export interface TicketPage {
  tickets: TicketView[];
  total: number;
  page: number;
  pageSize: number;
}
