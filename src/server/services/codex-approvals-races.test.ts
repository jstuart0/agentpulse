/**
 * Transitions and races for Codex approvals: a table over (state, event) with a
 * fake clock asserting the final `closed_reason`, the invariants (answered at
 * most once, `decision` never changes, `closed` never reopens, `closed_reason`
 * never changes), and the named interleavings. True concurrency runs on Postgres
 * behind a row lock; SQLite serializes every transaction on one connection, so
 * its sequential equivalents are the same calls back to back.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import { describePostgresOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovals, users } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { behindRowLock } = await import("../test-utils/pg-row-lock.js");
const {
	ApprovalRefusal,
	answerApproval,
	closeApproval,
	closeApprovalsForRestartedHost,
	recordApprovalRequest,
	sweepApprovals,
	syncApprovals,
} = await import("./codex-approvals.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");
const { CODEX_APPROVAL_TTL_MS } = await import("../../shared/codex-approvals.js");
import type { TrackerOutcome } from "../../shared/codex-approvals.js";

beforeAll(() => initializeDatabase());
const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

async function setup() {
	const sessionId = `rc-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `rc-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, clock, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];
const sync = (
	ctx: Ctx,
	live: string[],
	resolved: Array<{
		approvalId: string;
		outcome: TrackerOutcome;
		sentDecision: "accept" | "decline" | "cancel" | null;
	}> = [],
) =>
	syncApprovals(
		ctx.supervisorId,
		{ v: 1, live: live.map((approvalId) => ({ approvalId, revision: 1 })), resolved },
		ctx.deps,
	);
const record = async (ctx: Ctx, overrides: Parameters<typeof harness.commandReport>[0] = {}) =>
	(
		await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ rpcId: crypto.randomUUID(), ...overrides }),
			ctx.deps,
		)
	).response.approvalId;
const accept = async (ctx: Ctx, id: string, caller = harness.SOLO_PERSON) =>
	answerApproval(
		ctx.sessionId,
		id,
		{ decision: "accept", presentationHash: (await rowOf(id)).presentationHash },
		caller,
		ctx.deps,
	);
const decline = (ctx: Ctx, id: string) =>
	answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
const refusal = async (run: () => Promise<unknown>) => {
	try {
		await run();
		return "ok";
	} catch (error) {
		if (error instanceof ApprovalRefusal) return error.code;
		throw error;
	}
};

type State = "pending" | "accepted" | "accepted+issued" | "declined" | "closed:applied";
async function inState(ctx: Ctx, state: State): Promise<string> {
	const id = await record(ctx);
	if (state === "pending") return id;
	if (state === "declined") {
		await decline(ctx, id);
		return id;
	}
	await accept(ctx, id);
	if (state === "accepted+issued" || state === "closed:applied") await sync(ctx, [id]);
	if (state === "closed:applied")
		await sync(
			ctx,
			[id],
			[{ approvalId: id, outcome: "resolved_after_response", sentDecision: "accept" }],
		);
	return id;
}

describe("(state, event) -> final state", () => {
	type Event =
		| "expiry"
		| "window_passes"
		| "five_minutes_after_issue"
		| "host_runtime_gone"
		| "host_interrupted"
		| "host_applied"
		| "host_declined_locally"
		| "session_ends"
		| "host_restarts"
		| "stop";
	const fire: Record<Event, (ctx: Ctx, id: string) => Promise<void>> = {
		expiry: async (ctx) => {
			ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1);
			await sweepApprovals({}, ctx.deps);
		},
		window_passes: async (ctx) => {
			ctx.clock.advance(61_000);
			await sweepApprovals({}, ctx.deps);
		},
		five_minutes_after_issue: async (ctx) => {
			ctx.clock.advance(5 * 60_000 + 1_000);
			await sweepApprovals({}, ctx.deps);
		},
		host_runtime_gone: async (ctx, id) =>
			void (await sync(
				ctx,
				[id],
				[{ approvalId: id, outcome: "runtime_gone", sentDecision: null }],
			)),
		host_interrupted: async (ctx, id) =>
			void (await sync(
				ctx,
				[id],
				[{ approvalId: id, outcome: "resolved_before_response", sentDecision: null }],
			)),
		host_applied: async (ctx, id) =>
			void (await sync(
				ctx,
				[id],
				[{ approvalId: id, outcome: "resolved_after_response", sentDecision: "decline" }],
			)),
		host_declined_locally: async (ctx, id) =>
			void (await sync(
				ctx,
				[id],
				[{ approvalId: id, outcome: "declined_local", sentDecision: "decline" }],
			)),
		session_ends: async (ctx) =>
			void (await upsertManagedSessionState(ctx.supervisorId, {
				sessionId: ctx.sessionId,
				managedState: "stopped",
			})),
		host_restarts: async (ctx) =>
			void (await closeApprovalsForRestartedHost(ctx.supervisorId, ctx.deps)),
		stop: async (ctx) => {
			const { queueStopAction } = await import("./control-actions.js");
			const { ANONYMOUS_ACTOR } = await import("../auth/actor.js");
			await queueStopAction(ctx.sessionId, ANONYMOUS_ACTOR);
		},
	};

	// null reason = the row is still open afterwards.
	const table: Array<[State, Event, string | null]> = [
		["pending", "expiry", "expired"],
		["pending", "window_passes", null],
		["pending", "host_runtime_gone", "runtime_gone"],
		["pending", "host_interrupted", "interrupted"],
		["pending", "host_declined_locally", "expired"],
		["pending", "session_ends", "session_stopped"],
		["pending", "host_restarts", "runtime_gone"],
		["pending", "stop", "session_stopped"],
		["accepted", "expiry", "answer_lapsed"],
		["accepted", "window_passes", "answer_lapsed"],
		["accepted", "host_runtime_gone", "runtime_gone"],
		["accepted", "host_interrupted", "interrupted"],
		["accepted", "host_declined_locally", "answer_lapsed"],
		["accepted", "session_ends", "session_stopped"],
		["accepted", "host_restarts", "runtime_gone"],
		["accepted", "stop", "session_stopped"],
		["accepted+issued", "window_passes", null],
		["accepted+issued", "five_minutes_after_issue", "outcome_unknown"],
		["accepted+issued", "host_runtime_gone", "runtime_gone"],
		["accepted+issued", "host_interrupted", "interrupted"],
		["accepted+issued", "host_declined_locally", "answer_lapsed"],
		["accepted+issued", "session_ends", "outcome_unknown"],
		["accepted+issued", "host_restarts", "outcome_unknown"],
		["accepted+issued", "stop", null],
		["declined", "expiry", "applied"],
		["declined", "host_applied", "applied"],
		["declined", "host_runtime_gone", "runtime_gone"],
		["declined", "host_interrupted", "interrupted"],
		["declined", "host_declined_locally", "applied"],
		["declined", "session_ends", "session_stopped"],
		["declined", "stop", "session_stopped"],
		["closed:applied", "expiry", "applied"],
		["closed:applied", "host_runtime_gone", "applied"],
		["closed:applied", "host_interrupted", "applied"],
		["closed:applied", "session_ends", "applied"],
		["closed:applied", "host_restarts", "applied"],
		["closed:applied", "stop", "applied"],
	];

	for (const [state, event, reason] of table) {
		test(`${state} + ${event} -> ${reason ?? "still open"}`, async () => {
			const ctx = await setup();
			const id = await inState(ctx, state);
			const before = await rowOf(id);
			await fire[event](ctx, id);
			const after = await rowOf(id);
			if (reason === null) {
				expect(after.status).not.toBe("closed");
			} else {
				expect(after.status).toBe("closed");
				expect(after.closedReason).toBe(reason);
			}
			// Invariants over every transition.
			expect(after.decision).toBe(before.decision);
			if (before.status === "closed") {
				expect(after.status).toBe("closed");
				expect(after.closedReason).toBe(before.closedReason);
			}
			expect(after.presentationHash).toBe(before.presentationHash);
			expect(after.expiresAt).toBe(before.expiresAt);
		});
	}
});

describe("closed never reopens, closed_reason never changes", () => {
	test("closeApproval on a closed row changes nothing and the first reason stands", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const first = await sweepAfterExpiry(ctx, id);
		expect(first).toBe("expired");
		const again = await closeApprovalOnce(id, "runtime_gone", ctx);
		expect(again).toBeNull();
		expect((await rowOf(id)).closedReason).toBe("expired");
	});

	test("every writer of a closed row's status, decision and reason is a no-op", async () => {
		const ctx = await setup();
		const id = await inState(ctx, "closed:applied");
		const closed = await rowOf(id);
		expect(await refusal(() => accept(ctx, id))).toBe("already_resolved");
		expect(await refusal(() => decline(ctx, id))).toBe("already_resolved");
		await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ rpcId: closed.rpcId, revision: 99 }),
			ctx.deps,
		);
		await sync(ctx, [id], [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }]);
		await sweepApprovals({}, ctx.deps);
		expect(await rowOf(id)).toEqual(closed);
	});

	async function sweepAfterExpiry(ctx: Ctx, id: string) {
		ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1);
		await sweepApprovals({}, ctx.deps);
		return (await rowOf(id)).closedReason;
	}
	async function closeApprovalOnce(id: string, reason: "runtime_gone", ctx: Ctx) {
		const { withTransaction } = await import("../db/with-transaction.js");
		return withTransaction((tx) => closeApproval(tx, id, reason, ctx.clock.now()));
	}
});

describe("named interleavings", () => {
	test("the sweep's outcome_unknown, then a late resolved_after_response: it stays outcome_unknown", async () => {
		const ctx = await setup();
		const id = await inState(ctx, "accepted+issued");
		ctx.clock.advance(5 * 60_000 + 1_000);
		await sweepApprovals({}, ctx.deps);
		await sync(
			ctx,
			[id],
			[{ approvalId: id, outcome: "resolved_after_response", sentDecision: "accept" }],
		);
		expect((await rowOf(id)).closedReason).toBe("outcome_unknown");
	});

	test("accept vs expiry: one millisecond before expires_at it is taken, at expires_at it is expired", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const expiresMs = Date.parse((await rowOf(id)).expiresAt);
		ctx.clock.set(expiresMs);
		expect(await refusal(() => accept(ctx, id))).toBe("expired");
		ctx.clock.set(expiresMs - 1);
		expect(await refusal(() => accept(ctx, id))).toBe("ok");
	});

	test("a sweep that decided on a stale read can't close a row that was answered meanwhile", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const stale = await rowOf(id);
		await decline(ctx, id);
		const { withTransaction } = await import("../db/with-transaction.js");
		const closed = await withTransaction((tx) =>
			closeApproval(tx, stale.id, "expired", ctx.clock.now() + CODEX_APPROVAL_TTL_MS + 1, {
				fromStatus: "pending",
			}),
		);
		expect(closed).toBeNull();
		expect((await rowOf(id)).status).toBe("answered");
	});

	test("accept vs the 60 s edge: issued at exactly 60 s, never at 60 s and 1 ms", async () => {
		const ctx = await setup();
		const first = await record(ctx);
		await accept(ctx, first);
		ctx.clock.advance(60_000);
		expect((await sync(ctx, [first])).answers.map((a) => a.decision)).toEqual(["accept"]);
		const second = await record(ctx);
		await accept(ctx, second);
		ctx.clock.advance(60_001);
		const response = await sync(ctx, [second]);
		expect(response.answers.filter((a) => a.approvalId === second)).toEqual([]);
		expect((await rowOf(second)).closedReason).toBe("answer_lapsed");
	});

	test("accept vs sweep: a sweep before the sync closes it answer_lapsed and the sync then issues nothing", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		ctx.clock.advance(61_000);
		await sweepApprovals({}, ctx.deps);
		const response = await sync(ctx, [id]);
		expect(response.answers).toEqual([]);
		expect(response.closed).toContain(id);
		expect((await rowOf(id)).firstDeliveredAt).toBeNull();
	});

	test("accept vs runtime_gone: the host reporting the runtime gone first wins, and the accept is never issued", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await sync(ctx, [id], [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }]);
		expect(await refusal(() => accept(ctx, id))).toBe("already_resolved");
		expect((await sync(ctx, [id])).answers).toEqual([]);
	});

	test("a higher revision vs an in-flight accept: an accept of the old hash is presentation_changed", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "npm test", revision: 1 });
		const oldHash = (await rowOf(id)).presentationHash;
		await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({
				rpcId: (await rowOf(id)).rpcId,
				command: "rm -rf /",
				revision: 2,
			}),
			ctx.deps,
		);
		expect(
			await refusal(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: oldHash },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("presentation_changed");
		expect((await rowOf(id)).status).toBe("pending");
		expect(await refusal(() => accept(ctx, id))).toBe("ok");
	});

	test("a report landing after a sync body: 29 s the row stays, 31 s it is closed runtime_gone", async () => {
		for (const [seconds, closed] of [
			[29, false],
			[31, true],
		] as const) {
			const ctx = await setup();
			const id = await record(ctx);
			ctx.clock.advance(seconds * 1000);
			await sync(ctx, []);
			expect((await rowOf(id)).status === "closed").toBe(closed);
		}
	});

	test("a replayed state report can't close a row that is newer than it", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await upsertManagedSessionState(
			ctx.supervisorId,
			{ sessionId: ctx.sessionId, status: "completed" },
			{ replay: true },
		);
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("an accept whose approver was disabled before issue closes answer_withdrawn; a changed owner does too; a null user passes", async () => {
		const ctx = await setup();
		await harness.seedUser("approver-a", { role: "user" });
		const approver = harness.teamCaller("approver-a", "member");
		const { setStoredMode } = await import("../test-utils/team-fixtures.js");
		const { sessions } = await import("../db/schema/index.js");
		await setStoredMode("team");
		try {
			await getDb()
				.update(sessions)
				.set({ ownerUserId: "approver-a" })
				.where(eq(sessions.sessionId, ctx.sessionId));

			const disabled = await record(ctx);
			await accept(ctx, disabled, approver);
			await getDb()
				.update(users)
				.set({ disabledAt: new Date().toISOString() })
				.where(eq(users.id, "approver-a"));
			expect((await sync(ctx, [disabled])).answers).toEqual([]);
			expect((await rowOf(disabled)).closedReason).toBe("answer_withdrawn");
			await getDb().update(users).set({ disabledAt: null }).where(eq(users.id, "approver-a"));

			const handedOver = await record(ctx);
			await accept(ctx, handedOver, approver);
			await getDb()
				.update(sessions)
				.set({ ownerUserId: "someone-else" })
				.where(eq(sessions.sessionId, ctx.sessionId));
			expect((await sync(ctx, [handedOver])).answers).toEqual([]);
			expect((await rowOf(handedOver)).closedReason).toBe("answer_withdrawn");

			const nullUser = await record(ctx);
			await accept(ctx, nullUser, harness.teamCaller(null, "admin", { human: true }));
			expect((await sync(ctx, [nullUser])).answers).toHaveLength(1);
		} finally {
			await getDb().delete(users).where(eq(users.id, "approver-a"));
			const { clearInstanceSettings } = await import("../test-utils/team-fixtures.js");
			await clearInstanceSettings();
		}
	});

	test("an accept that was already issued is not re-judged on a repeat issue", async () => {
		const ctx = await setup();
		const id = await inState(ctx, "accepted+issued");
		await getDb()
			.update(codexApprovals)
			.set({ answeredByUserId: "ghost-user" })
			.where(eq(codexApprovals.id, id));
		const response = await sync(ctx, [id]);
		expect(response.answers.map((a) => a.decision)).toEqual(["accept"]);
	});
});

describePostgresOnly("true concurrency on Postgres, behind one row lock", () => {
	test("two answers race: exactly one wins, the other is already_resolved, one audit row", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const hash = (await rowOf(id)).presentationHash;
		const results = await behindRowLock(
			"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
			[id],
			[
				() =>
					refusal(() =>
						answerApproval(
							ctx.sessionId,
							id,
							{ decision: "accept", presentationHash: hash },
							harness.SOLO_PERSON,
							ctx.deps,
						),
					),
				() =>
					refusal(() =>
						answerApproval(
							ctx.sessionId,
							id,
							{ decision: "decline" },
							harness.SOLO_PERSON,
							ctx.deps,
						),
					),
			],
		);
		expect(results.filter((r) => r === "ok")).toHaveLength(1);
		expect(results.filter((r) => r === "already_resolved")).toHaveLength(1);
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(1);
		const row = await rowOf(id);
		expect(row.decision).toBe(results[0] === "ok" ? "accept" : "decline");
	});

	test("answer vs expiry: whichever commits first wins and the other changes nothing", async () => {
		for (const order of ["answer first", "sweep first"] as const) {
			const ctx = await setup();
			const id = await record(ctx);
			const answerClock = { now: () => ctx.clock.now() };
			const sweepClock = { now: () => ctx.clock.now() + CODEX_APPROVAL_TTL_MS + 1 };
			const doAnswer = () =>
				refusal(() =>
					answerApproval(
						ctx.sessionId,
						id,
						{ decision: "decline" },
						harness.SOLO_PERSON,
						answerClock,
					),
				);
			const doSweep = () => sweepApprovals({}, sweepClock).then(() => "swept");
			const ops = order === "answer first" ? [doAnswer, doSweep] : [doSweep, doAnswer];
			const results = await behindRowLock(
				"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
				[id],
				ops,
			);
			const row = await rowOf(id);
			if (order === "answer first") {
				expect(results).toContain("ok");
				expect(row).toMatchObject({ status: "answered", decision: "decline" });
			} else {
				expect(results).toContain("expired");
				expect(row).toMatchObject({ status: "closed", closedReason: "expired", decision: null });
			}
			await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
		}
	});

	test("answer vs the host reporting the runtime gone: one winner, a consistent row and audit", async () => {
		for (const order of ["answer first", "report first"] as const) {
			const ctx = await setup();
			const id = await record(ctx);
			const hash = (await rowOf(id)).presentationHash;
			const doAnswer = () =>
				refusal(() =>
					answerApproval(
						ctx.sessionId,
						id,
						{ decision: "accept", presentationHash: hash },
						harness.SOLO_PERSON,
						ctx.deps,
					),
				);
			const doReport = () =>
				sync(ctx, [id], [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }]).then(
					() => "reported",
				);
			const ops = order === "answer first" ? [doAnswer, doReport] : [doReport, doAnswer];
			const results = await behindRowLock(
				"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
				[id],
				ops,
			);
			const row = await rowOf(id);
			expect(row.status).toBe("closed");
			expect(row.closedReason).toBe("runtime_gone");
			const audit = await harness.auditRows(ctx.sessionId);
			if (results.includes("ok")) {
				expect(audit).toHaveLength(1);
				expect(audit[0].outcome).toBe("runtime_gone");
				expect(row.firstDeliveredAt).toBeNull();
			} else {
				expect(audit).toHaveLength(0);
			}
			await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
		}
	});

	test("a higher revision vs an in-flight accept: the hash guard lets exactly one of them win", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "npm test", revision: 1 });
		const row = await rowOf(id);
		const results = await behindRowLock(
			"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
			[id],
			[
				() =>
					refusal(() =>
						answerApproval(
							ctx.sessionId,
							id,
							{ decision: "accept", presentationHash: row.presentationHash },
							harness.SOLO_PERSON,
							ctx.deps,
						),
					),
				() =>
					recordApprovalRequest(
						ctx.supervisorId,
						ctx.sessionId,
						harness.commandReport({
							rpcId: row.rpcId,
							command: "rm -rf /",
							revision: 2,
						}),
						ctx.deps,
					).then(() => "revised"),
			],
		);
		const after = await rowOf(id);
		if (results[0] === "ok") {
			// The accept took the row first: it is bound to the text it was shown, and the revision didn't land.
			expect(after).toMatchObject({
				status: "answered",
				presentationRevision: 1,
				presentationHash: row.presentationHash,
			});
		} else {
			expect(results[0]).toBe("presentation_changed");
			expect(after).toMatchObject({ status: "pending", presentationRevision: 2 });
		}
	});
	test("a fence landing between the sync's read and its issue stops the issue: a decline, never the accept", async () => {
		const ctx = await setup();
		const id = await inState(ctx, "accepted+issued");
		const lock = "SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE";
		const [response] = await behindRowLock(lock, [id], [() => sync(ctx, [id])], async (holder) => {
			await holder.unsafe("UPDATE codex_approvals SET fenced_at = $1 WHERE id = $2", [
				new Date(ctx.clock.now()).toISOString(),
				id,
			]);
		});
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
		expect((await rowOf(id)).fencedAt).not.toBeNull();
	});

	test("two re-reports of different revisions racing: the higher one stands whichever lands last", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "npm test", revision: 1 });
		const rpcId = (await rowOf(id)).rpcId;
		const report = (revision: number) => () =>
			recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ rpcId, command: `npm run v${revision}`, revision }),
				ctx.deps,
			);
		await behindRowLock(
			"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
			[id],
			[report(3), report(2)],
		);
		const row = await rowOf(id);
		expect(row.presentationRevision).toBe(3);
		expect(row.presentation).toContain("npm run v3");
	});

	test("the sweep closing an undelivered accept loses to an issue that lands first, and the row stays answered", async () => {
		const ctx = await setup();
		const id = await inState(ctx, "accepted");
		await harness.seedActiveStop(ctx.sessionId, "queued");
		await behindRowLock(
			"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
			[id],
			[() => sweepApprovals({}, ctx.deps)],
			async (holder) => {
				await holder.unsafe("UPDATE codex_approvals SET first_delivered_at = $1 WHERE id = $2", [
					new Date(ctx.clock.now()).toISOString(),
					id,
				]);
			},
		);
		const row = await rowOf(id);
		expect(row.status).toBe("answered");
		expect(row.firstDeliveredAt).not.toBeNull();
	});
});
