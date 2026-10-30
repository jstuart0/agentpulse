/**
 * The wake path of the runner: which events wake it, how long it waits, what
 * it does when a run is already queued or running. Only the runner's own timers
 * are faked; the database, the bus and the queue are real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { createFakeClock } from "../../test-utils/fake-clock.js";
import { startLlmStubServer } from "../../test-utils/llm-stub-server.js";
import {
	seedStubProvider,
	seedTurn,
	seedWatchedSession,
} from "../../test-utils/runner-fixtures.js";
import {
	enableAiRuntime,
	seedEvent,
	seedProposalWithHitl,
	setSetting,
} from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const schema = await import("../../db/schema/index.js");
const {
	aiDailySpend,
	aiHitlRequests,
	aiWatcherRuns,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	settings,
	supervisors,
	watcherConfigs,
	watcherProposals,
} = schema;
const { WatcherRunner, BOUNDARY_DEBOUNCE_MS } = await import("./runner.js");
const { sessionBus, notifyWatcherWake } = await import("../notifier.js");
const { getEventById } = await import("./event-queries.js");
const { boundaryOf, computeTurnKey } = await import("./turn-identity.js");
const { claimNextRun, enqueueRun, getOpenRunForSession, _setBeforeTriggerMoveHookForTest } =
	await import("./watcher-runs-service.js");
const feature = await import("./feature.js");

const stub = startLlmStubServer();
let providerId = "";
let clock: ReturnType<typeof createFakeClock>;
let runner: InstanceType<typeof WatcherRunner>;
let n = 0;

beforeAll(() => initializeDatabase());
afterAll(async () => {
	await stub.stop();
});

async function reset() {
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(aiWatcherRuns);
	await getDb().delete(watcherConfigs);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	await getDb().delete(aiDailySpend);
	await getDb().delete(settings);
	await getDb().delete(schema.llmProviders);
	feature.invalidateAiFlagsCache();
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedStubProvider(stub);
	clock = createFakeClock();
	runner = new WatcherRunner(clock);
	runner.attachListeners();
});
afterEach(async () => {
	_setBeforeTriggerMoveHookForTest(null);
	runner.stop();
	await reset();
});

const newId = () => `rw-${++n}-${crypto.randomUUID().slice(0, 6)}`;
const runsOf = (sessionId: string) =>
	getDb().select().from(aiWatcherRuns).where(eq(aiWatcherRuns.sessionId, sessionId));

/** Let the runner's async work (flag reads, the queue insert) settle; its timers are the fake clock's. */
const flush = () => new Promise<void>((r) => setTimeout(r, 40));

async function until(check: () => Promise<boolean>, ms = 3_000) {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("until: not met in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function newEvent(
	sessionId: string,
	eventType: string,
	category: string | null = "system_event",
) {
	const id = await seedEvent(sessionId, { eventType, category });
	const event = await getEventById(id);
	if (!event) throw new Error("event missing");
	return event;
}

/** A hook delivery: ingest tells the runner through the wake event. */
function hookWake(sessionId: string, event: Awaited<ReturnType<typeof newEvent>>) {
	const boundary = boundaryOf(event);
	if (boundary) notifyWatcherWake(sessionId, event, boundary);
}

async function watched(over: { managed?: boolean } = {}) {
	const sessionId = newId();
	await seedWatchedSession({ sessionId, providerId, notify: true, continue: false, ...over });
	return sessionId;
}

describe("which events wake the watcher", () => {
	test("a Stop and then a SessionEnd within ten seconds give one run, woken for the newer", async () => {
		const sessionId = await watched();
		const stop = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stop);
		await flush();
		clock.advance(5_000);
		const end = await newEvent(sessionId, "SessionEnd");
		hookWake(sessionId, end);
		await flush();

		clock.advance(BOUNDARY_DEBOUNCE_MS - 1);
		await flush();
		expect(await runsOf(sessionId)).toEqual([]);
		clock.advance(1);
		await until(async () => (await runsOf(sessionId)).length === 1);
		const [run] = await runsOf(sessionId);
		expect(run).toMatchObject({ triggerEventId: end.id, triggerKind: "stop", status: "queued" });
	});

	test("a Stop and then a new prompt within ten seconds give none", async () => {
		const sessionId = await watched();
		hookWake(sessionId, await newEvent(sessionId, "Stop"));
		await flush();
		hookWake(sessionId, await newEvent(sessionId, "UserPromptSubmit", "prompt"));
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS * 2);
		await flush();
		expect(await runsOf(sessionId)).toEqual([]);
		expect(clock.pendingTimers()).toBe(0);
	});

	test("a prompt that is already stored when the timer fires also stops the run (the order of two events can't be trusted)", async () => {
		const sessionId = await watched();
		hookWake(sessionId, await newEvent(sessionId, "Stop"));
		await flush();
		// The next turn started, but its wake never reached the runner.
		await newEvent(sessionId, "UserPromptSubmit", "prompt");
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await flush();
		expect(await runsOf(sessionId)).toEqual([]);
	});

	test("the watcher's own events never wake it", async () => {
		const sessionId = await watched();
		for (const [eventType, category] of [
			["AiReport", "ai_report"],
			["AiContinueSent", "ai_continue_sent"],
			["AiProposal", "ai_proposal"],
			["AiHitlRequest", "ai_hitl_request"],
			["ProviderError", "ai_error"],
		] as const) {
			const event = await newEvent(sessionId, eventType, category);
			sessionBus.emit("session_event", { sessionId, event });
		}
		await flush();
		expect(clock.pendingTimers()).toBe(0);
		expect(await runsOf(sessionId)).toEqual([]);
	});

	test("a session nobody watches is never woken, from either path", async () => {
		const sessionId = newId();
		await seedWatchedSession({ sessionId, providerId, notify: false, continue: false });
		const stop = await newEvent(sessionId, "Stop");
		sessionBus.emit("session_event", { sessionId, event: stop });
		await flush();
		expect(clock.pendingTimers()).toBe(0);
	});

	test("the supervisor path wakes through session_event for a managed turn end", async () => {
		const sessionId = await watched({ managed: true });
		const done = await newEvent(sessionId, "HeadlessPromptCompleted");
		sessionBus.emit("session_event", { sessionId, event: done });
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await runsOf(sessionId)).length === 1);
	});

	test("bob High 2: a second managed turn after the first run gives a second run with a different turn key", async () => {
		const sessionId = await watched({ managed: true });
		const submitted1 = await newEvent(sessionId, "HeadlessPromptSubmitted", "prompt");
		const done1 = await newEvent(sessionId, "HeadlessPromptCompleted");
		sessionBus.emit("session_event", { sessionId, event: done1 });
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await runsOf(sessionId)).length === 1);
		await getDb()
			.update(aiWatcherRuns)
			.set({ status: "succeeded" })
			.where(eq(aiWatcherRuns.sessionId, sessionId));

		// An automatic send, then the supervisor reports the next turn.
		const submitted2 = await newEvent(sessionId, "HeadlessPromptSubmitted", "prompt");
		sessionBus.emit("session_event", { sessionId, event: submitted2 });
		const done2 = await newEvent(sessionId, "HeadlessPromptCompleted");
		sessionBus.emit("session_event", { sessionId, event: done2 });
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await runsOf(sessionId)).length === 2);

		const session = { sessionId, agentType: "claude_code" };
		expect(await computeTurnKey(getDb(), session, done1)).toBe(`p:${submitted1.id}`);
		expect(await computeTurnKey(getDb(), session, done2)).toBe(`p:${submitted2.id}`);
	});

	test("a turn start closes the open request as superseded", async () => {
		const sessionId = await watched({ managed: true });
		const turn = await seedTurn(sessionId);
		const { hitlId } = await seedProposalWithHitl({
			sessionId,
			providerId,
			prompt: "Run the tests",
			turnKey: `p:${turn.promptId}`,
			triggerEventId: turn.stopId,
		});
		const next = await newEvent(sessionId, "UserPromptSubmit", "prompt");
		hookWake(sessionId, next);
		await until(
			async () =>
				(await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId)))[0]
					?.status === "superseded",
		);
	});

	test("the kill switch turned on before the timer fires: nothing is queued", async () => {
		const sessionId = await watched();
		hookWake(sessionId, await newEvent(sessionId, "Stop"));
		await flush();
		await setSetting("ai.killSwitch", true);
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await flush();
		expect(await runsOf(sessionId)).toEqual([]);
	});

	test("the watcher turned off for the session before the timer fires: nothing is queued", async () => {
		const sessionId = await watched();
		hookWake(sessionId, await newEvent(sessionId, "Stop"));
		await flush();
		await getDb().delete(watcherConfigs).where(eq(watcherConfigs.sessionId, sessionId));
		const { invalidateWatchedSessions } = await import("./watched-sessions.js");
		invalidateWatchedSessions();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await flush();
		expect(await runsOf(sessionId)).toEqual([]);
	});
});

describe("a wake while a run is queued or running", () => {
	test("while queued: the queued run's trigger moves to the newer Stop", async () => {
		const sessionId = await watched();
		const stopA = await newEvent(sessionId, "Stop");
		await enqueueRun({ sessionId, triggerEventId: stopA.id, triggerKind: "stop" });
		const stopB = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stopB);
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await runsOf(sessionId))[0]?.triggerEventId === stopB.id);
		expect(await runsOf(sessionId)).toHaveLength(1);
	});

	/** A claimed run whose evaluation is quick: its trigger isn't a boundary, so it is cancelled at once. */
	async function runningRun(sessionId: string) {
		const filler = await newEvent(sessionId, "AssistantMessage", "assistant_message");
		await enqueueRun({ sessionId, triggerEventId: filler.id, triggerKind: "idle" });
		const claimed = await claimNextRun({ leaseOwner: "test", leaseDurationMs: 60_000 });
		if (!claimed) throw new Error("not claimed");
		return claimed;
	}

	test("bob M6: two wakes while it runs give exactly one more run afterwards, for the newest", async () => {
		const sessionId = await watched();
		const claimed = await runningRun(sessionId);

		const stopA = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stopA);
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await flush();
		const stopB = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stopB);
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await flush();
		expect(await runsOf(sessionId)).toHaveLength(1);

		// biome-ignore lint/complexity/useLiteralKeys: the run is finished directly
		await runner["processRun"](claimed);
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await runsOf(sessionId)).length === 2);
		const queued = await getOpenRunForSession(sessionId);
		expect(queued).toMatchObject({ triggerEventId: stopB.id, status: "queued" });
	});

	test("bob M6: a queued run claimed between the read and the update is treated the same way", async () => {
		const sessionId = await watched();
		const filler = await newEvent(sessionId, "AssistantMessage", "assistant_message");
		await enqueueRun({ sessionId, triggerEventId: filler.id, triggerKind: "idle" });
		let claimed: Awaited<ReturnType<typeof claimNextRun>> = null;
		_setBeforeTriggerMoveHookForTest(async () => {
			claimed = await claimNextRun({ leaseOwner: "test", leaseDurationMs: 60_000 });
			_setBeforeTriggerMoveHookForTest(null);
		});

		const stop = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stop);
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => claimed !== null);
		await flush();
		// The claimed run kept its own trigger, and no second run exists yet.
		expect(await runsOf(sessionId)).toHaveLength(1);
		expect((await runsOf(sessionId))[0]?.triggerEventId).toBe(filler.id);

		// biome-ignore lint/complexity/useLiteralKeys: the run is finished directly
		await runner["processRun"](claimed as never);
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await runsOf(sessionId)).length === 2);
		expect(await getOpenRunForSession(sessionId)).toMatchObject({ triggerEventId: stop.id });
	});

	test("C2: a run that finishes between the wake's read and its note is still followed by a run", async () => {
		const sessionId = await watched();
		const filler = await newEvent(sessionId, "AssistantMessage", "assistant_message");
		await enqueueRun({ sessionId, triggerEventId: filler.id, triggerKind: "idle" });
		// The wake reads the queued run; before it can move the trigger, the run is claimed
		// and runs to the end, including its `finally`. The wake then finds nobody to collect it.
		_setBeforeTriggerMoveHookForTest(async () => {
			_setBeforeTriggerMoveHookForTest(null);
			const claimed = await claimNextRun({ leaseOwner: "test", leaseDurationMs: 60_000 });
			// biome-ignore lint/complexity/useLiteralKeys: the run is finished directly
			await runner["processRun"](claimed as never);
		});
		const stop = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stop);
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		// The wake collects its own rewake: a timer for the follow-up run appears.
		await until(async () => clock.pendingTimers() === 1);
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await getOpenRunForSession(sessionId))?.triggerEventId === stop.id);
		expect(await runsOf(sessionId)).toHaveLength(2);
	});

	test("C1: a run left claimed by a dead process does not absorb the next wake after a restart", async () => {
		const sessionId = await watched();
		const filler = await newEvent(sessionId, "AssistantMessage", "assistant_message");
		await enqueueRun({ sessionId, triggerEventId: filler.id, triggerKind: "idle" });
		// Claimed a moment ago: the lease is fresh, so lease expiry would not reclaim it for a minute.
		await claimNextRun({ leaseOwner: "dead-process", leaseDurationMs: 60_000 });
		const { sweepWatcherOnStart } = await import("./watcher-maintenance.js");
		const swept = await sweepWatcherOnStart();
		expect(swept.abandonedRuns).toBe(1);
		expect((await runsOf(sessionId))[0]).toMatchObject({
			status: "cancelled",
			lastErrorSubType: "abandoned_on_restart",
		});

		const stop = await newEvent(sessionId, "Stop");
		hookWake(sessionId, stop);
		await flush();
		clock.advance(BOUNDARY_DEBOUNCE_MS);
		await until(async () => (await getOpenRunForSession(sessionId))?.triggerEventId === stop.id);
	});
});
