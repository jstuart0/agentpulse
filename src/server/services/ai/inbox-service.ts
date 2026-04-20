import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions, watcherProposals } from "../../db/schema.js";
import type { HealthState } from "./classifier.js";
import { listAllOpenHitl } from "./hitl-service.js";
import { intelligenceForSession } from "./intelligence-service.js";
import { getProposal } from "./proposals-service.js";

/**
 * Inbox work items. Discriminated union matches the plan's shape so the
 * UI can render each kind distinctly without string-sniffing.
 */

export type InboxSeverity = "normal" | "high";

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
			(proposal.rawResponse as Record<string, unknown> | null)?.["decision"] as
				| Record<string, unknown>
				| undefined
		)?.["why"] as string | undefined;
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

	// ---- Filter / sort ------------------------------------------------
	let out = items;
	if (filter.kinds && filter.kinds.length > 0) {
		out = out.filter((i) => filter.kinds?.includes(i.kind));
	}
	if (filter.sessionId) {
		out = out.filter((i) => i.sessionId === filter.sessionId);
	}
	if (filter.severity) {
		out = out.filter((i) => i.severity === filter.severity);
	}

	// Sort: high severity first, newest first within each bucket.
	out.sort((a, b) => {
		const sevA = a.severity === "high" ? 0 : 1;
		const sevB = b.severity === "high" ? 0 : 1;
		if (sevA !== sevB) return sevA - sevB;
		return cmpNewestFirst(a, b);
	});

	out = out.slice(0, limit);

	const byKind: Record<InboxWorkItem["kind"], number> = {
		hitl: 0,
		stuck: 0,
		risky: 0,
		failed_proposal: 0,
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
					: new Date().toISOString();
	return ts.includes("T") ? new Date(ts).getTime() : new Date(`${ts.replace(" ", "T")}Z`).getTime();
}
