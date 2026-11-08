/**
 * The turn fence of Stop turn (AGEN-119, F5/F36). The rule: no accept is issued for a turn after its Stop turn
 * commits; an accept issued before may still run. Unlike the Stop fence it is scoped to one turn (`turn_id` is
 * the Claude prompt's action id), closes `turn_stopped`, takes no lock, and a FAILED interrupt lifts it.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { CLAUDE_STOP, CLAUDE_TURN_CONTROL } from "../../shared/constants.js";
import { CLAUDE_TAKEOVER } from "../../shared/session-resume.js";
import { CLAUDE_TURN_INTERRUPT } from "../../shared/stop-turn.js";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { withAdminLock } = await import("../db/admin-lock.js");
const { codexApprovals, controlActions, launchRequests, managedSessions, supervisors } =
	await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const {
	answerApproval,
	deriveApprovalOutcome,
	recordApprovalRequest,
	runApprovalClosedEffects,
	syncApprovals,
} = await import("./codex-approvals.js");
const { enqueueInterruptInTx } = await import("./control-actions.js");
const { fenceApprovalsForTurn } = await import("./codex-approvals-fence.js");
const { ANONYMOUS_ACTOR } = await import("../auth/actor.js");

beforeAll(() => initializeDatabase());
const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

const FEATURES = [CLAUDE_STOP, CLAUDE_TURN_CONTROL, CLAUDE_TAKEOVER, CLAUDE_TURN_INTERRUPT];

/** A continued Claude session with a running prompt that holds the lock. */
async function setup() {
	const sessionId = `tf-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `tf-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId, agentType: "claude_code" });
	await getDb()
		.update(launchRequests)
		.set({ metadata: { boundObservedSession: true } })
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	await getDb()
		.update(supervisors)
		.set({ capabilities: { version: 1, features: FEATURES } as never })
		.where(eq(supervisors.id, supervisorId));
	const promptId = crypto.randomUUID();
	await getDb()
		.insert(controlActions)
		.values({
			id: promptId,
			sessionId,
			actionType: "prompt",
			status: "running",
			claimedBySupervisorId: supervisorId,
			metadata: { agentType: "claude_code", runtime: "claude_stream" },
		});
	await getDb()
		.update(managedSessions)
		.set({
			activeControlActionId: promptId,
			controlLockExpiresAt: new Date(Date.now() + 90_000).toISOString(),
		})
		.where(eq(managedSessions.sessionId, sessionId));
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, promptId, clock, deps: { now: clock.now } };
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

async function pendingRow(ctx: Ctx, turnId: string, rpcId: string = crypto.randomUUID()) {
	const recorded = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport({ rpcId, turnId }),
		ctx.deps,
	);
	return recorded.response.approvalId;
}
async function acceptedRow(ctx: Ctx, turnId: string, options: { issue: boolean }) {
	const id = await pendingRow(ctx, turnId);
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
async function interrupt(ctx: Ctx) {
	const result = await withAdminLock((tx) =>
		enqueueInterruptInTx(tx, { sessionId: ctx.sessionId, actor: ANONYMOUS_ACTOR }),
	);
	expect(result.ok).toBe(true);
	if (result.ok) await runApprovalClosedEffects(result.fencedApprovals, ctx.deps);
	return result as Extract<typeof result, { ok: true }>;
}
const setInterrupt = (status: string) =>
	getDb().update(controlActions).set({ status }).where(eq(controlActions.actionType, "interrupt"));

describe("what the fence closes: every open row of the session (review M5)", () => {
	test("pending and answered-undelivered rows close turn_stopped, whatever turn id the host gave them", async () => {
		const ctx = await setup();
		const pending = await pendingRow(ctx, ctx.promptId);
		const answered = await acceptedRow(ctx, ctx.promptId, { issue: false });
		const older = await pendingRow(ctx, "older-turn");
		const next = await pendingRow(ctx, "next-turn");
		await interrupt(ctx);
		expect(await rowOf(pending)).toMatchObject({ status: "closed", closedReason: "turn_stopped" });
		expect(await rowOf(answered)).toMatchObject({
			status: "closed",
			closedReason: "turn_stopped",
			decision: "accept",
			firstDeliveredAt: null,
		});
		// The turn id is the host's word: a request naming another turn does not escape a person's Stop.
		expect(await rowOf(older)).toMatchObject({ status: "closed", closedReason: "turn_stopped" });
		expect(await rowOf(next)).toMatchObject({ status: "closed", closedReason: "turn_stopped" });
		expect(deriveApprovalOutcome(await rowOf(answered), ctx.clock.now()).outcome).toBe(
			"turn_stopped",
		);
		expect((await harness.auditRows(ctx.sessionId)).map((a) => a.outcome).sort()).toContain(
			"turn_stopped",
		);
	});

	test("the session is not stopped: no Stop is the lock holder and the prompt still holds it", async () => {
		const ctx = await setup();
		await pendingRow(ctx, ctx.promptId);
		await interrupt(ctx);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, ctx.sessionId));
		expect(managed?.activeControlActionId).toBe(ctx.promptId);
	});

	test("an accept already issued is fenced, kept as 'may have run', and never issued again", async () => {
		const ctx = await setup();
		const id = await acceptedRow(ctx, ctx.promptId, { issue: true });
		expect((await rowOf(id)).firstDeliveredAt).not.toBeNull();
		await interrupt(ctx);
		const row = await rowOf(id);
		expect(row.status).toBe("answered");
		expect(row.fencedAt).not.toBeNull();
		expect(deriveApprovalOutcome(row, ctx.clock.now()).outcome).toBe("may_have_run");
		const response = await sync(ctx, [id]);
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
	});
});

describe("an accept racing the enqueue, in both orders", () => {
	test("the interrupt commits first: the accept is refused turn_interrupted and nothing was delivered", async () => {
		const ctx = await setup();
		const id = await pendingRow(ctx, ctx.promptId);
		const hash = (await rowOf(id)).presentationHash;
		await interrupt(ctx);
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: hash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "turn_interrupted" });
		expect((await rowOf(id)).firstDeliveredAt).toBeNull();
	});

	test("the guarded answer itself refuses while an interrupt names the turn (the row the fence missed)", async () => {
		const ctx = await setup();
		const id = await pendingRow(ctx, ctx.promptId);
		const hash = (await rowOf(id)).presentationHash;
		// An interrupt committed whose fence missed this row (it reported after the fence read).
		await getDb()
			.insert(controlActions)
			.values({
				id: crypto.randomUUID(),
				sessionId: ctx.sessionId,
				actionType: "interrupt",
				status: "queued",
				metadata: { runtime: "claude_stream", targetPromptActionId: ctx.promptId },
			});
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: hash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "turn_interrupted" });
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("the answer commits first: the fence then closes the never-issued accept turn_stopped", async () => {
		const ctx = await setup();
		const id = await acceptedRow(ctx, ctx.promptId, { issue: false });
		await interrupt(ctx);
		const response = await sync(ctx, [id]);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect(await rowOf(id)).toMatchObject({
			status: "closed",
			closedReason: "turn_stopped",
			firstDeliveredAt: null,
		});
	});

	test("the sync's issue: a row the fence missed is closed turn_stopped when undelivered, fenced when issued", async () => {
		const ctx = await setup();
		const undelivered = await acceptedRow(ctx, ctx.promptId, { issue: false });
		await getDb()
			.insert(controlActions)
			.values({
				id: crypto.randomUUID(),
				sessionId: ctx.sessionId,
				actionType: "interrupt",
				status: "running",
				metadata: { runtime: "claude_stream", targetPromptActionId: ctx.promptId },
			});
		const response = await sync(ctx, [undelivered]);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect(response.closed).toContain(undelivered);
		expect(await rowOf(undelivered)).toMatchObject({
			status: "closed",
			closedReason: "turn_stopped",
		});
	});
});

describe("a request that names another turn id than the one stopped (review M5)", () => {
	test("the sync's issue still refuses it while the interrupt is open, and the answer is refused turn_interrupted", async () => {
		const ctx = await setup();
		const undelivered = await acceptedRow(ctx, "lying-turn-id", { issue: false });
		const pending = await pendingRow(ctx, "another-lying-id");
		const hash = (await rowOf(pending)).presentationHash;
		await getDb()
			.insert(controlActions)
			.values({
				id: crypto.randomUUID(),
				sessionId: ctx.sessionId,
				actionType: "interrupt",
				status: "running",
				metadata: { runtime: "claude_stream", targetPromptActionId: ctx.promptId },
			});
		await expect(
			answerApproval(
				ctx.sessionId,
				pending,
				{ decision: "accept", presentationHash: hash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "turn_interrupted" });
		const response = await sync(ctx, [undelivered]);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect(await rowOf(undelivered)).toMatchObject({
			status: "closed",
			closedReason: "turn_stopped",
		});
	});
});

describe("a request reported on a fenced turn", () => {
	test("is refused turn_interrupted (the host declines that one request) and nothing is stored", async () => {
		const ctx = await setup();
		await interrupt(ctx);
		await expect(
			recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ turnId: ctx.promptId, rpcId: "late" }),
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "turn_interrupted" });
		expect(await harness.approvalRows(ctx.sessionId)).toHaveLength(0);
	});

	test("a request naming ANOTHER turn id is refused while the interrupt is open (the host's turn id is not trusted)", async () => {
		const ctx = await setup();
		await interrupt(ctx);
		await expect(pendingRow(ctx, "some-other-turn")).rejects.toMatchObject({
			code: "turn_interrupted",
		});
		expect(await harness.approvalRows(ctx.sessionId)).toHaveLength(0);
	});

	test("a request of the NEXT turn is not refused once the interrupt has succeeded: the session is alive", async () => {
		const ctx = await setup();
		await interrupt(ctx);
		await setInterrupt("succeeded");
		const id = await pendingRow(ctx, "next-turn");
		expect((await rowOf(id)).status).toBe("pending");
	});
});

describe("a failed interrupt lifts the fence on the server too", () => {
	test("after it fails, an answer is accepted, a report is taken and the issue works", async () => {
		const ctx = await setup();
		await interrupt(ctx);
		await setInterrupt("failed");
		const id = await pendingRow(ctx, ctx.promptId);
		const row = await rowOf(id);
		await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "accept", presentationHash: row.presentationHash },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		const response = await sync(ctx, [id]);
		expect(response.answers).toEqual([{ approvalId: id, decision: "accept", revision: 1 }]);
	});

	test("a succeeded interrupt keeps it (the turn ended, nothing more can be issued for it)", async () => {
		const ctx = await setup();
		await interrupt(ctx);
		await setInterrupt("succeeded");
		await expect(
			recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ turnId: ctx.promptId, rpcId: "x" }),
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "turn_interrupted" });
	});
});

describe("fenceApprovalsForTurn on its own", () => {
	test("a turn with nothing open closes nothing and fences nothing", async () => {
		const ctx = await setup();
		const result = await withAdminLock((tx) =>
			fenceApprovalsForTurn(tx, ctx.sessionId, ctx.promptId, ctx.clock.now()),
		);
		expect(result).toEqual({ closed: [], fenced: 0 });
	});
});
