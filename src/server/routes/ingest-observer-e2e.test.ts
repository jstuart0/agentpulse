// Phase 7 (AGEN-16): the real observer <-> server seam. fetchImpl wires
// codex-observer's processRolloutFile straight into app.fetch — neither
// side is stubbed. Every test uses a fresh session_meta id (the fixture's
// placeholder UUID rewritten) and a fresh tmp homeDir (harness rule 8), so
// isNativeCovered's process-wide positive cache can never leak between
// tests, and mkTmp gives per-test filesystem isolation for the native
// marker directory.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { ingest } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { _resetEventDedupForTest, getEventsDeduplicatedCounts } = await import(
	"../services/event-dedup.js"
);
const { processRolloutFile, codexNativeMarkerPath } = await import(
	"../../supervisor/services/codex-observer.js"
);

const originalDisableAuth = config.disableAuth;

const app = new Hono();
app.route("/api/v1", ingest);
const fetchImpl = async (url: string | URL | Request, init?: RequestInit) =>
	app.fetch(new Request(url, init));

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
beforeEach(() => {
	_resetBucketsForTest();
	_resetCountersForTest();
	_resetEventDedupForTest();
});

// Requires the condition to hold for 2 consecutive checks (a stable read,
// not a single-shot one) before returning. A single-shot check can return
// true on a transient scheduling artifact under load (observed on Postgres:
// getInFlightCount() reads 0 between two legitimately in-flight ticks), one
// tick before the condition would flip back — see F113/host-load note.
async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let stableHits = 0;
	while (stableHits < 2) {
		if (cond()) {
			stableHits++;
		} else {
			stableHits = 0;
		}
		if (stableHits >= 2) return;
		if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function rowsFor(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

const FIXTURE_PATH = join(
	import.meta.dir,
	"..",
	"..",
	"supervisor",
	"services",
	"__fixtures__",
	"codex-rollout-0.145",
	"rollout-sanitized.jsonl",
);
const FIXTURE_RAW = readFileSync(FIXTURE_PATH, "utf8");
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

function fixtureWithSessionId(sessionId: string): string {
	return FIXTURE_RAW.replaceAll(PLACEHOLDER_ID, sessionId);
}

function writeFixtureCopy(
	dir: string,
	sessionId: string = crypto.randomUUID(),
): { path: string; sessionId: string } {
	const path = join(dir, "rollout.jsonl");
	writeFileSync(path, fixtureWithSessionId(sessionId));
	return { path, sessionId };
}

function splitFixture(sessionId: string): [string, string] {
	const full = fixtureWithSessionId(sessionId);
	const lines = full.split("\n").filter((l) => l.length > 0);
	const splitIdx = lines.findIndex(
		(l) => l.includes('"call_id":"call_0001example"') && l.includes('"type":"function_call"'),
	);
	const part1 = `${lines.slice(0, splitIdx + 1).join("\n")}\n`;
	const part2 = `${lines.slice(splitIdx + 1).join("\n")}\n`;
	return [part1, part2];
}

async function runToCompletion(dir: string, sessionId: string) {
	const { path } = writeFixtureCopy(dir, sessionId);
	const state = await processRolloutFile(
		path,
		undefined,
		"http://x",
		null,
		new Map(),
		fetchImpl,
		dir,
	);
	await until(() => getInFlightCount() === 0, 10_000);
	return state;
}

describe("E1(a): observer output is stored once, keyed", () => {
	test("SessionStart, 1 prompt, a Pre/Post per exec_command call, Stop+AssistantMessage — every row keyed", async () => {
		const dir = mkTmp("ap-e1a-");
		const sessionId = crypto.randomUUID();
		await runToCompletion(dir, sessionId);

		const rows = await rowsFor(sessionId);
		expect(
			rows.filter((r) => r.eventType === "SessionStart"),
			JSON.stringify(rows),
		).toHaveLength(1);
		expect(
			rows.filter((r) => r.eventType === "UserPromptSubmit"),
			JSON.stringify(rows),
		).toHaveLength(1);
		const preRows = rows.filter((r) => r.eventType === "PreToolUse");
		const postRows = rows.filter((r) => r.eventType === "PostToolUse");
		expect(preRows.length).toBeGreaterThanOrEqual(2);
		expect(preRows.length).toBe(postRows.length);
		for (const row of preRows) {
			const toolUseId = (row.rawPayload as Record<string, unknown> | null)?.tool_use_id;
			expect(typeof toolUseId).toBe("string");
			expect(String(toolUseId).startsWith("call_")).toBe(true);
		}
		expect(
			rows.filter((r) => r.eventType === "Stop"),
			JSON.stringify(rows),
		).toHaveLength(1);
		expect(
			rows.filter((r) => r.category === "assistant_message"),
			JSON.stringify(rows),
		).toHaveLength(1);

		for (const row of rows) {
			expect(row.dedupKey, JSON.stringify(row)).toMatch(/^[dt]:[0-9a-f]{32}$/);
		}
	});
});

test("E1(b): a state-loss replay stores nothing", async () => {
	const dir = mkTmp("ap-e1b-");
	const sessionId = crypto.randomUUID();
	await runToCompletion(dir, sessionId);
	const before = await rowsFor(sessionId);
	const beforeCounts = getEventsDeduplicatedCounts();

	// Rerun from undefined state — as if the observer's state file was lost.
	const { path } = writeFixtureCopy(dir, sessionId);
	// The fixture copy is written fresh each call, but writeFixtureCopy
	// creates a NEW random filename target only if the caller asks — reuse
	// the same on-disk file path this session already used.
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fetchImpl, dir);
	await until(() => getInFlightCount() === 0, 10_000);

	const after = await rowsFor(sessionId);
	expect(after.length, JSON.stringify({ before, after })).toBe(before.length);
	const afterCounts = getEventsDeduplicatedCounts();
	const retryDelta =
		afterCounts.deliveryRetry -
		beforeCounts.deliveryRetry +
		(afterCounts.toolUseRetry - beforeCounts.toolUseRetry);
	expect(retryDelta).toBe(before.length);
});

test("E1(c): without a marker, native and observer copies are both kept", async () => {
	const dir = mkTmp("ap-e1c-");
	const sessionId = crypto.randomUUID();
	const state = await runToCompletion(dir, sessionId);

	// Post the native Codex PreToolUse fixture (same session_id, with
	// transcript_path) directly, as a genuine native hook would.
	const { readFileSync: read } = await import("node:fs");
	const nativeFixturePath = join(
		import.meta.dir,
		"..",
		"services",
		"__fixtures__",
		"event-dedup",
		"codex-0.145",
		"PreToolUse.json",
	);
	const nativeFixture = JSON.parse(read(nativeFixturePath, "utf8"));
	const res = await fetchImpl("http://x/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Agent-Type": "codex_cli" },
		body: JSON.stringify({ ...nativeFixture, session_id: sessionId }),
	});
	expect(res.status).toBe(200);
	await until(() => getInFlightCount() === 0, 10_000);

	const beforeAppend = await rowsFor(sessionId);
	const beforeCounts = getEventsDeduplicatedCounts();

	// Append one more function_call to the rollout and rerun from saved state.
	const extraCallLine = `${JSON.stringify({
		type: "response_item",
		payload: {
			type: "function_call",
			call_id: "call_0099example",
			name: "exec_command",
			arguments: "{}",
		},
	})}\n${JSON.stringify({
		type: "response_item",
		payload: { call_id: "call_0099example", type: "function_call_output", output: "ok" },
	})}\n`;
	const { appendFileSync } = await import("node:fs");
	const { path } = { path: join(dir, "rollout.jsonl") };
	appendFileSync(path, extraCallLine);
	await processRolloutFile(path, state, "http://x", null, new Map(), fetchImpl, dir);
	await until(() => getInFlightCount() === 0, 10_000);

	const afterAppend = await rowsFor(sessionId);
	expect(afterAppend.length).toBeGreaterThan(beforeAppend.length);
	const nativePre = afterAppend.filter(
		(r) =>
			r.eventType === "PreToolUse" &&
			(r.rawPayload as Record<string, unknown> | null)?.transcript_path,
	);
	expect(nativePre.length).toBeGreaterThanOrEqual(1);
	const afterCounts = getEventsDeduplicatedCounts();
	expect(afterCounts.deliveryRetry).toBe(beforeCounts.deliveryRetry);
	expect(afterCounts.toolUseRetry).toBe(beforeCounts.toolUseRetry);
});

test("E1(d): with a marker, only the native copy is stored", async () => {
	const dir = mkTmp("ap-e1d-");
	const sessionId = crypto.randomUUID();
	const state = await runToCompletion(dir, sessionId);
	const beforeRows = await rowsFor(sessionId);

	const { mkdirSync, writeFileSync: write } = await import("node:fs");
	const markerPath = codexNativeMarkerPath(dir, sessionId);
	mkdirSync(join(dir, ".agentpulse", "codex-native"), { recursive: true });
	write(markerPath, "");

	const extraCallLine = `${JSON.stringify({
		type: "response_item",
		payload: {
			type: "function_call",
			call_id: "call_0098example",
			name: "exec_command",
			arguments: "{}",
		},
	})}\n${JSON.stringify({
		type: "response_item",
		payload: { call_id: "call_0098example", type: "function_call_output", output: "ok" },
	})}\n`;
	const { appendFileSync } = await import("node:fs");
	const path = join(dir, "rollout.jsonl");
	appendFileSync(path, extraCallLine);
	await processRolloutFile(path, state, "http://x", null, new Map(), fetchImpl, dir);
	await until(() => getInFlightCount() === 0, 10_000);

	const afterRows = await rowsFor(sessionId);
	expect(afterRows.length).toBe(beforeRows.length);

	// The native PreToolUse posted next is still stored normally.
	const { readFileSync: read } = await import("node:fs");
	const nativeFixturePath = join(
		import.meta.dir,
		"..",
		"services",
		"__fixtures__",
		"event-dedup",
		"codex-0.145",
		"PreToolUse.json",
	);
	const nativeFixture = JSON.parse(read(nativeFixturePath, "utf8"));
	await fetchImpl("http://x/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Agent-Type": "codex_cli" },
		body: JSON.stringify({ ...nativeFixture, session_id: sessionId }),
	});
	await until(() => getInFlightCount() === 0, 10_000);
	const finalRows = await rowsFor(sessionId);
	expect(finalRows.length).toBeGreaterThan(afterRows.length);
});

test("E1-split: a restart mid-turn plus a later replay stores nothing new", async () => {
	const dir = mkTmp("ap-e1split-");
	const sessionId = crypto.randomUUID();
	const [part1, part2] = splitFixture(sessionId);
	const path = join(dir, "rollout.jsonl");

	const { writeFileSync: write, appendFileSync } = await import("node:fs");
	write(path, part1);
	const midState = await processRolloutFile(
		path,
		undefined,
		"http://x",
		null,
		new Map(),
		fetchImpl,
		dir,
	);
	await until(() => getInFlightCount() === 0, 10_000);

	appendFileSync(path, part2);
	// A restart: a brand new callMap, simulating a fresh observer process.
	await processRolloutFile(path, midState, "http://x", null, new Map(), fetchImpl, dir);
	await until(() => getInFlightCount() === 0, 10_000);

	const rowCount = (await rowsFor(sessionId)).length;

	// Reset state and replay the whole file from offset 0, again with a
	// fresh callMap.
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fetchImpl, dir);
	await until(() => getInFlightCount() === 0, 10_000);

	const finalRowCount = (await rowsFor(sessionId)).length;
	expect(finalRowCount).toBe(rowCount);
});
