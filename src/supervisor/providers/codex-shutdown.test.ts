/**
 * Shutdown order for the managed Codex child (AGEN-87, D20): stdin closes first, a child still there after
 * the wait gets SIGTERM to its process group, then SIGKILL; a child that already left gets nothing. Real
 * child processes, short waits.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import { type CodexAppServer, startCodexAppServer } from "./codex-rpc.js";

const TIMINGS = { stdinCloseMs: 250, termMs: 400, killMs: 800 };
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

let dir: string;
let fakeCodex: string;
let logPath: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ap-codex-shutdown-"));
	fakeCodex = installFakeCodex(dir);
	logPath = join(dir, "fake.log");
	return () => rmSync(dir, { recursive: true, force: true });
});

const started: CodexAppServer[] = [];
const strays: number[] = [];
afterEach(async () => {
	for (const app of started.splice(0)) await app.shutdown();
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	rmSync(logPath, { force: true });
});

async function startFake(env: Record<string, string> = {}) {
	const app = await startCodexAppServer({
		executable: fakeCodex,
		env: { ...process.env, FAKE_CODEX_LOG: logPath, ...env },
		timings: TIMINGS,
		log: () => {},
	});
	started.push(app);
	// The fake logs once it is running; wait for that so signals can be handled.
	const deadline = Date.now() + 5_000;
	while (readFakeLog(logPath).length === 0) {
		if (Date.now() > deadline) throw new Error("the fake never started");
		await Bun.sleep(10);
	}
	await Bun.sleep(50);
	return app;
}

const signalsSent = (spy: { mock: { calls: unknown[][] } }) =>
	spy.mock.calls.filter((call) => call[1] !== 0).map((call) => [call[0], call[1]]);
const logged = (key: string) => readFakeLog(logPath).filter((e) => key in e);

describe("shutdown order", () => {
	test("a well-behaved child exits on stdin close and is never signalled", async () => {
		const app = await startFake();
		const kill = spyOn(process, "kill");
		try {
			await app.shutdown();
			expect(signalsSent(kill)).toEqual([]);
		} finally {
			kill.mockRestore();
		}
		expect(logged("stdinEnd")).toHaveLength(1);
		expect(logged("signal")).toEqual([]);
		expect(alive(readFakeLog(logPath)[0].pid)).toBe(false);
	});

	test("child ignores stdin close: it gets SIGTERM to its group after the wait, and leaves", async () => {
		const app = await startFake({ FAKE_CODEX_IGNORE_STDIN_CLOSE: "1" });
		const kill = spyOn(process, "kill");
		const began = Date.now();
		try {
			await app.shutdown();
			expect(signalsSent(kill)).toEqual([[-app.pid, "SIGTERM"]]);
		} finally {
			kill.mockRestore();
		}
		expect(Date.now() - began).toBeGreaterThanOrEqual(TIMINGS.stdinCloseMs - 20);
		const entries = readFakeLog(logPath);
		const order = entries.map((e) => (e.stdinEnd ? "stdinEnd" : e.signal)).filter(Boolean);
		expect(order).toEqual(["stdinEnd", "SIGTERM"]);
		expect(alive(entries[0].pid)).toBe(false);
	});

	test("child ignores stdin close and SIGTERM: it gets SIGKILL after the second wait", async () => {
		const app = await startFake({
			FAKE_CODEX_IGNORE_STDIN_CLOSE: "1",
			FAKE_CODEX_IGNORE_TERM: "1",
		});
		const kill = spyOn(process, "kill");
		const began = Date.now();
		try {
			await app.shutdown();
			expect(signalsSent(kill)).toEqual([
				[-app.pid, "SIGTERM"],
				[-app.pid, "SIGKILL"],
			]);
		} finally {
			kill.mockRestore();
		}
		expect(Date.now() - began).toBeGreaterThanOrEqual(TIMINGS.stdinCloseMs + TIMINGS.termMs - 40);
		expect(logged("signal").map((e) => e.signal)).toEqual(["SIGTERM"]);
		expect(alive(readFakeLog(logPath)[0].pid)).toBe(false);
	});

	test("a grandchild in the child's group dies with it", async () => {
		const app = await startFake({
			FAKE_CODEX_IGNORE_STDIN_CLOSE: "1",
			FAKE_CODEX_IGNORE_TERM: "1",
			FAKE_CODEX_GRANDCHILD: "1",
		});
		const grandchild = logged("grandchild")[0].grandchild as number;
		strays.push(grandchild);
		expect(alive(grandchild)).toBe(true);
		await app.shutdown();
		expect(alive(grandchild)).toBe(false);
	});

	test("a grandchild left behind by a child that exited on its own is still cleaned up", async () => {
		const app = await startFake({ FAKE_CODEX_GRANDCHILD: "1" });
		const grandchild = logged("grandchild")[0].grandchild as number;
		strays.push(grandchild);
		await app.shutdown();
		expect(alive(grandchild)).toBe(false);
	});

	test("a second shutdown is harmless: the same promise, and no further signal", async () => {
		const app = await startFake({ FAKE_CODEX_IGNORE_STDIN_CLOSE: "1" });
		const kill = spyOn(process, "kill");
		try {
			const first = app.shutdown();
			const second = app.shutdown();
			await Promise.all([first, second]);
			await app.shutdown();
			expect(signalsSent(kill)).toEqual([[-app.pid, "SIGTERM"]]);
		} finally {
			kill.mockRestore();
		}
		expect(logged("signal")).toHaveLength(1);
	});

	test("a child that has already exited is given no signal", async () => {
		const app = await startFake();
		const closed = new Promise<void>((resolve) => app.client.onClose(() => resolve()));
		process.kill(app.pid, "SIGKILL");
		await closed;
		await Bun.sleep(50);
		const kill = spyOn(process, "kill");
		try {
			await app.shutdown();
			expect(signalsSent(kill)).toEqual([]);
		} finally {
			kill.mockRestore();
		}
	});

	test("stdin closes before any signal is sent", async () => {
		const app = await startFake({ FAKE_CODEX_IGNORE_STDIN_CLOSE: "1" });
		await app.shutdown();
		const entries = readFakeLog(logPath);
		const stdinEnd = entries.findIndex((e) => e.stdinEnd);
		const signal = entries.findIndex((e) => e.signal);
		expect(stdinEnd).toBeGreaterThanOrEqual(0);
		expect(signal).toBeGreaterThan(stdinEnd);
	});

	test("a frame over the limit also escalates against a child that ignores stdin close", async () => {
		const app = await startCodexAppServer({
			executable: fakeCodex,
			env: { ...process.env, FAKE_CODEX_LOG: logPath, FAKE_CODEX_IGNORE_STDIN_CLOSE: "1" },
			maxFrameBytes: 8,
			timings: TIMINGS,
			log: () => {},
		});
		started.push(app);
		await expect(app.client.request("initialize", {}, { timeoutMs: 5_000 })).rejects.toThrow(
			/size limit/,
		);
		const pid = readFakeLog(logPath)[0].pid;
		const deadline = Date.now() + 5_000;
		while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
		expect(alive(pid)).toBe(false);
		expect(logged("signal").map((e) => e.signal)).toEqual(["SIGTERM"]);
	});

	test("a frame over the limit closes the client and ends the child without being asked", async () => {
		const app = await startCodexAppServer({
			executable: fakeCodex,
			env: { ...process.env, FAKE_CODEX_LOG: logPath },
			maxFrameBytes: 8,
			timings: TIMINGS,
			log: () => {},
		});
		started.push(app);
		await expect(app.client.request("initialize", {}, { timeoutMs: 5_000 })).rejects.toThrow(
			/size limit/,
		);
		const pid = readFakeLog(logPath)[0].pid;
		const deadline = Date.now() + 5_000;
		while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
		expect(alive(pid)).toBe(false);
	});
});
