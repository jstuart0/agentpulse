/**
 * Update status (AGEN-155): get_update_status (observe). A read of whether a newer AgentPulse exists, from
 * GET /capabilities `.update`. There is deliberately no tool that starts, schedules or enables an update:
 * the server has no route for it (an update is the machine's own updater's act), and an agent's own config
 * can hold a manage key, so a tool here would let an agent swap code.
 */
import { registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

export function registerUpdateTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasObserve) return;
	registerReadTool(
		ctx,
		{
			name: "get_update_status",
			description:
				'Whether a newer AgentPulse release exists for this server: the running version, the latest verified release, a state (available, security, current, ...), whether the release feed looks stale, and when it was last checked. Read-only; it never starts an update. An older server without the update check answers state "unknown".',
			inputSchema: {},
		},
		async (_args, client) => client.getUpdateStatus(),
	);
}
