import { and, desc, eq, gt } from "drizzle-orm";
import type { InboxWorkItem } from "../../../shared/types.js";
import type { Actor } from "../../auth/actor.js";
import { getDb } from "../../db/client.js";
import {
	aiHitlRequests,
	aiInboxSnoozes,
	sessions,
	watcherProposals,
} from "../../db/schema/index.js";
import { canReadSession } from "../authorization.js";

/**
 * Operator-inbox snooze. A snooze is an (kind, targetId, until) tuple
 * that tells buildInbox to hide the matching item until the deadline
 * passes. Snoozes are stored, survive restart, and auto-expire.
 *
 * Safe to expose as a one-click UI action per the Phase 3 plan: snooze
 * is reversible, idempotent, and non-destructive.
 */

// Snooze applies only to session-scoped inbox items — the five listed
// here. The Extract narrows InboxWorkItem["kind"] so removing or
// renaming any of these kinds in shared/types.ts immediately
// breaks the snooze service at compile time.
export type InboxKind = Extract<
	InboxWorkItem["kind"],
	"hitl" | "stuck" | "risky" | "failed_proposal" | "watcher_report"
>;

export interface SnoozeRecord {
	id: string;
	kind: InboxKind;
	targetId: string;
	snoozedUntil: string;
	createdBy: string | null;
	reason: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof aiInboxSnoozes.$inferSelect): SnoozeRecord {
	return {
		id: row.id,
		kind: row.kind as InboxKind,
		targetId: row.targetId,
		snoozedUntil: row.snoozedUntil,
		createdBy: row.createdBy,
		reason: row.reason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Snooze an inbox item until a given deadline. If a snooze already
 * exists for this (kind, targetId), the deadline is extended to the
 * later of the two.
 */
export async function snoozeItem(input: {
	kind: InboxKind;
	targetId: string;
	until: Date;
	reason?: string | null;
	createdBy?: string | null;
}): Promise<SnoozeRecord> {
	const now = new Date().toISOString();
	const untilIso = input.until.toISOString();
	const [existing] = await getDb()
		.select()
		.from(aiInboxSnoozes)
		.where(and(eq(aiInboxSnoozes.kind, input.kind), eq(aiInboxSnoozes.targetId, input.targetId)))
		.limit(1);

	if (existing) {
		const newUntil = existing.snoozedUntil > untilIso ? existing.snoozedUntil : untilIso;
		const [row] = await getDb()
			.update(aiInboxSnoozes)
			.set({
				snoozedUntil: newUntil,
				reason: input.reason ?? existing.reason,
				updatedAt: now,
			})
			.where(eq(aiInboxSnoozes.id, existing.id))
			.returning();
		return toRecord(row);
	}

	const [row] = await getDb()
		.insert(aiInboxSnoozes)
		.values({
			kind: input.kind,
			targetId: input.targetId,
			snoozedUntil: untilIso,
			createdBy: input.createdBy ?? null,
			reason: input.reason ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

export async function unsnooze(id: string): Promise<boolean> {
	const rows = await getDb().delete(aiInboxSnoozes).where(eq(aiInboxSnoozes.id, id)).returning();
	return rows.length > 0;
}

export async function unsnoozeTarget(kind: InboxKind, targetId: string): Promise<boolean> {
	const rows = await getDb()
		.delete(aiInboxSnoozes)
		.where(and(eq(aiInboxSnoozes.kind, kind), eq(aiInboxSnoozes.targetId, targetId)))
		.returning();
	return rows.length > 0;
}

/**
 * Return the set of (kind, targetId) pairs that are currently snoozed.
 * Expired rows are silently skipped (and a future sweep can prune them).
 */
export async function listActiveSnoozes(now: Date = new Date()): Promise<SnoozeRecord[]> {
	const rows = await getDb()
		.select()
		.from(aiInboxSnoozes)
		.where(gt(aiInboxSnoozes.snoozedUntil, now.toISOString()))
		.orderBy(desc(aiInboxSnoozes.snoozedUntil));
	return rows.map(toRecord);
}

export function activeSnoozeSet(records: SnoozeRecord[]): Set<string> {
	return new Set(records.map((r) => `${r.kind}:${r.targetId}`));
}

/**
 * The session a snooze target belongs to, or null when it can't be resolved to one. A `hitl`
 * target is a request id and a `failed_proposal` target a proposal id; `stuck` and `risky`
 * targets are `<kind>:<sessionId>`.
 */
export async function snoozeTargetSession(
	kind: InboxKind,
	targetId: string,
): Promise<string | null> {
	if (kind === "stuck" || kind === "risky") {
		const prefix = `${kind}:`;
		return targetId.startsWith(prefix) && targetId.length > prefix.length
			? targetId.slice(prefix.length)
			: null;
	}
	if (kind === "hitl") {
		const [row] = await getDb()
			.select({ sessionId: aiHitlRequests.sessionId })
			.from(aiHitlRequests)
			.where(eq(aiHitlRequests.id, targetId))
			.limit(1);
		return row?.sessionId ?? null;
	}
	const [row] = await getDb()
		.select({ sessionId: watcherProposals.sessionId })
		.from(watcherProposals)
		.where(eq(watcherProposals.id, targetId))
		.limit(1);
	return row?.sessionId ?? null;
}

/**
 * May this actor snooze, unsnooze or see the snooze of this item? Solo: yes. Team: only if they
 * can read the item's session, and only an admin for a target that doesn't resolve to one. A snooze
 * hides the item from everyone who could see it, so it is judged like the item itself.
 */
export async function actorMayTouchSnooze(
	actor: Actor,
	kind: InboxKind,
	targetId: string,
): Promise<boolean> {
	if (actor.mode === "solo") return true;
	const sessionId = await snoozeTargetSession(kind, targetId);
	if (sessionId === null) return actor.role === "admin";
	const [row] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return canReadSession(actor, row ? { ownerUserId: row.ownerUserId ?? null } : {});
}

/** The snooze with this id, for a check before it is removed. */
export async function getSnooze(id: string): Promise<SnoozeRecord | null> {
	const [row] = await getDb()
		.select()
		.from(aiInboxSnoozes)
		.where(eq(aiInboxSnoozes.id, id))
		.limit(1);
	return row ? toRecord(row) : null;
}

/** The active snoozes this actor may see. */
export async function listActiveSnoozesFor(
	actor: Actor,
	now: Date = new Date(),
): Promise<SnoozeRecord[]> {
	const all = await listActiveSnoozes(now);
	if (actor.mode === "solo") return all;
	const allowed: SnoozeRecord[] = [];
	for (const record of all) {
		if (await actorMayTouchSnooze(actor, record.kind, record.targetId)) allowed.push(record);
	}
	return allowed;
}
