/**
 * Guard for the test-isolation incident (2026-09-30): a supervisor.json
 * write, a `.zshrc` append, and a `~/.agentpulse/env` create all landed in a
 * real developer home from a test run. bunfig.toml's [test] preload
 * (test-env-defaults.ts) now redirects every home-derived env var to a
 * per-process temp directory and patches node:os's homedir() and
 * Bun.spawn's/Bun.spawnSync's default env to match — this file proves each
 * of those three closes the specific gap it targets, so a regression in the
 * preload fails loudly here instead of silently writing into someone's real
 * home again.
 */
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { ORIGINAL_HOME_ENV, TEST_HOME_SANDBOX_ROOT } from "./test-env-defaults.js";

describe("test-env-defaults.ts home sandbox", () => {
	test("the sandbox root lives under the OS temp dir, not the real home", () => {
		expect(TEST_HOME_SANDBOX_ROOT.startsWith(tmpdir())).toBe(true);
		if (ORIGINAL_HOME_ENV.HOME) {
			expect(TEST_HOME_SANDBOX_ROOT).not.toBe(ORIGINAL_HOME_ENV.HOME);
			expect(TEST_HOME_SANDBOX_ROOT.startsWith(ORIGINAL_HOME_ENV.HOME)).toBe(false);
		}
	});

	test("process.env.HOME/USERPROFILE point at the sandbox root", () => {
		expect(process.env.HOME).toBe(TEST_HOME_SANDBOX_ROOT);
		expect(process.env.USERPROFILE).toBe(TEST_HOME_SANDBOX_ROOT);
	});

	test("os.homedir() reflects the sandbox root, not Bun's cached real value (Finding #1)", () => {
		// This is the actual regression this preload exists to prevent: on
		// Bun 1.3.12, os.homedir() resolves once and ignores a later
		// process.env.HOME mutation entirely — without the mock.module patch
		// in test-env-defaults.ts, this assertion fails and returns the real
		// developer home instead.
		expect(homedir()).toBe(TEST_HOME_SANDBOX_ROOT);
	});

	test("a subprocess spawned with no explicit env still inherits the sandboxed HOME (Finding #2)", async () => {
		// Bun.spawn's default (env omitted) is a snapshot of the process's
		// OWN startup environment, not a live read of process.env — proven
		// empirically during the 2026-09-30 investigation (a real `codex`
		// CLI invocation wrote into the ambient $HOME even after this exact
		// kind of mid-process override, because the spawn call it went
		// through never passed `env`). Without the Bun.spawn patch in
		// test-env-defaults.ts, this prints the developer's real $HOME.
		const proc = Bun.spawn(["bash", "-c", 'printf %s "$HOME"'], { stdout: "pipe" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out).toBe(TEST_HOME_SANDBOX_ROOT);
	});

	test("Bun.spawnSync with no explicit env also inherits the sandboxed HOME", () => {
		const proc = Bun.spawnSync(["bash", "-c", 'printf %s "$HOME"'], { stdout: "pipe" });
		expect(proc.stdout?.toString()).toBe(TEST_HOME_SANDBOX_ROOT);
	});

	test("a caller-supplied explicit env is never overridden by the patch", async () => {
		const explicit = "/explicit-env-was-respected";
		const proc = Bun.spawn(["bash", "-c", 'printf %s "$HOME"'], {
			stdout: "pipe",
			env: { HOME: explicit, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		expect(out).toBe(explicit);
	});
});
