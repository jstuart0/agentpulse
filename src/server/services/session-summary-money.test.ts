/**
 * AGEN-69 phase 5 review fixes, section A: the money (P5-1, P5-2, P5-4, P5-7).
 *
 * R-I: budget arithmetic errs toward charging. The text actually sent is priced with a worst-case
 * token ratio before each call and the reservation is topped up to it; a call whose outcome is
 * unknown is charged the single-call maximum. Real database, the real registry and adapters, real
 * HTTP to the stub provider on a priced kind and model (`openai` / `gpt-5`: input 125c and output
 * 1,000c per million, so the zero, input-only and maximum charges differ by whole cents).
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
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiDailySpend, llmProviders } = await import("../db/schema/index.js");
const H = await import("../test-utils/summary-service-harness.js");
const svc = await import("./session-summary-service.js");
const spend = await import("./ai/spend-service.js");
const secrets = await import("./ai/secrets.js");
const registry = await import("./ai/llm/registry.js");
const { LlmError } = await import("./ai/llm/types.js");
const { priceCompletion } = await import("./ai/llm/pricing.js");
const { setShuttingDown, _resetDrainStateForTest } = await import("../drain-state.js");
const { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS } = await import(
	"./ai/session-summary/service-limits.js"
);
const { toDbTimestamp } = await import("./util/db-time.js");

const SID = "money-s1";
const MODEL = "gpt-5";
const CAP = spend.DEFAULT_DAILY_CAP_CENTS;
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
	await H.seedProvider(stub, { model: MODEL });
});
afterEach(async () => {
	await H.afterEachGuard(stub);
});

// The arithmetic of R-I, written out here on purpose (not imported from the service).
const rate = (inputTokens: number, outputTokens = 0) =>
	priceCompletion("openai", MODEL, { inputTokens, outputTokens, estimated: true });
const worstTokens = (text: string) =>
	Math.max(Math.ceil(text.length / 4.5), Math.ceil(Buffer.byteLength(text, "utf8") / 2));
const pricedInput = (text: string) => rate(worstTokens(text));
const maxCall = (text: string) => rate(worstTokens(text), MAX_OUTPUT_TOKENS);
const reservationOfOneCall = () => rate(MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
const actual = (usage = H.STUB_USAGE) => rate(usage.input, usage.output);
const textOf = (req: Parameters<typeof H.promptsOf>[0]) => {
	const { system, user } = H.promptsOf(req);
	return system + user;
};
const ok = (cite: number[]) => ({ text: H.answer(cite), stop: "stop", usage: H.STUB_USAGE });
const unusable = () => ({ text: "I cannot produce JSON.", stop: "stop", usage: H.STUB_USAGE });
const script = (...answers: Array<Record<string, unknown>>) =>
	stub.script("openai", ...(answers as never[]));

const WORDS =
	"upload retry backoff queue socket header parse stream buffer config deploy cache index shard token merge patch build lint test fix".split(
		" ",
	);
/** Plain ASCII prose, about 60,000 characters of ledger: big enough that chars/4.5 and the worst case price differently. */
async function seedBigSession(): Promise<number> {
	await H.seedSession(SID);
	const rows: Parameters<typeof H.seedEvents>[1] = [];
	for (let i = 0; i < 80; i++) {
		rows.push(
			H.prompt(
				Array.from(
					{ length: 140 },
					(_, j) => `${WORDS[(i * 13 + j * 7) % WORDS.length]}${(i + j) % 97}`,
				).join(" "),
			),
		);
	}
	rows.push(H.edit("src/uploader.ts"));
	const ids = await H.seedEvents(SID, rows);
	return ids[ids.length - 1];
}

async function runFailing(...answers: Array<Record<string, unknown>>) {
	await seedBigSession();
	script(...answers);
	const before = await H.snapshotSpend(SID);
	await H.runGeneration(SID);
	const delta = await H.spendDelta(before);
	return { delta, row: await H.readSummaryRow(SID) };
}

describe("P5-2 the charging table (R-I b): one row, one test, the exact day delta", () => {
	for (const status of [400, 401, 403, 404, 408, 422, 429]) {
		test(`HTTP ${status} is an explicit pre-billing rejection: charged 0`, async () => {
			const { delta, row } = await runFailing({ text: "", status, errorBody: "no" });
			expect(stub.requests().length).toBe(1);
			expect(row?.attemptStatus).toBe("failed");
			expect(delta.day).toBe(0);
			expect(delta.sessions[SID]).toBe(0);
		});
	}

	for (const status of [500, 502, 503, 504]) {
		test(`HTTP ${status} is an explicit 5xx: charged the priced input of the text sent`, async () => {
			const { delta } = await runFailing({ text: "", status, errorBody: "boom" });
			const expected = pricedInput(textOf(stub.requests()[0]));
			const text = textOf(stub.requests()[0]);
			expect(expected).toBeLessThan(maxCall(text));
			// This prompt is big enough that the worst-case ratio and chars/4.5 give different cents.
			expect(expected).toBeGreaterThan(rate(Math.ceil(text.length / 4.5)));
			expect(delta.day).toBe(expected);
			expect(delta.sessions[SID]).toBe(expected);
		});
	}

	for (const status of [402, 409, 418]) {
		test(`HTTP ${status} is not a pre-billing rejection: unknown, charged the single-call maximum`, async () => {
			const { delta } = await runFailing({ text: "", status, errorBody: "odd" });
			expect(delta.day).toBe(maxCall(textOf(stub.requests()[0])));
		});
	}

	test("a client-side timeout is unknown: charged the single-call maximum", async () => {
		await seedBigSession();
		let sent = "";
		const spy = spyOn(registry, "getAdapter").mockImplementation(
			() =>
				({
					kind: "openai",
					complete: async (request: { systemPrompt: string; transcriptPrompt: string }) => {
						sent = request.systemPrompt + request.transcriptPrompt;
						throw new LlmError("transient_timeout", "timed out");
					},
				}) as never,
		);
		try {
			const before = await H.snapshotSpend(SID);
			await H.runGeneration(SID);
			expect(sent.length).toBeGreaterThan(0);
			expect((await H.readSummaryRow(SID))?.attemptErrorCode).toBe("provider_timeout");
			expect((await H.spendDelta(before)).day).toBe(maxCall(sent));
		} finally {
			spy.mockRestore();
		}
	});

	test("a network failure after the request left (the peer closes the socket) is unknown: charged the single-call maximum", async () => {
		const bodies: string[] = [];
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					pending += Buffer.from(data).toString("utf8");
					const split = pending.indexOf("\r\n\r\n");
					if (split === -1) return;
					const length = Number(/content-length: (\d+)/i.exec(pending)?.[1] ?? 0);
					const body = pending.slice(split + 4);
					if (Buffer.byteLength(body) < length) return;
					bodies.push(body);
					socket.end();
				},
			},
		});
		try {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProviderAt(`http://127.0.0.1:${server.port}/v1`, { model: MODEL });
			await seedBigSession();
			const before = await H.snapshotSpend(SID);
			await H.runGeneration(SID);
			expect(bodies.length).toBe(1);
			const sent = JSON.parse(bodies[0]) as { messages: Array<{ content: string }> };
			const text = sent.messages[0].content + sent.messages[1].content;
			expect((await H.readSummaryRow(SID))?.attemptErrorCode).toBe("provider_error");
			expect((await H.spendDelta(before)).day).toBe(maxCall(text));
		} finally {
			server.stop(true);
		}
	});

	test("a non-LlmError after the provider answered (an unreadable 200 body) is unknown: charged the single-call maximum", async () => {
		const seen: string[] = [];
		const bad = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) => {
				seen.push(await req.text());
				return new Response("<html>not json", { status: 200 });
			},
		});
		try {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProviderAt(`http://127.0.0.1:${bad.port}/v1`, { model: MODEL });
			await seedBigSession();
			const before = await H.snapshotSpend(SID);
			await H.runGeneration(SID);
			const sent = JSON.parse(seen[0]) as { messages: Array<{ content: string }> };
			const text = sent.messages[0].content + sent.messages[1].content;
			expect((await H.readSummaryRow(SID))?.attemptErrorCode).toBe("internal_error");
			expect((await H.spendDelta(before)).day).toBe(maxCall(text));
		} finally {
			bad.stop(true);
		}
	});

	test("a first call that billed and a repair call that fails with a 5xx charges call 1's actual plus the repair's priced input", async () => {
		await seedBigSession();
		script(unusable(), { text: "", status: 503, errorBody: "down" });
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		expect(stub.requests().length).toBe(2);
		const second = pricedInput(textOf(stub.requests()[1]));
		expect((await H.spendDelta(before)).day).toBe(actual() + second);
	});

	test("a first call that billed and a repair call with an unknown outcome charges call 1's actual plus the maximum", async () => {
		await seedBigSession();
		script(unusable(), { text: "", status: 418, errorBody: "odd" });
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		const second = maxCall(textOf(stub.requests()[1]));
		expect((await H.spendDelta(before)).day).toBe(actual() + second);
	});
});

/** A session whose prompts are dense: a lot of bytes per character, so chars/4.5 under-counts tokens. */
const DENSE: Record<string, (i: number, j: number) => string> = {
	cjk: (i, j) => String.fromCodePoint(0x4e00 + ((i * 131 + j * 17) % 6000)),
	emoji: (i, j) => String.fromCodePoint(0x1f300 + ((i * 7 + j * 3) % 200)),
	hex: (i, j) => ((i * 2654435761 + j * 40503) % 16).toString(16),
	base64: (i, j) =>
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[(i * 31 + j * 7) % 64],
};
const denseText = (kind: string, i: number, chars = 1500) =>
	Array.from({ length: chars }, (_, j) => DENSE[kind](i, j)).join("");

async function seedDenseSession(kind: string): Promise<number> {
	await H.seedSession(SID);
	const rows: Parameters<typeof H.seedEvents>[1] = [];
	for (let i = 0; i < 120; i++) rows.push(H.prompt(denseText(kind, i)));
	rows.push(H.edit("src/uploader.ts"));
	const ids = await H.seedEvents(SID, rows);
	return ids[ids.length - 1];
}

describe("P5-1 worst-case pricing of the text actually sent (R-I a)", () => {
	for (const kind of ["cjk", "emoji", "hex", "base64"]) {
		test(`${kind}: at the character bound the reservation is topped up to the worst case before call 1, and the day never passes the cap`, async () => {
			const editId = await seedDenseSession(kind);
			const gate = stub.createGate();
			script({ ...ok([editId]), gate });
			const { done } = await H.startGeneration(SID);
			await H.withDeadline(gate.arrived);
			const text = textOf(stub.requests()[0]);
			expect(text.length).toBeGreaterThan(40_000);
			expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
			const expected = Math.max(reservationOfOneCall(), maxCall(text));
			// The ruled arithmetic catches what chars/4.5 misses: this prompt costs more than the reservation.
			expect(maxCall(text)).toBeGreaterThan(reservationOfOneCall());
			const heldDay = await H.daySpend();
			expect(heldDay).toBe(expected);
			expect(heldDay).toBeLessThan(CAP);
			gate.release();
			await H.withDeadline(done);
			expect(await H.daySpend()).toBe(actual());
		});
	}

	test("a refused top-up before call 1 returns the reservation and ends spend_cap: no call is made, the day returns to where it was", async () => {
		const editId = await seedDenseSession("cjk");
		const start = CAP - reservationOfOneCall() - 1;
		await H.setDaySpend(start);
		script(ok([editId]));
		await H.runGeneration(SID);
		expect(stub.requests().length).toBe(0);
		const row = await H.readSummaryRow(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("spend_cap");
		expect(await H.daySpend()).toBe(start);
		expect(await H.sessionSpend(SID)).toBe(0);
		stub.reset();
	});

	test("the repair call is priced from its own text too: the day at its gate is the larger of the held reservation and settled + the worst case", async () => {
		const editId = await seedDenseSession("emoji");
		const gate = stub.createGate();
		script(unusable(), { ...ok([editId]), gate });
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		const [first, second] = stub.requests().map(textOf);
		const held = Math.max(reservationOfOneCall(), maxCall(first));
		expect(await H.daySpend()).toBe(Math.max(held, actual() + maxCall(second)));
		gate.release();
		await H.withDeadline(done);
		expect(await H.daySpend()).toBe(actual() * 2);
	});

	test("a refused top-up before the repair call settles call 1 at its actual, ends spend_cap and sends no second request", async () => {
		const editId = await seedDenseSession("emoji");
		const gate = stub.createGate();
		script({ ...unusable(), gate }, ok([editId]));
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		const first = textOf(stub.requests()[0]);
		const held = Math.max(reservationOfOneCall(), maxCall(first));
		// One cent under the cap: no top-up can fit.
		await H.setDaySpend(CAP - 1);
		gate.release();
		await H.withDeadline(done);
		expect(stub.requests().length).toBe(1);
		expect((await H.readSummaryRow(SID))?.attemptErrorCode).toBe("spend_cap");
		expect(held).toBeGreaterThan(0);
		expect(await H.sessionSpend(SID)).toBe(actual());
		stub.reset();
	});

	test("a free provider has no worst case to price: nothing is reserved, topped up or charged", async () => {
		await H.resetWorld(stub);
		await H.enableAi();
		await H.seedProvider(stub, { kind: "openai_compatible", model: "local-model" });
		const editId = await seedDenseSession("cjk");
		script(ok([editId]));
		await H.runGeneration(SID);
		expect(await H.daySpend()).toBe(0);
		expect((await H.readSummaryRow(SID))?.attemptStatus).toBe("idle");
	});
});

describe("P5-4 a settlement that fails on a database error is retried once and logged", () => {
	function failDayUpdates(times: number) {
		const db = getDb() as unknown as { update: (table: unknown) => unknown };
		const original = db.update.bind(db);
		let left = times;
		const spy = spyOn(db, "update").mockImplementation((table: unknown) => {
			if (table === aiDailySpend && left > 0) {
				left--;
				throw new Error("disk I/O error (simulated)");
			}
			return original(table);
		});
		return { restore: () => spy.mockRestore() };
	}

	test("one failure: the retry settles, so the reservation does not stay on the day; the failure is logged by class name", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		const logs = H.captureLogs();
		let failing: ReturnType<typeof failDayUpdates> | null = null;
		svc._setSummaryHooksForTest({
			at: (step) => {
				if (step === "finish_write") failing = failDayUpdates(1);
			},
		});
		try {
			await H.runGeneration(SID);
		} finally {
			(failing as ReturnType<typeof failDayUpdates> | null)?.restore();
			logs.restore();
		}
		expect(await H.daySpend()).toBe(actual());
		expect(await H.sessionSpend(SID)).toBe(actual());
		const line = logs.lines.find((l) => l.includes("settlement failed"));
		expect(line).toBeDefined();
		expect(line).toContain('"code":"Error"');
		expect(line).not.toContain("disk I/O");
		expect(svc._summaryGenerationCountForTest()).toBe(0);
	});

	test("two failures: the slot is still freed and the second failure is logged as an error", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		const logs = H.captureLogs();
		let failing: ReturnType<typeof failDayUpdates> | null = null;
		svc._setSummaryHooksForTest({
			at: (step) => {
				if (step === "finish_write") failing = failDayUpdates(2);
			},
		});
		try {
			await H.runGeneration(SID);
		} finally {
			(failing as ReturnType<typeof failDayUpdates> | null)?.restore();
			logs.restore();
		}
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		expect(logs.lines.filter((l) => l.includes("settlement failed")).length).toBe(2);
		expect((await H.readSummaryRow(SID))?.attemptStatus).toBe("idle");
	});

	test("a failed release of a reservation at an exit is retried once as well", async () => {
		await H.seedActiveSession("money-few");
		const db = getDb() as unknown as { update: (table: unknown) => unknown };
		const original = db.update.bind(db);
		let armed = false;
		let failed = 0;
		const spy = spyOn(db, "update").mockImplementation((table: unknown) => {
			if (armed && table === aiDailySpend && failed < 1) {
				failed++;
				throw new Error("disk I/O error (simulated)");
			}
			return original(table);
		});
		// An exception after the reservation: the request's own exit path returns the reservation.
		svc._setSummaryHooksForTest({
			at: (step) => {
				if (step === "reserve") {
					armed = true;
					throw new Error("seam failure after the reservation");
				}
			},
		});
		try {
			await expect(H.request("money-few")).rejects.toThrow();
		} finally {
			spy.mockRestore();
		}
		expect(failed).toBe(1);
		expect(await H.daySpend()).toBe(0);
	});
});

describe("P5-7 the key is decrypted after the claim is won", () => {
	function watchDecrypt() {
		return spyOn(secrets, "decryptSecret");
	}

	test("a join, a cooldown, a busy, a cap refusal, a lost claim, too little activity, no provider, shutting down and an unknown session decrypt nothing", async () => {
		const decrypt = watchDecrypt();
		try {
			await H.seedActiveSession("dec-join");
			await H.seedSummaryRow("dec-join", {
				attemptStatus: "generating",
				attemptToken: "t",
				attemptStartedAt: toDbTimestamp(new Date()),
			});
			expect(H.refusalOf(await H.request("dec-join"))).toBeNull();
			expect((await H.request("dec-join")).kind).toBe("joined");

			await H.seedActiveSession("dec-cool");
			await H.seedSummaryRow("dec-cool", {
				attemptStatus: "failed",
				attemptErrorCode: "provider_error",
				attemptStartedAt: toDbTimestamp(new Date()),
			});
			expect(H.refusalOf(await H.request("dec-cool"))).toBe("summary_cooldown");

			await H.seedActiveSession("dec-cap");
			await H.setDaySpend(CAP - 1);
			expect(H.refusalOf(await H.request("dec-cap"))).toBe("spend_cap_reached");
			await H.setDaySpend(0);

			await H.seedActiveSession("dec-lost");
			svc._setSummaryHooksForTest({
				at: async (step) => {
					if (step === "reserve") {
						await H.seedSummaryRow("dec-lost", {
							attemptStatus: "generating",
							attemptToken: "other",
							attemptStartedAt: toDbTimestamp(new Date()),
						});
					}
				},
			});
			expect((await H.request("dec-lost")).kind).toBe("joined");
			svc._setSummaryHooksForTest(null);
			expect(await H.daySpend()).toBe(0);

			await H.seedSession("dec-few");
			expect(H.refusalOf(await H.request("dec-few"))).toBe("too_little_activity");
			expect(H.refusalOf(await H.request("dec-missing"))).toBe("session_not_found");

			setShuttingDown(true);
			expect(H.refusalOf(await H.request("dec-cap"))).toBe("shutting_down");
			_resetDrainStateForTest();

			await getDb().delete(llmProviders);
			expect(H.refusalOf(await H.request("dec-cap"))).toBe("no_provider");

			expect(decrypt.mock.calls.length).toBe(0);
		} finally {
			decrypt.mockRestore();
			_resetDrainStateForTest();
		}
	});

	test("a busy refusal at the two-slot cap decrypts nothing", async () => {
		const held: Array<{ gate: ReturnType<typeof stub.createGate>; done: Promise<void> }> = [];
		for (const id of ["dec-a", "dec-b"]) {
			const { editId } = await H.seedActiveSession(id);
			const gate = stub.createGate();
			script({ ...ok([editId]), gate });
			const { done } = await H.startGeneration(id);
			await H.withDeadline(gate.arrived);
			held.push({ gate, done });
		}
		await H.seedActiveSession("dec-c");
		const decrypt = watchDecrypt();
		try {
			expect(H.refusalOf(await H.request("dec-c"))).toBe("busy");
			expect(decrypt.mock.calls.length).toBe(0);
		} finally {
			decrypt.mockRestore();
			for (const h of held) {
				h.gate.release();
				await H.withDeadline(h.done);
			}
		}
	});

	test("eight simultaneous requests for an idle session decrypt once: only the winner of the claim pays", async () => {
		const { editId } = await H.seedActiveSession(SID);
		const gate = stub.createGate();
		script({ ...ok([editId]), gate });
		const decrypt = watchDecrypt();
		try {
			const results = await Promise.all(Array.from({ length: 8 }, () => H.request(SID)));
			const started = results.filter((r) => r.kind === "started");
			expect(started).toHaveLength(1);
			expect(results.filter((r) => r.kind === "joined")).toHaveLength(7);
			expect(decrypt.mock.calls.length).toBe(1);
			await H.withDeadline(gate.arrived);
			gate.release();
			if (started[0].kind === "started") await H.withDeadline(started[0].done);
		} finally {
			decrypt.mockRestore();
		}
	});

	test("an unreadable key after the claim is a failed attempt: provider_key_unreadable, nothing sent or spent, and no cooldown", async () => {
		await H.seedActiveSession(SID);
		await getDb()
			.update(llmProviders)
			.set({ credentialCiphertext: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0" });
		const before = await H.snapshotSpend(SID);
		const result = await H.request(SID);
		expect(result.kind).toBe("started");
		if (result.kind === "started") await H.withDeadline(result.done);
		const row = await H.readSummaryRow(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("provider_key_unreadable");
		expect(row?.attemptToken).toBeNull();
		expect(row?.attemptStartedAt).toBeNull();
		expect(stub.requests().length).toBe(0);
		expect((await H.spendDelta(before)).day).toBe(0);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		// The person who fixes the key is not locked out for the cooldown: the view allows it at once.
		const view = await svc.getSessionSummaryView(SID);
		expect(view?.attempt).toMatchObject({ status: "failed", errorCode: "provider_key_unreadable" });
		expect(view?.blocked).toBeNull();
		expect(view?.cooldownSeconds).toBeNull();
		const again = await H.request(SID);
		expect(again.kind).toBe("started");
		if (again.kind === "started") await H.withDeadline(again.done);
	});
});

describe("P5-5 a released run never sends a billed repair call nobody settles", () => {
	test("released while call 1 is in flight with an unusable answer scripted: exactly one request, failed / interrupted, the day at the unknown-outcome charge", async () => {
		await H.seedActiveSession(SID);
		const gate = stub.createGate();
		script({ ...unusable(), gate }, ok([1]));
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		await svc.releaseOwnSummaryClaims();
		const charged = maxCall(textOf(stub.requests()[0]));
		expect(await H.daySpend()).toBe(charged);
		gate.release();
		await H.withDeadline(done);
		expect(stub.requests().length).toBe(1);
		const row = await H.readSummaryRow(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("interrupted");
		expect(await H.daySpend()).toBe(charged);
		expect(await H.sessionSpend(SID)).toBe(charged);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
		stub.reset();
	});

	test("released during the top-up before the repair call: still one request, the day at call 1's actual (the late top-up is rolled back)", async () => {
		await H.seedActiveSession(SID);
		const gate = stub.createGate();
		script({ ...unusable(), gate }, ok([1]));
		const realTopUp = spend.topUpReservation;
		let reachedTopUp!: () => void;
		const atTopUp = new Promise<void>((resolve) => {
			reachedTopUp = resolve;
		});
		let proceed!: () => void;
		const hold = new Promise<void>((resolve) => {
			proceed = resolve;
		});
		const spy = spyOn(spend, "topUpReservation").mockImplementation(async (reservation, extra) => {
			reachedTopUp();
			await hold;
			return realTopUp(reservation, extra);
		});
		try {
			const { done } = await H.startGeneration(SID);
			await H.withDeadline(gate.arrived);
			gate.release();
			await H.withDeadline(atTopUp);
			await svc.releaseOwnSummaryClaims();
			expect(await H.daySpend()).toBe(actual());
			proceed();
			await H.withDeadline(done);
			expect(stub.requests().length).toBe(1);
			const row = await H.readSummaryRow(SID);
			expect(row?.attemptErrorCode).toBe("interrupted");
			expect(await H.daySpend()).toBe(actual());
			expect(await H.sessionSpend(SID)).toBe(actual());
		} finally {
			proceed();
			spy.mockRestore();
			stub.reset();
		}
	});
});
