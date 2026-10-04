/**
 * AGEN-69 phase 3: the evidence loader against a real database, on either
 * dialect (TC-3.24 to 3.37, 3.40 to 3.43, 3.46, 3.50, 3.52). Nothing is
 * mocked; statements are captured by wrapping the real database handle.
 * Fixtures are seeded in chunks of at most 500 rows (fat rows in smaller ones,
 * to stay under driver limits) with explicit test timeouts. Wall-clock figures
 * are recorded as `[perf]` lines and hard-asserted only at 4x the plan's number.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import "../__test_db.js";
import * as ownTurn from "../../../util/own-turn.js";

const { config } = await import("../../../config.js");
const { getDb, initializeDatabase } = await import("../../../db/client.js");
const { executeRows } = await import("../../../db/sql-helpers.js");
const { events, sessions } = await import("../../../db/schema/index.js");
const { countDbCalls } = await import("../../../test-utils/db-call-counter.js");
const { ingest, getInFlightCount } = await import("../../../routes/ingest.js");
const loader = await import("./evidence-loader.js");
const { buildLedger } = await import("./ledger.js");
const { classifyCommand } = await import("./command-class.js");
const limits = await import("./limits.js");

const { loadEvidence, buildChunkStatement, buildBoundsStatement, buildFirstPromptsStatement } =
	loader;
const isPg = config.dialect === "postgres";
const originalDisableAuth = config.disableAuth;
const GOLDEN = fileURLToPath(new URL("./__fixtures__/ledger-golden.txt", import.meta.url));

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

// ── helpers ──────────────────────────────────────────────────────────────────

type Seed = typeof events.$inferInsert;
const FAKE_KEY = "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const sessionIdFor = (label: string) => `ev-${label}-${crypto.randomUUID().slice(0, 8)}`;

async function newSession(label: string): Promise<string> {
	const sessionId = sessionIdFor(label);
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code" });
	return sessionId;
}

let clock = Date.parse("2026-10-01T10:00:00Z");
const stamp = () => {
	clock += 1000;
	return new Date(clock).toISOString().slice(0, 19).replace("T", " ");
};

function ev(sessionId: string, over: Partial<Seed> & { eventType: string }): Seed {
	return { sessionId, rawPayload: {}, createdAt: stamp(), ...over };
}
const promptEv = (sid: string, content: string, over: Partial<Seed> = {}) =>
	ev(sid, { eventType: "UserPromptSubmit", category: "prompt", content, ...over });
const agentEv = (sid: string, content: string) =>
	ev(sid, { eventType: "AssistantMessage", category: "assistant_message", content });
const toolEv = (
	sid: string,
	toolName: string | null,
	toolInput: unknown,
	over: Partial<Seed> = {},
) =>
	ev(sid, {
		eventType: "PostToolUse",
		category: "tool_event",
		toolName,
		toolInput: toolInput as Seed["toolInput"],
		...over,
	});
const bashEv = (sid: string, command: unknown, over: Partial<Seed> = {}) =>
	toolEv(sid, "Bash", { command }, over);
const readEv = (sid: string, path = "src/r.ts") =>
	toolEv(sid, "Read", { file_path: path }, { isNoise: true });

/** Inserts in chunks; returns ids in insertion order when asked (small fixtures only). */
async function seed(rows: Seed[], chunk = 500): Promise<void> {
	for (let i = 0; i < rows.length; i += chunk) {
		await getDb()
			.insert(events)
			.values(rows.slice(i, i + chunk));
	}
}
async function seedIds(rows: Seed[]): Promise<number[]> {
	const ids: number[] = [];
	for (let i = 0; i < rows.length; i += 500) {
		const got = await getDb()
			.insert(events)
			.values(rows.slice(i, i + 500))
			.returning({ id: events.id });
		ids.push(...got.map((r) => r.id));
	}
	return ids;
}

function render(query: SQL): { text: string; params: unknown[] } {
	const dialect = isPg ? new PgDialect() : new SQLiteSyncDialect();
	const out = dialect.sqlToQuery(query);
	return { text: out.sql, params: out.params };
}

interface Captured {
	query: SQL;
	text: string;
	params: unknown[];
}

/** Runs `fn`, recording every statement the loader sends through the real handle. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; statements: Captured[] }> {
	const statements: Captured[] = [];
	const db = getDb() as unknown as Record<string, (...a: unknown[]) => unknown>;
	const method = isPg ? "execute" : "all";
	const original = (db[method] as (...a: unknown[]) => unknown).bind(db);
	const spy = spyOn(db, method).mockImplementation((query: unknown, ...rest: unknown[]) => {
		statements.push({ query: query as SQL, ...render(query as SQL) });
		return original(query, ...rest);
	});
	try {
		return { result: await fn(), statements };
	} finally {
		spy.mockRestore();
	}
}

const lines = (text: string) => (text === "" ? [] : text.split("\n"));
const ordinalIds = (text: string, firstId: number) =>
	text.replace(/E(\d+)/g, (_m, n) => `E${Number(n) - firstId + 1}`);

function perf(label: string, figures: Record<string, number | string>) {
	console.log(
		`[perf] ${JSON.stringify({ label, dialect: config.dialect, platform: `${process.platform}-${process.arch}`, bun: Bun.version, date: new Date().toISOString().slice(0, 10), load1: Number(loadavg()[0]?.toFixed(1)), ...figures })}`,
	);
}

async function minIdOf(sessionId: string): Promise<number> {
	const [row] = await executeRows<{ m: number }>(
		getDb(),
		sql`SELECT min(id) AS m FROM events WHERE session_id = ${sessionId}`,
	);
	return Number(row?.m);
}

// ── fixtures, seeded once each, on demand ────────────────────────────────────

function once<T>(make: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | undefined;
	return () => {
		promise ??= make();
		return promise;
	};
}

/** 41,000 events: noise (read-class) dominates; a prompt first, agent messages, edits, commands, a tool. */
const fixtureA = once(async () => {
	const sid = await newSession("A41k");
	const rows: Seed[] = [];
	for (let p = 1; p <= 41_000; p++) {
		const m = p % 100;
		if (p === 1) rows.push(promptEv(sid, "FIRST-PROMPT-MARKER please build the thing"));
		else if (p % 500 === 0) rows.push(agentEv(sid, `agent ${p}`));
		else if (p % 1000 === 1) rows.push(promptEv(sid, `prompt ${p}`));
		else if (m <= 4)
			rows.push(
				toolEv(sid, "Edit", { file_path: `src/f${p % 7}.ts`, old_string: "a" }, { isNoise: true }),
			);
		else if (m === 5) rows.push(bashEv(sid, "bun test", { toolResponse: "12 pass\n0 fail" }));
		else if (m <= 9) rows.push(bashEv(sid, `echo ${p}`));
		else if (m === 10) rows.push(toolEv(sid, "mcp__x__y", { q: "SENTINEL-MCP" }));
		else rows.push(readEv(sid));
	}
	await seed(rows);
	return { sid, firstId: await minIdOf(sid) };
});

/** 60,000 events: prompts only in the newest 5,000 and the very first event; the rest is read-class noise. */
const fixtureB = once(async () => {
	const sid = await newSession("B60k");
	const rows: Seed[] = [];
	for (let p = 1; p <= 60_000; p++) {
		if (p === 1) rows.push(promptEv(sid, "B-FIRST-PROMPT take over the build"));
		else if (p > 55_000 && p % 1000 === 0) rows.push(promptEv(sid, `late prompt ${p}`));
		else rows.push(readEv(sid));
	}
	await seed(rows);
	return { sid, firstId: await minIdOf(sid) };
});

/** 2,500 fat tool rows (20 to 100 KB of input each), all inside one chunk. */
const fixtureD = once(async () => {
	const sid = await newSession("D-fat");
	const rows: Seed[] = [promptEv(sid, "fat session")];
	for (let i = 0; i < 2500; i++) {
		const blob = "x".repeat(20_000 + (i % 9) * 10_000);
		rows.push(
			i % 2 === 0
				? toolEv(
						sid,
						"Edit",
						{ file_path: `src/fat${i % 40}.ts`, old_string: blob, new_string: blob },
						{ isNoise: true },
					)
				: toolEv(sid, "Bash", { command: `echo fat ${i}`, description: "d", env: blob }),
		);
	}
	await seed(rows, 50);
	return { sid };
});

/** 201 sessions of 500 events, ids interleaved round-robin; the target is one of them. */
const fixtureC = once(async () => {
	const sessionsList: string[] = [];
	for (let s = 0; s < 201; s++) sessionsList.push(await newSession(`C${s}`));
	const rows: Seed[] = [];
	for (let r = 0; r < 500; r++) {
		for (const sid of sessionsList) {
			if (r % 50 === 0) rows.push(promptEv(sid, `prompt ${r}`));
			else if (r % 10 === 1) rows.push(bashEv(sid, `echo ${r}`));
			else if (r % 10 === 2) rows.push(toolEv(sid, "Edit", { file_path: `src/c${r}.ts` }));
			else rows.push(readEv(sid));
		}
	}
	await seed(rows);
	const target = sessionsList[100] as string;
	await executeRows(getDb(), isPg ? sql`ANALYZE events` : sql`ANALYZE`);
	return { target };
});

// ── TC-3.24, 3.25, 3.27: reads, order, caps, stop rule ───────────────────────

/** 12,000 events: every tenth a prompt, the rest commands. Three chunks reach the first event. */
const fixtureG = once(async () => {
	const sid = await newSession("G12k");
	const rows: Seed[] = [];
	for (let p = 1; p <= 12_000; p++)
		rows.push(p % 10 === 0 ? promptEv(sid, `p${p}`) : bashEv(sid, `echo ${p}`));
	await seed(rows);
	return { sid, firstId: await minIdOf(sid) };
});

describe("reads, caps and order", () => {
	test("TC-3.24 spine 300, actions 800 at most min(remaining,350) per chunk from each chunk's highest ids; two-step statements, newest first, cursor = lowest id minus 1, own-turn jobs, id BETWEEN everywhere", async () => {
		const { sid, firstId } = await fixtureG();
		const ownTurnSpy = spyOn(ownTurn, "runInOwnTurn");
		const { result, statements } = await capture(() => loadEvidence(sid));
		const jobs = ownTurnSpy.mock.calls.length;
		ownTurnSpy.mockRestore();
		const idOf = (p: number) => firstId + p - 1;

		const spine = result.rows.filter((r) => r.category === "prompt");
		const actions = result.rows.filter((r) => r.category === "tool_event");
		expect(spine.map((r) => r.id)).toEqual(
			Array.from({ length: 300 }, (_, i) => idOf(12_000 - i * 10)),
		);
		expect(actions).toHaveLength(800);
		const expectActions = (hiP: number, count: number) => {
			const out: number[] = [];
			for (let p = hiP; out.length < count; p--) if (p % 10 !== 0) out.push(idOf(p));
			return out;
		};
		expect(actions.map((r) => r.id)).toEqual([
			...expectActions(12_000, 350),
			...expectActions(7_000, 350),
			...expectActions(2_000, 100),
		]);

		expect(result.diagnostics.statements.map((s) => s.kind)).toEqual([
			"bounds",
			"chunk",
			"chunk",
			"chunk",
			"first_prompts",
		]);
		expect(statements).toHaveLength(5);
		expect(jobs, "every read is its own own-turn job").toBe(5);
		expect(result.diagnostics.jobs).toBe(5);
		for (const s of statements) expect(s.text).toMatch(/id BETWEEN/i);
		expect(statements.filter((s) => /ROW_NUMBER/i.test(s.text))).toHaveLength(3);
		for (const s of statements.slice(1, 4)) {
			expect(s.text, "ids first, then the join").toMatch(
				/WITH ids AS MATERIALIZED[\s\S]*FROM ids (CROSS )?JOIN events e ON e\.id = ids\.id/,
			);
		}
		// cursor: each chunk starts one below the previous chunk's lowest id.
		const between = (s: Captured) => [s.params[1], s.params[2]].map(Number);
		expect(between(statements[1] as Captured)).toEqual([firstId, idOf(12_000)]);
		expect(between(statements[2] as Captured)).toEqual([firstId, idOf(7_000)]);
		expect(between(statements[3] as Captured)).toEqual([firstId, idOf(2_000)]);
		// limits: spine 300 then none, actions 350, 350, 100.
		expect(statements.slice(1, 4).map((s) => [s.params[3], s.params[4]])).toEqual([
			[300, 350],
			[0, 350],
			[0, 100],
		]);

		expect(result.scan.reachedFirstEvent).toBe(true);
		const ledger = buildLedger(result);
		const c = ledger.coverage;
		expect(c.status).toBe("partial");
		expect(c.eventsRepresented + c.droppedByCap + c.droppedByBudget).toBe(result.scan.eligibleRead);
		expect(result.scan.eligibleRead).toBe(12_000);
	}, 120_000);

	test("TC-3.25a once the action cap is met, later chunk statements ask for narrative rows only (statement text)", async () => {
		const sid = await newSession("H16k");
		const rows: Seed[] = [];
		for (let p = 1; p <= 16_000; p++)
			rows.push(
				p % 100 === 0
					? promptEv(sid, `p${p}`)
					: bashEv(sid, `echo ${p}`, { toolInput: { command: `echo ${p}` } }),
			);
		await seed(rows);
		const { result, statements } = await capture(() => loadEvidence(sid));
		const chunks = statements.filter((s) => /ROW_NUMBER/i.test(s.text));
		expect(chunks).toHaveLength(4);
		for (const s of chunks.slice(0, 3)) expect(s.text).toMatch(/tool_input/);
		expect(chunks[3]?.text).not.toMatch(/tool_input|tool_response/);
		expect(chunks[3]?.params.slice(3, 5), "150 narrative rows still wanted, no tool rows").toEqual([
			150, 0,
		]);
		expect(result.scan.reachedFirstEvent).toBe(true);
		expect(result.rows.filter((r) => r.category === "tool_event")).toHaveLength(800);
	}, 120_000);

	test("TC-3.25b 50,000 Read events: terminates after 10 chunks, partial; chunks with no passing row still advance the cursor and count", async () => {
		const { sid, firstId } = await fixtureB();
		const { result, statements } = await capture(() => loadEvidence(sid));
		expect(result.diagnostics.chunks).toBe(limits.MAX_CHUNKS);
		expect(result.diagnostics.jobs).toBe(12);
		expect(statements).toHaveLength(12);
		expect(result.scan.eventsRead).toBeGreaterThanOrEqual(50_000);
		expect(result.scan.eventsRead).toBeLessThanOrEqual(50_001);
		expect(result.scan.reachedFirstEvent).toBe(false);
		expect(result.scan.droppedByCap).toBe(0);
		const chunkParams = statements
			.filter((s) => /ROW_NUMBER/i.test(s.text))
			.map((s) => Number(s.params[2]));
		const top = firstId + 60_000 - 1;
		expect(chunkParams).toEqual(Array.from({ length: 10 }, (_, i) => top - i * 5000));
		const ledger = buildLedger(result);
		expect(ledger.coverage.status).toBe("partial");
		expect(ledger.coverage.cutoffAt).not.toBeNull();
		expect(
			ledger.coverage.eventsRepresented +
				ledger.coverage.droppedByCap +
				ledger.coverage.droppedByBudget,
		).toBe(result.scan.eligibleRead);
	}, 180_000);

	test("TC-3.25c a session that fits one chunk stops at its first event", async () => {
		const sid = await newSession("small");
		await seed([promptEv(sid, "hi"), bashEv(sid, "bun test"), readEv(sid)]);
		const { result } = await capture(() => loadEvidence(sid));
		expect(result.diagnostics.chunks).toBe(1);
		expect(result.scan.reachedFirstEvent).toBe(true);
		expect(buildLedger(result).coverage.status).toBe("full");
	});

	test("TC-3.26 a NULL tool_name and a NULL category are included as material and not excluded from any read or from the max id", async () => {
		const sid = await newSession("nulls");
		const ids = await seedIds([
			promptEv(sid, "go"),
			toolEv(sid, null, { command: "echo nullname" }),
			ev(sid, {
				eventType: "PostToolUse",
				category: null,
				toolName: "Bash",
				toolInput: { command: "echo nullcat" },
			}),
			ev(sid, {
				eventType: "UserPromptSubmit",
				category: null,
				content: "a prompt with no category",
			}),
			ev(sid, { eventType: "SomethingElse", category: null, content: "unknown type, last id" }),
		]);
		const { result } = await capture(() => loadEvidence(sid));
		expect(result.throughEventId).toBe(ids[4] as number);
		const got = new Set(result.rows.map((r) => r.id));
		for (const id of [ids[0], ids[1], ids[2], ids[3]]) expect(got.has(id as number)).toBe(true);
		expect(got.has(ids[4] as number)).toBe(false);
		expect(result.scan.eventsRead).toBe(5);
		expect(result.scan.eligibleRead).toBe(4);
		expect(buildLedger(result).text).toContain("echo nullcat");
	});

	test("TC-3.27 through_event_id is max(id) and firstEventId min(id), read before the evidence; a trailing user_ack counts; no events gives nulls", async () => {
		const sid = await newSession("bounds");
		const ids = await seedIds([
			promptEv(sid, "a"),
			bashEv(sid, "echo 1"),
			ev(sid, { eventType: "UserAcknowledge", category: "user_ack", content: "Marked as seen" }),
		]);
		const { result, statements } = await capture(() => loadEvidence(sid));
		expect(result.throughEventId).toBe(ids[2] as number);
		expect(result.firstEventId).toBe(ids[0] as number);
		expect(statements[0]?.text).toMatch(/min\(id\)[\s\S]*max\(id\)[\s\S]*count\(\*\)/i);
		expect(statements[0]?.text).not.toMatch(/ROW_NUMBER/i);
		expect(statements.slice(1).every((s) => /ROW_NUMBER|ids AS MATERIALIZED/i.test(s.text))).toBe(
			true,
		);
		expect(result.scan.eventsTotal).toBe(3);
		const empty = await loadEvidence(await newSession("none"));
		expect(empty).toMatchObject({
			throughEventId: null,
			firstEventId: null,
			rows: [],
			firstPromptRows: [],
		});
		expect(empty.scan.eventsTotal).toBe(0);
		expect(empty.diagnostics.jobs).toBe(1);
	});
});

// ── TC-3.28, 3.29, 3.31, 3.46, 3.52: expressions ─────────────────────────────

describe("what SQL selects", () => {
	test("TC-3.28 a 200 KB tool_input yields fields of at most 556 characters (300 in the ledger); a response is read in full only for validation-looking commands and as a 556-character tail only for failures", async () => {
		const sid = await newSession("fields");
		const huge = "h".repeat(200_000);
		const response = `${"r".repeat(1900)}END-OF-RESPONSE`;
		const ids = await seedIds([
			promptEv(sid, "start"),
			toolEv(sid, "Edit", { file_path: `src/${huge}`, old_string: huge, new_string: huge }),
			bashEv(sid, `echo ${"c".repeat(400)}`, {
				toolInput: { command: `echo ${"c".repeat(400)}`, description: huge, blob: huge },
			}),
			bashEv(sid, "bun test", { toolResponse: response }),
			bashEv(sid, "bun run typecheck", { eventType: "PostToolUseFailure", toolResponse: response }),
			bashEv(sid, "git status", { toolResponse: "SENTINEL-OK-OUTPUT" }),
			bashEv(sid, "rm -rf x", {
				eventType: "PostToolUseFailure",
				toolResponse: `${"q".repeat(900)}TAIL-OF-FAILURE`,
			}),
			toolEv(sid, "WebFetch", { url: "SENTINEL-URL" }, { toolResponse: "SENTINEL-WEB" }),
		]);
		const { result, statements } = await capture(() => loadEvidence(sid));
		const row = (n: number) => result.rows.find((r) => r.id === ids[n]);
		expect(row(1)?.filePath?.length).toBeLessThanOrEqual(556);
		expect(Array.from(row(1)?.filePath ?? "").length).toBe(556);
		expect(row(2)?.command?.length).toBeLessThanOrEqual(556);
		expect(row(2)?.description?.length).toBe(556);
		expect(row(3)?.response, "validation-looking: read in full").toBe(response);
		expect(row(4)?.response).toBe(response);
		expect(row(4)?.responseTail).toBe(response.slice(-556));
		expect(row(5)?.response, "not validation-looking").toBeNull();
		expect(row(5)?.responseTail).toBeNull();
		expect(row(6)?.response).toBeNull();
		expect(row(6)?.responseTail?.endsWith("TAIL-OF-FAILURE")).toBe(true);
		expect(row(6)?.responseTail?.length).toBe(556);
		expect(row(7)?.response).toBeNull();
		expect(JSON.stringify(result.rows)).not.toMatch(/SENTINEL-(OK-OUTPUT|URL|WEB)/);
		expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual(
			[
				"category",
				"command",
				"content",
				"createdAt",
				"description",
				"eventType",
				"filePath",
				"id",
				"response",
				"responseTail",
				"toolName",
			].sort(),
		);
		const ledger = buildLedger(result);
		expect(ledger.text).not.toContain("hhhhhhhhhh".repeat(35));
		const edited = lines(ledger.text).find((l) => l.includes("OBSERVED edit"));
		expect(Array.from(edited ?? "").length).toBeLessThanOrEqual(340);
		const cmdLine = lines(ledger.text).find((l) => l.includes("echo ccc"));
		expect(cmdLine?.match(/`([^`]*)`/)?.[1]?.length).toBe(301);

		const chunk = (statements.find((s) => /ROW_NUMBER/i.test(s.text)) as Captured).text;
		expect(chunk).not.toMatch(/raw_payload/);
		const stripped = chunk
			.replace(/json_extract\(e\.tool_input, \?\)/g, "")
			.replace(/json_valid\(e\.tool_input\)/g, "")
			.replace(/\(e\.tool_input::json\) -> \$\d+/g, "")
			.replace(/strpos\(CAST\(e\.tool_input AS text\), \$\d+\)/g, "")
			.replace(/CAST\(e\.tool_input AS text\) !~ \$\d+/g, "");
		expect(stripped, "tool_input only inside key extractions").not.toMatch(/tool_input/);
		const finalSelect = chunk.slice(chunk.lastIndexOf("SELECT meta.chunk_lo"));
		expect(finalSelect).not.toMatch(/tool_input|e\.tool_response/);
		expect(finalSelect.match(/ex\.full_response/g)).toHaveLength(1);
		expect(finalSelect).toMatch(/CASE WHEN .*LIKE[\s\S]*THEN ex\.full_response END/);
	});

	test("TC-3.29 an astral character at positions cap+255 and cap+256 is kept or dropped whole, identically on both dialects", async () => {
		const sid = await newSession("astral");
		const cap = limits.PROMPT_CAP + limits.SQL_REDACTION_MARGIN;
		const ids = await seedIds([
			promptEv(sid, "first"),
			promptEv(sid, "second"),
			promptEv(sid, "third"),
			promptEv(sid, `${"a".repeat(cap - 2)}😀😀zz`),
			promptEv(sid, `${"a".repeat(cap - 1)}😀zz`),
			promptEv(sid, `${"a".repeat(cap)}😀zz`),
		]);
		const { result } = await capture(() => loadEvidence(sid));
		const content = (n: number) => result.rows.find((r) => r.id === ids[n])?.content ?? "";
		expect(content(3)).toBe(`${"a".repeat(cap - 2)}😀😀`);
		expect(content(4)).toBe(`${"a".repeat(cap - 1)}😀`);
		expect(content(5)).toBe("a".repeat(cap));
		for (const n of [3, 4, 5]) expect(LONE_SURROGATE.test(content(n))).toBe(false);
	});

	test("TC-3.31 a command stored as a number, array, object, null or a string with quotes and unicode renders the same on both dialects without throwing", async () => {
		const sid = await newSession("cmdtypes");
		const tricky = 'say "hi" é 中 😀 \\ end';
		const ids = await seedIds([
			promptEv(sid, "go"),
			bashEv(sid, 5),
			bashEv(sid, ["bash", "-lc", "bun test"], { toolResponse: "3 pass" }),
			bashEv(sid, { a: 1 }),
			bashEv(sid, null),
			bashEv(sid, tricky),
		]);
		const { result } = await capture(() => loadEvidence(sid));
		const command = (n: number) => result.rows.find((r) => r.id === ids[n])?.command;
		expect(command(1)).toBe("5");
		expect(command(2)).toBe('["bash","-lc","bun test"]');
		expect(command(3)).toBe('{"a":1}');
		expect(command(4)).toBeNull();
		expect(command(5)).toBe(tricky);
		const text = buildLedger(result).text;
		const byId = (n: number) => lines(text).find((l) => l.startsWith(`E${ids[n]} `)) ?? "";
		expect(byId(1)).toMatch(/`5` -> ok$/);
		expect(byId(2)).toMatch(
			/\[validation\] `bash -lc 'bun test'`|\[validation\] `\["bash","-lc","bun test"\]`/,
		);
		expect(byId(3)).toMatch(/\[not shown\] -> ok$/);
		expect(byId(4)).toMatch(/\[not shown\] -> ok$/);
		expect(byId(5)).toContain('`say "hi" \u00e9 \u4e2d \ud83d\ude00 \\ end`');
	});

	test("TC-3.31b a tool_input that is an array, a number or text, or a command with a NUL escape, does not fail the statement for the other rows", async () => {
		const sid = await newSession("unreadable");
		const ids = await seedIds([
			promptEv(sid, "go"),
			toolEv(sid, "Bash", [1, 2, 3]),
			toolEv(sid, "Bash", 7),
			toolEv(sid, "Bash", "just text"),
			bashEv(sid, "echo \u0000 nul"),
			bashEv(sid, "echo healthy"),
		]);
		const { result } = await capture(() => loadEvidence(sid));
		const command = (n: number) => result.rows.find((r) => r.id === ids[n])?.command;
		expect(result.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(ids);
		expect(command(5)).toBe("echo healthy");
		for (const n of [1, 2, 3]) expect(command(n), `tool_input ${n}`).toBeNull();
		const ledger = buildLedger(result);
		expect(ledger.text).toContain("`echo healthy`");
		expect(ledger.ids.size).toBe(6);
	});

	test("TC-3.52 the coarse predicate reads the full response for every validation positive (a superset of the classifier) and for no git status row", async () => {
		const sid = await newSession("coarse");
		const positives = [
			"bun test",
			"bun run test",
			"npm test",
			"npx vitest",
			"vitest",
			"jest",
			"pytest",
			"go test ./...",
			"cargo test",
			"tsc --noEmit",
			"bun run typecheck",
			"biome check",
			"bun run check",
			"CI=1 bun test",
			"env FOO=1 bun test",
			"cd x && bun test",
			["bash", "-lc", "bun test"],
		];
		const rows: Seed[] = [promptEv(sid, "start")];
		for (const c of positives)
			rows.push(bashEv(sid, c, { toolResponse: `RESP ${JSON.stringify(c)} 3 pass` }));
		await seed(rows);
		const { result } = await capture(() => loadEvidence(sid));
		const byCommand = new Map(result.rows.filter((r) => r.command).map((r) => [r.command, r]));
		for (const c of positives) {
			const stored = typeof c === "string" ? c : JSON.stringify(c);
			expect(classifyCommand(stored).kind, `classifier ${stored}`).toBe("validation");
			expect(byCommand.get(stored)?.response, `response for ${stored}`).toContain("RESP");
		}
		const noisy = await newSession("gitstatus");
		await seed(
			Array.from({ length: 1000 }, () =>
				bashEv(noisy, "git status", { toolResponse: "On branch main\nnothing to commit" }),
			),
		);
		const { result: noisyResult } = await capture(() => loadEvidence(noisy));
		expect(noisyResult.rows).toHaveLength(350);
		expect(noisyResult.rows.every((r) => r.response === null && r.responseTail === null)).toBe(
			true,
		);
	}, 60_000);

	test("TC-3.46 redact-then-cap: a key and a PEM block straddling a cap, longer than the SQL margin, are wholly redacted; SQL reads cap + 256 characters", async () => {
		const sid = await newSession("straddle");
		const cap = limits.PROMPT_CAP;
		const pem = `-----BEGIN PRIVATE KEY-----\n${"MIIEFAKEFAKE".repeat(60)}\n-----END PRIVATE KEY-----`;
		expect(pem.length).toBeGreaterThan(limits.SQL_REDACTION_MARGIN * 2);
		await seed([
			promptEv(sid, "one"),
			promptEv(sid, "two"),
			promptEv(sid, "three"),
			promptEv(sid, `${"a".repeat(cap - 6)} ${FAKE_KEY} tail`),
			promptEv(sid, `${"b".repeat(cap - 11)} ${pem}`),
			agentEv(sid, `${"c".repeat(limits.AGENT_MESSAGE_CAP - 6)} ${FAKE_KEY} tail`),
			agentEv(sid, "last message"),
		]);
		const { result, statements } = await capture(() => loadEvidence(sid));
		const chunk = statements.find((s) => /ROW_NUMBER/i.test(s.text)) as Captured;
		expect(chunk.params).toContain(cap + limits.SQL_REDACTION_MARGIN);
		expect(chunk.params).toContain(limits.LAST_AGENT_MESSAGE_CAP + limits.SQL_REDACTION_MARGIN);
		const prompts = result.rows.filter((r) => r.category === "prompt");
		expect(
			prompts.every((r) => Array.from(r.content ?? "").length <= cap + limits.SQL_REDACTION_MARGIN),
		).toBe(true);
		const { text } = buildLedger(result);
		expect(/sk-ant-[A-Za-z0-9_-]{8,}/.test(text)).toBe(false);
		expect(text).not.toContain("sk-ant-");
		expect(text).not.toContain("BEGIN PRIVATE KEY");
		expect(text).not.toContain("MIIEFAKE");
	});
});

// ── TC-3.30: golden ──────────────────────────────────────────────────────────

describe("TC-3.30 golden", () => {
	test("TC-3.30 one fixture loaded on either dialect gives byte-identical ledger text equal to the committed golden file", async () => {
		const sid = await newSession("golden");
		const goldenLongTail = `${"x".repeat(900)}-TAIL`;
		const rows: Seed[] = [
			promptEv(sid, "Add retry to the uploader.\nKeep the API stable."),
			agentEv(sid, "I'll start by reading the uploader."),
			readEv(sid, "src/uploader.ts"),
			toolEv(
				sid,
				"Edit",
				{ file_path: "src/uploader.ts", old_string: "a", new_string: "b" },
				{ isNoise: true },
			),
			toolEv(
				sid,
				"Edit",
				{ file_path: "src/uploader.ts", old_string: "c", new_string: "d" },
				{ isNoise: true },
			),
			toolEv(sid, "Write", { file_path: "src/retry.ts", content: "export {}" }, { isNoise: true }),
			bashEv(sid, "bun test src/uploader.test.ts", {
				toolInput: { command: "bun test src/uploader.test.ts", description: "Run uploader tests" },
				toolResponse: "src/uploader.test.ts:\n(pass) retries\n 4 pass\n 0 fail",
			}),
			bashEv(sid, "cat .env", { toolResponse: "TOKEN=fake" }),
			bashEv(sid, 'python -c "print(1)"', {
				eventType: "PostToolUseFailure",
				toolResponse: "boom",
			}),
			bashEv(sid, "rm -rf build", {
				eventType: "PostToolUseFailure",
				toolResponse: goldenLongTail,
			}),
			toolEv(sid, "mcp__notes__add", { text: "SENTINEL-MCP" }),
			ev(sid, {
				eventType: "PermissionRequest",
				category: "permission_event",
				toolName: "Bash",
				content: "Permission requested: Bash",
			}),
			ev(sid, { eventType: "UserAcknowledge", category: "user_ack", content: "Marked as seen" }),
			promptEv(sid, "Also document it."),
			bashEv(sid, "bun run typecheck", { toolResponse: "Found 0 errors." }),
			agentEv(sid, "Done: retry added and documented."),
		];
		rows.forEach((r, i) => {
			r.createdAt = new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + i * 37_000)
				.toISOString()
				.slice(0, 19)
				.replace("T", " ");
		});
		await seed(rows);
		const bundle = await loadEvidence(sid);
		const ledger = buildLedger(bundle);
		const normalised = `${ordinalIds(ledger.text, bundle.firstEventId as number)}\n`;
		if (!existsSync(GOLDEN)) {
			mkdirSync(dirname(GOLDEN), { recursive: true });
			writeFileSync(GOLDEN, normalised);
		}
		expect(normalised).toBe(readFileSync(GOLDEN, "utf8"));
		expect(ledger.coverage.status).toBe("full");
	});
});

// ── TC-3.32, 3.40: the 41,000-event fixture ──────────────────────────────────

describe("41,000 events", () => {
	test("TC-3.32 text within budget, first prompt and last entries kept, partial with counts, at most 12 jobs and 16 statements", async () => {
		const { sid, firstId } = await fixtureA();
		let bundle: Awaited<ReturnType<typeof loadEvidence>> | undefined;
		const statementsRun = await countDbCalls(async () => {
			bundle = await loadEvidence(sid);
		});
		const result = bundle as NonNullable<typeof bundle>;
		expect(result.diagnostics.jobs).toBeLessThanOrEqual(12);
		expect(statementsRun).toBeLessThanOrEqual(16);
		expect(statementsRun).toBe(result.diagnostics.jobs);
		const ledger = buildLedger(result);
		expect(ledger.text.length).toBeLessThanOrEqual(limits.LEDGER_CHAR_BUDGET);
		expect(ledger.text).toContain("FIRST-PROMPT-MARKER");
		expect(ledger.ids.has(`E${firstId}`)).toBe(true);
		expect(ledger.ids.has(`E${firstId + 40_999}`), "the newest event, an agent message").toBe(true);
		expect(lines(ledger.text).slice(-3).join("\n")).toContain("agent 41000");
		const c = ledger.coverage;
		expect(c.status).toBe("partial");
		expect(c.eventsTotal).toBe(41_000);
		expect(c.eventsRead).toBe(41_000);
		expect(c.droppedByCap).toBeGreaterThan(0);
		expect(c.eventsRepresented + c.droppedByCap + c.droppedByBudget).toBe(result.scan.eligibleRead);
		expect(result.scan.reachedFirstEvent).toBe(true);
	}, 180_000);

	test("TC-3.40 own-turn jobs at most 12, statements at most 16 (hard); per-job time, event-loop lag and wall time recorded, hard at 4x", async () => {
		const { sid } = await fixtureA();
		let maxLag = 0;
		let last = performance.now();
		const sampler = setInterval(() => {
			const now = performance.now();
			maxLag = Math.max(maxLag, now - last - 5);
			last = now;
		}, 5);
		const started = performance.now();
		const result = await loadEvidence(sid);
		const wall = performance.now() - started;
		clearInterval(sampler);
		const perJob = result.diagnostics.statements.map((s) => s.elapsedMs);
		const slowest = Math.max(...perJob);
		perf("TC-3.40 41k events", {
			jobs: result.diagnostics.jobs,
			slowestJobMs: Number(slowest.toFixed(1)),
			maxLagMs: Number(maxLag.toFixed(1)),
			wallMs: Number(wall.toFixed(1)),
			perJobMs: perJob.map((n) => Number(n.toFixed(1))).join(","),
		});
		expect(result.diagnostics.jobs).toBeLessThanOrEqual(12);
		expect(result.diagnostics.statements.length).toBeLessThanOrEqual(16);
		if (!isPg) {
			expect(slowest).toBeLessThan(100);
			expect(maxLag).toBeLessThan(100);
			expect(wall).toBeLessThan(2000);
		}
	}, 180_000);
});

// ── TC-3.33, 3.42: fat bodies ────────────────────────────────────────────────

describe("fat bodies", () => {
	test("TC-3.33 2,500 fat tool rows in one chunk: at most 350 action rows and 1.5 MB into JS for the chunk; per-job time recorded, hard at 4x", async () => {
		const { sid } = await fixtureD();
		const result = await loadEvidence(sid);
		const chunk = result.diagnostics.statements.find((s) => s.kind === "chunk");
		expect(result.diagnostics.chunks).toBe(1);
		expect(result.rows.filter((r) => r.category === "tool_event")).toHaveLength(
			limits.ACTION_ROWS_PER_CHUNK,
		);
		expect(chunk?.chars ?? Number.POSITIVE_INFINITY).toBeLessThan(limits.CHUNK_BYTES_CEILING);
		const slowest = Math.max(...result.diagnostics.statements.map((s) => s.elapsedMs));
		perf("TC-3.33 fat bodies", {
			chunkRows: chunk?.rows ?? -1,
			chunkChars: chunk?.chars ?? -1,
			chunkMs: Number((chunk?.elapsedMs ?? -1).toFixed(1)),
			slowestJobMs: Number(slowest.toFixed(1)),
		});
		if (!isPg) expect(slowest).toBeLessThan(100);
	}, 240_000);

	test("TC-3.42 per statement: at most 350 action rows and 1.5 MB of text into JS, on the fat fixture", async () => {
		const { sid } = await fixtureD();
		const result = await loadEvidence(sid);
		for (const s of result.diagnostics.statements) {
			expect(s.chars).toBeLessThanOrEqual(limits.CHUNK_BYTES_CEILING);
			if (s.kind === "chunk")
				expect(s.rows).toBeLessThanOrEqual(limits.ACTION_ROWS_PER_CHUNK + 300);
		}
		expect(result.rows.length).toBeLessThanOrEqual(limits.ACTION_ROWS_PER_CHUNK + 1);
		expect(JSON.stringify(result.rows).length).toBeLessThan(limits.CHUNK_BYTES_CEILING);
	}, 240_000);
});

// ── TC-3.34, 3.35: pruned and shared ─────────────────────────────────────────

describe("what remains and what belongs", () => {
	test("TC-3.34 a partly pruned session loads what remains; an empty session returns an empty map and nulls", async () => {
		const sid = await newSession("pruned");
		const ids = await seedIds([
			promptEv(sid, "old prompt"),
			bashEv(sid, "echo old"),
			bashEv(sid, "echo mid"),
			bashEv(sid, "echo new"),
		]);
		await getDb()
			.delete(events)
			.where(eq(events.id, ids[1] as number));
		await getDb()
			.delete(events)
			.where(eq(events.id, ids[0] as number));
		const result = await loadEvidence(sid);
		expect(result.firstEventId).toBe(ids[2] as number);
		expect(result.throughEventId).toBe(ids[3] as number);
		expect(result.scan.eventsTotal).toBe(2);
		const ledger = buildLedger(result);
		expect([...ledger.ids.keys()].sort()).toEqual([`E${ids[2]}`, `E${ids[3]}`].sort());
		const none = buildLedger(await loadEvidence(await newSession("empty")));
		expect(none.ids.size).toBe(0);
		expect(none.text).toBe("");
	});

	test("TC-3.35 another session's events never appear; an id of session B is absent from A's map", async () => {
		const a = await newSession("iso-a");
		const b = await newSession("iso-b");
		const rows: Seed[] = [];
		for (let i = 0; i < 30; i++)
			rows.push(i % 2 ? promptEv(a, `a ${i}`) : promptEv(b, `SENTINEL-B ${i}`));
		const bIds = (await seedIds(rows)).filter((_, i) => i % 2 === 0);
		const result = await loadEvidence(a);
		expect(result.rows.every((r) => r.content?.startsWith("a "))).toBe(true);
		const ledger = buildLedger(result);
		for (const id of bIds) expect(ledger.ids.has(`E${id}`)).toBe(false);
		expect(ledger.text).not.toContain("SENTINEL-B");
		expect(result.scan.eventsTotal).toBe(15);
	});
});

// ── TC-3.36, 3.37: through the real ingest path ──────────────────────────────

function ingestApp() {
	const app = new Hono();
	app.route("/api/v1", ingest);
	return app;
}
async function quiesce() {
	for (let i = 0; i < 300 && getInFlightCount() > 0; i++)
		await new Promise((r) => setTimeout(r, 10));
	expect(getInFlightCount()).toBe(0);
}
async function post(agent: string, body: Record<string, unknown>, event?: string) {
	const app = ingestApp();
	const res = await app.request(`/api/v1/hooks${event ? `?event=${event}` : ""}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Agent-Type": agent },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await quiesce();
}
const fixtureJson = async (dir: string, name: string): Promise<Record<string, unknown>> =>
	JSON.parse(
		await Bun.file(
			fileURLToPath(new URL(`../../agents/__fixtures__/${dir}/${name}.json`, import.meta.url)),
		).text(),
	);

describe("through the real ingest path", () => {
	test("TC-3.36 claude_code events written by ingest yield the expected entries", async () => {
		const sid = sessionIdFor("claude-ingest");
		const base = { session_id: sid, cwd: "/work/p" };
		await post("claude_code", {
			...base,
			hook_event_name: "UserPromptSubmit",
			prompt: "fix the flaky test",
		});
		await post("claude_code", {
			...base,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "bun test" },
			tool_use_id: "t1",
		});
		await post("claude_code", {
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "bun test", description: "Run tests" },
			tool_response: "4 pass\n0 fail",
			tool_use_id: "t1",
		});
		await post("claude_code", {
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: "src/a.ts", old_string: "SENTINEL-OLD", new_string: "SENTINEL-NEW" },
			tool_response: "ok",
			tool_use_id: "t2",
		});
		await post("claude_code", {
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "src/a.ts" },
			tool_response: "SENTINEL-READ",
			tool_use_id: "t3",
		});
		await post("claude_code", {
			...base,
			hook_event_name: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "rm -rf build" },
			tool_response: "permission denied",
			tool_use_id: "t4",
		});
		await post("claude_code", {
			...base,
			hook_event_name: "Stop",
			last_assistant_message: "Fixed and verified.",
		});
		const ledger = buildLedger(await loadEvidence(sid));
		const text = ledger.text;
		expect(lines(text).map((l) => l.replace(/^\S+ \S+ /, ""))).toEqual([
			'CLAIMED user prompt: "fix the flaky test"',
			expect.stringMatching(
				/^OBSERVED command \[validation\] `bun test` \(desc "Run tests"\) -> ok: "4 pass 0 fail"$/,
			) as unknown as string,
			"OBSERVED edit src/a.ts",
			'OBSERVED command `rm -rf build` -> FAILED: "permission denied"',
			'CLAIMED agent message: "Fixed and verified."',
		]);
		expect(text).not.toMatch(/SENTINEL/);
		expect(ledger.coverage.status).toBe("full");
	}, 60_000);

	test("TC-3.37 codex and copilot sessions built from the agent fixtures through ingest are not judged too little: commands appear, read-class tools do not flood", async () => {
		const codexSid = sessionIdFor("codex-ingest");
		const withSid = (f: Record<string, unknown>) => ({ ...f, session_id: codexSid });
		await post("codex_cli", withSid(await fixtureJson("codex", "UserPromptSubmit")));
		await post("codex_cli", withSid(await fixtureJson("codex", "PostToolUse")));
		await post(
			"codex_cli",
			withSid({
				...(await fixtureJson("codex", "PostToolUse")),
				tool_name: "Read",
				tool_input: { file_path: "SENTINEL-CODEX-READ" },
				tool_use_id: "read-1",
			}),
		);
		await post("codex_cli", withSid(await fixtureJson("codex", "Stop")));
		const codex = buildLedger(await loadEvidence(codexSid));
		expect(lines(codex.text).map((l) => l.replace(/^\S+ \S+ /, ""))).toEqual([
			"CLAIMED user prompt: \"run 'echo hi' and stop\"",
			"OBSERVED command `echo hi` -> ok",
			'CLAIMED agent message: "hi"',
		]);
		expect(codex.text).not.toContain("SENTINEL");

		const copilotSid = sessionIdFor("copilot-ingest");
		const cop = async (name: string, event: string, extra: Record<string, unknown> = {}) =>
			post(
				"copilot_cli",
				{ ...(await fixtureJson("copilot", name)), sessionId: copilotSid, ...extra },
				event,
			);
		await cop("userPromptSubmitted", "userPromptSubmitted");
		await cop("postToolUse", "postToolUse");
		await cop("postToolUse", "postToolUse", {
			toolName: "view",
			toolArgs: { path: "SENTINEL-COPILOT-VIEW" },
		});
		await cop("postToolUseFailure", "postToolUseFailure");
		const copilot = buildLedger(await loadEvidence(copilotSid));
		expect(lines(copilot.text).map((l) => l.replace(/^\S+ \S+ /, ""))).toEqual([
			"CLAIMED user prompt: \"run 'echo hi' and stop\"",
			"OBSERVED command `echo hi` -> ok",
			"OBSERVED command `false` -> FAILED",
		]);
		expect(copilot.text).not.toContain("SENTINEL");
		expect(copilot.coverage.status).toBe("full");
	}, 60_000);
});

// ── TC-3.41: query plans ─────────────────────────────────────────────────────

// A database from the legacy boot path also has idx_events_session_id(session_id),
// and SQLite may pick it over idx_events_session_id_id for a statement that needs
// only session_id and the rowid: an entry of either index ends in the rowid, so
// the two answer `session_id=? AND id>? AND id<?` the same way. What matters is
// the shape: a search led by session_id with the id range in the index condition,
// never a scan of events and never a walk of the created_at index.
const SESSION_LED_INDEXES = "idx_events_session_id_id|idx_events_session_id";
const SESSION_SEARCH_RE = new RegExp(
	`^SEARCH (?:events|e) USING (?:COVERING )?INDEX (?:${SESSION_LED_INDEXES}) \\(session_id=\\?(?: AND (?:rowid|id)[<>]=?\\?)*\\)$`,
);
const RANGE_RE = /AND (?:rowid|id)[<>]/;
const PRIMARY_KEY_LOOKUP_RE = /^SEARCH (?:events|e) USING INTEGER PRIMARY KEY \(rowid=\?\)$/;

/** Every way one SQLite plan reaches `events` other than the allowed shapes. */
function sqliteEventsPlanViolations(plan: string[]): string[] {
	const eventsLines = plan.filter((d) => /^(?:SEARCH|SCAN) (?:events|e)\b/.test(d));
	const violations = eventsLines
		.filter((d) => !SESSION_SEARCH_RE.test(d) && !PRIMARY_KEY_LOOKUP_RE.test(d))
		.map((d) => `not an allowed access to events: ${d}`);
	const sessionSearches = eventsLines.filter((d) => SESSION_SEARCH_RE.test(d));
	if (sessionSearches.length === 0) violations.push("no session-led index search of events");
	if (!sessionSearches.some((d) => RANGE_RE.test(d))) {
		violations.push("no session-led search carries an id range");
	}
	if (plan.some((d) => d.includes("idx_events_created_at"))) {
		violations.push("walks a created_at index");
	}
	return violations;
}

describe("TC-3.41 plan matcher controls", () => {
	const ok =
		"SEARCH events USING COVERING INDEX idx_events_session_id_id (session_id=? AND id>? AND id<?)";
	const legacy =
		"SEARCH events USING COVERING INDEX idx_events_session_id (session_id=? AND rowid>? AND rowid<?)";
	test("TC-3.41 both session-led index shapes pass, with a primary-key point lookup beside them", () => {
		expect(sqliteEventsPlanViolations([ok])).toEqual([]);
		expect(sqliteEventsPlanViolations([legacy])).toEqual([]);
		expect(
			sqliteEventsPlanViolations([ok, "SEARCH e USING INTEGER PRIMARY KEY (rowid=?)", "SCAN cand"]),
		).toEqual([]);
	});

	test("TC-3.41 a table scan, a created_at walk, a range-less or id-led search are all refused", () => {
		expect(sqliteEventsPlanViolations(["SCAN events"]).length).toBeGreaterThan(0);
		expect(sqliteEventsPlanViolations([ok, "SCAN e"]).length).toBeGreaterThan(0);
		expect(
			sqliteEventsPlanViolations([
				"SEARCH events USING INDEX idx_events_created_at_id (created_at>?)",
			]).length,
		).toBeGreaterThan(0);
		expect(
			sqliteEventsPlanViolations([
				"SEARCH events USING COVERING INDEX idx_events_session_id (session_id=?)",
			]),
		).toContain("no session-led search carries an id range");
		expect(
			sqliteEventsPlanViolations(["SEARCH events USING INDEX idx_events_session_id_id (id>?)"])
				.length,
		).toBeGreaterThan(0);
		expect(sqliteEventsPlanViolations([]).length).toBeGreaterThan(0);
	});
});

describe("TC-3.41 query plans", () => {
	async function planOf(query: SQL): Promise<string[]> {
		if (isPg) {
			const rows = await executeRows<Record<string, string>>(getDb(), sql`EXPLAIN ${query}`);
			return rows.map((r) => String(r["QUERY PLAN"]));
		}
		const rows = await executeRows<{ detail: string }>(getDb(), sql`EXPLAIN QUERY PLAN ${query}`);
		return rows.map((r) => r.detail);
	}

	test("TC-3.41 every evidence statement reaches events through a session-led index on a fixture that interleaves 200 other sessions, after ANALYZE", async () => {
		const { target } = await fixtureC();
		const { statements, result } = await capture(() => loadEvidence(target));
		expect(statements.length).toBeGreaterThanOrEqual(3);
		const minId = result.firstEventId as number;
		const maxId = result.throughEventId as number;
		expect(maxId - minId, "the target's ids interleave with the other sessions").toBeGreaterThan(
			50_000,
		);
		const variants: SQL[] = [
			...statements.map((s) => s.query),
			buildChunkStatement({
				sessionId: target,
				lo: minId,
				cursor: maxId,
				spineLimit: 300,
				actionLimit: 350,
				newestChunk: true,
			}),
			buildChunkStatement({
				sessionId: target,
				lo: minId,
				cursor: maxId,
				spineLimit: 0,
				actionLimit: 350,
				newestChunk: false,
			}),
			buildChunkStatement({
				sessionId: target,
				lo: minId,
				cursor: maxId,
				spineLimit: 300,
				actionLimit: 0,
				newestChunk: false,
			}),
			buildBoundsStatement(target),
			buildFirstPromptsStatement(target, minId, maxId),
		];
		const dump: string[] = [];
		for (const query of variants) {
			const plan = await planOf(query);
			dump.push(plan.join(" | "));
			const joined = plan.join("\n");
			if (isPg) {
				expect(joined).toContain("idx_events_session_id_id");
				expect(joined, "never a backward events_pkey scan").not.toMatch(
					/Backward using events_pkey/,
				);
				expect(joined).not.toMatch(/Seq Scan on events/);
			} else {
				expect(sqliteEventsPlanViolations(plan), plan.join(" | ")).toEqual([]);
			}
		}
		console.log(`[plans] ${config.dialect} chunk: ${dump[statements.length] ?? dump[0]}`);
	}, 240_000);
});

// ── TC-3.43: allowlist sweep ─────────────────────────────────────────────────

describe("TC-3.43 allowlist sweep", () => {
	test("TC-3.43 a sentinel in every column the loader must not send is absent; a sentinel in every field it may send is present", async () => {
		const sid = await newSession("sweep");
		const forbidden = {
			raw: "FORBID-RAW",
			old: "FORBID-OLD",
			neu: "FORBID-NEW",
			content: "FORBID-CONTENT",
			url: "FORBID-URL",
			webPrompt: "FORBID-WEBPROMPT",
			mcp: "FORBID-MCP",
			readResp: "FORBID-READRESP",
			okOut: "FORBID-OKOUT",
			withheld: "FORBID-WITHHELD",
			provider: "FORBID-PROVIDER",
			source: "FORBID-SOURCE",
			dedup: "FORBID-DEDUP",
			other: "FORBID-OTHERKEY",
			ackContent: "FORBID-ACK",
			sysContent: "FORBID-SYSTEM",
		};
		const common = {
			rawPayload: { secret: forbidden.raw },
			providerEventType: forbidden.provider,
			source: forbidden.source,
		};
		let dedup = 0;
		const row = (r: Seed): Seed => ({ ...r, ...common, dedupKey: `${forbidden.dedup}-${dedup++}` });
		await seed([
			row(promptEv(sid, "PERMIT-PROMPT")),
			row(agentEv(sid, "PERMIT-AGENT")),
			row(
				toolEv(sid, "Edit", {
					file_path: "src/PERMIT-PATH.ts",
					old_string: forbidden.old,
					new_string: forbidden.neu,
					content: forbidden.content,
					other: forbidden.other,
				}),
			),
			row(
				toolEv(
					sid,
					"WebFetch",
					{ url: forbidden.url, prompt: forbidden.webPrompt },
					{ toolResponse: "FORBID-WEBRESP" },
				),
			),
			row(toolEv(sid, "mcp__x__y", { arg: forbidden.mcp }, { toolResponse: "FORBID-MCPRESP" })),
			row(
				toolEv(sid, "Read", { file_path: "FORBID-READPATH" }, { toolResponse: forbidden.readResp }),
			),
			row(
				bashEv(sid, "git status", {
					toolInput: { command: "git status", description: "PERMIT-DESC", other: forbidden.other },
					toolResponse: forbidden.okOut,
				}),
			),
			row(bashEv(sid, "bun test", { toolResponse: "PERMIT-VALIDATION-OUTPUT 3 pass" })),
			row(
				bashEv(sid, "rm -rf x", {
					eventType: "PostToolUseFailure",
					toolResponse: "PERMIT-FAILURE-TAIL",
				}),
			),
			row(
				bashEv(sid, "cat .env", {
					toolInput: { command: "cat .env", description: forbidden.withheld },
					toolResponse: forbidden.withheld,
				}),
			),
			row(
				ev(sid, {
					eventType: "PermissionRequest",
					category: "permission_event",
					toolName: "Bash",
					content: "PERMIT-ONELINER",
					toolInput: { command: forbidden.other },
				}),
			),
			row(
				ev(sid, {
					eventType: "UserAcknowledge",
					category: "user_ack",
					content: forbidden.ackContent,
				}),
			),
			row(
				ev(sid, {
					eventType: "SessionStart",
					category: "system_event",
					content: forbidden.sysContent,
				}),
			),
		]);
		const bundle = await loadEvidence(sid);
		const ledgerText = buildLedger(bundle).text;
		const everything =
			JSON.stringify(bundle.rows) + JSON.stringify(bundle.firstPromptRows) + ledgerText;
		// A withheld command's description is read by SQL (it cannot know) but never reaches the ledger.
		for (const value of Object.values(forbidden)) {
			expect(value === forbidden.withheld ? ledgerText : everything, value).not.toContain(value);
		}
		for (const text of ["FORBID-WEBRESP", "FORBID-MCPRESP", "FORBID-READPATH"])
			expect(everything).not.toContain(text);
		const { text } = buildLedger(bundle);
		for (const permitted of [
			"PERMIT-PROMPT",
			"PERMIT-AGENT",
			"PERMIT-PATH",
			"PERMIT-DESC",
			"PERMIT-VALIDATION-OUTPUT",
			"PERMIT-FAILURE-TAIL",
			"PERMIT-ONELINER",
		]) {
			expect(text, permitted).toContain(permitted);
		}
	});
});

// ── TC-3.50: first prompts ───────────────────────────────────────────────────

describe("TC-3.50 first prompts", () => {
	test("TC-3.50 the first prompts are their own single-statement job and are in the ledger although the chunk scan covers only the newest 50,000 of 60,000 events", async () => {
		const { sid, firstId } = await fixtureB();
		const { result, statements } = await capture(() => loadEvidence(sid));
		const first = result.diagnostics.statements.filter((s) => s.kind === "first_prompts");
		expect(first).toHaveLength(1);
		expect(statements.filter((s) => /ORDER BY id ASC LIMIT 5000/.test(s.text))).toHaveLength(1);
		expect(statements.at(-1)?.text).toMatch(/ORDER BY e\.id ASC LIMIT/);
		expect(
			result.rows.some((r) => r.id === firstId),
			"not read by the chunk scan",
		).toBe(false);
		expect(result.firstPromptRows[0]?.id).toBe(firstId);
		const ledger = buildLedger(result);
		expect(ledger.text).toContain("B-FIRST-PROMPT");
		expect(ledger.ids.has(`E${firstId}`)).toBe(true);
		const c = ledger.coverage;
		expect(c.eventsRepresented + c.droppedByCap + c.droppedByBudget).toBe(result.scan.eligibleRead);
	}, 180_000);
});
