// Phase 4 audit: src/server/services/channels/ is clean — no raw getSqlite()
// calls, no json_extract, no datetime('now') literals outside Drizzle's sql``
// tag. All queries use Drizzle ORM expressions with bound parameters.
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "../../auth/actor.js";
import { getDb } from "../../db/client.js";
import { aiHitlRequests, notificationChannels, watcherConfigs } from "../../db/schema/index.js";
import { decryptSecret, encryptSecret } from "../ai/secrets.js";
import { getMode } from "../instance-mode.js";
import type { NotificationChannelKind, NotificationChannelRecord } from "./types.js";

/**
 * CRUD + enrollment flow for notification channels. Adapter-specific
 * behavior (Telegram Bot API calls, webhook signature verification,
 * etc.) lives in each adapter module; this service just manages rows.
 */

/** Config keys that carry the enrollment secret: shown once, at create and re-link, never again. */
const ENROLLMENT_CONFIG_KEYS = ["enrollmentCode", "enrollmentCodeIssuedAt"] as const;

function publicConfig(config: Record<string, unknown> | null): Record<string, unknown> | null {
	if (config === null || typeof config !== "object") return null;
	const copy = { ...config };
	for (const key of ENROLLMENT_CONFIG_KEYS) delete copy[key];
	return copy;
}

function toRecord(row: typeof notificationChannels.$inferSelect): NotificationChannelRecord {
	return {
		id: row.id,
		userId: row.userId,
		kind: row.kind as NotificationChannelKind,
		label: row.label,
		config: publicConfig(row.config ?? null),
		isActive: row.isActive,
		verifiedAt: row.verifiedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** What is stored (encrypted) for a verified Telegram channel. */
export interface StoredTelegramCredential {
	chatId: string;
	/** The Telegram user who enrolled it. Absent on channels enrolled before it was recorded. */
	fromUserId?: string;
}

/** A channel's chat and the one Telegram user allowed to act through it (null when unknown). */
export interface TelegramCredential {
	chatId: string;
	fromUserId: string | null;
}

/** How long an enrollment code stays redeemable. */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

function isPositiveIntString(value: string): boolean {
	return /^[1-9][0-9]*$/.test(value);
}

/**
 * A fresh enrollment code, and the config that makes a channel pending with it.
 * 96 bits, so a code can't be guessed within its 15-minute life.
 */
function newEnrollment(): { enrollmentCode: string; config: Record<string, unknown> } {
	const enrollmentCode = generateEnrollmentCode();
	return {
		enrollmentCode,
		config: {
			enrollmentCode,
			enrollmentCodeIssuedAt: new Date().toISOString(),
			status: "pending_verification",
		},
	};
}

/**
 * Create a pending-verification channel. Returns the channel row plus
 * a one-time enrollment code the user passes to the bot (e.g., via
 * `/start <code>` DM) to complete linkage. `userId` is who owns the channel;
 * "local" (the default) is the single operator in solo mode and belongs to
 * nobody in team mode.
 */
export async function createPendingChannel(input: {
	kind: NotificationChannelKind;
	label: string;
	userId?: string;
}): Promise<{ channel: NotificationChannelRecord; enrollmentCode: string }> {
	const { enrollmentCode, config } = newEnrollment();
	const now = new Date().toISOString();
	const [row] = await getDb()
		.insert(notificationChannels)
		.values({
			userId: input.userId ?? "local",
			kind: input.kind,
			label: input.label,
			credentialCiphertext: null,
			config,
			isActive: true,
			verifiedAt: null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return { channel: toRecord(row), enrollmentCode };
}

function generateEnrollmentCode(): string {
	// 12 random bytes = 96 bits, base64url = 16 characters (well inside
	// Telegram's 64-character /start limit).
	return randomBytes(12).toString("base64url");
}

/**
 * The channels this actor may see. Solo: every channel. Team: an admin sees
 * every channel and a member only their own (a channel owned by "local"
 * belongs to nobody, so only an admin sees it).
 */
export async function listChannels(actor: Actor): Promise<NotificationChannelRecord[]> {
	const mode = actor.mode ?? (await getMode());
	const base = getDb().select().from(notificationChannels);
	const rows =
		mode === "solo" || actor.role === "admin"
			? await base.orderBy(desc(notificationChannels.createdAt))
			: actor.userId === null || actor.role === "none"
				? []
				: await base
						.where(eq(notificationChannels.userId, actor.userId))
						.orderBy(desc(notificationChannels.createdAt));
	return rows.map(toRecord);
}

export async function getChannel(id: string): Promise<NotificationChannelRecord | null> {
	const [row] = await getDb()
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	return row ? toRecord(row) : null;
}

/**
 * Decrypt and return the stored credential (the chat id and the enrolled
 * Telegram user). Returns null for un-verified or un-credentialed channels.
 *
 * A channel enrolled before the user was recorded has no `fromUserId`. A
 * private chat's id is the user's id (positive), so for those it is derived
 * from the chat id; a group's id is negative, so a legacy group channel has
 * no known user and every inbound update from it is refused until it is
 * re-linked from a private chat.
 */
export async function getChannelCredential(id: string): Promise<TelegramCredential | null> {
	const [row] = await getDb()
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	if (!row || !row.credentialCiphertext) return null;
	try {
		return parseCredential(row.credentialCiphertext);
	} catch {
		return null;
	}
}

function parseCredential(ciphertext: string): TelegramCredential {
	const stored = JSON.parse(decryptSecret(ciphertext)) as StoredTelegramCredential;
	const chatId = String(stored.chatId);
	const fromUserId =
		typeof stored.fromUserId === "string" && stored.fromUserId !== ""
			? stored.fromUserId
			: isPositiveIntString(chatId)
				? chatId
				: null;
	return { chatId, fromUserId };
}

/**
 * Find a pending channel by enrollment code (for Telegram `/start <code>`
 * flow). Returns null if the code is unknown, already consumed, or older than
 * its 15-minute life.
 */
export async function findPendingByEnrollmentCode(
	code: string,
): Promise<NotificationChannelRecord | null> {
	const rows = await getDb()
		.select()
		.from(notificationChannels)
		.where(isNull(notificationChannels.verifiedAt));
	const row = rows.find((r) => {
		if (r.config === null || typeof r.config !== "object") return false;
		const config = r.config as Record<string, unknown>;
		return config.enrollmentCode === code && enrollmentCodeIsFresh(config.enrollmentCodeIssuedAt);
	});
	return row ? toRecord(row) : null;
}

function enrollmentCodeIsFresh(issuedAt: unknown): boolean {
	if (typeof issuedAt !== "string") return false;
	const issued = Date.parse(issuedAt);
	return Number.isFinite(issued) && Date.now() - issued <= ENROLLMENT_CODE_TTL_MS;
}

/**
 * Bind a pending channel to the chat and Telegram user that redeemed its
 * code. Only a channel that is pending right now binds: the row must still
 * hold this code, and the update itself is conditional on `verified_at IS
 * NULL`, so a replayed `/start` (or two racing ones) can never re-bind a
 * verified channel. Returns the channel, or null when nothing was bound.
 */
export async function completeEnrollment(input: {
	channelId: string;
	chatId: string;
	fromUserId: string;
	code: string;
}): Promise<NotificationChannelRecord | null> {
	const [existing] = await getDb()
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, input.channelId))
		.limit(1);
	if (!existing || existing.verifiedAt !== null) return null;
	const stored = (existing.config ?? {}) as Record<string, unknown>;
	if (
		stored.enrollmentCode !== input.code ||
		!enrollmentCodeIsFresh(stored.enrollmentCodeIssuedAt)
	) {
		return null;
	}

	const now = new Date().toISOString();
	const credential: StoredTelegramCredential = {
		chatId: input.chatId,
		fromUserId: input.fromUserId,
	};
	// The code is single-use and the issue time goes with it.
	const { enrollmentCode: _code, enrollmentCodeIssuedAt: _issued, ...rest } = stored;
	const config: Record<string, unknown> = { ...rest, status: "verified" };
	const bound = await getDb()
		.update(notificationChannels)
		.set({
			credentialCiphertext: encryptSecret(JSON.stringify(credential)),
			config,
			verifiedAt: now,
			updatedAt: now,
		})
		.where(
			and(eq(notificationChannels.id, input.channelId), isNull(notificationChannels.verifiedAt)),
		)
		.returning({ id: notificationChannels.id });
	if (bound.length === 0) return null;
	return getChannel(input.channelId);
}

/**
 * Put a channel back to pending with a fresh code: the stored credential is
 * cleared (so the old chat and user lose every inbound right at once), the
 * channel id stays (watcher configs and HITLs keep pointing at it). With
 * `claimForUserId` a channel owned by "local" is stamped with that user. The
 * code is returned for the caller to show once.
 */
export async function relinkChannel(
	id: string,
	options: { claimForUserId?: string } = {},
): Promise<{ channel: NotificationChannelRecord; enrollmentCode: string } | null> {
	const [existing] = await getDb()
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	if (!existing) return null;
	const { enrollmentCode, config: enrollmentConfig } = newEnrollment();
	const kept = { ...(existing.config ?? {}) } as Record<string, unknown>;
	const config = { ...kept, ...enrollmentConfig };
	const claim =
		existing.userId === "local" && options.claimForUserId ? { userId: options.claimForUserId } : {};
	await getDb()
		.update(notificationChannels)
		.set({
			credentialCiphertext: null,
			verifiedAt: null,
			config,
			updatedAt: new Date().toISOString(),
			...claim,
		})
		.where(eq(notificationChannels.id, id));
	const channel = await getChannel(id);
	if (!channel) return null;
	return { channel, enrollmentCode };
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
	const [existing] = await getDb()
		.select()
		.from(notificationChannels)
		.where(eq(notificationChannels.id, id))
		.limit(1);
	if (!existing) return null;
	const merged = { ...(existing.config ?? {}), ...patch };
	await getDb()
		.update(notificationChannels)
		.set({ config: merged, updatedAt: new Date().toISOString() })
		.where(eq(notificationChannels.id, id));
	return getChannel(id);
}

export async function deactivateChannel(id: string): Promise<boolean> {
	const now = new Date().toISOString();
	const rows = await getDb()
		.update(notificationChannels)
		.set({ isActive: false, updatedAt: now })
		.where(eq(notificationChannels.id, id))
		.returning();
	return rows.length > 0;
}

export async function deleteChannel(id: string): Promise<boolean> {
	const rows = await getDb()
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
	const [assigned] = await getDb()
		.select({ count: sql<number>`count(*)` })
		.from(watcherConfigs)
		.where(eq(watcherConfigs.channelId, channelId));

	const hitlRows = await getDb()
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
	const rows = await getDb()
		.select()
		.from(notificationChannels)
		.where(and(eq(notificationChannels.kind, "telegram"), eq(notificationChannels.isActive, true)));
	for (const row of rows) {
		if (!row.credentialCiphertext || !row.verifiedAt) continue;
		try {
			if (parseCredential(row.credentialCiphertext).chatId === chatId) return toRecord(row);
		} catch {
			// Skip rows we can't decrypt (key rotated, etc.)
		}
	}
	return null;
}

export type RelinkReason = "group_chat" | "unowned_channel";

/**
 * Why a verified channel can't be used from Telegram until it is re-linked, or
 * null when it can. A group-enrolled channel has no known user to bind; in
 * team mode a channel owned by "local" belongs to nobody.
 */
export async function relinkReason(
	channel: NotificationChannelRecord,
	mode: "solo" | "team",
): Promise<RelinkReason | null> {
	if (!channel.verifiedAt) return null;
	const credential = await getChannelCredential(channel.id);
	if (credential && credential.fromUserId === null) return "group_chat";
	if (mode === "team" && channel.userId === "local") return "unowned_channel";
	return null;
}
