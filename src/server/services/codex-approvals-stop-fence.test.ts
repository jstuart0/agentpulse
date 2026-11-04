/**
 * The Stop fence (D16). The rule, stated plainly: no accept is issued after Stop
 * commits; an accept issued before Stop committed may still run. Stop only queues
 * and the host's sync takes no control lock, so the fence is atomic with queuing
 * and the issuing statement is the linearization point.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import { describePostgresOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { withAdminLock } = await import("../db/admin-lock.js");
const { codexApprovals, controlActions, managedSessions } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { behindRowLock } = await import("../test-utils/pg-row-lock.js");
const {
	ApprovalRefusal,
	answerApproval,
	deriveApprovalOutcome,
	recordApprovalRequest,
	sweepApprovals,
	syncApprovals,
} = await import("./codex-approvals.js");
const { ControlBusyError, enqueueStopInTx, queueStopAction } = await import("./control-actions.js");
const { ANONYMOUS_ACTOR } = await import("../auth/actor.js");

beforeAll(() => initializeDatabase());
const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

async function setup() {
	const sessionId = `sf-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `sf-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, clock, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];
const sync = (ctx: Ctx, live: string[]) =>
	syncApprovals(
		ctx.supervisorId,
		{ v: 1, live: live.map((approvalId) => ({ approvalId, revision: 1 })), resolved: [] },
		ctx.deps,
	);

async function pendingRow(ctx: Ctx, rpcId: string = crypto.randomUUID()) {
	const recorded = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport({ rpcId }),
		ctx.deps,
	);
	return recorded.response.approvalId;
}
async function acceptedRow(ctx: Ctx, options: { issue: boolean }) {
	const id = await pendingRow(ctx);
	const row = await rowOf(id);
	await answerApproval(
		ctx.sessionId,
		id,
		{ decision: "accept", presentationHash: row.presentationHash },
		harness.SOLO_PERSON,
		ctx.deps,
	);
	if (options.issue) await sync(ctx, [id]);
	return id;
}
const stop = (ctx: Ctx) => queueStopAction(ctx.sessionId, ANONYMOUS_ACTOR);

describe("Stop commits before a queued sync answer", () => {
	test("no accept is in answers, the id is in closed, and nothing was delivered", async () => {
		const ctx = await setup();
		const id = await acceptedRow(ctx, { issue: false });
		await stop(ctx);
		const response = await sync(ctx, [id]);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect(response.closed).toContain(id);
		expect(await rowOf(id)).toMatchObject({
			status: "closed",
			closedReason: "session_stopped",
			decision: "accept",
			firstDeliveredAt: null,
		});
	});

	test("an answered-undelivered accept reads approved_then_stopped", async () => {
		const ctx = await setup();
		const id = await acceptedRow(ctx, { issue: false });
		await stop(ctx);
		const row = await rowOf(id);
		expect(deriveApprovalOutcome(row, ctx.clock.now()).outcome).toBe("approved_then_stopped");
		expect((await harness.auditRows(ctx.sessionId))[0].outcome).toBe("session_stopped");
	});
});

describe("the issue commits, then Stop", () => {
	test("it is fenced, not re-issued as an accept, and reads may_have_run until the host reports", async () => {
		const ctx = await setup();
		const id = await acceptedRow(ctx, { issue: true });
		expect((await rowOf(id)).firstDeliveredAt).not.toBeNull();
		await stop(ctx);
		const row = await rowOf(id);
		expect(row).toMatchObject({ status: "answered" });
		expect(row.fencedAt).not.toBeNull();
		expect(row.firstDeliveredAt).not.toBeNull();
		expect(deriveApprovalOutcome(row, ctx.clock.now()).outcome).toBe("may_have_run");

		const response = await sync(ctx, [id]);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);

		await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [],
				resolved: [{ approvalId: id, outcome: "resolved_after_response", sentDecision: "accept" }],
			},
			ctx.deps,
		);
		expect(deriveApprovalOutcome(await rowOf(id), ctx.clock.now()).outcome).toBe("approved_sent");
	});
});

describe("a pending row and an answer after Stop", () => {
	test("a pending row closes session_stopped and answerApproval then says so", async () => {
		const ctx = await setup();
		const id = await pendingRow(ctx);
		await stop(ctx);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "session_stopped" });
		await expect(
			answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps),
		).rejects.toMatchObject({ code: "session_stopped" });
	});
});

describe("a row made after the fence", () => {
	test("with a Stop queued it can't be answered or issued, and the sweep closes it session_stopped", async () => {
		const ctx = await setup();
		const pending = await pendingRow(ctx, "late-pending");
		const answered = await acceptedRow(ctx, { issue: false });
		// The Stop commits and its fence missed both rows (a report that read "no Stop" committed after it).
		await harness.seedActiveStop(ctx.sessionId, "queued");

		const row = await rowOf(pending);
		await expect(
			answerApproval(
				ctx.sessionId,
				pending,
				{ decision: "accept", presentationHash: row.presentationHash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "session_stopped" });
		expect((await rowOf(pending)).status).toBe("pending");

		const response = await sync(ctx, [pending, answered]);
		expect(response.answers).toEqual([]);
		expect(response.closed).toContain(answered);
		expect(await rowOf(answered)).toMatchObject({
			status: "closed",
			closedReason: "session_stopped",
			firstDeliveredAt: null,
		});

		await sweepApprovals({}, ctx.deps);
		expect(await rowOf(pending)).toMatchObject({
			status: "closed",
			closedReason: "session_stopped",
		});
	});

	test("an accept the host already holds is fenced by the sweep rather than closed", async () => {
		const ctx = await setup();
		const id = await acceptedRow(ctx, { issue: true });
		await harness.seedActiveStop(ctx.sessionId, "running");
		await sweepApprovals({}, ctx.deps);
		const row = await rowOf(id);
		expect(row.status).toBe("answered");
		expect(row.fencedAt).not.toBeNull();
	});

	test("a report during a queued stop is session_stopping", async () => {
		const ctx = await setup();
		await harness.seedActiveStop(ctx.sessionId, "queued");
		await expect(
			recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ rpcId: "x" }),
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "session_stopping" });
	});
});

describe("the fence and the lock commit or roll back together", () => {
	test("a Stop refused control_busy fences nothing", async () => {
		const ctx = await setup();
		const id = await pendingRow(ctx);
		const holder = crypto.randomUUID();
		await getDb()
			.insert(controlActions)
			.values({ id: holder, sessionId: ctx.sessionId, actionType: "prompt", status: "running" });
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: holder,
				controlLockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.where(eq(managedSessions.sessionId, ctx.sessionId));
		await expect(stop(ctx)).rejects.toBeInstanceOf(ControlBusyError);
		expect((await rowOf(id)).status).toBe("pending");
		expect(
			await getDb()
				.select()
				.from(controlActions)
				.where(eq(controlActions.sessionId, ctx.sessionId)),
		).toHaveLength(1);
	});

	test("a failure after the fence rolls back the rows it closed and the lock it took", async () => {
		const ctx = await setup();
		const id = await pendingRow(ctx);
		await expect(
			withAdminLock(async (tx) => {
				const result = await enqueueStopInTx(tx, {
					sessionId: ctx.sessionId,
					actor: ANONYMOUS_ACTOR,
					controlActionId: crypto.randomUUID(),
				});
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.fencedApprovals).toHaveLength(1);
				throw new Error("roll back");
			}),
		).rejects.toThrow("roll back");
		expect((await rowOf(id)).status).toBe("pending");
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, ctx.sessionId));
		expect(managed.activeControlActionId).toBeNull();
	});

	test("the Stop that commits reports the rows it closed to run their side effects after the commit", async () => {
		const ctx = await setup();
		const id = await pendingRow(ctx);
		const result = await withAdminLock((tx) =>
			enqueueStopInTx(tx, {
				sessionId: ctx.sessionId,
				actor: ANONYMOUS_ACTOR,
				controlActionId: crypto.randomUUID(),
			}),
		);
		expect(result.ok && result.fencedApprovals.map((c) => c.approvalId)).toEqual([id]);
	});
});

describe("Stop writers (P11)", () => {
	test("exactly one non-test file queues a stop: control-actions.ts", () => {
		const root = join(import.meta.dir, "..");
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (
					name.endsWith(".ts") &&
					!name.endsWith(".test.ts") &&
					readFileSync(full, "utf8").includes('actionType: "stop"')
				) {
					found.push(full.slice(root.length + 1));
				}
			}
		};
		walk(root);
		expect(found.length).toBeGreaterThanOrEqual(1);
		expect(found).toContain("services/control-actions.ts");
		expect(found).toEqual(["services/control-actions.ts"]);
	});
});

describePostgresOnly("true concurrency on Postgres", () => {
	/** After both operations: an accept in the sync's answers means the row was issued and fenced; none means it was closed undelivered. */
	async function expectConsistent(id: string, answers: Array<{ decision: string }>) {
		const row = await rowOf(id);
		if (answers.some((a) => a.decision === "accept")) {
			expect(row.firstDeliveredAt).not.toBeNull();
			expect(row.status).toBe("answered");
			expect(row.fencedAt).not.toBeNull();
		} else {
			expect(row).toMatchObject({
				status: "closed",
				closedReason: "session_stopped",
				firstDeliveredAt: null,
			});
		}
	}

	for (const order of ["stop first", "sync first"] as const) {
		test(`behind one row lock, ${order}: the issue and the fence each win or lose, never both`, async () => {
			const ctx = await setup();
			const id = await acceptedRow(ctx, { issue: false });
			type Result = { kind: "stop" } | { kind: "sync"; answers: Array<{ decision: string }> };
			const doStop = (): Promise<Result> => stop(ctx).then(() => ({ kind: "stop" }));
			const doSync = (): Promise<Result> =>
				sync(ctx, [id]).then((r) => ({ kind: "sync", answers: r.answers }));
			const operations = order === "stop first" ? [doStop, doSync] : [doSync, doStop];
			const results = await behindRowLock(
				"SELECT 1 FROM codex_approvals WHERE id = $1 FOR UPDATE",
				[id],
				operations,
			);
			const syncResult = results.find((r) => r.kind === "sync");
			expect(syncResult?.kind).toBe("sync");
			await expectConsistent(id, syncResult?.kind === "sync" ? syncResult.answers : []);
		});
	}

	test("30 unsynchronised rounds of Stop against a sync keep the invariant", async () => {
		for (let round = 0; round < 30; round++) {
			const ctx = await setup();
			const id = await acceptedRow(ctx, { issue: false });
			const [, syncResult] = await Promise.all([stop(ctx), sync(ctx, [id])]);
			await expectConsistent(id, syncResult.answers);
			await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
		}
	});
});

void ApprovalRefusal;
