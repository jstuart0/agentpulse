/**
 * Fixtures for the watcher runner tests: a stub model provider, watched
 * sessions (observed or managed) with a turn that ended a few minutes ago, and
 * a way to run one queued run through the real runner. Everything goes through
 * Drizzle or the services. Not a test file.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { watcherConfigs } from "../db/schema/index.js";
import { createProvider } from "../services/ai/providers-service.js";
import type { WatcherRunner } from "../services/ai/runner.js";
import { invalidateWatchedSessions } from "../services/ai/watched-sessions.js";
import { claimNextRun, enqueueRun } from "../services/ai/watcher-runs-service.js";
import type { LlmStubServer } from "./llm-stub-server.js";
import { seedEvent, seedLiveManagedSession, seedSession } from "./watcher-fixtures.js";

export const PROVIDER_KEY = "sk-test-runner-key-0123456789";

/** A provider whose base URL is the stub, as the default provider. */
export async function seedStubProvider(stub: LlmStubServer): Promise<string> {
	const provider = await createProvider({
		name: "Stub provider",
		kind: "openai_compatible",
		model: "stub-model",
		baseUrl: stub.baseUrl("openai"),
		apiKey: PROVIDER_KEY,
		isDefault: true,
	});
	return provider.id;
}

export interface WatchedSessionOptions {
	sessionId: string;
	providerId: string;
	managed?: boolean;
	notify?: boolean;
	continue?: boolean;
	policy?: "ask_always" | "ask_on_risk" | "auto";
	confirmed?: boolean;
	maxContinuations?: number;
	continuationsUsed?: number;
	channelId?: string | null;
}

/** A session, observed or managed with a live supervisor, and its watcher config. */
export async function seedWatchedSession(options: WatchedSessionOptions): Promise<void> {
	if (options.managed) await seedLiveManagedSession(options.sessionId);
	else await seedSession(options.sessionId);
	await getDb()
		.insert(watcherConfigs)
		.values({
			sessionId: options.sessionId,
			providerId: options.providerId,
			enabled: true,
			notifyEnabled: options.notify ?? false,
			continueEnabled: options.continue ?? true,
			policy: options.policy ?? "ask_always",
			maxContinuations: options.maxContinuations ?? 10,
			continuationsUsed: options.continuationsUsed ?? 0,
			channelId: options.channelId ?? null,
			autoConfirmedAt: options.confirmed ? new Date().toISOString() : null,
			autoConfirmedBy: options.confirmed ? "local" : null,
		});
	invalidateWatchedSessions();
}

export async function setConfig(
	sessionId: string,
	patch: Partial<typeof watcherConfigs.$inferInsert>,
): Promise<void> {
	await getDb().update(watcherConfigs).set(patch).where(eq(watcherConfigs.sessionId, sessionId));
	invalidateWatchedSessions();
}

export interface TurnOptions {
	/** How long ago the turn ended. Default: three minutes, past every lockout. */
	endedAgoMs?: number;
	lastMessage?: string;
	/** Extra events inside the turn, before the Stop. */
	extra?: Array<{
		eventType: string;
		category?: string | null;
		content?: string | null;
		toolName?: string | null;
		rawPayload?: Record<string, unknown>;
	}>;
}

/** A turn that ended in the past: a prompt, an agent message, any extras, then a Stop. */
export async function seedTurn(
	sessionId: string,
	options: TurnOptions = {},
): Promise<{ promptId: number; messageId: number; stopId: number }> {
	const end = Date.now() - (options.endedAgoMs ?? 3 * 60_000);
	let step = 0;
	const at = () => new Date(end - 10_000 + step++ * 100).toISOString();
	const promptId = await seedEvent(sessionId, {
		eventType: "UserPromptSubmit",
		category: "prompt",
		content: "fix the build",
		createdAt: at(),
	});
	for (const extra of options.extra ?? []) {
		await seedEvent(sessionId, { ...extra, createdAt: at() });
	}
	const messageId = await seedEvent(sessionId, {
		eventType: "AssistantMessage",
		category: "assistant_message",
		content: options.lastMessage ?? "I fixed the build and the tests pass",
		createdAt: at(),
	});
	const stopId = await seedEvent(sessionId, {
		eventType: "Stop",
		category: "system_event",
		createdAt: at(),
	});
	return { promptId, messageId, stopId };
}

/** Queue a run for the trigger, claim it, and run it through the real runner. Returns the run id. */
export async function runOnce(
	runner: WatcherRunner,
	sessionId: string,
	triggerEventId: number,
): Promise<string> {
	const { run } = await enqueueRun({ sessionId, triggerEventId, triggerKind: "stop" });
	const claimed = await claimNextRun({ leaseOwner: "test", leaseDurationMs: 60_000 });
	if (!claimed || claimed.id !== run.id)
		throw new Error("the run just queued wasn't the one claimed");
	// biome-ignore lint/complexity/useLiteralKeys: the run is driven directly, without the poller
	await runner["processRun"](claimed);
	return run.id;
}
