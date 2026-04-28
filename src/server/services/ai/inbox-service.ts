import { desc, eq, inArray } from "drizzle-orm";
import type { Inbox, InboxFilter, InboxSeverity, InboxWorkItem } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { sessions, watcherProposals } from "../../db/schema.js";
import { listOpenActionRequests, narrowPayload } from "./action-requests-service.js";
import { listAllOpenHitl } from "./hitl-service.js";
import { activeSnoozeSet, listActiveSnoozes } from "./inbox-snooze-service.js";
import { intelligenceForSession } from "./intelligence-service.js";
import { getProposal } from "./proposals-service.js";

/**
 * Inbox work items. Discriminated union matches the plan's shape so the
 * UI can render each kind distinctly without string-sniffing. The union
 * itself lives in `src/shared/types.ts` so client and server stay in
 * lockstep — adding a new kind there forces both server build-up and
 * client switch statements to update.
 */

// Re-export the canonical types so existing server consumers
// (`import { InboxWorkItem } from "./inbox-service.js"`) keep working
// without per-call-site refactors.
export type { Inbox, InboxFilter, InboxSeverity, InboxWorkItem };

const DEFAULT_LIMIT = 100;

/**
 * Compose the operator inbox as a read model over the canonical sources:
 * - open HITL requests (ai_hitl_requests)
 * - classifier output (stuck / risky sessions with dispatchable action)
 * - recently failed proposals (watcher_proposals.state = 'failed')
 *
 * Read-only: no table backs this directly. If performance becomes an
 * issue we can memoize or project into its own table without changing
 * the discriminated-union contract.
 */
export async function buildInbox(filter: InboxFilter = {}): Promise<Inbox> {
	const limit = filter.limit ?? DEFAULT_LIMIT;
	const now = new Date();
	const items: InboxWorkItem[] = [];

	// ---- 1. Open HITL requests ----------------------------------------
	const openHitl = await listAllOpenHitl(limit);
	const sessionIds = Array.from(new Set(openHitl.map((h) => h.sessionId)));
	const sessionRows = sessionIds.length
		? await db
				.select({
					sessionId: sessions.sessionId,
					displayName: sessions.displayName,
				})
				.from(sessions)
				.where(inArray(sessions.sessionId, sessionIds))
		: [];
	const nameBySession = new Map(sessionRows.map((r) => [r.sessionId, r.displayName]));

	for (const h of openHitl) {
		const proposal = await getProposal(h.proposalId);
		if (!proposal) continue;
		const decision =
			proposal.decision === "continue" || proposal.decision === "ask" ? proposal.decision : "ask";
		const prompt = proposal.nextPrompt ?? proposal.reportSummary ?? "";
		const why = (
			(proposal.rawResponse as Record<string, unknown> | null)?.decision as
				| Record<string, unknown>
				| undefined
		)?.why as string | undefined;
		items.push({
			kind: "hitl",
			id: h.id,
			sessionId: h.sessionId,
			sessionName: nameBySession.get(h.sessionId) ?? null,
			proposalId: h.proposalId,
			decision,
			prompt,
			why: why ?? null,
			openedAt: h.createdAt,
			severity: "normal",
		});
	}

	// ---- 2. Stuck / risky sessions from classifier --------------------
	// Look at recently-active sessions so we don't classify 10k archived rows.
	const activeSessions = await db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			lastActivityAt: sessions.lastActivityAt,
		})
		.from(sessions)
		.where(inArray(sessions.status, ["active", "idle"]))
		.orderBy(desc(sessions.lastActivityAt))
		.limit(Math.max(limit, 50));

	for (const s of activeSessions) {
		try {
			const intel = await intelligenceForSession(s.sessionId);
			if (!intel) continue;
			if (intel.health === "stuck") {
				items.push({
					kind: "stuck",
					id: `stuck:${s.sessionId}`,
					sessionId: s.sessionId,
					sessionName: s.displayName ?? null,
					since: s.lastActivityAt,
					reason: intel.reasonCode,
					evidence: intel.evidence,
					severity: "high",
				});
			} else if (intel.health === "risky") {
				items.push({
					kind: "risky",
					id: `risky:${s.sessionId}`,
					sessionId: s.sessionId,
					sessionName: s.displayName ?? null,
					reason: intel.reasonCode,
					evidence: intel.evidence,
					severity: "high",
				});
			}
		} catch {
			// Intelligence failures should never crash the inbox.
		}
	}

	// ---- 3. Recently failed proposals ---------------------------------
	const failedProposals = await db
		.select()
		.from(watcherProposals)
		.where(eq(watcherProposals.state, "failed"))
		.orderBy(desc(watcherProposals.updatedAt))
		.limit(Math.max(limit, 20));

	const failedIds = Array.from(new Set(failedProposals.map((p) => p.sessionId)));
	const failedSessionRows = failedIds.length
		? await db
				.select({
					sessionId: sessions.sessionId,
					displayName: sessions.displayName,
				})
				.from(sessions)
				.where(inArray(sessions.sessionId, failedIds))
		: [];
	const failedNameBySession = new Map(failedSessionRows.map((r) => [r.sessionId, r.displayName]));

	for (const p of failedProposals) {
		items.push({
			kind: "failed_proposal",
			id: p.id,
			sessionId: p.sessionId,
			sessionName: failedNameBySession.get(p.sessionId) ?? null,
			errorSubType: p.errorSubType,
			errorMessage: p.errorMessage,
			at: p.updatedAt,
			severity: "normal",
		});
	}

	// ---- 4. Open action requests (launch approvals + add-project + session mutations) ----
	const openActions = await listOpenActionRequests();
	for (const a of openActions) {
		if (a.kind === "launch_request") {
			const payload = narrowPayload(a, "launch_request");
			items.push({
				kind: "action_launch",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "info",
				createdAt: a.createdAt,
				projectId: payload.projectId ?? "",
				projectName: payload.projectName ?? payload.projectId ?? "",
				template: payload.template,
				launchSpec: payload.launchSpec,
				requestedLaunchMode: payload.requestedLaunchMode,
				origin: a.origin,
				parentSessionId: payload.parentSessionId ?? null,
				parentSessionName: payload.parentSessionName ?? null,
			});
		} else if (a.kind === "add_project") {
			const payload = narrowPayload(a, "add_project");
			items.push({
				kind: "action_add_project",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "info",
				createdAt: a.createdAt,
				projectName: payload.draftFields?.name ?? "(unnamed)",
				projectCwd: payload.draftFields?.cwd ?? "(no directory)",
				defaultAgentType: payload.draftFields?.defaultAgentType ?? null,
				defaultModel: payload.draftFields?.defaultModel ?? null,
				defaultLaunchMode: payload.draftFields?.defaultLaunchMode ?? null,
				origin: a.origin,
			});
		} else if (a.kind === "session_stop") {
			const payload = narrowPayload(a, "session_stop");
			items.push({
				kind: "action_session_stop",
				id: a.id,
				sessionId: payload.sessionId,
				sessionName: payload.sessionDisplayName ?? null,
				severity: "high",
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "session_archive") {
			const payload = narrowPayload(a, "session_archive");
			items.push({
				kind: "action_session_archive",
				id: a.id,
				sessionId: payload.sessionId,
				sessionName: payload.sessionDisplayName ?? null,
				severity: "normal",
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "session_delete") {
			const payload = narrowPayload(a, "session_delete");
			items.push({
				kind: "action_session_delete",
				id: a.id,
				sessionId: payload.sessionId,
				sessionName: payload.sessionDisplayName ?? null,
				severity: "high",
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "edit_project") {
			const payload = narrowPayload(a, "edit_project");
			items.push({
				kind: "action_edit_project",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "normal",
				projectId: payload.projectId,
				projectName: payload.projectName ?? payload.projectId,
				fields: payload.fields ?? {},
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "delete_project") {
			const payload = narrowPayload(a, "delete_project");
			items.push({
				kind: "action_delete_project",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "high",
				projectId: payload.projectId,
				projectName: payload.projectName ?? payload.projectId,
				affectedTemplates: payload.affectedTemplates ?? 0,
				affectedSessions: payload.affectedSessions ?? 0,
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "edit_template") {
			const payload = narrowPayload(a, "edit_template");
			items.push({
				kind: "action_edit_template",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "normal",
				templateId: payload.templateId,
				templateName: payload.templateName ?? payload.templateId,
				fields: payload.fields ?? {},
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "delete_template") {
			const payload = narrowPayload(a, "delete_template");
			items.push({
				kind: "action_delete_template",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "high",
				templateId: payload.templateId,
				templateName: payload.templateName ?? payload.templateId,
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "add_channel") {
			const payload = narrowPayload(a, "add_channel");
			const validKinds = ["telegram", "webhook", "email"] as const;
			const channelKind = validKinds.includes(payload.channelKind as (typeof validKinds)[number])
				? (payload.channelKind as "telegram" | "webhook" | "email")
				: "telegram";
			items.push({
				kind: "action_add_channel",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "info",
				channelKind,
				channelLabel: payload.label ?? "Ask-created channel",
				createdAt: a.createdAt,
				origin: a.origin,
			});
		} else if (a.kind === "create_alert_rule") {
			const payload = narrowPayload(a, "create_alert_rule");
			items.push({
				kind: "action_create_alert_rule",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "info",
				createdAt: a.createdAt,
				projectName: payload.projectName ?? "(unknown project)",
				ruleType: payload.ruleType ?? "(unknown)",
				thresholdMinutes: payload.thresholdMinutes ?? null,
				origin: a.origin,
			});
		} else if (a.kind === "create_freeform_alert_rule") {
			const payload = narrowPayload(a, "create_freeform_alert_rule");
			items.push({
				kind: "action_create_freeform_alert_rule",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "info",
				createdAt: a.createdAt,
				projectName: payload.projectName ?? "(unknown project)",
				condition: (payload.condition ?? "(unknown condition)").slice(0, 200),
				dailyTokenBudget: payload.dailyTokenBudget ?? 0,
				origin: a.origin,
			});
		} else if (a.kind === "bulk_session_action") {
			const payload = narrowPayload(a, "bulk_session_action");
			const validActions = ["stop", "archive", "delete"] as const;
			const action = validActions.includes(payload.action as (typeof validActions)[number])
				? (payload.action as "stop" | "archive" | "delete")
				: "archive";
			const sessionCount = Array.isArray(payload.sessionIds) ? payload.sessionIds.length : 0;
			const sessionNames = Array.isArray(payload.sessionNames)
				? payload.sessionNames.slice(0, 20)
				: [];
			items.push({
				kind: "action_bulk_session",
				id: a.id,
				sessionId: null,
				sessionName: null,
				// stop and delete are irreversible — surface as high priority.
				severity: action === "archive" ? "normal" : "high",
				createdAt: a.createdAt,
				action,
				sessionCount,
				sessionNames,
				hasMore: sessionCount > 20,
				exclusionCount: Array.isArray(payload.exclusions) ? payload.exclusions.length : 0,
				origin: a.origin,
			});
		}
	}

	// ---- Filter / sort ------------------------------------------------
	let out = items;
	if (filter.kinds && filter.kinds.length > 0) {
		out = out.filter((i) => filter.kinds?.includes(i.kind));
	}
	if (filter.sessionId) {
		// action_launch items have null sessionId — they are always excluded
		// when filtering by sessionId, which is correct.
		out = out.filter((i) => i.sessionId === filter.sessionId);
	}
	if (filter.severity) {
		out = out.filter((i) => i.severity === filter.severity);
	}

	// Filter out snoozed items. Active snoozes are (kind, targetId) tuples;
	// for failed_proposal the targetId is the proposal id (item.id).
	const snoozeRecords = await listActiveSnoozes(now);
	if (snoozeRecords.length > 0) {
		const snoozed = activeSnoozeSet(snoozeRecords);
		out = out.filter((i) => !snoozed.has(`${i.kind}:${i.id}`));
	}

	// Sort: high severity first, info last, newest first within each bucket.
	out.sort((a, b) => {
		const sevRank = (s: InboxSeverity) => (s === "high" ? 0 : s === "normal" ? 1 : 2);
		const rankA = sevRank(a.severity);
		const rankB = sevRank(b.severity);
		if (rankA !== rankB) return rankA - rankB;
		return cmpNewestFirst(a, b);
	});

	out = out.slice(0, limit);

	const byKind: Record<InboxWorkItem["kind"], number> = {
		hitl: 0,
		stuck: 0,
		risky: 0,
		failed_proposal: 0,
		action_launch: 0,
		action_add_project: 0,
		action_session_stop: 0,
		action_session_archive: 0,
		action_session_delete: 0,
		action_edit_project: 0,
		action_delete_project: 0,
		action_edit_template: 0,
		action_delete_template: 0,
		action_add_channel: 0,
		action_create_alert_rule: 0,
		action_create_freeform_alert_rule: 0,
		action_bulk_session: 0,
	};
	for (const i of out) byKind[i.kind]++;

	return { items: out, total: out.length, byKind };
}

function cmpNewestFirst(a: InboxWorkItem, b: InboxWorkItem): number {
	const ta = timestampFor(a);
	const tb = timestampFor(b);
	return tb - ta;
}

function timestampFor(item: InboxWorkItem): number {
	const ts =
		item.kind === "hitl"
			? item.openedAt
			: item.kind === "failed_proposal"
				? item.at
				: item.kind === "stuck"
					? item.since
					: item.kind === "action_launch" ||
							item.kind === "action_add_project" ||
							item.kind === "action_session_stop" ||
							item.kind === "action_session_archive" ||
							item.kind === "action_session_delete" ||
							item.kind === "action_edit_project" ||
							item.kind === "action_delete_project" ||
							item.kind === "action_edit_template" ||
							item.kind === "action_delete_template" ||
							item.kind === "action_add_channel" ||
							item.kind === "action_create_alert_rule" ||
							item.kind === "action_create_freeform_alert_rule" ||
							item.kind === "action_bulk_session"
						? item.createdAt
						: new Date().toISOString();
	return ts.includes("T") ? new Date(ts).getTime() : new Date(`${ts.replace(" ", "T")}Z`).getTime();
}
