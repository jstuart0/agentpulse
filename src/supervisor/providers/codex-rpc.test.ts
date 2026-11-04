/**
 * The Codex RPC client and its stdio transport (AGEN-87, D20).
 *
 * F25 (2026-09-29-deliver-supervisor-auth-routing): the notification dispatcher must isolate each
 * listener call: a rejected async listener (an in-session reportState that gets a 403
 * session_not_owned) must not become an unhandled rejection, and must not block later notifications.
 * Those two tests now run over a real child on pipes.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import {
	CODEX_INITIALIZE_TIMEOUT_MS,
	type CodexAppServer,
	MAX_FRAME_BYTES,
	RPC_METHOD_NOT_FOUND,
	RpcClient,
	type RpcTimers,
	initializeCodexClient,
	startCodexAppServer,
} from "./codex-rpc.js";

// F30: bun's default per-test timeout (5s) is too tight under host contention even though these
// tests are green in isolation; the explicit timeout gives real headroom without masking a hang
// (waitUntil below has its own bounded deadline).
const TEST_TIMEOUT_MS = 30_000;

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

let dir: string;
let fakeCodex: string;
let logPath: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ap-codex-rpc-"));
	fakeCodex = installFakeCodex(dir);
	logPath = join(dir, "fake.log");
	return () => rmSync(dir, { recursive: true, force: true });
});

const started: CodexAppServer[] = [];
afterEach(async () => {
	for (const app of started.splice(0)) await app.shutdown();
	rmSync(logPath, { force: true });
});

async function startFake(env: Record<string, string> = {}, timings = {}) {
	const app = await startCodexAppServer({
		executable: fakeCodex,
		env: { ...process.env, FAKE_CODEX_LOG: logPath, ...env },
		timings: { stdinCloseMs: 1_000, termMs: 500, killMs: 500, ...timings },
		log: () => {},
	});
	started.push(app);
	return app;
}

/** A client over an in-memory link: what it writes is captured, and the test feeds it frames. */
function memoryClient(options: ConstructorParameters<typeof RpcClient>[1] = {}) {
	const written: any[] = [];
	let closes = 0;
	const client = new RpcClient(
		{
			write: (frame) => written.push(JSON.parse(frame)),
			close: () => {
				closes++;
			},
		},
		options,
	);
	const feed = (frame: unknown) => client.receive(`${JSON.stringify(frame)}\n`);
	return { client, written, feed, closes: () => closes };
}

/** A child that prints notifications once it hears from the client. */
const NOTIFYING_CHILD = `
process.stdin.once("data", () => {
  console.log(JSON.stringify({ method: "first", params: {} }));
  setTimeout(() => console.log(JSON.stringify({ method: "second", params: {} })), 20);
});
process.stdin.on("end", () => process.exit(0));
`;

describe("RpcClient notification dispatch isolates listener rejections (F25)", () => {
	async function startNotifier() {
		const app = await startCodexAppServer({
			executable: process.execPath,
			args: ["-e", NOTIFYING_CHILD],
			timings: { stdinCloseMs: 1_000, termMs: 500, killMs: 500 },
		});
		started.push(app);
		return app;
	}

	test(
		"a listener that rejects (403-shaped error) doesn't become an unhandled rejection, and later notifications still arrive",
		async () => {
			const { client } = await startNotifier();
			const unhandledReasons: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => unhandledReasons.push(reason);
			process.on("unhandledRejection", onUnhandledRejection);
			try {
				const delivered: string[] = [];
				client.onNotification(async (notification) => {
					delivered.push(notification.method);
					if (notification.method === "first") {
						throw new Error("Supervisor request failed: 403 Forbidden");
					}
				});
				client.request("go").catch(() => {});
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
		"multiple listeners are each isolated, one rejecting doesn't stop the others from receiving the same notification",
		async () => {
			const { client } = await startNotifier();
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
				client.request("go").catch(() => {});
				await waitUntil(() => secondListenerCalled);
				expect(unhandledReasons).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandledRejection);
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("jsonl framing", () => {
	test("two frames in one chunk are both delivered", () => {
		const { client } = memoryClient();
		const seen: string[] = [];
		client.onNotification((n) => seen.push(n.method));
		client.receive('{"method":"a"}\n{"method":"b"}\n');
		return Bun.sleep(5).then(() => expect(seen).toEqual(["a", "b"]));
	});

	test("one frame across chunks is delivered once, when its newline arrives", async () => {
		const { client } = memoryClient();
		const seen: string[] = [];
		client.onNotification((n) => seen.push(n.method));
		client.receive('{"meth');
		client.receive('od":"split"}');
		await Bun.sleep(5);
		expect(seen).toEqual([]);
		client.receive("\n");
		await Bun.sleep(5);
		expect(seen).toEqual(["split"]);
	});

	test("a multi-byte character split across chunks survives", async () => {
		const { client } = memoryClient();
		const seen: string[] = [];
		client.onNotification((n) => seen.push((n.params as { text: string }).text));
		const bytes = Buffer.from(
			`${JSON.stringify({ method: "m", params: { text: "café \u{1F600}" } })}\n`,
		);
		// Cut inside the two-byte é and again inside the four-byte emoji.
		const eAcute = bytes.indexOf(0xc3);
		const emoji = bytes.indexOf(0xf0);
		client.receive(bytes.subarray(0, eAcute + 1));
		client.receive(bytes.subarray(eAcute + 1, emoji + 2));
		client.receive(bytes.subarray(emoji + 2));
		await Bun.sleep(5);
		expect(seen).toEqual(["café \u{1F600}"]);
	});

	test("a malformed line is ignored and the next frame still arrives", async () => {
		const { client } = memoryClient();
		const seen: string[] = [];
		client.onNotification((n) => seen.push(n.method));
		client.receive('{not json\n["an","array"]\n"a string"\n\n{"method":"after"}\n');
		await Bun.sleep(5);
		expect(seen).toEqual(["after"]);
		expect(client.isClosed).toBe(false);
	});

	test("a partial line at end of file is dropped", async () => {
		const { client } = memoryClient();
		const seen: string[] = [];
		client.onNotification((n) => seen.push(n.method));
		// The partial line is complete JSON, only its newline never came.
		client.receive('{"method":"whole"}\n{"method":"cut off"}');
		client.transportClosed();
		await Bun.sleep(5);
		expect(seen).toEqual(["whole"]);
	});

	test("a frame over the limit closes the client with an error, whether it arrives whole or in pieces", () => {
		for (const send of [
			(c: RpcClient) => c.receive(`${"x".repeat(100)}\n`),
			(c: RpcClient) => {
				c.receive("x".repeat(60));
				c.receive("x".repeat(60));
			},
		]) {
			const { client } = memoryClient({ maxFrameBytes: 64 });
			const errors: Array<Error | undefined> = [];
			client.onClose((e) => errors.push(e));
			send(client);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.message).toMatch(/size limit/);
		}
	});

	test("the real limit is 64 MiB, and a frame exactly at the limit is accepted", () => {
		expect(MAX_FRAME_BYTES).toBe(64 * 1024 * 1024);
		const { client } = memoryClient({ maxFrameBytes: 64 });
		const closed: unknown[] = [];
		client.onClose((e) => closed.push(e));
		client.receive(`${"x".repeat(64)}\n`);
		expect(closed).toEqual([]);
	});

	test("a write after the child exits doesn't throw, and a request is refused", async () => {
		const app = await startFake();
		await app.shutdown();
		expect(() => app.client.respond(0, {})).not.toThrow();
		expect(app.client.respond(0, {})).toBe(false);
		await expect(app.client.request("x")).rejects.toThrow(/closed/);
	});

	test("close fires once, however many ways the stream ends", async () => {
		const app = await startFake();
		let calls = 0;
		app.client.onClose(() => calls++);
		app.client.close();
		app.client.transportClosed(new Error("again"));
		await app.shutdown();
		app.client.close();
		expect(calls).toBe(1);
	});
});

describe("drains stderr", () => {
	test(
		"a child that writes 1 MiB to stderr before it answers still gets its request answered",
		async () => {
			const lines: string[] = [];
			const app = await startCodexAppServer({
				executable: fakeCodex,
				env: {
					...process.env,
					FAKE_CODEX_LOG: logPath,
					FAKE_CODEX_STDERR_BYTES: String(1024 * 1024),
				},
				log: (line) => lines.push(line),
			});
			started.push(app);
			const result = await app.client.request<{ protocolVersion: string }>(
				"initialize",
				{},
				{ timeoutMs: 10_000 },
			);
			expect(result.protocolVersion).toBe("fake");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"stderr text is never logged or notified: an unexpected exit logs a fixed line with counts only",
		async () => {
			const SENTINEL = "sk-SENTINEL-secret-token-9f3a";
			const lines: string[] = [];
			const app = await startCodexAppServer({
				executable: fakeCodex,
				env: {
					...process.env,
					FAKE_CODEX_LOG: logPath,
					FAKE_CODEX_STDERR_TEXT: SENTINEL,
					FAKE_CODEX_STDERR_BYTES: String(512 * 1024),
				},
				log: (line) => lines.push(line),
			});
			started.push(app);
			const notifications: unknown[] = [];
			app.client.onNotification((n) => notifications.push(n));
			await app.client.request("initialize", {}, { timeoutMs: 10_000 });
			const closed = new Promise<void>((resolve) => app.client.onClose(() => resolve()));
			process.kill(app.pid, "SIGKILL");
			await closed;
			await waitUntil(() => lines.length > 0);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("exited unexpectedly");
			expect(lines[0]).toContain("signal=SIGKILL");
			expect(lines[0]).toMatch(/stderr=\d+ bytes, not logged/);
			expect(lines.join("\n")).not.toContain(SENTINEL);
			expect(lines[0]).not.toContain("eeee");
			expect(JSON.stringify(notifications)).not.toContain(SENTINEL);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("startup failure", () => {
	test("a missing executable rejects at once, naming it", async () => {
		const began = Date.now();
		await expect(startCodexAppServer({ executable: join(dir, "no-such-codex") })).rejects.toThrow(
			/Failed to start Codex app-server/,
		);
		expect(Date.now() - began).toBeLessThan(2_000);
	});

	test("a child that exits early rejects the first request at once", async () => {
		const app = await startFake({ FAKE_CODEX_EARLY_EXIT: "3" });
		const began = Date.now();
		await expect(initializeCodexClient(app.client, {})).rejects.toThrow();
		expect(Date.now() - began).toBeLessThan(5_000);
	});

	test("a silent child rejects at the 15 s limit, on an injected clock", async () => {
		const scheduled: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
		const timers: RpcTimers = {
			set: (callback, ms) => {
				const entry = { callback, ms, cleared: false };
				scheduled.push(entry);
				return entry;
			},
			clear: (handle) => {
				(handle as { cleared: boolean }).cleared = true;
			},
		};
		const app = await startCodexAppServer({
			executable: fakeCodex,
			env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_SILENT: "1" },
			timers,
			log: () => {},
		});
		started.push(app);
		const pending = initializeCodexClient(app.client, {});
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0].ms).toBe(CODEX_INITIALIZE_TIMEOUT_MS);
		expect(CODEX_INITIALIZE_TIMEOUT_MS).toBe(15_000);
		scheduled[0].callback();
		await expect(pending).rejects.toThrow(/Timed out waiting for initialize/);
	});

	test("an answered request clears its limit", async () => {
		const scheduled: Array<{ cleared: boolean }> = [];
		const app = await startCodexAppServer({
			executable: fakeCodex,
			env: { ...process.env, FAKE_CODEX_LOG: logPath },
			timers: {
				set: () => {
					const entry = { cleared: false };
					scheduled.push(entry);
					return entry;
				},
				clear: (handle) => {
					(handle as { cleared: boolean }).cleared = true;
				},
			},
			log: () => {},
		});
		started.push(app);
		await initializeCodexClient(app.client, {});
		expect(scheduled.map((s) => s.cleared)).toEqual([true]);
	});
});

describe("server request", () => {
	test("server id 1 while client request 1 is pending doesn't resolve it", async () => {
		const { client, written, feed } = memoryClient();
		const requests: Array<{ id: unknown; method: string }> = [];
		client.onServerRequest((r) => {
			requests.push({ id: r.id, method: r.method });
		});
		let resolved: unknown;
		const first = client.request("thread/start", {}).then((v) => {
			resolved = v;
		});
		expect(written[0].id).toBe(1);
		feed({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
		await Bun.sleep(5);
		expect(requests).toEqual([{ id: 1, method: "item/commandExecution/requestApproval" }]);
		expect(resolved).toBeUndefined();
		feed({ id: 1, result: { ok: true } });
		await first;
		expect(resolved).toEqual({ ok: true });
	});

	test("id 0 is a request id like any other", async () => {
		const { client, feed } = memoryClient();
		const seen: unknown[] = [];
		client.onServerRequest((r) => {
			seen.push(r.id);
		});
		feed({ id: 0, method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		expect(seen).toEqual([0]);
	});

	test('a string id "1" round-trips as a string and does not resolve client request 1', async () => {
		const { client, written, feed } = memoryClient();
		client.onServerRequest((r) => {
			client.respond(r.id, { done: true });
		});
		let resolved = false;
		const first = client.request("m").then(() => {
			resolved = true;
		});
		feed({ id: "1", method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		expect(written[1]).toEqual({ id: "1", result: { done: true } });
		expect(resolved).toBe(false);
		// A string-id response is not an answer to our numeric request either.
		feed({ id: "1", result: {} });
		await Bun.sleep(5);
		expect(resolved).toBe(false);
		feed({ id: 1, result: {} });
		await first;
		expect(resolved).toBe(true);
	});

	test("no handler means -32601, written once", async () => {
		const { written, feed } = memoryClient();
		feed({ id: 7, method: "attestation/generate", params: {} });
		await Bun.sleep(5);
		expect(written).toEqual([
			{ id: 7, error: { code: RPC_METHOD_NOT_FOUND, message: "Method not found" } },
		]);
		expect(RPC_METHOD_NOT_FOUND).toBe(-32601);
	});

	test("a request is answered once: a second answer is refused and writes nothing", async () => {
		const { client, written, feed } = memoryClient();
		client.onServerRequest(() => {});
		feed({ id: 5, method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		expect(client.respond(5, { a: 1 })).toBe(true);
		expect(client.respond(5, { a: 2 })).toBe(false);
		expect(client.respondError(5, -1, "late")).toBe(false);
		expect(written).toEqual([{ id: 5, result: { a: 1 } }]);
	});

	test('a numeric id and the string of it are different requests: respond("1") does not answer id 1', async () => {
		const { client, written, feed } = memoryClient();
		client.onServerRequest(() => {});
		feed({ id: 1, method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		expect(client.respond("1", { wrong: true })).toBe(false);
		expect(written).toEqual([]);
		expect(client.respond(1, { right: true })).toBe(true);
		expect(written).toEqual([{ id: 1, result: { right: true } }]);
	});

	test("an id the server never sent can't be answered", () => {
		const { client, written } = memoryClient();
		expect(client.respond(99, {})).toBe(false);
		expect(written).toEqual([]);
	});

	test("a handler that throws leaves the request answered -32603, once", async () => {
		const { client, written, feed } = memoryClient();
		client.onServerRequest(() => {
			throw new Error("boom");
		});
		feed({ id: 3, method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		expect(written).toEqual([{ id: 3, error: { code: -32603, message: "Internal error" } }]);
	});

	test("a handler that answered before it threw is not answered again", async () => {
		const { client, written, feed } = memoryClient();
		client.onServerRequest((r) => {
			client.respond(r.id, { fine: true });
			throw new Error("after");
		});
		feed({ id: 3, method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		expect(written).toEqual([{ id: 3, result: { fine: true } }]);
	});

	test("a malformed frame is ignored without throwing, and a request with an unusable id is not dispatched", async () => {
		const { client, feed } = memoryClient();
		const seen: unknown[] = [];
		client.onServerRequest((r) => {
			seen.push(r.id);
		});
		expect(() => client.receive("{{{ not json\n")).not.toThrow();
		feed({ id: null, method: "item/tool/call" });
		feed({ id: { a: 1 }, method: "item/tool/call" });
		feed({ id: 2, method: "item/tool/call" });
		await Bun.sleep(5);
		expect(seen).toEqual([2]);
	});

	test("closing the client forgets unanswered requests", async () => {
		const { client, written, feed } = memoryClient();
		client.onServerRequest(() => {});
		feed({ id: 1, method: "item/tool/call", params: {} });
		await Bun.sleep(5);
		client.transportClosed();
		expect(client.respond(1, {})).toBe(false);
		expect(written).toEqual([]);
	});

	test("a request from a real child round-trips over the pipes", async () => {
		const app = await startFake({
			FAKE_CODEX_REQUESTS: JSON.stringify([{ method: "item/tool/call", id: "abc" }]),
		});
		app.client.onServerRequest((r) => {
			app.client.respond(r.id, { contentItems: [], success: false });
		});
		await app.client.request("turn/start", {}, { timeoutMs: 5_000 });
		await waitUntil(() => readFakeLog(logPath).some((e) => e.answer));
		expect(readFakeLog(logPath).find((e) => e.answer)?.answer).toEqual({
			id: "abc",
			result: { contentItems: [], success: false },
		});
	});
});

describe("no listener", () => {
	test("nothing under src/supervisor can start a socket listener for the app-server or kill it around the helper", () => {
		const root = join(import.meta.dir, "..");
		const forbidden = /--listen|findFreePort|waitForServer|managedCodexUrl|serverProcess\.kill/;
		const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: root })].filter(
			(name) => !name.endsWith(".test.ts"),
		);
		// Floor and named member: a scan of nothing proves nothing.
		expect(files.length).toBeGreaterThan(20);
		expect(files).toContain("providers/codex-rpc.ts");
		const offenders = files.filter((name) =>
			forbidden.test(readFileSync(join(root, name), "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
