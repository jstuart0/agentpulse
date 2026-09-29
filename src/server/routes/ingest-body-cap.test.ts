// D16 (F116): cap /api/v1/hooks and /api/v1/hooks/status bodies at 16 MiB
// without breaking the always-200 post-auth contract. An oversize body is
// dropped before JSON.parse ever runs (never a 413), counted via a new
// /health field (oversizeDropped, same shape as rateLimitedDropped).

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { ingest, MAX_HOOK_BODY_BYTES } = await import("./ingest.js");
const { health, _resetDbReadyForTest } = await import("./health.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount, getOversizeDropped } = await import(
	"./ingest-counters.js"
);

const originalDisableAuth = config.disableAuth;

function buildApp() {
	const app = new Hono();
	app.route("/api/v1", ingest);
	app.route("/api/v1", health);
	return app;
}
const app = buildApp();

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
	_resetDbReadyForTest(true);
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
	_resetDbReadyForTest(false);
});
beforeEach(() => {
	_resetBucketsForTest();
	_resetCountersForTest();
});

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

async function mkSession(sessionId: string, extra: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			metadata: {},
			...extra,
		})
		.execute();
}

async function rowsFor(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

// A readable stream that generates chunks lazily (never fully materialized
// in memory up front), so a streaming-path test actually exercises the
// running-total abort rather than a body that was already fully buffered
// by the time the Request object was constructed.
function lazyOversizeStream(totalBytes: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= totalBytes) {
				controller.close();
				return;
			}
			const size = Math.min(chunkSize, totalBytes - sent);
			controller.enqueue(new Uint8Array(size).fill(120)); // 'x'
			sent += size;
		},
	});
}

describe("D16: MAX_HOOK_BODY_BYTES is 16 MiB", () => {
	test("constant value", () => {
		expect(MAX_HOOK_BODY_BYTES).toBe(16 * 1024 * 1024);
	});
});

describe("D16: POST /api/v1/hooks — oversize body", () => {
	test("a 17 MiB body: 200, not stored, oversizeDropped +1, JSON.parse never called", async () => {
		const sid = newSessionId("d16-over");
		const padding = "x".repeat(17 * 1024 * 1024);
		const body = JSON.stringify({
			session_id: sid,
			hook_event_name: "Stop",
			cwd: padding,
		});
		expect(body.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		const parseSpy = spyOn(JSON, "parse");
		let res: Response;
		try {
			res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
		} finally {
			expect(parseSpy).not.toHaveBeenCalled();
			parseSpy.mockRestore();
		}

		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json.ok).toBe(true);
		expect(getOversizeDropped() - before).toBe(1);

		await until(() => getInFlightCount() === 0, 10_000);
		expect(await rowsFor(sid)).toHaveLength(0);
	});

	test("a 1 MiB body: stored normally (GUARD — the cap doesn't affect real payloads)", async () => {
		const sid = newSessionId("d16-under");
		const padding = "y".repeat(1 * 1024 * 1024);
		const body = JSON.stringify({
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "d16-under-tu",
			tool_response: padding,
		});
		expect(body.length).toBeLessThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(0);

		await until(() => getInFlightCount() === 0, 10_000);
		const rows = await rowsFor(sid);
		expect(rows.length).toBeGreaterThan(0);
	});

	test("a lazily-generated stream over the cap, with NO Content-Length header, is caught by the running-total check", async () => {
		const before = getOversizeDropped();
		const stream = lazyOversizeStream(17 * 1024 * 1024);
		const req = new Request("http://x/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stream,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(req.headers.get("content-length")).toBeNull();

		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(1);
	});

	test("a Content-Length header above the cap short-circuits before reading the body stream in a loop", async () => {
		const before = getOversizeDropped();
		let pullCount = 0;
		const neverEndingStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount++;
				controller.enqueue(new Uint8Array(1024).fill(120));
				// Deliberately never closes — if readCappedBody's streaming loop
				// ran against this stream, pullCount would climb far past the
				// single eager pre-pull the platform itself performs on any
				// ReadableStream-bodied Request (observed once, independent of
				// whether any consumer ever calls getReader()).
			},
		});
		const req = new Request("http://x/api/v1/hooks", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(20 * 1024 * 1024),
			},
			body: neverEndingStream,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const res = await app.fetch(req);
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(1);
		// <=1, not ===0: the platform's own one-time eager pre-pull is not our
		// code reading the stream — a real streaming read loop would drive
		// this into the dozens/hundreds within the same tick.
		expect(pullCount).toBeLessThanOrEqual(1);
	});
});

describe("D16: POST /api/v1/hooks/status — oversize body", () => {
	test("an oversize status update: 200, oversizeDropped +1, status unchanged", async () => {
		const sid = newSessionId("d16-status-over");
		await mkSession(sid, { semanticStatus: "planning" });
		const padding = "z".repeat(17 * 1024 * 1024);
		const body = JSON.stringify({ session_id: sid, status: "implementing", task: padding });
		expect(body.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		const res = await app.request("/api/v1/hooks/status", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(1);

		await until(() => getInFlightCount() === 0, 10_000);
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sid)).limit(1);
		expect(row?.semanticStatus).toBe("planning");
	});
});

describe("D16: GET /api/v1/health includes oversizeDropped", () => {
	test("starts at 0 and increments, same shape as rateLimitedDropped", async () => {
		const res1 = await app.request("/api/v1/health");
		const body1 = await res1.json();
		expect(typeof body1.oversizeDropped).toBe("number");
		expect(body1.oversizeDropped).toBe(0);

		await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: newSessionId("d16-health"),
				hook_event_name: "Stop",
				cwd: "x".repeat(17 * 1024 * 1024),
			}),
		});

		const res2 = await app.request("/api/v1/health");
		const body2 = await res2.json();
		expect(body2.oversizeDropped).toBe(1);
	});
});
