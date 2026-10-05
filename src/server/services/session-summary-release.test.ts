/**
 * AGEN-69 phase 5: shutdown release (TC-5.38, 5.51, 5.52, 5.63b, BN-9) and the wiring of
 * `gracefulExit` in src/server/index.ts. A running generation has exactly one owner: the
 * finisher or the release, whichever takes its process entry first (synchronously).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiSessionSummaries } = await import("../db/schema/index.js");
const H = await import("../test-utils/summary-service-harness.js");
const svc = await import("./session-summary-service.js");
const ownTurn = await import("../util/own-turn.js");
const registry = await import("./ai/llm/registry.js");
const { setShuttingDown } = await import("../drain-state.js");
const { priceCompletion } = await import("./ai/llm/pricing.js");
const { estimateTokens } = await import("./ai/llm/types.js");
const { MAX_OUTPUT_TOKENS } = await import("./ai/session-summary/service-limits.js");

const SID = "rel-s1";
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
const rowOf = (id: string) => H.readSummaryRow(id);
const ACTUAL = () =>
	priceCompletion("openai", "gpt-5-mini", {
		inputTokens: H.STUB_USAGE.input,
		outputTokens: H.STUB_USAGE.output,
		estimated: false,
	});

/**
 * What a release charges for a call in flight (R-I): its outcome is unknown, so the single-call
 * maximum of the text actually sent, at the worst-case token ratio (written out here, not imported).
 */
function unknownOutcomeCents(): number {
	const { system, user } = H.promptsOf(stub.requests()[0]);
	const text = system + user;
	return priceCompletion("openai", "gpt-5-mini", {
		inputTokens: Math.max(estimateTokens(text), Math.ceil(Buffer.byteLength(text, "utf8") / 2)),
		outputTokens: MAX_OUTPUT_TOKENS,
		estimated: true,
	});
}

async function startHeld(id: string) {
	const { editId } = await H.seedActiveSession(id);
	const gate = stub.createGate();
	script({ ...ok([editId]), gate });
	const { done } = await H.startGeneration(id);
	await H.withDeadline(gate.arrived);
	return { gate, done, editId };
}

describe("release, finish, and the two orderings", () => {
	test("TC-5.38a finish then release: the finisher owns the write and settlement; the release finds nothing", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		await svc.releaseOwnSummaryClaims();
		expect((await rowOf(SID))?.attemptStatus).toBe("idle");
		expect((await H.spendDelta(before)).day).toBe(ACTUAL());
	});

	test("TC-5.38b release then finish: release writes failed / interrupted under the guard with the token cleared and settles per D-25; the late finisher writes and settles nothing", async () => {
		const { gate, done } = await startHeld(SID);
		const before = await H.snapshotSpend(SID);
		expect((await H.daySpend()) - before.day).toBe(0);
		await svc.releaseOwnSummaryClaims();
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("interrupted");
		expect(row?.attemptToken).toBeNull();
		const charged = unknownOutcomeCents();
		expect(await H.daySpend()).toBe(charged);
		expect(await H.sessionSpend(SID)).toBe(charged);
		// the view reads it at once, and a new claim wins inside the cooldown
		const view = await svc.getSessionSummaryView(SID);
		expect(view?.attempt).toMatchObject({ status: "failed", errorCode: "interrupted" });
		expect(view?.blocked).toBeNull();
		gate.release();
		await H.withDeadline(done);
		const after = await rowOf(SID);
		expect(after?.attemptStatus).toBe("failed");
		expect(after?.summary).toBeNull();
		expect(await H.daySpend()).toBe(charged);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		// idempotent
		await svc.releaseOwnSummaryClaims();
		expect(await H.daySpend()).toBe(charged);
	});

	test("TC-5.38c a release in the reading phase returns everything: no request is ever sent", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		const real = ownTurn.runInOwnTurn;
		let n = 0;
		let unblock!: () => void;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const spy = spyOn(ownTurn, "runInOwnTurn").mockImplementation((work) =>
			n++ === 0 ? real(work) : blocked.then(() => real(work)),
		);
		try {
			const { done } = await H.startGeneration(SID);
			await svc.releaseOwnSummaryClaims();
			expect(await H.daySpend()).toBe(0);
			expect((await rowOf(SID))?.attemptErrorCode).toBe("interrupted");
			unblock();
			await H.withDeadline(done);
			expect(stub.requests().length).toBe(0);
			expect(await H.daySpend()).toBe(0);
		} finally {
			unblock();
			spy.mockRestore();
			stub.reset();
		}
	});

	test("TC-5.38d an entry that is writing its result is skipped by release and completes normally", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		let reached!: () => void;
		const atWrite = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let proceed!: () => void;
		const hold = new Promise<void>((resolve) => {
			proceed = resolve;
		});
		svc._setSummaryHooksForTest({
			at: async (step) => {
				if (step === "finish_write") {
					reached();
					await hold;
				}
			},
		});
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(atWrite);
		await svc.releaseOwnSummaryClaims();
		expect((await rowOf(SID))?.attemptStatus).toBe("generating");
		proceed();
		await H.withDeadline(done);
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("idle");
		expect(row?.summary?.overview).toBeTruthy();
		expect(await H.daySpend()).toBe(ACTUAL());
	});

	test("TC-5.38e a hung adapter never blocks the release (the settlement hang is pinned in session-summary-lifecycle.test.ts)", async () => {
		const { gate, done } = await startHeld(SID);
		const t = performance.now();
		await svc.releaseOwnSummaryClaims();
		expect(performance.now() - t).toBeLessThan(2500);
		gate.release();
		await H.withDeadline(done);
	});

	test("TC-5.51a finisher first: the release finds it finishing; spend is the actual, once, and the token is cleared", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		let reached!: () => void;
		const atWrite = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let proceed!: () => void;
		const hold = new Promise<void>((resolve) => {
			proceed = resolve;
		});
		svc._setSummaryHooksForTest({
			at: async (step) => {
				if (step === "finish_write") {
					reached();
					await hold;
				}
			},
		});
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(atWrite);
		await svc.releaseOwnSummaryClaims();
		proceed();
		await H.withDeadline(done);
		expect(await H.daySpend()).toBe(ACTUAL());
		expect((await rowOf(SID))?.attemptToken).toBeNull();
		expect(await H.daySpend()).toBeGreaterThanOrEqual(0);
	});

	test("TC-5.51b release first with a real gate: the D-25 amount exactly once, the finisher writes nothing", async () => {
		const { gate, done } = await startHeld(SID);
		await svc.releaseOwnSummaryClaims();
		gate.release();
		await H.withDeadline(done);
		expect(await H.daySpend()).toBe(unknownOutcomeCents());
		expect((await rowOf(SID))?.attemptErrorCode).toBe("interrupted");
		expect((await rowOf(SID))?.summary).toBeNull();
	});

	test("TC-5.63b after a release and a new claim, the released run's late finish cannot touch the newer row", async () => {
		const { gate, done, editId } = await startHeld(SID);
		await svc.releaseOwnSummaryClaims();
		const gateB = stub.createGate();
		script({ ...ok([editId]), gate: gateB });
		const { done: doneB } = await H.startGeneration(SID);
		await H.withDeadline(gateB.arrived);
		const tokenB = (await rowOf(SID))?.attemptToken;
		gate.release();
		await H.withDeadline(done);
		const row = await rowOf(SID);
		expect(row?.attemptToken).toBe(tokenB);
		expect(row?.attemptStatus).toBe("generating");
		gateB.release();
		await H.withDeadline(doneB);
		expect((await rowOf(SID))?.attemptStatus).toBe("idle");
	});

	test("TC-5.63c a write needs the generating status as well as the token: a second write of any kind matches nothing", async () => {
		const { gate, done } = await startHeld(SID);
		await getDb()
			.update(aiSessionSummaries)
			.set({ attemptStatus: "failed", attemptErrorCode: "interrupted" })
			.where(eq(aiSessionSummaries.sessionId, SID));
		gate.release();
		await H.withDeadline(done);
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("interrupted");
		expect(row?.summary).toBeNull();
		expect(row?.attemptToken).toBeTruthy();
	});

	test("BN-9 a release that lands between the claim and the hand-over skips the half-built entry; the run then completes", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		svc._setSummaryHooksForTest({
			at: async (step) => {
				if (step === "claim") await svc.releaseOwnSummaryClaims();
			},
		});
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		const row = await rowOf(SID);
		expect(row?.attemptStatus).toBe("idle");
		expect((await H.spendDelta(before)).day).toBe(ACTUAL());
	});

	test("a request that reaches the hand-over while the server is shutting down ends interrupted and returns its reservation", async () => {
		await H.seedActiveSession(SID);
		svc._setSummaryHooksForTest({
			at: (step) => void (step === "start" && setShuttingDown("test")),
		});
		const result = await H.request(SID);
		expect(H.refusalOf(result)).toBe("shutting_down");
		expect((await rowOf(SID))?.attemptErrorCode).toBe("interrupted");
		expect(await H.daySpend()).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		expect(stub.requests().length).toBe(0);
	});
});

describe("TC-5.52 the slot map is empty after every terminal path", () => {
	test("30 runs across success, parse failure, provider error, deleted session, lost token, release and internal error", async () => {
		const paths = [
			"success",
			"parse",
			"provider",
			"deleted",
			"lost_token",
			"release",
			"internal",
		] as const;
		for (let i = 0; i < 30; i++) {
			const path = paths[i % paths.length];
			const id = `rel-cycle-${i}`;
			const { editId } = await H.seedActiveSession(id);
			if (path === "success") {
				script(ok([editId]));
				await H.runGeneration(id);
			} else if (path === "parse") {
				script({ text: "nope", stop: "stop" }, { text: "still nope", stop: "stop" });
				await H.runGeneration(id);
			} else if (path === "provider") {
				script({ text: "", status: 401, errorBody: "x" });
				await H.runGeneration(id);
			} else if (path === "internal") {
				const spy = spyOn(registry, "getAdapter").mockImplementation(() => {
					throw new TypeError("boom");
				});
				try {
					await H.runGeneration(id);
				} finally {
					spy.mockRestore();
				}
			} else {
				const gate = stub.createGate();
				script({ ...ok([editId]), gate });
				const { done } = await H.startGeneration(id);
				await H.withDeadline(gate.arrived);
				if (path === "deleted") await H.deleteSession(id);
				if (path === "lost_token")
					await getDb()
						.update(aiSessionSummaries)
						.set({ attemptToken: "someone-else" })
						.where(eq(aiSessionSummaries.sessionId, id));
				if (path === "release") await svc.releaseOwnSummaryClaims();
				gate.release();
				await H.withDeadline(done);
			}
			expect(svc._summaryGenerationCountForTest(), `${path} #${i}`).toBe(0);
		}
		expect(await H.daySpend()).toBeGreaterThanOrEqual(0);
		const { editId } = await H.seedActiveSession("rel-next");
		script(ok([editId]));
		await H.runGeneration("rel-next");
		expect((await rowOf("rel-next"))?.attemptStatus).toBe("idle");
	}, 120_000);
});

describe("gracefulExit releases the claims", () => {
	test("index.ts awaits releaseOwnSummaryClaims() after setShuttingDown and before process.exit, outside comments", () => {
		const raw = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
		const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const body = text.slice(text.indexOf("async function gracefulExit"));
		const shut = body.indexOf("setShuttingDown(");
		const release = body.indexOf("await releaseOwnSummaryClaims()");
		const exit = body.indexOf("process.exit(");
		expect(shut).toBeGreaterThan(-1);
		expect(release).toBeGreaterThan(shut);
		expect(exit).toBeGreaterThan(release);
		expect(text).toContain("session-summary-service.js");
	});

	test("the scan ignores a mention in a comment: a release that is only commented out does not count", () => {
		const raw =
			"async function gracefulExit() {\n// await releaseOwnSummaryClaims()\n process.exit(0);\n}";
		const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(text.indexOf("await releaseOwnSummaryClaims()")).toBe(-1);
	});
});
