import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { aiHitlRequests, notificationChannels, watcherConfigs } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../ai/secrets.js";
import type { NotificationChannelKind, NotificationChannelRecord } from "./types.js";

/**
 * CRUD + enrollment flow for notification channels. Adapter-specific
 * behavior (Telegram Bot API calls, webhook signature verification,
 * etc.) lives in each adapter module; this service just manages rows.
 */

function toRecord(row: typeof notificationChannels.$inferSelect): NotificationChannelRecord {
	return {
		id: row.id,
		userId: row.userId,
		kind: row.kind as NotificationChannelKind,
		label: row.label,
		config: row.config ?? null,
		isActive: row.isActive,
		verifiedAt: row.verifiedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export interface StoredTelegramCredential {
	chatId: string;
}

/**
 * Create a pending-verification channel. Returns the channel row plus
 * a one-time enrollment code the user passes to the bot (e.g., via
 * `/start <code>` DM) to complete linkage.
 */
export async function createPendingChannel(input: {
	kind: NotificationChannelKind;
	label: string;
	userId?: string;
}): Promise<{ channel: NotificationChannelRecord; enrollmentCode: string }> {
	const enrollmentCode = generateEnrollmentCode();
	const now = new Date().toISOString();
	const [row] = await db
		.insert(notificationChannels)
		.values({
			userId: input.userId ?? "local",
			kind: input.kind,
			label: input.label,
			credentialCiphertext: null,
			config: { enrollmentCode, status: "pending_verification" },
			isActive: true,
			verifiedAt: null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return { channel: toRecord(row), enrollmentCode };
}

function generateEnrollmentCode(): string {
	// 8 chars of hex = 32 bits. Unlikely collision at the scale we're
	// operating at, short enough for a Telegram DM, not guessable.
	return randomBytes(4).toString("hex");
}

export async function listChannels(userId = "local"): Promise<NotificationChannelRecord[]> {
	const rows = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.userId, userId))
		.orderBy(desc(notificationChannels.createdAt));
	return rows.map(toRecord);
}

export async function getChannel(id: string): Promise<NotificationChannelRecord | null> {
	const [row] = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	return row ? toRecord(row) : null;
}

/**
 * Decrypt and return the stored credential (e.g., Telegram chat id).
 * Returns null for un-verified or un-credentialed channels.
 */
export async function getChannelCredential(id: string): Promise<StoredTelegramCredential | null> {
	const [row] = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	if (!row || !row.credentialCiphertext) return null;
	try {
		return JSON.parse(decryptSecret(row.credentialCiphertext)) as StoredTelegramCredential;
	} catch {
		return null;
	}
}

/**
 * Find a pending channel by enrollment code (for Telegram `/start <code>`
 * flow). Returns null if the code is unknown or already consumed.
 */
export async function findPendingByEnrollmentCode(
	code: string,
): Promise<NotificationChannelRecord | null> {
	const rows = await db
		.select()
		.from(notificationChannels)
		.where(isNull(notificationChannels.verifiedAt));
	const row = rows.find(
		(r) =>
			r.config !== null &&
			typeof r.config === "object" &&
			(r.config as Record<string, unknown>).enrollmentCode === code,
	);
	return row ? toRecord(row) : null;
}

/**
 * Mark a channel as verified, store the encrypted chat id, clear the
 * enrollment code from config. Idempotent.
 */
export async function completeEnrollment(input: {
	channelId: string;
	chatId: string;
}): Promise<NotificationChannelRecord | null> {
	const now = new Date().toISOString();
	const credentialCiphertext = encryptSecret(JSON.stringify({ chatId: input.chatId }));
	const [existing] = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, input.channelId))
		.limit(1);
	if (!existing) return null;
	const config = {
		...(existing.config ?? {}),
		status: "verified",
	} as Record<string, unknown>;
	// Strip the enrollment code — single-use.
	config.enrollmentCode = undefined;
	await db
		.update(notificationChannels)
		.set({
			credentialCiphertext,
			config,
			verifiedAt: now,
			updatedAt: now,
		})
		.where(eq(notificationChannels.id, input.channelId));
	return getChannel(input.channelId);
}

/**
 * Merge a partial config update into the channel row without touching
 * anything else. Used to flip per-channel toggles like `askEnabled`
 * without rewriting the credential or label.
 */
export async function updateChannelConfig(
	id: string,
	patch: Record<string, unknown>,
): Promise<NotificationChannelRecord | null> {
	const [existing] = await db
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	if (!existing) return null;
	const merged = { ...(existing.config ?? {}), ...patch };
	await db
		.update(notificationChannels)
		.set({ config: merged, updatedAt: new Date().toISOString() })
		.where(eq(notificationChannels.id, id));
	return getChannel(id);
}

export async function deactivateChannel(id: string): Promise<boolean> {
	const now = new Date().toISOString();
	const rows = await db
		.update(notificationChannels)
		.set({ isActive: false, updatedAt: now })
		.where(eq(notificationChannels.id, id))
		.returning();
	return rows.length > 0;
}

export async function deleteChannel(id: string): Promise<boolean> {
	const rows = await db
		.delete(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.returning();
	return rows.length > 0;
}

/**
 * Look up a verified, active channel by its decrypted chat id. Used
 * by the Telegram webhook handler to route inbound callback_query
 * updates back to the right channel row without trusting client input.
 */
export interface ChannelStats {
	assignedSessionCount: number;
	hitlTotal: number;
	hitlOpen: number;
	hitlResolved: number;
	lastHitlAt: string | null;
}

/**
 * Aggregate usage stats for a channel. Used by the Settings UI to
 * tell the operator how many sessions route through this channel,
 * how many HITL requests have flowed, and when the last one landed.
 */
export async function getChannelStats(channelId: string): Promise<ChannelStats> {
	const [assigned] = await db
		.select({ count: sql<number>`count(*)` })
		.from(watcherConfigs)
		.where(eq(watcherConfigs.channelId, channelId));

	const hitlRows = await db
		.select({
			status: aiHitlRequests.status,
			createdAt: aiHitlRequests.createdAt,
		})
		.from(aiHitlRequests)
		.where(eq(aiHitlRequests.channelId, channelId))
		.orderBy(desc(aiHitlRequests.createdAt));

	const hitlTotal = hitlRows.length;
	const hitlOpen = hitlRows.filter((r) => r.status === "awaiting_reply").length;
	const hitlResolved = hitlRows.filter(
		(r) => r.status === "applied" || r.status === "declined",
	).length;
	const lastHitlAt = hitlRows[0]?.createdAt ?? null;

	return {
		assignedSessionCount: Number(assigned?.count ?? 0),
		hitlTotal,
		hitlOpen,
		hitlResolved,
		lastHitlAt,
	};
}

export async function findActiveChannelByChatId(
	chatId: string,
): Promise<NotificationChannelRecord | null> {
	const rows = await db
		.select()
		.from(notificationChannels)
		.where(and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.isActive, true)));
	for (const row of rows) {
		if (!row.credentialCiphertext || !row.verifiedAt) continue;
		try {
			const cred = JSON.parse(decryptSecret(row.credentialCiphertext)) as StoredTelegramCredential;
			if (cred.chatId === chatId) return toRecord(row);
		} catch {
			// Skip rows we can't decrypt (key rotated, etc.)
		}
	}
	return null;
}
