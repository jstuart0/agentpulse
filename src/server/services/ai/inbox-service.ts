import { desc, eq, inArray } from "drizzle-orm";
import type { LaunchMode, LaunchSpec, SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { sessions, watcherProposals } from "../../db/schema.js";
import { listOpenActionRequests } from "./action-requests-service.js";
import type { AddProjectActionPayload } from "./action-requests-service.js";
import type { HealthState } from "./classifier.js";
import { listAllOpenHitl } from "./hitl-service.js";
import { activeSnoozeSet, listActiveSnoozes } from "./inbox-snooze-service.js";
import { intelligenceForSession } from "./intelligence-service.js";
import { getProposal } from "./proposals-service.js";

/**
 * Inbox work items. Discriminated union matches the plan's shape so the
 * UI can render each kind distinctly without string-sniffing.
 */

export type InboxSeverity = "normal" | "high" | "info";

export type InboxWorkItem =
	| {
			kind: "hitl";
			id: string; // hitl request id
			sessionId: string;
			sessionName: string | null;
			proposalId: string;
			decision: "continue" | "ask";
			prompt: string;
			why: string | null;
			openedAt: string;
			severity: InboxSeverity;
	  }
	| {
			kind: "stuck";
			id: string; // stable session-derived id
			sessionId: string;
			sessionName: string | null;
			since: string;
			reason: string;
			evidence: string[];
			severity: InboxSeverity;
	  }
	| {
			kind: "risky";
			id: string;
			sessionId: string;
			sessionName: string | null;
			reason: string;
			evidence: string[];
			severity: InboxSeverity;
	  }
	| {
			kind: "failed_proposal";
			id: string; // proposal id
			sessionId: string;
			sessionName: string | null;
			errorSubType: string | null;
			errorMessage: string | null;
			at: string;
			severity: InboxSeverity;
	  }
	| {
			// Action requests are NOT session-scoped. sessionId/sessionName are
			// always null — the UI must branch on kind to avoid rendering a broken
			// session link. See InboxPage.tsx for the conditional renderer.
			kind: "action_launch";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectId: string;
			projectName: string;
			template: SessionTemplateInput;
			launchSpec: LaunchSpec;
			requestedLaunchMode: LaunchMode;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_add_project";
			id: string; // action_request id
			sessionId: null;
			sessionName: null;
			severity: "info";
			createdAt: string;
			projectName: string;
			projectCwd: string;
			defaultAgentType: string | null;
			defaultModel: string | null;
			defaultLaunchMode: string | null;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_stop";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_archive";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "normal";
			createdAt: string;
			origin: "web" | "telegram";
	  }
	| {
			kind: "action_session_delete";
			id: string; // action_request id
			sessionId: string;
			sessionName: string | null;
			severity: "high";
			createdAt: string;
			origin: "web" | "telegram";
	  };

export interface Inbox {
	items: InboxWorkItem[];
	total: number;
	byKind: Record<InboxWorkItem["kind"], number>;
}

export interface InboxFilter {
	kinds?: Array<InboxWorkItem["kind"]>;
	sessionId?: string;
	severity?: InboxSeverity;
	limit?: number;
}

const DEFAULT_LIMIT = 100;
const _HIGH_SEVERITY_HEALTH: HealthState[] = ["stuck", "risky", "blocked"];

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
			const payload = a.payload;
			items.push({
				kind: "action_launch",
				id: a.id,
				sessionId: null,
				sessionName: null,
				severity: "info",
				createdAt: a.createdAt,
				projectId: payload.projectId,
				projectName: payload.projectName ?? payload.projectId,
				template: payload.template,
				launchSpec: payload.launchSpec,
				requestedLaunchMode: payload.requestedLaunchMode,
				origin: a.origin,
			});
		} else if (a.kind === "add_project") {
			const payload = a.payload as unknown as AddProjectActionPayload;
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
			const payload = a.payload as unknown as {
				sessionId: string;
				sessionDisplayName: string | null;
			};
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
			const payload = a.payload as unknown as {
				sessionId: string;
				sessionDisplayName: string | null;
			};
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
			const payload = a.payload as unknown as {
				sessionId: string;
				sessionDisplayName: string | null;
			};
			items.push({
				kind: "action_session_delete",
				id: a.id,
				sessionId: payload.sessionId,
				sessionName: payload.sessionDisplayName ?? null,
				severity: "high",
				createdAt: a.createdAt,
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
							item.kind === "action_session_delete"
						? item.createdAt
						: new Date().toISOString();
	return ts.includes("T") ? new Date(ts).getTime() : new Date(`${ts.replace(" ", "T")}Z`).getTime();
}
