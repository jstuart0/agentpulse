/**
 * Session-control tools (AGEN-12 Phase 4, D2's mutating-tool table):
 * prompt_session/stop_session/retry_launch (managed-sessions-only, L2),
 * update_session (per-field fan-out with partial-failure reporting, L4).
 *
 * Split from orchestrate.ts (dexter M, mid-build review) — orchestrate.ts
 * keeps launch-creation/advisory (recommend_launch/preview_template/
 * launch_agent) + list_hosts; this file is the session-control domain,
 * restoring one-domain-per-file locality before Phase 5 grows the surface
 * further.
 */
import { z } from "zod";
import { ApiError } from "../client.js";
import { registerMutatingTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

/** Per-field error text for update_session's partial-failure report — richer than a bare Error.message for an ApiError (which stringifies to just "AgentPulse API error: <status>"). */
function describeFieldError(err: unknown): string {
	if (err instanceof ApiError) {
		const bodyText = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
		return `AgentPulse returned ${err.status}: ${bodyText}`;
	}
	return err instanceof Error ? err.message : String(err);
}

const MANAGED_ONLY_NOTE =
	'Managed sessions only — AgentPulse rejects this for sessions it isn\'t managing the process for ("Session is not managed.").';

/**
 * xander H1/e (mid-build security review): every mutating tool ships this
 * caveat in its own description — the honest baseline mitigation for
 * confirmation-portability. rUI (_meta["anthropic/requiresUserInteraction"])
 * is a Claude-Code-specific extension; nothing at the MCP protocol or SDK
 * layer enforces it (live-verified in the Phase 4 report: a scripted
 * StdioClientTransport client calling stop_session executed immediately,
 * with no confirmation gate — the rejection it hit was ordinary server-side
 * business logic, not a confirmation boundary).
 */
const CONFIRMATION_PORTABILITY_NOTE =
	"This is a state-changing action. The requires-confirmation hint is honored only by MCP hosts that implement it (e.g. Claude Code's UI); other clients (scripted, or hosts without the gate) will execute it without prompting.";

export function registerSessionActionTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasManage) return;

	registerMutatingTool(
		ctx,
		{
			name: "prompt_session",
			description: `Inject a prompt into a LIVE agent session, as if typed into its terminal. ${MANAGED_ONLY_NOTE} ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: { session_id: z.string(), prompt: z.string() },
		},
		async (args, client) => client.promptSession(args.session_id, args.prompt),
	);

	registerMutatingTool(
		ctx,
		{
			name: "stop_session",
			description: `Stop a live agent session's process. ${MANAGED_ONLY_NOTE} ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => client.stopSession(args.session_id),
	);

	registerMutatingTool(
		ctx,
		{
			name: "retry_launch",
			description: `Re-launch a session's original launch request as a new one (same template/spec, fresh correlation id). ${MANAGED_ONLY_NOTE} ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => client.retryLaunch(args.session_id),
	);

	registerMutatingTool(
		ctx,
		{
			name: "update_session",
			description: `Update one or more session fields (notes, display name, pinned, archived) in a single call. Each provided field is applied independently — a failure on one field doesn't block the others. The result reports which fields applied and which failed; call fails (isError) only if every requested field failed. ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: {
				session_id: z.string(),
				notes: z.string().optional(),
				display_name: z.string().optional(),
				pinned: z.boolean().optional(),
				archived: z.boolean().optional(),
			},
		},
		async (args, client) => {
			const applied: string[] = [];
			const failed: Array<{ field: string; error: string }> = [];

			async function attempt(field: string, fn: () => Promise<unknown>) {
				try {
					await fn();
					applied.push(field);
				} catch (err) {
					failed.push({ field, error: describeFieldError(err) });
				}
			}

			if (args.notes !== undefined) {
				await attempt("notes", () =>
					client.updateSessionNotes(args.session_id, args.notes as string),
				);
			}
			if (args.display_name !== undefined) {
				await attempt("display_name", () =>
					client.renameSession(args.session_id, args.display_name as string, "user"),
				);
			}
			if (args.pinned !== undefined) {
				await attempt("pinned", () => client.pinSession(args.session_id, args.pinned as boolean));
			}
			if (args.archived !== undefined) {
				await attempt("archived", () =>
					client.archiveSession(args.session_id, args.archived as boolean),
				);
			}

			// L4: isError only when every requested field failed. Zero fields
			// requested is a legal no-op (empty applied/failed), not an error.
			if (failed.length > 0 && applied.length === 0) {
				throw new Error(
					`update_session: all ${failed.length} requested field(s) failed: ${failed
						.map((f) => `${f.field} (${f.error})`)
						.join("; ")}`,
				);
			}

			return { applied, failed };
		},
	);
}
