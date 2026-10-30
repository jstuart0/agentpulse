import type { SQL } from "drizzle-orm";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	not,
	notLike,
	or,
	sql,
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
			expiresAt: input.expiresAt ?? new Date(Date.now() + HITL_TTL_MS).toISOString(),
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
