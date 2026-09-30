/**
 * Phase 5 ([plan+] F38, r6 item 10): opt-in live smoke against a real Codex
 * CLI. Skipped by default — `bun test` in CI/dev never runs this. Set
 * AGENTPULSE_LIVE_CODEX=1 and have `codex` on PATH to run it for real.
 *
 * Proves, against the real CLI (not a stub), that: the D12-shape hooks file
 * loads with no parse/async-skip/clamp warnings, at least 5 of the 6
 * `codex exec`-triggerable events actually fire, and the detached shim
 * doesn't delay the turn (D13's non-blocking claim — see item 10's
 * turn-not-delayed assertion, the empirical proof Codex doesn't wait on the
 * detached child; see D13).
 *
 * Uses a temp CODEX_HOME (never the user's real ~/.codex) containing the
 * generated hooks.json and a copy of the user's real auth.json (needed for
 * `codex exec` to have a session; no prompts or tool calls touch anything
 * outside <tmp>).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexHooksFile } from "../src/shared/hook-command.js";

const LIVE = process.env.AGENTPULSE_LIVE_CODEX === "1";
const CODEX_ON_PATH = Boolean(Bun.which("codex"));
const RUN = LIVE && CODEX_ON_PATH;

const SPIKE_MD = join(import.meta.dir, "../src/server/services/agents/__fixtures__/SPIKE.md");

type Recorded = { event: string; agentType: string | null; body: string };

function startCaptureServer(delayMs = 0) {
	const captured: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = await req.text();
			if (delayMs > 0) await Bun.sleep(delayMs);
			captured.push({
				event: url.searchParams.get("event") ?? "",
				agentType: req.headers.get("x-agent-type"),
				body,
			});
			return new Response("ok", { status: 200 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, captured, stop: () => server.stop(true) };
}

async function runCodexExec(codexHome: string, cwd: string, prompt: string) {
	const proc = Bun.spawn(["codex", "exec", "--dangerously-bypass-hook-trust", "-C", cwd, prompt], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CODEX_HOME: codexHome, HOME: process.env.HOME ?? homedir() },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr };
}

describe.skipIf(!RUN)("codex-live-smoke (opt-in, AGENTPULSE_LIVE_CODEX=1 + codex on PATH)", () => {
	let root: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "ap-codex-live-smoke-"));
	});

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	test("hooks file loads clean, >=5 events fire, and the turn isn't delayed by the detached shim", async () => {
		const realAuth = join(process.env.HOME ?? homedir(), ".codex", "auth.json");
		const hasRealAuth = await Bun.file(realAuth).exists();
		expect(hasRealAuth, "no ~/.codex/auth.json — log in with `codex login` first").toBe(true);

		const project = join(root, "project");
		await mkdir(project, { recursive: true });

		// Instant capture server: proves the hooks file parses/fires clean.
		const instant = startCaptureServer(0);
		const codexHomeInstant = join(root, "codex-home-instant");
		await mkdir(codexHomeInstant, { recursive: true });
		await cp(realAuth, join(codexHomeInstant, "auth.json"));
		await writeFile(
			join(codexHomeInstant, "hooks.json"),
			buildCodexHooksFile({ baseUrl: instant.url, direct: false }),
		);

		const startInstant = performance.now();
		const runInstant = await runCodexExec(
			codexHomeInstant,
			project,
			"run `echo agentpulse-live-smoke` and stop",
		);
		const wallInstant = performance.now() - startInstant;

		expect(runInstant.stderr).not.toContain("failed to parse hooks config");
		expect(runInstant.stderr).not.toContain("skipping async hook");
		expect(runInstant.stderr).not.toContain("clamping");

		const deadlineInstant = Date.now() + 5000;
		while (instant.captured.length < 2 && Date.now() < deadlineInstant) {
			await Bun.sleep(100);
		}
		const seenEvents = new Set(instant.captured.map((c) => c.event));
		const expectedAny = [
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"Stop",
			"SessionEnd",
		];
		const seenCount = expectedAny.filter((e) => seenEvents.has(e)).length;
		expect(seenCount).toBeGreaterThanOrEqual(5);
		instant.stop();

		// Delayed capture server: this is the empirical proof the shim
		// doesn't block on the detached child — see D13. A Codex that
		// waited on an inherited fd would show ~5s of wall-time delta here,
		// not <1.5s.
		const delayed = startCaptureServer(5000);
		const codexHomeDelayed = join(root, "codex-home-delayed");
		await mkdir(codexHomeDelayed, { recursive: true });
		await cp(realAuth, join(codexHomeDelayed, "auth.json"));
		await writeFile(
			join(codexHomeDelayed, "hooks.json"),
			buildCodexHooksFile({ baseUrl: delayed.url, direct: false }),
		);
		const startDelayed = performance.now();
		await runCodexExec(codexHomeDelayed, project, "run `echo agentpulse-live-smoke-2` and stop");
		const wallDelayed = performance.now() - startDelayed;
		delayed.stop();

		const deltaMs = Math.abs(wallDelayed - wallInstant);
		const spikeNote = [
			"",
			"## Phase 5 live smoke (opt-in, codex-live-smoke.test.ts)",
			`- instant-capture wall time: ${wallInstant.toFixed(0)}ms`,
			`- delayed-capture (5s/event) wall time: ${wallDelayed.toFixed(0)}ms`,
			`- delta: ${deltaMs.toFixed(0)}ms (budget: <1500ms — proves the shim doesn't block the turn)`,
			`- events captured (instant run): ${[...seenEvents].sort().join(", ")}`,
			"",
		].join("\n");
		await writeFile(SPIKE_MD, spikeNote, { flag: "a" });

		expect(deltaMs).toBeLessThan(1500);
	}, 60_000);
});
