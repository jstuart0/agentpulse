import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { aiHitlRequests, watcherProposals } from "../../db/schema.js";
import {
	type HitlStatus,
	openHitlRequest,
	resolveHitlRequest,
	supersedeOpenHitl,
} from "./hitl-service.js";
import type { WatcherDecision } from "./parser.js";

export type ProposalState =
	| "pending"
	| "complete"
	| "hitl_waiting"
	| "hitl_applied"
	| "hitl_declined"
	| "cancelled"
	| "failed";

export interface ProposalRecord {
	id: string;
	sessionId: string;
	providerId: string;
	state: ProposalState;
	decision: WatcherDecision["decision"] | null;
	nextPrompt: string | null;
	reportSummary: string | null;
	rawResponse: Record<string, unknown> | null;
	triggerEventId: string | null;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated: boolean;
	errorSubType: string | null;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecordBase(row: typeof watcherProposals.$inferSelect): ProposalRecord {
	return {
		id: row.id,
		sessionId: row.sessionId,
		providerId: row.providerId,
		state: row.state as ProposalState,
		decision: (row.decision as ProposalRecord["decision"]) ?? null,
		nextPrompt: row.nextPrompt,
		reportSummary: row.reportSummary,
		rawResponse: row.rawResponse ?? null,
		triggerEventId: row.triggerEventId,
		tokensIn: row.tokensIn,
		tokensOut: row.tokensOut,
		costCents: row.costCents,
		usageEstimated: row.usageEstimated,
		errorSubType: row.errorSubType,
		errorMessage: row.errorMessage,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Map ai_hitl_requests status onto the legacy proposal state enum for UI
 * compatibility. Callers that need the canonical HITL record should read
 * from ai_hitl_requests directly.
 */
function applyHitlOverlay(
	record: ProposalRecord,
	hitlStatus: HitlStatus | undefined,
): ProposalRecord {
	if (!hitlStatus) return record;
	if (hitlStatus === "awaiting_reply") return { ...record, state: "hitl_waiting" };
	if (hitlStatus === "applied") return { ...record, state: "hitl_applied" };
	if (hitlStatus === "declined") return { ...record, state: "hitl_declined" };
	// superseded / timed_out leave the proposal's physical state (usually
	// "complete") visible — UI treats those as closed, which is correct.
	return record;
}

async function hitlStatusMapFor(proposalIds: string[]): Promise<Map<string, HitlStatus>> {
	if (proposalIds.length === 0) return new Map();
	const rows = await db
		.select({
			proposalId: aiHitlRequests.proposalId,
			status: aiHitlRequests.status,
			createdAt: aiHitlRequests.createdAt,
		})
		.from(aiHitlRequests)
		.where(inArray(aiHitlRequests.proposalId, proposalIds));
	// Newest-per-proposal wins.
	const newest = new Map<string, { status: HitlStatus; createdAt: string }>();
	for (const row of rows) {
		const curr = newest.get(row.proposalId);
		if (!curr || row.createdAt > curr.createdAt) {
			newest.set(row.proposalId, {
				status: row.status as HitlStatus,
				createdAt: row.createdAt,
			});
		}
	}
	const out = new Map<string, HitlStatus>();
	for (const [pid, v] of newest) out.set(pid, v.status);
	return out;
}

export async function createPendingProposal(input: {
	sessionId: string;
	providerId: string;
	triggerEventId?: string | null;
}): Promise<ProposalRecord> {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(watcherProposals)
		.values({
			sessionId: input.sessionId,
			providerId: input.providerId,
			state: "pending",
			triggerEventId: input.triggerEventId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecordBase(row);
}

export interface CompleteProposalInput {
	id: string;
	decision: WatcherDecision["decision"];
	nextPrompt?: string | null;
	reportSummary?: string | null;
	rawResponse?: Record<string, unknown> | null;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated?: boolean;
	state?: ProposalState;
}

export async function completeProposal(
	input: CompleteProposalInput,
): Promise<ProposalRecord | null> {
	const now = new Date().toISOString();
	await db
		.update(watcherProposals)
		.set({
			decision: input.decision,
			nextPrompt: input.nextPrompt ?? null,
			reportSummary: input.reportSummary ?? null,
			rawResponse: input.rawResponse ?? null,
			tokensIn: input.tokensIn,
			tokensOut: input.tokensOut,
			costCents: input.costCents,
			usageEstimated: input.usageEstimated ?? false,
			state: input.state ?? "complete",
			updatedAt: now,
		})
		.where(eq(watcherProposals.id, input.id));
	return getProposal(input.id);
}

/**
 * Complete a proposal that requires HITL. Proposal state is stored as
 * "complete" (proposal work is finished) while the HITL workflow lives in
 * ai_hitl_requests. The caller-facing `ProposalRecord.state` is overlayed
 * as "hitl_waiting" by getProposal/listProposalsForSession so the UI
 * contract stays unchanged.
 */
export async function completeProposalAsHitl(
	input: Omit<CompleteProposalInput, "state"> & {
		channelId?: string | null;
		expiresAt?: string | null;
	},
): Promise<{ proposal: ProposalRecord | null; hitlId: string }> {
	await completeProposal({ ...input, state: "complete" });
	const hitl = await openHitlRequest({
		proposalId: input.id,
		sessionId: (await getProposal(input.id))?.sessionId ?? "",
		channelId: input.channelId ?? null,
		expiresAt: input.expiresAt ?? null,
	});
	const final = await getProposal(input.id);
	return { proposal: final, hitlId: hitl.id };
}

export async function failProposal(input: {
	id: string;
	errorSubType: string;
	errorMessage: string;
}): Promise<ProposalRecord | null> {
	const now = new Date().toISOString();
	await db
		.update(watcherProposals)
		.set({
			state: "failed",
			errorSubType: input.errorSubType,
			errorMessage: input.errorMessage,
			updatedAt: now,
		})
		.where(eq(watcherProposals.id, input.id));
	return getProposal(input.id);
}

export async function setProposalState(id: string, state: ProposalState): Promise<void> {
	await db
		.update(watcherProposals)
		.set({ state, updatedAt: new Date().toISOString() })
		.where(eq(watcherProposals.id, id));
}

export async function getProposal(id: string): Promise<ProposalRecord | null> {
	const [row] = await db
		.select()
		.from(watcherProposals)
		.where(eq(watcherProposals.id, id))
		.limit(1);
	if (!row) return null;
	const base = toRecordBase(row);
	const map = await hitlStatusMapFor([id]);
	return applyHitlOverlay(base, map.get(id));
}

export async function listProposalsForSession(
	sessionId: string,
	limit = 30,
): Promise<ProposalRecord[]> {
	const rows = await db
		.select()
		.from(watcherProposals)
		.where(eq(watcherProposals.sessionId, sessionId))
		.orderBy(desc(watcherProposals.createdAt))
		.limit(limit);
	const ids = rows.map((r) => r.id);
	const map = await hitlStatusMapFor(ids);
	return rows.map((r) => applyHitlOverlay(toRecordBase(r), map.get(r.id)));
}

export async function getOpenHitlProposal(sessionId: string): Promise<ProposalRecord | null> {
	// Look through ai_hitl_requests for an open one, then fetch its proposal.
	const [open] = await db
		.select({ proposalId: aiHitlRequests.proposalId })
		.from(aiHitlRequests)
		.where(
			and(eq(aiHitlRequests.sessionId, sessionId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.orderBy(desc(aiHitlRequests.createdAt))
		.limit(1);
	if (open) return getProposal(open.proposalId);

	// Legacy fallback: any proposal still physically marked hitl_waiting.
	const [row] = await db
		.select()
		.from(watcherProposals)
		.where(
			and(eq(watcherProposals.sessionId, sessionId), eq(watcherProposals.state, "hitl_waiting")),
		)
		.orderBy(desc(watcherProposals.createdAt))
		.limit(1);
	if (!row) return null;
	const base = toRecordBase(row);
	const map = await hitlStatusMapFor([row.id]);
	return applyHitlOverlay(base, map.get(row.id));
}

/**
 * Cancel any open HITL requests for a session. Supersedes both the new
 * ai_hitl_requests rows and any legacy `hitl_waiting` proposal rows that
 * predate the split. Returns the count of rows closed.
 */
export async function cancelOpenHitl(sessionId: string, reason = "cancelled"): Promise<number> {
	const now = new Date().toISOString();

	// New path: mark ai_hitl_requests as superseded.
	const supersededCount = await supersedeOpenHitl(sessionId);

	// Legacy path: any proposal still carrying state=hitl_waiting.
	const legacy = await db
		.update(watcherProposals)
		.set({ state: "cancelled", errorMessage: reason, updatedAt: now })
		.where(
			and(eq(watcherProposals.sessionId, sessionId), eq(watcherProposals.state, "hitl_waiting")),
		)
		.returning();
	return supersededCount + legacy.length;
}

/**
 * Resolve a HITL request tied to a proposal (approve/decline/custom).
 * Updates the ai_hitl_requests row and ensures the proposal's physical
 * state no longer claims a stale `hitl_*` value.
 */
export async function resolveProposalHitl(input: {
	proposalId: string;
	action: "approve" | "decline" | "custom";
	replyText?: string | null;
}): Promise<ProposalRecord | null> {
	const proposal = await getProposal(input.proposalId);
	if (!proposal) return null;

	const [open] = await db
		.select()
		.from(aiHitlRequests)
		.where(
			and(
				eq(aiHitlRequests.proposalId, input.proposalId),
				eq(aiHitlRequests.status, "awaiting_reply"),
			),
		)
		.limit(1);
	const now = new Date().toISOString();

	if (open) {
		await resolveHitlRequest({
			id: open.id,
			status: input.action === "decline" ? "declined" : "applied",
			replyKind: input.action,
			replyText: input.replyText ?? null,
		});
	} else if (proposal.state === "hitl_waiting") {
		// Legacy row — move proposal state directly so derived state flips.
		await db
			.update(watcherProposals)
			.set({
				state: input.action === "decline" ? "hitl_declined" : "hitl_applied",
				updatedAt: now,
			})
			.where(eq(watcherProposals.id, input.proposalId));
	}

	return getProposal(input.proposalId);
}
