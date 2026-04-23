import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../ai/secrets.js";

/**
 * Telegram bot credentials storage. The token + webhook secret used to
 * be env-var only (TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET), which
 * made setup a command-line chore. They now persist in the `settings`
 * table as a single encrypted JSON blob under key `telegram:credentials`,
 * with env vars kept as a bootstrap fallback for existing deployments.
 *
 * Precedence on read:
 *   1. DB row (if present)  — explicit user action via the UI
 *   2. Env vars             — legacy / CI / first-boot bootstrap
 *
 * The in-memory cache is warmed at startup and invalidated on every
 * save / clear so synchronous callers (adapter.isConfigured, webhook
 * secret verification) don't need to await a DB round-trip on every
 * request.
 */

const SETTINGS_KEY = "telegram:credentials";

export type TelegramDeliveryMode = "webhook" | "polling";

interface StoredCreds {
	botTokenCiphertext?: string;
	webhookSecretCiphertext?: string;
	deliveryMode?: TelegramDeliveryMode;
}

interface TelegramCredentials {
	botToken: string | null;
	webhookSecret: string | null;
	deliveryMode: TelegramDeliveryMode;
	source: "db" | "env" | "missing";
}

let cached: TelegramCredentials | null = null;

function readEnvCreds(): TelegramCredentials {
	const botToken = config.telegramBotToken || null;
	const webhookSecret = config.telegramWebhookSecret || null;
	// Env-configured deployments usually have a webhook already set up
	// (that's the only way they worked before this feature). Default to
	// webhook mode so behavior doesn't silently change under them.
	if (botToken || webhookSecret) {
		return { botToken, webhookSecret, deliveryMode: "webhook", source: "env" };
	}
	return { botToken: null, webhookSecret: null, deliveryMode: "polling", source: "missing" };
}

async function readDbCreds(): Promise<TelegramCredentials | null> {
	const [row] = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
	if (!row) return null;
	const stored = row.value as StoredCreds | null;
	if (!stored) return null;
	// If decryption throws (key rotated, corrupt ciphertext) we treat the
	// DB row as unusable and fall back to env — better to degrade than to
	// 500 every call.
	try {
		const botToken = stored.botTokenCiphertext ? decryptSecret(stored.botTokenCiphertext) : null;
		const webhookSecret = stored.webhookSecretCiphertext
			? decryptSecret(stored.webhookSecretCiphertext)
			: null;
		if (!botToken && !webhookSecret) return null;
		// New installs default to polling (works behind NAT, no public
		// URL required). Stored rows that pre-date this default keep
		// whatever they had explicitly set.
		const deliveryMode: TelegramDeliveryMode = stored.deliveryMode ?? "polling";
		return { botToken, webhookSecret, deliveryMode, source: "db" };
	} catch (err) {
		console.error("[telegram-credentials] decrypt failed; falling back to env:", err);
		return null;
	}
}

async function loadCreds(): Promise<TelegramCredentials> {
	const fromDb = await readDbCreds();
	if (fromDb) return fromDb;
	return readEnvCreds();
}

/**
 * Warm the in-memory cache. Called once at server startup so the
 * synchronous `getTelegramBotToken()` / `getTelegramWebhookSecret()`
 * accessors below have data ready before the first request lands.
 */
export async function initTelegramCredentials(): Promise<void> {
	cached = await loadCreds();
}

/**
 * Force a cache refresh from DB. Call after save/clear so readers
 * see the new values immediately.
 */
export async function refreshTelegramCredentials(): Promise<TelegramCredentials> {
	cached = await loadCreds();
	return cached;
}

/**
 * Cache-backed readers used everywhere that previously read from
 * `config.telegramBotToken` / `config.telegramWebhookSecret`. Return
 * empty string (not null) to keep the existing truthy-check call
 * sites working without modification.
 */
export function getTelegramBotToken(): string {
	if (!cached) cached = readEnvCreds();
	return cached.botToken ?? "";
}

export function getTelegramWebhookSecret(): string {
	if (!cached) cached = readEnvCreds();
	return cached.webhookSecret ?? "";
}

export function getTelegramCredentialsSource(): "db" | "env" | "missing" {
	if (!cached) cached = readEnvCreds();
	return cached.source;
}

export function getTelegramDeliveryMode(): TelegramDeliveryMode {
	if (!cached) cached = readEnvCreds();
	return cached.deliveryMode;
}

/**
 * Four-char suffix hint for UI display. Never leaks the full token
 * back to the client — the raw value is write-once at save time.
 */
export function getTelegramBotTokenHint(): string | null {
	if (!cached) cached = readEnvCreds();
	const t = cached.botToken;
	if (!t) return null;
	return t.length <= 4 ? "*".repeat(t.length) : `…${t.slice(-4)}`;
}

export interface SaveTelegramCredentialsInput {
	botToken?: string | null;
	webhookSecret?: string | null;
	deliveryMode?: TelegramDeliveryMode;
}

/**
 * Upsert the encrypted credentials row. Pass `null` for a field to
 * preserve whatever is already stored for that field; pass a string
 * to overwrite it. Empty string clears the field.
 */
export async function saveTelegramCredentials(
	input: SaveTelegramCredentialsInput,
): Promise<TelegramCredentials> {
	const [existingRow] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, SETTINGS_KEY))
		.limit(1);
	const existing = (existingRow?.value as StoredCreds | null) ?? {};
	const next: StoredCreds = {
		botTokenCiphertext:
			input.botToken === undefined || input.botToken === null
				? existing.botTokenCiphertext
				: input.botToken.length > 0
					? encryptSecret(input.botToken)
					: undefined,
		webhookSecretCiphertext:
			input.webhookSecret === undefined || input.webhookSecret === null
				? existing.webhookSecretCiphertext
				: input.webhookSecret.length > 0
					? encryptSecret(input.webhookSecret)
					: undefined,
		deliveryMode: input.deliveryMode ?? existing.deliveryMode,
	};

	const now = new Date().toISOString();
	if (existingRow) {
		await db
			.update(settings)
			.set({ value: next, updatedAt: now })
			.where(eq(settings.key, SETTINGS_KEY));
	} else {
		await db.insert(settings).values({ key: SETTINGS_KEY, value: next, updatedAt: now });
	}
	return refreshTelegramCredentials();
}

/**
 * Remove both the token and webhook secret from the DB. After this,
 * reads fall back to env vars (if set) or report "missing".
 */
export async function clearTelegramCredentials(): Promise<TelegramCredentials> {
	await db.delete(settings).where(eq(settings.key, SETTINGS_KEY));
	return refreshTelegramCredentials();
}

/**
 * Generate a cryptographically random webhook secret of the length
 * Telegram recommends (24–256 chars). Hex keeps it URL/header-safe.
 */
export function generateWebhookSecret(): string {
	return randomBytes(32).toString("hex");
}
