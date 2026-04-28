import { eq } from "drizzle-orm";
import type { WatcherPolicy } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { watcherConfigs } from "../../db/schema.js";

// Canonical const + type live in src/shared/types.ts so the dashboard
// and server agree on the policy list. Re-exported for legacy imports.
export type { WatcherPolicy };

export interface WatcherConfigRecord {
	sessionId: string;
	enabled: boolean;
	providerId: string;
	policy: WatcherPolicy;
	channelId: string | null;
	maxContinuations: number;
	continuationsUsed: number;
	maxDailyCents: number | null;
	systemPrompt: string | null;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof watcherConfigs.$inferSelect): WatcherConfigRecord {
	return {
		sessionId: row.sessionId,
		enabled: row.enabled,
		providerId: row.providerId,
		policy: row.policy as WatcherPolicy,
		channelId: row.channelId,
		maxContinuations: row.maxContinuations,
		continuationsUsed: row.continuationsUsed,
		maxDailyCents: row.maxDailyCents,
		systemPrompt: row.systemPrompt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function getWatcherConfig(sessionId: string): Promise<WatcherConfigRecord | null> {
	const [row] = await db
		.select()
		.from(watcherConfigs)
		.where(eq(watcherConfigs.sessionId, sessionId))
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function listEnabledWatcherSessionIds(): Promise<string[]> {
	const rows = await db
		.select({ sessionId: watcherConfigs.sessionId })
		.from(watcherConfigs)
		.where(eq(watcherConfigs.enabled, true));
	return rows.map((r) => r.sessionId);
}

export interface UpsertWatcherConfigInput {
	sessionId: string;
	enabled?: boolean;
	providerId?: string;
	policy?: WatcherPolicy;
	channelId?: string | null;
	maxContinuations?: number;
	maxDailyCents?: number | null;
	systemPrompt?: string | null;
}

export async function upsertWatcherConfig(
	input: UpsertWatcherConfigInput,
): Promise<WatcherConfigRecord> {
	const now = new Date().toISOString();
	const existing = await getWatcherConfig(input.sessionId);

	// Per plan: continuationsUsed resets when enabled flips false -> true.
	const shouldResetCounter = existing && !existing.enabled && input.enabled === true;
	const continuationsUsed = shouldResetCounter ? 0 : (existing?.continuationsUsed ?? 0);

	if (!existing) {
		if (!input.providerId) {
			throw new Error("providerId is required when creating a watcher config");
		}
		const [row] = await db
			.insert(watcherConfigs)
			.values({
				sessionId: input.sessionId,
				enabled: input.enabled ?? false,
				providerId: input.providerId,
				policy: input.policy ?? "ask_always",
				channelId: input.channelId ?? null,
				maxContinuations: input.maxContinuations ?? 10,
				continuationsUsed,
				maxDailyCents: input.maxDailyCents ?? null,
				systemPrompt: input.systemPrompt ?? null,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return toRecord(row);
	}

	const updates: Partial<typeof watcherConfigs.$inferInsert> = {
		updatedAt: now,
		continuationsUsed,
	};
	if (input.enabled !== undefined) updates.enabled = input.enabled;
	if (input.providerId !== undefined) updates.providerId = input.providerId;
	if (input.policy !== undefined) updates.policy = input.policy;
	if (input.channelId !== undefined) updates.channelId = input.channelId;
	if (input.maxContinuations !== undefined) updates.maxContinuations = input.maxContinuations;
	if (input.maxDailyCents !== undefined) updates.maxDailyCents = input.maxDailyCents;
	if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;

	await db.update(watcherConfigs).set(updates).where(eq(watcherConfigs.sessionId, input.sessionId));
	const result = await getWatcherConfig(input.sessionId);
	if (!result) throw new Error("Watcher config disappeared during update");
	return result;
}

export async function incrementContinuations(sessionId: string): Promise<number> {
	const existing = await getWatcherConfig(sessionId);
	if (!existing) return 0;
	const next = existing.continuationsUsed + 1;
	await db
		.update(watcherConfigs)
		.set({ continuationsUsed: next, updatedAt: new Date().toISOString() })
		.where(eq(watcherConfigs.sessionId, sessionId));
	return next;
}

export async function deleteWatcherConfig(sessionId: string): Promise<boolean> {
	const res = await db
		.delete(watcherConfigs)
		.where(eq(watcherConfigs.sessionId, sessionId))
		.returning();
	return res.length > 0;
}
