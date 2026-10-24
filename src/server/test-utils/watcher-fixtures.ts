/**
 * Shared fixtures for the watcher-modes tests: the AI runtime switched on, a
 * provider row, owned sessions, notification channels, and a capture of the
 * structured audit lines. Everything goes through Drizzle. Not a test file.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
	events,
	aiHitlRequests,
	llmProviders,
	notificationChannels,
	sessions,
	settings,
	watcherConfigs,
	watcherProposals,
} from "../db/schema/index.js";
import { invalidateAiFlagsCache } from "../services/ai/feature.js";
import { credentialHint, encryptSecret } from "../services/ai/secrets.js";
import { seedManagedSession, seedSupervisor } from "./supervisor-fixture.js";

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

// ── events, managed sessions, proposals and HITLs ────────────────────────────

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** One row on a session's timeline, written straight to the table so a test controls its id and time. */
export async function seedEvent(
	sessionId: string,
	input: {
		eventType: string;
		category?: string | null;
		content?: string | null;
		rawPayload?: Record<string, unknown>;
		toolName?: string | null;
		createdAt?: string;
	},
): Promise<number> {
	const [row] = await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType: input.eventType,
			category: input.category ?? null,
			source: "observed_hook",
			content: input.content ?? null,
			toolName: input.toolName ?? null,
			rawPayload: input.rawPayload ?? {},
			...(input.createdAt ? { createdAt: input.createdAt } : {}),
		})
		.returning({ id: events.id });
	if (!row) throw new Error("event did not insert");
	return row.id;
}

/** A managed session (launched by AgentPulse) with a connected supervisor. */
export async function seedLiveManagedSession(
	sessionId: string,
	options: { supervisor?: "live" | "offline"; managedState?: string; ownerUserId?: string } = {},
): Promise<{ supervisorId: string }> {
	const supervisorId = `sup-${sessionId}`;
	await seedSupervisor(supervisorId, {
		leaseOffsetMs: options.supervisor === "offline" ? -60_000 : 60_000,
		leaseBaseMs: Date.now(),
	});
	await seedManagedSession({
		sessionId,
		supervisorId,
		managedState: options.managedState ?? "managed",
	});
	if (options.ownerUserId) {
		await getDb()
			.update(sessions)
			.set({ ownerUserId: options.ownerUserId })
			.where(eq(sessions.sessionId, sessionId));
	}
	return { supervisorId };
}

/** A prompt-turn on a session: a user prompt, then a Stop. Returns both event ids and the turn key a Claude Stop gets. */
export async function seedFinishedTurn(sessionId: string): Promise<{
	promptId: number;
	stopId: number;
	turnKey: string;
}> {
	const promptId = await seedEvent(sessionId, {
		eventType: "UserPromptSubmit",
		category: "prompt",
		content: "do the thing",
	});
	await seedEvent(sessionId, {
		eventType: "PostToolUse",
		category: "tool_event",
		toolName: "Bash",
	});
	const stopId = await seedEvent(sessionId, { eventType: "Stop", category: "system_event" });
	return { promptId, stopId, turnKey: `p:${promptId}` };
}

/** A completed proposal with its open HITL, bound to a turn the way the restructured runner binds one. */
export async function seedProposalWithHitl(input: {
	sessionId: string;
	providerId: string;
	prompt: string | null;
	turnKey: string | null;
	triggerEventId: number | null;
	approvable?: boolean | null;
	promptSha256?: string | null;
	channelId?: string | null;
	expiresAt?: string | null;
	status?: string;
	decision?: "continue" | "ask";
}): Promise<{ proposalId: string; hitlId: string }> {
	const proposalId = crypto.randomUUID();
	const hitlId = crypto.randomUUID();
	await getDb()
		.insert(watcherProposals)
		.values({
			id: proposalId,
			sessionId: input.sessionId,
			providerId: input.providerId,
			state: "complete",
			decision: input.decision ?? "continue",
			suggestedPrompt: input.prompt,
			triggerEventId: input.triggerEventId === null ? null : String(input.triggerEventId),
			turnKey: input.turnKey,
		});
	await getDb()
		.insert(aiHitlRequests)
		.values({
			id: hitlId,
			proposalId,
			sessionId: input.sessionId,
			channelId: input.channelId ?? null,
			status: input.status ?? "awaiting_reply",
			turnKey: input.turnKey,
			triggerEventId: input.triggerEventId,
			promptSha256:
				input.promptSha256 !== undefined
					? input.promptSha256
					: input.prompt === null
						? null
						: sha256(input.prompt),
			approvable: input.approvable === undefined ? true : input.approvable,
			expiresAt:
				input.expiresAt !== undefined
					? input.expiresAt
					: new Date(Date.now() + 20 * 60_000).toISOString(),
		});
	return { proposalId, hitlId };
}

/** A confirmed `auto` config the dispatch will accept (continue on, confirmed by `confirmedBy`). */
export async function seedAutoConfig(input: {
	sessionId: string;
	providerId: string;
	confirmedBy?: string;
	maxContinuations?: number;
	continuationsUsed?: number;
}): Promise<void> {
	await getDb()
		.insert(watcherConfigs)
		.values({
			sessionId: input.sessionId,
			providerId: input.providerId,
			enabled: true,
			notifyEnabled: false,
			continueEnabled: true,
			policy: "auto",
			maxContinuations: input.maxContinuations ?? 10,
			continuationsUsed: input.continuationsUsed ?? 0,
			autoConfirmedAt: new Date().toISOString(),
			autoConfirmedBy: input.confirmedBy ?? "local",
		})
		.onConflictDoNothing();
}
