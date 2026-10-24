/**
 * Shared fixtures for the watcher-modes tests: the AI runtime switched on, a
 * provider row, owned sessions, notification channels, and a capture of the
 * structured audit lines. Everything goes through Drizzle. Not a test file.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { llmProviders, notificationChannels, sessions, settings } from "../db/schema/index.js";
import { invalidateAiFlagsCache } from "../services/ai/feature.js";
import { credentialHint, encryptSecret } from "../services/ai/secrets.js";

export async function setSetting(key: string, value: unknown): Promise<void> {
	const now = new Date().toISOString();
	await getDb()
		.insert(settings)
		.values({ key, value, updatedAt: now })
		.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
	invalidateAiFlagsCache();
}

export async function clearSetting(key: string): Promise<void> {
	await getDb().delete(settings).where(eq(settings.key, key));
	invalidateAiFlagsCache();
}

/** `ai.enabled` on, kill switch off: the watcher routes' gate passes. */
export async function enableAiRuntime(): Promise<void> {
	await setSetting("ai.enabled", true);
	await clearSetting("ai.killSwitch");
}

export async function seedProvider(id = crypto.randomUUID()): Promise<string> {
	const now = new Date().toISOString();
	await getDb()
		.insert(llmProviders)
		.values({
			id,
			userId: "local",
			name: `provider-${id.slice(0, 6)}`,
			kind: "anthropic",
			model: "claude-sonnet-4-6",
			baseUrl: null,
			credentialCiphertext: encryptSecret("sk-test-key"),
			credentialHint: credentialHint("sk-test-key"),
			isDefault: false,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	return id;
}

export async function seedSession(
	sessionId: string,
	fields: { ownerUserId?: string | null; agentType?: "claude_code" | "codex_cli" } = {},
): Promise<void> {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: fields.agentType ?? "claude_code",
			status: "active",
			ownerUserId: fields.ownerUserId ?? null,
			lastActivityAt: new Date().toISOString(),
		})
		.onConflictDoNothing();
}

export async function seedChannel(input: {
	userId: string;
	verified?: boolean;
	active?: boolean;
}): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(notificationChannels)
		.values({
			id,
			userId: input.userId,
			kind: "telegram",
			label: `channel-${id.slice(0, 6)}`,
			config: { status: input.verified === false ? "pending_verification" : "active" },
			isActive: input.active ?? true,
			verifiedAt: input.verified === false ? null : now,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

/** Captures the structured JSON lines `logAdminAction` writes to console.log. */
export function captureAuditLines(): {
	lines(kind: string): Array<Record<string, unknown>>;
	restore(): void;
} {
	const original = console.log;
	const captured: Array<Record<string, unknown>> = [];
	console.log = (...args: unknown[]) => {
		const first = args[0];
		if (typeof first === "string" && first.startsWith("{")) {
			try {
				captured.push(JSON.parse(first) as Record<string, unknown>);
			} catch {
				// not a structured line
			}
		}
	};
	return {
		lines: (kind) => captured.filter((line) => line.kind === kind),
		restore: () => {
			console.log = original;
		},
	};
}
