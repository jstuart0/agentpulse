import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { ActionRequestDecision, HitlReplyKind } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { aiHitlRequests } from "../../db/schema/index.js";

export type HitlStatus =
	| "draft"
	| "awaiting_reply"
	| "applied"
	| "declined"
	| "timed_out"
	| "superseded";

// Canonical const + type live in src/shared/types.ts. Re-exported here
// so existing server consumers don't need to change their import path.
export type { HitlReplyKind };

export interface HitlRequestRecord {
	id: string;
	proposalId: string;
	sessionId: string;
	channelId: string | null;
	status: HitlStatus;
	replyKind: HitlReplyKind | null;
	replyText: string | null;
	expiresAt: string | null;
	/** The turn this request is about, the event that triggered it, and the hash of the prompt a person is shown. */
	turnKey: string | null;
	triggerEventId: number | null;
	promptSha256: string | null;
	/** True only when the stored suggestion survived the sanitiser unchanged. Null on requests from before it existed. */
	approvable: boolean | null;
	telegramSentAt: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof aiHitlRequests.$inferSelect): HitlRequestRecord {
	return {
		id: row.id,
		proposalId: row.proposalId,
		sessionId: row.sessionId,
		channelId: row.channelId,
		status: row.status as HitlStatus,
		replyKind: (row.replyKind as HitlReplyKind) ?? null,
		replyText: row.replyText,
		expiresAt: row.expiresAt,
		turnKey: row.turnKey,
		triggerEventId: row.triggerEventId,
		promptSha256: row.promptSha256,
		approvable: row.approvable,
		telegramSentAt: row.telegramSentAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Open a new HITL request for a proposal. Supersedes any existing
 * `awaiting_reply` row for the same session so the unique partial index
 * stays happy.
 */
export async function openHitlRequest(input: {
	proposalId: string;
	sessionId: string;
	channelId?: string | null;
	expiresAt?: string | null;
	turnKey?: string | null;
	triggerEventId?: number | null;
	promptSha256?: string | null;
	approvable?: boolean | null;
}): Promise<HitlRequestRecord> {
	await supersedeOpenHitl(input.sessionId);
	const now = new Date().toISOString();
	const [row] = await getDb()
		.insert(aiHitlRequests)
		.values({
			proposalId: input.proposalId,
			sessionId: input.sessionId,
			channelId: input.channelId ?? null,
			status: "awaiting_reply",
			expiresAt: input.expiresAt ?? null,
			turnKey: input.turnKey ?? null,
			triggerEventId: input.triggerEventId ?? null,
			promptSha256: input.promptSha256 ?? null,
			approvable: input.approvable ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

/** Mark any open HITL for this session as superseded. Returns count updated. */
export async function supersedeOpenHitl(sessionId: string): Promise<number> {
	const now = new Date().toISOString();
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({ status: "superseded", updatedAt: now })
		.where(
			and(eq(aiHitlRequests.sessionId, sessionId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.returning();
	return rows.length;
}

/** Resolve a specific HITL request with an operator reply. */
export async function resolveHitlRequest(input: {
	id: string;
	status: ActionRequestDecision;
	replyKind: HitlReplyKind;
	replyText?: string | null;
}): Promise<HitlRequestRecord | null> {
	const now = new Date().toISOString();
	await getDb()
		.update(aiHitlRequests)
		.set({
			status: input.status,
			replyKind: input.replyKind,
			replyText: input.replyText ?? null,
			updatedAt: now,
		})
		.where(eq(aiHitlRequests.id, input.id));
	return getHitlRequest(input.id);
}

export async function getHitlRequest(id: string): Promise<HitlRequestRecord | null> {
	const [row] = await getDb()
		.select()
		.from(aiHitlRequests)
		.where(eq(aiHitlRequests.id, id))
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function getOpenHitlForProposal(
	proposalId: string,
): Promise<HitlRequestRecord | null> {
	const [row] = await getDb()
		.select()
		.from(aiHitlRequests)
		.where(
			and(eq(aiHitlRequests.proposalId, proposalId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function getOpenHitlForSession(sessionId: string): Promise<HitlRequestRecord | null> {
	const [row] = await getDb()
		.select()
		.from(aiHitlRequests)
		.where(
			and(eq(aiHitlRequests.sessionId, sessionId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.orderBy(desc(aiHitlRequests.createdAt))
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function listOpenHitlForSessions(sessionIds: string[]): Promise<HitlRequestRecord[]> {
	if (sessionIds.length === 0) return [];
	const rows = await getDb()
		.select()
		.from(aiHitlRequests)
		.where(
			and(
				inArray(aiHitlRequests.sessionId, sessionIds),
				eq(aiHitlRequests.status, "awaiting_reply"),
			),
		);
	return rows.map(toRecord);
}

/** List open HITL across all sessions — used by the Phase 3 inbox. */
export async function listAllOpenHitl(limit = 100): Promise<HitlRequestRecord[]> {
	const rows = await getDb()
		.select()
		.from(aiHitlRequests)
		.where(eq(aiHitlRequests.status, "awaiting_reply"))
		.orderBy(desc(aiHitlRequests.createdAt))
		.limit(limit);
	return rows.map(toRecord);
}

/** Time-out any awaiting_reply rows whose expires_at has passed. */
export async function expireOverdueHitl(): Promise<number> {
	const now = new Date().toISOString();
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({ status: "timed_out", updatedAt: now })
		.where(
			and(
				eq(aiHitlRequests.status, "awaiting_reply"),
				isNotNull(aiHitlRequests.expiresAt),
				lte(aiHitlRequests.expiresAt, now),
			),
		)
		.returning();
	return rows.length;
}

/**
 * Claim an open HITL for a decision before any side effect: one conditional
 * update that matches only a request still awaiting a reply and not yet
 * expired. Of two concurrent decisions exactly one gets the row back. The
 * claim time is returned so a release can recognise its own claim.
 */
export async function claimHitl(input: {
	id: string;
	status: "applied" | "declined";
	replyKind: HitlReplyKind;
	replyText?: string | null;
}): Promise<{ claimedAt: string } | null> {
	const claimedAt = new Date().toISOString();
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({
			status: input.status,
			replyKind: input.replyKind,
			replyText: input.replyText ?? null,
			updatedAt: claimedAt,
		})
		.where(
			and(
				eq(aiHitlRequests.id, input.id),
				eq(aiHitlRequests.status, "awaiting_reply"),
				or(isNull(aiHitlRequests.expiresAt), gt(aiHitlRequests.expiresAt, claimedAt)),
			),
		)
		.returning({ id: aiHitlRequests.id });
	return rows.length > 0 ? { claimedAt } : null;
}

/**
 * Give a claim back after a refusal that happened before anything was sent, so
 * the person can still decline, copy or edit. Re-opens the request only if it
 * is still this claim's and no other request is open for the session (a newer
 * one must not be made to share the slot); returns false when it could not.
 */
export async function releaseHitlClaim(input: {
	id: string;
	sessionId: string;
	claimedAt: string;
}): Promise<boolean> {
	try {
		const rows = await getDb()
			.update(aiHitlRequests)
			.set({
				status: "awaiting_reply",
				replyKind: null,
				replyText: null,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(aiHitlRequests.id, input.id),
					eq(aiHitlRequests.status, "applied"),
					eq(aiHitlRequests.updatedAt, input.claimedAt),
					sql`NOT EXISTS (SELECT 1 FROM ai_hitl_requests o WHERE o.session_id = ${input.sessionId} AND o.status = 'awaiting_reply' AND o.id <> ${input.id})`,
				),
			)
			.returning({ id: aiHitlRequests.id });
		return rows.length > 0;
	} catch {
		// A request opened between the check and the update trips the one-open-per-session index.
		return false;
	}
}

/** Close one request that is still open. Returns whether it changed. */
export async function closeOpenHitl(
	id: string,
	status: "superseded" | "timed_out",
): Promise<boolean> {
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({ status, updatedAt: new Date().toISOString() })
		.where(and(eq(aiHitlRequests.id, id), eq(aiHitlRequests.status, "awaiting_reply")))
		.returning({ id: aiHitlRequests.id });
	return rows.length > 0;
}

/** A Telegram copy of this request was sent: counted toward the global Telegram cap. */
export async function stampHitlTelegramSent(id: string): Promise<void> {
	await getDb()
		.update(aiHitlRequests)
		.set({ telegramSentAt: new Date().toISOString() })
		.where(eq(aiHitlRequests.id, id));
}
