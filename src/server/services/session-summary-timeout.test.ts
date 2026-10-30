/**
 * AGEN-77 phase 2: the call limit T and every bound derived from it. The lease, the breaker window
 * and its idle drop, the ceiling's day, the abort of a released run, and which failures read as a
 * timeout. Real database and adapters; the providers here are local servers that answer, or don't.
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
import "./ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase } = await import("../db/client.js");
const H = await import("../test-utils/summary-service-harness.js");
const svc = await import("./session-summary-service.js");
const spend = await import("./ai/spend-service.js");
const limits = await import("./ai/session-summary/service-limits.js");
const { toDbTimestamp } = await import("./util/db-time.js");

const SID = "to-s1";
const DEFAULT_T = config.sessionSummaryTimeoutSeconds;
const BASE = Date.UTC(2031, 0, 1, 12, 0, 0);
const MINUTE = 60_000;
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
	config.sessionSummaryTimeoutSeconds = DEFAULT_T;
	setSystemTime();
	svc._setSummaryHooksForTest(null);
	svc._breakerForTest.reset();
	svc._unknownOutcomeForTest.reset();
	await H.afterEachGuard(stub);
});

describe("the limit and what derives from it", () => {
	test("the default is 360 s: lease 780 s, request timeout 360 s, breaker window 27 min", () => {
		expect(DEFAULT_T).toBe(360);
		expect(limits.summaryLeaseSeconds()).toBe(780);
		expect(limits.summaryCallTimeoutSeconds()).toBe(360);
		expect(limits.breakerWindowMs()).toBe(27 * MINUTE);
		expect(limits.breakerIdleDropMs()).toBe(60 * MINUTE);
	});

	for (const [t, lease, windowMs, idleMs] of [
		[30, 120, 10 * MINUTE, 60 * MINUTE],
		[600, 1260, 43 * MINUTE, 60 * MINUTE],
		[1800, 3660, 123 * MINUTE, 123 * MINUTE],
	] as const) {
		test(`T = ${t}: lease ${lease} s, window ${windowMs / MINUTE} min, idle drop ${idleMs / MINUTE} min`, () => {
			config.sessionSummaryTimeoutSeconds = t;
			expect(limits.summaryLeaseSeconds()).toBe(lease);
			expect(limits.breakerWindowMs()).toBe(windowMs);
			expect(limits.breakerIdleDropMs()).toBe(idleMs);
		});
	}
});

describe("the lease boundary: one less, exactly, one more", () => {
	for (const t of [360, 120, 30, 1800]) {
		test(`T = ${t}: the claim and the view agree (live, live, lapsed)`, async () => {
			config.sessionSummaryTimeoutSeconds = t;
			const lease = limits.summaryLeaseSeconds();
			expect(lease).toBe(2 * t + 60);
			const started = toDbTimestamp(new Date(BASE));
			for (const [age, lapsed] of [
				[lease - 1, false],
				[lease, false],
				[lease + 1, true],
			] as const) {
				const id = `${SID}-${t}-${age}`;
				await H.seedActiveSession(id);
				await H.seedSummaryRow(id, {
					attemptStatus: "generating",
					attemptStartedAt: started,
					attemptToken: "old",
				});
				setSystemTime(new Date(BASE + age * 1000));
				const view = await svc.getSessionSummaryView(id);
				expect(view?.attempt.status, `view at ${age} s`).toBe(lapsed ? "failed" : "generating");
				if (lapsed) expect(view?.attempt.errorCode).toBe("interrupted");
				const won = await svc.claimSummaryAttempt(id, `t${age}`, new Date(BASE + age * 1000));
				expect(won, `claim at ${age} s`).toBe(lapsed);
				setSystemTime();
			}
		});
	}

	test("the watchdog delay is the lease", () => {
		expect(svc.watchdogDelayMs()).toBe(780_000);
		config.sessionSummaryTimeoutSeconds = 30;
		expect(svc.watchdogDelayMs()).toBe(120_000);
	});
});

describe("the breaker window scales with T (virtual time, no sleeps)", () => {
	const B = svc._breakerForTest;
	for (const t of [30, 360, 600, 1800]) {
		test(`T = ${t}: three failures spaced lease + 5 s apart open it`, () => {
			config.sessionSummaryTimeoutSeconds = t;
			const spacing = (limits.summaryLeaseSeconds() + 5) * 1000;
			B.record("s", 0);
			B.record("s", spacing);
			expect(B.retryAfter("s", spacing)).toBe(0);
			B.record("s", 2 * spacing);
			expect(B.retryAfter("s", 2 * spacing)).toBeGreaterThan(0);
		});
	}

	for (const t of [30, 360, 1800]) {
		test(`T = ${t}: a third failure at window - 1 ms trips it, at window + 1 ms it doesn't`, () => {
			config.sessionSummaryTimeoutSeconds = t;
			const w = limits.breakerWindowMs();
			B.record("a", 0);
			B.record("a", 1000);
			B.record("a", w - 1);
			expect(B.retryAfter("a", w - 1)).toBeGreaterThan(0);
			B.reset();
			B.record("b", 0);
			B.record("b", 1000);
			B.record("b", w + 1);
			expect(B.retryAfter("b", w + 1)).toBe(0);
		});
	}

	for (const t of [360, 1800]) {
		test(`T = ${t}: an idle subject is kept at the idle drop - 1 ms and forgotten at + 1 ms`, () => {
			config.sessionSummaryTimeoutSeconds = t;
			const idle = limits.breakerIdleDropMs();
			B.record("idle", 0);
			B.record("other", idle - 1);
			expect(B.has("idle")).toBe(true);
			B.reset();
			B.record("idle", 0);
			B.record("other", idle + 1);
			expect(B.has("idle")).toBe(false);
		});
	}
});

describe("the unknown-outcome ceiling is keyed by the reservation's day", () => {
	// Local-time constructors, so the test needs no TZ pin: `today()` and the keys both use the local day.
	const U = svc._unknownOutcomeForTest;
	const at = (day: number, h: number, m: number, s: number) => new Date(2031, 0, day, h, m, s);

	test("reserved at 23:59:50, charged at 00:00:10: the start day's counter moves, today's stays 0", () => {
		setSystemTime(at(1, 23, 59, 50));
		const reservedOn = spend.today();
		setSystemTime(at(2, 0, 0, 10));
		U.record(100, reservedOn);
		expect(U.cents(reservedOn)).toBe(100);
		expect(U.today()).toBe(0);
	});

	test("reserved at 00:00:05, charged at 00:00:10: today's counter moves", () => {
		setSystemTime(at(2, 0, 0, 5));
		const reservedOn = spend.today();
		setSystemTime(at(2, 0, 0, 10));
		U.record(100, reservedOn);
		expect(U.today()).toBe(100);
	});

	test("a late charge for yesterday does not reset today's counter, and the gate still refuses at the ceiling", () => {
		setSystemTime(at(1, 23, 59, 50));
		const yesterday = spend.today();
		setSystemTime(at(2, 0, 0, 10));
		U.record(50, spend.today());
		U.record(70, yesterday);
		expect(U.today()).toBe(50);
		svc._setSummaryHooksForTest({ unknownCeilingCents: 50 });
		expect(U.today() >= svc.unknownOutcomeCeilingCents()).toBe(true);
	});

	test("charges older than yesterday are pruned", () => {
		setSystemTime(at(1, 12, 0, 0));
		const old = spend.today();
		U.record(10, old);
		setSystemTime(at(4, 12, 0, 0));
		U.record(10, spend.today());
		expect(U.cents(old)).toBe(0);
	});
});

/** A provider that holds every request open and records when each client hangs up. */
function hangingProvider() {
	const state = { arrived: 0, aborted: 0 };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 60,
		fetch(req) {
			state.arrived++;
			return new Promise<Response>((resolve) => {
				req.signal.addEventListener("abort", () => {
					state.aborted++;
					resolve(new Response("gone"));
				});
			});
		},
	});
	return { state, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

describe("a released run closes its socket and settles once", () => {
	for (const via of ["the watchdog", "the shutdown release"] as const) {
		test(`${via}: the provider sees the hang-up within 1 s; one settlement; no failure row from the woken run`, async () => {
			const p = hangingProvider();
			const settle = spyOn(spend, "settleReservedSpend");
			try {
				await H.resetWorld(stub);
				await H.enableAi();
				await H.seedProviderAt(p.url);
				await H.seedActiveSession(SID);
				if (via === "the watchdog") svc._setSummaryHooksForTest({ watchdogMs: 400 });
				const { done } = await H.startGeneration(SID);
				await H.until(() => p.state.arrived === 1, 10_000);
				if (via === "the shutdown release") await svc.releaseOwnSummaryClaims();
				const t0 = Date.now();
				await H.until(() => p.state.aborted === 1, 10_000);
				if (via === "the shutdown release") expect(Date.now() - t0).toBeLessThan(3000);
				await H.withDeadline(done);
				await H.until(() => svc._summaryGenerationCountForTest() === 0);
				const row = await H.readSummaryRow(SID);
				expect(row?.attemptStatus).toBe("failed");
				expect(row?.attemptErrorCode).toBe("interrupted~long");
				expect(settle).toHaveBeenCalledTimes(1);
			} finally {
				settle.mockRestore();
				p.stop();
			}
		});
	}
});

describe("which failures read as a timeout", () => {
	async function runAgainst(status: number | "hang", callTimeoutMs?: number) {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) =>
				status === "hang"
					? new Promise<Response>((r) =>
							req.signal.addEventListener("abort", () => r(new Response("x"))),
						)
					: new Response("upstream trouble", { status }),
		});
		try {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProviderAt(`http://127.0.0.1:${server.port}/v1`);
			await H.seedActiveSession(SID);
			if (callTimeoutMs) svc._setSummaryHooksForTest({ callTimeoutMs });
			const logs = H.captureLogs();
			try {
				await H.runGeneration(SID);
			} finally {
				logs.restore();
			}
			return { row: await H.readSummaryRow(SID), lines: logs.lines };
		} finally {
			server.stop(true);
		}
	}

	for (const status of [500, 502, 504, 524]) {
		test(`an immediate HTTP ${status} is a provider error`, async () => {
			const { row } = await runAgainst(status);
			expect(row?.attemptErrorCode?.startsWith("provider_error")).toBe(true);
		});
	}

	test("a deadline we fired is provider_timeout, and the log names the model, the limit sent and the call", async () => {
		const { row, lines } = await runAgainst("hang", 300);
		expect(row?.attemptErrorCode).toBe("provider_timeout~long");
		const line = lines.find((l) => l.includes("attempt failed") && l.includes("provider_timeout"));
		expect(line).toBeDefined();
		const facts = JSON.parse(line?.slice(line.indexOf("{")) as string);
		expect(facts).toMatchObject({ model: "gpt-5-mini", limitSeconds: 0.3, call: "first" });
		expect(typeof facts.ranSeconds).toBe("number");
	});
});

describe("a free provider", () => {
	test("a free (zero-cost) provider's timeout records nothing: neither the breaker nor the ceiling", async () => {
		const p = hangingProvider();
		try {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProviderAt(p.url, { kind: "openai_compatible", model: "local-model" });
			await H.seedActiveSession(SID);
			svc._setSummaryHooksForTest({ callTimeoutMs: 300 });
			await H.runGeneration(SID);
			expect(p.state.arrived).toBe(1);
			const row = await H.readSummaryRow(SID);
			expect(row?.attemptErrorCode).toBe("provider_timeout");
			expect(svc._breakerForTest.size()).toBe(0);
			expect(svc._unknownOutcomeForTest.today()).toBe(0);
			expect(svc._unknownOutcomeForTest.cents(spend.today())).toBe(0);
		} finally {
			p.stop();
		}
	});
});

describe("slots busy", () => {
	test("a refusal for want of a slot is logged with the count", async () => {
		const p = hangingProvider();
		try {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProviderAt(p.url);
			for (const id of ["to-a", "to-b", "to-c"]) await H.seedActiveSession(id);
			const a = await H.startGeneration("to-a");
			const b = await H.startGeneration("to-b");
			await H.until(() => p.state.arrived === 2, 10_000);
			const logs = H.captureLogs();
			let refused: string | null;
			try {
				refused = H.refusalOf(await H.request("to-c"));
			} finally {
				logs.restore();
			}
			expect(refused).toBe("busy");
			expect(logs.lines.some((l) => l.includes("slots busy") && l.includes('"running":2'))).toBe(
				true,
			);
			await svc.releaseOwnSummaryClaims();
			await H.withDeadline(Promise.all([a.done, b.done]));
		} finally {
			p.stop();
		}
	});
});
