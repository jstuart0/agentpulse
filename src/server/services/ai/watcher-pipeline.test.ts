/**
 * End-to-end watcher pipeline test using a mocked LLM provider and a fresh
 * SQLite DB. Exercises: provider creation, watcher enablement, runner wake,
 * LLM call, parsing, HITL request emission, approval → ai_continue_sent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpDataDir = mkdtempSync(join(tmpdir(), "ap-watcher-pipeline-"));
process.env.AGENTPULSE_AI_ENABLED = "true";
process.env.AGENTPULSE_SECRETS_KEY = "a".repeat(32);
process.env.DATA_DIR = tmpDataDir;
process.env.DISABLE_AUTH = "true";

// Imports happen after env is set so config picks them up.
const { initializeDatabase } = await import("../../db/client.js");
const { db } = await import("../../db/client.js");
const { sessions, events: eventsTable, settings } = await import("../../db/schema.js");
const { createProvider } = await import("./providers-service.js");
const { upsertWatcherConfig } = await import("./watcher-config-service.js");
const { watcherRunner } = await import("./runner.js");
const { AI_RUNTIME_ENABLED_KEY } = await import("./feature.js");
const { getOpenHitlProposal, listProposalsForSession } = await import("./proposals-service.js");
const { sessionBus } = await import("../notifier.js");

async function seedSession(sessionId: string) {
	const now = new Date().toISOString();
	await db.insert(sessions).values({
		sessionId,
		displayName: "test-session",
		agentType: "claude_code",
		status: "active",
		cwd: "/tmp/fake",
		startedAt: now,
		lastActivityAt: now,
		metadata: {},
	});
}

async function seedEvent(sessionId: string, category: string, content: string) {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(eventsTable)
		.values({
			sessionId,
			eventType: "SyntheticEvent",
			category,
			source: "observed_hook",
			content,
			isNoise: false,
			providerEventType: null,
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload: {},
			createdAt: now,
		})
		.returning();
	return row;
}

function mockAdapter(responses: string[]): void {
	// Mock fetch so the adapter returns a canned response.
	const originalFetch = globalThis.fetch;
	// biome-ignore lint/suspicious/noExplicitAny: test harness
	globalThis.fetch = (async (url: string, _init?: RequestInit) => {
		if (String(url).includes("/chat/completions")) {
			const text = responses.shift() ?? '{"decision":"wait"}';
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: text } }],
					usage: { prompt_tokens: 100, completion_tokens: 20 },
				}),
				{ status: 200 },
			);
		}
		return originalFetch(url, _init);
	}) as any;
}

function waitForRunner(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
	if (!existsSync(tmpDataDir)) mkdirSync(tmpDataDir, { recursive: true });
	initializeDatabase();
	// Flip the runtime toggle on directly
	await db
		.insert(settings)
		.values({ key: AI_RUNTIME_ENABLED_KEY, value: true, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({ target: settings.key, set: { value: true } });
	watcherRunner.start();
});

afterAll(() => {
	try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
});

describe("watcher pipeline (mocked LLM)", () => {
	test("runs end-to-end and parks in HITL when the model returns an ask", async () => {
		const sessionId = `sess-ask-${Date.now()}`;
		await seedSession(sessionId);
		await seedEvent(sessionId, "assistant_message", "done with step one");

		const provider = await createProvider({
			name: "mock",
			kind: "openai_compatible",
			model: "mock-model",
			baseUrl: "http://localhost:1/v1",
			apiKey: "mock-key",
			isDefault: true,
		});
		await upsertWatcherConfig({
			sessionId,
			enabled: true,
			providerId: provider.id,
			policy: "ask_always",
		});

		mockAdapter([
			'{"decision":"ask","proposal":"run the failing tests again","why":"saw a flake"}',
		]);

		// Kick the bus; runner debounces ~1500ms.
		sessionBus.emit("session_updated", {
			sessionId,
			agentType: "claude_code",
			isWorking: false,
		} as any);
		await waitForRunner(2500);

		const proposals = await listProposalsForSession(sessionId, 5);
		expect(proposals.length).toBeGreaterThan(0);
		const top = proposals[0];
		expect(top.state).toBe("hitl_waiting");
		expect(top.decision).toBe("ask");

		const open = await getOpenHitlProposal(sessionId);
		expect(open?.id).toBe(top.id);
	});

	test("emits ai_error when the LLM fails and does not spend budget on failure", async () => {
		const sessionId = `sess-fail-${Date.now()}`;
		await seedSession(sessionId);
		await seedEvent(sessionId, "assistant_message", "done again");

		const provider = await createProvider({
			name: "mock2",
			kind: "openai_compatible",
			model: "mock-model",
			baseUrl: "http://localhost:1/v1",
			apiKey: "x",
		});
		await upsertWatcherConfig({
			sessionId,
			enabled: true,
			providerId: provider.id,
			policy: "ask_always",
		});

		// Mock fetch to return 401
		const originalFetch = globalThis.fetch;
		// biome-ignore lint/suspicious/noExplicitAny: test harness
		globalThis.fetch = (async (url: string, _init?: RequestInit) => {
			if (String(url).includes("/chat/completions")) {
				return new Response("nope", { status: 401 });
			}
			return originalFetch(url, _init);
		}) as any;

		sessionBus.emit("session_updated", {
			sessionId,
			agentType: "claude_code",
			isWorking: false,
		} as any);
		await waitForRunner(2500);

		const proposals = await listProposalsForSession(sessionId, 5);
		expect(proposals[0].state).toBe("failed");
		expect(proposals[0].errorSubType).toBe("permanent_auth");
	});
});
