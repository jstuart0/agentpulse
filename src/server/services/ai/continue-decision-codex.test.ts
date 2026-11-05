/**
 * AGEN-91 D13: an unattended nudge never reaches a Codex session in this release. The human gate
 * reads hook-shaped evidence a managed Codex session doesn't produce, and auto ignores the
 * launch's policy, so a confirmed `auto` config on a Codex session opens the same request a person
 * decides on. The send path refuses on its own too, keyed on the launch, so a forged session row
 * can't route around the decision.
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
import { enableAiRuntime, seedEvent, setSetting } from "../../test-utils/watcher-fixtures.js";

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

const newId = () => `cdx-${++n}-${crypto.randomUUID().slice(0, 6)}`;
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

describe("a Codex session never gets an unattended send", () => {
	test("an auto-kind decision opens a request carrying the prompt, and writes no control action and no audit row", async () => {
		const w = await autoWorld({ session: "codex_cli", launch: "codex_cli" });
		stub.script("openai", continueAnswer("Run the tests in src/foo", "run_tests"));

		await runOnce(runner, w.sessionId, w.stopId);

		expect(await actionsOf(w.sessionId)).toEqual([]);
		expect(await auditOf(w.sessionId)).toEqual([]);
		const requests = await hitlsOf(w.sessionId);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.status).toBe("awaiting_reply");
		expect(requests[0]?.promptSha256).not.toBeNull();
		expect((await proposalsOf(w.sessionId))[0]?.suggestedPrompt).toBe("Run the tests in src/foo");
	});

	test("positive control: the same config on a Claude session still sends the fixed template", async () => {
		const w = await autoWorld({ session: "claude_code", launch: "claude_code" });
		stub.script("openai", continueAnswer("Run the tests in src/foo", "run_tests"));

		await runOnce(runner, w.sessionId, w.stopId);

		expect(await actionsOf(w.sessionId)).toHaveLength(1);
		expect(await hitlsOf(w.sessionId)).toEqual([]);
	});

	test("the send path refuses on its own: dispatchPrompt answers codex_needs_person for a Codex launch even when the session row says claude_code", async () => {
		const w = await autoWorld({ session: "claude_code", launch: "codex_cli" });
		const proposalId = crypto.randomUUID();
		await seedEvent(w.sessionId, { eventType: "ManagedProbe", category: "system_event" });

		const refused = await dispatchPrompt(
			w.sessionId,
			{ kind: "auto", continueKind: "run_tests" } as Parameters<typeof dispatchPrompt>[1],
			AI_ACTOR,
			{
				actorKind: "auto",
				proposalId,
				triggerEventId: w.stopId,
				turnKey: `p:${w.promptId}`,
			},
		);

		expect(refused).toMatchObject({
			ok: false,
			code: "auto_send_blocked",
			reason: "codex_needs_person",
		});
		expect(await actionsOf(w.sessionId)).toEqual([]);
	});

	test("autoRefusalWhy has text for codex_needs_person, host_upgrade_required and launch_mismatch", () => {
		const config = { continuationsUsed: 0, maxContinuations: 3 } as never;
		for (const reason of ["codex_needs_person", "host_upgrade_required", "launch_mismatch"]) {
			const why = autoRefusalWhy({ code: "auto_send_blocked", reason }, config);
			expect(why).not.toBeNull();
			expect(why).not.toContain(reason);
			expect(why).not.toBe("Auto-send was refused, so this waits for you.");
		}
	});
});
