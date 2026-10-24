/**
 * The hook path wakes the watcher only for watched sessions, and only at turn
 * boundaries: thirty tool events and a Stop in two sessions, one watched and
 * one not, leave exactly one queued run, for the watched one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";
import { createFakeClock } from "../test-utils/fake-clock.js";
import { startLlmStubServer } from "../test-utils/llm-stub-server.js";
import { seedStubProvider } from "../test-utils/runner-fixtures.js";
import { enableAiRuntime } from "../test-utils/watcher-fixtures.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const schema = await import("../db/schema/index.js");
const { aiWatcherRuns, events, sessions, settings, watcherConfigs } = schema;
const { ingest } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { WatcherRunner, BOUNDARY_DEBOUNCE_MS } = await import("../services/ai/runner.js");
const { invalidateWatchedSessions } = await import("../services/ai/watched-sessions.js");
const feature = await import("../services/ai/feature.js");

const originalDisableAuth = config.disableAuth;
const hooksApp = new Hono().route("/api/v1", ingest);
const stub = startLlmStubServer();
let providerId = "";
let clock: ReturnType<typeof createFakeClock>;
let runner: InstanceType<typeof WatcherRunner>;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(async () => {
	config.disableAuth = originalDisableAuth;
	await stub.stop();
});
beforeEach(async () => {
	_resetBucketsForTest();
	_resetCountersForTest();
	await getDb().delete(aiWatcherRuns);
	await getDb().delete(watcherConfigs);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(settings);
	await getDb().delete(schema.llmProviders);
	feature.invalidateAiFlagsCache();
	invalidateWatchedSessions();
	await enableAiRuntime();
	providerId = await seedStubProvider(stub);
	clock = createFakeClock();
	runner = new WatcherRunner(clock);
	runner.attachListeners();
});
afterEach(() => {
	runner.stop();
});

async function settled() {
	for (let i = 0; i < 300 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function post(body: Record<string, unknown>) {
	const res = await hooksApp.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await settled();
}

async function toolEvents(sessionId: string, pairs: number) {
	for (let i = 0; i < pairs; i += 1) {
		const common = {
			session_id: sessionId,
			tool_name: "Bash",
			tool_use_id: `tu-${sessionId}-${i}`,
		};
		await post({ ...common, hook_event_name: "PreToolUse", tool_input: { command: "ls" } });
		await post({
			...common,
			hook_event_name: "PostToolUse",
			tool_input: { command: "ls" },
			tool_response: "ok",
		});
	}
}

const runsOf = (sessionId: string) =>
	getDb().select().from(aiWatcherRuns).where(eq(aiWatcherRuns.sessionId, sessionId));

async function flushWake() {
	await new Promise((r) => setTimeout(r, 60));
	clock.advance(BOUNDARY_DEBOUNCE_MS);
	await new Promise((r) => setTimeout(r, 150));
}

describe("the hook path wakes the watcher only for watched sessions", () => {
	test("thirty tool events and a Stop: one run for the watched session, none for the other", async () => {
		const watchedId = "iw-watched";
		const plainId = "iw-plain";
		for (const sessionId of [watchedId, plainId]) {
			await post({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "go" });
		}
		await getDb().insert(watcherConfigs).values({
			sessionId: watchedId,
			providerId,
			enabled: true,
			notifyEnabled: true,
			continueEnabled: false,
		});
		invalidateWatchedSessions();

		for (const sessionId of [watchedId, plainId]) {
			await toolEvents(sessionId, 15);
		}
		// Thirty tool events in each session woke nothing: no timer exists yet.
		await new Promise((r) => setTimeout(r, 60));
		expect(clock.pendingTimers()).toBe(0);
		for (const sessionId of [watchedId, plainId]) {
			await post({ session_id: sessionId, hook_event_name: "Stop" });
		}
		await new Promise((r) => setTimeout(r, 60));
		// Only the watched session's Stop started the debounce.
		expect(clock.pendingTimers()).toBe(1);
		await flushWake();

		const [stop] = await getDb()
			.select({ id: events.id })
			.from(events)
			.where(eq(events.sessionId, watchedId))
			.orderBy(events.id)
			.then((rows) => rows.slice(-1));
		const runs = await runsOf(watchedId);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ triggerEventId: stop?.id, status: "queued" });
		expect(await runsOf(plainId)).toEqual([]);
		expect(clock.pendingTimers()).toBe(0);
	});

	test("with the config disabled, a Stop queues nothing", async () => {
		const sessionId = "iw-disabled";
		await post({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "go" });
		await getDb().insert(watcherConfigs).values({
			sessionId,
			providerId,
			enabled: true,
			notifyEnabled: true,
			continueEnabled: false,
		});
		invalidateWatchedSessions();
		await post({ session_id: sessionId, hook_event_name: "Stop" });
		await flushWake();
		expect(await runsOf(sessionId)).toHaveLength(1);

		await getDb()
			.update(aiWatcherRuns)
			.set({ status: "succeeded" })
			.where(eq(aiWatcherRuns.sessionId, sessionId));
		await getDb()
			.update(watcherConfigs)
			.set({ enabled: false })
			.where(eq(watcherConfigs.sessionId, sessionId));
		invalidateWatchedSessions();
		await post({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "again" });
		await post({ session_id: sessionId, hook_event_name: "Stop" });
		await flushWake();
		expect(await runsOf(sessionId)).toHaveLength(1);
	});
});
