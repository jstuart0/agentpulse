/**
 * The send path under contention. On Postgres these run on the real pool, so
 * two decisions are really two connections; on SQLite they pin the serial
 * cases and that the dispatch body never yields to the event loop (the admin
 * lock throws in tests if a body does).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { AdminLockYieldError } from "../../db/admin-lock.js";
import {
	enableAiRuntime,
	seedAutoConfig,
	seedFinishedTurn,
	seedLiveManagedSession,
	seedProposalWithHitl,
	seedProvider,
	setSetting,
	sha256,
} from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { config } = await import("../../config.js");
const schema = await import("../../db/schema/index.js");
const {
	aiDispatchAudit,
	aiHitlRequests,
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
const feature = await import("./feature.js");
const { AI_ACTOR, dispatchPrompt, resolveProposal } = await import("./proposal-resolution.js");
const { queuePromptAction } = await import("../control-actions.js");

const originalDisableAuth = config.disableAuth;
const ROUNDS = 20;
const PROMPT = "Run the failing test and fix it";
const USER = { userId: null, label: "user" } as const;
let providerId = "";
let n = 0;

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(watcherConfigs);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	await getDb().delete(settings);
	feature.invalidateAiFlagsCache();
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedProvider();
});
afterEach(reset);

async function world() {
	n += 1;
	const sessionId = `cc-${n}-${crypto.randomUUID().slice(0, 6)}`;
	await seedLiveManagedSession(sessionId);
	const turn = await seedFinishedTurn(sessionId);
	const ids = await seedProposalWithHitl({
		sessionId,
		providerId,
		prompt: PROMPT,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
	});
	return { sessionId, ...turn, ...ids };
}
const rowsFor = (sessionId: string) =>
	getDb().select().from(controlActions).where(eq(controlActions.sessionId, sessionId));

function autoOn(w: { sessionId: string; stopId: number; turnKey: string; proposalId: string }) {
	return dispatchPrompt(w.sessionId, { kind: "auto", continueKind: "run_tests" }, AI_ACTOR, {
		actorKind: "auto",
		proposalId: w.proposalId,
		triggerEventId: w.stopId,
		turnKey: w.turnKey,
	});
}

describe("two decisions on one request", () => {
	test(`exactly one sends and the other is already_resolved, ${ROUNDS} rounds`, async () => {
		for (let round = 0; round < ROUNDS; round += 1) {
			const w = await world();
			const results = await Promise.all([
				resolveProposal({
					hitlId: w.hitlId,
					action: "approve",
					promptSha256: sha256(PROMPT),
					actor: USER,
					actorKind: "user",
				}),
				resolveProposal({
					hitlId: w.hitlId,
					action: "approve",
					promptSha256: sha256(PROMPT),
					actor: USER,
					actorKind: "user",
				}),
			]);
			expect(await rowsFor(w.sessionId), `round ${round}`).toHaveLength(1);
			const ok = results.filter((r) => r.ok);
			expect(ok, `round ${round}`).toHaveLength(1);
			// The loser lost the claim, not the lock: dropping the claim would make it control_busy instead.
			const loser = results.find((r) => !r.ok);
			expect(loser).toMatchObject({ ok: false, status: 409, code: "already_resolved" });
			// And only the winner's intent was ever written.
			const audit = await getDb()
				.select()
				.from(aiDispatchAudit)
				.where(eq(aiDispatchAudit.sessionId, w.sessionId));
			expect(audit, `round ${round}`).toHaveLength(1);
		}
	}, 120_000);
});

describe("a person and the auto policy at the same moment", () => {
	test(`exactly one prompt row and exactly one lock holder, ${ROUNDS} rounds`, async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		let autoWon = 0;
		let humanWon = 0;
		for (let round = 0; round < ROUNDS; round += 1) {
			const w = await world();
			await seedAutoConfig({ sessionId: w.sessionId, providerId });
			const outcomes = await Promise.allSettled([
				queuePromptAction(w.sessionId, "Look at the failing test", { userId: "u", label: "user" }),
				autoOn(w),
			]);
			const rows = await rowsFor(w.sessionId);
			expect(rows, `round ${round}`).toHaveLength(1);
			const [managed] = await getDb()
				.select()
				.from(managedSessions)
				.where(eq(managedSessions.sessionId, w.sessionId));
			expect(managed?.activeControlActionId, `round ${round}`).toBe(rows[0]?.id);
			if (rows[0]?.requestedBy === "ai") autoWon += 1;
			else humanWon += 1;
			// The loser is told why, never a crash: either the lock was taken, or the turn
			// already has a prompt after its trigger.
			const auto = outcomes[1];
			if (auto?.status === "fulfilled" && !auto.value.ok) {
				expect(["prompt_not_deliverable", "stale_proposal"]).toContain(auto.value.code);
			}
			expect(auto?.status).toBe("fulfilled");
		}
		expect(autoWon + humanWon).toBe(ROUNDS);
	}, 120_000);
});

describe("the global cap", () => {
	test("with 19 sends used, of two auto dispatches on two sessions exactly one succeeds", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		for (let round = 0; round < ROUNDS; round += 1) {
			await getDb().delete(controlActions);
			const a = await world();
			const b = await world();
			await seedAutoConfig({ sessionId: a.sessionId, providerId });
			await seedAutoConfig({ sessionId: b.sessionId, providerId });
			await getDb()
				.insert(controlActions)
				.values(
					Array.from({ length: 19 }, () => ({
						sessionId: a.sessionId,
						actionType: "prompt",
						requestedBy: "ai",
						status: "completed",
						createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
					})),
				);
			const results = await Promise.all([autoOn(a), autoOn(b)]);
			expect(
				results.filter((r) => r.ok),
				`round ${round}`,
			).toHaveLength(1);
			expect(
				results.find((r) => !r.ok),
				`round ${round}`,
			).toMatchObject({
				code: "auto_send_blocked",
				reason: "hourly_cap",
			});
		}
	}, 120_000);
});

describe("a refusal commits", () => {
	test("an auto dispatch refused for the cap leaves its audit row refused and the actions unchanged", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		const w = await world();
		await seedAutoConfig({ sessionId: w.sessionId, providerId });
		for (let i = 0; i < 6; i += 1) {
			await getDb()
				.insert(controlActions)
				.values({
					sessionId: w.sessionId,
					actionType: "prompt",
					requestedBy: "ai",
					status: "completed",
					createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
				});
		}
		const before = (await rowsFor(w.sessionId)).length;
		const result = await autoOn(w);
		expect(result).toMatchObject({ ok: false, reason: "hourly_cap", enqueued: false });
		expect(await rowsFor(w.sessionId)).toHaveLength(before);
		const audit = await getDb()
			.select()
			.from(aiDispatchAudit)
			.where(eq(aiDispatchAudit.sessionId, w.sessionId));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			outcome: "refused",
			refusalCode: "auto_send_blocked:hourly_cap",
		});
		expect(AdminLockYieldError).toBeDefined();
	});

	test("the dispatch body never yields to the event loop, across many serial sends", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		for (let round = 0; round < ROUNDS; round += 1) {
			const w = await world();
			await seedAutoConfig({ sessionId: w.sessionId, providerId });
			const result = await autoOn(w);
			// A yield would have thrown AdminLockYieldError, which becomes dispatch_failed.
			expect(result, `round ${round}`).toMatchObject({ ok: true });
		}
	}, 120_000);
});
