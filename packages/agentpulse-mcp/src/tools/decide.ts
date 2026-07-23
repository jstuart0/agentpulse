/**
 * Operator-decision tools (AGEN-12 Phase 4, D2's mutating-tool table):
 * decide_hitl, decide_action_request. Both single-item only — no
 * batch/array field in either schema (D2 deliberately excludes
 * POST /ai/inbox/batch-decline; a `hitl_ids: string[]` field here would be
 * silent scope-creep back into that excluded territory).
 */
import { z } from "zod";
import { ACTION_REQUEST_DECISION_ENUM, HITL_REPLY_KIND_ENUM } from "../enums.js";
import { registerMutatingTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

/**
 * xander H1/e (mid-build security review): every mutating tool ships the
 * confirmation-portability caveat (see orchestrate.ts/session-actions.ts/
 * templates.ts for the identical constant). decide_hitl/decide_action_request
 * additionally get a HITL-bypass warning: deciding via this tool short-circuits
 * the human-review step the operator inbox exists to provide — an
 * automated caller approving here is not the same guarantee as a human
 * clicking approve in the dashboard.
 */
const CONFIRMATION_PORTABILITY_NOTE =
	"This is a state-changing action. The requires-confirmation hint is honored only by MCP hosts that implement it (e.g. Claude Code's UI); other clients (scripted, or hosts without the gate) will execute it without prompting.";
const HITL_BYPASS_NOTE =
	"Deciding via this tool bypasses the human-in-the-loop review the inbox exists to provide: an automated caller approving here is NOT a human approval. Only wire this to a trusted, supervised automation.";

export function registerDecideTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasManage) return;

	registerMutatingTool(
		ctx,
		{
			name: "decide_hitl",
			description: `Resolve a single open human-in-the-loop (HITL) request: approve (send the proposed action as-is), decline, or reply with a custom prompt instead. Single-item only. ${HITL_BYPASS_NOTE} ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: {
				hitl_id: z.string(),
				action: HITL_REPLY_KIND_ENUM,
				custom_prompt: z.string().optional(),
			},
		},
		async (args, client) =>
			client.decideHitl(args.hitl_id, args.action, args.custom_prompt ?? null),
	);

	registerMutatingTool(
		ctx,
		{
			name: "decide_action_request",
			description: `Resolve a single pending fleet/project-scoped action request (e.g. add-project): apply it or decline it. Single-item only. ${HITL_BYPASS_NOTE} ${CONFIRMATION_PORTABILITY_NOTE}`,
			inputSchema: {
				action_request_id: z.string(),
				decision: ACTION_REQUEST_DECISION_ENUM,
			},
		},
		async (args, client) => client.decideActionRequest(args.action_request_id, args.decision),
	);
}
