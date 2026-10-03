/**
 * Session-observability read tools (AGEN-12 Phase 3, D2's observe read-tool
 * table): list_sessions, get_session, get_session_timeline,
 * get_event_context, get_session_claude_md. All observe-scoped — registered
 * whenever the caller holds observe or manage (D5: manage implies
 * observe-satisfied).
 */
import { z } from "zod";
import type { AgentPulseClient } from "../client.js";
import {
	OBSERVED_AGENT_TYPE_ENUM,
	OPERATIONAL_STATUS_ENUM,
	OWNER_SCOPE,
	SESSION_STATUS_ENUM,
} from "../enums.js";
import { capList, capText } from "../output.js";
import { assertOwnerScopeEchoed } from "../scopes.js";
import { registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

/**
 * Fields the dashboard grid needs, trimmed for token budget — no
 * notes/metadata/claude-md blobs. Exported so resources.ts's
 * agentpulse://sessions resource reuses the exact same row shape rather
 * than hand-building a third, diverged copy.
 *
 * `managed` reads `session.managed` — the batched boolean
 * `getSessions()` (session-tracker.ts) now populates via one membership
 * query per page, NOT `session.managedSession` (the full joined object,
 * which only the single-session detail route populates and which is
 * always undefined on list rows).
 */
export function compactSessionRow(
	session: Awaited<ReturnType<AgentPulseClient["getSessions"]>>["sessions"][number],
) {
	return {
		sessionId: session.sessionId,
		displayName: session.displayName,
		agentType: session.agentType,
		status: session.status,
		semanticStatus: session.semanticStatus,
		currentTask: session.currentTask,
		cwd: session.cwd,
		isWorking: session.isWorking,
		isPinned: session.isPinned,
		isArchived: session.isArchived,
		gitBranch: session.gitBranch,
		lastActivityAt: session.lastActivityAt,
		totalToolUses: session.totalToolUses,
		managed: Boolean(session.managed),
		// Who owns the session. Optional: an older server doesn't send them.
		ownerUserId: session.ownerUserId,
		ownerKind: session.ownerKind,
		// Optional: an AgentPulse server predating the operational-status
		// model (AGEN) simply doesn't send this field, and it stays
		// undefined here too — no error, no stale guess.
		operationalStatus: session.operationalStatus,
	};
}

function capEventPreviews(
	events: Awaited<ReturnType<AgentPulseClient["getSessionTimeline"]>>["events"],
) {
	return events.map((e) => ({
		...e,
		toolInput: e.toolInput ? capText(JSON.stringify(e.toolInput)) : null,
		toolResponse: e.toolResponse ? capText(e.toolResponse) : null,
		content: e.content ? capText(e.content) : null,
	}));
}

/**
 * Shared by the get_session tool and the agentpulse://sessions/{sessionId}
 * resource (test-contract Phase 3 assertion 17: the resource must match the
 * tool's shape for the same id) — one implementation, two callers.
 */
export async function buildSessionDetailPayload(client: AgentPulseClient, sessionId: string) {
	const { session, events, controlActions } = await client.getSession(sessionId);
	const trimmed = capEventPreviews(events).slice(0, 20);
	return {
		session,
		managed: Boolean(session.managedSession),
		events: trimmed,
		...(events.length > trimmed.length
			? {
					moreEvents: `${events.length - trimmed.length} older event(s) not shown here (showing the most recent 20 of ${events.length}) — call get_session_timeline for full history.`,
				}
			: {}),
		...(controlActions ? { controlActions } : {}),
	};
}

export function registerSessionsTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasObserve) return;

	registerReadTool(
		ctx,
		{
			name: "list_sessions",
			description:
				"List AgentPulse sessions across the fleet, optionally filtered by status/agent type/project/operational state, or by owner. Compact rows; each includes a `managed` boolean indicating whether control tools (stop/prompt/retry) can target it, who owns it (`ownerUserId`, `ownerKind`: user/service/unassigned), and (when the server supports it) `operationalStatus` — waiting/working/idle/error/completed. `owner` is `me` (the key's owner), a user id, `unassigned`, `service`, or `all` (default); `total` counts the same scoped set. The server must confirm the scope it applied (`ownerScope` in the response); an older server ignores `owner`, so a response that doesn't confirm it is refused instead of returning everyone's sessions.",
			inputSchema: {
				status: SESSION_STATUS_ENUM.optional(),
				agent_type: OBSERVED_AGENT_TYPE_ENUM.optional(),
				project_id: z.string().optional(),
				// Filters by the derived operational state (AGEN) rather than
				// the raw lifecycle `status` above. Older servers ignore this
				// param and return an unfiltered page instead of erroring.
				operational: OPERATIONAL_STATUS_ENUM.optional(),
				owner: OWNER_SCOPE.optional(),
				limit: z.number().int().min(1).max(100).optional(),
				offset: z.number().int().min(0).optional(),
			},
		},
		async (args, client) => {
			const limit = args.limit ?? 20;
			const offset = args.offset ?? 0;
			const { sessions, total, ownerScope } = await client.getSessions({
				status: args.status,
				agentType: args.agent_type,
				projectId: args.project_id,
				operational: args.operational,
				owner: args.owner,
				limit,
				offset,
			});
			assertOwnerScopeEchoed(args.owner, ownerScope);
			const capped = capList(sessions.map(compactSessionRow), { offset });
			const hasMore = offset + sessions.length < total;
			return {
				sessions: capped.items,
				total,
				...(ownerScope ? { ownerScope } : {}),
				...(capped.hint ? { truncated: capped.hint } : {}),
				...(hasMore
					? {
							hint: `returned ${sessions.length} of ${total} — call again with offset=${offset + sessions.length}`,
						}
					: {}),
			};
		},
	);

	registerReadTool(
		ctx,
		{
			name: "get_session",
			description:
				"Full detail for one AgentPulse session: session fields, the most recent 20 events (tool_input/tool_response previews capped), and control actions (manage-scoped callers only). Surfaces `managed` so the model knows whether control tools can target it.",
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => buildSessionDetailPayload(client, args.session_id),
	);

	registerReadTool(
		ctx,
		{
			name: "get_session_timeline",
			description:
				"Paginated event timeline for a session (newest first), independent of get_session's 20-event trim.",
			inputSchema: {
				session_id: z.string(),
				limit: z.number().int().min(1).max(200).optional(),
				offset: z.number().int().min(0).optional(),
			},
		},
		async (args, client) => {
			const limit = args.limit ?? 30;
			const offset = args.offset ?? 0;
			const { events } = await client.getSessionTimeline(args.session_id, { limit, offset });
			const capped = capList(capEventPreviews(events), { offset });
			return {
				events: capped.items,
				...(capped.hint ? { truncated: capped.hint } : {}),
				...(events.length === limit
					? {
							hint: `returned a full page of ${limit} — call again with offset=${offset + events.length} for more`,
						}
					: {}),
			};
		},
	);

	registerReadTool(
		ctx,
		{
			name: "get_event_context",
			description:
				"Events immediately before/after a specific event id, for deep-linking into an older part of a session's transcript.",
			inputSchema: {
				session_id: z.string(),
				event_id: z.number().int(),
				around: z.number().int().min(1).max(100).optional(),
			},
		},
		async (args, client) => {
			const around = args.around ?? 20;
			const { events, target } = await client.getEventContext(
				args.session_id,
				args.event_id,
				around,
			);
			return { events: capEventPreviews(events), target };
		},
	);

	registerReadTool(
		ctx,
		{
			name: "get_session_claude_md",
			description:
				"The CLAUDE.md content stored for a session (as synced from the agent's workspace).",
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => {
			const result = await client.getSessionClaudeMd(args.session_id);
			// capText the content explicitly (dexter Med, mid-build): the
			// structural safety net (output.ts capToolResult) only handled
			// oversized ARRAY fields until this same commit's output.ts fix;
			// an oversized single scalar string was silently DROPPED, not
			// truncated. Cap here too (matches the get_session_timeline/
			// search convention of capping known free-text fields at the
			// handler level) rather than relying solely on the safety net.
			return { ...result, content: capText(result.content) };
		},
	);
}
