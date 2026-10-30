import { eq, sql } from "drizzle-orm";
import type { WatcherPolicy } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { watcherConfigs } from "../../db/schema/index.js";
import { getWatcherDefaults } from "./feature.js";
import { invalidateWatchedSessions, loadWatchedSessionIds } from "./watched-sessions.js";

// Canonical const + type live in src/shared/types.ts so the dashboard
// and server agree on the policy list. Re-exported for legacy imports.
export type { WatcherPolicy };

export interface WatcherConfigRecord {
	sessionId: string;
	enabled: boolean;
	notifyEnabled: boolean;
	continueEnabled: boolean;
	providerId: string;
	policy: WatcherPolicy;
	channelId: string | null;
	maxContinuations: number;
	continuationsUsed: number;
	maxDailyCents: number | null;
	systemPrompt: string | null;
	/** Set only by a human confirming `auto`; auto is honoured only while this is set. */
	autoConfirmedAt: string | null;
	autoConfirmedBy: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof watcherConfigs.$inferSelect): WatcherConfigRecord {
	return {
		sessionId: row.sessionId,
		enabled: row.enabled,
		notifyEnabled: row.notifyEnabled,
		continueEnabled: row.continueEnabled,
		providerId: row.providerId,
		policy: row.policy as WatcherPolicy,
		channelId: row.channelId,
		maxContinuations: row.maxContinuations,
		continuationsUsed: row.continuationsUsed,
		maxDailyCents: row.maxDailyCents,
		systemPrompt: row.systemPrompt,
		autoConfirmedAt: row.autoConfirmedAt,
		autoConfirmedBy: row.autoConfirmedBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function getWatcherConfig(sessionId: string): Promise<WatcherConfigRecord | null> {
	const [row] = await getDb()
		.select()
		.from(watcherConfigs)
		.where(eq(watcherConfigs.sessionId, sessionId))
		.limit(1);
	return row ? toRecord(row) : null;
}

/** Sessions that are enabled with at least one mode on (an uncached read). */
export async function listWatchedSessionIds(): Promise<string[]> {
	return [...(await loadWatchedSessionIds())];
}

export interface UpsertWatcherConfigInput {
	sessionId: string;
	enabled?: boolean;
	notifyEnabled?: boolean;
	continueEnabled?: boolean;
	providerId?: string;
	policy?: WatcherPolicy;
	channelId?: string | null;
	maxContinuations?: number;
	maxDailyCents?: number | null;
	systemPrompt?: string | null;
	/**
	 * Who confirmed `auto`: the human's user id, or "local" under DISABLE_AUTH.
	 * Required with `policy: "auto"` so no other caller can confirm it.
	 */
	autoConfirmedBy?: string;
	/** Zero the automatic-send counter. The only way it is ever written after create. */
	resetContinuations?: boolean;
}

/**
 * Create or update a watcher config. Only the fields that are sent change.
 *
 * `continuations_used` is written only on create (0) and by an explicit
 * `resetContinuations`; a toggle or any other update never touches it, so a
 * concurrent increment can't be lost and re-enabling no longer clears the cap.
 *
 * `auto` needs a human confirmation: setting that policy stamps
 * auto_confirmed_at/by, setting any other policy clears them, and so does an
 * update that changes the system prompt, the provider or the continuation
 * limit (the confirmation covered the old configuration, not the new one).
 */
export async function upsertWatcherConfig(
	input: UpsertWatcherConfigInput,
): Promise<WatcherConfigRecord> {
	const now = new Date().toISOString();
	const existing = await getWatcherConfig(input.sessionId);

	if (input.policy === "auto" && !input.autoConfirmedBy) {
		throw new Error("policy 'auto' needs autoConfirmedBy: only a human confirms it");
	}

	if (!existing) {
		if (!input.providerId) {
			throw new Error("providerId is required when creating a watcher config");
		}
		const defaults = await getWatcherDefaults();
		const confirmed = input.policy === "auto";
		const [row] = await getDb()
			.insert(watcherConfigs)
			.values({
				sessionId: input.sessionId,
				enabled: input.enabled ?? false,
				notifyEnabled: input.notifyEnabled ?? defaults.notify,
				continueEnabled: input.continueEnabled ?? defaults.continue,
				providerId: input.providerId,
				policy: input.policy ?? "ask_always",
				channelId: input.channelId ?? null,
				maxContinuations: input.maxContinuations ?? 10,
				continuationsUsed: 0,
				maxDailyCents: input.maxDailyCents ?? null,
				systemPrompt: input.systemPrompt ?? null,
				autoConfirmedAt: confirmed ? now : null,
				autoConfirmedBy: confirmed ? (input.autoConfirmedBy ?? null) : null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		invalidateWatchedSessions();
		return toRecord(row);
	}

	const updates: Partial<typeof watcherConfigs.$inferInsert> = { updatedAt: now };
	if (input.enabled !== undefined) updates.enabled = input.enabled;
	if (input.notifyEnabled !== undefined) updates.notifyEnabled = input.notifyEnabled;
	if (input.continueEnabled !== undefined) updates.continueEnabled = input.continueEnabled;
	if (input.providerId !== undefined) updates.providerId = input.providerId;
	if (input.policy !== undefined) updates.policy = input.policy;
	if (input.channelId !== undefined) updates.channelId = input.channelId;
	if (input.maxContinuations !== undefined) updates.maxContinuations = input.maxContinuations;
	if (input.maxDailyCents !== undefined) updates.maxDailyCents = input.maxDailyCents;
	if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
	if (input.resetContinuations === true) updates.continuationsUsed = 0;

	if (input.policy === "auto") {
		updates.autoConfirmedAt = now;
		updates.autoConfirmedBy = input.autoConfirmedBy ?? null;
	} else if (input.policy !== undefined || confirmationLapses(existing, input)) {
		updates.autoConfirmedAt = null;
		updates.autoConfirmedBy = null;
	}

	await getDb()
		.update(watcherConfigs)
		.set(updates)
		.where(eq(watcherConfigs.sessionId, input.sessionId));
	invalidateWatchedSessions();
	const result = await getWatcherConfig(input.sessionId);
	if (!result) throw new Error("Watcher config disappeared during update");
	return result;
}

/** Does this update change what a human confirmed `auto` for? */
function confirmationLapses(
	existing: WatcherConfigRecord,
	input: UpsertWatcherConfigInput,
): boolean {
	if (existing.autoConfirmedAt === null) return false;
	return (
		(input.systemPrompt !== undefined && input.systemPrompt !== existing.systemPrompt) ||
		(input.providerId !== undefined && input.providerId !== existing.providerId) ||
		(input.maxContinuations !== undefined && input.maxContinuations !== existing.maxContinuations)
	);
}

/**
 * Count one automatic send, atomically, and return the new total (0 when the
 * config is gone). Takes the transaction handle a dispatch runs on.
 */
export async function incrementContinuations(
	sessionId: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any = getDb(),
): Promise<number> {
	const rows = (await tx
		.update(watcherConfigs)
		.set({
			continuationsUsed: sql`${watcherConfigs.continuationsUsed} + 1`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(watcherConfigs.sessionId, sessionId))
		.returning({ used: watcherConfigs.continuationsUsed })) as Array<{ used: number }>;
	return rows[0]?.used ?? 0;
}

export async function deleteWatcherConfig(sessionId: string): Promise<boolean> {
	const res = await getDb()
		.delete(watcherConfigs)
		.where(eq(watcherConfigs.sessionId, sessionId))
		.returning();
	invalidateWatchedSessions();
	return res.length > 0;
}
