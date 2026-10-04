/**
 * What the direct installers tell the user about the exclude rules:
 *  - an installer that writes Codex hooks ends with the Codex re-approve
 *    line (the hook command changed, so Codex asks again) — only when it
 *    really wrote them, not when they were already up to date;
 *  - an installer that writes Codex or Copilot hooks says to run
 *    `agentpulse exclude check` after hand-editing the rules file;
 *  - the Claude Code statusline is offered behind --statusline, off by
 *    default, with one line saying it exists.
 *
 * Every run uses a throwaway HOME (and no CODEX_HOME), so nothing here can
 * touch a real ~/.codex, ~/.claude, ~/.copilot or ~/.agentpulse.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../src/server/db/__test_db.js";
import {
	CODEX_APPROVE_LINE,
	CODEX_REAPPROVE_LINE,
	EXCLUDE_CHECK_HINT,
	STATUSLINE_OFFER_LINE,
} from "../src/shared/hook-headers.js";

// These tests start real shell installers; under load one can take longer than Bun's 5 s default.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const SETUP_HOOKS = join(ROOT, "scripts", "setup-hooks.sh");
const CLI = join(ROOT, "bin", "cli.ts");
const PATH = process.env.PATH ?? "/usr/bin:/bin";

async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "ap-installer-msgs-"));
}

async function spawnCollect(argv: string[], home: string) {
	const proc = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH, HOME: home, SHELL: "/bin/zsh" },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: out + err, stdout: out };
}

const runSetupHooks = (home: string, ...extra: string[]) =>
	spawnCollect(
		["bash", SETUP_HOOKS, "--url", "http://127.0.0.1:1", "--key", "ap_test_key", ...extra],
		home,
	);
const runCliSetup = (home: string, ...extra: string[]) =>
	spawnCollect(["bun", CLI, "setup", "--url", "http://127.0.0.1:1", ...extra], home);

const lastLine = (text: string) => text.trimEnd().split("\n").pop()?.trim() ?? "";

describe("setup-hooks.sh — Codex", () => {
	test("a fresh install ends with the plain approve line (nothing to 're'-approve) and prints the exclude hint", async () => {
		const home = await tempHome();
		try {
			const res = await runSetupHooks(home, "--agent", "codex_cli", "--no-auth-check");
			expect(res.code).toBe(0);
			expect(res.out).toContain(EXCLUDE_CHECK_HINT);
			expect(lastLine(res.out)).toBe(CODEX_APPROVE_LINE);
			expect(res.out).not.toContain(CODEX_REAPPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an update that changes the hooks (a new URL) ends with the re-approve line", async () => {
		const home = await tempHome();
		try {
			await runSetupHooks(home, "--agent", "codex_cli", "--no-auth-check");
			const res = await spawnCollect(
				[
					"bash",
					SETUP_HOOKS,
					"--url",
					"http://127.0.0.1:2",
					"--key",
					"ap_test_key",
					"--agent",
					"codex_cli",
					"--no-auth-check",
				],
				home,
			);
			expect(res.code).toBe(0);
			expect(lastLine(res.out)).toBe(CODEX_REAPPROVE_LINE);
			expect(res.out).not.toContain(CODEX_APPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a run that finds the hooks already current does not ask for re-approval, but keeps the hint", async () => {
		const home = await tempHome();
		try {
			await runSetupHooks(home, "--agent", "codex_cli", "--no-auth-check");
			const second = await runSetupHooks(home, "--agent", "codex_cli", "--no-auth-check");
			expect(second.code).toBe(0);
			expect(second.out).toContain("no re-trust needed");
			expect(second.out).toContain(EXCLUDE_CHECK_HINT);
			expect(lastLine(second.out)).not.toBe(CODEX_REAPPROVE_LINE);
			expect(second.out).not.toContain(CODEX_REAPPROVE_LINE);
			expect(second.out).not.toContain(CODEX_APPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("setup-hooks.sh — Copilot", () => {
	test("writing Copilot hooks prints the exclude hint and no Codex line", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".copilot"), { recursive: true });
			const res = await runSetupHooks(home, "--agent", "copilot_cli", "--no-auth-check");
			expect(res.code).toBe(0);
			expect(res.out).toContain(EXCLUDE_CHECK_HINT);
			expect(res.out).not.toContain(CODEX_REAPPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("setup-hooks.sh — Claude Code statusline", () => {
	test("off by default: one line says it exists, nothing is installed", async () => {
		const home = await tempHome();
		try {
			const res = await runSetupHooks(home, "--no-auth-check");
			expect(res.code).toBe(0);
			expect(res.out).toContain(STATUSLINE_OFFER_LINE);
			expect(res.out.split(STATUSLINE_OFFER_LINE)).toHaveLength(2);
			await expect(stat(join(home, ".claude", "statusline-agentpulse.sh"))).rejects.toThrow();
			expect(await readFile(join(home, ".claude", "settings.json"), "utf-8")).not.toContain(
				"statusLine",
			);
			expect(res.out).not.toContain(EXCLUDE_CHECK_HINT);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--statusline installs it, enables it when no statusLine is set, and drops the offer line", async () => {
		const home = await tempHome();
		try {
			const res = await runSetupHooks(home, "--no-auth-check", "--statusline");
			expect(res.code).toBe(0);
			expect(res.out).not.toContain(STATUSLINE_OFFER_LINE);
			const installed = join(home, ".claude", "statusline-agentpulse.sh");
			expect((await stat(installed)).mode & 0o111).not.toBe(0);
			expect(await readFile(installed, "utf-8")).toBe(
				await readFile(join(ROOT, "scripts", "statusline.sh"), "utf-8"),
			);
			const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
			expect(settings.statusLine).toEqual({
				type: "command",
				command: "~/.claude/statusline-agentpulse.sh",
			});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--statusline never replaces someone else's statusLine", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await writeFile(
				join(home, ".claude", "settings.json"),
				JSON.stringify({ statusLine: { type: "command", command: "my-own-line" } }),
			);
			const res = await runSetupHooks(home, "--no-auth-check", "--statusline");
			expect(res.code).toBe(0);
			expect(res.out).toContain("already has a statusLine");
			const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
			expect(settings.statusLine.command).toBe("my-own-line");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--help lists the flag", async () => {
		const home = await tempHome();
		try {
			const res = await spawnCollect(["bash", SETUP_HOOKS, "--help"], home);
			expect(res.out).toContain("--statusline");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("agentpulse setup", () => {
	test("a fresh install: the output ends with the approve line and carries the exclude hint", async () => {
		const home = await tempHome();
		try {
			const res = await runCliSetup(home);
			expect(res.code).toBe(0);
			expect(res.out).toContain(EXCLUDE_CHECK_HINT);
			expect(lastLine(res.out)).toBe(CODEX_APPROVE_LINE);
			expect(res.out).not.toContain(CODEX_REAPPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("an update that changes the hooks (a new URL): the re-approve line", async () => {
		const home = await tempHome();
		try {
			await runCliSetup(home);
			const res = await spawnCollect(["bun", CLI, "setup", "--url", "http://127.0.0.1:2"], home);
			expect(lastLine(res.out)).toBe(CODEX_REAPPROVE_LINE);
			expect(res.out).not.toContain(CODEX_APPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("hooks already current: neither line", async () => {
		const home = await tempHome();
		try {
			await runCliSetup(home);
			const second = await runCliSetup(home);
			expect(second.out).toContain("Codex hooks unchanged");
			expect(second.out).not.toContain(CODEX_REAPPROVE_LINE);
			expect(second.out).not.toContain(CODEX_APPROVE_LINE);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("Copilot detected: the exclude hint is printed", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".copilot"), { recursive: true });
			const res = await runCliSetup(home);
			expect(res.out).toContain("Copilot CLI hooks");
			expect(res.out).toContain(EXCLUDE_CHECK_HINT);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("the statusline is off by default with one line saying it exists, and --statusline installs it", async () => {
		const home = await tempHome();
		try {
			const plain = await runCliSetup(home);
			expect(plain.out).toContain(STATUSLINE_OFFER_LINE);
			await expect(stat(join(home, ".claude", "statusline-agentpulse.sh"))).rejects.toThrow();

			const withLine = await runCliSetup(home, "--statusline");
			expect(withLine.out).not.toContain(STATUSLINE_OFFER_LINE);
			expect((await readdir(join(home, ".claude"))).includes("statusline-agentpulse.sh")).toBe(
				true,
			);
			const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
			expect(settings.statusLine.command).toBe("~/.claude/statusline-agentpulse.sh");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("--statusline never replaces someone else's statusLine", async () => {
		const home = await tempHome();
		try {
			await mkdir(join(home, ".claude"), { recursive: true });
			await writeFile(
				join(home, ".claude", "settings.json"),
				JSON.stringify({ statusLine: { type: "command", command: "my-own-line" } }),
			);
			const res = await runCliSetup(home, "--statusline");
			expect(res.out).toContain("already has a statusLine");
			const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf-8"));
			expect(settings.statusLine.command).toBe("my-own-line");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("the other installers carry the same lines", () => {
	test("the rendered /setup.sh carries both Codex lines (approve on a fresh install, re-approve on an update) and the exclude hint", async () => {
		const { setup } = await import("../src/server/routes/setup.ts");
		const app = new Hono().route("/", setup);
		const res = await app.request("http://localhost/setup.sh", {
			headers: { Host: "localhost:3000" },
		});
		const script = await res.text();
		expect(script).toContain(EXCLUDE_CHECK_HINT);
		expect(script).toContain(CODEX_REAPPROVE_LINE);
		expect(script).toContain(CODEX_APPROVE_LINE);
		// the approval line is the script's final output
		const tail = script.trimEnd().split("\n").slice(-8).join("\n");
		expect(tail).toContain(CODEX_REAPPROVE_LINE);
		expect(tail).toContain(CODEX_APPROVE_LINE);
	});

	test("setup-relay.sh carries the hint and both Codex lines", async () => {
		const source = await readFile(join(ROOT, "scripts", "setup-relay.sh"), "utf-8");
		expect(source).toContain(EXCLUDE_CHECK_HINT);
		expect(source).toContain(CODEX_REAPPROVE_LINE);
		expect(source).toContain(CODEX_APPROVE_LINE);
	});

	test("install-local.ps1 carries the hint and both Codex lines, chosen by whether a hooks file existed (never executed)", async () => {
		const source = await readFile(join(ROOT, "scripts", "install-local.ps1"), "utf-8");
		expect(source).toContain(EXCLUDE_CHECK_HINT);
		expect(source).toContain(CODEX_REAPPROVE_LINE);
		expect(source).toContain(CODEX_APPROVE_LINE);
		expect(source).toContain('$script:CodexHooksWritten = "updated"');
		expect(source).toContain('$script:CodexHooksWritten = "new"');
	});
});
