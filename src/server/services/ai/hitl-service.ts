import type { SQL } from "drizzle-orm";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	not,
	notLike,
	or,
} from "drizzle-orm";
import type { HitlReplyKind } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { aiHitlRequests } from "../../db/schema/index.js";
import { notifyInboxChanged } from "../notifier.js";

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
 * How long an open request can still be answered. An answer sends a prompt the watcher wrote for the
 * session as it was then; a day later that is a guess about a different moment.
 */
export const HITL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * When a request stops being answerable: its `expiresAt`, or for a request opened before expiry existed
 * (no `expiresAt`), a day after it was created.
 */
export function effectiveExpiry(row: { expiresAt: string | null; createdAt: string }): number {
	if (row.expiresAt) return Date.parse(row.expiresAt);
	const created = Date.parse(
		/[zZ]|[+-]\d\d(:?\d\d)?$/.test(row.createdAt)
			? row.createdAt
			: `${row.createdAt.replace(" ", "T")}Z`,
	);
	return created + HITL_TTL_MS;
}

/** Rows whose time is up, in SQL: past `expires_at`, or with none and created more than a day ago. */
function overdue(now: Date): SQL {
	const nowIso = now.toISOString();
	const cutoff = new Date(now.getTime() - HITL_TTL_MS);
	const cutoffIso = cutoff.toISOString();
	const cutoffSpace = `${cutoffIso.slice(0, 10)} ${cutoffIso.slice(11, 19)}`;
	return or(
		and(isNotNull(aiHitlRequests.expiresAt), lte(aiHitlRequests.expiresAt, nowIso)),
		and(
			isNull(aiHitlRequests.expiresAt),
			// created_at is an ISO string when the service wrote it and "YYYY-MM-DD HH:MM:SS" when the database did
			or(
				and(like(aiHitlRequests.createdAt, "%T%"), lte(aiHitlRequests.createdAt, cutoffIso)),
				and(notLike(aiHitlRequests.createdAt, "%T%"), lte(aiHitlRequests.createdAt, cutoffSpace)),
			),
		),
	) as SQL;
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
	const [row] = await getDb()
		.insert(aiHitlRequests)
		.values({
			proposalId: input.proposalId,
			sessionId: input.sessionId,
			channelId: input.channelId ?? null,
			status: "awaiting_reply",
			expiresAt: input.expiresAt ?? new Date(Date.now() + HITL_TTL_MS).toISOString(),
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
export async function listAllOpenHitl(limit = 100, offset = 0): Promise<HitlRequestRecord[]> {
	const rows = await getDb()
		.select()
		.from(aiHitlRequests)
		// An overdue request the sweep hasn't closed yet is not offered: it can't be answered.
		.where(and(eq(aiHitlRequests.status, "awaiting_reply"), not(overdue(new Date()))))
		.orderBy(desc(aiHitlRequests.createdAt))
		.limit(limit)
		.offset(offset);
	return rows.map(toRecord);
}

/** Time-out any awaiting_reply rows that are overdue, and tell whoever can see them. */
export async function expireOverdueHitl(): Promise<number> {
	const now = new Date();
	const rows = await getDb()
		.update(aiHitlRequests)
		.set({ status: "timed_out", updatedAt: now.toISOString() })
		.where(and(eq(aiHitlRequests.status, "awaiting_reply"), overdue(now)))
		.returning({ sessionId: aiHitlRequests.sessionId });
	for (const sessionId of new Set(rows.map((r) => r.sessionId))) notifyInboxChanged({ sessionId });
	return rows.length;
}
