/**
 * AGEN-69 phase 5: the request path and its concurrency (TC-5.2 to 5.5 POST halves, 5.18 to 5.28,
 * 5.37, 5.47 to 5.50, 5.53, 5.58, 5.60 to 5.63a). The point of this file is what happens when
 * requests, leases, cooldowns and reservations race.
 *
 * Real database, real adapters through the stub provider (a priced kind). Frozen time moves in
 * whole seconds: the stored timestamp has one-second granularity (contract C-4).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import { describePostgresOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase, PG_CONNECTION_OPTIONS } = await import("../db/client.js");
const { aiDailySpend, aiSessionSummaries, events, llmProviders } = await import(
	"../db/schema/index.js"
);
const H = await import("../test-utils/summary-service-harness.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const svc = await import("./session-summary-service.js");
const spend = await import("./ai/spend-service.js");
const ownTurn = await import("../util/own-turn.js");
const { setShuttingDown } = await import("../drain-state.js");
const { priceCompletion } = await import("./ai/llm/pricing.js");
const { toDbTimestamp } = await import("./util/db-time.js");

const SID = "res-s1";
const CAP = spend.DEFAULT_DAILY_CAP_CENTS;
const TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const BASE = Date.UTC(2031, 0, 1, 12, 0, 0);
let stub: ReturnType<typeof H.startStub>;

beforeAll(async () => {
	await initializeDatabase();
	stub = H.startStub();
});
afterAll(async () => {
	await stub.stop();
});
beforeEach(async () => {
	await H.resetWorld(stub);
	await H.enableAi();
	await H.seedProvider(stub);
});
afterEach(async () => {
	await H.afterEachGuard(stub);
});

const ok = (cite: number[]) => ({ text: H.answer(cite), stop: "stop", usage: H.STUB_USAGE });
const script = (...answers: Array<Record<string, unknown>>) =>
	stub.script("openai", ...(answers as never[]));
const { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } = await import(
	"./ai/session-summary/service-limits.js"
);
/** The reservation for one call on the default test provider (gpt-5-mini). */
const maxCost = () =>
	priceCompletion("openai", "gpt-5-mini", {
		inputTokens: MAX_INPUT_TOKENS,
		outputTokens: MAX_OUTPUT_TOKENS,
		estimated: true,
	});
const GATED_OK = async (cite: number[]) => {
	const gate = stub.createGate();
	script({ ...ok(cite), gate });
	return gate;
};
const rowOf = (id: string) => H.readSummaryRow(id);
const refusal = (r: Awaited<ReturnType<typeof H.request>>) =>
	r.kind === "refused" ? r.refusal : null;

/** Starts a generation held at its model call; returns the gate, `done` and the entry's session id. */
async function startHeld(id: string, caller = H.SOLO) {
	const { editId } = await H.seedActiveSession(id);
	const gate = await GATED_OK([editId]);
	const { done } = await H.startGeneration(id, caller);
	await H.withDeadline(gate.arrived);
	return { gate, done, editId };
}

describe("POST halves of the view's table", () => {
	test("TC-5.2 the request refuses too little activity the way the view does, and takes nothing", async () => {
		await H.seedSession(SID);
		await H.seedEvents(SID, [H.ack()]);
		const before = await H.snapshotSpend(SID);
		expect(refusal(await H.request(SID))?.error).toBe("too_little_activity");
		expect(await rowOf(SID)).toBeUndefined();
		expect((await H.spendDelta(before)).day).toBe(0);
	});

	test("TC-5.4 cap edge: a reservation succeeds only when spent + max < cap (cap - m - 1, cap - m, cap)", async () => {
		const m = maxCost();
		expect(m).toBeGreaterThan(0);
		const cases: Array<[number, boolean]> = [
			[CAP - m - 1, true],
			[CAP - m, false],
			[CAP, false],
		];
		for (const [i, [spent, allowed]] of cases.entries()) {
			const id = `res-cap-${i}`;
			const { editId } = await H.seedActiveSession(id);
			await H.setDaySpend(spent);
			if (allowed) script(ok([editId]));
			const result = await H.request(id);
			if (allowed) {
				expect(result.kind, `spent ${spent}`).toBe("started");
				if (result.kind === "started") await H.withDeadline(result.done);
			} else {
				const r = refusal(result);
				expect(r, `spent ${spent}`).toEqual({
					error: "spend_cap_reached",
					spentCents: spent,
					capCents: CAP,
					maxCostCents: m,
				});
				expect(await H.daySpend()).toBe(spent);
				expect(await rowOf(id)).toBeUndefined();
			}
			const view = await svc.getSessionSummaryView(id);
			expect(view?.blocked === "spend_cap_reached", `view agrees at ${spent}`).toBe(!allowed);
		}
	});

	test("TC-5.5 a free provider is allowed at cap - 1 and at cap, and writes nothing to the day row", async () => {
		await H.resetWorld(stub);
		await H.enableAi();
		await H.seedProvider(stub, { kind: "openai_compatible" });
		for (const [i, spent] of [CAP - 1, CAP].entries()) {
			const id = `res-free-${i}`;
			const { editId } = await H.seedActiveSession(id);
			await H.setDaySpend(spent);
			const [{ updatedAt }] = await getDb()
				.select()
				.from(aiDailySpend)
				.where(eq(aiDailySpend.date, H.localDate()));
			stub.script("openai", ok([editId]) as never);
			await H.runGeneration(id);
			const [after] = await getDb()
				.select()
				.from(aiDailySpend)
				.where(eq(aiDailySpend.date, H.localDate()));
			expect(after.spendCents).toBe(spent);
			expect(after.updatedAt).toBe(updatedAt);
			expect((await rowOf(id))?.attemptStatus).toBe("idle");
		}
	});
});

describe("the claim and its races", () => {
	test("TC-5.18 eight concurrent requests, the adapter held: one started, seven joined, one request to the stub, one reservation (20 rounds)", async () => {
		const m = maxCost();
		for (let round = 0; round < 20; round++) {
			const id = `res-race-${round}`;
			const { editId } = await H.seedActiveSession(id);
			const gate = await GATED_OK([editId]);
			const before = await H.snapshotSpend(id);
			let go!: () => void;
			const barrier = new Promise<void>((resolve) => {
				go = resolve;
			});
			const calls = Array.from({ length: 8 }, () => barrier.then(() => H.request(id)));
			go();
			const results = await Promise.all(calls);
			const started = results.filter((r) => r.kind === "started");
			expect(started, `round ${round}`).toHaveLength(1);
			expect(
				results.filter((r) => r.kind === "joined"),
				`round ${round}`,
			).toHaveLength(7);
			await H.withDeadline(gate.arrived);
			expect(stub.requests().length).toBe(round + 1);
			// TC-5.47: the seven that lost net zero spend: exactly one reservation is held.
			expect((await H.spendDelta(before)).day, `round ${round}`).toBe(m);
			expect(svc._summaryGenerationCountForTest()).toBe(1);
			gate.release();
			if (started[0].kind === "started") await H.withDeadline(started[0].done);
			expect(svc._summaryGenerationCountForTest()).toBe(0);
		}
	}, 120_000);

	describePostgresOnly("on Postgres", () => {
		test("TC-5.19 the raw claim on two independent max:1 connections, with a barrier: exactly one UPDATE wins per round (20 rounds)", async () => {
			const { default: postgres } = await import("postgres");
			const { drizzle } = await import("drizzle-orm/postgres-js");
			const clientA = postgres(config.databaseUrl, {
				max: 1,
				idle_timeout: 10,
				...PG_CONNECTION_OPTIONS,
			});
			const clientB = postgres(config.databaseUrl, {
				max: 1,
				idle_timeout: 10,
				...PG_CONNECTION_OPTIONS,
			});
			const dbA = drizzle(clientA) as unknown as ReturnType<typeof getDb>;
			const dbB = drizzle(clientB) as unknown as ReturnType<typeof getDb>;
			try {
				for (let round = 0; round < 20; round++) {
					const id = `res-pgclaim-${round}`;
					await H.seedActiveSession(id);
					await H.seedSummaryRow(id, {});
					let go!: () => void;
					const barrier = new Promise<void>((resolve) => {
						go = resolve;
					});
					const now = new Date();
					const attempt = async (db: ReturnType<typeof getDb>, token: string) => {
						await barrier;
						return svc.claimSummaryAttempt(id, token, now, db);
					};
					const all = [
						attempt(dbA, "a1"),
						attempt(dbB, "b1"),
						attempt(dbA, "a2"),
						attempt(dbB, "b2"),
					];
					go();
					const wins = (await Promise.all(all)).filter(Boolean).length;
					expect(wins, `round ${round}`).toBe(1);
				}
			} finally {
				await clientA.end({ timeout: 2 });
				await clientB.end({ timeout: 2 });
			}
		});
	});

	test("TC-5.20 with the clock frozen to one second, two back-to-back claims: exactly one wins", async () => {
		await H.seedActiveSession(SID);
		await H.seedSummaryRow(SID, {});
		setSystemTime(new Date(BASE));
		const now = new Date();
		expect(await svc.claimSummaryAttempt(SID, "tok-one", now)).toBe(true);
		expect(await svc.claimSummaryAttempt(SID, "tok-two", now)).toBe(false);
		const row = await rowOf(SID);
		expect(row?.attemptToken).toBe("tok-one");
		expect(row?.attemptStartedAt).toMatch(TIMESTAMP);
	});

	test("TC-5.21 cooldown at second granularity: 29 s and 30 s ago refused (retryAfterSeconds >= 1), 31 s allowed; interrupted starts none", async () => {
		const { editId } = await H.seedActiveSession(SID);
		setSystemTime(new Date(BASE));
		await H.seedSummaryRow(SID, {
			attemptStatus: "failed",
			attemptErrorCode: "provider_error",
			attemptStartedAt: toDbTimestamp(new Date(BASE)),
		});
		for (const elapsed of [29, 30]) {
			setSystemTime(new Date(BASE + elapsed * 1000));
			const r = refusal(await H.request(SID));
			expect(r?.error, `${elapsed}s`).toBe("summary_cooldown");
			expect(r?.retryAfterSeconds, `${elapsed}s`).toBeGreaterThanOrEqual(1);
		}
		expect((await rowOf(SID))?.attemptStatus).toBe("failed");
		setSystemTime(new Date(BASE + 31_000));
		script(ok([editId]));
		await H.runGeneration(SID);
		expect((await rowOf(SID))?.attemptStatus).toBe("idle");

		const other = "res-interrupted";
		const o = await H.seedActiveSession(other);
		setSystemTime(new Date(BASE + 100_000));
		await H.seedSummaryRow(other, {
			attemptStatus: "failed",
			attemptErrorCode: "interrupted",
			attemptStartedAt: toDbTimestamp(new Date(BASE + 95_000)),
		});
		script(ok([o.editId]));
		await H.runGeneration(other);
		expect((await rowOf(other))?.attemptStatus).toBe("idle");
	});

	test("TC-5.21c the claim's own fences are strict: exactly 30 s of cooldown and exactly 300 s of lease still hold; one second more gives way", async () => {
		await H.seedActiveSession(SID);
		await H.seedSummaryRow(SID, {
			attemptStatus: "failed",
			attemptErrorCode: "provider_error",
			attemptStartedAt: toDbTimestamp(new Date(BASE)),
		});
		expect(await svc.claimSummaryAttempt(SID, "t30", new Date(BASE + 30_000))).toBe(false);
		expect(await svc.claimSummaryAttempt(SID, "t31", new Date(BASE + 31_000))).toBe(true);
		await getDb()
			.update(aiSessionSummaries)
			.set({
				attemptStatus: "generating",
				attemptStartedAt: toDbTimestamp(new Date(BASE)),
				attemptToken: "old",
			});
		expect(await svc.claimSummaryAttempt(SID, "l300", new Date(BASE + 300_000))).toBe(false);
		expect(await svc.claimSummaryAttempt(SID, "l301", new Date(BASE + 301_000))).toBe(true);
	});

	test("TC-5.22 lease: a generation 300 s old is joined; at 301 s a new claim wins inside the cooldown", async () => {
		const { editId } = await H.seedActiveSession(SID);
		setSystemTime(new Date(BASE));
		await H.seedSummaryRow(SID, {
			attemptStatus: "generating",
			attemptStartedAt: toDbTimestamp(new Date(BASE)),
			attemptToken: "old",
		});
		setSystemTime(new Date(BASE + 300_000));
		const joined = await H.request(SID);
		expect(joined.kind).toBe("joined");
		if (joined.kind === "joined")
			expect(joined.body.attempt).toEqual({
				status: "generating",
				startedAt: new Date(BASE).toISOString(),
				joined: true,
			});
		expect((await rowOf(SID))?.attemptToken).toBe("old");
		setSystemTime(new Date(BASE + 301_000));
		script(ok([editId]));
		await H.runGeneration(SID);
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("idle");
		expect(row?.attemptToken).toBeNull();
	});

	test("TC-5.23a a finisher that returns after its lease and a takeover writes nothing to the new row, but still settles its spend", async () => {
		const m = maxCost();
		const { editId } = await H.seedActiveSession(SID);
		setSystemTime(new Date(BASE));
		const [gateA, gateB] = [stub.createGate(), stub.createGate()];
		script({ ...ok([editId]), gate: gateA }, { ...ok([editId]), gate: gateB });
		const before = await H.snapshotSpend(SID);
		const { done: doneA } = await H.startGeneration(SID);
		await H.withDeadline(gateA.arrived);
		setSystemTime(new Date(BASE + 301_000));
		const { done: doneB } = await H.startGeneration(SID);
		await H.withDeadline(gateB.arrived);
		const tokenB = (await rowOf(SID))?.attemptToken;
		expect(tokenB).toBeTruthy();
		gateA.release();
		await H.withDeadline(doneA);
		const row = await rowOf(SID);
		expect(row?.attemptToken).toBe(tokenB);
		expect(row?.attemptStatus).toBe("generating");
		expect(row?.summary).toBeNull();
		const cost = priceCompletion("openai", "gpt-5-mini", {
			inputTokens: H.STUB_USAGE.input,
			outputTokens: H.STUB_USAGE.output,
			estimated: false,
		});
		expect((await H.spendDelta(before)).day).toBe(m + cost);
		gateB.release();
		await H.withDeadline(doneB);
		const after = await rowOf(SID);
		expect(after?.attemptStatus).toBe("idle");
		expect(after?.summary?.overview).toBeTruthy();
		expect((await H.spendDelta(before)).day).toBe(2 * cost);
	});

	test("TC-5.23b the same with a failing late finisher: its failure is not written either", async () => {
		const { editId } = await H.seedActiveSession(SID);
		setSystemTime(new Date(BASE));
		const [gateA, gateB] = [stub.createGate(), stub.createGate()];
		script(
			{ text: "", status: 401, errorBody: "no", gate: gateA },
			{ ...ok([editId]), gate: gateB },
		);
		const { done: doneA } = await H.startGeneration(SID);
		await H.withDeadline(gateA.arrived);
		setSystemTime(new Date(BASE + 301_000));
		const { done: doneB } = await H.startGeneration(SID);
		await H.withDeadline(gateB.arrived);
		gateA.release();
		await H.withDeadline(doneA);
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("generating");
		expect(row?.attemptErrorCode).toBeNull();
		gateB.release();
		await H.withDeadline(doneB);
		expect((await rowOf(SID))?.attemptStatus).toBe("idle");
	});

	test("TC-5.24 a session deleted after the claim and before the adapter returns: no throw, no unhandled rejection, no row, spend settled", async () => {
		const unhandled: unknown[] = [];
		const listener = (e: unknown) => unhandled.push(e);
		process.on("unhandledRejection", listener);
		try {
			const { gate, done } = await startHeld(SID);
			const before = await H.snapshotSpend();
			await H.deleteSession(SID);
			gate.release();
			await H.withDeadline(done);
			await new Promise((r) => setImmediate(r));
			expect(await rowOf(SID)).toBeUndefined();
			const cost = priceCompletion("openai", "gpt-5-mini", {
				inputTokens: H.STUB_USAGE.input,
				outputTokens: H.STUB_USAGE.output,
				estimated: false,
			});
			expect((await H.daySpend()) - before.day).toBe(cost - maxCost());
			expect(svc._summaryGenerationCountForTest()).toBe(0);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	test("TC-5.25 an unknown session id is refused as not found; nothing is inserted", async () => {
		const r = await H.request("never-existed");
		expect(refusal(r)).toEqual({ error: "session_not_found" });
		expect(await H.countSummaryRows(["never-existed"])).toBe(0);
	});
});

describe("refusals take nothing", () => {
	interface Case {
		name: string;
		reason: string;
		arrange: (id: string) => Promise<() => Promise<void>>;
	}
	const CASES: Case[] = [
		{ name: "unknown session", reason: "session_not_found", arrange: async () => async () => {} },
		{
			name: "shutting down",
			reason: "shutting_down",
			arrange: async () => {
				setShuttingDown("test");
				return async () => {
					const { _resetDrainStateForTest } = await import("../drain-state.js");
					_resetDrainStateForTest();
				};
			},
		},
		{
			name: "too little activity",
			reason: "too_little_activity",
			arrange: async (id) => {
				await getDb().delete(events).where(eq(events.sessionId, id));
				return async () => void (await H.seedEvents(id, [H.prompt("hello")]));
			},
		},
		{
			name: "no provider",
			reason: "no_provider",
			arrange: async () => {
				await getDb().update(llmProviders).set({ isDefault: false });
				return async () => void (await getDb().update(llmProviders).set({ isDefault: true }));
			},
		},
		{
			name: "cooldown",
			reason: "summary_cooldown",
			arrange: async (id) => {
				await H.seedSummaryRow(id, {
					attemptStatus: "failed",
					attemptErrorCode: "provider_error",
					attemptStartedAt: toDbTimestamp(new Date()),
				});
				return async () =>
					void (await getDb().update(aiSessionSummaries).set({ attemptErrorCode: "interrupted" }));
			},
		},
		{
			name: "spend cap",
			reason: "spend_cap_reached",
			arrange: async () => {
				await H.setDaySpend(CAP);
				return async () => void (await H.setDaySpend(0));
			},
		},
	];
	for (const c of CASES) {
		test(`TC-5.26 ${c.name}: the row, the day, the slot map are unchanged and an immediate valid request starts`, async () => {
			const { editId } = await H.seedActiveSession(SID);
			const id = c.reason === "session_not_found" ? "res-missing" : SID;
			const fix = await c.arrange(id);
			const before = await H.snapshotSpend(SID);
			const rowBefore = JSON.stringify(await rowOf(SID));
			const r = refusal(await H.request(id));
			expect(String(r?.error)).toBe(c.reason);
			expect(JSON.stringify(await rowOf(SID))).toBe(rowBefore);
			const delta = await H.spendDelta(before);
			expect(delta.day).toBe(0);
			expect(delta.sessions[SID]).toBe(0);
			expect(svc._summaryGenerationCountForTest()).toBe(0);
			if (c.reason === "shutting_down") expect(r?.retryAfterSeconds).toBe(5);
			if (c.reason === "summary_cooldown") expect(r?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
			await fix();
			if (c.reason === "session_not_found") return;
			script(ok([editId]));
			await H.runGeneration(SID);
			expect((await rowOf(SID))?.attemptStatus).toBe("idle");
		});
	}

	test("TC-5.26 a lost claim: the row is the winner's, nothing is spent, the answer is a join", async () => {
		const { editId } = await H.seedActiveSession(SID);
		await H.seedSummaryRow(SID, {});
		svc._setSummaryHooksForTest({
			at: async (step) => {
				if (step === "reserve") {
					await getDb()
						.update(aiSessionSummaries)
						.set({
							attemptStatus: "generating",
							attemptToken: "winner",
							attemptStartedAt: toDbTimestamp(new Date()),
						});
				}
			},
		});
		const before = await H.snapshotSpend(SID);
		const result = await H.request(SID);
		expect(result.kind).toBe("joined");
		expect((await rowOf(SID))?.attemptToken).toBe("winner");
		expect((await H.spendDelta(before)).day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		expect(editId).toBeGreaterThan(0);
	});
});

describe("the order of the steps", () => {
	test("TC-5.27 unknown session wins over shutting down; shutting down wins over a join", async () => {
		setShuttingDown("test");
		expect(refusal(await H.request("res-unknown"))?.error).toBe("session_not_found");
		await H.seedActiveSession(SID);
		await H.seedSummaryRow(SID, {
			attemptStatus: "generating",
			attemptToken: "t",
			attemptStartedAt: toDbTimestamp(new Date()),
		});
		expect(refusal(await H.request(SID))?.error).toBe("shutting_down");
	});

	test("TC-5.27 a join needs no activity, no provider and no budget; the cooldown comes before the activity check", async () => {
		await H.seedSession(SID);
		await getDb().update(llmProviders).set({ isDefault: false });
		await H.setDaySpend(CAP);
		await H.seedSummaryRow(SID, {
			attemptStatus: "generating",
			attemptToken: "t",
			attemptStartedAt: toDbTimestamp(new Date()),
		});
		const joined = await H.request(SID);
		expect(joined.kind).toBe("joined");
		await getDb()
			.update(aiSessionSummaries)
			.set({ attemptStatus: "failed", attemptErrorCode: "provider_error" });
		expect(refusal(await H.request(SID))?.error).toBe("summary_cooldown");
	});

	test("TC-5.27 too little activity comes before no provider; no provider before the budget", async () => {
		await H.seedSession(SID);
		await getDb().update(llmProviders).set({ isDefault: false });
		await H.setDaySpend(CAP);
		expect(refusal(await H.request(SID))?.error).toBe("too_little_activity");
		await H.seedEvents(SID, [H.prompt("hi")]);
		expect(refusal(await H.request(SID))?.error).toBe("no_provider");
		await getDb().update(llmProviders).set({ isDefault: true });
		expect(refusal(await H.request(SID))?.error).toBe("spend_cap_reached");
	});

	test("TC-5.27 the slot comes before the budget: two running and the day at the cap is busy", async () => {
		const a = await startHeld("res-a");
		const b = await startHeld("res-b");
		await H.seedActiveSession("res-c");
		await H.setDaySpend(CAP);
		const r = refusal(await H.request("res-c"));
		expect(r?.error).toBe("busy");
		expect(r?.retryAfterSeconds).toBe(5);
		await H.setDaySpend(0);
		a.gate.release();
		b.gate.release();
		await H.withDeadline(Promise.all([a.done, b.done]));
	});

	test("TC-5.27 a joiner at the cap gets the join; a request inside the cooldown at the cap gets the cooldown", async () => {
		await H.seedActiveSession(SID);
		await H.setDaySpend(CAP);
		await H.seedSummaryRow(SID, {
			attemptStatus: "generating",
			attemptToken: "t",
			attemptStartedAt: toDbTimestamp(new Date()),
		});
		expect((await H.request(SID)).kind).toBe("joined");
		await getDb().update(aiSessionSummaries).set({ attemptStatus: "idle", attemptToken: null });
		expect(refusal(await H.request(SID))?.error).toBe("summary_cooldown");
	});

	test("TC-5.62 effects happen in order: row read, slot, reservation, claim, audit line, detached start", async () => {
		const { editId } = await H.seedActiveSession(SID);
		const trace: string[] = [];
		svc._setSummaryHooksForTest({ at: (step) => void trace.push(step) });
		script(ok([editId]));
		await H.runGeneration(SID);
		const at = (s: string) => trace.indexOf(s);
		for (const s of ["row_read", "slot", "reserve", "claim", "audit", "start"])
			expect(at(s), s).toBeGreaterThanOrEqual(0);
		expect(at("row_read")).toBeLessThan(at("slot"));
		expect(at("slot")).toBeLessThan(at("reserve"));
		expect(at("reserve")).toBeLessThan(at("claim"));
		expect(at("claim")).toBeLessThan(at("audit"));
		expect(at("audit")).toBeLessThan(at("start"));
	});

	test("TC-5.62 a join at the cap and a cooldown at the cap never touch the budget", async () => {
		await H.seedActiveSession(SID);
		await H.setDaySpend(CAP);
		const reserve = spyOn(spend, "reserveSpendCents");
		const trace: string[] = [];
		svc._setSummaryHooksForTest({ at: (step) => void trace.push(step) });
		try {
			await H.seedSummaryRow(SID, {
				attemptStatus: "generating",
				attemptToken: "t",
				attemptStartedAt: toDbTimestamp(new Date()),
			});
			expect((await H.request(SID)).kind).toBe("joined");
			await getDb()
				.update(aiSessionSummaries)
				.set({ attemptStatus: "failed", attemptErrorCode: "provider_error" });
			expect(refusal(await H.request(SID))?.error).toBe("summary_cooldown");
			expect(reserve.mock.calls.length).toBe(0);
			expect(trace).not.toContain("slot");
			expect(trace).not.toContain("reserve");
		} finally {
			reserve.mockRestore();
		}
	});
});

describe("process slots", () => {
	test("TC-5.37 two generations running: a third is refused busy with its reservation returned and the row unchanged; when one finishes the next starts", async () => {
		const a = await startHeld("res-a");
		const b = await startHeld("res-b");
		const { editId } = await H.seedActiveSession("res-c");
		const before = await H.snapshotSpend("res-c");
		const r = refusal(await H.request("res-c"));
		expect(r?.error).toBe("busy");
		expect(await rowOf("res-c")).toBeUndefined();
		expect((await H.spendDelta(before)).day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(2);
		a.gate.release();
		await H.withDeadline(a.done);
		script(ok([editId]));
		await H.runGeneration("res-c");
		expect((await rowOf("res-c"))?.attemptStatus).toBe("idle");
		b.gate.release();
		await H.withDeadline(b.done);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
	});

	test("TC-5.63a an entry that is writing its result still counts toward the cap until its write and settlement finish", async () => {
		const first = await H.seedActiveSession("res-f1");
		const second = await H.seedActiveSession("res-f2");
		const third = await H.seedActiveSession("res-f3");
		let reached!: () => void;
		const atWrite = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let proceed!: () => void;
		const hold = new Promise<void>((resolve) => {
			proceed = resolve;
		});
		let held = false;
		svc._setSummaryHooksForTest({
			at: async (step) => {
				if (step === "finish_write" && !held) {
					held = true;
					reached();
					await hold;
				}
			},
		});
		const gate = stub.createGate();
		script(ok([first.editId]), { ...ok([second.editId]), gate }, ok([third.editId]));
		const { done: doneFirst } = await H.startGeneration("res-f1");
		await H.withDeadline(atWrite);
		const { done: doneSecond } = await H.startGeneration("res-f2");
		await H.withDeadline(gate.arrived);
		expect(refusal(await H.request("res-f3"))?.error).toBe("busy");
		proceed();
		await H.withDeadline(doneFirst);
		await H.runGeneration("res-f3");
		gate.release();
		await H.withDeadline(doneSecond);
		expect((await rowOf("res-f3"))?.attemptStatus).toBe("idle");
	});

	test("TC-5.60 team mode: a second generation by the same caller is refused without taking a slot; another caller proceeds; solo is unlimited", async () => {
		const alice = H.asTeamMember("alice");
		const first = await startHeld("res-t1", alice);
		const second = await H.seedActiveSession("res-t2");
		const before = await H.snapshotSpend("res-t2");
		const r = refusal(await H.request("res-t2", alice));
		expect(r?.error).toBe("caller_generation_running");
		expect(await rowOf("res-t2")).toBeUndefined();
		expect((await H.spendDelta(before)).day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(1);
		expect((await H.request("res-t1", alice)).kind).toBe("joined");
		const gate = await GATED_OK([second.editId]);
		const bob = await H.request("res-t2", H.asTeamMember("bob"));
		expect(bob.kind).toBe("started");
		await H.withDeadline(gate.arrived);
		first.gate.release();
		gate.release();
		await H.withDeadline(first.done);
		if (bob.kind === "started") await H.withDeadline(bob.done);

		const x = await startHeld("res-s1");
		const y = await H.seedActiveSession("res-s2");
		const gateY = await GATED_OK([y.editId]);
		const soloSecond = await H.request("res-s2", H.SOLO);
		expect(soloSecond.kind).toBe("started");
		await H.withDeadline(gateY.arrived);
		x.gate.release();
		gateY.release();
		await H.withDeadline(x.done);
		if (soloSecond.kind === "started") await H.withDeadline(soloSecond.done);
	});

	test("TC-5.28a the activity probe answers busy when the scan queue is full, before any reservation or claim", async () => {
		await H.seedActiveSession(SID);
		const spy = spyOn(ownTurn, "runInOwnTurn").mockImplementation(() =>
			Promise.reject(new ownTurn.OwnTurnBusyError()),
		);
		try {
			const before = await H.snapshotSpend(SID);
			const r = refusal(await H.request(SID));
			expect(r?.error).toBe("busy");
			expect(r?.retryAfterSeconds).toBe(1);
			expect(await rowOf(SID)).toBeUndefined();
			expect((await H.spendDelta(before)).day).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	test("TC-5.28b busy inside the detached work ends the row failed / busy, never stuck generating", async () => {
		await H.seedActiveSession(SID);
		const real = ownTurn.runInOwnTurn;
		let n = 0;
		const spy = spyOn(ownTurn, "runInOwnTurn").mockImplementation((work) =>
			n++ === 0 ? real(work) : Promise.reject(new ownTurn.OwnTurnBusyError()),
		);
		try {
			await H.runGeneration(SID);
			const row = await rowOf(SID);
			expect(row?.attemptStatus).toBe("failed");
			expect(row?.attemptErrorCode).toBe("busy");
			expect(stub.requests().length).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("every exit returns what it holds", () => {
	test("TC-5.48 a session deleted between the probe and the insert: the reservation is returned in full and the answer is not found", async () => {
		await H.seedActiveSession(SID);
		svc._setSummaryHooksForTest({
			at: async (step) => void (step === "reserve" && (await H.deleteSession(SID))),
		});
		const before = await H.snapshotSpend();
		const r = refusal(await H.request(SID));
		expect(r?.error).toBe("session_not_found");
		expect((await H.daySpend()) - before.day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
	});

	test("TC-5.49 an exception after the claim and before the work starts: failed / internal_error, reservation released, slot freed", async () => {
		await H.seedActiveSession(SID);
		svc._setSummaryHooksForTest({
			at: (step) => {
				if (step === "audit") throw new Error("audit write failed");
			},
		});
		const before = await H.snapshotSpend(SID);
		await expect(H.request(SID)).rejects.toThrow();
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("internal_error");
		expect(row?.attemptToken).toBeNull();
		expect((await H.spendDelta(before)).day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		expect(stub.requests().length).toBe(0);
	});

	const EXITS: Array<{
		name: string;
		hook: (step: string) => void | Promise<void>;
		claimed: boolean;
	}> = [
		{
			name: "a throw while reserving",
			hook: (s) => {
				if (s === "reserving") throw new Error("while reserving");
			},
			claimed: false,
		},
		{
			name: "a rejected promise after the reservation",
			hook: (s) => (s === "reserve" ? Promise.reject(new Error("rejected")) : undefined),
			claimed: false,
		},
		{
			name: "a throw at step 12 (the audit write)",
			hook: (s) => {
				if (s === "audit") throw new Error("audit");
			},
			claimed: true,
		},
		{
			name: "a throw after the claim, before the start",
			hook: (s) => {
				if (s === "claim") throw new Error("after claim");
			},
			claimed: true,
		},
	];
	for (const exit of EXITS) {
		test(`TC-5.61 ${exit.name}: spend delta 0, the map empty${exit.claimed ? ", the row failed / internal_error" : ", no row"}`, async () => {
			await H.seedActiveSession(SID);
			svc._setSummaryHooksForTest({ at: exit.hook });
			const before = await H.snapshotSpend(SID);
			const outcome = await H.request(SID).then(
				() => "returned",
				() => "threw",
			);
			expect(["returned", "threw"]).toContain(outcome);
			expect((await H.spendDelta(before)).day).toBe(0);
			expect(svc._summaryGenerationCountForTest()).toBe(0);
			const row = await rowOf(SID);
			if (exit.claimed) {
				expect(row?.attemptStatus).toBe("failed");
				expect(row?.attemptErrorCode).toBe("internal_error");
			} else {
				expect(row === undefined || row.attemptStatus !== "generating").toBe(true);
			}
			expect(stub.requests().length).toBe(0);
		});
	}

	test("TC-5.61 the slot refusal and the cap refusal end with spend delta 0 and an empty map beyond the running ones", async () => {
		await H.seedActiveSession("res-cap");
		await H.setDaySpend(CAP);
		const before = await H.snapshotSpend();
		expect(refusal(await H.request("res-cap"))?.error).toBe("spend_cap_reached");
		expect((await H.daySpend()) - before.day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		expect(await rowOf("res-cap")).toBeUndefined();
	});
});

describe("reserve, then die", () => {
	test("TC-5.50 a process that reserved and never settled leaves the reservation counted; the reclaim reserves its own and the next day starts at 0", async () => {
		const m = maxCost();
		const { editId } = await H.seedActiveSession(SID);
		setSystemTime(new Date(BASE));
		const [gate] = [stub.createGate()];
		script({ ...ok([editId]), gate });
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		expect(await H.daySpend()).toBe(m);
		svc._resetSummaryGenerationsForTest();
		gate.release();
		await H.withDeadline(done);
		expect(await H.daySpend()).toBe(m);
		expect((await rowOf(SID))?.attemptStatus).toBe("generating");

		setSystemTime(new Date(BASE + 301_000));
		const view = await svc.getSessionSummaryView(SID);
		expect(view?.attempt).toMatchObject({ status: "failed", errorCode: "interrupted" });
		script(ok([editId]));
		const { done: reclaim } = await H.startGeneration(SID);
		expect(await H.daySpend()).toBe(2 * m);
		await H.withDeadline(reclaim);
		const cost = priceCompletion("openai", "gpt-5-mini", {
			inputTokens: H.STUB_USAGE.input,
			outputTokens: H.STUB_USAGE.output,
			estimated: false,
		});
		expect(await H.daySpend()).toBe(m + cost);

		const tomorrow = new Date(
			new Date(BASE).getFullYear(),
			new Date(BASE).getMonth(),
			new Date(BASE).getDate() + 1,
			9,
			0,
			0,
		);
		setSystemTime(tomorrow);
		expect((await svc.getSessionSummaryView(SID))?.spend.spentCents).toBe(0);
	});
});

describe("cost of a request", () => {
	test("TC-5.53 the winning path takes at most 10 statements before the 202, a lost claim at most 12; elapsed is recorded", async () => {
		const { editId } = await H.seedActiveSession(SID);
		const gate = await GATED_OK([editId]);
		let started!: Awaited<ReturnType<typeof H.request>>;
		const t0 = performance.now();
		const winning = await countDbCalls(async () => {
			started = await H.request(SID);
		});
		const elapsed = performance.now() - t0;
		expect(started.kind).toBe("started");
		expect(winning).toBeLessThanOrEqual(10);
		console.log(
			`[perf] ${JSON.stringify({ label: "POST before 202", statements: winning, ms: Number(elapsed.toFixed(1)), contractMs: 100, hardMs: 400 })}`,
		);
		expect(elapsed).toBeLessThan(400);
		await H.withDeadline(gate.arrived);
		gate.release();
		if (started.kind === "started") await H.withDeadline(started.done);

		const lostId = "res-lost";
		await H.seedActiveSession(lostId);
		await H.seedSummaryRow(lostId, {});
		svc._setSummaryHooksForTest({
			at: async (step) => {
				if (step === "reserve") {
					await getDb()
						.update(aiSessionSummaries)
						.set({
							attemptStatus: "generating",
							attemptToken: "w",
							attemptStartedAt: toDbTimestamp(new Date()),
						})
						.where(eq(aiSessionSummaries.sessionId, lostId));
				}
			},
		});
		let lost!: Awaited<ReturnType<typeof H.request>>;
		const lostCount = await countDbCalls(async () => {
			lost = await H.request(lostId);
		});
		expect(lost.kind).toBe("joined");
		expect(lostCount).toBeLessThanOrEqual(12 + 1 /* the hook's own seeding write */);
		console.log(`[perf] ${JSON.stringify({ label: "POST lost claim", statements: lostCount })}`);
	});

	test("TC-5.58 every timestamp the service writes has the stored format; the claim writes it too", async () => {
		const { editId } = await H.seedActiveSession(SID);
		const gate = await GATED_OK([editId]);
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		const claimed = await rowOf(SID);
		expect(claimed?.attemptStartedAt).toMatch(TIMESTAMP);
		expect(claimed?.attemptToken).toBeTruthy();
		expect(claimed?.generatedAt).toBeNull();
		gate.release();
		await H.withDeadline(done);
		const row = await rowOf(SID);
		expect(row?.generatedAt).toMatch(TIMESTAMP);
		expect(row?.attemptStartedAt).toMatch(TIMESTAMP);
	});
});
