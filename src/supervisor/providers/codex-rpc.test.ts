/**
 * F25 (2026-09-29-deliver-supervisor-auth-routing): RpcClient's notification
 * dispatcher must isolate each listener call — a rejected async listener
 * (e.g. an in-session reportState call that now gets a 403 session_not_owned)
 * must not become an unhandled promise rejection, and must not block
 * delivery of later notifications to the same or other listeners.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { RpcClient } from "./codex-rpc.js";

// F30: bun's default per-test timeout (5s) is too tight under host
// contention (observed 11.6s during a full Postgres suite run at ~65 load
// average) even though these tests are green in isolation. A generous
// explicit timeout, passed as each test()'s third argument, gives real
// headroom without masking an actual hang (waitUntil below still has its
// own bounded deadline).
const TEST_TIMEOUT_MS = 30_000;

/**
 * Poll `predicate` until it's true instead of sleeping a fixed duration.
 * Deterministic in the sense that it returns as soon as the condition
 * holds — normally within a microtask or two — rather than gambling a
 * fixed sleep is long enough under load, or wastefully long when it isn't.
 */
async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 5_000,
	intervalMs = 5,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
		}
		await Bun.sleep(intervalMs);
	}
}

function fakeUpgradingServer(onOpen: (ws: ServerWebSocket<unknown>) => void) {
	return Bun.serve({
		port: 0,
		fetch(req: Request, srv: unknown) {
			const s = srv as { upgrade(req: Request): boolean };
			if (s.upgrade(req)) return undefined as unknown as Response;
			return new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open: onOpen,
			message() {},
		},
	});
}

describe("RpcClient notification dispatch isolates listener rejections (F25)", () => {
	let server: Server<unknown> | undefined;
	let client: RpcClient | undefined;

	afterEach(() => {
		client?.close();
		server?.stop(true);
		client = undefined;
		server = undefined;
	});

	test(
		"a listener that rejects (403-shaped error) doesn't become an unhandled rejection, and later notifications still arrive",
		async () => {
			let serverSocket: ServerWebSocket<unknown> | undefined;
			server = fakeUpgradingServer((ws) => {
				serverSocket = ws;
			});

			client = await RpcClient.connect(`ws://127.0.0.1:${server.port}`);

			const unhandledReasons: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
			process.on("unhandledRejection", onUnhandledRejection);

			try {
				const delivered: string[] = [];
				client.onNotification(async (notification) => {
					delivered.push(notification.method);
					if (notification.method === "first") {
						// Simulates an in-session reportState call rejecting with the
						// new 403 session_not_owned (or any other non-2xx).
						throw new Error("Supervisor request failed: 403 Forbidden");
					}
				});

				serverSocket?.send(JSON.stringify({ method: "first", params: {} }));
				await waitUntil(() => delivered.includes("first"));

				serverSocket?.send(JSON.stringify({ method: "second", params: {} }));
				await waitUntil(() => delivered.includes("second"));

				expect(delivered).toEqual(["first", "second"]);
				expect(unhandledReasons).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"multiple listeners are each isolated — one rejecting doesn't stop the others from receiving the same notification",
		async () => {
			let serverSocket: ServerWebSocket<unknown> | undefined;
			server = fakeUpgradingServer((ws) => {
				serverSocket = ws;
			});

			client = await RpcClient.connect(`ws://127.0.0.1:${server.port}`);

			const unhandledReasons: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
			process.on("unhandledRejection", onUnhandledRejection);

			try {
				let secondListenerCalled = false;
				client.onNotification(async () => {
					throw new Error("Supervisor request failed: 403 Forbidden");
				});
				client.onNotification(async () => {
					secondListenerCalled = true;
				});

				serverSocket?.send(JSON.stringify({ method: "any", params: {} }));
				await waitUntil(() => secondListenerCalled);

				expect(secondListenerCalled).toBe(true);
				expect(unhandledReasons).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
