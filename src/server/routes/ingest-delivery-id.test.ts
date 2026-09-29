// Phase 7 (AGEN-16): the X-AgentPulse-Delivery-Id / X-AgentPulse-Origin
// headers over HTTP — the literal pin (P4.10, the Phase 7 gate), delivery-id
// retries, body-digest discrimination (P4.12, G6, G6b), scope-gated API
// keys (K1-K4), and the body/broadcast leak guard (P4.11).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

import type { HookEventPayload } from "../../shared/types.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { ingest } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { handleWsOpen, handleWsClose } = await import("../ws/handler.js");
const { _resetEventDedupForTest, getEventsDeduplicatedCounts } = await import(
	"../services/event-dedup.js"
);
const { DELIVERY_ID_HEADER } = await import("../../shared/hook-headers.js");
const { createApiKey, SCOPE_INGEST } = await import("../auth/api-key.js");
const { insertHookEvents } = await import("../services/event-processor.js");
const { normalizeHookEvent } = await import("../services/event-normalizer.js");

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

async function mkSession(sessionId: string) {
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
		})
		.execute();
}

type PostOpts = { headers?: Record<string, string>; auth?: string };

async function postHook(body: Record<string, unknown>, opts: PostOpts = {}): Promise<Response> {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(opts.auth ? { Authorization: `Bearer ${opts.auth}` } : {}),
			...opts.headers,
		},
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

describe("P4.10: the header literal (Phase 7 gate)", () => {
	test("DELIVERY_ID_HEADER equals the exact literal", () => {
		expect(DELIVERY_ID_HEADER).toBe("X-AgentPulse-Delivery-Id");
	});

	test("a post with the exact literal header is honored (retry collapses)", async () => {
		const sid = newSessionId("p410");
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		expect((await rowsFor(sid)).length).toBe(1);
	});
});

describe("P4.1-P4.9", () => {
	test("D1/D2 -> 2", async () => {
		const sid = newSessionId("p41");
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d2-aaaaaaaa" } },
		);
		expect((await rowsFor(sid)).length).toBe(2);
	});

	test("D1 x2 -> 1, deliveryRetry +1", async () => {
		const sid = newSessionId("p42");
		const before = getEventsDeduplicatedCounts().deliveryRetry;
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		expect((await rowsFor(sid)).length).toBe(1);
		expect(getEventsDeduplicatedCounts().deliveryRetry - before).toBe(1);
	});

	test("Codex Stop D1 x2 -> 2 rows, +2 (primary and assistant echo both keyed, both retry)", async () => {
		const sid = newSessionId("p43");
		const before = getEventsDeduplicatedCounts().deliveryRetry;
		const body = {
			session_id: sid,
			hook_event_name: "Stop",
			last_assistant_message: "done",
			transcript_path: "/fake/t.jsonl",
		};
		const headers = { "X-Agent-Type": "codex_cli", [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" };
		await postHook(body, { headers });
		expect((await rowsFor(sid)).length).toBe(2);
		await postHook(body, { headers });
		expect((await rowsFor(sid)).length).toBe(2);
		expect(getEventsDeduplicatedCounts().deliveryRetry - before).toBe(2);
	});

	test("D1, D2, D1 -> 2", async () => {
		const sid = newSessionId("p44");
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d2-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		expect((await rowsFor(sid)).length).toBe(2);
	});

	test("malformed ids are ignored; valid ones accepted (via storage behavior)", async () => {
		// A malformed id behaves like "no delivery id at all": under this file's
		// content-free Stop payload (no tool_use_id), that means unkeyed —
		// always stored, never deduped. Space and NUL can't even be sent as an
		// HTTP header value through the fetch Headers API (the platform itself
		// rejects them before the request is dispatched); those two chars are
		// covered directly against parseDeliveryId in event-dedup.test.ts.
		const malformed = ["a".repeat(7), "a".repeat(65), "a/b", "a_b", "a.b"];
		for (const id of malformed) {
			const sid = newSessionId(`p45-${malformed.indexOf(id)}`);
			await postHook(
				{ session_id: sid, hook_event_name: "Stop" },
				{ headers: { [DELIVERY_ID_HEADER]: id } },
			);
			await postHook(
				{ session_id: sid, hook_event_name: "Stop" },
				{ headers: { [DELIVERY_ID_HEADER]: id } },
			);
			expect((await rowsFor(sid)).length, `id=${JSON.stringify(id)}`).toBe(2);
		}

		const valid = [
			"a".repeat(8),
			"a".repeat(64),
			"01a0e994-8966-7df2-9441-cb89cc6ae1aa",
			"0123456789abcdef0123456789abcdef",
		];
		for (const id of valid) {
			const sid = newSessionId(`p45v-${valid.indexOf(id)}`);
			await postHook(
				{ session_id: sid, hook_event_name: "Stop" },
				{ headers: { [DELIVERY_ID_HEADER]: id } },
			);
			await postHook(
				{ session_id: sid, hook_event_name: "Stop" },
				{ headers: { [DELIVERY_ID_HEADER]: id } },
			);
			expect((await rowsFor(sid)).length, `id=${id}`).toBe(1);
		}
	});

	test("the same D1 across sessions (GUARD)", async () => {
		const sidA = newSessionId("p46a");
		const sidB = newSessionId("p46b");
		await postHook(
			{ session_id: sidA, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sidB, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		expect((await rowsFor(sidA)).length).toBe(1);
		expect((await rowsFor(sidB)).length).toBe(1);
	});

	test("/hooks/status ignores the delivery-id header (GUARD)", async () => {
		const sid = newSessionId("p47");
		const res = await app.request("/api/v1/hooks/status", {
			method: "POST",
			headers: { "content-type": "application/json", [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" },
			body: JSON.stringify({ session_id: sid, status: "implementing" }),
		});
		expect(res.status).toBe(200);
	});

	test("P4.8: an id-less Post D1, an id-less PermissionRequest D2, then Post D1 again -> 1 Post row, +1, wait cleared", async () => {
		const { getDb: getDbLocal } = await import("../db/client.js");
		const { sessions } = await import("../db/schema/index.js");
		const sid = newSessionId("p48");
		const before = getEventsDeduplicatedCounts().deliveryRetry;
		await postHook(
			{ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Bash" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "PermissionRequest", tool_name: "Bash" },
			{ headers: { [DELIVERY_ID_HEADER]: "d2-aaaaaaaa" } },
		);
		// getInFlightCount()===0 is a proxy for "the queued task finished", not
		// a guarantee — poll the actual condition directly (bounded) instead
		// of trusting the proxy a second time.
		let mid: { metadata: unknown } | undefined;
		const waitStart = Date.now();
		do {
			[mid] = await getDbLocal()
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, sid))
				.limit(1);
			if ((mid?.metadata as Record<string, unknown> | null)?.permissionWait) break;
			if (Date.now() - waitStart > 10_000) break;
			await new Promise((r) => setTimeout(r, 10));
		} while (Date.now() - waitStart <= 10_000);
		expect((mid?.metadata as Record<string, unknown> | null)?.permissionWait).toBeTruthy();

		await postHook(
			{ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Bash" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		// A conflicting retry never changes the row count (nothing new is
		// inserted), so rowsFor() alone can't prove the retry's own
		// processing (the deliveryRetry classification) has actually run —
		// poll that directly, bounded, same as above.
		const counterStart = Date.now();
		while (
			getEventsDeduplicatedCounts().deliveryRetry - before < 1 &&
			Date.now() - counterStart < 10_000
		) {
			await new Promise((r) => setTimeout(r, 10));
		}
		const rows = await rowsFor(sid);
		expect(rows.filter((r) => r.eventType === "PostToolUse")).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().deliveryRetry - before).toBe(1);
		const [final] = await getDbLocal()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sid))
			.limit(1);
		expect((final?.metadata as Record<string, unknown> | null)?.permissionWait).toBeUndefined();
	});

	test("P4.9: a failed insert doesn't burn D1", async () => {
		// Drives the actual failed-insert path (mirrors P2.15 in
		// event-processor-dedup.test.ts): insertHookEvents against a session
		// that doesn't exist yet must reject before ever touching the
		// delivery-id key space, so a retry once the session exists is a
		// genuinely fresh insert, not a deliveryRetry.
		//
		// The previous version of this test posted a body missing
		// hook_event_name, which is rejected by the route before any insert
		// is attempted — it never drove a *failed insert*, only the
		// always-200 malformed-body guard (already covered elsewhere).
		const sid = newSessionId("p49");
		const stop = { session_id: sid, hook_event_name: "Stop" } as HookEventPayload;
		const ctx = { keyId: "anonymous", deliveryId: "d1-aaaaaaaa", origin: "native" as const };

		await expect(
			insertHookEvents(sid, normalizeHookEvent(stop, "codex_cli"), {
				kind: "hook_delivery",
				ctx,
				rawPayload: stop,
			}),
		).rejects.toThrow();

		await mkSession(sid);
		const before = getEventsDeduplicatedCounts().deliveryRetry;
		const stored = await insertHookEvents(sid, normalizeHookEvent(stop, "codex_cli"), {
			kind: "hook_delivery",
			ctx,
			rawPayload: stop,
		});
		expect(stored).toHaveLength(1);
		expect((await rowsFor(sid)).length).toBe(1);
		expect(getEventsDeduplicatedCounts().deliveryRetry - before).toBe(0);
	});
});

describe("P4.11: the delivery id never leaks into stored rawPayload or broadcast", () => {
	test("D1 absent from stored rawPayload and from the broadcast", async () => {
		const ws = attachFakeWs();
		const sid = newSessionId("p411");
		await postHook(
			{ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu1" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
		);
		const rows = await rowsFor(sid);
		for (const row of rows) {
			expect(JSON.stringify(row.rawPayload)).not.toContain("d1-aaaaaaaa");
		}
		const events_ = ws.messages.filter((m) => m.type === "new_event" && m.data.sessionId === sid);
		for (const e of events_) {
			expect(JSON.stringify(e.data)).not.toContain("d1-aaaaaaaa");
		}
		ws.close();
	});
});

test("P4.12: the same key and D1 with a different body -> 2 rows", async () => {
	const sid = newSessionId("p412");
	await postHook(
		{ session_id: sid, hook_event_name: "Stop", last_assistant_message: "first" },
		{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
	);
	await postHook(
		{ session_id: sid, hook_event_name: "Stop", last_assistant_message: "second" },
		{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" } },
	);
	expect((await rowsFor(sid)).length).toBe(4); // 2 Stops + 2 distinct assistant echoes
});

describe("G6 / G6b: the body digest is over the uncapped payload", () => {
	test("G6: bodies differing only past tool_response char 4096 -> 2 rows", async () => {
		const sid = newSessionId("g6");
		const headers = { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" };
		await postHook(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_response: `${"x".repeat(4096)}AAA`,
			},
			{ headers },
		);
		await postHook(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_response: `${"x".repeat(4096)}BBB`,
			},
			{ headers },
		);
		expect((await rowsFor(sid)).length).toBe(2);
	});

	test("G6b: bodies differing only in tool_input (dropped from rawPayload) -> 2 rows", async () => {
		const sid = newSessionId("g6b");
		const headers = { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" };
		await postHook(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "echo 1" },
			},
			{ headers },
		);
		await postHook(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "echo 2" },
			},
			{ headers },
		);
		expect((await rowsFor(sid)).length).toBe(2);
	});
});

describe("K1-K4: API-key scoping and identity (auth on)", () => {
	afterEach(() => {
		config.disableAuth = true;
	});

	test("K1: key A X, key B X -> 2; A again -> still 2", async () => {
		config.disableAuth = false;
		const { key: keyA } = await createApiKey("k1-a", [SCOPE_INGEST]);
		const { key: keyB } = await createApiKey("k1-b", [SCOPE_INGEST]);
		const sid = newSessionId("k1");
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" }, auth: keyA },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" }, auth: keyB },
		);
		expect((await rowsFor(sid)).length).toBe(2);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" }, auth: keyA },
		);
		expect((await rowsFor(sid)).length).toBe(2);
	});

	test("K2: B reuses A's D -> stored (GUARD — keyId is part of the key)", async () => {
		config.disableAuth = false;
		const { key: keyA } = await createApiKey("k2-a", [SCOPE_INGEST]);
		const { key: keyB } = await createApiKey("k2-b", [SCOPE_INGEST]);
		const sid = newSessionId("k2");
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" }, auth: keyA },
		);
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" }, auth: keyB },
		);
		expect((await rowsFor(sid)).length).toBe(2);
	});

	test("K3: a 100 KB session_id -> dedup_key matches ^d:[0-9a-f]{32}$", async () => {
		config.disableAuth = false;
		const { key } = await createApiKey("k3", [SCOPE_INGEST]);
		const sid = `${newSessionId("k3")}-${"s".repeat(100 * 1024)}`;
		await postHook(
			{ session_id: sid, hook_event_name: "Stop" },
			{ headers: { [DELIVERY_ID_HEADER]: "d1-aaaaaaaa" }, auth: key },
		);
		const rows = await rowsFor(sid);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dedupKey).toMatch(/^d:[0-9a-f]{32}$/);
	});
});
