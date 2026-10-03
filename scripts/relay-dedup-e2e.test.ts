/**
 * Post-merge E2 (D3, event-dedup's test-contract.md "Post-merge: E2, E3,
 * E3-canon"): the canonical relay's queue forwarder, retried against a lost
 * ack, dedupes by X-AgentPulse-Delivery-Id instead of storing a duplicate.
 *
 * "The relay's fetch wired to app.fetch through a wrapper that awaits the
 * server call and then throws for the first attempt of queue item 1" is
 * implemented here as a real HTTP proxy in front of the real app server:
 * the proxy forwards the first /api/v1/hooks POST it sees straight through
 * to the real server (so the event genuinely gets processed and stored),
 * AWAITS that real response, then returns a 500 to the caller (the relay)
 * — an honest "lost ack" simulation, not a mocked fetch. Every subsequent
 * request (including the relay's own retry of that same item) proxies
 * through untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/server/db/__test_db.js";
import { DELIVERY_ID_HEADER as SHARED_DELIVERY_ID_HEADER } from "../src/shared/hook-headers.js";

const { config } = await import("../src/server/config.js");
const { initializeDatabase, getDb } = await import("../src/server/db/client.js");
const { events } = await import("../src/server/db/schema/index.js");
const { app } = await import("../src/server/app.js");
const { createApiKey } = await import("../src/server/auth/api-key.js");
const { _resetDbReadyForTest } = await import("../src/server/routes/health.js");
const { getEventsDeduplicatedCounts, _resetEventDedupForTest } = await import(
	"../src/server/services/event-dedup.js"
);
const { eq } = await import("drizzle-orm");

const RELAY = join(import.meta.dir, "relay.ts");
const SCENARIO_TIMEOUT = 30_000;

let realServer: ReturnType<typeof Bun.serve>;
let realServerUrl: string;
let proxyServer: ReturnType<typeof Bun.serve>;
let proxyUrl: string;
let relayKey: string;
let root: string;
let seenHookHeaders: string[] = [];
let hookAttempts = 0;
const originalDisableAuth = config.disableAuth;

async function waitFor<T>(
	label: string,
	probe: () => Promise<T | undefined | null | false>,
	timeoutMs = 12_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const v = await probe();
			if (v) return v as T;
			last = v;
		} catch (err) {
			last = err;
		}
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${label} (last: ${String(last)})`);
}

beforeAll(async () => {
	await initializeDatabase();
	_resetDbReadyForTest(true);
	config.disableAuth = false;
	realServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
	realServerUrl = `http://127.0.0.1:${realServer.port}`;
	relayKey = (await createApiKey("e2e-dedup-relay", ["ingest", "observe"])).key;

	// The lost-ack proxy: awaits the real server's response (so the event is
	// genuinely stored), then returns 500 to the caller for the FIRST
	// /api/v1/hooks POST only. Everything else (including the retry) passes
	// through untouched, including /auth/me for the relay's own preflight.
	proxyServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const isHookPost = req.method === "POST" && url.pathname === "/api/v1/hooks";
			const body = await req.arrayBuffer();
			if (isHookPost) {
				const deliveryId = req.headers.get(SHARED_DELIVERY_ID_HEADER);
				if (deliveryId) seenHookHeaders.push(deliveryId);
			}
			const realRes = await fetch(`${realServerUrl}${url.pathname}${url.search}`, {
				method: req.method,
				headers: req.headers,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
			});
			if (isHookPost) {
				hookAttempts++;
				if (hookAttempts === 1) {
					// Drain the real response so the await above already stored the
					// event, then lie to the caller about it.
					await realRes.arrayBuffer();
					return new Response("lost ack (E2 fault injection)", { status: 500 });
				}
			}
			return new Response(await realRes.arrayBuffer(), {
				status: realRes.status,
				headers: realRes.headers,
			});
		},
	});
	proxyUrl = `http://127.0.0.1:${proxyServer.port}`;
}, 30_000);

afterAll(async () => {
	realServer?.stop(true);
	proxyServer?.stop(true);
	config.disableAuth = originalDisableAuth;
	if (root) await rm(root, { recursive: true, force: true });
});

describe("E2 (D3): relay retry against a lost ack dedupes by delivery id, not content", () => {
	test(
		"two identical id-less Claude Stop hooks, first delivery's ack lost: exactly 2 stored rows, deliveryRetry +1",
		async () => {
			_resetEventDedupForTest();
			seenHookHeaders = [];
			hookAttempts = 0;
			const before = getEventsDeduplicatedCounts().deliveryRetry;

			root = await mkdtemp(join(tmpdir(), "ap-relay-dedup-e2e-"));
			const home = join(root, "home");
			const dir = join(root, "relay-state");
			const codexHome = join(home, ".codex");
			await mkdir(codexHome, { recursive: true });
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "config.json"),
				JSON.stringify({ remote_url: proxyUrl, api_key: relayKey, port: 0 }),
				{ mode: 0o600 },
			);

			const proc = Bun.spawn(
				[process.execPath, RELAY, "--config", join(dir, "config.json"), "--port", "0"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						TMPDIR: process.env.TMPDIR ?? "/tmp",
						HOME: home,
						AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "",
						AGENTPULSE_RELAY_SYNC_MS: "200",
					},
				},
			);
			let buf = "";
			const decoder = new TextDecoder();
			const pump = async (stream: ReadableStream<Uint8Array>) => {
				for await (const chunk of stream) buf += decoder.decode(chunk);
			};
			void pump(proc.stdout as ReadableStream<Uint8Array>);
			void pump(proc.stderr as ReadableStream<Uint8Array>);

			try {
				const relayPort = await waitFor(
					"relay banner",
					async () => {
						const m = /Local:\s+http:\/\/localhost:(\d+)/.exec(buf);
						const n = m ? Number(m[1]) : 0;
						return n > 0 ? n : undefined;
					},
					10_000,
				);
				const relayBase = `http://127.0.0.1:${relayPort}`;

				const sessionId = `e2e-dedup-${crypto.randomUUID()}`;
				const stopPayload = {
					session_id: sessionId,
					hook_event_name: "Stop",
					cwd: "/tmp/e2e-dedup",
				};

				// Two identical id-less Claude Stop hooks == two queue items.
				for (let i = 0; i < 2; i++) {
					const res = await fetch(`${relayBase}/api/v1/hooks`, {
						method: "POST",
						headers: { "Content-Type": "application/json", "X-Agent-Type": "claude_code" },
						body: JSON.stringify(stopPayload),
					});
					expect(res.status).toBe(200);
				}

				// Drain: item 1 fails once (lost ack, real backoff before its
				// retry) and item 2 succeeds immediately — wait for both attempts
				// (3 total: item1 attempt1 fail, item1 retry, item2) to land.
				await waitFor("both queue items delivered", async () => hookAttempts >= 3, 20_000);

				// /api/v1/hooks returns 200 before processing finishes, so
				// hookAttempts >= 3 only proves the proxy has SEEN the 3rd request
				// arrive — not that the server has finished storing/deduping it.
				// Poll until the retry counter and the stored-row count both catch
				// up, then assert exact values (so an overshoot, e.g. a dedup bug
				// storing 3 rows, still fails with a clear message rather than the
				// poll spinning to its timeout).
				await waitFor(
					"retry counter and stored rows catch up with delivery",
					async () => {
						const retryDelta = getEventsDeduplicatedCounts().deliveryRetry - before;
						const rowCount = (
							await getDb().select().from(events).where(eq(events.sessionId, sessionId))
						).length;
						return retryDelta >= 1 && rowCount >= 2 ? true : undefined;
					},
					10_000,
				);

				const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
				expect(rows.length).toBe(2);

				const after = getEventsDeduplicatedCounts().deliveryRetry;
				expect(after - before).toBe(1);

				expect(seenHookHeaders.length).toBeGreaterThanOrEqual(2);
				// Item 1's original attempt and its retry carry the SAME delivery
				// id (that's what makes the retry dedupe instead of duplicate).
				expect(new Set(seenHookHeaders).size).toBeLessThan(seenHookHeaders.length);

				// Pins both independently-defined DELIVERY_ID_HEADER constants
				// (relay.ts is self-contained by design, see its own header
				// comment) to the same literal.
				expect(SHARED_DELIVERY_ID_HEADER).toBe("X-AgentPulse-Delivery-Id");
			} finally {
				proc.kill();
				await proc.exited.catch(() => {});
			}
		},
		SCENARIO_TIMEOUT,
	);
});
