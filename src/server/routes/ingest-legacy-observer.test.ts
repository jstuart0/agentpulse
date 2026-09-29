// Phase 7 (AGEN-16): the legacy-observer branch (mozart D14) — a
// pre-upgrade codex-observer post (codex_cli, no origin header, no
// transcript_path) keeps today's content window and is never keyed, but
// still broadcasts exactly its stored rows. F57-1 pins that observer
// copies are never suppressed by native activity (no shadowing, D11).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { ingest } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { handleWsOpen, handleWsClose } = await import("../ws/handler.js");
const { _resetEventDedupForTest } = await import("../services/event-dedup.js");
const { ORIGIN_HEADER, ORIGIN_CODEX_OBSERVER, DELIVERY_ID_HEADER } = await import(
	"../../shared/hook-headers.js"
);

const originalDisableAuth = config.disableAuth;

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", ingest);
	return app;
}
const app = buildApp();

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

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function rowsFor(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

async function postCodex(
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
): Promise<Response> {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Agent-Type": "codex_cli", ...headers },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await until(() => getInFlightCount() === 0, 10_000);
	return res;
}

type WsMsg = { type: string; data: Record<string, unknown> };
function attachFakeWs(): { messages: WsMsg[]; close: () => void } {
	const messages: WsMsg[] = [];
	const ws = {
		send: (raw: string) => {
			messages.push(JSON.parse(raw));
		},
	} as unknown as ServerWebSocket<unknown>;
	handleWsOpen(ws);
	return { messages, close: () => handleWsClose(ws) };
}

const FIXTURE_DIR = join(
	import.meta.dir,
	"..",
	"services",
	"__fixtures__",
	"event-dedup",
	"codex-0.145",
);
function loadFixture(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

describe("L-obs1: a pre-upgrade observer keeps today's content window", () => {
	test("two identical Stops -> 1 row, every stored row has dedup_key IS NULL", async () => {
		const sid = newSessionId("lobs1");
		await postCodex({ session_id: sid, hook_event_name: "Stop" });
		await postCodex({ session_id: sid, hook_event_name: "Stop" });

		const rows = await rowsFor(sid);
		expect(rows).toHaveLength(1);
		for (const row of rows) expect(row.dedupKey).toBeNull();
	});
});

describe("L-obs2: native Codex payloads use exact identity", () => {
	test("the vendored native Stop fixture verbatim, posted twice with distinct delivery ids -> 2 rows", async () => {
		const sid = newSessionId("lobs2");
		const fixture = loadFixture("Stop");
		expect(fixture.transcript_path).toBeTruthy();

		await postCodex({ ...fixture, session_id: sid }, { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" });
		await postCodex({ ...fixture, session_id: sid }, { [DELIVERY_ID_HEADER]: "d2-aaaaaaaa" });

		const rows = await rowsFor(sid);
		expect(rows.filter((r) => r.eventType === "Stop")).toHaveLength(2);
	});
});

describe("L-obs3: the legacy branch still broadcasts exactly its stored rows", () => {
	test("L-obs1's sequence broadcasts exactly 1 new_event, whose id is the stored row's id", async () => {
		const ws = attachFakeWs();
		const sid = newSessionId("lobs3");
		await postCodex({ session_id: sid, hook_event_name: "Stop" });
		await postCodex({ session_id: sid, hook_event_name: "Stop" });

		const rows = await rowsFor(sid);
		const stopBroadcasts = ws.messages.filter(
			(m) => m.type === "new_event" && m.data.sessionId === sid,
		);
		expect(stopBroadcasts).toHaveLength(1);
		const stopRow = rows.find((r) => r.eventType === "Stop");
		expect(stopBroadcasts[0]?.data.id).toBe(stopRow?.id);
		expect(Number(stopBroadcasts[0]?.data.id)).toBeGreaterThan(0);
		ws.close();
	});
});

test("F57-1: observer copies are never suppressed by native activity", async () => {
	const sid = newSessionId("f57-1");
	const nativePrompt = loadFixture("UserPromptSubmit");
	await postCodex({ ...nativePrompt, session_id: sid });

	const observerHeaders = { [ORIGIN_HEADER]: ORIGIN_CODEX_OBSERVER };
	await postCodex(
		{
			session_id: sid,
			hook_event_name: "PreToolUse",
			tool_name: "exec_command",
			tool_use_id: "call_observer_1",
		},
		observerHeaders,
	);
	await postCodex(
		{
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "exec_command",
			tool_use_id: "call_observer_1",
		},
		observerHeaders,
	);
	await postCodex(
		{ session_id: sid, hook_event_name: "Stop", last_assistant_message: "observer done" },
		observerHeaders,
	);

	const rows = await rowsFor(sid);
	// native UserPromptSubmit(1) + observer Pre(1) + Post(1) + Stop+Assistant(2) = 5.
	expect(rows.length).toBeGreaterThanOrEqual(4);
	expect(rows.some((r) => r.eventType === "UserPromptSubmit")).toBe(true);
	expect(rows.some((r) => r.eventType === "PreToolUse")).toBe(true);
	expect(rows.some((r) => r.eventType === "PostToolUse")).toBe(true);
	expect(rows.some((r) => r.eventType === "Stop")).toBe(true);
});
