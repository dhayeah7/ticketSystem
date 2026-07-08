import { Shift } from "./availability";

/** An agent record (camelCase domain form of the `agents` row). */
export interface Agent {
  id: string;
  companyId: string;
  name: string;
  timezone: string;
  active: boolean;
}

/** An agent together with their weekly shift windows. */
export interface AgentWithShifts extends Agent {
  shifts: Shift[];
}
