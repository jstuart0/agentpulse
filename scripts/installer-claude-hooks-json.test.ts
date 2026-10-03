/**
 * Executed check of the Claude Code HTTP hook JSON each installer writes
 * (replacing a regex over source text): run the installer in a throwaway HOME
 * and read ~/.claude/settings.json back. Covers scripts/setup-hooks.sh, the
 * rendered GET /setup.sh (with and without a key), and `agentpulse setup`
 * (with and without a key). The relay installer's own run is asserted in
 * scripts/installers-run.test.ts, which has the stubs it needs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../src/server/db/__test_db.js";
import { expectClaudeHooksCarrySkip } from "./claude-hook-assertions.js";

const ROOT = join(import.meta.dir, "..");
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const homes: string[] = [];
afterAll(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function newHome(): string {
	const home = mkdtempSync(join(tmpdir(), "ap-claude-hooks-json-"));
	homes.push(home);
	return home;
}

function readSettings(home: string) {
	return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
}

async function run(argv: string[], home: string, extraEnv: Record<string, string> = {}) {
	const proc = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH, HOME: home, SHELL: "/bin/zsh", ...extraEnv },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: out + err };
}

/** A server that answers the two probes an installer makes; auth disabled so a key-less install is allowed. */
function authStub() {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/api/v1/auth/me")
				return Response.json({ authenticated: false, disableAuth: true });
			if (path === "/api/v1/health") return Response.json({ status: "ok" });
			return new Response("{}", { status: 200 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function renderedSetupSh(): Promise<string> {
	const { setup } = await import("../src/server/routes/setup.ts");
	const app = new Hono().route("/", setup);
	const res = await app.request("http://localhost/setup.sh", {
		headers: { Host: "localhost:3000" },
	});
	return res.text();
}

const KEY = "ap_literal_test_key";

describe("the Claude hook JSON each installer writes carries the skip header unexpanded", () => {
	test("scripts/setup-hooks.sh with a key: literal Authorization, allowedEnvVars exactly AGENTPULSE_SKIP", async () => {
		const stub = authStub();
		try {
			const home = newHome();
			const res = await run(
				["bash", join(ROOT, "scripts/setup-hooks.sh"), "--url", stub.url, "--key", KEY],
				home,
			);
			expect(res.code, res.out).toBe(0);
			expectClaudeHooksCarrySkip(readSettings(home), {
				allowedEnvVars: ["AGENTPULSE_SKIP"],
				authorization: `Bearer ${KEY}`,
			});
		} finally {
			stub.stop();
		}
	});

	test("the rendered /setup.sh with a key: the same", async () => {
		const stub = authStub();
		try {
			const home = newHome();
			const res = await run(
				["bash", "-c", await renderedSetupSh(), "installer", "--url", stub.url, "--key", KEY],
				home,
			);
			expect(res.code, res.out).toBe(0);
			expectClaudeHooksCarrySkip(readSettings(home), {
				allowedEnvVars: ["AGENTPULSE_SKIP"],
				authorization: `Bearer ${KEY}`,
			});
		} finally {
			stub.stop();
		}
	});

	test("the rendered /setup.sh with no key: the environment form lists the key variable too, and the header is still unexpanded", async () => {
		const stub = authStub();
		try {
			const home = newHome();
			const res = await run(
				["bash", "-c", await renderedSetupSh(), "installer", "--url", stub.url],
				home,
			);
			expect(res.code, res.out).toBe(0);
			expectClaudeHooksCarrySkip(readSettings(home), {
				allowedEnvVars: ["AGENTPULSE_API_KEY", "AGENTPULSE_SKIP"],
				authorization: "Bearer $AGENTPULSE_API_KEY",
			});
		} finally {
			stub.stop();
		}
	});

	test("agentpulse setup with a key", async () => {
		const stub = authStub();
		try {
			const home = newHome();
			const res = await run(
				["bun", join(ROOT, "bin/cli.ts"), "setup", "--url", stub.url, "--key", KEY],
				home,
			);
			expect(res.code, res.out).toBe(0);
			expectClaudeHooksCarrySkip(readSettings(home), {
				allowedEnvVars: ["AGENTPULSE_SKIP"],
				authorization: `Bearer ${KEY}`,
			});
		} finally {
			stub.stop();
		}
	});

	test("agentpulse setup with no key", async () => {
		const stub = authStub();
		try {
			const home = newHome();
			const res = await run(["bun", join(ROOT, "bin/cli.ts"), "setup", "--url", stub.url], home);
			expect(res.code, res.out).toBe(0);
			expectClaudeHooksCarrySkip(readSettings(home), {
				allowedEnvVars: ["AGENTPULSE_API_KEY", "AGENTPULSE_SKIP"],
				authorization: "Bearer $AGENTPULSE_API_KEY",
			});
		} finally {
			stub.stop();
		}
	});
});

describe("a symlinked ~/.claude/settings.json is never severed by the shell installers", () => {
	async function linkedSettings(home: string) {
		const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(home, "dotfiles"), { recursive: true });
		const target = join(home, "dotfiles", "settings.json");
		writeFileSync(target, `${JSON.stringify({ theme: "dark" })}\n`);
		symlinkSync(target, join(home, ".claude", "settings.json"));
		return target;
	}

	async function expectIntact(
		home: string,
		target: string,
		res: { code: number | null; out: string },
	) {
		const { lstatSync } = await import("node:fs");
		expect(lstatSync(join(home, ".claude", "settings.json")).isSymbolicLink(), res.out).toBe(true);
		const after = JSON.parse(readFileSync(target, "utf-8"));
		expect(after.theme).toBe("dark");
		if (res.code === 0) expect(Object.keys(after.hooks ?? {}).length).toBeGreaterThan(0);
		else expect(res.out).toMatch(/refusing to write through a symlink/);
	}

	test("the rendered /setup.sh", async () => {
		const stub = authStub();
		try {
			const home = newHome();
			const target = await linkedSettings(home);
			const res = await run(
				["bash", "-c", await renderedSetupSh(), "installer", "--url", stub.url, "--key", KEY],
				home,
			);
			await expectIntact(home, target, res);
		} finally {
			stub.stop();
		}
	});

	test("scripts/setup-hooks.sh, with and without --statusline", async () => {
		const stub = authStub();
		try {
			for (const extra of [[], ["--statusline"]]) {
				const home = newHome();
				const target = await linkedSettings(home);
				const res = await run(
					["bash", join(ROOT, "scripts/setup-hooks.sh"), "--url", stub.url, "--key", KEY, ...extra],
					home,
				);
				await expectIntact(home, target, res);
			}
		} finally {
			stub.stop();
		}
	});
});
