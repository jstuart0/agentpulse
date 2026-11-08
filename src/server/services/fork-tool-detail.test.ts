/**
 * What a fork's tool calls ran, stored for its owner (AGEN-123): the redaction order, the caps, the
 * ciphertext at rest and retention, against the real database (SQLite by default, Postgres under
 * AGENTPULSE_TEST_BACKEND=postgres).
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import "../db/__test_db.js";
import {
	FORK_TOOL_DETAIL_CAP_BYTES,
	FORK_TOOL_DETAIL_LIMITS,
	type ForkToolCallReport,
} from "../../shared/fork-tool-calls.js";
import type { Actor } from "../auth/actor.js";
import type { ToolDetailCaller } from "./fork-tool-detail.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { forkToolCalls, sessions, settings } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const detail = await import("./fork-tool-detail.js");
const { EVENTS_RETENTION_DAYS_KEY } = await import("./retention-service.js");
const { SessionOwnershipError } = await import("./session-ownership.js");

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hosts: string[] = [];
let counter = 0;

async function seedFork(over: { fork?: boolean; host?: string } = {}) {
	const sessionId = `t123-svc-${++counter}-${crypto.randomUUID().slice(0, 6)}`;
	const supervisorId = over.host ?? `t123-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId, agentType: "claude_code" });
	if (over.fork !== false) {
		await getDb()
			.update(sessions)
			.set({ metadata: { forkedFromSessionId: "the-original" } })
			.where(eq(sessions.sessionId, sessionId));
	}
	return { sessionId, supervisorId };
}

const call = (over: Partial<ForkToolCallReport> = {}): ForkToolCallReport => ({
	toolUseId: `toolu_${crypto.randomUUID().slice(0, 12)}`,
	turnActionId: "act-1",
	tool: "Bash",
	outcome: "unasked",
	fromSubagent: false,
	input: '{"command":"echo hi"}',
	inputTruncated: false,
	output: "hi",
	outputTruncated: false,
	...over,
});

const SOLO: ToolDetailCaller = {
	actor: { mode: "solo", role: "admin", userId: "u1" } as Actor,
	isHuman: true,
};

async function rawRows(sessionId: string) {
	return getDb().select().from(forkToolCalls).where(eq(forkToolCalls.sessionId, sessionId));
}

afterEach(async () => {
	detail.__resetForkToolDetailLimiterForTests();
	await getDb().delete(settings).where(eq(settings.key, EVENTS_RETENTION_DAYS_KEY));
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});
afterAll(() => {});

describe("making one text safe to keep", () => {
	const { prepareDetailText } = detail;

	test("redacts a planted key, and says it did", () => {
		const out = prepareDetailText(
			"token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD end",
			false,
		);
		expect(out.text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD");
		expect(out.redacted).toBe(true);
	});

	test("applies a user rule, and a text with nothing to hide is not flagged", () => {
		const rule = { name: "mine", pattern: /hunter2/g, replacement: "[HIDDEN]" };
		const hit = prepareDetailText("password hunter2 ok", false, [rule]);
		expect(hit.text).toBe("password [HIDDEN] ok");
		expect(hit.redacted).toBe(true);
		const clean = prepareDetailText("nothing to see", false, [rule]);
		expect(clean).toEqual({ text: "nothing to see", truncated: false, redacted: false });
	});

	test("a secret straddling the 16 KiB cut is hidden in the whole text before the cut, and a user rule too", () => {
		const secret = "sk-ant-api03-ZyXwVuTsRqPoNmLkJiHgFeDcBa0123456789ZZZZ";
		const rule = { name: "mine", pattern: /MYSECRETVALUE/g, replacement: "[HIDDEN]" };
		const text = `${"a".repeat(FORK_TOOL_DETAIL_CAP_BYTES - 20)} ${secret} MYSECRETVALUE tail`;
		const out = prepareDetailText(text, false, [rule]);
		expect(out.text).not.toContain("ZyXwVuTsRq");
		expect(out.text).not.toContain("sk-ant-api03");
		expect(out.truncated).toBe(true);
		expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(FORK_TOOL_DETAIL_CAP_BYTES);
		// The cut text is redacted again: a rule that would only match the cut remainder still bites.
		const cutRule = { name: "tailrule", pattern: /Q{40,}/g, replacement: "[Q]" };
		const q = prepareDetailText(
			`${"b".repeat(FORK_TOOL_DETAIL_CAP_BYTES - 10)}${"Q".repeat(40)}`,
			false,
			[cutRule],
		);
		expect(q.text).not.toMatch(/Q{40}/);
	});

	test("the cut is in bytes and lands on a code point", () => {
		const text = "é".repeat(FORK_TOOL_DETAIL_CAP_BYTES); // 2 bytes each
		const out = prepareDetailText(text, false);
		expect(out.truncated).toBe(true);
		expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(FORK_TOOL_DETAIL_CAP_BYTES);
		expect(out.text).not.toContain("�");
		const emoji = prepareDetailText("😀".repeat(FORK_TOOL_DETAIL_CAP_BYTES), false);
		expect(emoji.text).not.toContain("�");
		expect([...emoji.text].every((c) => c === "😀")).toBe(true);
	});

	test("a text the host cut loses its last 1 KiB; one it didn't keeps everything", () => {
		const text = "x".repeat(5000);
		const cut = prepareDetailText(text, true);
		expect(Buffer.byteLength(cut.text)).toBe(5000 - FORK_TOOL_DETAIL_LIMITS.hostCutDropBytes);
		expect(cut.truncated).toBe(true);
		expect(prepareDetailText(text, false).text).toBe(text);
		expect(prepareDetailText("short", true).text).toBe("");
	});

	test("NUL, C0 controls, ANSI escapes and bidi characters are removed; newlines and tabs stay", () => {
		const out = prepareDetailText("a\u0000b\u0007c\u001b[31mred\u202Eevil\u0085d\te\nf", false);
		const forbidden = new Set([0x00, 0x07, 0x1b, 0x202e]);
		expect([...out.text].filter((ch) => forbidden.has(ch.codePointAt(0) ?? -1))).toEqual([]);
		expect(out.text).toContain("\t");
		expect(out.text).toContain("\n");
		expect(out.redacted).toBe(false);
	});

	test("a lone surrogate (invalid UTF-8 in transit) never reaches storage", () => {
		const out = prepareDetailText("ok\uD800bad\uDC00end", false);
		expect(out.text).not.toMatch(/[\uD800-\uDFFF]/);
	});

	test("a rule that throws makes the call store nothing", async () => {
		const { sessionId, supervisorId } = await seedFork();
		const boom = {
			name: "boom",
			pattern: /x/g,
			replacement: () => {
				throw new Error("rule failed");
			},
		};
		const warnings: string[] = [];
		const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		const out = await detail
			.recordForkToolCalls(
				supervisorId,
				sessionId,
				[call({ input: "xxxSECRETINPUT" }), call({ input: null, output: null })],
				{ rules: [boom] },
			)
			.finally(() => spy.mockRestore());
		// The line says how many, never what.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("fork_tool_detail_dropped");
		expect(warnings[0]).not.toContain("SECRETINPUT");
		// The call with text hit the rule; the one without any text had nothing for it to run on.
		expect(out).toEqual({ stored: 1, dropped: 1 });
		expect(await rawRows(sessionId)).toHaveLength(1);
	});
});

describe("storing a host's report", () => {
	test("stored columns are ciphertext: no sentinel in the raw row, and the owner reads it back", async () => {
		const { sessionId, supervisorId } = await seedFork();
		const sentinel = `SENTINEL-${crypto.randomUUID()}`;
		const c = call({ input: `{"command":"echo ${sentinel}"}`, output: `out ${sentinel}` });
		expect(await detail.recordForkToolCalls(supervisorId, sessionId, [c])).toEqual({
			stored: 1,
			dropped: 0,
		});
		const [row] = await rawRows(sessionId);
		expect(JSON.stringify(row)).not.toContain(sentinel);
		expect(row?.inputCipher).toBeTruthy();
		expect(row?.outputCipher).toBeTruthy();
		const read = await detail.getForkToolCall(sessionId, c.toolUseId, SOLO);
		expect(read.input).toContain(sentinel);
		expect(read.output).toBe(`out ${sentinel}`);
		expect(read.redacted).toBe(false);
	});

	test("a call's DTO says what was cut and hidden", async () => {
		const { sessionId, supervisorId } = await seedFork();
		const c = call({
			input: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
			output: "y".repeat(20_000),
		});
		await detail.recordForkToolCalls(supervisorId, sessionId, [c]);
		const read = await detail.getForkToolCall(sessionId, c.toolUseId, SOLO);
		expect(read.redacted).toBe(true);
		expect(read.outputTruncated).toBe(true);
		expect(read.inputTruncated).toBe(false);
		expect(Buffer.byteLength(read.output ?? "")).toBeLessThanOrEqual(FORK_TOOL_DETAIL_CAP_BYTES);
	});

	test("a duplicate tool_use_id keeps the first content", async () => {
		const { sessionId, supervisorId } = await seedFork();
		const first = call({ output: "first" });
		await detail.recordForkToolCalls(supervisorId, sessionId, [first]);
		const again = await detail.recordForkToolCalls(supervisorId, sessionId, [
			{ ...first, output: "second" },
		]);
		expect(again).toEqual({ stored: 0, dropped: 0 });
		expect((await detail.getForkToolCall(sessionId, first.toolUseId, SOLO)).output).toBe("first");
	});

	test("another host's credential, an unknown session and a non-fork are refused", async () => {
		const { sessionId } = await seedFork();
		await expect(
			detail.recordForkToolCalls("someone-else", sessionId, [call()]),
		).rejects.toBeInstanceOf(SessionOwnershipError);
		const plain = await seedFork({ fork: false });
		await expect(
			detail.recordForkToolCalls(plain.supervisorId, plain.sessionId, [call()]),
		).rejects.toMatchObject({ code: "not_a_fork" });
	});

	test("without the secrets key nothing is stored and the feature says so", async () => {
		const { sessionId, supervisorId } = await seedFork();
		const key = config.secretsKey;
		(config as Record<string, unknown>).secretsKey = "";
		try {
			expect(detail.forkToolDetailAvailable()).toBe(false);
			await expect(
				detail.recordForkToolCalls(supervisorId, sessionId, [call()]),
			).rejects.toMatchObject({ code: "detail_unavailable" });
			await expect(detail.listForkToolCalls(sessionId, SOLO)).rejects.toMatchObject({
				code: "detail_unavailable",
			});
		} finally {
			(config as Record<string, unknown>).secretsKey = key;
		}
		expect(await rawRows(sessionId)).toHaveLength(0);
	});

	test("parse: the report is the contract or nothing", () => {
		const ok = { v: 1, calls: [call()] };
		expect(detail.parseForkToolCallsReport(ok)?.calls).toHaveLength(1);
		for (const bad of [
			null,
			{ v: 2, calls: [call()] },
			{ v: 1, calls: [] },
			{ v: 1, calls: [{ ...call(), tool: "Task" }] },
			{ v: 1, calls: [{ ...call(), tool: "mcp__s__t" }] },
			{ v: 1, calls: [{ ...call(), outcome: "weird" }] },
			{ v: 1, calls: [{ ...call(), toolUseId: "has space" }] },
			{
				v: 1,
				calls: [{ ...call(), input: "x".repeat(FORK_TOOL_DETAIL_LIMITS.hostFieldCapBytes + 1) }],
			},
			{ v: 1, calls: [{ ...call(), fromSubagent: "no" }] },
			{
				v: 1,
				calls: Array.from({ length: FORK_TOOL_DETAIL_LIMITS.callsPerReport + 1 }, () => call()),
			},
		]) {
			expect(detail.parseForkToolCallsReport(bad)).toBeNull();
		}
		for (const tool of ["mcp", "Agent"]) {
			expect(
				detail.parseForkToolCallsReport({ v: 1, calls: [{ ...call(), tool }] }),
			).not.toBeNull();
		}
	});
});

describe("volume caps", () => {
	test("2,000 rows a session: the oldest go first", async () => {
		const { sessionId, supervisorId } = await seedFork();
		const cap = FORK_TOOL_DETAIL_LIMITS.rowsPerSession;
		const stamp = new Date().toISOString();
		const rows = Array.from({ length: cap }, (_, i) => ({
			id: `seed-${String(i).padStart(5, "0")}`,
			sessionId,
			turnActionId: null,
			toolUseId: `seed_${i}`,
			tool: "Bash",
			outcome: "unasked",
			fromSubagent: false,
			inputCipher: null,
			inputTruncated: false,
			outputCipher: null,
			outputTruncated: false,
			redacted: false,
			createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
		}));
		for (let i = 0; i < rows.length; i += 200) {
			await getDb()
				.insert(forkToolCalls)
				.values(rows.slice(i, i + 200));
		}
		await detail.recordForkToolCalls(supervisorId, sessionId, [call({ toolUseId: "fresh" })], {
			now: new Date(stamp),
		});
		const left = await rawRows(sessionId);
		expect(left).toHaveLength(cap);
		expect(left.some((r) => r.toolUseId === "fresh")).toBe(true);
		expect(left.some((r) => r.toolUseId === "seed_0")).toBe(false);
		expect(left.some((r) => r.toolUseId === "seed_1")).toBe(true);
	});

	test("1,200 calls an hour per session; two sessions on one host each keep their own count", async () => {
		const a = await seedFork();
		const b = await seedFork({ host: a.supervisorId });
		const limit = FORK_TOOL_DETAIL_LIMITS.callsPerHourPerSession;
		let stored = 0;
		let dropped = 0;
		for (let i = 0; i < limit + 5; i += 100) {
			const n = Math.min(100, limit + 5 - i);
			const out = await detail.recordForkToolCalls(
				a.supervisorId,
				a.sessionId,
				Array.from({ length: n }, () => call({ input: null, output: null })),
			);
			stored += out.stored;
			dropped += out.dropped;
		}
		expect({ stored, dropped }).toEqual({ stored: limit, dropped: 5 });
		const other = await detail.recordForkToolCalls(b.supervisorId, b.sessionId, [call()]);
		expect(other).toEqual({ stored: 1, dropped: 0 });
	}, 120_000);
});

describe("retention", () => {
	async function putAt(sessionId: string, toolUseId: string, createdAt: Date) {
		await getDb()
			.insert(forkToolCalls)
			.values({
				id: `r-${toolUseId}`,
				sessionId,
				toolUseId,
				tool: "Bash",
				outcome: "unasked",
				createdAt: createdAt.toISOString(),
			});
	}
	const DAY = 24 * 60 * 60 * 1000;

	test("7 days exactly is kept and served; a minute older is neither served nor, after a pass, kept", async () => {
		const { sessionId } = await seedFork();
		const now = new Date("2026-11-08T12:00:00.000Z");
		await putAt(sessionId, "edge", new Date(now.getTime() - 7 * DAY));
		await putAt(sessionId, "old", new Date(now.getTime() - 7 * DAY - 60_000));
		const served = await detail.listForkToolCalls(sessionId, SOLO, {}, now);
		expect(served.calls.map((c) => c.toolUseId)).toEqual(["edge"]);
		await expect(detail.getForkToolCall(sessionId, "old", SOLO, now)).rejects.toMatchObject({
			code: "tool_call_not_found",
		});
		expect(await rawRows(sessionId)).toHaveLength(2); // not served before the pass, still on disk
		expect(await detail.pruneForkToolCalls(now, 0)).toBe(1);
		expect((await rawRows(sessionId)).map((r) => r.toolUseId)).toEqual(["edge"]);
	});

	test("a positive event retention shorter than 7 days wins; unset or longer leaves 7 days", async () => {
		const { sessionId } = await seedFork();
		const now = new Date("2026-11-08T12:00:00.000Z");
		await putAt(sessionId, "four-days", new Date(now.getTime() - 4 * DAY));
		await getDb()
			.insert(settings)
			.values({ key: EVENTS_RETENTION_DAYS_KEY, value: 3 as never });
		expect(
			(await detail.listForkToolCalls(sessionId, SOLO, {}, now)).calls.map((c) => c.toolUseId),
		).toEqual([]);
		expect(await detail.pruneForkToolCalls(now, 3)).toBe(1);
		await putAt(sessionId, "four-days-b", new Date(now.getTime() - 4 * DAY));
		expect(await detail.pruneForkToolCalls(now, 30)).toBe(0);
		expect(await detail.pruneForkToolCalls(now, 0)).toBe(0);
		expect(detail.forkToolDetailCutoffMs(now, -1)).toBe(now.getTime() - 7 * DAY);
	});

	test("the setting key matches the one retention reads", () => {
		expect(detail.EVENTS_RETENTION_SETTING_KEY).toBe(EVENTS_RETENTION_DAYS_KEY);
	});

	test("1,001 expired rows are all deleted across batches", async () => {
		const { sessionId } = await seedFork();
		const now = new Date("2026-11-08T12:00:00.000Z");
		const old = new Date(now.getTime() - 8 * DAY).toISOString();
		const rows = Array.from({ length: 1001 }, (_, i) => ({
			id: `bulk-${i}`,
			sessionId,
			toolUseId: `bulk_${i}`,
			tool: "Bash",
			outcome: "unasked",
			createdAt: old,
		}));
		for (let i = 0; i < rows.length; i += 250) {
			await getDb()
				.insert(forkToolCalls)
				.values(rows.slice(i, i + 250));
		}
		expect(await detail.pruneForkToolCalls(now, 0)).toBe(1001);
		expect(await rawRows(sessionId)).toHaveLength(0);
	});

	test("deleting the session takes its detail with it", async () => {
		const { sessionId } = await seedFork();
		await putAt(sessionId, "cascade", new Date());
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
		expect(await rawRows(sessionId)).toHaveLength(0);
		const [{ n }] = (await getDb()
			.select({ n: sql<number>`count(*)` })
			.from(forkToolCalls)
			.where(eq(forkToolCalls.toolUseId, "cascade"))) as Array<{ n: number }>;
		expect(Number(n)).toBe(0);
	});
});
