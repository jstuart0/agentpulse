import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { aiHitlRequests } from "../../db/schema.js";

export type HitlStatus =
	| "draft"
	| "awaiting_reply"
	| "applied"
	| "declined"
	| "timed_out"
	| "superseded";

export type HitlReplyKind = "approve" | "decline" | "custom";

export interface HitlRequestRecord {
	id: string;
	proposalId: string;
	sessionId: string;
	channelId: string | null;
	status: HitlStatus;
	replyKind: HitlReplyKind | null;
	replyText: string | null;
	expiresAt: string | null;
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
}): Promise<HitlRequestRecord> {
	await supersedeOpenHitl(input.sessionId);
	const now = new Date().toISOString();
	const [row] = await db
		.insert(aiHitlRequests)
		.values({
			proposalId: input.proposalId,
			sessionId: input.sessionId,
			channelId: input.channelId ?? null,
			status: "awaiting_reply",
			expiresAt: input.expiresAt ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

/** Mark any open HITL for this session as superseded. Returns count updated. */
export async function supersedeOpenHitl(sessionId: string): Promise<number> {
	const now = new Date().toISOString();
	const rows = await db
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
	status: "applied" | "declined";
	replyKind: HitlReplyKind;
	replyText?: string | null;
}): Promise<HitlRequestRecord | null> {
	const now = new Date().toISOString();
	await db
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
	const [row] = await db.select().from(aiHitlRequests).where(eq(aiHitlRequests.id, id)).limit(1);
	return row ? toRecord(row) : null;
}

export async function getOpenHitlForProposal(
	proposalId: string,
): Promise<HitlRequestRecord | null> {
	const [row] = await db
		.select()
		.from(aiHitlRequests)
		.where(
			and(eq(aiHitlRequests.proposalId, proposalId), eq(aiHitlRequests.status, "awaiting_reply")),
		)
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function getOpenHitlForSession(sessionId: string): Promise<HitlRequestRecord | null> {
	const [row] = await db
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
	const rows = await db
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
	const rows = await db
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
	const rows = await db
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
