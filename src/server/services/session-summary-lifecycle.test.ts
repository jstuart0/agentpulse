/**
 * AGEN-69 phase 5 review fixes, section B: concurrency and lifecycle (P5-5 to P5-13, P5-18, P5-19).
 * Real database, the real registry and adapters through the stub provider; the `at()` hooks hold
 * requests at named steps so each race is deterministic, never a sleep.
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
import "./ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiSessionSummaries } = await import("../db/schema/index.js");
const H = await import("../test-utils/summary-service-harness.js");
const svc = await import("./session-summary-service.js");
const spend = await import("./ai/spend-service.js");
const labs = await import("./labs-service.js");
const limits = await import("./ai/session-summary/service-limits.js");
const evidenceLoader = await import("./ai/session-summary/evidence-loader.js");
const tripwire = await import("./ai/session-summary/tripwire.js");
const { setShuttingDown } = await import("../drain-state.js");
const { priceCompletion } = await import("./ai/llm/pricing.js");
const { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } = await import(
	"./ai/session-summary/service-limits.js"
);
const { toDbTimestamp } = await import("./util/db-time.js");

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
const reservationOfOneCall = () =>
	priceCompletion("openai", "gpt-5-mini", {
		inputTokens: MAX_INPUT_TOKENS,
		outputTokens: MAX_OUTPUT_TOKENS,
		estimated: true,
	});

/** A request held at a named step until `release()`; only the first request to reach it is held. */
function holdAt(step: string, extra: Record<string, number> = {}) {
	let reached!: () => void;
	const atStep = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let joinWaiting!: () => void;
	const atJoinWait = new Promise<void>((resolve) => {
		joinWaiting = resolve;
	});
	let taken = false;
	svc._setSummaryHooksForTest({
		...extra,
		at: async (s) => {
			if (s === "join_wait") joinWaiting();
			if (s === step && !taken) {
				taken = true;
				reached();
				await hold;
			}
		},
	});
	return { atStep, release, atJoinWait };
}

/** A generation held at its model call: it occupies a slot until the gate is released. */
async function occupySlot(id: string) {
	const { editId } = await H.seedActiveSession(id);
	const gate = stub.createGate();
	script({ ...ok([editId]), gate });
	const { done } = await H.startGeneration(id);
	await H.withDeadline(gate.arrived);
	return { gate, done };
}

describe("P5-6 one audit line per accepted request, written after the last shutdown check", () => {
	const auditLines = (lines: string[]) =>
		lines.filter((l) => l.includes("session_summary_requested"));

	test("a started request logs exactly one line; a join logs none", async () => {
		const { editId } = await H.seedActiveSession("lc-audit");
		const gate = stub.createGate();
		script({ ...ok([editId]), gate });
		const logs = H.captureLogs();
		try {
			const { done } = await H.startGeneration("lc-audit");
			await H.withDeadline(gate.arrived);
			expect((await H.request("lc-audit")).kind).toBe("joined");
			expect(auditLines(logs.lines)).toHaveLength(1);
			gate.release();
			await H.withDeadline(done);
			expect(auditLines(logs.lines)).toHaveLength(1);
		} finally {
			logs.restore();
		}
	});

	test("a request refused shutting_down at the hand-over logs nothing", async () => {
		await H.seedActiveSession("lc-audit-shut");
		svc._setSummaryHooksForTest({
			at: (step) => {
				if (step === "start") setShuttingDown("test");
			},
		});
		const logs = H.captureLogs();
		try {
			const result = await H.request("lc-audit-shut");
			expect(H.refusalOf(result)).toBe("shutting_down");
			expect(auditLines(logs.lines)).toHaveLength(0);
		} finally {
			logs.restore();
		}
	});
});

describe("P5-8 a caller that raced a same-session request joins it; the wait is bounded", () => {
	test("A held at the reservation, the second slot taken by another session: a request for A's session is joined, never busy; one reservation for the session on the day, two generations counted", async () => {
		const other = await occupySlot("lc-other");
		const { editId } = await H.seedActiveSession("lc-same");
		const gateSame = stub.createGate();
		script({ ...ok([editId]), gate: gateSame });
		const held = holdAt("reserve");
		const a = H.request("lc-same");
		await H.withDeadline(held.atStep);
		const b = H.request("lc-same");
		// B has been refused the slot and is waiting for A's answer: only now does A go on.
		await H.withDeadline(held.atJoinWait);
		held.release();
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra.kind).toBe("started");
		expect(rb.kind).toBe("joined");
		await H.withDeadline(gateSame.arrived);
		expect(await H.daySpend()).toBe(2 * reservationOfOneCall());
		expect(svc._summaryGenerationCountForTest()).toBe(2);
		expect(stub.requests().length).toBe(2);
		gateSame.release();
		other.gate.release();
		await H.withDeadline(other.done);
		if (ra.kind === "started") await H.withDeadline(ra.done);
	});

	test("A held at its slot and never released: the same-session request is answered busy at the join-wait bound, not left waiting", async () => {
		const other = await occupySlot("lc-other");
		const { editId } = await H.seedActiveSession("lc-stuck");
		script(ok([editId]));
		const held = holdAt("slot", { joinWaitMs: 400 });
		const a = H.request("lc-stuck");
		await H.withDeadline(held.atStep);
		const t = performance.now();
		const bPending = H.request("lc-stuck");
		await H.withDeadline(held.atJoinWait);
		const b = await H.withDeadline(bPending, 9000, "the bounded wait");
		const waited = performance.now() - t;
		expect(H.refusalOf(b)).toBe("busy");
		// The injected bound (400 ms), not the default 5 s: the band is against that value.
		expect(waited).toBeGreaterThan(350);
		expect(waited).toBeLessThan(3000);
		held.release();
		const ra = await a;
		other.gate.release();
		await H.withDeadline(other.done);
		if (ra.kind === "started") await H.withDeadline(ra.done);
	}, 30_000);
});

describe("P5-10 a watchdog frees a slot whose run hangs", () => {
	test("two runs hung before they call the model: at the lease expiry both are failed / interrupted, their reservations returned and their slots free, so a third request starts", async () => {
		for (const id of ["lc-hang-a", "lc-hang-b"]) await H.seedActiveSession(id);
		const { editId } = await H.seedActiveSession("lc-after");
		const spy = spyOn(evidenceLoader, "loadEvidence").mockImplementation(
			() => new Promise(() => {}),
		);
		svc._setSummaryHooksForTest({ watchdogMs: 3000 });
		try {
			await H.startGeneration("lc-hang-a");
			await H.startGeneration("lc-hang-b");
			expect(svc._summaryGenerationCountForTest()).toBe(2);
			await H.until(() => svc._summaryGenerationCountForTest() === 0, 15_000);
			for (const id of ["lc-hang-a", "lc-hang-b"]) {
				const row = await H.readSummaryRow(id);
				expect(row?.attemptStatus, id).toBe("failed");
				expect(row?.attemptErrorCode, id).toBe("interrupted");
				expect(row?.attemptToken, id).toBeNull();
			}
			expect(await H.daySpend()).toBe(0);
		} finally {
			spy.mockRestore();
		}
		svc._setSummaryHooksForTest(null);
		script(ok([editId]));
		await H.runGeneration("lc-after");
		expect((await H.readSummaryRow("lc-after"))?.attemptStatus).toBe("idle");
	});

	test("a run with a call pending is settled as an unknown outcome when the watchdog fires, and the late answer settles nothing more", async () => {
		const { editId } = await H.seedActiveSession("lc-hang-call");
		const gate = stub.createGate();
		script({ ...ok([editId]), gate });
		svc._setSummaryHooksForTest({ watchdogMs: 1500 });
		const { done } = await H.startGeneration("lc-hang-call");
		await H.withDeadline(gate.arrived);
		await H.until(() => svc._summaryGenerationCountForTest() === 0, 15_000);
		const { system, user } = H.promptsOf(stub.requests()[0]);
		const text = system + user;
		const charged = priceCompletion("openai", "gpt-5-mini", {
			inputTokens: Math.max(Math.ceil(text.length / 4.5), Math.ceil(Buffer.byteLength(text) / 2)),
			outputTokens: MAX_OUTPUT_TOKENS,
			estimated: true,
		});
		expect(await H.daySpend()).toBe(charged);
		gate.release();
		await H.withDeadline(done);
		const row = await H.readSummaryRow("lc-hang-call");
		expect(row?.attemptErrorCode).toBe("interrupted~long");
		expect(row?.summary).toBeNull();
		expect(await H.daySpend()).toBe(charged);
	});
});

describe("P5-11 boot and shutdown", () => {
	test("recoverInterruptedSummaries marks rows left generating as failed / interrupted (single-replica SQLite only; on Postgres another replica may own the row)", async () => {
		await H.seedActiveSession("lc-boot-a");
		await H.seedActiveSession("lc-boot-b");
		await H.seedActiveSession("lc-boot-idle");
		await H.seedSummaryRow("lc-boot-a", {
			attemptStatus: "generating",
			attemptToken: "t1",
			attemptStartedAt: toDbTimestamp(new Date()),
		});
		await H.seedSummaryRow("lc-boot-b", {
			attemptStatus: "generating",
			attemptToken: "t2",
			attemptStartedAt: toDbTimestamp(new Date(Date.now() - 3600_000)),
		});
		await H.seedSummaryRow("lc-boot-idle", { attemptStatus: "idle" });
		const recovered = await svc.recoverInterruptedSummaries();
		if (config.dialect === "postgres") {
			expect(recovered).toBe(0);
			for (const id of ["lc-boot-a", "lc-boot-b"]) {
				expect((await H.readSummaryRow(id))?.attemptStatus, id).toBe("generating");
			}
			return;
		}
		expect(recovered).toBe(2);
		for (const id of ["lc-boot-a", "lc-boot-b"]) {
			const row = await H.readSummaryRow(id);
			expect(row?.attemptStatus, id).toBe("failed");
			expect(row?.attemptErrorCode, id).toBe("interrupted");
			expect(row?.attemptToken, id).toBeNull();
		}
		expect((await H.readSummaryRow("lc-boot-idle"))?.attemptStatus).toBe("idle");
		const view = await svc.getSessionSummaryView("lc-boot-a");
		expect(view?.attempt).toMatchObject({ status: "failed", errorCode: "interrupted" });
	});

	test("index.ts runs the recovery before it marks the database ready", () => {
		const code = readFileSync(join(import.meta.dir, "../index.ts"), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		const recover = code.indexOf("await recoverInterruptedSummaries(");
		expect(recover).toBeGreaterThan(-1);
		expect(recover).toBeGreaterThan(code.indexOf("await initializeDatabase("));
		expect(recover).toBeLessThan(code.indexOf("markDbReady()"));
	});

	test("a release waits for an entry that is writing its result (bounded), so a kill during the write does not lose a billed answer", async () => {
		const { editId } = await H.seedActiveSession("lc-finishing");
		script(ok([editId]));
		const held = holdAt("finish_write");
		const { done } = await H.startGeneration("lc-finishing");
		await H.withDeadline(held.atStep);
		let released = false;
		const release = svc.releaseOwnSummaryClaims().then(() => {
			released = true;
		});
		await new Promise((r) => setTimeout(r, 100));
		expect(released).toBe(false);
		held.release();
		await H.withDeadline(release, 5000, "the release");
		expect((await H.readSummaryRow("lc-finishing"))?.attemptStatus).toBe("idle");
		await H.withDeadline(done);
	});
});

describe("P5-12 the release is bounded even when a settlement hangs", () => {
	test("a releaseReservedSpend that never resolves: the release returns within its budget", async () => {
		const { editId } = await H.seedActiveSession("lc-hung-release");
		script(ok([editId]));
		const spy = spyOn(spend, "releaseReservedSpend").mockImplementation(
			() => new Promise(() => {}),
		);
		// A run still reading: the release returns the whole reservation, which is where the hang is.
		const ownTurn = await import("../util/own-turn.js");
		const real = ownTurn.runInOwnTurn;
		let n = 0;
		let unblock!: () => void;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const turn = spyOn(ownTurn, "runInOwnTurn").mockImplementation((work) =>
			n++ === 0 ? real(work) : blocked.then(() => real(work)),
		);
		try {
			svc._setSummaryHooksForTest({ releaseBudgetMs: 300 });
			const { done } = await H.startGeneration("lc-hung-release");
			const t = performance.now();
			await svc.releaseOwnSummaryClaims();
			const elapsed = performance.now() - t;
			// The injected budget (300 ms), not the default 2 s.
			expect(elapsed).toBeGreaterThan(250);
			expect(elapsed).toBeLessThan(1500);
			// The hung entry stays in the map until the process exits: this test is the one that clears it.
			expect(svc._summaryGenerationCountForTest()).toBe(1);
			svc._resetSummaryGenerationsForTest();
			expect(svc._summaryGenerationCountForTest()).toBe(0);
			unblock();
			await H.withDeadline(done);
		} finally {
			unblock();
			spy.mockRestore();
			turn.mockRestore();
			stub.reset();
		}
	}, 20_000);
});

describe("P5-18 the POST reads the attempt columns only", () => {
	test("with a 59 KB stored summary on the row, no select of the request names the summary or the provenance", async () => {
		const { promptId, editId } = await H.seedActiveSession("lc-cols");
		await H.seedReadySummary("lc-cols", { throughEventId: editId, firstEventId: promptId });
		await getDb()
			.update(aiSessionSummaries)
			.set({ attemptStartedAt: toDbTimestamp(new Date(Date.now() - 3600_000)) });
		script(ok([editId]));
		const db = getDb() as unknown as { select: (fields?: Record<string, unknown>) => unknown };
		const original = db.select.bind(db);
		const shapes: string[][] = [];
		const spy = spyOn(db, "select").mockImplementation((fields?: Record<string, unknown>) => {
			shapes.push(Object.keys(fields ?? {}));
			return original(fields);
		});
		try {
			await H.runGeneration("lc-cols");
		} finally {
			spy.mockRestore();
		}
		const request = shapes.slice(0, 6);
		expect(request.length).toBeGreaterThan(0);
		for (const keys of request) {
			expect(keys).not.toContain("summary");
			expect(keys).not.toContain("provenance");
		}
	});
});

describe("P5-19 the prompt URLs are collected in slices that yield the event loop", () => {
	test("170,000 characters of prompts reach collectUserPromptUrls in several bounded calls", async () => {
		await H.seedSession("lc-urls");
		const rows = Array.from({ length: 100 }, (_, i) =>
			H.prompt(`see https://example.test/${i} ${"word ".repeat(340)}`),
		);
		rows.push(H.edit("src/a.ts"));
		const ids = await H.seedEvents("lc-urls", rows);
		script(ok([ids[ids.length - 1]]));
		const real = tripwire.collectUserPromptUrls;
		const sizes: number[] = [];
		const spy = spyOn(tripwire, "collectUserPromptUrls").mockImplementation((texts) => {
			const list = [...texts];
			sizes.push(list.reduce((n, t) => n + t.length, 0));
			return real(list);
		});
		try {
			await H.runGeneration("lc-urls");
		} finally {
			spy.mockRestore();
		}
		expect(sizes.length).toBeGreaterThanOrEqual(4);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
		expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(100_000);
	});
});

describe("the timings are pinned (Q-6, Q-8b)", () => {
	test("TC-5.65 with no hook set the watchdog is the lease (300 s), the join wait 5 s and the release budget 2 s, and the hooks override each", () => {
		svc._setSummaryHooksForTest(null);
		expect(svc.watchdogDelayMs()).toBe(300_000);
		expect(svc.joinWaitMs()).toBe(5000);
		expect(svc.releaseBudgetMs()).toBe(2000);
		expect(limits.SUMMARY_LEASE_SECONDS * 1000).toBe(300_000);
		expect(limits.JOIN_WAIT_BUDGET_MS).toBe(5000);
		expect(limits.SHUTDOWN_RELEASE_BUDGET_MS).toBe(2000);
		svc._setSummaryHooksForTest({ watchdogMs: 11, joinWaitMs: 22, releaseBudgetMs: 33 });
		expect([svc.watchdogDelayMs(), svc.joinWaitMs(), svc.releaseBudgetMs()]).toEqual([11, 22, 33]);
	});
});

describe("Q-4 a release that lands while the gates are re-read", () => {
	test("held in the Labs flag read after call 1's unusable answer, with a reservation that already covers the repair: one request, interrupted", async () => {
		await H.seedActiveSession("lc-gates");
		const gate = stub.createGate();
		script({ text: "nope", stop: "stop", usage: H.STUB_USAGE, gate }, ok([1]));
		const real = labs.isLabsFlagEnabled;
		let reached!: () => void;
		const atGates = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let proceed!: () => void;
		const hold = new Promise<void>((resolve) => {
			proceed = resolve;
		});
		const spy = spyOn(labs, "isLabsFlagEnabled").mockImplementation(
			async (...args: Parameters<typeof real>) => {
				reached();
				await hold;
				return real(...args);
			},
		);
		const topUp = spyOn(spend, "topUpReservation");
		try {
			const { done } = await H.startGeneration("lc-gates");
			await H.withDeadline(gate.arrived);
			gate.release();
			await H.withDeadline(atGates);
			await svc.releaseOwnSummaryClaims();
			proceed();
			await H.withDeadline(done);
			expect(topUp.mock.calls.length).toBe(0);
			expect(stub.requests().length).toBe(1);
			expect((await H.readSummaryRow("lc-gates"))?.attemptErrorCode).toBe("interrupted");
			expect(svc._summaryGenerationCountForTest()).toBe(0);
		} finally {
			proceed();
			topUp.mockRestore();
			spy.mockRestore();
			stub.reset();
		}
	});
});

describe("Q-5 the watchdog before the hand-over", () => {
	test("a request held after its reservation: the watchdog frees its slot and returns the reservation; once woken it ends interrupted and releases nothing twice", async () => {
		const other = await occupySlot("lc-wd-other");
		const { editId } = await H.seedActiveSession("lc-wd-pre");
		script(ok([editId]));
		const held = holdAt("reserve", { watchdogMs: 400 });
		const request = H.request("lc-wd-pre");
		await H.withDeadline(held.atStep);
		expect(svc._summaryGenerationCountForTest()).toBe(2);
		await H.until(() => svc._summaryGenerationCountForTest() === 1, 10_000);
		// The other session's reservation is all that is left on the day (the release follows the slot).
		await H.until(async () => (await H.daySpend()) === reservationOfOneCall(), 10_000);
		held.release();
		const result = await H.withDeadline(request);
		expect(H.refusalOf(result)).toBe("shutting_down");
		const row = await H.readSummaryRow("lc-wd-pre");
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("interrupted");
		expect(row?.attemptToken).toBeNull();
		expect(await H.daySpend()).toBe(reservationOfOneCall());
		expect(stub.requests().length).toBe(1);
		other.gate.release();
		await H.withDeadline(other.done);
		stub.reset();
	});
});

describe("Q-3d the watchdog also covers a finishing entry whose write hangs", () => {
	test("held in the row write with the watchdog short: the slot is freed and the reservation is settled at the actual cost", async () => {
		const { editId } = await H.seedActiveSession("lc-wd-fin");
		script(ok([editId]));
		const held = holdAt("finish_write", { watchdogMs: 600 });
		const { done } = await H.startGeneration("lc-wd-fin");
		await H.withDeadline(held.atStep);
		expect(svc._summaryGenerationCountForTest()).toBe(1);
		await H.until(() => svc._summaryGenerationCountForTest() === 0, 10_000);
		const actual = priceCompletion("openai", "gpt-5-mini", {
			inputTokens: H.STUB_USAGE.input,
			outputTokens: H.STUB_USAGE.output,
			estimated: false,
		});
		// The slot is freed first and the settlement follows: wait for the money, not a tick.
		await H.until(async () => (await H.daySpend()) === actual, 10_000);
		held.release();
		await H.withDeadline(done);
		expect(await H.daySpend()).toBe(actual);
	});
});

describe("Q-8a the URL scan lets the event loop go between slices", () => {
	test("a setImmediate marker scheduled in the first slice runs before the second slice starts", async () => {
		await H.seedSession("lc-yield");
		const rows = Array.from({ length: 60 }, (_, i) =>
			H.prompt(`see https://example.test/${i} ${"word ".repeat(340)}`),
		);
		rows.push(H.edit("src/a.ts"));
		const ids = await H.seedEvents("lc-yield", rows);
		script(ok([ids[ids.length - 1]]));
		const real = tripwire.collectUserPromptUrls;
		const order: string[] = [];
		const spy = spyOn(tripwire, "collectUserPromptUrls").mockImplementation((texts) => {
			order.push(`call${order.filter((o) => o.startsWith("call")).length}`);
			if (order.length === 1) setImmediate(() => order.push("marker"));
			return real([...texts]);
		});
		try {
			await H.runGeneration("lc-yield");
		} finally {
			spy.mockRestore();
		}
		expect(order.slice(0, 3)).toEqual(["call0", "marker", "call1"]);
	});
});

describe("F-1 a released in-flight call moves the failure controls", () => {
	async function heldCall(id: string, hooks: Record<string, number> = {}) {
		const { editId } = await H.seedActiveSession(id);
		const gate = stub.createGate();
		script({ ...ok([editId]), gate });
		svc._setSummaryHooksForTest(hooks);
		const { done } = await H.startGeneration(id);
		await H.withDeadline(gate.arrived);
		return { gate, done };
	}
	/** What the release must have moved: the breaker entry, the session cooldown, the daily ceiling. */
	async function effects(id: string) {
		svc._setSummaryHooksForTest({ unknownCeilingCents: 1 });
		const { editId } = await H.seedActiveSession("f1-probe");
		script(ok([editId]));
		const probe = await H.request("f1-probe");
		const ceiling = H.refusalOf(probe);
		if (probe.kind === "started") await H.withDeadline(probe.done);
		const view = await svc.getSessionSummaryView(id);
		const row = await H.readSummaryRow(id);
		return {
			breaker: svc._breakerForTest.has(H.SOLO.subject),
			ceiling,
			code: row?.attemptErrorCode,
			blocked: view?.blocked,
			cooldown: view?.cooldownSeconds ?? 0,
		};
	}

	test("a watchdog release during a hung call records the breaker and the ceiling and cools the session for 10 minutes", async () => {
		svc._breakerForTest.reset();
		const { gate, done } = await heldCall("f1-wd", { watchdogMs: 300 });
		await H.until(() => svc._summaryGenerationCountForTest() === 0, 10_000);
		const e = await effects("f1-wd");
		expect(e.breaker).toBe(true);
		expect(e.ceiling).toBe("spend_cap_reached");
		expect(e.code).toBe("interrupted~long");
		expect(e.blocked).toBe("summary_cooldown");
		expect(e.cooldown).toBeGreaterThan(590);
		gate.release();
		await H.withDeadline(done);
	});

	test("a shutdown release during a call in flight does the same", async () => {
		svc._breakerForTest.reset();
		const { gate, done } = await heldCall("f1-sd");
		await svc.releaseOwnSummaryClaims();
		const e = await effects("f1-sd");
		expect(e.breaker).toBe(true);
		expect(e.ceiling).toBe("spend_cap_reached");
		expect(e.code).toBe("interrupted~long");
		expect(e.cooldown).toBeGreaterThan(590);
		gate.release();
		await H.withDeadline(done);
	});

	test("a release with nothing pending changes none of them: plain interrupted, no cooldown", async () => {
		svc._breakerForTest.reset();
		const { editId } = await H.seedActiveSession("f1-none");
		script(ok([editId]));
		const real = (await import("../util/own-turn.js")).runInOwnTurn;
		const ownTurn = await import("../util/own-turn.js");
		let n = 0;
		let unblock!: () => void;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const turn = spyOn(ownTurn, "runInOwnTurn").mockImplementation((work) =>
			n++ === 0 ? real(work) : blocked.then(() => real(work)),
		);
		try {
			const { done } = await H.startGeneration("f1-none");
			await svc.releaseOwnSummaryClaims();
			unblock();
			await H.withDeadline(done);
			const e = await effects("f1-none");
			expect(e.breaker).toBe(false);
			expect(e.ceiling).not.toBe("spend_cap_reached");
			expect(e.code).toBe("interrupted");
			expect(e.cooldown).toBe(0);
		} finally {
			unblock();
			turn.mockRestore();
			stub.reset();
		}
	});
});
