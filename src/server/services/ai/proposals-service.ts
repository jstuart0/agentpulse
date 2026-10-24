import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { HitlReplyKind } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { aiHitlRequests, watcherProposals } from "../../db/schema/index.js";
import { isUniqueViolationError } from "../../db/sql-helpers.js";
import { parseDbTimestamp } from "../util/db-time.js";
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
	/** The watcher's suggestion, whether or not it can be sent from here. Written once. */
	suggestedPrompt: string | null;
	continueKind: string | null;
	/** The turn this proposal is about (one proposal per session turn). */
	turnKey: string | null;
	reportSummary: string | null;
	rawResponse: Record<string, unknown> | null;
	triggerEventId: string | null;
	tokensIn: number;
	tokensOut: number;
	costCents: number;
	usageEstimated: boolean;
	errorSubType: string | null;
	errorMessage: string | null;
	/**
	 * The proposal's newest HITL request, as a person decides it: the hash of the
	 * prompt shown (sent back with Approve so the server can tell it is the same
	 * text), whether it can be approved as stored, and when the request lapses.
	 * Null on a proposal that never opened one.
	 */
	hitlId: string | null;
	promptSha256: string | null;
	approvable: boolean | null;
	hitlExpiresAt: string | null;
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
		suggestedPrompt: row.suggestedPrompt,
		continueKind: row.continueKind,
		turnKey: row.turnKey,
		reportSummary: row.reportSummary,
		rawResponse: row.rawResponse ?? null,
		triggerEventId: row.triggerEventId,
		tokensIn: row.tokensIn,
		tokensOut: row.tokensOut,
		costCents: row.costCents,
		usageEstimated: row.usageEstimated,
		errorSubType: row.errorSubType,
		errorMessage: row.errorMessage,
		hitlId: null,
		promptSha256: null,
		approvable: null,
		hitlExpiresAt: null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Map ai_hitl_requests status onto the legacy proposal state enum for UI
 * compatibility. Callers that need the canonical HITL record should read
 * from ai_hitl_requests directly.
 */
function applyHitlOverlay(record: ProposalRecord, hitl: HitlOverlay | undefined): ProposalRecord {
	if (!hitl) return record;
	const withHitl: ProposalRecord = {
		...record,
		hitlId: hitl.id,
		promptSha256: hitl.promptSha256,
		approvable: hitl.approvable,
		hitlExpiresAt: hitl.expiresAt,
	};
	if (hitl.status === "awaiting_reply") return { ...withHitl, state: "hitl_waiting" };
	if (hitl.status === "applied") return { ...withHitl, state: "hitl_applied" };
	if (hitl.status === "declined") return { ...withHitl, state: "hitl_declined" };
	// superseded / timed_out leave the proposal's physical state (usually
	// "complete") visible — UI treats those as closed, which is correct.
	return withHitl;
}

interface HitlOverlay {
	id: string;
	status: HitlStatus;
	promptSha256: string | null;
	approvable: boolean | null;
	expiresAt: string | null;
}

async function hitlStatusMapFor(proposalIds: string[]): Promise<Map<string, HitlOverlay>> {
	if (proposalIds.length === 0) return new Map();
	const rows = await getDb()
		.select({
			id: aiHitlRequests.id,
			proposalId: aiHitlRequests.proposalId,
			status: aiHitlRequests.status,
			createdAt: aiHitlRequests.createdAt,
			promptSha256: aiHitlRequests.promptSha256,
			approvable: aiHitlRequests.approvable,
			expiresAt: aiHitlRequests.expiresAt,
		})
		.from(aiHitlRequests)
		.where(inArray(aiHitlRequests.proposalId, proposalIds));
	// Newest-per-proposal wins.
	const newest = new Map<string, HitlOverlay & { createdAt: string }>();
	for (const row of rows) {
		const curr = newest.get(row.proposalId);
		if (!curr || row.createdAt > curr.createdAt) {
			newest.set(row.proposalId, {
				id: row.id,
				status: row.status as HitlStatus,
				createdAt: row.createdAt,
				promptSha256: row.promptSha256,
				approvable: row.approvable,
				expiresAt: row.expiresAt,
			});
		}
	}
	return newest;
}

/** A proposal for this (session, turn) already exists: the turn was proposed on, so there is nothing to create. */
export class ProposalAlreadyExistsError extends Error {
	constructor() {
		super("a proposal already exists for this turn");
		this.name = "ProposalAlreadyExistsError";
	}
}

/**
 * Open a pending proposal. With a `turnKey`, the database allows one proposal
 * per (session, turn): a second insert for the same turn throws
 * `ProposalAlreadyExistsError` instead of making a second one.
 */
export async function createPendingProposal(input: {
	sessionId: string;
	providerId: string;
	triggerEventId?: string | null;
	turnKey?: string | null;
}): Promise<ProposalRecord> {
	const now = new Date().toISOString();
	try {
		const [row] = await getDb()
			.insert(watcherProposals)
			.values({
				sessionId: input.sessionId,
				providerId: input.providerId,
				state: "pending",
				triggerEventId: input.triggerEventId ?? null,
				turnKey: input.turnKey ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return toRecordBase(row);
	} catch (err) {
		if (input.turnKey != null && isUniqueViolationError(err))
			throw new ProposalAlreadyExistsError();
		throw err;
	}
}

/** True when a proposal for this (session, turn) exists, whatever its state. */
export async function hasProposalForTurn(sessionId: string, turnKey: string): Promise<boolean> {
	const [row] = await getDb()
		.select({ id: watcherProposals.id })
		.from(watcherProposals)
		.where(and(eq(watcherProposals.sessionId, sessionId), eq(watcherProposals.turnKey, turnKey)))
		.limit(1);
	return row !== undefined;
}

/**
 * Proposals created for a session since `sinceIso` (ISO), and when the newest was created
 * (epoch ms). Counted from the table, so a restart can't reset the Continue flood limits.
 */
export async function proposalActivity(
	sessionId: string,
	sinceIso: string,
): Promise<{ inWindow: number; newestAt: number | null }> {
	const rows = await getDb()
		.select({ createdAt: watcherProposals.createdAt })
		.from(watcherProposals)
		.where(eq(watcherProposals.sessionId, sessionId))
		.orderBy(desc(watcherProposals.createdAt))
		.limit(50);
	const times = rows
		.map((r) => parseDbTimestamp(r.createdAt))
		.filter((t): t is number => t !== null);
	const since = Date.parse(sinceIso);
	return {
		inWindow: times.filter((t) => t >= since).length,
		newestAt: times.length > 0 ? Math.max(...times) : null,
	};
}

/**
 * Store the watcher's suggestion for a proposal, once. `WHERE suggested_prompt
 * IS NULL` makes the first write the only one: a second call (a retry, a
 * race) leaves the text a person was shown, and the hash made of it, alone.
 * The only writer of the column.
 */
export async function recordSuggestion(input: {
	id: string;
	suggestedPrompt: string;
	continueKind: string | null;
}): Promise<boolean> {
	const rows = await getDb()
		.update(watcherProposals)
		.set({
			suggestedPrompt: input.suggestedPrompt,
			continueKind: input.continueKind,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(watcherProposals.id, input.id), isNull(watcherProposals.suggestedPrompt)))
		.returning({ id: watcherProposals.id });
	return rows.length > 0;
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
	/** Stored once with the completion (see `recordSuggestion`); the kind of nudge goes with it. */
	suggestedPrompt?: string | null;
	continueKind?: string | null;
}

export async function completeProposal(
	input: CompleteProposalInput,
): Promise<ProposalRecord | null> {
	const now = new Date().toISOString();
	await getDb()
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
	if (input.suggestedPrompt != null) {
		await recordSuggestion({
			id: input.id,
			suggestedPrompt: input.suggestedPrompt,
			continueKind: input.continueKind ?? null,
		});
	}
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
		/** What a later decision is bound to: the turn, its trigger, the hash of the shown prompt, and whether it can be approved as stored. */
		turnKey?: string | null;
		triggerEventId?: number | null;
		promptSha256?: string | null;
		approvable?: boolean | null;
	},
): Promise<{ proposal: ProposalRecord | null; hitlId: string }> {
	await completeProposal({ ...input, state: "complete" });
	const hitl = await openHitlRequest({
		proposalId: input.id,
		sessionId: (await getProposal(input.id))?.sessionId ?? "",
		channelId: input.channelId ?? null,
		expiresAt: input.expiresAt ?? null,
		turnKey: input.turnKey ?? null,
		triggerEventId: input.triggerEventId ?? null,
		promptSha256: input.promptSha256 ?? null,
		approvable: input.approvable ?? null,
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
	await getDb()
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
	await getDb()
		.update(watcherProposals)
		.set({ state, updatedAt: new Date().toISOString() })
		.where(eq(watcherProposals.id, id));
}

export async function getProposal(id: string): Promise<ProposalRecord | null> {
	const [row] = await getDb()
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
	const rows = await getDb()
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
	const [open] = await getDb()
		.select({ proposalId: aiHitlRequests.proposalId })
		.from(aiHitlRequests)
		.where(
			and(eq(aiHitlRequests.sessionId, sessionId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.orderBy(desc(aiHitlRequests.createdAt))
		.limit(1);
	if (open) return getProposal(open.proposalId);

	// Legacy fallback: any proposal still physically marked hitl_waiting.
	const [row] = await getDb()
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
	const legacy = await getDb()
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
	action: HitlReplyKind;
	replyText?: string | null;
}): Promise<ProposalRecord | null> {
	const proposal = await getProposal(input.proposalId);
	if (!proposal) return null;

	const [open] = await getDb()
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
		await getDb()
			.update(watcherProposals)
			.set({
				state: input.action === "decline" ? "hitl_declined" : "hitl_applied",
				updatedAt: now,
			})
			.where(eq(watcherProposals.id, input.proposalId));
	}

	return getProposal(input.proposalId);
}
