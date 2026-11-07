/**
 * AGEN-117 I18, X17: an unattended nudge never reaches a continued (taken-over) Claude session, and a
 * prompt to one that runs under the person's own settings needs a person, not an API key. The send path
 * refuses on its own, keyed on the launch (the one table only a launch request writes), so a forged session
 * row can't route around either decision.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { type LlmStubServer, startLlmStubServer } from "../../test-utils/llm-stub-server.js";
import {
	runOnce,
	seedStubProvider,
	seedTurn,
	seedWatchedSession,
} from "../../test-utils/runner-fixtures.js";
import { enableAiRuntime, setSetting } from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { config } = await import("../../config.js");
const schema = await import("../../db/schema/index.js");
const {
	aiDailySpend,
	aiDispatchAudit,
	aiHitlRequests,
	aiWatcherReports,
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
const { WatcherRunner } = await import("./runner.js");
const { AI_ACTOR, dispatchPrompt } = await import("./proposal-resolution.js");
const { autoRefusalWhy } = await import("./continue-decision.js");
const feature = await import("./feature.js");
const { createFakeClock } = await import("../../test-utils/fake-clock.js");

let stub: LlmStubServer;
let providerId = "";
let runner: InstanceType<typeof WatcherRunner>;
let n = 0;
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	stub = startLlmStubServer();
});
afterAll(async () => {
	await stub.stop();
});

async function reset() {
	stub?.reset();
	await getDb().delete(aiHitlRequests);
	await getDb().delete(aiWatcherReports);
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
	(config as Record<string, unknown>).disableAuth = true;
	await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
	providerId = await seedStubProvider(stub);
	runner = new WatcherRunner(createFakeClock());
});
afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	runner.stop();
	await reset();
	stub.verify();
});

const newId = () => `fork-${++n}-${crypto.randomUUID().slice(0, 6)}`;
const continueAnswer = (nextPrompt: string, continueKind: string) => ({
	text: JSON.stringify({ decision: "continue", nextPrompt, continueKind }),
});

/** A confirmed, un-paused auto config on a managed session with a finished turn. */
async function autoWorld(types: { session: string; launch: string }) {
	const sessionId = newId();
	await seedWatchedSession({
		sessionId,
		providerId,
		managed: true,
		continue: true,
		policy: "auto",
		confirmed: true,
	});
	await getDb()
		.update(sessions)
		.set({ agentType: types.session })
		.where(eq(sessions.sessionId, sessionId));
	await getDb()
		.update(launchRequests)
		.set({ agentType: types.launch })
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	// The host takes Codex follow-ups (a host that doesn't is control-actions-codex-host-gate.test.ts's case).
	await getDb()
		.update(supervisors)
		.set({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "managed_codex"],
				os: "linux",
				terminalSupport: [],
				features: ["codex_follow_up_prompts"],
			},
		});
	return { sessionId, ...(await seedTurn(sessionId)) };
}

const actionsOf = (sessionId: string) =>
	getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId));
const auditOf = (sessionId: string) =>
	getDb().select().from(aiDispatchAudit).where(eq(aiDispatchAudit.sessionId, sessionId));
const hitlsOf = (sessionId: string) =>
	getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.sessionId, sessionId));
const proposalsOf = (sessionId: string) =>
	getDb().select().from(watcherProposals).where(eq(watcherProposals.sessionId, sessionId));

async function forkWorld(branch: "ask" | "restricted" = "ask") {
	const sessionId = newId();
	await seedWatchedSession({
		sessionId,
		providerId,
		managed: true,
		continue: true,
		policy: "auto",
		confirmed: true,
	});
	await getDb()
		.update(launchRequests)
		.set({ agentType: "claude_code", metadata: { boundObservedSession: true } })
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	await getDb()
		.update(sessions)
		.set({
			agentType: "claude_code",
			metadata: { forkedFromSessionId: "src-1", forkPermissionBranch: branch },
		})
		.where(eq(sessions.sessionId, sessionId));
	return { sessionId, ...(await seedTurn(sessionId)) };
}

const humanCtx = (w: { stopId: number; promptId: number }) => ({
	actorKind: "user" as const,
	proposalId: crypto.randomUUID(),
	triggerEventId: w.stopId,
	turnKey: `p:${w.promptId}`,
});

describe("a continued Claude session never gets an unattended send", () => {
	test("the send path refuses auto on its own: takeover_needs_person, nothing queued", async () => {
		const w = await forkWorld();
		const refused = await dispatchPrompt(
			w.sessionId,
			{ kind: "auto", continueKind: "run_tests" } as Parameters<typeof dispatchPrompt>[1],
			AI_ACTOR,
			{
				actorKind: "auto",
				proposalId: crypto.randomUUID(),
				triggerEventId: w.stopId,
				turnKey: `p:${w.promptId}`,
			},
		);
		expect(refused).toMatchObject({
			ok: false,
			code: "auto_send_blocked",
			reason: "takeover_needs_person",
		});
		expect(await actionsOf(w.sessionId)).toEqual([]);
	});

	test("end to end the run ends in a request a person decides on, with an audited refusal", async () => {
		const w = await forkWorld("restricted");
		stub.script("openai", continueAnswer("Run the tests in src/foo", "run_tests"));
		await runOnce(runner, w.sessionId, w.stopId);
		expect(await actionsOf(w.sessionId)).toEqual([]);
		expect(await hitlsOf(w.sessionId)).toHaveLength(1);
		expect((await auditOf(w.sessionId)).map((r) => r.refusalCode)).toEqual([
			"auto_send_blocked:takeover_needs_person",
		]);
	});

	test("a launched Claude session with the same config still sends (positive control)", async () => {
		const sessionId = newId();
		await seedWatchedSession({
			sessionId,
			providerId,
			managed: true,
			continue: true,
			policy: "auto",
			confirmed: true,
		});
		const w = { sessionId, ...(await seedTurn(sessionId)) };
		stub.script("openai", continueAnswer("Run the tests in src/foo", "run_tests"));
		await runOnce(runner, w.sessionId, w.stopId);
		expect(await actionsOf(w.sessionId)).toHaveLength(1);
	});

	test("autoRefusalWhy has its own words for takeover_needs_person", () => {
		const why = autoRefusalWhy({ code: "auto_send_blocked", reason: "takeover_needs_person" }, {
			continuationsUsed: 0,
			maxContinuations: 3,
		} as never);
		expect(why).not.toBeNull();
		expect(why).not.toContain("takeover_needs_person");
		expect(why).not.toBe("Auto-send was refused, so this waits for you.");
	});
});

describe("a manual send to a continued session under the person's own settings needs a person", () => {
	test("a person's approve passes; an API key, the watcher and system work get human_required, with nothing queued", async () => {
		const w = await forkWorld("ask");
		const send = (label: "user" | "api_key" | "system" | "ai") =>
			dispatchPrompt(
				w.sessionId,
				{ kind: "human", text: "Run the tests in src/foo" },
				{ userId: null, label },
				humanCtx(w),
			);
		for (const label of ["api_key", "system"] as const) {
			expect(await send(label), label).toMatchObject({
				ok: false,
				status: 403,
				code: "human_required",
			});
		}
		expect(await actionsOf(w.sessionId)).toEqual([]);
		expect(await send("user")).toMatchObject({ ok: true });
		expect(await actionsOf(w.sessionId)).toHaveLength(1);
	});

	test("under the restricted branch an API key's manual send passes", async () => {
		const w = await forkWorld("restricted");
		const result = await dispatchPrompt(
			w.sessionId,
			{ kind: "human", text: "Run the tests in src/foo" },
			{ userId: null, label: "api_key" },
			humanCtx(w),
		);
		expect(result).toMatchObject({ ok: true });
	});
});
