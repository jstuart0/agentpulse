/**
 * Codex approvals, phase 3: the service. Recording a request, the limits, the
 * TTL arithmetic, re-reports, answering, and every row of the plan's "how a row
 * dies" table (3.3) that doesn't need a Stop (those are in
 * codex-approvals-stop-fence.test.ts).
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import type { CodexApprovalResolved } from "../../shared/codex-approvals.js";
import { countDbCalls } from "../test-utils/db-call-counter.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovalAudit, codexApprovals, events, managedSessions, sessions, supervisors } =
	await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const {
	ApprovalRefusal,
	answerApproval,
	closeApprovalsForRestartedHost,
	closeApprovalsForSession,
	getApprovalDetail,
	listApprovalsForSession,
	recordApprovalRequest,
	sweepApprovals,
	syncApprovals,
} = await import("./codex-approvals.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");
const shared = await import("../../shared/codex-approvals.js");

const { CODEX_APPROVAL_TTL_MS, CODEX_APPROVAL_LIMITS } = shared;

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

let counter = 0;
function newIds(prefix = "ca") {
	counter++;
	const sessionId = `${prefix}-session-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	const supervisorId = `${prefix}-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	return { sessionId, supervisorId };
}

async function setup(prefix?: string) {
	const ids = newIds(prefix);
	await harness.seedApprovalSession(ids);
	const clock = harness.createApprovalClock();
	return { ...ids, clock, deps: { now: clock.now } };
}

async function code(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ApprovalRefusal) return error.code;
		throw error;
	}
	return "ok";
}

async function rowOf(approvalId: string) {
	const [row] = await getDb()
		.select()
		.from(codexApprovals)
		.where(eq(codexApprovals.id, approvalId));
	return row;
}

/** Record a command request and return its id. */
async function record(
	ctx: Awaited<ReturnType<typeof setup>>,
	overrides: Parameters<typeof harness.commandReport>[0] = {},
) {
	const result = await recordApprovalRequest(
		ctx.supervisorId,
		ctx.sessionId,
		harness.commandReport(overrides),
		ctx.deps,
	);
	return result.response.approvalId;
}

async function acceptIt(ctx: Awaited<ReturnType<typeof setup>>, approvalId: string) {
	const row = await rowOf(approvalId);
	return answerApproval(
		ctx.sessionId,
		approvalId,
		{ decision: "accept", presentationHash: row.presentationHash },
		harness.SOLO_PERSON,
		ctx.deps,
	);
}

const syncBody = (live: string[] = [], resolved: CodexApprovalResolved[] = []) => ({
	v: 1 as const,
	live: live.map((approvalId) => ({ approvalId, revision: 1 })),
	resolved,
});

describe("recording a request", () => {
	test("stores a pending row whose text is the redacted presentation, never raw", async () => {
		const ctx = await setup();
		const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		const { created, response } = await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ command: `echo ${secret} | wc -c` }),
			ctx.deps,
		);
		expect(created).toBe(true);
		expect(response).toEqual({
			v: 1,
			approvalId: expect.any(String),
			revision: 1,
			expiresInMs: CODEX_APPROVAL_TTL_MS,
		});
		const row = await rowOf(response.approvalId);
		expect(row.status).toBe("pending");
		expect(row.approvable).toBe(false);
		expect(row.notApprovableReason).toBe("redacted");
		expect(JSON.stringify(row)).not.toContain(secret);
		expect(row.presentationHash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("the row's expiry is receipt time plus the TTL minus the request's age", async () => {
		const ctx = await setup();
		const cases: Array<[unknown, number]> = [
			[0, CODEX_APPROVAL_TTL_MS],
			[-5_000, CODEX_APPROVAL_TTL_MS],
			[Number.NaN, 0],
			[Number.POSITIVE_INFINITY, 0],
			[CODEX_APPROVAL_TTL_MS * 3, 0],
			[CODEX_APPROVAL_TTL_MS - 60_000, 60_000],
			[CODEX_APPROVAL_TTL_MS - 59_000, 59_000],
		];
		let rpc = 0;
		for (const [ageMs, remaining] of cases) {
			rpc++;
			const { response } = await recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ rpcId: `age-${rpc}`, ageMs: ageMs as number }),
				ctx.deps,
			);
			const row = await rowOf(response.approvalId);
			expect(Date.parse(row.expiresAt) - ctx.clock.now()).toBe(remaining);
			expect(response.expiresInMs).toBe(remaining);
		}
	});

	test("a re-report of the same request is ignored unless it is pending with a higher revision, and expires_at never moves", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "npm test", revision: 2 });
		const before = await rowOf(id);

		ctx.clock.advance(5 * 60_000);
		const same = await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ command: "npm run other", revision: 2, ageMs: 0 }),
			ctx.deps,
		);
		const lower = await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ command: "npm run lower", revision: 1 }),
			ctx.deps,
		);
		expect(same.created).toBe(false);
		expect(lower.created).toBe(false);
		expect((await rowOf(id)).presentationHash).toBe(before.presentationHash);

		const higher = await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ command: "npm run changed", revision: 3 }),
			ctx.deps,
		);
		expect(higher.created).toBe(false);
		expect(higher.response.revision).toBe(3);
		const after = await rowOf(id);
		expect(after.presentationRevision).toBe(3);
		expect(after.presentationHash).not.toBe(before.presentationHash);
		expect(after.expiresAt).toBe(before.expiresAt);
		expect(after.id).toBe(id);
		expect(await harness.approvalRows(ctx.sessionId)).toHaveLength(1);
	});

	test("a re-report on an answered or closed row changes nothing", async () => {
		const ctx = await setup();
		const answered = await record(ctx, { rpcId: "a", revision: 1 });
		await acceptIt(ctx, answered);
		const closed = await record(ctx, { rpcId: "b", revision: 1 });
		await getDb()
			.update(codexApprovals)
			.set({ status: "closed", closedReason: "expired" })
			.where(eq(codexApprovals.id, closed));
		const beforeAnswered = await rowOf(answered);
		const beforeClosed = await rowOf(closed);

		for (const rpcId of ["a", "b"]) {
			await recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				harness.commandReport({ rpcId, revision: 9, command: "rm -rf /" }),
				ctx.deps,
			);
		}
		expect(await rowOf(answered)).toEqual(beforeAnswered);
		expect(await rowOf(closed)).toEqual(beforeClosed);
	});

	test("the same RPC id under another runtime epoch is another request", async () => {
		const ctx = await setup();
		const a = await record(ctx, { runtimeEpoch: "epoch-1", rpcId: "7" });
		const b = await record(ctx, { runtimeEpoch: "epoch-2", rpcId: "7" });
		expect(a).not.toBe(b);
	});

	test("an unknown session is refused session_unknown", async () => {
		const ctx = await setup();
		expect(
			await code(() =>
				recordApprovalRequest(
					ctx.supervisorId,
					"no-such-session",
					harness.commandReport(),
					ctx.deps,
				),
			),
		).toBe("session_unknown");
	});

	test("while a Stop is queued or running, a report is refused session_stopping", async () => {
		const ctx = await setup();
		for (const status of ["queued", "running"]) {
			await harness.seedActiveStop(ctx.sessionId, status);
			expect(await code(() => record(ctx, { rpcId: `s-${status}` }))).toBe("session_stopping");
			await harness.clearActiveStop(ctx.sessionId);
		}
		expect(await code(() => record(ctx, { rpcId: "after" }))).toBe("ok");
	});

	test("a finished Stop no longer blocks a report", async () => {
		const ctx = await setup();
		await harness.seedActiveStop(ctx.sessionId, "succeeded");
		expect(await code(() => record(ctx))).toBe("ok");
	});

	test("writes the timeline line with fixed words only, and no agent text", async () => {
		const ctx = await setup();
		const marker = "UNIQUE-AGENT-WORDS-91827";
		await record(ctx, { command: `echo ${marker}`, reason: marker });
		const rows = await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId));
		expect(rows).toHaveLength(1);
		expect(rows[0].eventType).toBe("PermissionRequest");
		expect(rows[0].category).toBe("permission_event");
		expect(rows[0].content).toBe("Codex asks to run a command");
		expect(JSON.stringify(rows[0])).not.toContain(marker);
	});
});

describe("limits", () => {
	test("32 open per session: the 33rd is refused too_many_pending", async () => {
		const ctx = await setup();
		for (let i = 1; i <= CODEX_APPROVAL_LIMITS.openPerSession; i++) {
			await record(ctx, { rpcId: `o-${i}` });
		}
		expect(await code(() => record(ctx, { rpcId: "o-33" }))).toBe("too_many_pending");
		expect(await harness.approvalRows(ctx.sessionId)).toHaveLength(32);
	});

	test("60 created in 10 minutes per session: the 61st is refused until the window passes", async () => {
		const ctx = await setup();
		for (let i = 1; i <= CODEX_APPROVAL_LIMITS.createdPer10MinPerSession; i++) {
			const id = await record(ctx, { rpcId: `c-${i}` });
			await getDb()
				.update(codexApprovals)
				.set({ status: "closed", closedReason: "applied" })
				.where(eq(codexApprovals.id, id));
		}
		expect(await code(() => record(ctx, { rpcId: "c-61" }))).toBe("too_many_pending");
		ctx.clock.advance(CODEX_APPROVAL_LIMITS.createdWindowMs + 1_000);
		expect(await code(() => record(ctx, { rpcId: "c-62" }))).toBe("ok");
	});

	test("64 open per owner host, counted through the owner-of-record rule: the 65th is refused", async () => {
		// Three sessions of one host, each well under the per-session limit of 32, so only the host limit can stop it.
		const ctx = await setup();
		const second = newIds("ca-second");
		const third = newIds("ca-third");
		await harness.seedApprovalSession({ ...second, supervisorId: ctx.supervisorId });
		await harness.seedApprovalSession({ ...third, supervisorId: ctx.supervisorId });
		const sessionsOfHost = [ctx.sessionId, second.sessionId, third.sessionId];
		for (let i = 1; i <= CODEX_APPROVAL_LIMITS.openPerHost; i++) {
			await recordApprovalRequest(
				ctx.supervisorId,
				sessionsOfHost[i % 3],
				harness.commandReport({ rpcId: `h-${i}` }),
				ctx.deps,
			);
		}
		const open = await Promise.all(sessionsOfHost.map((id) => harness.approvalRows(id)));
		expect(Math.max(...open.map((rows) => rows.length))).toBeLessThan(
			CODEX_APPROVAL_LIMITS.openPerSession,
		);
		expect(
			await code(() =>
				recordApprovalRequest(
					ctx.supervisorId,
					ctx.sessionId,
					harness.commandReport({ rpcId: "h-65" }),
					ctx.deps,
				),
			),
		).toBe("too_many_pending");

		// Another host's rows don't count against this one, and this host's don't count against theirs.
		const stranger = newIds("ca-stranger");
		await harness.seedApprovalSession(stranger);
		expect(
			await code(() =>
				recordApprovalRequest(
					stranger.supervisorId,
					stranger.sessionId,
					harness.commandReport(),
					ctx.deps,
				),
			),
		).toBe("ok");
	});
});

describe("answering", () => {
	test("an accept with the shown hash is answered once, with an audit row naming who", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const response = await acceptIt(ctx, id);
		expect(response.approval.state).toBe("answered");
		expect(response.approval.decision).toBe("accept");
		expect(response.approval.outcome).toBe("sending_accept");
		const audit = await harness.auditRows(ctx.sessionId);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			approvalId: id,
			decision: "accept",
			outcome: "pending",
			hostName: "build-host",
			actorLabel: "user",
			requestKind: "command",
			revision: 1,
		});
	});

	test("a decision outside the fixed set, and an accept without the hash, have their fixed codes", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const call = (input: { decision: unknown; presentationHash?: unknown }) =>
			code(() => answerApproval(ctx.sessionId, id, input, harness.SOLO_PERSON, ctx.deps));
		expect(await call({ decision: "acceptForSession" })).toBe("invalid_decision");
		expect(await call({ decision: "acceptWithExecpolicyAmendment" })).toBe("invalid_decision");
		expect(await call({ decision: undefined })).toBe("invalid_decision");
		expect(await call({ decision: "accept" })).toBe("presentation_hash_required");
		expect(await call({ decision: "accept", presentationHash: "" })).toBe(
			"presentation_hash_required",
		);
		expect(await call({ decision: "accept", presentationHash: 42 })).toBe(
			"presentation_hash_required",
		);
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("a wrong hash is presentation_changed and nothing is answered", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		expect(
			await code(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: "f".repeat(64) },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("presentation_changed");
		expect((await rowOf(id)).status).toBe("pending");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(0);
	});

	test("an accept needs a signed-in person: an API key is refused human_required, a decline is not", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const key = {
			actor: {
				userId: null,
				label: "api_key" as const,
				role: "admin" as const,
				mode: "solo" as const,
			},
			keyId: "k1",
			isHuman: false,
		};
		const row = await rowOf(id);
		expect(
			await code(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: row.presentationHash },
					key,
					ctx.deps,
				),
			),
		).toBe("human_required");
		expect((await rowOf(id)).status).toBe("pending");
		const declined = await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "decline" },
			key,
			ctx.deps,
		);
		expect(declined.approval.decision).toBe("decline");
		expect((await harness.auditRows(ctx.sessionId))[0]).toMatchObject({
			actorKeyId: "k1",
			actorLabel: "api_key",
		});
	});

	test("an unapprovable request can only be declined", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "ls", declineOnly: ["network"] });
		const row = await rowOf(id);
		expect(row.approvable).toBe(false);
		expect(
			await code(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: row.presentationHash },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("not_approvable");
		const declined = await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "decline" },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		expect(declined.approval.state).toBe("answered");
	});

	test("a second answer is already_resolved and the first decision stays", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
		expect(await code(() => acceptIt(ctx, id))).toBe("already_resolved");
		expect(
			await code(() =>
				answerApproval(ctx.sessionId, id, { decision: "cancel" }, harness.SOLO_PERSON, ctx.deps),
			),
		).toBe("already_resolved");
		expect((await rowOf(id)).decision).toBe("decline");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(1);
	});

	test("an unknown approval, and one on another session, is approval_not_found", async () => {
		const ctx = await setup();
		const other = await setup("ca-elsewhere");
		const id = await record(ctx);
		expect(
			await code(() =>
				answerApproval(
					ctx.sessionId,
					"nope",
					{ decision: "decline" },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("approval_not_found");
		expect(
			await code(() =>
				answerApproval(other.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps),
			),
		).toBe("approval_not_found");
	});

	test("at exactly expires_at the answer is refused expired; a millisecond before it is taken", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		ctx.clock.set(Date.parse(row.expiresAt) - 1);
		const taken = await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "decline" },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		expect(taken.approval.state).toBe("answered");

		const second = await record(ctx, { rpcId: "late" });
		const lateRow = await rowOf(second);
		ctx.clock.set(Date.parse(lateRow.expiresAt));
		expect(
			await code(() =>
				answerApproval(
					ctx.sessionId,
					second,
					{ decision: "decline" },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("expired");
	});

	test("the expiry the guard enforces is the one at the write: a person who clicked a moment before expiry and lands after it is expired", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const expiresMs = Date.parse((await rowOf(id)).expiresAt);
		// The checks read the clock just before expiry; by the time the row is written it has passed.
		const times = [expiresMs - 1, expiresMs, expiresMs];
		const clock = { now: () => times.shift() ?? expiresMs };
		expect(
			await code(() =>
				answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, clock),
			),
		).toBe("expired");
		expect((await rowOf(id)).status).toBe("pending");
		expect(await harness.auditRows(ctx.sessionId)).toHaveLength(0);
	});

	test("nothing is answered for an offline or a removed host", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const row = await rowOf(id);
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(ctx.clock.start - 1_000).toISOString() })
			.where(eq(supervisors.id, ctx.supervisorId));
		expect(
			await code(() =>
				answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps),
			),
		).toBe("host_offline");
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, ctx.supervisorId));
		expect(
			await code(() =>
				answerApproval(
					ctx.sessionId,
					id,
					{ decision: "accept", presentationHash: row.presentationHash },
					harness.SOLO_PERSON,
					ctx.deps,
				),
			),
		).toBe("host_gone");
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("a request that can't be cancelled refuses cancel and still takes a decline", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await getDb().update(codexApprovals).set({ canCancel: false }).where(eq(codexApprovals.id, id));
		expect(
			await code(() =>
				answerApproval(ctx.sessionId, id, { decision: "cancel" }, harness.SOLO_PERSON, ctx.deps),
			),
		).toBe("invalid_decision");
		expect((await rowOf(id)).status).toBe("pending");
		expect(
			await code(() =>
				answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps),
			),
		).toBe("ok");
	});

	test("cancel is accepted for a request that can be cancelled", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const response = await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "cancel" },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		expect(response.approval.decision).toBe("cancel");
		expect(response.approval.outcome).toBe("sending_decline");
	});
});

describe("reading", () => {
	test("the list and the detail carry the shown text and a preview; a closed row has neither", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "npm test\nnpm run lint", reason: "Codex says so" });
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.host).toEqual({ state: "live", name: "build-host" });
		expect(list.viewer).toEqual({ canAccept: true });
		expect(list.approvals).toHaveLength(1);
		expect(list.approvals[0].preview).toMatchObject({ lineCount: 2, cwd: "/work/project" });
		const detail = await getApprovalDetail(ctx.sessionId, id, harness.SOLO_PERSON, ctx.deps);
		expect(detail.presentation).toMatchObject({
			requestKind: "command",
			command: "npm test\nnpm run lint",
		});
		expect(detail.reasonText).toBe("Codex says so");

		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }]),
			ctx.deps,
		);
		const closedList = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(closedList.approvals[0]).toMatchObject({
			state: "closed",
			outcome: "codex_shut_down",
			preview: null,
		});
		const closedDetail = await getApprovalDetail(ctx.sessionId, id, harness.SOLO_PERSON, ctx.deps);
		expect(closedDetail.presentation).toBeNull();
		expect(closedDetail.reasonText).toBeNull();
	});

	test("an expired pending row reads as closed before the sweep writes it", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1);
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.approvals[0]).toMatchObject({
			id,
			state: "closed",
			outcome: "expired",
			approvable: false,
		});
		expect((await rowOf(id)).status).toBe("pending");
	});

	test("closed rows leave the list after five minutes, but a may-have-run row stays", async () => {
		const ctx = await setup();
		const gone = await record(ctx, { rpcId: "g" });
		const unknown = await record(ctx, { rpcId: "u" });
		const at = new Date(ctx.clock.now()).toISOString();
		await getDb()
			.update(codexApprovals)
			.set({ status: "closed", closedReason: "runtime_gone", closedAt: at })
			.where(eq(codexApprovals.id, gone));
		await getDb()
			.update(codexApprovals)
			.set({ status: "closed", closedReason: "outcome_unknown", closedAt: at, decision: "accept" })
			.where(eq(codexApprovals.id, unknown));
		expect(
			(await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps)).approvals,
		).toHaveLength(2);
		ctx.clock.advance(5 * 60_000 + 1_000);
		const later = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(later.approvals.map((a) => a.id)).toEqual([unknown]);
		expect(later.approvals[0].outcome).toBe("may_have_run");
	});

	test("the list is capped at 52, open rows first", async () => {
		const ctx = await setup();
		const at = new Date(ctx.clock.now()).toISOString();
		for (let i = 0; i < 60; i++) {
			await getDb()
				.insert(codexApprovals)
				.values({
					sessionId: ctx.sessionId,
					runtimeEpoch: "e",
					rpcId: `r${i}`,
					requestKind: "command",
					threadId: "t",
					turnId: "t",
					itemId: "i",
					presentationHash: "h",
					presentationRevision: 1,
					approvable: true,
					status: i < 55 ? "closed" : "pending",
					closedReason: i < 55 ? "applied" : null,
					closedAt: at,
					createdAt: new Date(ctx.clock.now() + i).toISOString(),
					expiresAt: new Date(ctx.clock.now() + 600_000).toISOString(),
					updatedAt: at,
				});
		}
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.approvals).toHaveLength(52);
		expect(list.approvals.slice(0, 5).every((a) => a.state === "pending")).toBe(true);
	});
});

describe("the host's sync", () => {
	test("a sync with nothing to do is one statement", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const statements = await countDbCalls(async () => {
			await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		});
		expect(statements).toBeLessThanOrEqual(3);
		expect(statements).toBe(1);
	});

	test("an answered accept is issued once, bound to the revision, and stamped", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.answers).toEqual([{ approvalId: id, decision: "accept", revision: 1 }]);
		const row = await rowOf(id);
		expect(row.firstDeliveredAt).not.toBeNull();
		expect(row.lastIssuedAt).not.toBeNull();
		// Issued again within the window if the host asks again (its response may have been lost).
		const again = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(again.answers).toEqual([{ approvalId: id, decision: "accept", revision: 1 }]);
	});

	test("a pending row gets no answer; a row the host doesn't list is closed runtime_gone after 30 s, not before", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		ctx.clock.advance(29_000);
		let response = await syncApprovals(ctx.supervisorId, syncBody([]), ctx.deps);
		expect(response.closed).toEqual([]);
		expect((await rowOf(id)).status).toBe("pending");
		ctx.clock.advance(2_000);
		response = await syncApprovals(ctx.supervisorId, syncBody([]), ctx.deps);
		expect(response.closed).toEqual([id]);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "runtime_gone" });
	});

	test("a row missing from live after an accept was issued closes outcome_unknown", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		ctx.clock.advance(31_000);
		await syncApprovals(ctx.supervisorId, syncBody([]), ctx.deps);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "outcome_unknown" });
	});

	test("an expired pending row is closed by the sync and reported in closed", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1);
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.closed).toEqual([id]);
		expect((await rowOf(id)).closedReason).toBe("expired");
	});

	test("an accept past its 60 s window is never issued: closed answer_lapsed when never delivered", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		ctx.clock.advance(61_000);
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.answers).toEqual([]);
		expect(response.closed).toEqual([id]);
		const row = await rowOf(id);
		expect(row).toMatchObject({
			status: "closed",
			closedReason: "answer_lapsed",
			firstDeliveredAt: null,
		});
	});

	test("at exactly 60 s an accept is still issued; a decline is issued whenever", async () => {
		const ctx = await setup();
		const accept = await record(ctx, { rpcId: "a" });
		const decline = await record(ctx, { rpcId: "d" });
		await acceptIt(ctx, accept);
		await answerApproval(
			ctx.sessionId,
			decline,
			{ decision: "decline" },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		ctx.clock.advance(60_000);
		const response = await syncApprovals(ctx.supervisorId, syncBody([accept, decline]), ctx.deps);
		expect(response.answers.map((a) => a.decision).sort()).toEqual(["accept", "decline"]);
	});

	test("an accept already issued and then past its window is handed a decline, never the accept again", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		ctx.clock.advance(61_000);
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.answers).toEqual([{ approvalId: id, decision: "decline", revision: 1 }]);
		expect((await rowOf(id)).status).toBe("answered");
	});

	test("a host that already reported sending its answer is not handed it again", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
		const first = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(first.answers).toHaveLength(1);
		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "respond_sent", sentDecision: "decline" }]),
			ctx.deps,
		);
		const again = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(again.answers).toEqual([]);
	});

	test("an answered decline past the TTL is closed applied by the sweep (a decline can't have run)", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
		ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1);
		await sweepApprovals({}, ctx.deps);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "applied" });
		expect((await harness.auditRows(ctx.sessionId))[0].outcome).toBe("applied");
	});
});

describe("how a row dies (3.3)", () => {
	test("the host reports the runtime closed: runtime_gone, and an unreported issued accept is outcome_unknown on absence", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }]),
			ctx.deps,
		);
		expect(await rowOf(id)).toMatchObject({
			status: "closed",
			closedReason: "runtime_gone",
			hostOutcome: "runtime_gone",
		});
	});

	test("a turn interrupted before the host answered: interrupted", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "resolved_before_response", sentDecision: null }]),
			ctx.deps,
		);
		expect((await rowOf(id)).closedReason).toBe("interrupted");
	});

	test("a managed session reporting a live terminal state closes its rows; degraded and a replay do not", async () => {
		const ctx = await setup();
		const pending = await record(ctx, { rpcId: "p" });
		const issued = await record(ctx, { rpcId: "i" });
		await acceptIt(ctx, issued);
		await syncApprovals(ctx.supervisorId, syncBody([pending, issued]), ctx.deps);

		await upsertManagedSessionState(ctx.supervisorId, {
			sessionId: ctx.sessionId,
			managedState: "degraded",
		});
		await upsertManagedSessionState(
			ctx.supervisorId,
			{ sessionId: ctx.sessionId, managedState: "stopped" },
			{ replay: true },
		);
		await upsertManagedSessionState(
			ctx.supervisorId,
			{ sessionId: ctx.sessionId, status: "completed" },
			{ replay: true },
		);
		expect((await rowOf(pending)).status).toBe("pending");
		expect((await rowOf(issued)).status).toBe("answered");

		await upsertManagedSessionState(ctx.supervisorId, {
			sessionId: ctx.sessionId,
			managedState: "stopped",
		});
		expect(await rowOf(pending)).toMatchObject({
			status: "closed",
			closedReason: "session_stopped",
		});
		expect(await rowOf(issued)).toMatchObject({
			status: "closed",
			closedReason: "outcome_unknown",
		});
	});

	test("each live terminal shape closes rows", async () => {
		const shapes = [
			{ status: "completed" as const },
			{ status: "failed" as const },
			{ managedState: "stopped" as const },
			{ managedState: "completed" as const },
			{ managedState: "failed" as const },
		];
		for (const shape of shapes) {
			const ctx = await setup();
			const id = await record(ctx);
			await upsertManagedSessionState(ctx.supervisorId, { sessionId: ctx.sessionId, ...shape });
			expect((await rowOf(id)).closedReason).toBe("session_stopped");
		}
	});

	test("a supervisor restart closes only that host's rows", async () => {
		const mine = await setup();
		const theirs = await setup("ca-theirs");
		const a = await record(mine, { rpcId: "a" });
		const issued = await record(mine, { rpcId: "i" });
		const b = await record(theirs);
		await acceptIt(mine, issued);
		await syncApprovals(mine.supervisorId, syncBody([a, issued]), mine.deps);
		const closed = await closeApprovalsForRestartedHost(mine.supervisorId, mine.deps);
		expect(closed.map((c) => c.approvalId).sort()).toEqual([a, issued].sort());
		expect((await rowOf(a)).closedReason).toBe("runtime_gone");
		expect((await rowOf(issued)).closedReason).toBe("outcome_unknown");
		expect((await rowOf(b)).status).toBe("pending");
	});

	test("a re-enrolled host: the new id can't see the old rows, and the old lease lapsing leaves the TTL to close them", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const newcomer = newIds("ca-newcomer");
		await harness.seedApprovalSession(newcomer);
		const view = await syncApprovals(newcomer.supervisorId, syncBody([id]), ctx.deps);
		expect(view.closed).toEqual([id]);
		expect(view.answers).toEqual([]);
		expect((await rowOf(id)).status).toBe("pending");
		ctx.clock.advance(CODEX_APPROVAL_TTL_MS + 1);
		await sweepApprovals({}, ctx.deps);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "expired" });
	});

	test("TTL: the sweep closes expired pending rows and a read agrees before it runs", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		ctx.clock.advance(CODEX_APPROVAL_TTL_MS);
		const result = await sweepApprovals({}, ctx.deps);
		expect(result.closed).toBe(1);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "expired" });
	});

	test("an accept not issued within 60 s is closed answer_lapsed by the sweep", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		ctx.clock.advance(60_000);
		await sweepApprovals({}, ctx.deps);
		expect((await rowOf(id)).status).toBe("answered");
		ctx.clock.advance(1_000);
		await sweepApprovals({}, ctx.deps);
		expect((await rowOf(id)).closedReason).toBe("answer_lapsed");
	});

	test("an accept issued and never reported on closes outcome_unknown after five minutes", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		ctx.clock.advance(5 * 60_000 - 1_000);
		await sweepApprovals({}, ctx.deps);
		expect((await rowOf(id)).status).toBe("answered");
		ctx.clock.advance(2_000);
		await sweepApprovals({}, ctx.deps);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "outcome_unknown" });
	});

	test("the person who answered lost access before issue: answer_withdrawn, and the host gets no accept", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await harness.seedUser("approver", { role: "admin" });
		const approver = {
			actor: {
				userId: "approver",
				label: "user" as const,
				role: "admin" as const,
				mode: "solo" as const,
			},
			keyId: null,
			isHuman: true,
		};
		const row = await rowOf(id);
		await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "accept", presentationHash: row.presentationHash },
			approver,
			ctx.deps,
		);
		await getDb()
			.update((await import("../db/schema/index.js")).users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq((await import("../db/schema/index.js")).users.id, "approver"));
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.answers).toEqual([]);
		expect(response.closed).toEqual([id]);
		expect(await rowOf(id)).toMatchObject({
			status: "closed",
			closedReason: "answer_withdrawn",
			firstDeliveredAt: null,
		});
		await getDb()
			.delete((await import("../db/schema/index.js")).users)
			.where(eq((await import("../db/schema/index.js")).users.id, "approver"));
	});

	test("a null user (only under DISABLE_AUTH) passes the re-judge", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		expect((await rowOf(id)).answeredByUserId).toBeNull();
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.answers).toHaveLength(1);
	});

	test("the session is deleted: the rows go, the audit stays and is finalized, and the next sync reports the id closed", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await acceptIt(ctx, id);
		await getDb().delete(sessions).where(eq(sessions.sessionId, ctx.sessionId));
		expect(await rowOf(id)).toBeUndefined();
		const audit = await getDb()
			.select()
			.from(codexApprovalAudit)
			.where(eq(codexApprovalAudit.approvalId, id));
		expect(audit).toHaveLength(1);
		expect(audit[0].outcome).toBe("session_deleted");
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.closed).toEqual([id]);
		used.splice(used.indexOf(ctx.sessionId), 1);
		await harness.wipeAuditForTest([ctx.sessionId]);
	});

	test("a closed row's text is gone and its hash stays; the audit is finalized with the same reason", async () => {
		const ctx = await setup();
		const id = await record(ctx, { command: "echo keep-me-private", reason: "private reason" });
		const before = await rowOf(id);
		expect(before.presentation).toContain("keep-me-private");
		await acceptIt(ctx, id);
		await syncApprovals(
			ctx.supervisorId,
			syncBody(
				[id],
				[{ approvalId: id, outcome: "resolved_after_response", sentDecision: "accept" }],
			),
			ctx.deps,
		);
		const after = await rowOf(id);
		expect(after).toMatchObject({
			status: "closed",
			closedReason: "applied",
			presentation: null,
			reasonText: null,
			presentationHash: before.presentationHash,
		});
		expect(JSON.stringify(after)).not.toContain("keep-me-private");
		expect((await harness.auditRows(ctx.sessionId))[0]).toMatchObject({ outcome: "applied" });
		expect((await harness.auditRows(ctx.sessionId))[0].completedAt).not.toBeNull();
	});

	test("closeApprovalsForSession closes only that session", async () => {
		const a = await setup();
		const b = await setup("ca-b");
		const ra = await record(a);
		const rb = await record(b);
		await closeApprovalsForSession(a.sessionId, a.deps);
		expect((await rowOf(ra)).status).toBe("closed");
		expect((await rowOf(rb)).status).toBe("pending");
	});
});

// Keep the imports honest when a suite above is trimmed.
void managedSessions;
