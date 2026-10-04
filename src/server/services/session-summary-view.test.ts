/**
 * AGEN-69 phase 5: the read model `getSessionSummaryView` (TC-5.1 to 5.6, 5.22 view half,
 * 5.29 to 5.31, 5.44 view half, 5.54, 5.55). Real database, nothing stubbed; the stub
 * provider is only a base URL here (the view never calls a model).
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
import * as nodeCrypto from "node:crypto";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import type { SeedEvent } from "../test-utils/summary-service-harness.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiSessionSummaries, llmProviders, sessions } = await import("../db/schema/index.js");
const { getSessionSummaryView } = await import("./session-summary-service.js");
const H = await import("../test-utils/summary-service-harness.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const secrets = await import("./ai/secrets.js");
const { priceCompletion } = await import("./ai/llm/pricing.js");
const { estimateTokens } = await import("./ai/llm/types.js");
const { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, MAX_PROMPT_CHARS } = await import(
	"./ai/session-summary/service-limits.js"
);
const { toDbTimestamp } = await import("./util/db-time.js");
const { upsertSetting } = await import("./settings-service.js");
const { STALE_EVENT_COUNT_CAP } = await import("../../shared/session-summary-view.js");
const { loadEvidence } = await import("./ai/session-summary/evidence-loader.js");
const { buildLedgerAsync, userPromptTexts } = await import("./ai/session-summary/ledger.js");
const { buildSummaryPrompt, sessionForPrompt } = await import("./ai/session-summary/prompt.js");
const { SESSION_COLUMNS_SANS_OWNERSHIP } = await import("../db/session-columns.js");

const SID = "view-s1";
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
});
afterEach(async () => {
	await H.resetWorld(stub);
});

async function view(sessionId = SID) {
	const v = await getSessionSummaryView(sessionId);
	if (!v) throw new Error("no view");
	return v;
}
const allKeys = (value: unknown, out = new Set<string>()): Set<string> => {
	if (Array.isArray(value)) for (const v of value) allKeys(v, out);
	else if (value && typeof value === "object")
		for (const [k, v] of Object.entries(value)) {
			out.add(k);
			allKeys(v, out);
		}
	return out;
};

describe("the empty and ready view", () => {
	test("TC-5.1a nothing stored, allowed: provider kind and model, spend, cap, max cost, reset time", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub, { kind: "openai", model: "gpt-5-mini" });
		await H.setDaySpend(120);
		const v = await view();
		expect(v.stored).toBeNull();
		expect(v.generatedAt).toBeNull();
		expect(v.throughAt).toBeNull();
		expect(v.throughEventId).toBeNull();
		expect(v.attempt).toEqual({ status: "idle", startedAt: null, errorCode: null });
		expect(v.staleEvents).toBe(0);
		expect(v.evidenceShrunk).toBe(false);
		expect(v.blocked).toBeNull();
		expect(v.cooldownSeconds).toBeNull();
		expect(v.provider).toEqual({ kind: "openai", model: "gpt-5-mini" });
		expect(v.spend.spentCents).toBe(120);
		expect(v.spend.capCents).toBe(500);
		expect(v.spend.maxCostCents).toBe(
			priceCompletion("openai", "gpt-5-mini", {
				inputTokens: MAX_INPUT_TOKENS,
				outputTokens: MAX_OUTPUT_TOKENS,
				estimated: true,
			}),
		);
		expect(v.spend.maxCostCents).toBeGreaterThan(0);
		expect(v.spend.maxCostWithRetryCents).toBe(2 * v.spend.maxCostCents);
		expect("retentionDays" in v).toBe(false);
	});

	test("TC-5.1b resetsAt is the next local midnight, not UTC and not +24 h (DST-change day)", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		const realTz = process.env.TZ;
		try {
			process.env.TZ = "America/New_York";
			// Spring forward 2031-03-09 02:00 local: from 01:00 the next midnight is 23 hours away.
			setSystemTime(new Date(2031, 2, 9, 1, 0, 0));
			expect(new Date(2031, 2, 9, 1).getTimezoneOffset()).not.toBe(
				new Date(2031, 2, 10, 1).getTimezoneOffset(),
			);
			const v = await view();
			expect(v.spend.resetsAt).toBe(new Date(2031, 2, 10, 0, 0, 0).toISOString());
			expect(new Date(v.spend.resetsAt).getTime() - Date.now()).toBe(23 * 3600 * 1000);
			// And the ordinary case: 10:30 local the next midnight is 13.5 hours away.
			setSystemTime(new Date(2031, 5, 1, 10, 30, 0));
			const w = await view();
			expect(w.spend.resetsAt).toBe(new Date(2031, 5, 2, 0, 0, 0).toISOString());
			expect(w.spend.resetsAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		} finally {
			if (realTz === undefined) Reflect.deleteProperty(process.env, "TZ");
			else process.env.TZ = realTz;
		}
	});

	test("TC-5.1c retentionDays only with a stored summary and retention on", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		await upsertSetting("eventsRetentionDays", 30);
		expect("retentionDays" in (await view())).toBe(false);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
		expect((await view()).retentionDays).toBe(30);
		await upsertSetting("eventsRetentionDays", 0);
		expect("retentionDays" in (await view())).toBe(false);
	});

	test("TC-5.1d the view carries no AI state (key scan) and no owner, key or provider identity", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID, {
			ownerUserId: "owner-sentinel-7c1f",
			ingestKeyId: "key-sentinel-93aa",
			reportedHost: "host-sentinel-55",
			metadata: { secret: "metadata-sentinel-11" },
		});
		await H.seedProvider(stub);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
		const v = await view();
		const keys = [...allKeys(v)].map((k) => k.toLowerCase());
		for (const forbidden of [
			"paused",
			"killswitch",
			"aienabled",
			"aipaused",
			"runtime",
			"build",
			"enabled",
			"active",
			"ai",
		]) {
			expect(keys).not.toContain(forbidden);
		}
		const body = JSON.stringify(v);
		for (const s of [
			"owner-sentinel",
			"key-sentinel",
			"host-sentinel",
			"metadata-sentinel",
			"Stub provider",
			stub.origin,
			"baseUrl",
		]) {
			expect(body).not.toContain(s);
		}
		const [{ id }] = await getDb().select({ id: llmProviders.id }).from(llmProviders);
		expect(body).not.toContain(id);
	});

	test("TC-5.1e an unknown session has no view", async () => {
		expect(await getSessionSummaryView("no-such-session")).toBeNull();
	});
});

describe("blocked reasons", () => {
	test("TC-5.2 too-little-activity table, and the 5,000-event action window", async () => {
		await H.seedProvider(stub);
		const cases: Array<[string, SeedEvent[], boolean]> = [
			["no events", [], true],
			["only user_ack", [H.ack(), H.ack()], true],
			[
				"only system events",
				[
					{ eventType: "SessionStart", category: "system_event" },
					{ eventType: "Notification", category: "notification" },
				],
				true,
			],
			[
				"only a Read-class action",
				[
					{
						eventType: "PostToolUse",
						category: "tool_event",
						toolName: "Read",
						toolInput: { file_path: "a.ts" },
					},
				],
				true,
			],
			["one prompt", [H.prompt("hello")], false],
			["one non-Read action", [H.edit("src/a.ts")], false],
		];
		for (const [name, rows, blocked] of cases) {
			const id = `view-act-${name.replace(/\W+/g, "-")}`;
			await H.seedSession(id);
			await H.seedEvents(id, rows);
			expect((await view(id)).blocked, name).toBe(blocked ? "too_little_activity" : null);
		}
		const filler = (n: number): SeedEvent[] => Array.from({ length: n }, () => H.ack());
		// An action with exactly 5,000 events from the end (itself included) counts; 5,001 does not.
		await H.seedSession("view-win-in");
		await H.seedEvents("view-win-in", [H.edit("src/a.ts"), ...filler(4999)]);
		expect((await view("view-win-in")).blocked).toBeNull();
		await H.seedSession("view-win-out");
		await H.seedEvents("view-win-out", [H.edit("src/a.ts"), ...filler(5000)]);
		expect((await view("view-win-out")).blocked).toBe("too_little_activity");
		// A prompt counts anywhere in the session.
		await H.seedSession("view-prompt-far");
		await H.seedEvents("view-prompt-far", [H.prompt("first"), ...filler(5200)]);
		expect((await view("view-prompt-far")).blocked).toBeNull();
	}, 60_000);

	test("TC-5.3a no_provider only when there is no default provider row", async () => {
		await H.seedActiveSession(SID);
		const none = await view();
		expect(none.blocked).toBe("no_provider");
		expect(none.provider).toBeNull();
		await H.seedProvider(stub);
		await getDb().update(llmProviders).set({ isDefault: false });
		expect((await view()).blocked).toBe("no_provider");
		await getDb().update(llmProviders).set({ isDefault: true });
		expect((await view()).blocked).toBeNull();
	});

	test("TC-5.3b an undecryptable key leaves the view allowed and never throws", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		await getDb()
			.update(llmProviders)
			.set({ credentialCiphertext: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0" });
		const v = await view();
		expect(v.blocked).toBeNull();
		expect(v.provider?.kind).toBe("openai");
	});

	test("TC-5.4 cap edge: cap - m - 1 allowed, cap - m and cap refused", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		const m = (await view()).spend.maxCostCents;
		const cap = 500;
		for (const [spent, blocked] of [
			[cap - m - 1, null],
			[cap - m, "spend_cap_reached"],
			[cap, "spend_cap_reached"],
		] as const) {
			await H.setDaySpend(spent);
			expect((await view()).blocked, `spent ${spent}`).toBe(blocked);
		}
	});

	test("TC-5.5a a free provider is allowed at cap - 1 and at cap, and shows maxCostCents 0", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub, { kind: "openai_compatible" });
		for (const spent of [499, 500]) {
			await H.setDaySpend(spent);
			const v = await view();
			expect(v.blocked).toBeNull();
			expect(v.spend.maxCostCents).toBe(0);
			expect(v.spend.maxCostWithRetryCents).toBe(0);
		}
	});

	test("TC-5.6 the reservation bound covers the worst-case prompt", async () => {
		const longPath = `${"d/".repeat(140)}file.ts`;
		await H.seedSession(SID, {
			displayName: "n".repeat(400),
			cwd: "c".repeat(400),
			gitBranch: "b".repeat(400),
			model: "m".repeat(400),
			currentTask: "t".repeat(2000),
			notes: "x".repeat(2000),
			planSummary: ["p".repeat(2000)],
		});
		const rows: SeedEvent[] = [];
		for (let i = 0; i < 320; i++) rows.push(H.prompt(`${i} ${"word ".repeat(300)}`));
		for (let i = 0; i < 400; i++)
			rows.push({
				eventType: "PostToolUse",
				category: "tool_event",
				toolName: "Bash",
				toolInput: { command: `bun test ${"a".repeat(250)} ${i}` },
				toolResponse: `${"out ".repeat(120)}`,
			});
		for (let i = 0; i < 60; i++) rows.push(H.edit(`${longPath}${i}`));
		await H.seedEvents(SID, rows);
		const bundle = await loadEvidence(SID);
		const ledger = await buildLedgerAsync({
			rows: bundle.rows,
			firstPromptRows: bundle.firstPromptRows,
			scan: bundle.scan,
			agentType: bundle.agentType,
		});
		const [row] = await getDb()
			.select(SESSION_COLUMNS_SANS_OWNERSHIP)
			.from(sessions)
			.where(eq(sessions.sessionId, SID));
		const built = buildSummaryPrompt(sessionForPrompt(row), ledger);
		expect(userPromptTexts(bundle).length).toBeGreaterThan(100);
		const tokens = estimateTokens(built.systemPrompt + built.transcriptPrompt);
		expect(tokens).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
		expect(built.systemPrompt.length + built.transcriptPrompt.length).toBeLessThanOrEqual(
			MAX_PROMPT_CHARS,
		);
		// It is a real bound, not a slack figure: the worst case lands within 2x of it.
		expect(tokens).toBeGreaterThan(MAX_INPUT_TOKENS / 2);
	}, 60_000);
});

describe("the attempt", () => {
	test("TC-5.22a lease: 300 s is still generating, 301 s reads failed / interrupted without writing", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		setSystemTime(new Date(Date.UTC(2031, 0, 1, 12, 0, 0)));
		const started = toDbTimestamp(new Date());
		await H.seedSummaryRow(SID, {
			attemptStatus: "generating",
			attemptStartedAt: started,
			attemptToken: "tok",
		});
		setSystemTime(new Date(Date.UTC(2031, 0, 1, 12, 5, 0)));
		const at300 = await view();
		expect(at300.attempt.status).toBe("generating");
		expect(at300.attempt.errorCode).toBeNull();
		expect(at300.blocked).toBeNull();
		setSystemTime(new Date(Date.UTC(2031, 0, 1, 12, 5, 1)));
		const at301 = await view();
		expect(at301.attempt).toEqual({
			status: "failed",
			startedAt: "2031-01-01T12:00:00.000Z",
			errorCode: "interrupted",
		});
		const row = await H.readSummaryRow(SID);
		expect(row.attemptStatus).toBe("generating");
		expect(row.attemptToken).toBe("tok");
	});

	test("TC-5.21a the view reports the cooldown at second granularity and none after an interrupted attempt", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		const base = Date.UTC(2031, 0, 1, 12, 0, 0);
		setSystemTime(new Date(base));
		const started = toDbTimestamp(new Date(base));
		await H.seedSummaryRow(SID, {
			attemptStatus: "failed",
			attemptErrorCode: "provider_error",
			attemptStartedAt: started,
		});
		for (const [elapsed, blocked, secs] of [
			[29, "summary_cooldown", 1],
			[30, "summary_cooldown", 1],
			[31, null, null],
		] as const) {
			setSystemTime(new Date(base + elapsed * 1000));
			const v = await view();
			expect(v.blocked, `${elapsed}s`).toBe(blocked);
			expect(v.cooldownSeconds, `${elapsed}s`).toBe(secs);
		}
		setSystemTime(new Date(base + 10_000));
		await getDb().update(aiSessionSummaries).set({ attemptErrorCode: "interrupted" });
		const interrupted = await view();
		expect(interrupted.blocked).toBeNull();
		expect(interrupted.cooldownSeconds).toBeNull();
	});

	test("TC-5.21b a longer cooldown reports the whole seconds left", async () => {
		await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		const base = Date.UTC(2031, 0, 1, 12, 0, 0);
		setSystemTime(new Date(base));
		await H.seedSummaryRow(SID, {
			attemptStatus: "idle",
			attemptStartedAt: toDbTimestamp(new Date(base - 5000)),
		});
		const v = await view();
		expect(v.cooldownSeconds).toBe(25);
		expect(v.blocked).toBe("summary_cooldown");
	});

	test("TC-5.27a blocked is the first applicable reason: activity, provider, cooldown, cap", async () => {
		await H.seedSession(SID);
		const base = Date.UTC(2031, 0, 1, 12, 0, 0);
		setSystemTime(new Date(base));
		await H.seedSummaryRow(SID, {
			attemptStatus: "failed",
			attemptErrorCode: "provider_error",
			attemptStartedAt: toDbTimestamp(new Date(base - 1000)),
		});
		await H.setDaySpend(500, H.localDate());
		expect((await view()).blocked).toBe("too_little_activity");
		await H.seedEvents(SID, [H.prompt("hi")]);
		expect((await view()).blocked).toBe("no_provider");
		await H.seedProvider(stub);
		expect((await view()).blocked).toBe("summary_cooldown");
		await getDb()
			.update(aiSessionSummaries)
			.set({ attemptStartedAt: toDbTimestamp(new Date(base - 60_000)) });
		expect((await view()).blocked).toBe("spend_cap_reached");
	});

	test("TC-5.27b while generating nothing blocks (a joiner needs no budget)", async () => {
		await H.seedActiveSession(SID);
		await H.setDaySpend(500);
		await H.seedSummaryRow(SID, {
			attemptStatus: "generating",
			attemptStartedAt: toDbTimestamp(new Date()),
			attemptToken: "t",
		});
		const v = await view();
		expect(v.attempt.status).toBe("generating");
		expect(v.blocked).toBeNull();
		expect(v.cooldownSeconds).toBeNull();
	});
});

describe("stale and shrunk", () => {
	async function ready(): Promise<{ ids: number[] }> {
		await H.seedSession(SID);
		const ids = await H.seedEvents(SID, [H.prompt("one"), H.edit("a.ts"), H.edit("b.ts")]);
		await H.seedProvider(stub);
		await H.seedReadySummary(SID, { throughEventId: ids[2], firstEventId: ids[0] });
		return { ids };
	}

	test("TC-5.29 staleness: a prompt gives 1, user_ack 0, a NULL category counts, SessionEnd counts, only later events", async () => {
		await ready();
		expect((await view()).staleEvents).toBe(0);
		await H.seedEvents(SID, [H.ack(), H.ack()]);
		expect((await view()).staleEvents).toBe(0);
		await H.seedEvents(SID, [H.prompt("two")]);
		expect((await view()).staleEvents).toBe(1);
		await H.seedEvents(SID, [{ eventType: "Whatever", category: null }]);
		expect((await view()).staleEvents).toBe(2);
		await H.seedEvents(SID, [{ eventType: "SessionEnd", category: "lifecycle" }]);
		expect((await view()).staleEvents).toBe(3);
	});

	test("TC-5.55a the stale probe reads at most 100 rows: 5,000 later events give 100, with LIMIT 100 inside the count", async () => {
		await ready();
		await H.seedEvents(
			SID,
			Array.from({ length: 5000 }, () => H.prompt("more")),
		);
		const { result, statements } = await H.captureStatements(() => view());
		expect(result.staleEvents).toBe(STALE_EVENT_COUNT_CAP);
		const probe = statements.filter((s) => /count\(/i.test(s.text));
		expect(probe).toHaveLength(1);
		expect(probe[0].text).toMatch(/limit\s+100/i);
		expect(probe[0].text.toLowerCase().indexOf("limit")).toBeLessThan(
			probe[0].text.toLowerCase().lastIndexOf(")"),
		);
		expect(probe[0].text).toMatch(/from\s*\(\s*select/i);
	}, 30_000);

	test("TC-5.55b the shrunk probe is one min(id) statement with no count(", async () => {
		await ready();
		const { statements } = await H.captureStatements(() => view());
		const minProbes = statements.filter((s) => /min\(/i.test(s.text));
		expect(minProbes).toHaveLength(1);
		expect(minProbes[0].text).not.toMatch(/count\(/i);
	});

	test("TC-5.30 evidenceShrunk: oldest pruned true, add-only false, prune 10 + add 50 true, none stored false, all pruned true", async () => {
		const noSummary = "view-shrunk-none";
		await H.seedActiveSession(noSummary);
		await H.seedProvider(stub);
		expect((await view(noSummary)).evidenceShrunk).toBe(false);

		await H.seedSession(SID);
		const ids = await H.seedEvents(
			SID,
			Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? H.prompt(`p${i}`) : H.edit(`f${i}.ts`))),
		);
		await H.seedReadySummary(SID, { throughEventId: ids[29], firstEventId: ids[0] });
		expect((await view()).evidenceShrunk).toBe(false);
		await H.seedEvents(SID, [H.prompt("later")]);
		expect((await view()).evidenceShrunk).toBe(false);
		const { events } = await import("../db/schema/index.js");
		const { inArray } = await import("drizzle-orm");
		await getDb().delete(events).where(eq(events.id, ids[0]));
		expect((await view()).evidenceShrunk).toBe(true);
		await getDb()
			.delete(events)
			.where(inArray(events.id, ids.slice(1, 10)));
		await H.seedEvents(
			SID,
			Array.from({ length: 50 }, () => H.prompt("new")),
		);
		expect((await view()).evidenceShrunk).toBe(true);
		await getDb().delete(events).where(eq(events.sessionId, SID));
		const gone = await view();
		expect(gone.evidenceShrunk).toBe(true);
		expect(gone.blocked).toBe("too_little_activity");
	});
});

describe("cost of the view", () => {
	test("TC-5.31a no write, at most 6 statements idle or ready, 3 while generating, body at most 2 KB while generating", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		await upsertSetting("eventsRetentionDays", 30);
		const db = getDb() as unknown as Record<string, (...a: unknown[]) => unknown>;
		const writers = (["insert", "update", "delete"] as const).map((m) => spyOn(db, m));
		try {
			const idle = await countDbCalls(async () => void (await view()));
			expect(idle).toBeLessThanOrEqual(6);
			await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
			let body = "";
			const ready = await countDbCalls(async () => {
				body = JSON.stringify(await view());
			});
			expect(ready).toBeLessThanOrEqual(6);
			expect(body.length).toBeGreaterThan(0);
			await getDb().delete(aiSessionSummaries);
			for (const w of writers) w.mockClear();
			await H.seedSummaryRow(SID, {
				attemptStatus: "generating",
				attemptStartedAt: toDbTimestamp(new Date()),
				attemptToken: "t",
			});
			for (const w of writers) w.mockClear();
			let generatingBody = "";
			const generating = await countDbCalls(async () => {
				generatingBody = JSON.stringify(await view());
			});
			expect(generating).toBeLessThanOrEqual(3);
			expect(generatingBody.length).toBeLessThanOrEqual(2048);
			for (const w of writers) expect(w.mock.calls.length).toBe(0);
			console.log(
				`[perf] ${JSON.stringify({ label: "view statements", idle, ready, generating })}`,
			);
		} finally {
			for (const w of writers) w.mockRestore();
		}
	});

	test("TC-5.31b p95 is recorded and hard-asserted at 4x the contract (200 ms)", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
		const times: number[] = [];
		for (let i = 0; i < 30; i++) {
			const t = performance.now();
			await view();
			times.push(performance.now() - t);
		}
		times.sort((a, b) => a - b);
		const p95 = times[Math.floor(times.length * 0.95)];
		console.log(
			`[perf] ${JSON.stringify({ label: "view p95 ms", p95: Number(p95.toFixed(2)), contract: 50, hard: 200 })}`,
		);
		expect(p95).toBeLessThan(200);
	});

	test("TC-5.44a the view never decrypts: no decryptSecret and no scryptSync", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		await H.seedReadySummary(SID, { throughEventId: editId, firstEventId: promptId });
		const decrypt = spyOn(secrets, "decryptSecret");
		const scrypt = spyOn(nodeCrypto, "scryptSync");
		try {
			await view();
			await getDb().update(llmProviders).set({ credentialCiphertext: "garbage" });
			await view();
			expect(decrypt.mock.calls.length).toBe(0);
			expect(scrypt.mock.calls.length).toBe(0);
		} finally {
			decrypt.mockRestore();
			scrypt.mockRestore();
		}
	});

	test("TC-5.54 a ready body is at most 32 KB for a large honest summary; the schema-cap maximum is recorded", async () => {
		const { promptId, editId } = await H.seedActiveSession(SID);
		await H.seedProvider(stub);
		const base = H.storedSummary({ firstEventId: promptId });
		const item = (n: number) => ({
			text: `${"detail ".repeat(36)}${n}`.slice(0, 250),
			evidence: ["E1", "E2", "E3"],
			unverified: false,
		});
		const eight = (f: (n: number) => unknown) => Array.from({ length: 8 }, (_, i) => f(i));
		const honest = {
			...base.summary,
			overview: "o".repeat(1200),
			accomplishments: eight(item),
			changes: eight((n) => ({ ...item(n), kind: "modified" })),
			decisions: eight((n) => ({ ...item(n), why: "w".repeat(200) })),
			validation: eight((n) => ({
				what: `bun test ${n}`,
				result: "passed",
				detail: "d".repeat(200),
				evidence: ["E1"],
				adjusted: false,
			})),
			problems: eight(item),
			unfinished: eight(item),
			nextActions: [0, 1, 2, 3, 4].map(item),
			handoff: "h".repeat(2000),
		};
		const evidence = Object.fromEntries(
			Array.from({ length: 150 }, (_, i) => [
				`E${i + 1}`,
				{ kind: "edit", at: "2026-10-04T10:04:00.000Z", count: 3 },
			]),
		);
		await getDb()
			.insert(aiSessionSummaries)
			.values({
				sessionId: SID,
				generatedAt: toDbTimestamp(new Date()),
				throughEventId: editId,
				summary: honest as never,
				provenance: { ...base.provenance, evidence } as never,
			});
		const honestBytes = JSON.stringify(await view()).length;
		console.log(
			`[perf] ${JSON.stringify({ label: "ready view bytes", honest: honestBytes, limit: 32768 })}`,
		);
		expect(honestBytes).toBeLessThanOrEqual(32 * 1024);
		// The schema's own caps (20 items of 600 characters in seven sections, 4,000-character handoff) cannot fit 32 KB.
		const cap = (n: number) => ({
			text: "x".repeat(600),
			evidence: Array.from({ length: 12 }, (_, i) => `E${n + i}`),
			unverified: false,
		});
		const schemaMax = {
			...honest,
			handoff: "h".repeat(4000),
			accomplishments: Array.from({ length: 20 }, (_, i) => cap(i)),
			problems: Array.from({ length: 20 }, (_, i) => cap(i)),
			unfinished: Array.from({ length: 20 }, (_, i) => cap(i)),
		};
		console.log(
			`[perf] ${JSON.stringify({ label: "schema-cap summary bytes (spec finding: exceeds 32 KB)", bytes: JSON.stringify(schemaMax).length })}`,
		);
	});
});
