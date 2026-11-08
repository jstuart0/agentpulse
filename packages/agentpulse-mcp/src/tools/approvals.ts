/**
 * Managed Codex approval tools (AGEN-87, D15): list_pending_approvals (read) and
 * decline_approval (mutating), both `manage`.
 *
 * There is deliberately no accept. Accepting runs a command or writes files on a
 * person's machine, and the server only takes it from a signed-in person who has seen
 * the exact text and its hash; an API key is refused (`human_required`). A tool that
 * could only ever fail would invite a caller to look for a way around it.
 */
import { z } from "zod";
import { ApiError } from "../client.js";
import { ToolInputError } from "../errors.js";
import { registerMutatingTool, registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

const CONFIRMATION_PORTABILITY_NOTE =
	"This is a state-changing action. The requires-confirmation hint is honored only by MCP hosts that implement it (e.g. Claude Code's UI); other clients (scripted, or hosts without the gate) will execute it without prompting.";

/** The one message for a server that predates managed-session approvals (Codex, and a continued Claude Code session). */
export const APPROVALS_UNSUPPORTED_MESSAGE =
	"This AgentPulse server doesn't support approvals for managed sessions. Upgrade the server to read or decline them.";

/**
 * A server without the routes answers a bare 404 (no `error` code). One with them always
 * answers a coded body, an unknown session or approval included, so a coded 404 is not this.
 */
async function withApprovalsSupport<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) {
			const body = err.body;
			const coded =
				body !== null &&
				typeof body === "object" &&
				typeof (body as { error?: unknown }).error === "string";
			if (!coded) throw new ToolInputError(APPROVALS_UNSUPPORTED_MESSAGE);
		}
		throw err;
	}
}

export function registerApprovalTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasManage) return;

	registerReadTool(
		ctx,
		{
			name: "list_pending_approvals",
			description:
				"List the approvals a managed session (Codex, or a Claude Code session continued in AgentPulse) is waiting on: commands, file changes and, for Claude, web fetches, reads outside its directory calls to MCP tools and starting a helper (a subagent; a request a helper itself made has `preview.fromSubagent: true`, and a helper type that does not ship with Claude Code is not approvable) (open ones only: pending, or answered and waiting for the host). Each carries a short preview (the command's start and last lines, the file paths, the URL or path, or for an MCP tool, tool 'mcp' with target as server/tool: the input and what the tool does are for the person in the dashboard, and AgentPulse can't tell what an MCP tool does), the presentationHash, whether it is approvable, how long it has left, and the host's state. Previews are cut to 4 KiB; the full text is in the dashboard. This tool can read and decline but never accept: accepting is for a signed-in person in the dashboard, who sees the whole command first.",
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => {
			const list = await withApprovalsSupport(() => client.listApprovals(args.session_id));
			return {
				approvals: list.approvals.filter((a) => a.state !== "closed"),
				host: list.host,
			};
		},
	);

	registerMutatingTool(
		ctx,
		{
			name: "decline_approval",
			description: `Decline one pending approval so the command is not run, the files are not written and nothing is fetched or read. Declining is always safe for the machine; the agent is told it was refused and may try something else. It needs the host to be connected (an offline or removed host refuses the call: the request expires on its own and is declined then). Single-item only. There is no accept tool: only a signed-in person can accept, in the dashboard. ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: { session_id: z.string(), approval_id: z.string() },
		},
		async (args, client) => {
			const answered = await withApprovalsSupport(() =>
				client.declineApproval(args.session_id, args.approval_id),
			);
			return { approval: answered.approval };
		},
	);
}
