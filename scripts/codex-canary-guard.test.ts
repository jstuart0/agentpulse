/**
 * The canary copies the user's Codex `auth.json` into a throwaway CODEX_HOME. Whatever ends the run (a normal
 * exit, a thrown error, Ctrl-C, a terminal closing, a kill) must remove that copy. Each case runs the guard in a
 * child process, because the guard is about how a process ends.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "codex-canary-guard.ts");

const CHILD = `
import { guardAuthCopy } from ${JSON.stringify(GUARD)};
const [file, mode] = process.argv.slice(2);
await Bun.write(file, "secret");
guardAuthCopy(file, () => []);
console.log("ready");
if (mode === "exit") process.exit(0);
if (mode === "throw") throw new Error("boom");
setInterval(() => {}, 1000);
`;

async function run(mode: string, signal?: NodeJS.Signals) {
	const dir = mkdtempSync(join(tmpdir(), "canary-guard-"));
	const file = join(dir, "auth.json");
	const script = join(dir, "child.ts");
	writeFileSync(script, CHILD);
	const proc = Bun.spawn(["bun", script, file, mode], { stdout: "pipe", stderr: "pipe" });
	const reader = proc.stdout.getReader();
	let seen = "";
	while (!seen.includes("ready")) {
		const { value, done } = await reader.read();
		if (done) break;
		seen += new TextDecoder().decode(value);
	}
	if (signal) proc.kill(signal);
	const code = await proc.exited;
	const left = existsSync(file);
	rmSync(dir, { recursive: true, force: true });
	return { code, left, seen };
}

describe("codex-canary-guard", () => {
	test("positive control: the copy exists while the child runs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "canary-guard-"));
		const file = join(dir, "auth.json");
		const script = join(dir, "child.ts");
		writeFileSync(script, CHILD);
		const proc = Bun.spawn(["bun", script, file, "wait"], { stdout: "pipe", stderr: "pipe" });
		const reader = proc.stdout.getReader();
		let seen = "";
		while (!seen.includes("ready")) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += new TextDecoder().decode(value);
		}
		expect(existsSync(file)).toBe(true);
		proc.kill("SIGKILL");
		await proc.exited;
		rmSync(dir, { recursive: true, force: true });
	});

	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	] as const) {
		test(`${signal} removes the copy and exits ${code}`, async () => {
			const result = await run("wait", signal);
			expect(result.left).toBe(false);
			expect(result.code).toBe(code);
		});
	}

	test("a normal process.exit removes the copy", async () => {
		const result = await run("exit");
		expect(result.left).toBe(false);
	});

	test("an uncaught error removes the copy and exits non-zero", async () => {
		const result = await run("throw");
		expect(result.left).toBe(false);
		expect(result.code).not.toBe(0);
	});
});
