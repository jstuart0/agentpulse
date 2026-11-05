/**
 * The fake app-server against the answers recorded from a real Codex 0.163.0
 * (__fixtures__/codex-0.163-thread-resume.json). No binary is needed: the file was recorded once, and
 * codex-resume.real.test.ts asserts it against a real Codex wherever one is installed. Together they keep
 * the fake honest: a field the provider reads, a sandbox shape or an error shape that drifts fails here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCodex } from "./__fixtures__/fake-codex.js";

const RECORDED = JSON.parse(
	readFileSync(new URL("./__fixtures__/codex-0.163-thread-resume.json", import.meta.url), "utf8"),
);
const THREAD = "01a1ab60-0000-7000-8000-000000000009";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ap-fake-parity-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function fakeAnswers(env: Record<string, string> = {}) {
	const executable = installFakeCodex(dir);
	const child = spawn(executable, ["app-server"], {
		env: {
			...process.env,
			FAKE_CODEX_VERSION: "0.163.0",
			FAKE_CODEX_THREAD_ID: THREAD,
			FAKE_CODEX_THREAD_CWD: dir,
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const answers = new Map<number, any>();
	let buffer = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const message = JSON.parse(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
			if (message.id !== undefined && message.method === undefined)
				answers.set(message.id, message);
		}
	});
	let next = 0;
	const ask = async (method: string, params: unknown) => {
		const id = ++next;
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		for (let i = 0; i < 150 && !answers.has(id); i++) await Bun.sleep(20);
		return answers.get(id);
	};
	await ask("initialize", { clientInfo: { name: "x" }, capabilities: {} });
	return {
		ask,
		stop: () => {
			try {
				process.kill(-(child.pid as number), "SIGKILL");
			} catch {}
		},
	};
}

const keys = (value: unknown) => Object.keys((value ?? {}) as object).sort();
const typeOf = (value: unknown) =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

describe("the fake's answers equal the recorded real ones", () => {
	test("thread/read: result keys, thread keys, status keys, and a null `environments` as a real read has it", async () => {
		const fake = await fakeAnswers();
		try {
			const read = (await fake.ask("thread/read", { threadId: THREAD, includeTurns: false }))
				.result;
			expect(keys(read)).toEqual(RECORDED.read.keys);
			expect(keys(read.thread)).toEqual(RECORDED.read.threadKeys);
			expect(keys(read.thread.status)).toEqual(RECORDED.read.statusKeys);
			expect(read.thread.environments).toBeNull();
		} finally {
			fake.stop();
		}
	});

	test("thread/resume: result keys, thread keys, status keys, environments[0] keys, and the sandbox for both shapes", async () => {
		const fake = await fakeAnswers();
		try {
			const resumed = (
				await fake.ask("thread/resume", {
					threadId: THREAD,
					excludeTurns: true,
					approvalPolicy: "untrusted",
					sandbox: "workspace-write",
				})
			).result;
			expect(keys(resumed)).toEqual(RECORDED.resume.keys);
			expect(keys(resumed.thread)).toEqual(RECORDED.resume.threadKeys);
			expect(keys(resumed.thread.status)).toEqual(RECORDED.resume.statusKeys);
			expect(keys(resumed.thread.environments[0])).toEqual(RECORDED.resume.environmentKeys);
			expect(resumed.sandbox).toEqual(RECORDED.sandbox.workspaceWrite);
		} finally {
			fake.stop();
		}
		const second = await fakeAnswers();
		try {
			const readOnly = (
				await second.ask("thread/resume", {
					threadId: THREAD,
					excludeTurns: true,
					sandbox: "read-only",
				})
			).result;
			expect(readOnly.sandbox).toEqual(RECORDED.sandbox.readOnly);
		} finally {
			second.stop();
		}
	});

	test("every field the provider reads has the recorded type", async () => {
		const fake = await fakeAnswers();
		try {
			const read = (await fake.ask("thread/read", { threadId: THREAD, includeTurns: false }))
				.result;
			const resumed = (
				await fake.ask("thread/resume", {
					threadId: THREAD,
					excludeTurns: true,
					approvalPolicy: "untrusted",
					sandbox: "workspace-write",
				})
			).result;
			const observed = {
				"thread.id": typeOf(read.thread.id),
				"thread.cwd": typeOf(read.thread.cwd),
				"thread.originator": typeOf(read.thread.originator),
				"thread.status.type": typeOf(read.thread.status.type),
				"result.approvalPolicy": typeOf(resumed.approvalPolicy),
				"result.sandbox": typeOf(resumed.sandbox),
				"result.sandbox.type": typeOf(resumed.sandbox.type),
				"result.cwd": typeOf(resumed.cwd),
			};
			expect(observed).toEqual(RECORDED.types);
		} finally {
			fake.stop();
		}
	});

	test("the three error cases have the recorded shape: {code, message}, code -32600, and the recorded wording", async () => {
		const fake = await fakeAnswers();
		try {
			const notLoaded = (
				await fake.ask("thread/read", {
					threadId: "01a1aaff-0000-7000-8000-000000000000",
					includeTurns: false,
				})
			).error;
			const noRollout = (
				await fake.ask("thread/resume", { threadId: "01a1aaff-0000-7000-8000-000000000000" })
			).error;
			expect(keys(notLoaded)).toEqual(RECORDED.errors.notLoaded.keys);
			expect(notLoaded.code).toBe(RECORDED.errors.notLoaded.code);
			expect(notLoaded.message.startsWith(RECORDED.errors.notLoaded.messagePrefix)).toBe(true);
			expect(keys(noRollout)).toEqual(RECORDED.errors.noRollout.keys);
			expect(noRollout.code).toBe(RECORDED.errors.noRollout.code);
			expect(noRollout.message.startsWith(RECORDED.errors.noRollout.messagePrefix)).toBe(true);
		} finally {
			fake.stop();
		}
		const lockFile = join(dir, "writer.lock");
		const first = await fakeAnswers({ FAKE_CODEX_LOCK_FILE: lockFile });
		const second = await fakeAnswers({ FAKE_CODEX_LOCK_FILE: lockFile });
		try {
			await first.ask("thread/resume", { threadId: THREAD, excludeTurns: true });
			const held = (await second.ask("thread/resume", { threadId: THREAD, excludeTurns: true }))
				.error;
			expect(keys(held)).toEqual(RECORDED.errors.activeWriter.keys);
			expect(held.code).toBe(RECORDED.errors.activeWriter.code);
			expect(held.message).toContain(RECORDED.errors.activeWriter.messageContains);
		} finally {
			first.stop();
			second.stop();
		}
	});
});
