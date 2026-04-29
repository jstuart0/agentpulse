import { and, desc, eq, gt } from "drizzle-orm";
import type { InboxWorkItem } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { aiInboxSnoozes } from "../../db/schema.js";

/**
 * Operator-inbox snooze. A snooze is an (kind, targetId, until) tuple
 * that tells buildInbox to hide the matching item until the deadline
 * passes. Snoozes are stored, survive restart, and auto-expire.
 *
 * Safe to expose as a one-click UI action per the Phase 3 plan: snooze
 * is reversible, idempotent, and non-destructive.
 */

// Snooze applies only to session-scoped inbox items — the four listed
// here. The Extract narrows InboxWorkItem["kind"] so removing or
// renaming any of these four kinds in shared/types.ts immediately
// breaks the snooze service at compile time.
export type InboxKind = Extract<
	InboxWorkItem["kind"],
	"hitl" | "stuck" | "risky" | "failed_proposal"
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
	const [existing] = await db
		.select()
		.from(aiInboxSnoozes)
		.where(and(eq(aiInboxSnoozes.kind, input.kind), eq(aiInboxSnoozes.targetId, input.targetId)))
		.limit(1);

	if (existing) {
		const newUntil = existing.snoozedUntil > untilIso ? existing.snoozedUntil : untilIso;
		const [row] = await db
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

	const [row] = await db
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
	const rows = await db.delete(aiInboxSnoozes).where(eq(aiInboxSnoozes.id, id)).returning();
	return rows.length > 0;
}

export async function unsnoozeTarget(kind: InboxKind, targetId: string): Promise<boolean> {
	const rows = await db
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
	const rows = await db
		.select()
		.from(aiInboxSnoozes)
		.where(gt(aiInboxSnoozes.snoozedUntil, now.toISOString()))
		.orderBy(desc(aiInboxSnoozes.snoozedUntil));
	return rows.map(toRecord);
}

export function activeSnoozeSet(records: SnoozeRecord[]): Set<string> {
	return new Set(records.map((r) => `${r.kind}:${r.targetId}`));
}
