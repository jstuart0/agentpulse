/**
 * AGEN-69 phase 5: one generation, end to end (TC-5.7 to 5.17, 5.32, 5.33, 5.39 to 5.44, 5.46).
 *
 * Real database, the real registry and adapters, real HTTP to the stub provider on a
 * priced provider kind (`openai`; `openai_compatible` is free and would price every
 * call at 0). Every test asserts on the recorded outbound request, and that the stub
 * saw at least one request, so a mocked registry cannot pass vacuously.
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
import * as nodeCrypto from "node:crypto";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import type { SessionSummary, SummaryProvenance } from "../../shared/session-summary.js";
import type { StubGate } from "../test-utils/llm-stub-server.js";
import type { SeedEvent } from "../test-utils/summary-service-harness.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiSessionSummaries, sessions } = await import("../db/schema/index.js");
const H = await import("../test-utils/summary-service-harness.js");
const svc = await import("./session-summary-service.js");
const secrets = await import("./ai/secrets.js");
const ownTurn = await import("../util/own-turn.js");
const registry = await import("./ai/llm/registry.js");
const { LlmError } = await import("./ai/llm/types.js");
const { priceCompletion } = await import("./ai/llm/pricing.js");
const { estimateTokens } = await import("./ai/llm/types.js");
const { PROMPT_VERSION, SESSION_SUMMARY_SYSTEM_PROMPT } = await import(
	"./ai/session-summary/prompt.js"
);
const { repairTrailer } = await import("./ai/session-summary/output-schema.js");
const { setLabsFlag } = await import("./labs-service.js");
const { getSessionSummaryView } = svc;
const { redact } = await import("./ai/redactor.js");

const SID = "gen-s1";
const TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
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

const ok = (cite: number[], over: Record<string, unknown> = {}) => ({
	text: H.answer(cite, over),
	stop: "stop",
	usage: H.STUB_USAGE,
});
const unusable = (text = "I am sorry, I cannot produce JSON for this.") => ({
	text,
	stop: "stop",
	usage: H.STUB_USAGE,
});
const script = (...answers: Parameters<typeof stub.script>[1][]) =>
	stub.script("openai", ...answers);
const cost = (usage = H.STUB_USAGE, model = "gpt-5-mini") =>
	priceCompletion("openai", model, {
		inputTokens: usage.input,
		outputTokens: usage.output,
		estimated: false,
	});

async function summaryOf(sessionId: string) {
	return H.readSummaryRow(sessionId);
}
async function viewOf(sessionId: string) {
	const v = await getSessionSummaryView(sessionId);
	if (!v) throw new Error("no view");
	return v;
}
async function gated(...answers: Array<Record<string, unknown>>): Promise<StubGate[]> {
	const gates = answers.map(() => stub.createGate());
	script(...answers.map((a, i) => ({ ...a, gate: gates[i] }) as never));
	return gates;
}
const serialized = async (sessionId: string): Promise<string> =>
	JSON.stringify(await summaryOf(sessionId));

describe("a successful run", () => {
	test("TC-5.7 stores the summary, provenance, through_event_id and generated_at; settles the priced cost on the day and the session", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		expect(stub.requests().length).toBe(1);
		const row = await summaryOf(SID);
		expect(row.attemptStatus).toBe("idle");
		expect(row.attemptToken).toBeNull();
		expect(row.attemptErrorCode).toBeNull();
		expect(row.throughEventId).toBe(editId);
		expect(row.generatedAt).toMatch(TIMESTAMP);
		expect(row.attemptStartedAt).toMatch(TIMESTAMP);
		expect(row.summary?.overview).toBe("Added retry to the uploader.");
		const p = row.provenance;
		expect(p?.promptVersion).toBe(PROMPT_VERSION);
		expect(p?.provider).toEqual({ kind: "openai", model: "gpt-5-mini" });
		expect(p?.inputTokens).toBe(10_000);
		expect(p?.outputTokens).toBe(1_000);
		expect(p?.usageEstimated).toBe(false);
		expect(p?.costCents).toBe(cost());
		expect(p?.calls).toBe(1);
		expect(typeof p?.redactionHits).toBe("number");
		expect(p?.eventsTotal).toBe(2);
		expect(p?.eventsRead).toBe(2);
		expect(p?.eventsRepresented).toBeGreaterThanOrEqual(2);
		expect(p?.coverage.status).toBe("full");
		expect(p?.firstEventId).toBe(promptId);
		expect(p?.adjustments).toEqual([]);
		expect(p?.suspect).toBe(false);
		expect(p?.evidence[`E${editId}`]?.kind).toBe("edit");
		expect(p?.throughAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		const delta = await H.spendDelta(before);
		expect(delta.day).toBe(cost());
		expect(delta.sessions[SID]).toBe(cost());
		expect(cost()).toBeGreaterThan(0);
	});

	test("TC-5.8 the recorded wire body carries the provider's model, 4,000 tokens, 0.2, no reasoning, system and user", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(ok([editId]));
		await H.runGeneration(SID);
		const [req] = stub.requests("openai");
		expect(req).toBeDefined();
		const body = JSON.parse(req.body);
		expect(body.model).toBe("gpt-5-mini");
		expect(body.max_tokens).toBe(4000);
		expect(body.temperature).toBe(0.2);
		expect(body.reasoning_effort).toBe("none");
		expect(body.messages[0]).toEqual({ role: "system", content: SESSION_SUMMARY_SYSTEM_PROMPT });
		expect(body.messages[1].role).toBe("user");
		expect(body.messages[1].content).toContain("Add retry to the uploader.");
		expect(req.headers.authorization).toBe(`Bearer ${H.KEY}`);
	});

	test("TC-5.33 stored summary has only schema keys; unverified and adjusted are persisted and listed in provenance", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(
			ok([editId], {
				evil: "not a schema key",
				__proto__: { polluted: true },
				accomplishments: [{ text: "Claimed with nothing cited", evidence: [], extra: 1 }],
				validation: [{ what: "bun test", result: "passed", detail: "all green", evidence: [] }],
			}),
		);
		await H.runGeneration(SID);
		const stored = await summaryOf(SID);
		const summary = stored?.summary as SessionSummary;
		const provenance = stored?.provenance as SummaryProvenance;
		expect(Object.keys(summary).sort()).toEqual(
			[
				"overview",
				"outcome",
				"accomplishments",
				"changes",
				"decisions",
				"validation",
				"problems",
				"unfinished",
				"nextActions",
				"handoff",
			].sort(),
		);
		expect(JSON.stringify(summary)).not.toContain("evil");
		expect(JSON.stringify(summary)).not.toContain("polluted");
		expect(summary.accomplishments[0].unverified).toBe(true);
		expect(Object.keys(summary.accomplishments[0]).sort()).toEqual([
			"evidence",
			"text",
			"unverified",
		]);
		expect(summary.validation[0].result).toBe("unknown");
		expect(summary.validation[0].adjusted).toBe(true);
		expect(provenance.adjustments.length).toBeGreaterThan(0);
	});
});

describe("what leaves the machine", () => {
	const SECRETS = [
		"PASSWORD=hunter2hunter2secret",
		"Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD",
		"DB_PASSWORD=correct-horse-battery-staple",
		"API_KEY=sk-live-abcdefghijklmnopqrstuvwx123456",
		"NOTE_SECRET=top-secret-value-1234567",
	];

	test("TC-5.9 secrets in events, name, directory, notes and a prompt are absent from the bodies of both calls", async () => {
		for (const s of SECRETS) expect(redact(s).text, `precondition: ${s}`).not.toBe(s);
		await H.seedSession(SID, {
			displayName: `deploy ${SECRETS[0]}`,
			cwd: `/work/${SECRETS[2]}`,
			notes: `remember ${SECRETS[4]}`,
		});
		const [promptId, editId] = await H.seedEvents(SID, [
			H.prompt(`please use ${SECRETS[1]} and ${SECRETS[3]}`),
			H.edit("src/a.ts"),
		]);
		script(unusable(`not json at all ${SECRETS[3]}`), ok([editId]));
		await H.runGeneration(SID);
		const requests = stub.requests("openai");
		expect(requests.length).toBe(2);
		for (const req of requests) {
			for (const s of SECRETS) {
				const value = s.split(/[=:]\s*/).pop() as string;
				expect(req.body, `${value} leaked`).not.toContain(value);
			}
			expect(req.body).toContain("[REDACTED");
		}
		const hits = (await summaryOf(SID)).provenance?.redactionHits ?? 0;
		expect(hits).toBeGreaterThanOrEqual(SECRETS.length - 1);
		expect(promptId).toBeGreaterThan(0);
	});

	test("TC-5.10 sentinels never reach a body, the stored row, the view or a log line; provenance holds provider kind and model only", async () => {
		const logs = H.captureLogs();
		try {
			const { editId } = await H.seedActiveSession(SID, {
				ownerUserId: "owner-sentinel-7c1f",
				ingestKeyId: "key-sentinel-93aa",
				reportedHost: "host-sentinel-55",
				metadata: {
					other: "metadata-sentinel-11",
					permissionWait: { ids: [], anon: 0, prevStatus: null },
				},
			});
			script(unusable(), ok([editId]));
			await H.runGeneration(SID);
			const view = JSON.stringify(await viewOf(SID));
			const surfaces = [
				...stub.requests().map((r) => r.body),
				await serialized(SID),
				view,
				logs.lines.join("\n"),
			];
			expect(stub.requests().length).toBe(2);
			for (const text of surfaces) {
				for (const s of ["owner-sentinel", "key-sentinel", "host-sentinel", "metadata-sentinel"]) {
					expect(text).not.toContain(s);
				}
			}
			const row = await summaryOf(SID);
			expect(row.provenance?.provider).toEqual({ kind: "openai", model: "gpt-5-mini" });
			const asText = JSON.stringify(row);
			for (const s of ["Stub provider", stub.origin, "baseUrl", "credential"])
				expect(asText).not.toContain(s);
		} finally {
			logs.restore();
		}
	});
});

describe("repair and failure of the answer", () => {
	test("TC-5.11 an unusable first answer gets exactly one repair call: the same prompt plus the fixed trailer; both calls settled", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script(unusable(), ok([editId]));
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		const [first, second] = stub.requests("openai");
		expect(stub.requests().length).toBe(2);
		const a = JSON.parse(first.body);
		const b = JSON.parse(second.body);
		expect(b.messages[0]).toEqual(a.messages[0]);
		expect(b.messages[1].content).toBe(
			`${a.messages[1].content}\n\n${repairTrailer({ kind: "parse", path: "top level" })}`,
		);
		const row = await summaryOf(SID);
		expect(row.attemptStatus).toBe("idle");
		expect(row.provenance?.calls).toBe(2);
		expect(row.provenance?.costCents).toBe(2 * cost());
		const delta = await H.spendDelta(before);
		expect(delta.day).toBe(2 * cost());
		expect(delta.sessions[SID]).toBe(2 * cost());
	});

	test("TC-5.12 two unusable answers: failed / parse_failed, the previous summary byte-identical, nothing of the answer kept, both calls settled", async () => {
		const logs = H.captureLogs();
		try {
			const { promptId, editId } = await H.seedActiveSession(SID);
			await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
			const previous = await serialized(SID);
			script(
				unusable("SENTINEL-MODEL-ANSWER-one"),
				unusable("SENTINEL-MODEL-ANSWER-two {not json"),
			);
			const before = await H.snapshotSpend(SID);
			await H.runGeneration(SID);
			const row = await summaryOf(SID);
			expect(row.attemptStatus).toBe("failed");
			expect(row.attemptErrorCode).toBe("parse_failed");
			expect(row.attemptToken).toBeNull();
			const after = JSON.parse(await serialized(SID));
			const keep = JSON.parse(previous);
			for (const col of ["summary", "provenance", "generatedAt", "throughEventId"]) {
				expect(after[col], col).toEqual(keep[col]);
			}
			for (const text of [
				JSON.stringify(row),
				JSON.stringify(await viewOf(SID)),
				logs.lines.join("\n"),
			]) {
				expect(text).not.toContain("SENTINEL-MODEL-ANSWER");
			}
			expect((await H.spendDelta(before)).day).toBe(2 * cost());
			expect(stub.requests().length).toBe(2);
		} finally {
			logs.restore();
		}
	});

	test("TC-5.13a length on both calls gives output_truncated; a mid-object cut with no stop reason twice stays parse_failed", async () => {
		await H.seedActiveSession(SID);
		script(
			{ ...unusable('{"overview": "cut'), stop: "length" },
			{ ...unusable('{"overview": "cut'), stop: "length" },
		);
		await H.runGeneration(SID);
		expect((await summaryOf(SID)).attemptErrorCode).toBe("output_truncated");
		await H.seedActiveSession("gen-cut");
		script(
			{ text: '{"overview": "cut', usage: H.STUB_USAGE },
			{ text: '{"overview": "cut', usage: H.STUB_USAGE },
		);
		await H.runGeneration("gen-cut");
		expect((await summaryOf("gen-cut")).attemptErrorCode).toBe("parse_failed");
		expect(stub.requests().length).toBe(4);
	});

	test("TC-5.13b end, other and an absent stop reason are treated identically (parse)", async () => {
		for (const [i, stop] of (["stop", "something_new", undefined] as const).entries()) {
			const id = `gen-stop-${i}`;
			const { editId } = await H.seedActiveSession(id);
			script({ text: H.answer([editId]), stop, usage: H.STUB_USAGE });
			await H.runGeneration(id);
			const row = await summaryOf(id);
			expect(row.attemptStatus, String(stop)).toBe("idle");
			expect(row.provenance?.calls, String(stop)).toBe(1);
		}
		expect(stub.requests().length).toBe(3);
	});
});

describe("truncation on every wire", () => {
	const WIRES = [
		{ kind: "openai", model: "gpt-5-mini", length: "length", end: "stop" },
		{ kind: "anthropic", model: "claude-sonnet-4-6", length: "max_tokens", end: "end_turn" },
		{ kind: "cohere", model: "command-r", length: "MAX_TOKENS", end: "COMPLETE" },
	] as const;
	for (const wire of WIRES) {
		test(`TC-5.39 ${wire.kind}: length then a good answer stores; length twice is output_truncated; a valid answer cut by length is never stored`, async () => {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProvider(stub, { kind: wire.kind, model: wire.model });
			const usage = { input: 1000, output: 100 };
			const a = await H.seedActiveSession("gen-t1");
			stub.script(
				wire.kind,
				{ text: '{"overview"', stop: wire.length, usage },
				{ text: H.answer([a.editId]), stop: wire.end, usage },
			);
			await H.runGeneration("gen-t1");
			expect((await summaryOf("gen-t1")).attemptStatus).toBe("idle");
			expect((await summaryOf("gen-t1")).provenance?.calls).toBe(2);

			const b = await H.seedActiveSession("gen-t2");
			await H.seedReadySummary("gen-t2", { throughEventId: b.editId, firstEventId: b.promptId });
			const previous = await serialized("gen-t2");
			stub.script(
				wire.kind,
				{ text: H.answer([b.editId]), stop: wire.length, usage },
				{ text: H.answer([b.editId]), stop: wire.length, usage },
			);
			await H.runGeneration("gen-t2");
			const row = await summaryOf("gen-t2");
			expect(row.attemptErrorCode).toBe("output_truncated");
			expect(JSON.stringify(row.summary)).toBe(JSON.stringify(JSON.parse(previous).summary));
			expect(stub.requests(wire.kind).length).toBe(4);
		});
	}
});

describe("refusal", () => {
	test("TC-5.40 a provider refusal ends provider_refused after one call and no repair", async () => {
		const { editId } = await H.seedActiveSession(SID);
		script({ text: H.answer([editId]), stop: "content_filter", usage: H.STUB_USAGE });
		await H.runGeneration(SID);
		const row = await summaryOf(SID);
		expect(row.attemptErrorCode).toBe("provider_refused");
		expect(row.summary).toBeNull();
		expect(stub.requests().length).toBe(1);
	});
});

describe("provider failures", () => {
	// R-I (b): what each status charges. The exact arithmetic per row is pinned in session-summary-money.test.ts.
	type Charge = "zero" | "input" | "max";
	const CASES: Array<[number, string, Charge]> = [
		[401, "provider_auth", "zero"],
		[403, "provider_auth", "zero"],
		[429, "provider_rate_limit", "zero"],
		[503, "provider_timeout", "input"],
		[400, "provider_error", "zero"],
		[404, "provider_error", "zero"],
		[422, "provider_error", "zero"],
		[418, "provider_error", "max"],
	];
	for (const [status, code, charge] of CASES) {
		test(`TC-5.14 HTTP ${status} gives ${code}; the row leaves generating and keeps the previous summary`, async () => {
			const { promptId, editId } = await H.seedActiveSession(SID);
			await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
			const previous = JSON.parse(await serialized(SID));
			script({ text: "", status, errorBody: `provider said no (${status})` });
			const before = await H.snapshotSpend(SID);
			await H.runGeneration(SID);
			const row = await summaryOf(SID);
			expect(row.attemptStatus).toBe("failed");
			expect(row.attemptErrorCode).toBe(code);
			expect(row.attemptToken).toBeNull();
			expect(JSON.parse(await serialized(SID)).summary).toEqual(previous.summary);
			expect(stub.requests().length).toBe(1);
			const { system, user } = H.promptsOf(stub.requests()[0]);
			const sent = system + user;
			const worst = Math.max(estimateTokens(sent), Math.ceil(Buffer.byteLength(sent, "utf8") / 2));
			const chargeOf = (outputTokens: number) =>
				priceCompletion("openai", "gpt-5-mini", {
					inputTokens: worst,
					outputTokens,
					estimated: true,
				});
			// TC-5.16: rejected before billing is 0; an explicit 5xx is the priced input; anything else is unknown, the maximum.
			const expected = { zero: 0, input: chargeOf(0), max: chargeOf(4000) }[charge];
			expect((await H.spendDelta(before)).day).toBe(expected);
		});
	}

	test("TC-5.14b a non-LlmError throw is internal_error", async () => {
		const bad = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("<html>not json", { status: 200 }),
		});
		try {
			await H.resetWorld(stub);
			await H.enableAi();
			await H.seedProviderAt(`http://127.0.0.1:${bad.port}/v1`);
			await H.seedActiveSession(SID);
			await H.runGeneration(SID);
			expect((await summaryOf(SID)).attemptErrorCode).toBe("internal_error");
		} finally {
			bad.stop(true);
		}
	});

	test("TC-5.14c an undecryptable key is a failed attempt after the claim (P5-7): provider_key_unreadable, no cooldown, nothing sent", async () => {
		await H.seedActiveSession(SID);
		const { llmProviders } = await import("../db/schema/index.js");
		await getDb()
			.update(llmProviders)
			.set({ credentialCiphertext: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0" });
		const result = await H.request(SID);
		expect(result.kind).toBe("started");
		if (result.kind === "started") await H.withDeadline(result.done);
		const row = await summaryOf(SID);
		expect(row?.attemptStatus).toBe("failed");
		expect(row?.attemptErrorCode).toBe("provider_key_unreadable");
		expect(row?.attemptStartedAt).toBeNull();
		expect(stub.requests().length).toBe(0);
		expect(await getSessionSummaryView(SID)).not.toBeNull();
	});

	test("TC-5.15 a secret-shaped string in the provider's error body is not stored, shown or logged", async () => {
		const logs = H.captureLogs();
		try {
			await H.seedActiveSession(SID);
			script({
				text: "",
				status: 401,
				errorBody: "Incorrect API key provided: sk-live-ERRBODYSECRET0123456789abcdef",
			});
			await H.runGeneration(SID);
			for (const text of [
				await serialized(SID),
				JSON.stringify(await viewOf(SID)),
				logs.lines.join("\n"),
			]) {
				expect(text).not.toContain("ERRBODYSECRET");
			}
			expect(stub.requests().length).toBe(1);
		} finally {
			logs.restore();
		}
	});

	test("TC-5.16a a connection refused cannot be told from a failure after the request left: charged the single-call maximum (R-I)", async () => {
		await H.resetWorld(stub);
		await H.enableAi();
		await H.seedProviderAt("http://127.0.0.1:1/v1");
		await H.seedActiveSession(SID);
		let sent = "";
		const real = registry.getAdapter;
		const spy = spyOn(registry, "getAdapter").mockImplementation((provider) => {
			const adapter = real(provider);
			return {
				...adapter,
				complete: (request) => {
					sent = request.systemPrompt + request.transcriptPrompt;
					return adapter.complete(request);
				},
			};
		});
		try {
			const before = await H.snapshotSpend(SID);
			await H.runGeneration(SID);
			expect((await summaryOf(SID)).attemptErrorCode).toBe("provider_error");
			const worst = Math.max(estimateTokens(sent), Math.ceil(Buffer.byteLength(sent, "utf8") / 2));
			const expected = priceCompletion("openai", "gpt-5-mini", {
				inputTokens: worst,
				outputTokens: 4000,
				estimated: true,
			});
			const delta = await H.spendDelta(before);
			expect(sent.length).toBeGreaterThan(0);
			expect(delta.day).toBe(expected);
			expect(delta.sessions[SID]).toBe(expected);
		} finally {
			spy.mockRestore();
		}
	});

	test("TC-5.16b a first call that billed and a repair call rejected before billing settles only the first", async () => {
		await H.seedActiveSession(SID);
		script(unusable(), { text: "", status: 401, errorBody: "no" });
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		expect((await summaryOf(SID)).attemptErrorCode).toBe("provider_auth");
		const delta = await H.spendDelta(before);
		expect(delta.day).toBe(cost());
		expect(delta.sessions[SID]).toBe(cost());
	});

	test("TC-5.17 the failure log line is {code, subType, status} and nothing else", async () => {
		const logs = H.captureLogs();
		try {
			await H.seedActiveSession(SID);
			script({ text: "", status: 429, errorBody: "slow down, PROMPT-SENTINEL" });
			await H.runGeneration(SID);
			const failure = logs.lines.filter((l) => l.includes("provider_rate_limit"));
			expect(failure).toHaveLength(1);
			const json = failure[0].slice(failure[0].indexOf("{"));
			expect(JSON.parse(json)).toEqual({
				code: "provider_rate_limit",
				subType: "transient_rate_limit",
				status: 429,
			});
			const everything = logs.lines.join("\n");
			for (const s of ["PROMPT-SENTINEL", "slow down", "Add retry to the uploader", H.KEY]) {
				expect(everything).not.toContain(s);
			}
		} finally {
			logs.restore();
		}
	});

	test("TC-5.46 an LlmError whose message and cause carry a fake key reaches no row, view or log line", async () => {
		const FAKE = "sk-FAKEKEY-9f8e7d6c5b4a39281706";
		const logs = H.captureLogs();
		const adapter = spyOn(registry, "getAdapter").mockImplementation(() => ({
			kind: "openai",
			complete: async () => {
				throw new LlmError(
					"permanent_auth",
					`rejected key ${FAKE}`,
					401,
					new Error(`cause carries ${FAKE}`),
				);
			},
		}));
		try {
			await H.seedActiveSession(SID);
			await H.runGeneration(SID);
			expect(adapter).toHaveBeenCalled();
			const row = await summaryOf(SID);
			expect(row.attemptErrorCode).toBe("provider_auth");
			for (const text of [
				JSON.stringify(row),
				JSON.stringify(await viewOf(SID)),
				logs.lines.join("\n"),
			]) {
				expect(text).not.toContain(FAKE);
			}
		} finally {
			adapter.mockRestore();
			logs.restore();
		}
	});
});

describe("gates before the repair call", () => {
	async function pausedBetweenCalls(flip: () => Promise<void>) {
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
		const previous = await serialized(SID);
		const [gate] = await gated(unusable());
		const before = await H.snapshotSpend(SID);
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		await flip();
		gate.release();
		await H.withDeadline(done);
		expect(stub.requests().length).toBe(1);
		const row = await summaryOf(SID);
		expect(row.attemptStatus).toBe("failed");
		expect(row.attemptErrorCode).toBe("ai_inactive");
		expect(JSON.parse(await serialized(SID)).summary).toEqual(JSON.parse(previous).summary);
		expect((await H.spendDelta(before)).day).toBe(cost());
	}

	test("TC-5.41a AI paused between the calls ends ai_inactive and the second call is never sent", async () => {
		await pausedBetweenCalls(() => H.setAiSetting("ai.killSwitch", true));
	});
	test("TC-5.41b the Labs flag turned off between the calls ends ai_inactive", async () => {
		await pausedBetweenCalls(async () => void (await setLabsFlag("sessionSummary", false)));
	});
	test("TC-5.41c AI switched off at runtime between the calls ends ai_inactive", async () => {
		await pausedBetweenCalls(() => H.setAiSetting("ai.enabled", false));
	});
});

describe("top-up of the reservation", () => {
	const PRICEY = "gpt-5";
	const BIG = { input: 100_000, output: 10_000 };

	test("TC-5.42a call 1's actual plus the repair's maximum exceeds the reservation: topped up on the reserved date, total settles to the sum of actuals", async () => {
		await H.resetWorld(stub);
		await H.enableAi();
		await H.seedProvider(stub, { model: PRICEY });
		const { editId } = await H.seedActiveSession(SID);
		const view = await viewOf(SID);
		const max = view.spend.maxCostCents;
		const first = cost(BIG, PRICEY);
		expect(first).toBeGreaterThan(max);
		const gates = await gated(
			{ text: "not json", stop: "stop", usage: BIG },
			{ text: H.answer([editId]), stop: "stop", usage: { input: 1000, output: 100 } },
		);
		const before = await H.snapshotSpend(SID);
		const { done } = await H.startGeneration(SID);
		expect((await H.spendDelta(before)).day).toBe(max);
		gates[0].release();
		await H.withDeadline(gates[1].arrived);
		expect((await H.spendDelta(before)).day).toBe(first + max);
		gates[1].release();
		await H.withDeadline(done);
		const second = cost({ input: 1000, output: 100 }, PRICEY);
		const delta = await H.spendDelta(before);
		expect(delta.day).toBe(first + second);
		expect(delta.sessions[SID]).toBe(first + second);
	});

	test("TC-5.42b a refused top-up settles call 1 at its actual cost, returns the rest, ends spend_cap and keeps the previous summary", async () => {
		await H.resetWorld(stub);
		await H.enableAi();
		await H.seedProvider(stub, { model: PRICEY });
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
		const previous = JSON.parse(await serialized(SID));
		const max = (await viewOf(SID)).spend.maxCostCents;
		const first = cost(BIG, PRICEY);
		const [gate] = await gated({ text: "not json", stop: "stop", usage: BIG });
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		// Leave 20 cents of room: the reservation is in the row, the top-up of `first` cannot fit.
		await H.setDaySpend(480);
		const sessionBefore = await H.sessionSpend(SID);
		gate.release();
		await H.withDeadline(done);
		const row = await summaryOf(SID);
		expect(row.attemptErrorCode).toBe("spend_cap");
		expect(JSON.parse(await serialized(SID)).summary).toEqual(previous.summary);
		expect(stub.requests().length).toBe(1);
		expect(await H.daySpend()).toBe(480 + (first - max));
		expect((await H.sessionSpend(SID)) - sessionBefore).toBe(first);
		expect(svc._summaryGenerationCountForTest()).toBe(0);
	});

	test("TC-5.43 an estimated input is priced from system + transcript, not the adapter's transcript-only figure", async () => {
		await H.resetWorld(stub);
		await H.enableAi();
		await H.seedProvider(stub, { kind: "anthropic", model: "claude-opus-4-1" });
		await H.seedSession(SID);
		const rows: SeedEvent[] = [];
		for (let i = 0; i < 30; i++) rows.push(H.prompt(`${i} ${"lorem ipsum dolor ".repeat(80)}`));
		rows.push(H.edit("src/a.ts"));
		const ids = await H.seedEvents(SID, rows);
		stub.script("anthropic", { text: H.answer([ids[ids.length - 1]]), stop: "end_turn" });
		const before = await H.snapshotSpend(SID);
		await H.runGeneration(SID);
		const [req] = stub.requests("anthropic");
		expect(req).toBeDefined();
		const { system, user } = H.promptsOf(req);
		const text = H.answer([ids[ids.length - 1]]);
		const wanted = priceCompletion("anthropic", "claude-opus-4-1", {
			inputTokens: estimateTokens(system + user),
			outputTokens: estimateTokens(text),
			estimated: true,
		});
		const adapterOnly = priceCompletion("anthropic", "claude-opus-4-1", {
			inputTokens: estimateTokens(user),
			outputTokens: estimateTokens(text),
			estimated: true,
		});
		expect(wanted).toBeGreaterThan(adapterOnly);
		expect((await H.spendDelta(before)).day).toBe(wanted);
		const row = await summaryOf(SID);
		expect(row.provenance?.usageEstimated).toBe(true);
		expect(row.provenance?.costCents).toBe(wanted);
		expect(row.provenance?.inputTokens).toBe(estimateTokens(system + user));
	});
});

describe("how often it decrypts and scans", () => {
	test("TC-5.44b a winning request and its whole run decrypt exactly once; a refused request at most once", async () => {
		const { editId } = await H.seedActiveSession(SID);
		await H.seedSession("gen-few");
		script(unusable(), ok([editId]));
		const decrypt = spyOn(secrets, "decryptSecret");
		const scrypt = spyOn(nodeCrypto, "scryptSync");
		try {
			await H.runGeneration(SID);
			expect(decrypt.mock.calls.length).toBe(1);
			expect(scrypt.mock.calls.length).toBe(1);
			expect(stub.requests().length).toBe(2);
			decrypt.mockClear();
			scrypt.mockClear();
			expect(H.refusalOf(await H.request("gen-few"))).toBe("too_little_activity");
			expect(decrypt.mock.calls.length).toBe(0);
			await getDb().update(aiSessionSummaries).set({ attemptStartedAt: null });
			expect(H.refusalOf(await H.request("no-such"))).toBe("session_not_found");
			expect(decrypt.mock.calls.length).toBe(0);
			await viewOf(SID);
			expect(decrypt.mock.calls.length).toBe(0);
		} finally {
			decrypt.mockRestore();
			scrypt.mockRestore();
		}
	});
});

describe("the evidence read", () => {
	test("TC-5.32 one generation over 41,000 events issues at most 12 own-turn jobs and 16 loader statements", async () => {
		await H.seedSession(SID);
		const rows: SeedEvent[] = [];
		for (let i = 0; i < 41_000; i++) {
			if (i % 150 === 0) rows.push(H.prompt(`prompt ${i}`));
			else if (i % 40 === 0) rows.push(H.edit(`src/f${i % 97}.ts`));
			else rows.push({ eventType: "Notification", category: "notification", content: "n" });
		}
		const ids = await H.seedEvents(SID, rows);
		script(ok([ids[0]]));
		const turns = spyOn(ownTurn, "runInOwnTurn");
		try {
			const { statements } = await H.captureStatements(() => H.runGeneration(SID));
			// The request's own too-little-activity probe is one job and one statement; the rest is the loader.
			expect(turns.mock.calls.length - 1).toBeLessThanOrEqual(12);
			const readsEvents = statements.filter((s) => /\bfrom\s+events\b/i.test(s.text));
			expect(readsEvents.length - 1).toBeLessThanOrEqual(16);
			console.log(
				`[perf] ${JSON.stringify({ label: "generation over 41,000 events", ownTurnJobs: turns.mock.calls.length, eventStatements: readsEvents.length })}`,
			);
		} finally {
			turns.mockRestore();
		}
		expect(stub.requests().length).toBe(1);
	}, 120_000);
});

describe("what the verifier is given", () => {
	test("TC-5.7b the session is read again after the last model call: one that started working meanwhile has its outcome clamped", async () => {
		const { editId } = await H.seedActiveSession(SID);
		const gate = stub.createGate();
		script({
			text: H.answer([editId], { outcome: { status: "completed", explanation: "all done" } }),
			stop: "stop",
			usage: H.STUB_USAGE,
			gate,
		} as never);
		const { done } = await H.startGeneration(SID);
		await H.withDeadline(gate.arrived);
		await getDb().update(sessions).set({ isWorking: true }).where(eq(sessions.sessionId, SID));
		gate.release();
		await H.withDeadline(done);
		const codes = (await summaryOf(SID))?.provenance?.adjustments.map((a) => a.code) ?? [];
		expect(codes).toContain("outcome_clamped");
	});

	test("TC-5.7c the ledger is built with the session's agent type: a Claude Code Bash call with no exit code counts as a pass", async () => {
		await H.seedSession(SID);
		const [, testId] = await H.seedEvents(SID, [
			H.prompt("run the tests"),
			{
				eventType: "PostToolUse",
				category: "tool_event",
				toolName: "Bash",
				toolInput: { command: "bun test" },
				toolResponse: "4 pass\n0 fail",
			},
		]);
		script(
			ok([testId], {
				validation: [
					{ what: "bun test", result: "passed", detail: "finished", evidence: [`E${testId}`] },
				],
			}),
		);
		await H.runGeneration(SID);
		const stored = await summaryOf(SID);
		const validation = stored?.summary?.validation[0];
		expect(validation?.result).toBe("passed");
		expect(validation?.adjusted).toBe(false);
	});
});
