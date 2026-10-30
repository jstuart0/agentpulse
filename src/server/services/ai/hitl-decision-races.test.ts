/**
 * The races a decision and a delivery have to survive, made deterministic on Postgres with a row-lock
 * barrier: one connection holds the row lock the contested write needs, the operations under test are
 * started and let run until each is parked on that lock, and only then is the lock released. Every
 * operation has therefore done all of its reads against the same state, which is the worst interleaving,
 * and the outcome no longer depends on timing.
 *
 * SQLite serializes every transaction on one connection, so the interleaving cannot happen there. Its
 * sequential equivalents are named in hitl-decision-service.test.ts ("two concurrent approvals…" runs
 * the same two calls back to back on SQLite; "of two prompts queued at once…"; "works only while the
 * delivery still follows…"; "an attempt that finished after its lock ran out stays succeeded").
 */
import { afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { describePostgresOnly } from "../../test-utils/backend.js";
import { resetIdentityState } from "../../test-utils/identity-reset.js";
import { clearInstanceSettings } from "../../test-utils/team-fixtures.js";

setDefaultTimeout(120_000);
const LIMIT = 120_000;

const { getDb, initializeDatabase } = await import("../../db/client.js");
const {
	aiHitlDeliveries,
	aiHitlRequests,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	watcherProposals,
} = await import("../../db/schema/index.js");
const { seedOwnedLaunch } = await import("../../test-utils/owned-launch.js");
const { enableAiRuntime, seedFinishedTurn, seedProposalWithHitl, seedProvider } = await import(
	"../../test-utils/watcher-fixtures.js"
);
const { hashPrompt } = await import("./prompt-hash.js");
const { decideHitl, retryDelivery } = await import("./hitl-decision-service.js");
const { queuePromptAction, queueStopAction, expireStaleControlLock, ControlBusyError } =
	await import("../control-actions.js");
const { default: postgres } = await import("postgres");

const SUPERVISOR = "race-sup";
const PROMPT = "Run the full test suite and fix what fails.";
const APPROVE = { promptHash: hashPrompt(PROMPT) };
let providerId = "";
const ctx = {
	actor: { userId: null, label: "api_key" as const, role: "admin" as const, mode: "solo" as const },
	source: "api_key" as const,
	keyId: "key-manage",
	scopes: ["manage"],
	canCustomPrompt: true,
};

beforeAll(() => initializeDatabase(), LIMIT);
async function reset() {
	await getDb().delete(aiHitlDeliveries);
	await getDb().delete(aiHitlRequests);
	await getDb().delete(watcherProposals);
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(async () => {
	await reset();
	await enableAiRuntime();
	providerId = await seedProvider();
}, LIMIT);
afterEach(reset, LIMIT);

async function seedManaged(sessionId: string) {
	await getDb().insert(sessions).values({
		sessionId,
		agentType: "claude_code",
		status: "active",
		metadata: {},
		displayName: sessionId,
	});
	await getDb()
		.insert(supervisors)
		.values({
			id: SUPERVISOR,
			hostName: "h",
			platform: "linux",
			arch: "x64",
			version: "0",
			enrollmentState: "active",
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		})
		.onConflictDoNothing();
	const { launchId } = await seedOwnedLaunch(sessionId, SUPERVISOR);
	const now = new Date().toISOString();
	await getDb().insert(managedSessions).values({
		sessionId,
		launchRequestId: launchId,
		supervisorId: SUPERVISOR,
		managedState: "managed",
		createdAt: now,
		updatedAt: now,
	});
}

async function seedHitl(sessionId: string) {
	const turn = await seedFinishedTurn(sessionId);
	return seedProposalWithHitl({
		sessionId,
		providerId,
		prompt: PROMPT,
		turnKey: turn.turnKey,
		triggerEventId: turn.stopId,
	});
}

/**
 * Holds `lockSql` (a SELECT … FOR UPDATE, or an UPDATE) open in its own transaction while `start()` launches
 * the operations, waits until `parked` of them are blocked on a lock, then commits. Fails, rather than hangs,
 * if they never park, or if one settles while the lock is still held.
 */
async function behindRowLock<T>(
	lockSql: string,
	params: unknown[],
	start: Array<() => Promise<T>>,
	/** Run in the holder's transaction after every operation is parked and before it commits. */
	beforeCommit?: (holder: ReturnType<typeof postgres>) => Promise<void>,
): Promise<T[]> {
	const url = process.env.DATABASE_URL ?? "";
	const holder = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
	const monitor = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
	try {
		await holder.unsafe("BEGIN");
		await holder.unsafe(lockSql, params as never[]);
		const running: Promise<T>[] = [];
		const settled: boolean[] = [];
		const waitUntilParked = async (n: number) => {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const [{ count }] = (await monitor`
					SELECT count(*)::int AS count FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'`) as Array<{
					count: number;
				}>;
				if (count >= n) return;
				if (Date.now() > deadline)
					throw new Error(`only ${count} of ${n} operations parked on the row lock`);
				if (settled.some(Boolean))
					throw new Error("an operation finished while the row lock was still held");
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		// Started one at a time, each parked before the next begins, so the order they take the lock in is the order given.
		for (const [i, begin] of start.entries()) {
			const promise = begin();
			running.push(promise);
			settled.push(false);
			promise.then(
				() => {
					settled[i] = true;
				},
				() => {
					settled[i] = true;
				},
			);
			await waitUntilParked(i + 1);
		}
		await beforeCommit?.(holder);
		await holder.unsafe("COMMIT");
		return await Promise.all(running);
	} finally {
		await holder.unsafe("ROLLBACK").catch(() => undefined);
		await holder.end({ timeout: 1 });
		await monitor.end({ timeout: 1 });
	}
}

describePostgresOnly("interleaved: operations that have all read the same state", () => {
	test("interleaved: the lock guard. Two prompts that both saw a free session: one takes the lock, the other is ControlBusyError and leaves no action", async () => {
		await seedManaged("rc-1");
		const results = await behindRowLock(
			"SELECT 1 FROM managed_sessions WHERE session_id = $1 FOR UPDATE",
			["rc-1"],
			[
				() =>
					queuePromptAction("rc-1", "first", ctx.actor).then(
						(v) => ({ ok: true as const, v }),
						(e: unknown) => ({ ok: false as const, e }),
					),
				() =>
					queuePromptAction("rc-1", "second", ctx.actor).then(
						(v) => ({ ok: true as const, v }),
						(e: unknown) => ({ ok: false as const, e }),
					),
			],
		);

		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const lost = results.find((r) => !r.ok);
		expect(!lost?.ok && lost?.e).toBeInstanceOf(ControlBusyError);
		const actions = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.sessionId, "rc-1"));
		expect(actions).toHaveLength(1);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "rc-1"));
		expect(managed?.activeControlActionId).toBe(actions[0]?.id as string);
	});

	// Whichever operation parks on the lock first is released first, so each order is run: the guard
	// of the second one to run is what is under test, and it has to hold for a stop and for a prompt.
	for (const order of ["stop first", "prompt first"] as const) {
		test(`interleaved: the lock guard for a stop and a prompt (${order}). Both saw a free session: one takes the lock, the other is ControlBusyError`, async () => {
			const sessionId = order === "stop first" ? "rc-1s" : "rc-1p";
			await seedManaged(sessionId);
			const settle = <T>(p: Promise<T>) =>
				p.then(
					(v) => ({ ok: true as const, v }),
					(e: unknown) => ({ ok: false as const, e }),
				);
			const stop = () => settle(queueStopAction(sessionId, ctx.actor));
			const prompt = () => settle(queuePromptAction(sessionId, "hello", ctx.actor));
			const results = await behindRowLock(
				"SELECT 1 FROM managed_sessions WHERE session_id = $1 FOR UPDATE",
				[sessionId],
				order === "stop first" ? [stop, prompt] : [prompt, stop],
			);

			expect(results.filter((r) => r.ok)).toHaveLength(1);
			const lost = results.find((r) => !r.ok);
			expect(!lost?.ok && lost?.e).toBeInstanceOf(ControlBusyError);
			const actions = await getDb()
				.select()
				.from(controlActions)
				.where(eq(controlActions.sessionId, sessionId));
			expect(actions).toHaveLength(1);
		});
	}

	test("interleaved: double-decide. Two approvals that both saw the request open: one wins, the other is already_resolved, one delivery and one action exist", async () => {
		await seedManaged("rc-2");
		const { proposalId, hitlId } = await seedHitl("rc-2");
		const results = await behindRowLock(
			"SELECT 1 FROM ai_hitl_requests WHERE id = $1 FOR UPDATE",
			[hitlId],
			[
				() => decideHitl({ kind: "proposal", proposalId }, "approve", APPROVE, ctx),
				() => decideHitl({ kind: "hitl", hitlId }, "approve", APPROVE, ctx),
			],
		);

		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const lost = results.find((r) => !r.ok);
		expect(!lost?.ok && lost?.refusal).toMatchObject({ code: "already_resolved", status: 409 });
		expect(await getDb().select().from(aiHitlDeliveries)).toHaveLength(1);
		expect(await getDb().select().from(controlActions)).toHaveLength(1);
	});

	test("interleaved: retry. Two retries that both saw the attempt failed: one wins, the other is refused stale_proposal (the winner's prompt moved the turn on), one new action exists", async () => {
		await seedManaged("rc-3");
		const { proposalId } = await seedHitl("rc-3");
		await decideHitl({ kind: "proposal", proposalId }, "approve", APPROVE, ctx);
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });

		const results = await behindRowLock(
			"SELECT 1 FROM managed_sessions WHERE session_id = $1 FOR UPDATE",
			["rc-3"],
			[
				() => retryDelivery(proposalId, ctx, { confirm: true }),
				() => retryDelivery(proposalId, ctx, { confirm: true }),
			],
		);

		expect(results.filter((r) => r.ok)).toHaveLength(1);
		const lost = results.find((r) => !r.ok);
		// The winner's new prompt is itself a prompt after the trigger, so the loser finds the turn moved on.
		expect(!lost?.ok && lost?.refusal).toMatchObject({ code: "stale_proposal", status: 409 });
		expect(await getDb().select().from(controlActions)).toHaveLength(2);
		const [delivery] = await getDb().select().from(aiHitlDeliveries);
		expect(delivery?.attempt).toBe(2);
	});

	test("interleaved: a session deleted mid-decision. The decision parks on the request, the session goes (and the request with it): a clean 409, no delivery, no action, no lock", async () => {
		await seedManaged("rc-5");
		const { proposalId, hitlId } = await seedHitl("rc-5");
		const [result] = await behindRowLock(
			"SELECT 1 FROM ai_hitl_requests WHERE id = $1 FOR UPDATE",
			[hitlId],
			[() => decideHitl({ kind: "proposal", proposalId }, "approve", APPROVE, ctx)],
			async (holder) => {
				await holder.unsafe("DELETE FROM sessions WHERE session_id = $1", ["rc-5"]);
			},
		);

		expect(!result?.ok && result?.refusal).toMatchObject({ code: "already_resolved", status: 409 });
		expect(await getDb().select().from(aiHitlDeliveries)).toHaveLength(0);
		expect(await getDb().select().from(controlActions)).toHaveLength(0);
		expect(await getDb().select().from(managedSessions)).toHaveLength(0);
	});

	test("interleaved: a decision racing the sweeper. The sweep's close commits first: the decision is already_resolved and sends nothing", async () => {
		await seedManaged("rc-6");
		const { proposalId, hitlId } = await seedHitl("rc-6");
		const [result] = await behindRowLock(
			"SELECT 1 FROM ai_hitl_requests WHERE id = $1 FOR UPDATE",
			[hitlId],
			[() => decideHitl({ kind: "proposal", proposalId }, "approve", APPROVE, ctx)],
			async (holder) => {
				// what the sweep does to an overdue request, committed while the decision is parked on it
				await holder.unsafe("UPDATE ai_hitl_requests SET status = 'timed_out' WHERE id = $1", [
					hitlId,
				]);
			},
		);

		expect(!result?.ok && result?.refusal).toMatchObject({ code: "already_resolved", status: 409 });
		expect(await getDb().select().from(aiHitlDeliveries)).toHaveLength(0);
		expect(await getDb().select().from(controlActions)).toHaveLength(0);
		const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId));
		expect(row?.status).toBe("timed_out");
	});

	test("interleaved: the sweep after a decision that won finds nothing to close, and leaves the answer alone", async () => {
		await seedManaged("rc-7");
		const { proposalId, hitlId } = await seedHitl("rc-7");
		await decideHitl({ kind: "proposal", proposalId }, "approve", APPROVE, ctx);
		await getDb()
			.update(aiHitlRequests)
			.set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(aiHitlRequests.id, hitlId));
		const { expireOverdueHitl } = await import("./hitl-service.js");

		expect(await expireOverdueHitl()).toBe(0);

		const [row] = await getDb().select().from(aiHitlRequests).where(eq(aiHitlRequests.id, hitlId));
		expect(row?.status).toBe("applied");
	});

	test("interleaved: expiry versus completion. The supervisor's success commits while the lock's expiry is waiting on the row: the action stays succeeded", async () => {
		await seedManaged("rc-4");
		const { proposalId } = await seedHitl("rc-4");
		await decideHitl({ kind: "proposal", proposalId }, "approve", APPROVE, ctx);
		const [action] = await getDb().select().from(controlActions);
		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() });

		const url = process.env.DATABASE_URL ?? "";
		const holder = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
		const monitor = postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
		try {
			// the completion, mid-flight: the action is succeeded but not yet committed
			await holder.unsafe("BEGIN");
			await holder.unsafe("UPDATE control_actions SET status = 'succeeded' WHERE id = $1", [
				action?.id as string,
			]);
			const expiry = expireStaleControlLock(getDb(), "rc-4");
			const deadline = Date.now() + 30_000;
			for (;;) {
				const [{ n }] = (await monitor`
					SELECT count(*)::int AS n FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'`) as Array<{ n: number }>;
				if (n >= 1) break;
				if (Date.now() > deadline) throw new Error("the expiry never parked on the completing row");
				await new Promise((r) => setTimeout(r, 20));
			}
			await holder.unsafe("COMMIT");
			await expiry;
		} finally {
			await holder.unsafe("ROLLBACK").catch(() => undefined);
			await holder.end({ timeout: 1 });
			await monitor.end({ timeout: 1 });
		}

		const [after] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, action?.id as string));
		expect(after?.status).toBe("succeeded");
		expect(after?.error).toBeNull();
	});
});
