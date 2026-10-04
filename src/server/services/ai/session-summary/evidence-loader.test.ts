/**
 * AGEN-69 phase 3: the evidence loader against a real database, on either
 * dialect (TC-3.24 to 3.37, 3.40 to 3.43, 3.46, 3.50, 3.52). Nothing is
 * mocked; statements are captured by wrapping the real database handle.
 * Fixtures are seeded in chunks of at most 500 rows (fat rows in smaller ones,
 * to stay under driver limits) with explicit test timeouts. Wall-clock figures
 * are recorded as `[perf]` lines (per-job time as the minimum of 3 runs) and
 * hard-asserted only on SQLite, at the plan's hard limit.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, eq, inArray, sql } from "drizzle-orm";
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
const { OwnTurnBusyError } = await import("../../../util/own-turn.js");
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
const createdSessions: string[] = [];
afterAll(async () => {
	config.disableAuth = originalDisableAuth;
	// P3-30: the fixtures leave ~230k event rows and ~200 MB of fat bodies in the shared
	// temp database; every later file in the process would carry them.
	for (let i = 0; i < createdSessions.length; i += 50) {
		const batch = createdSessions.slice(i, i + 50);
		await getDb().delete(events).where(inArray(events.sessionId, batch));
		await getDb().delete(sessions).where(inArray(sessions.sessionId, batch));
	}
}, 600_000);

// ── helpers ──────────────────────────────────────────────────────────────────

type Seed = typeof events.$inferInsert;
const FAKE_KEY = "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const sessionIdFor = (label: string) => `ev-${label}-${crypto.randomUUID().slice(0, 8)}`;

async function newSession(label: string, agentType = "claude_code"): Promise<string> {
	const sessionId = sessionIdFor(label);
	await getDb().insert(sessions).values({ sessionId, agentType });
	createdSessions.push(sessionId);
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

/** Per-statement time as the minimum of `runs` loads; event-loop lag and wall time of the best run are recorded, not asserted. */
async function timedLoads(sessionId: string, runs = 3) {
	const perStatement: number[][] = [];
	let maxLag = 0;
	let wall = Number.POSITIVE_INFINITY;
	let last = performance.now();
	const sampler = setInterval(() => {
		const now = performance.now();
		maxLag = Math.max(maxLag, now - last - 5);
		last = now;
	}, 5);
	let result: Awaited<ReturnType<typeof loadEvidence>> | undefined;
	for (let i = 0; i < runs; i++) {
		const started = performance.now();
		result = await loadEvidence(sessionId);
		wall = Math.min(wall, performance.now() - started);
		perStatement.push(result.diagnostics.statements.map((s) => s.elapsedMs));
	}
	clearInterval(sampler);
	const perJobMin = (result as NonNullable<typeof result>).diagnostics.statements.map((_, k) =>
		Math.min(...perStatement.map((run) => run[k] as number)),
	);
	return {
		result: result as NonNullable<typeof result>,
		perJobMin,
		slowest: Math.max(...perJobMin),
		maxLag,
		wall,
	};
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

/** 60,000 events: five prompts at the very start, prompts in the newest 5,000; the rest is read-class noise. */
const fixtureB = once(async () => {
	const sid = await newSession("B60k");
	const rows: Seed[] = [];
	for (let p = 1; p <= 60_000; p++) {
		if (p === 1) rows.push(promptEv(sid, "B-FIRST-PROMPT take over the build"));
		else if (p >= 2 && p <= 5) rows.push(promptEv(sid, `B-EARLY-PROMPT-${p}`));
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

/**
 * 400 tool rows with about 40 KB of incompressible input each. The byte budget counts
 * stored bytes (Postgres `pg_column_size`, which reads no TOAST), so a fixture of one
 * repeated character, which compresses to a few hundred bytes, would not exercise it.
 */
const fixtureE = once(async () => {
	const sid = await newSession("E-incompressible");
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let state = 12345;
	const noise = (n: number) => {
		let out = "";
		for (let i = 0; i < n; i++) {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			out += alphabet[(state >> 16) % 64];
		}
		return out;
	};
	const rows: Seed[] = [promptEv(sid, "incompressible")];
	for (let i = 0; i < 400; i++)
		rows.push(
			bashEv(sid, `echo ${i}`, { toolInput: { command: `echo ${i}`, env: noise(40_000) } }),
		);
	await seed(rows, 20);
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
		expect(result.scan.eventsRead).toBeLessThanOrEqual(50_003);
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
	test("TC-3.28 a 200 KB tool_input yields fields of at most 556 characters (300 in the ledger); a response is read, cut to 2,000 characters in SQL, only for shell-tool rows, and as a 2,000-character tail only for failures", async () => {
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
		expect(row(3)?.response, "a shell row: read, within the 2,000 cut").toBe(response);
		expect(row(4)?.response).toBe(response);
		expect(row(4)?.responseTail, "a failed row: the last 2,000 characters, here all of it").toBe(
			response,
		);
		expect(row(5)?.response, "a shell row: the stored response, cut in SQL").toBe(
			"SENTINEL-OK-OUTPUT",
		);
		expect(row(5)?.responseTail).toBeNull();
		expect(row(6)?.responseTail?.endsWith("TAIL-OF-FAILURE")).toBe(true);
		expect(row(6)?.responseTail?.length).toBe(915);
		expect(row(7)?.response, "a non-shell tool: no response").toBeNull();
		expect(JSON.stringify(result.rows)).not.toMatch(/SENTINEL-(URL|WEB)/);
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

		const chunkStatement = statements.find((s) => /ROW_NUMBER/i.test(s.text)) as Captured;
		const chunk = chunkStatement.text;
		// P3-35: raw_payload is read in one place only: the `tool_use_id` key of a Post row with
		// no input, and the `error` keys of a failed row with no response.
		const rawKeys = chunkStatement.params.filter((p) =>
			["tool_use_id", "error", "error_message"].includes(String(p).replace(/^\$\./, "")),
		);
		expect(rawKeys.length).toBeGreaterThan(0);
		const withoutAllowedRawReads = chunk
			.replace(/\(?\w+\.raw_payload(?:::json)?\)?\s*->>?\s*\$\d+/g, "")
			.replace(/json_extract\(\w+\.raw_payload, \?\)/g, "")
			.replace(/json_valid\(\w+\.raw_payload\)/g, "")
			.replace(/strpos\(CAST\(\w+\.raw_payload AS text\), \$\d+\)/g, "")
			.replace(/CAST\(\w+\.raw_payload AS text\) !~ \$\d+/g, "");
		expect(withoutAllowedRawReads, "raw_payload only inside those extractions").not.toMatch(
			/raw_payload/,
		);
		const stripped = chunk
			.replace(/json_extract\(\w+\.tool_input, \?\)/g, "")
			.replace(/json_valid\(\w+\.tool_input\)/g, "")
			.replace(/\(\w+\.tool_input::json\) -> \$\d+/g, "")
			.replace(/strpos\(CAST\(\w+\.tool_input AS text\), \$\d+\)/g, "")
			.replace(/CAST\(\w+\.tool_input AS text\) !~ \$\d+/g, "")
			.replace(/COALESCE\(\w+\.tool_input, \w+\.tool_input\)/g, "")
			.replace(/\w+\.tool_input IS NULL/g, "")
			.replace(/pg_column_size\(\w+\.tool_input\)/g, "")
			.replace(/length\(CAST\(\w+\.tool_input AS BLOB\)\)/g, "");
		expect(
			stripped,
			"tool_input only inside key extractions, the pairing and the byte budget",
		).not.toMatch(/tool_input/);
		const finalSelect = chunk.slice(chunk.lastIndexOf("SELECT meta.chunk_lo"));
		expect(finalSelect).not.toMatch(/tool_input|e\.tool_response|raw_payload|LIKE/);
		expect(chunkStatement.params, "the response is cut in SQL").toContain(limits.RESPONSE_SQL_CAP);
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

	test("TC-3.52 the response is read for every shell-tool row (every validation positive, every ordinary command) and for no other tool", async () => {
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
		rows.push(
			toolEv(sid, "WebFetch", { url: "SENTINEL-URL" }, { toolResponse: "SENTINEL-WEB" }),
			toolEv(sid, "mcp__x__y", { q: "x" }, { toolResponse: "SENTINEL-MCP" }),
			bashEv(sid, "git status", { toolResponse: "On branch main" }),
		);
		await seed(rows);
		const { result } = await capture(() => loadEvidence(sid));
		const byCommand = new Map(result.rows.filter((r) => r.command).map((r) => [r.command, r]));
		for (const c of positives) {
			const stored = typeof c === "string" ? c : JSON.stringify(c);
			expect(classifyCommand(stored).kind, `classifier ${stored}`).toBe("validation");
			expect(byCommand.get(stored)?.response, `response for ${stored}`).toContain("RESP");
		}
		expect(byCommand.get("git status")?.response).toBe("On branch main");
		const nonShell = result.rows.filter((r) => /WebFetch|mcp__/.test(r.toolName ?? ""));
		expect(nonShell).toHaveLength(2);
		expect(nonShell.every((r) => r.response === null && r.responseTail === null)).toBe(true);
		expect(JSON.stringify(result.rows)).not.toMatch(/SENTINEL-(URL|WEB|MCP)/);
		const noisy = await newSession("gitstatus");
		await seed(
			Array.from({ length: 1000 }, () =>
				bashEv(noisy, "git status", { toolResponse: "On branch main\nnothing to commit" }),
			),
		);
		const { result: noisyResult } = await capture(() => loadEvidence(noisy));
		expect(noisyResult.rows).toHaveLength(350);
		expect(noisyResult.rows.every((r) => r.responseTail === null)).toBe(true);
		expect(buildLedger(noisyResult).text).not.toContain("nothing to commit");
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
			promptEv(
				sid,
				"Add retry to the uploader.\nKeep the API stable. \u{1F600} \u{1F468}\u200D\u{1F469} done",
			),
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
			...Array.from({ length: 8 }, (_, i) =>
				toolEv(sid, "Edit", { file_path: "src/many.ts", old_string: `o${i}` }, { isNoise: true }),
			),
			bashEv(sid, "rm -rf dist", {
				eventType: "PostToolUseFailure",
				toolResponse: `-----BEGIN PRIVATE KEY-----\n${"MIIEFAKEFAKE".repeat(8)}\n-----END PRIVATE KEY-----\nrm: cannot remove dist`,
			}),
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
		if (process.env.UPDATE_GOLDEN === "1") {
			mkdirSync(dirname(GOLDEN), { recursive: true });
			writeFileSync(GOLDEN, normalised);
		}
		expect(existsSync(GOLDEN), "golden file missing: run once with UPDATE_GOLDEN=1").toBe(true);
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

	test("TC-3.40 own-turn jobs at most 12, statements at most 16 (hard); per-job time (minimum of 3 runs), event-loop lag and wall time recorded, per-job hard at 100 ms on SQLite", async () => {
		const { sid } = await fixtureA();
		const { result, perJobMin, slowest, maxLag, wall } = await timedLoads(sid);
		const targetMs = 25;
		perf("TC-3.40 41k events", {
			jobs: result.diagnostics.jobs,
			slowestJobMs: Number(slowest.toFixed(1)),
			targetMs,
			overTarget: slowest > targetMs ? "yes" : "no",
			maxLagMs: Number(maxLag.toFixed(1)),
			wallMs: Number(wall.toFixed(1)),
			perJobMs: perJobMin.map((n) => Number(n.toFixed(1))).join(","),
		});
		expect(result.diagnostics.jobs).toBeLessThanOrEqual(12);
		expect(result.diagnostics.statements.length).toBeLessThanOrEqual(16);
		if (!isPg) expect(slowest).toBeLessThan(100);
	}, 300_000);
});

// ── TC-3.33, 3.42: fat bodies ────────────────────────────────────────────────

describe("fat bodies", () => {
	test("TC-3.33 2,500 fat tool rows in one chunk: at most 350 action rows and 1.5 MB into JS for the chunk, and the meter is not zero; per-job time (minimum of 3) recorded with an overTarget flag, hard at 100 ms on SQLite", async () => {
		const { sid } = await fixtureD();
		const { result, perJobMin, slowest } = await timedLoads(sid);
		const chunk = result.diagnostics.statements.find((s) => s.kind === "chunk");
		expect(result.diagnostics.chunks).toBe(1);
		expect(result.rows.filter((r) => r.category === "tool_event")).toHaveLength(350);
		expect(chunk?.chars ?? 0, "a meter that reads 0 would pass the ceiling").toBeGreaterThan(5_000);
		expect(chunk?.chars ?? Number.POSITIVE_INFINITY).toBeLessThan(limits.CHUNK_BYTES_CEILING);
		const targetMs = 50;
		perf("TC-3.33 fat bodies", {
			chunkRows: chunk?.rows ?? -1,
			chunkChars: chunk?.chars ?? -1,
			slowestJobMs: Number(slowest.toFixed(1)),
			perJobMs: perJobMin.map((n) => Number(n.toFixed(1))).join(","),
			targetMs,
			overTarget: slowest > targetMs ? "yes" : "no",
		});
		if (!isPg) expect(slowest).toBeLessThan(100);
	}, 300_000);

	test("TC-3.42 per statement: at most 350 action rows and 1.5 MB of text into JS, on the fat fixture, every field at its cap", async () => {
		const { sid } = await fixtureD();
		const result = await loadEvidence(sid);
		for (const s of result.diagnostics.statements) {
			expect(s.chars).toBeLessThanOrEqual(1_500_000);
			if (s.kind === "chunk") expect(s.rows).toBeLessThanOrEqual(350 + 300);
		}
		expect(result.rows.length).toBeLessThanOrEqual(350 + 1);
		expect(JSON.stringify(result.rows).length).toBeLessThan(1_500_000);
		const capped = result.rows.filter((r) => r.command !== null || r.filePath !== null);
		expect(capped.length).toBeGreaterThan(0);
		for (const r of capped) {
			expect(Array.from(r.command ?? "").length).toBeLessThanOrEqual(556);
			expect(Array.from(r.filePath ?? "").length).toBeLessThanOrEqual(556);
			expect(Array.from(r.description ?? "").length).toBeLessThanOrEqual(556);
		}
	}, 300_000);

	test("P3-33 a byte budget on tool_input: rows past 8 MB of stored input are actions with NULL fields, rendered [not shown]", async () => {
		const { sid } = await fixtureE();
		const result = await loadEvidence(sid);
		const actions = result.rows.filter((r) => r.category === "tool_event");
		const withFields = actions.filter((r) => r.command !== null || r.filePath !== null);
		const without = actions.filter((r) => r.command === null && r.filePath === null);
		expect(actions).toHaveLength(350);
		expect(withFields.length, "the newest rows are read").toBeGreaterThan(20);
		expect(without.length, "the budget cut some").toBeGreaterThan(50);
		const newestId = Math.max(...actions.map((r) => r.id));
		expect(withFields.some((r) => r.id === newestId)).toBe(true);
		const firstWithout = Math.max(...without.map((r) => r.id));
		const oldestWith = Math.min(...withFields.map((r) => r.id));
		expect(firstWithout, "the cut is by recency: everything after the budget is NULL").toBeLessThan(
			oldestWith,
		);
		const ledger = buildLedger(result);
		expect(ledger.text).toMatch(/\[not shown\]|\[path not shown\]/);
	}, 300_000);

	test("P3-32 a 300 KB response on a validation command is cut in SQL: at most 2,000 characters per row, and the chunk stays under the ceiling", async () => {
		const sid = await newSession("fatresp");
		const huge = `${"r".repeat(300_000)} FAIL tail`;
		await seed(
			[
				promptEv(sid, "go"),
				...Array.from({ length: 60 }, (_, i) =>
					bashEv(sid, `bun test src/a${i}.test.ts`, { toolResponse: huge }),
				),
			],
			10,
		);
		const result = await loadEvidence(sid);
		const rows = result.rows.filter((r) => r.command !== null);
		expect(rows).toHaveLength(60);
		for (const r of rows) {
			expect(Array.from(r.response ?? "").length).toBeLessThanOrEqual(2000);
			expect(r.response?.length ?? 0).toBeGreaterThan(1000);
		}
		const chunk = result.diagnostics.statements.find((s) => s.kind === "chunk");
		expect(chunk?.chars ?? Number.POSITIVE_INFINITY).toBeLessThan(1_500_000);
		expect(chunk?.chars ?? 0).toBeGreaterThan(60 * 1000);
	}, 120_000);
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
		createdSessions.push(sid);
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
				/^OBSERVED command \[validation\] `bun test` \(desc "Run tests"\) -> ok: "4 pass"$/,
			) as unknown as string,
			'OBSERVED edit "src/a.ts"',
			'OBSERVED command `rm -rf build` -> FAILED: "permission denied"',
			'CLAIMED agent message: "Fixed and verified."',
		]);
		expect(text).not.toMatch(/SENTINEL/);
		expect(ledger.coverage.status).toBe("full");
	}, 60_000);

	test("TC-3.37 codex and copilot sessions built from the agent fixtures through ingest are not judged too little: commands appear, read-class tools do not flood", async () => {
		const codexSid = sessionIdFor("codex-ingest");
		createdSessions.push(codexSid);
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
			"OBSERVED command `echo hi` -> completed",
			'CLAIMED agent message: "hi"',
		]);
		expect(codex.text).not.toContain("SENTINEL");

		const copilotSid = sessionIdFor("copilot-ingest");
		createdSessions.push(copilotSid);
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
	`^SEARCH (?:events|e|pre2?) USING (?:COVERING )?INDEX (?:${SESSION_LED_INDEXES}) \\(session_id=\\?(?: AND (?:rowid|id)[<>]=?\\?)*\\)$`,
);
const RANGE_RE = /AND (?:rowid|id)[<>]/;
const PRIMARY_KEY_LOOKUP_RE =
	/^SEARCH (?:events|e|pre) USING INTEGER PRIMARY KEY \(rowid=\?\)(?: LEFT-JOIN)?$/;

/** Every way one SQLite plan reaches `events` other than the allowed shapes. */
function sqliteEventsPlanViolations(plan: string[]): string[] {
	const eventsLines = plan.filter((d) => /^(?:SEARCH|SCAN) (?:events|e|pre2?)\b/.test(d));
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

// Postgres: the planner may answer a statement from idx_events_session_id_id or
// from the unique (session_id, dedup_key) index, both led by session_id (a
// min/max over one session's ids came back as a bitmap scan of the second on
// some runs). Never a sequential scan, a backward walk of the primary key, or an
// index that is not led by session_id; the primary key is fine for point lookups.
const PG_SESSION_LED_INDEXES = new Set(["idx_events_session_id_id", "uq_events_session_dedup_key"]);
const PG_INDEX_SCAN_RE =
	/(?:Index Only Scan|Index Scan|Bitmap Index Scan)( Backward)?(?: using| on) (\w+)/;

/** Every way one Postgres plan reaches `events` other than the allowed shapes. */
function pgEventsPlanViolations(plan: string[]): string[] {
	const violations: string[] = [];
	let sessionLed = 0;
	for (const line of plan) {
		if (/Seq Scan on events\b/.test(line)) violations.push(`sequential scan: ${line.trim()}`);
		const m = PG_INDEX_SCAN_RE.exec(line);
		if (!m) continue;
		const [, backward, index] = m;
		if (!/^(?:idx_events_|uq_events_|events_)/.test(index)) continue;
		if (PG_SESSION_LED_INDEXES.has(index)) sessionLed++;
		else if (index === "events_pkey" && !backward) continue;
		else violations.push(`not a session-led index: ${line.trim()}`);
	}
	if (sessionLed === 0) violations.push("no scan through a session-led index");
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

describe("TC-3.41 Postgres plan matcher controls", () => {
	const idLed =
		"Index Only Scan Backward using idx_events_session_id_id on events e  (cost=0.42..1.0 rows=1)";
	const dedupLed =
		"  ->  Bitmap Index Scan on uq_events_session_dedup_key  (cost=0.00..8.00 rows=477 width=0)";
	test("TC-3.41 either session-led index passes, with a primary-key point lookup beside it", () => {
		expect(pgEventsPlanViolations([idLed])).toEqual([]);
		expect(pgEventsPlanViolations([dedupLed])).toEqual([]);
		expect(
			pgEventsPlanViolations([
				idLed,
				"Index Scan using events_pkey on events e  (cost=0.42..8.44)",
			]),
		).toEqual([]);
	});

	test("TC-3.41 a sequential scan, a backward primary-key walk, a created_at walk and a plan with no session index are refused", () => {
		expect(
			pgEventsPlanViolations([idLed, "Seq Scan on events e  (cost=0.00..9.0)"]).length,
		).toBeGreaterThan(0);
		expect(
			pgEventsPlanViolations([idLed, "Index Scan Backward using events_pkey on events e"]).length,
		).toBeGreaterThan(0);
		expect(
			pgEventsPlanViolations([idLed, "Index Scan using idx_events_created_at_id on events e"])
				.length,
		).toBeGreaterThan(0);
		expect(pgEventsPlanViolations(["Index Scan using events_pkey on events e"])).toContain(
			"no scan through a session-led index",
		);
		expect(pgEventsPlanViolations([]).length).toBeGreaterThan(0);
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
				expect(pgEventsPlanViolations(plan), joined).toEqual([]);
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
		// A withheld command's description and an ordinary command's ok output are read by SQL (it cannot know) but never reach the ledger.
		// A shell row's response is read into JS (to find an exit code); only the ledger is the boundary.
		const ledgerOnly = new Set([forbidden.withheld, forbidden.okOut]);
		for (const value of Object.values(forbidden)) {
			expect(ledgerOnly.has(value) ? ledgerText : everything, value).not.toContain(value);
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
		expect(result.firstPromptRows.map((r) => r.content?.slice(0, 14))).toEqual([
			"B-FIRST-PROMPT",
			"B-EARLY-PROMPT",
			"B-EARLY-PROMPT",
		]);
		expect(ledger.text).toContain("B-EARLY-PROMPT-3");
		expect(
			ledger.text,
			"the 4th and 5th early prompts are beyond the scan and not first prompts",
		).not.toContain("B-EARLY-PROMPT-4");
		expect(ledger.ids.has(`E${firstId}`)).toBe(true);
		const c = ledger.coverage;
		expect(c.eventsRepresented + c.droppedByCap + c.droppedByBudget).toBe(result.scan.eligibleRead);
	}, 180_000);
});

// ── P3 review fixes: pairing, shapes, boundaries, robustness ─────────────────

const OBSERVER_HEADERS = { "X-AgentPulse-Origin": "codex-observer" };
async function postObserver(
	sid: string,
	hook: "PreToolUse" | "PostToolUse",
	callId: string,
	fields: { tool_name: string; tool_input?: unknown; tool_response?: unknown },
) {
	const app = ingestApp();
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Type": "codex_cli",
			...OBSERVER_HEADERS,
		},
		body: JSON.stringify({
			session_id: sid,
			hook_event_name: hook,
			tool_use_id: callId,
			...fields,
			...(fields.tool_input === undefined ? {} : { tool_input: fields.tool_input }),
		}),
	});
	expect(res.status).toBe(200);
	await quiesce();
}
async function observerCall(
	sid: string,
	callId: string,
	toolName: string,
	input: unknown,
	response: unknown,
	postName = toolName,
) {
	await postObserver(sid, "PreToolUse", callId, { tool_name: toolName, tool_input: input });
	await postObserver(sid, "PostToolUse", callId, { tool_name: postName, tool_response: response });
}
const bodies = (text: string) => lines(text).map((l) => l.replace(/^\S+ \S+ /, ""));

describe("P3-8 Codex observer rows, through the real ingest path", () => {
	test("a Post row with no input takes its command from the Pre row of the same call: cmd, array and unknown_tool forms", async () => {
		const sid = sessionIdFor("observer");
		createdSessions.push(sid);
		await postObserver(sid, "PreToolUse", "p0", { tool_name: "noop" });
		await observerCall(sid, "c1", "exec_command", { cmd: "echo hello" }, "hello\n");
		await observerCall(
			sid,
			"c2",
			"shell",
			{ command: ["bash", "-lc", "bun test"] },
			JSON.stringify({ output: "4 pass\n0 fail", metadata: { exit_code: 0 } }),
		);
		await observerCall(
			sid,
			"c3",
			"shell",
			{
				command: [
					"apply_patch",
					"*** Begin Patch\n*** Add File: src/x.ts\n+SECRET-BODY\n*** End Patch",
				],
			},
			"Done",
		);
		await observerCall(sid, "c4", "exec_command", { cmd: "cat .env" }, "TOKEN=fake");
		await observerCall(
			sid,
			"c5",
			"exec_command",
			{ cmd: "rm -rf build" },
			JSON.stringify({ output: "rm: denied", metadata: { exit_code: 1 } }),
			"unknown_tool",
		);
		const bundle = await loadEvidence(sid);
		const ledger = buildLedger(bundle);
		expect(bodies(ledger.text)).toEqual([
			"OBSERVED command `echo hello` -> completed",
			'OBSERVED command [validation] `["bash","-lc","bun test"]` -> ok: "4 pass"',
			'OBSERVED edit "src/x.ts"',
			"OBSERVED command [withheld: reads credentials] -> completed",
			'OBSERVED command `rm -rf build` -> FAILED: "rm: denied"',
		]);
		expect(ledger.text).not.toContain("SECRET-BODY");
		expect(bundle.agentType).toBe("codex_cli");
		expect(
			bundle.diagnostics.jobs,
			"bounds, one chunk, first prompts: no extra statement for the pairing",
		).toBe(3);
	}, 60_000);

	test("parallel calls pair by tool_use_id, not by position", async () => {
		const sid = sessionIdFor("observer-par");
		createdSessions.push(sid);
		await postObserver(sid, "PreToolUse", "a", {
			tool_name: "exec_command",
			tool_input: { cmd: "echo AAA" },
		});
		await postObserver(sid, "PreToolUse", "b", {
			tool_name: "exec_command",
			tool_input: { cmd: "echo BBB" },
		});
		await postObserver(sid, "PostToolUse", "b", {
			tool_name: "exec_command",
			tool_response: "BBB",
		});
		await postObserver(sid, "PostToolUse", "a", {
			tool_name: "exec_command",
			tool_response: "AAA",
		});
		const ledger = buildLedger(await loadEvidence(sid));
		expect(bodies(ledger.text)).toEqual([
			"OBSERVED command `echo BBB` -> completed",
			"OBSERVED command `echo AAA` -> completed",
		]);
	}, 60_000);

	test("a Post with no Pre in the window is [not shown] (a shell name) or name and status (unknown_tool)", async () => {
		const sid = sessionIdFor("observer-lost");
		createdSessions.push(sid);
		await postObserver(sid, "PostToolUse", "lost1", {
			tool_name: "exec_command",
			tool_response: "x",
		});
		await postObserver(sid, "PostToolUse", "lost2", {
			tool_name: "unknown_tool",
			tool_response: "y",
		});
		const ledger = buildLedger(await loadEvidence(sid));
		expect(bodies(ledger.text)).toEqual([
			"OBSERVED command [not shown] -> completed",
			"OBSERVED tool unknown_tool -> completed",
		]);
	}, 60_000);

	test("the window is 200 ids: a Pre 150 events before is found, one 250 events before is not", async () => {
		const sid = sessionIdFor("observer-window");
		createdSessions.push(sid);
		await postObserver(sid, "PreToolUse", "near", {
			tool_name: "exec_command",
			tool_input: { cmd: "echo NEAR" },
		});
		await postObserver(sid, "PreToolUse", "far", {
			tool_name: "exec_command",
			tool_input: { cmd: "echo FAR" },
		});
		await seed(
			Array.from({ length: 150 }, () =>
				ev(sid, { eventType: "SessionStart", category: "system_event" }),
			).map((r) => ({ ...r, sessionId: sid })),
		);
		await postObserver(sid, "PostToolUse", "near", {
			tool_name: "exec_command",
			tool_response: "NEAR",
		});
		await seed(
			Array.from({ length: 100 }, () =>
				ev(sid, { eventType: "SessionStart", category: "system_event" }),
			),
		);
		await postObserver(sid, "PostToolUse", "far", {
			tool_name: "exec_command",
			tool_response: "FAR",
		});
		const ledger = buildLedger(await loadEvidence(sid));
		expect(bodies(ledger.text)).toEqual([
			"OBSERVED command `echo NEAR` -> completed",
			"OBSERVED command [not shown] -> completed",
		]);
	}, 60_000);

	test("a Claude Post row that has its own input is never paired", async () => {
		const sid = await newSession("nopair");
		await seed([
			ev(sid, {
				eventType: "PreToolUse",
				category: "tool_event",
				toolName: "Bash",
				toolInput: { command: "echo PRE" },
				rawPayload: { tool_use_id: "z" },
			}),
			bashEv(sid, "echo POST", { rawPayload: { tool_use_id: "z" } }),
		]);
		const { statements, result } = await capture(() => loadEvidence(sid));
		expect(buildLedger(result).text).toContain("echo POST");
		expect(buildLedger(result).text).not.toContain("echo PRE");
		expect(statements.length).toBe(3);
	});
});

describe("P3-35 the pairing statement on a Codex-observer fixture, on this dialect", () => {
	test("plan and rows: the probe rides the session index inside the id window; 1,500 calls", async () => {
		const sid = await newSession("observer-1500", "codex_cli");
		const rows: Seed[] = [promptEv(sid, "observer session")];
		for (let i = 0; i < 1500; i++) {
			rows.push(
				ev(sid, {
					eventType: "PreToolUse",
					category: "tool_event",
					toolName: "exec_command",
					toolInput: { cmd: `echo ${i}` },
					rawPayload: { tool_use_id: `call-${i}` },
				}),
				ev(sid, {
					eventType: "PostToolUse",
					category: "tool_event",
					toolName: "exec_command",
					toolResponse: `${i}\n`,
					rawPayload: { tool_use_id: `call-${i}`, tool_response: `${i}\n` },
				}),
			);
		}
		await seed(rows);
		const { result, statements } = await capture(() => loadEvidence(sid));
		const chunk = statements.find((s) => /ROW_NUMBER/i.test(s.text)) as Captured;
		const plan = isPg
			? (
					await executeRows<Record<string, string>>(
						getDb(),
						sql`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${chunk.query}`,
					)
				).map((r) => String(r["QUERY PLAN"]))
			: (
					await executeRows<{ detail: string }>(getDb(), sql`EXPLAIN QUERY PLAN ${chunk.query}`)
				).map((r) => r.detail);
		const eventScans = plan.filter((l) => /events|\bpre\b/.test(l) && /(Scan|SEARCH|SCAN)/.test(l));
		console.log(`[pair-plan] ${config.dialect}: ${eventScans.map((l) => l.trim()).join(" | ")}`);
		const rowsLines = plan.filter((l) => /rows=\d+/.test(l) && /Scan/.test(l) && /events/.test(l));
		console.log(
			`[pair-rows] ${config.dialect}: ${rowsLines.map((l) => l.trim().slice(0, 140)).join(" | ")}`,
		);
		if (isPg) expect(pgEventsPlanViolations(plan), plan.join("\n")).toEqual([]);
		else expect(sqliteEventsPlanViolations(plan), plan.join(" | ")).toEqual([]);
		const withCommand = result.rows.filter((r) => r.command?.startsWith("echo "));
		expect(withCommand).toHaveLength(350);
		expect(
			result.diagnostics.statements.find((s) => s.kind === "chunk")?.elapsedMs,
		).toBeGreaterThan(0);
		perf("P3-35 pairing 350 candidates", {
			chunkMs: Number(
				(result.diagnostics.statements.find((s) => s.kind === "chunk")?.elapsedMs ?? -1).toFixed(1),
			),
			windowIds: limits.PAIR_WINDOW_IDS,
		});
	}, 240_000);
});

describe("P3-10 JSON-shaped responses and the Claude failure shapes", () => {
	test("a Bash response stored as a JSON object: pass, fail and exit-masked, on real lines", async () => {
		const sid = await newSession("jsonresp");
		const obj = (stdout: string, stderr = "") =>
			JSON.stringify({ stdout, stderr, interrupted: false, isImage: false });
		const ids = await seedIds([
			promptEv(sid, "go"),
			bashEv(sid, "bun test", { toolResponse: obj("ok  pkg 0.1s\n 4 pass\n 0 fail") }),
			bashEv(sid, "bun test", { toolResponse: obj("ok line\nFAIL src/a.test.ts\nmore") }),
			bashEv(sid, "bun test | tail -5", { toolResponse: obj(" 4 pass") }),
			bashEv(sid, "bun test", { toolResponse: obj("compiled", "\nerror: boom") }),
		]);
		const ledger = buildLedger(await loadEvidence(sid));
		const line = (n: number) => lines(ledger.text).find((l) => l.startsWith(`E${ids[n]} `)) ?? "";
		expect(line(1), "the first line a pass pattern matched").toMatch(/-> ok: "ok {2}pkg 0\.1s"$/);
		expect(line(2)).toMatch(/-> FAILED: "ok line FAIL src\/a\.test\.ts more"$/);
		expect(line(3)).toMatch(/-> unknown$/);
		expect(line(4)).toMatch(/-> FAILED/);
	});
	test("a Claude PostToolUseFailure whose text is under `error` (no tool_response) is read from there", async () => {
		const sid = sessionIdFor("claude-fail");
		createdSessions.push(sid);
		await post("claude_code", {
			session_id: sid,
			cwd: "/w",
			hook_event_name: "UserPromptSubmit",
			prompt: "go",
		});
		await post("claude_code", {
			session_id: sid,
			cwd: "/w",
			hook_event_name: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "rm -rf build" },
			tool_use_id: "f1",
			error: "Exit code 1\nrm: cannot remove build: Permission denied",
			is_interrupt: false,
		});
		const bundle = await loadEvidence(sid);
		const ledger = buildLedger(bundle);
		expect(bodies(ledger.text).at(-1)).toMatch(
			/^OBSERVED command `rm -rf build` -> FAILED: ".*Permission denied"$/,
		);
	});
});

describe("P3-14 / P3-17 robustness and rejection", () => {
	test("a tool_input nested far beyond a sane depth, or holding a NUL escape, cannot make the session unsummarisable", async () => {
		const sid = await newSession("deep");
		const depth = 100_000;
		let insertedDeep = true;
		try {
			await getDb()
				.insert(events)
				.values(
					toolEv(
						sid,
						"Bash",
						`${"[".repeat(depth)}${"]".repeat(depth)}` as unknown as Seed["toolInput"],
					),
				);
		} catch {
			insertedDeep = false;
		}
		await seed([promptEv(sid, "go"), bashEv(sid, "echo healthy"), bashEv(sid, "echo \u0000 nul")]);
		const result = await loadEvidence(sid);
		const ledger = buildLedger(result);
		console.log(`[p3-14] ${config.dialect}: deeply nested tool_input stored: ${insertedDeep}`);
		expect(ledger.text).toContain("`echo healthy`");
		expect(result.rows.length).toBeGreaterThanOrEqual(2);
	}, 120_000);

	test("a statement that throws is retried without reading tool_input: the rows become [not shown], the session still loads", async () => {
		const sid = await newSession("throwing");
		await seed([promptEv(sid, "go"), bashEv(sid, "echo one"), bashEv(sid, "echo two")]);
		const db = getDb() as unknown as Record<string, (...a: unknown[]) => unknown>;
		const method = isPg ? "execute" : "all";
		const original = (db[method] as (...a: unknown[]) => unknown).bind(db);
		const spy = spyOn(db, method).mockImplementation((query: unknown, ...rest: unknown[]) => {
			if (render(query as SQL).text.includes("tool_input"))
				throw new Error("boom: SECRET-SQL-TEXT");
			return original(query, ...rest);
		});
		try {
			const result = await loadEvidence(sid);
			const ledger = buildLedger(result);
			expect(bodies(ledger.text)).toEqual([
				'CLAIMED user prompt: "go"',
				"OBSERVED command [not shown] -> ok",
				"OBSERVED command [not shown] -> ok",
			]);
		} finally {
			spy.mockRestore();
		}
	});

	test("an error that cannot be recovered carries a code and no SQL text", async () => {
		const sid = await newSession("broken");
		await seed([promptEv(sid, "go")]);
		const db = getDb() as unknown as Record<string, (...a: unknown[]) => unknown>;
		const method = isPg ? "execute" : "all";
		const spy = spyOn(db, method).mockImplementation(() => {
			throw new Error("Failed query: SELECT SECRET-SQL-TEXT FROM events");
		});
		try {
			const error = await loadEvidence(sid).then(
				() => null,
				(e: unknown) => e as Error & { code?: string },
			);
			expect(error).not.toBeNull();
			expect(error?.code).toBe("evidence_read_failed");
			expect(String(error?.message)).not.toContain("SECRET-SQL-TEXT");
			expect(String(error?.message)).not.toMatch(/SELECT|FROM/);
			expect("cause" in (error as object) && (error as { cause?: unknown }).cause).toBeFalsy();
		} finally {
			spy.mockRestore();
		}
	});

	test("P3-17 a busy own-turn queue rejects with OwnTurnBusyError, unchanged; loadEvidence is never called from inside an own-turn job", async () => {
		const sid = await newSession("busy");
		await seed([promptEv(sid, "go")]);
		const spy = spyOn(ownTurn, "runInOwnTurn").mockRejectedValue(new OwnTurnBusyError());
		try {
			await expect(loadEvidence(sid)).rejects.toBeInstanceOf(OwnTurnBusyError);
		} finally {
			spy.mockRestore();
		}
		const source = await Bun.file(
			fileURLToPath(new URL("./evidence-loader.ts", import.meta.url)),
		).text();
		expect(source).toMatch(/never be called from inside a `runInOwnTurn` job/);
	});
});

describe("P3-16 stop-rule boundaries", () => {
	for (const total of [limits.CHUNK_SIZE + 1, 2 * limits.CHUNK_SIZE + 1]) {
		test(`a session of exactly ${total} events whose first event is an Edit reaches it`, async () => {
			const sid = await newSession(`edge${total}`);
			const rows: Seed[] = [
				toolEv(sid, "Edit", { file_path: "src/FIRST-EDIT.ts" }, { isNoise: true }),
			];
			for (let i = 1; i < total; i++) rows.push(readEv(sid));
			await seed(rows);
			const result = await loadEvidence(sid);
			expect(result.scan.eventsTotal).toBe(total);
			expect(result.scan.reachedFirstEvent).toBe(true);
			expect(result.diagnostics.chunks).toBe(Math.ceil(total / limits.CHUNK_SIZE));
			expect(buildLedger(result).text).toContain('OBSERVED edit "src/FIRST-EDIT.ts"');
			expect(buildLedger(result).coverage.cutoffAt).toBeNull();
		}, 120_000);
	}
});

describe("P3-26 a first prompt of about 4,100 characters", () => {
	test("through SQL it reaches the ledger as 4,000 characters and an ellipsis", async () => {
		const sid = await newSession("longfirst");
		await seed([promptEv(sid, `${"f".repeat(4100)}`), promptEv(sid, "second")]);
		const ledger = buildLedger(await loadEvidence(sid));
		const first = lines(ledger.text)[0] ?? "";
		const quoted = first.slice(first.indexOf('"') + 1, first.lastIndexOf('"'));
		expect(Array.from(quoted)).toHaveLength(4001);
		expect(quoted.endsWith("…")).toBe(true);
	});
});

describe("P3-34 an un-vacuumed table with a dense session", () => {
	test("the statement is bounded by the session's id range; the plan is recorded, the index is not asserted", async () => {
		const sid = await newSession("dense");
		await seed(
			Array.from({ length: 12_000 }, (_, i) =>
				i % 15 === 0 ? bashEv(sid, `echo ${i}`) : readEv(sid),
			),
		);
		const { statements, result } = await capture(() => loadEvidence(sid));
		const chunk = statements.find((s) => /ROW_NUMBER/i.test(s.text)) as Captured;
		const plan = isPg
			? (await executeRows<Record<string, string>>(getDb(), sql`EXPLAIN ${chunk.query}`)).map((r) =>
					String(r["QUERY PLAN"]),
				)
			: (
					await executeRows<{ detail: string }>(getDb(), sql`EXPLAIN QUERY PLAN ${chunk.query}`)
				).map((r) => r.detail);
		console.log(
			`[plans] ${config.dialect} un-vacuumed dense session: ${plan.map((l) => l.trim()).join(" | ")}`,
		);
		const joined = plan.join("\n");
		if (isPg) {
			expect(joined).not.toMatch(/Seq Scan on events/);
			expect(joined, "an id range on the scan of the ids").toMatch(/id >= .*id <= |id <= .*id >= /);
		} else {
			expect(plan.some((l) => RANGE_RE.test(l))).toBe(true);
			expect(joined).not.toMatch(/SCAN (events|e)\b/);
		}
		expect(result.scan.reachedFirstEvent).toBe(true);
	}, 120_000);
});

describe("the bundle exposes prompt text longer than the ledger's cap (phase 4's URL extraction)", () => {
	test("a 3,000-character prompt is 1,756 characters in the bundle and 1,500 plus an ellipsis in the ledger; the row is not mutated", async () => {
		const sid = await newSession("rawprompt");
		await seed([
			promptEv(sid, "first"),
			promptEv(sid, "second"),
			promptEv(sid, "third"),
			promptEv(sid, `${"u".repeat(2000)} https://example.com/typed ${"v".repeat(1000)}`),
		]);
		const bundle = await loadEvidence(sid);
		const row = bundle.rows.find((r) => r.content?.startsWith("uuuu"));
		expect(Array.from(row?.content ?? "")).toHaveLength(1756);
		const ledger = buildLedger(bundle);
		expect(Array.from(quotedOfLine(ledger.text, 4))).toHaveLength(1501);
		expect(Array.from(row?.content ?? "")).toHaveLength(1756);
	});
});
function quotedOfLine(text: string, n: number): string {
	const line = lines(text)[n - 1] ?? "";
	return line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));
}
