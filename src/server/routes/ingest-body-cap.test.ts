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
const { ingest, MAX_HOOK_BODY_BYTES, extractOversizeIdentity } = await import("./ingest.js");
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
	test("a 17 MiB body with no identity in the first 64 KiB: 200, not stored, oversizeDropped +1, JSON.parse never called", async () => {
		const sid = newSessionId("d16-over");
		const padding = "x".repeat(17 * 1024 * 1024);
		// F128: cwd (the padding) is written FIRST, pushing session_id/
		// hook_event_name past the 64 KiB identity-extraction prefix — this
		// stays the "nothing recoverable" case. See the F128 describe block
		// below for the case where identity IS recoverable.
		const body = JSON.stringify({
			cwd: padding,
			session_id: sid,
			hook_event_name: "Stop",
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

	// F128: readCappedBody now reads a bounded 64 KiB prefix even when
	// Content-Length alone already proves the body is oversize, so
	// extractOversizeIdentity has something to scan. That's a deliberate,
	// small, fixed amount of work — the assertion below bounds pull count to
	// "enough to fill the 64 KiB prefix", never to "the whole declared body".
	test("a Content-Length header above the cap still only reads a bounded 64 KiB prefix, never the declared body", async () => {
		const before = getOversizeDropped();
		let pullCount = 0;
		const chunkSize = 1024;
		const neverEndingStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount++;
				controller.enqueue(new Uint8Array(chunkSize).fill(120));
				// Deliberately never closes — if readCappedBody read to
				// completion (or read anywhere close to the declared 20 MiB),
				// pullCount would climb into the thousands within this tick.
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
		// Bounded by the 64 KiB prefix cap (plus a small platform pre-pull
		// margin), never proportional to the declared 20 MiB body.
		expect(pullCount).toBeLessThanOrEqual(Math.ceil((64 * 1024) / chunkSize) + 2);
	});

	test("F128: a stream with no Content-Length never accumulates more than MAX_HOOK_BODY_BYTES before aborting (memory bound)", async () => {
		const { readCappedBody } = await import("./ingest.js");
		const chunkSize = 8 * 1024;
		let pullCount = 0;
		const hugeStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pullCount++;
				controller.enqueue(new Uint8Array(chunkSize).fill(120));
				// Never closes — a body-buffering implementation given this
				// stream would hang forever; readCappedBody must abort once
				// the running total crosses MAX_HOOK_BODY_BYTES.
			},
		});
		const req = new Request("http://x/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: hugeStream,
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		const result = await readCappedBody(req, MAX_HOOK_BODY_BYTES);
		expect(result.oversize).toBe(true);
		if (result.oversize) {
			expect(result.prefix.length).toBeLessThanOrEqual(64 * 1024);
		}
		// Bounded by MAX_HOOK_BODY_BYTES / chunkSize (~2048 pulls here), not
		// unbounded — the reader never keeps pulling past the cap.
		expect(pullCount).toBeLessThanOrEqual(Math.ceil(MAX_HOOK_BODY_BYTES / chunkSize) + 2);
	});
});

describe("F128 (codex r2): oversize deliveries with a recoverable session_id store a stub row", () => {
	test("an oversize PreToolUse with identity in the first 64 KiB stores one row, keyed by tool_use_id (replay twice → one row)", async () => {
		const sid = newSessionId("f128-tool");
		const toolUseId = `f128-tu-${crypto.randomUUID()}`;
		// Just over the cap, not a full extra megabyte over it — this delivery
		// is sent twice in this test, and every byte here is pure overhead
		// once the point (>16 MiB) is made.
		const padding = "p".repeat(MAX_HOOK_BODY_BYTES + 4096);
		const body = JSON.stringify({
			session_id: sid,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: toolUseId,
			cwd: "/workspace",
			tool_input: { command: "echo hi" },
			tool_response: padding,
		});
		expect(body.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		for (let i = 0; i < 2; i++) {
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(res.status).toBe(200);
		}
		expect(getOversizeDropped() - before).toBe(2);

		await until(() => getInFlightCount() === 0, 10_000);
		const rows = await rowsFor(sid);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.eventType).toBe("PreToolUse");
		expect(rows[0]?.content).toBe("Payload exceeded 16 MiB and was dropped");
	});

	test("an oversize delivery with no session_id in the prefix: no row, counter still increments", async () => {
		const padding = "p".repeat(MAX_HOOK_BODY_BYTES + 4096);
		const body = JSON.stringify({
			hook_event_name: "Stop",
			cwd: "/workspace",
			last_assistant_message: padding,
		});
		expect(body.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(1);

		await until(() => getInFlightCount() === 0, 5_000);
	});

	test("identity fields placed after a huge tool_response fall outside the 64 KiB prefix: no row stored", async () => {
		const sid = newSessionId("f128-late-identity");
		// tool_response is written FIRST and is large enough on its own to
		// both trip the 16 MiB cap and push session_id/hook_event_name well
		// past the captured 64 KiB prefix.
		const oversizeBody = JSON.stringify({
			tool_response: "p".repeat(MAX_HOOK_BODY_BYTES + 4096),
			session_id: sid,
			hook_event_name: "PreToolUse",
			tool_use_id: "should-not-be-seen",
		});
		expect(oversizeBody.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: oversizeBody,
		});
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(1);

		await until(() => getInFlightCount() === 0, 5_000);
		expect(await rowsFor(sid)).toHaveLength(0);
	});
});

describe("F131b (D19): oversize stubs never claim a real t:/d: dedup key", () => {
	test("an oversize PostToolUse stub with tool_use_id X, followed by a normal PostToolUse with the same X, stores both rows", async () => {
		const sid = newSessionId("f131b-both");
		const toolUseId = `f131b-tu-${crypto.randomUUID()}`;

		const oversizeBody = JSON.stringify({
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: toolUseId,
			tool_input: { command: "echo hi" },
			tool_response: "p".repeat(MAX_HOOK_BODY_BYTES + 4096),
		});
		expect(oversizeBody.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const res1 = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: oversizeBody,
		});
		expect(res1.status).toBe(200);
		await until(() => getInFlightCount() === 0, 10_000);

		// The real event: same tool_use_id, a normal-sized body.
		const res2 = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: toolUseId,
				tool_response: "real output",
			}),
		});
		expect(res2.status).toBe(200);
		await until(() => getInFlightCount() === 0, 10_000);

		const rows = await rowsFor(sid);
		expect(rows).toHaveLength(2);

		const stub = rows.find((r) => r.content === "Payload exceeded 16 MiB and was dropped");
		const real = rows.find((r) => r.content !== "Payload exceeded 16 MiB and was dropped");
		expect(stub, JSON.stringify(rows)).toBeDefined();
		expect(real, JSON.stringify(rows)).toBeDefined();
		expect(stub?.dedupKey).toMatch(/^o:[0-9a-f]{32}$/);
		expect(real?.dedupKey).toMatch(/^t:[0-9a-f]{32}$/);
	});

	test("replaying the same oversize delivery still gives one stub", async () => {
		const sid = newSessionId("f131b-replay");
		const toolUseId = `f131b-replay-tu-${crypto.randomUUID()}`;
		const oversizeBody = JSON.stringify({
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: toolUseId,
			tool_response: "p".repeat(MAX_HOOK_BODY_BYTES + 4096),
		});
		expect(oversizeBody.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		for (let i = 0; i < 2; i++) {
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: oversizeBody,
			});
			expect(res.status).toBe(200);
		}
		await until(() => getInFlightCount() === 0, 10_000);

		const rows = await rowsFor(sid);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dedupKey).toMatch(/^o:[0-9a-f]{32}$/);
	});
});

describe("F140 (D21): the oversize-stub flag can't be forged by a client", () => {
	test("a normal-size PostToolUse with agentpulse_oversize:true stores its real content under a t: key, not the placeholder", async () => {
		const sid = newSessionId("f140-forge");
		const toolUseId = `f140-tu-${crypto.randomUUID()}`;
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: toolUseId,
				tool_response: "real tool output",
				// The forgery attempt: a normal-size, real-looking body that
				// claims to be an oversize stub.
				agentpulse_oversize: true,
			}),
		});
		expect(res.status).toBe(200);
		await until(() => getInFlightCount() === 0, 10_000);

		const rows = await rowsFor(sid);
		expect(rows, JSON.stringify(rows)).toHaveLength(1);
		expect(rows[0]?.content).not.toBe("Payload exceeded 16 MiB and was dropped");
		expect(rows[0]?.content).toBe("Completed Bash");
		expect(rows[0]?.toolResponse).toBe("real tool output");
		expect(rows[0]?.dedupKey).toMatch(/^t:[0-9a-f]{32}$/);
		// Defense in depth: the reserved key never survives into the stored
		// rawPayload either.
		expect(rows[0]?.rawPayload).not.toHaveProperty("agentpulse_oversize");
	});

	test("a real oversize delivery still stores the placeholder under an o: key (D19 unchanged)", async () => {
		const sid = newSessionId("f140-real-oversize");
		const toolUseId = `f140-real-tu-${crypto.randomUUID()}`;
		const body = JSON.stringify({
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: toolUseId,
			tool_response: "p".repeat(MAX_HOOK_BODY_BYTES + 4096),
		});
		expect(body.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		await until(() => getInFlightCount() === 0, 10_000);

		const rows = await rowsFor(sid);
		expect(rows, JSON.stringify(rows)).toHaveLength(1);
		expect(rows[0]?.content).toBe("Payload exceeded 16 MiB and was dropped");
		expect(rows[0]?.dedupKey).toMatch(/^o:[0-9a-f]{32}$/);
	});
});

describe("F132 (D19): identity extraction is top-level-only and JSON-aware", () => {
	test("a top-level session_id is extracted even when tool_input nests a fake one", () => {
		const prefix = JSON.stringify({
			tool_input: { session_id: "victim", nested: { more: "stuff" } },
			session_id: "real",
			hook_event_name: "PreToolUse",
			tool_use_id: "tu-1",
		});
		const identity = extractOversizeIdentity(prefix);
		expect(identity).not.toBeNull();
		expect(identity?.sessionId).toBe("real");
	});

	test("a non-JSON prefix extracts nothing", () => {
		const prefix = '"pad" "session_id":"x"';
		expect(extractOversizeIdentity(prefix)).toBeNull();
	});

	test("leading whitespace before the opening brace is tolerated", () => {
		const prefix = `   ${JSON.stringify({ session_id: "f132-ws-ok", hook_event_name: "Stop" })}`;
		const identity = extractOversizeIdentity(prefix);
		expect(identity?.sessionId).toBe("f132-ws-ok");
	});

	test("an array-nested fake session_id at depth > 1 is ignored", () => {
		const prefix = JSON.stringify({
			some_list: [{ session_id: "victim-in-array" }],
			session_id: "f132-real-array",
			hook_event_name: "Stop",
		});
		const identity = extractOversizeIdentity(prefix);
		expect(identity?.sessionId).toBe("f132-real-array");
	});
});

describe("F141 (D21): a bracket-type mismatch aborts extraction entirely", () => {
	test("a nested object closed by ] (not }) yields no stub — xander's adversarial prefix, padded past the cap", async () => {
		// A flat depth counter sees `{` and `[` as interchangeable: closing the
		// nested tool_input object with `]` still drops the counter from 2 to
		// 1, so it reads everything after that `]` as top-level — including
		// the attacker's forged session_id/hook_event_name/tool_use_id. The
		// stack-based tracker must instead detect the `}` vs `]` mismatch and
		// abort extraction outright.
		const sid = "attacker-session";
		const padding = "p".repeat(MAX_HOOK_BODY_BYTES + 4096);
		const body = `{"tool_input":{"nested":"x"]"session_id":"${sid}","hook_event_name":"PostToolUse","tool_use_id":"forged-1","padding":"${padding}"}`;
		expect(body.length).toBeGreaterThan(MAX_HOOK_BODY_BYTES);

		const before = getOversizeDropped();
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(getOversizeDropped() - before).toBe(1);

		await until(() => getInFlightCount() === 0, 5_000);
		expect(await rowsFor(sid)).toHaveLength(0);
	});

	test("the reverse mismatch, [ closed by }, also yields nothing", () => {
		const prefix = '{"a":[1,2}"session_id":"f141-reverse","hook_event_name":"Stop"}';
		expect(extractOversizeIdentity(prefix)).toBeNull();
	});
});

describe("F133 (D19): stub fields are sanitized and hook_event_name must be known", () => {
	test("an unknown hook_event_name yields no stub", () => {
		const prefix = JSON.stringify({
			session_id: "f133-unknown",
			hook_event_name: "TotallyMadeUpEvent",
		});
		expect(extractOversizeIdentity(prefix)).toBeNull();
	});

	test("control characters are stripped from a recovered field", () => {
		const prefix = JSON.stringify({
			session_id: "f133-ctl",
			hook_event_name: "PreToolUse",
			tool_name: "Ba\u0007sh\u0000!",
		});
		const identity = extractOversizeIdentity(prefix);
		expect(identity).not.toBeNull();
		expect(identity?.toolName).toBe("Bash!");
	});

	test("a recovered field is length-capped", () => {
		const longToolName = "x".repeat(5000);
		const prefix = JSON.stringify({
			session_id: "f133-long",
			hook_event_name: "PreToolUse",
			tool_name: longToolName,
		});
		const identity = extractOversizeIdentity(prefix);
		expect(identity).not.toBeNull();
		expect(identity?.toolName?.length).toBeLessThanOrEqual(512);
	});
});

describe("ReDoS guard (D19): adversarial-prefix extraction stays fast", () => {
	test('a 64 KiB run of unterminated "session_id":" fragments finishes well under a generous bound', () => {
		const fragment = '"session_id":"';
		const body = `{${fragment.repeat(Math.ceil((64 * 1024) / fragment.length))}`.slice(
			0,
			64 * 1024,
		);

		const start = Date.now();
		const identity = extractOversizeIdentity(body);
		const elapsed = Date.now() - start;

		// Loosely bounded — the host can be heavily loaded — this only guards
		// against a real blowup (would be seconds/minutes with backtracking),
		// not a tight performance budget.
		expect(elapsed).toBeLessThan(500);
		expect(identity).toBeNull();
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

		// F128: cwd (the padding) is written FIRST so session_id/hook_event_name
		// fall outside the 64 KiB identity-extraction prefix — this stays a
		// pure drop-and-count delivery with no background processing to await,
		// which is all this test needs (it's only checking the counter).
		await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cwd: "x".repeat(17 * 1024 * 1024),
				session_id: newSessionId("d16-health"),
				hook_event_name: "Stop",
			}),
		});

		const res2 = await app.request("/api/v1/health");
		const body2 = await res2.json();
		expect(body2.oversizeDropped).toBe(1);
	});

	// F121 (tessa): nothing previously asserted these fields' actual
	// presence/shape on the real GET /api/v1/health response — renaming or
	// dropping them in health.ts passed every other test. Fetch through the
	// real app and pin the exact shape.
	test("F121: eventsDeduplicated (exactly 4 keys), legacyObserverDeliveries, and oversizeDropped are all present with the right types", async () => {
		const res = await app.request("/api/v1/health");
		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.eventsDeduplicated).toBeDefined();
		expect(Object.keys(body.eventsDeduplicated).sort()).toEqual(
			["authority", "contentWindow", "deliveryRetry", "toolUseRetry"].sort(),
		);
		for (const v of Object.values(body.eventsDeduplicated as Record<string, unknown>)) {
			expect(typeof v).toBe("number");
		}

		expect(typeof body.legacyObserverDeliveries).toBe("number");
		expect(typeof body.oversizeDropped).toBe("number");
	});
});
