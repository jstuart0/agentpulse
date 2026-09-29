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

describe("RpcClient notification dispatch isolates listener rejections (F25)", () => {
	let server: Server<unknown> | undefined;
	let client: RpcClient | undefined;

	afterEach(() => {
		client?.close();
		server?.stop(true);
		client = undefined;
		server = undefined;
	});

	test("a listener that rejects (403-shaped error) doesn't become an unhandled rejection, and later notifications still arrive", async () => {
		let serverSocket: ServerWebSocket<unknown> | undefined;
		server = Bun.serve({
			port: 0,
			fetch(req: Request, srv: unknown) {
				const s = srv as { upgrade(req: Request): boolean };
				if (s.upgrade(req)) return undefined as unknown as Response;
				return new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				open(ws) {
					serverSocket = ws;
				},
				message() {},
			},
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
			// Give the microtask/macrotask queue a turn to run the wrapped,
			// rejecting listener.
			await Bun.sleep(20);

			serverSocket?.send(JSON.stringify({ method: "second", params: {} }));
			await Bun.sleep(20);

			expect(delivered).toEqual(["first", "second"]);
			expect(unhandledReasons).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	test("multiple listeners are each isolated — one rejecting doesn't stop the others from receiving the same notification", async () => {
		let serverSocket: ServerWebSocket<unknown> | undefined;
		server = Bun.serve({
			port: 0,
			fetch(req: Request, srv: unknown) {
				const s = srv as { upgrade(req: Request): boolean };
				if (s.upgrade(req)) return undefined as unknown as Response;
				return new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				open(ws) {
					serverSocket = ws;
				},
				message() {},
			},
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
			await Bun.sleep(20);

			expect(secondListenerCalled).toBe(true);
			expect(unhandledReasons).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});
});
