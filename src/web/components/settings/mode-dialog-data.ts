import type { SupervisorRecord } from "../../../shared/types.js";
import { type AdminUserRow, type ApiKeyRow, type InstanceCounts, api } from "../../lib/api.js";

export const REVIEWED_KEYS_STORAGE_KEY = "agentpulse.team.reviewedKeys";
/** The Team section's heading: where focus returns when the control that opened a dialog is gone. */
export const TEAM_HEADING_ID = "settings-team-heading";
export const DISMISSED_CHECKLIST_STORAGE_KEY = "agentpulse.team.dismissedChecklist";

/** Everything the mode dialog and the checklist behind it work from, fetched together. */
export interface Loaded {
	users: AdminUserRow[];
	keys: ApiKeyRow[];
	counts: InstanceCounts;
	hosts: SupervisorRecord[];
}

export async function loadEverything(): Promise<Loaded> {
	const [users, keys, counts, hosts] = await Promise.all([
		api.getUsers(),
		api.getApiKeys(),
		api.getInstance(),
		api.getSupervisors(),
	]);
	return { users: users.users, keys: keys.keys, counts: counts.counts, hosts: hosts.supervisors };
}
