// Phase 7 (AGEN-16): native Codex hooks are never mistaken for a legacy
// observer (NATIVE1, F67), and legacy-observer-shaped deliveries are
// counted and warned once (LEG1, F66). Re-run unchanged post-merge as
// E3-canon once the sibling's canonicalizeHookPayload sits in front of
// processHookEvent — the transcript_path field must survive that too.

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const { _resetEventDedupForTest, getEventsDeduplicatedCounts, getLegacyObserverDeliveries } =
	await import("../services/event-dedup.js");

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

describe("NATIVE1: native Codex hooks are never mistaken for a legacy observer", () => {
	test("each vendored fixture posted verbatim (session_id overridden) is never counted as legacy", async () => {
		const sid = newSessionId("native1");
		const before = getLegacyObserverDeliveries();

		for (const name of ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "SessionEnd"]) {
			const fixture = loadFixture(name);
			await postCodex({ ...fixture, session_id: sid });
		}

		expect(getLegacyObserverDeliveries() - before).toBe(0);

		const rows = await rowsFor(sid);
		const toolRows = rows.filter(
			(r) => r.eventType === "PreToolUse" || r.eventType === "PostToolUse",
		);
		expect(toolRows.length).toBeGreaterThanOrEqual(2);
		for (const row of toolRows) {
			expect(row.dedupKey, JSON.stringify(row)).toMatch(/^t:[0-9a-f]{32}$/);
		}
	});

	test("posting the PostToolUse fixture again stores no new row, toolUseRetry +1", async () => {
		const sid = newSessionId("native1-retry");
		const fixture = loadFixture("PostToolUse");
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		await postCodex({ ...fixture, session_id: sid });
		await postCodex({ ...fixture, session_id: sid });
		const rows = await rowsFor(sid);
		expect(rows.filter((r) => r.eventType === "PostToolUse")).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
	});
});

describe("LEG1: legacy observers are counted and warned once", () => {
	test("two legacy-shaped posts -> legacyObserverDeliveries +2, exactly one warn", async () => {
		const sid = newSessionId("leg1");
		const before = getLegacyObserverDeliveries();
		const warnSpy = spyOn(console, "warn");
		warnSpy.mockClear();

		// Legacy-observer shape: codex_cli, no origin header, no transcript_path.
		await postCodex({ session_id: sid, hook_event_name: "Stop", last_assistant_message: "done" });
		await postCodex({ session_id: sid, hook_event_name: "Stop", last_assistant_message: "done" });

		expect(getLegacyObserverDeliveries() - before).toBe(2);

		const legacyWarns = warnSpy.mock.calls.filter((call) => {
			const arg = call[0];
			return typeof arg === "string" && arg.includes("legacy_codex_observer");
		});
		expect(legacyWarns).toHaveLength(1);
		// Static line: no identifiers (session_id or body fields) in the warning.
		expect(String(legacyWarns[0]?.[0])).not.toContain(sid);

		warnSpy.mockRestore();
	});
});
