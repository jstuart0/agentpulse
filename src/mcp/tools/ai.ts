/**
 * AI control-plane read tools (AGEN-12 Phase 3, D2): get_session_intelligence,
 * get_digest, get_ai_status (observe); get_inbox (manage-only, C1: action_*
 * items can embed launch env/claimToken payloads).
 *
 * AI-gate errors (404 ai_disabled / 409 ai_disabled / 409 ai_paused) need no
 * special handling here — a thrown ApiError from the client propagates
 * through registerReadTool's wrapHandler straight into errors.ts's
 * pair-keyed mapper, which already distinguishes all three (Correction #1).
 */
import { z } from "zod";
import { capList } from "../output.js";
import { registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

export function registerAiTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (flags.hasObserve) {
		registerReadTool(
			ctx,
			{
				name: "get_session_intelligence",
				description:
					"AI health classification for a session (healthy/blocked/stuck/risky/complete_candidate) with a reason code and evidence. Requires the AI feature to be enabled on this AgentPulse instance.",
				inputSchema: { session_id: z.string() },
			},
			async (args, client) => client.getSessionIntelligence(args.session_id),
		);

		registerReadTool(
			ctx,
			{
				name: "get_digest",
				description:
					"Cross-session daily digest grouped by project/cwd: active/blocked/stuck counts, completions, notable failures.",
				inputSchema: {},
			},
			async (_args, client) => client.getDigest(),
		);

		registerReadTool(
			ctx,
			{
				name: "get_ai_status",
				description:
					"AI feature flags: build/runtime enabled, kill switch, classifier settings. Diagnostics (queue snapshot) are opt-in via include_diagnostics — fetching them emits a metric side-effect on the server, so routine polling should leave it off.",
				inputSchema: { include_diagnostics: z.boolean().optional() },
			},
			async (args, client) => {
				const status = await client.getAiStatus();
				if (!args.include_diagnostics) return status;
				const diagnostics = await client.getAiDiagnostics();
				return { ...status, diagnostics };
			},
		);
	}

	if (flags.hasManage) {
		registerReadTool(
			ctx,
			{
				name: "get_inbox",
				description:
					"Operator inbox: open HITL requests, stuck/risky sessions, failed proposals, and pending action requests. Manage-scoped: action_* items can embed launch env/claimToken payloads.",
				inputSchema: {
					kinds: z.array(z.enum(["hitl", "stuck", "risky", "failed_proposal"])).optional(),
					session_id: z.string().optional(),
					severity: z.enum(["high", "normal"]).optional(),
					limit: z.number().int().min(1).max(500).optional(),
				},
			},
			async (args, client) => {
				const inbox = await client.getInbox({
					kinds: args.kinds,
					sessionId: args.session_id,
					severity: args.severity,
					limit: args.limit,
				});
				const capped = capList(inbox.items);
				return {
					items: capped.items,
					total: inbox.total,
					byKind: inbox.byKind,
					...(capped.hint ? { truncated: capped.hint } : {}),
				};
			},
		);
	}
}
