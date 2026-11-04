/**
 * The outcome protocol (D17): what the host's tracker observed, what the row
 * becomes, and when the server acks. One table in shared/codex-approvals.ts,
 * driven row by row here.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovals } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const {
	answerApproval,
	deriveApprovalOutcome,
	recordApprovalRequest,
	sweepApprovals,
	syncApprovals,
} = await import("./codex-approvals.js");
const { TRACKER_OUTCOMES, TRACKER_OUTCOME_TABLE } = await import("../../shared/codex-approvals.js");
type Outcome = (typeof TRACKER_OUTCOMES)[number];
type Decision = "accept" | "decline" | "cancel";

beforeAll(() => initializeDatabase());
const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

async function setup() {
	const sessionId = `op-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `op-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, clock, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];

const report = (ctx: Ctx, approvalId: string, outcome: Outcome, sentDecision: Decision | null) =>
	syncApprovals(
		ctx.supervisorId,
		{
			v: 1,
			live: [{ approvalId, revision: 1 }],
			resolved: [{ approvalId, outcome, sentDecision }],
		},
		ctx.deps,
	);

/** A row in the state the host would report on: pending, or answered (and issued, as the host acts on an issued answer). */
async function rowIn(ctx: Ctx, state: "pending" | "accept" | "decline" | "cancel") {
	const recorded = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport({ rpcId: crypto.randomUUID() }),
		ctx.deps,
	);
	const id = recorded.response.approvalId;
	if (state === "pending") return id;
	const row = await rowOf(id);
	await answerApproval(
		ctx.sessionId,
		id,
		state === "accept"
			? { decision: "accept", presentationHash: row.presentationHash }
			: { decision: state },
		harness.SOLO_PERSON,
		ctx.deps,
	);
	await syncApprovals(
		ctx.supervisorId,
		{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
		ctx.deps,
	);
	return id;
}

/** The table's expectation for an answered row, computed from the shared data. */
function expected(outcome: Outcome, decision: Decision): string | null {
	const entry = TRACKER_OUTCOME_TABLE[outcome];
	return decision === "accept" ? entry.accept : entry.other;
}

describe("the table, row by row", () => {
	test("covers every tracker outcome (floor 9, named member resolved_after_response)", () => {
		expect(TRACKER_OUTCOMES.length).toBeGreaterThanOrEqual(9);
		expect(TRACKER_OUTCOMES).toContain("resolved_after_response");
		expect(Object.keys(TRACKER_OUTCOME_TABLE).sort()).toEqual([...TRACKER_OUTCOMES].sort());
	});

	for (const outcome of TRACKER_OUTCOMES) {
		for (const decision of ["accept", "decline", "cancel"] as const) {
			test(`${outcome} on an answered ${decision}`, async () => {
				const ctx = await setup();
				const id = await rowIn(ctx, decision);
				const sent: Decision | null =
					outcome === "resolved_before_response" || outcome === "runtime_gone"
						? null
						: outcome.startsWith("declined_")
							? "decline"
							: decision;
				const response = await report(ctx, id, outcome, sent);
				const row = await rowOf(id);
				expect(response.ack).toEqual([{ approvalId: id, outcome }]);
				if (!TRACKER_OUTCOME_TABLE[outcome].terminal) {
					expect(row.status).toBe("answered");
					expect(row.hostOutcome).toBe(outcome);
					return;
				}
				expect(row.status).toBe("closed");
				expect(row.closedReason).toBe(expected(outcome, decision));
				expect(row.hostOutcome).toBe(outcome);
			});
		}
	}

	test("an accept is applied from resolved_after_response and from nothing else", async () => {
		for (const outcome of TRACKER_OUTCOMES) {
			const ctx = await setup();
			const id = await rowIn(ctx, "accept");
			await report(ctx, id, outcome, outcome.startsWith("declined_") ? "decline" : "accept");
			const row = await rowOf(id);
			if (outcome === "resolved_after_response") expect(row.closedReason).toBe("applied");
			else expect(row.closedReason).not.toBe("applied");
		}
	});

	test("a sent decline or cancel with no resolved also closes applied", async () => {
		for (const decision of ["decline", "cancel"] as const) {
			for (const outcome of ["resolved_timeout", "runtime_gone_after_response"] as const) {
				const ctx = await setup();
				const id = await rowIn(ctx, decision);
				await report(ctx, id, outcome, decision);
				expect((await rowOf(id)).closedReason).toBe("applied");
			}
		}
	});

	test("on a pending row the host's own terminal outcomes close it as what they are", async () => {
		const wanted: Record<string, string> = {
			resolved_before_response: "interrupted",
			runtime_gone: "runtime_gone",
			runtime_gone_after_response: "runtime_gone",
			declined_local: "expired",
			resolved_after_response: "expired",
		};
		for (const [outcome, reason] of Object.entries(wanted)) {
			const ctx = await setup();
			const id = await rowIn(ctx, "pending");
			await report(
				ctx,
				id,
				outcome as Outcome,
				outcome === "resolved_before_response" || outcome === "runtime_gone" ? null : "decline",
			);
			expect((await rowOf(id)).closedReason, outcome).toBe(reason);
		}
	});
});

describe("anything inconsistent closes outcome_unknown", () => {
	test("sentDecision accept against a row whose decision isn't accept", async () => {
		for (const outcome of [
			"respond_sent",
			"resolved_after_response",
			"resolved_timeout",
		] as const) {
			const ctx = await setup();
			const id = await rowIn(ctx, "decline");
			const warn = spyOn(console, "warn").mockImplementation(() => undefined);
			await report(ctx, id, outcome, "accept");
			const logged = warn.mock.calls.map((c) => String(c[0]));
			warn.mockRestore();
			expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "outcome_unknown" });
			expect(logged.some((line) => line.includes("codex_approval_outcome_mismatch"))).toBe(true);
		}
	});

	test("any outcome on a pending row that claims a sent accept", async () => {
		for (const outcome of TRACKER_OUTCOMES) {
			const ctx = await setup();
			const id = await rowIn(ctx, "pending");
			const warn = spyOn(console, "warn").mockImplementation(() => undefined);
			await report(ctx, id, outcome, "accept");
			warn.mockRestore();
			expect((await rowOf(id)).closedReason, outcome).toBe("outcome_unknown");
		}
	});
});

describe("idempotence and ack", () => {
	test("each outcome sent twice acks twice and changes nothing the second time", async () => {
		for (const outcome of TRACKER_OUTCOMES) {
			const ctx = await setup();
			const id = await rowIn(ctx, "accept");
			const sent: Decision = outcome.startsWith("declined_") ? "decline" : "accept";
			const first = await report(ctx, id, outcome, sent);
			const afterFirst = await rowOf(id);
			const second = await report(ctx, id, outcome, sent);
			expect(first.ack).toEqual([{ approvalId: id, outcome }]);
			expect(second.ack).toEqual([{ approvalId: id, outcome }]);
			expect(await rowOf(id)).toEqual(afterFirst);
		}
	});

	test("a closed row acks anything and keeps its first terminal result", async () => {
		const ctx = await setup();
		const id = await rowIn(ctx, "accept");
		await report(ctx, id, "resolved_after_response", "accept");
		for (const outcome of TRACKER_OUTCOMES) {
			const response = await report(ctx, id, outcome, "accept");
			expect(response.ack).toEqual([{ approvalId: id, outcome }]);
		}
		expect((await rowOf(id)).closedReason).toBe("applied");
	});

	test("an id the server doesn't know, or another host's, is acked and changes nothing", async () => {
		const ctx = await setup();
		const other = await setup();
		const id = await rowIn(other, "accept");
		const before = await rowOf(id);
		const response = await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [],
				resolved: [
					{ approvalId: id, outcome: "runtime_gone", sentDecision: null },
					{ approvalId: "never-existed", outcome: "declined_local", sentDecision: "decline" },
				],
			},
			ctx.deps,
		);
		expect(response.ack.map((a) => a.approvalId).sort()).toEqual([id, "never-existed"].sort());
		expect(await rowOf(id)).toEqual(before);
	});

	test("the ack comes in the same response as the durable change", async () => {
		const ctx = await setup();
		const id = await rowIn(ctx, "accept");
		const response = await report(ctx, id, "resolved_after_response", "accept");
		expect(response.ack).toEqual([{ approvalId: id, outcome: "resolved_after_response" }]);
		expect((await rowOf(id)).status).toBe("closed");
	});
});

describe("late resolved after outcome_unknown", () => {
	test("is acked and logged once, and changes the row, the audit and the may-have-run copy not at all", async () => {
		const ctx = await setup();
		const id = await rowIn(ctx, "accept");
		ctx.clock.advance(5 * 60_000 + 1_000);
		await sweepApprovals({}, ctx.deps);
		const closed = await rowOf(id);
		expect(closed).toMatchObject({ status: "closed", closedReason: "outcome_unknown" });
		const auditBefore = await harness.auditRows(ctx.sessionId);
		expect(auditBefore[0]).toMatchObject({ outcome: "outcome_unknown" });
		const copyBefore = deriveApprovalOutcome(closed, ctx.clock.now()).outcome;
		expect(copyBefore).toBe("may_have_run");

		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		const response = await report(ctx, id, "resolved_after_response", "accept");
		const logged = warn.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.includes("codex_approval_late_resolved"));
		warn.mockRestore();

		expect(response.ack).toEqual([{ approvalId: id, outcome: "resolved_after_response" }]);
		expect(logged).toHaveLength(1);
		const after = await rowOf(id);
		expect(after.closedReason).toBe("outcome_unknown");
		expect(after.closedAt).toBe(closed.closedAt);
		expect(await harness.auditRows(ctx.sessionId)).toEqual(auditBefore);
		expect(deriveApprovalOutcome(after, ctx.clock.now()).outcome).toBe("may_have_run");
	});
});

describe("a delivered accept whose response was lost", () => {
	test("closes answer_lapsed when the host says it declined locally", async () => {
		const ctx = await setup();
		const id = await rowIn(ctx, "accept");
		expect((await rowOf(id)).firstDeliveredAt).not.toBeNull();
		await report(ctx, id, "declined_local", "decline");
		expect((await rowOf(id)).closedReason).toBe("answer_lapsed");
	});

	test("closes outcome_unknown on silence", async () => {
		const ctx = await setup();
		const id = await rowIn(ctx, "accept");
		ctx.clock.advance(5 * 60_000 + 1_000);
		await sweepApprovals({}, ctx.deps);
		expect((await rowOf(id)).closedReason).toBe("outcome_unknown");
	});
});
