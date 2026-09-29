/**
 * Phase 5 (D12/D13, r6 detached shape; xander's synchronous-hook safety
 * constraints): replays every Codex fixture through the *generated* sh
 * command with `sh -c` (not bash — Codex runs `command` through the system
 * shell, which is dash on Debian/Ubuntu), against a real stub HTTP server.
 *
 * Also covers item 13's cross-agent safety matrix: no stdout ever, never
 * fails closed, and bounded well under Codex's timeout — even when curl,
 * the server, or the filesystem misbehaves.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBashHookCommand } from "../src/shared/hook-command.js";

const CODEX_FIXTURES_DIR = join(
	import.meta.dir,
	"../src/server/services/agents/__fixtures__/codex",
);
const COPILOT_FIXTURES_DIR = join(
	import.meta.dir,
	"../src/server/services/agents/__fixtures__/copilot",
);

// D32 (F205): a flat 150ms wall-clock bound measures the host, not the
// shim — under real contention (AV scanning every spawn, background VMs,
// browsers) a correctly-detached shim can legitimately take several hundred
// ms of scheduler latency before the OS even runs it. The default assertion
// instead tests the actual contract: comfortably under Codex's own 1s hook
// timeout, and at least 5x faster than a synchronous curl against the same
// endpoint would take. This shim's own curl invocation carries `--max-time
// 2`, so a synchronous mutant of this exact command is bounded at ~2s
// regardless of whether the stub delays or never responds; SYNC_BASELINE_MS
// is a conservative reference (>= that bound) so the 5x margin stays
// meaningful even against slower stub setups. This is the property that
// discriminates a detached shim from a synchronous curl — see the "mutant"
// test below, which proves it.
const DEFAULT_EXIT_BOUND_MS = 750; // comfortably under Codex's own 1s hook timeout (D12/D13)
const SYNC_BASELINE_MS = 5000;
const SYNC_MARGIN_BOUND_MS = SYNC_BASELINE_MS / 5; // 1000ms
// Strict mode (AGENTPULSE_PERF_TESTS=1): the tighter 150ms p95 budget from
// D13's original spec still runs, opt-in — p95 itself is always recorded.
const STRICT_P95_BOUND_MS = 150;
const PERF_TESTS = process.env.AGENTPULSE_PERF_TESTS === "1";

/** D32's default bounded-exit contract — see the block comment above. */
function assertBoundedExit(ms: number) {
	expect(ms).toBeLessThan(DEFAULT_EXIT_BOUND_MS);
	expect(ms).toBeLessThan(SYNC_MARGIN_BOUND_MS);
}

/**
 * D32: strips the backgrounding (`& exit 0` -> `; exit 0`, dropping the `&`
 * that forks the subshell) from a generated command, so the network call
 * runs synchronously in the foreground instead. Used only to prove the
 * default assertion discriminates — see "mutant: a synchronous curl...".
 */
function toSynchronousMutant(cmd: string): string {
	const mutated = cmd.replace(
		/\) <\/dev\/null >\/dev\/null 2>&1 & exit 0$/,
		") </dev/null >/dev/null 2>&1; exit 0",
	);
	if (mutated === cmd) {
		throw new Error(
			"toSynchronousMutant: the detached-tail pattern didn't match — command shape changed?",
		);
	}
	return mutated;
}

type Recorded = {
	method: string;
	path: string;
	search: string;
	body: string;
	headers: Record<string, string>;
};

function startStub(handler?: (req: Request) => Response | Promise<Response>) {
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = await req.text();
			requests.push({
				method: req.method,
				path: url.pathname,
				search: url.search,
				body,
				headers: Object.fromEntries(req.headers),
			});
			if (handler) return handler(req);
			return new Response("ok", { status: 200 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A port nothing listens on — connection refused immediately. */
async function closedPort(): Promise<string> {
	const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
	const url = `http://127.0.0.1:${srv.port}`;
	srv.stop(true);
	return url;
}

/** Bind and hold the connection without ever writing a response. */
function startNeverRespondingStub() {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Promise<Response>(() => {}), // never resolves
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function runSh(
	cmd: string,
	stdin: Uint8Array | string,
	env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string; ms: number }> {
	const start = performance.now();
	const proc = Bun.spawn(["sh", "-c", cmd], {
		stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const ms = performance.now() - start;
	return { exitCode, stdout, stderr, ms };
}

async function waitFor(check: () => boolean, timeoutMs = 3000, stepMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(stepMs);
	}
	return check();
}

let tmp: string;
const stops: Array<() => unknown> = [];

beforeAll(async () => {
	// AGEN-18/F202-style warm-up: pay the first Bun.serve() bind/fetch tax
	// outside any single test's budget.
	const warm = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("warm") });
	await fetch(`http://127.0.0.1:${warm.port}/`);
	warm.stop(true);
});

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-codex-hook-cmd-"));
});

afterEach(async () => {
	while (stops.length) await stops.pop()?.();
	await rm(tmp, { recursive: true, force: true });
}, 15_000);

function baseEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: join(home, "tmp"),
		...extra,
	};
}

async function loadFixture(dir: string, name: string): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(join(dir, `${name}.json`)).arrayBuffer());
}

const CODEX_EVENTS = [
	"SessionStart",
	"SessionEnd",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"Interrupt",
	"SubagentStart",
	"SubagentStop",
	"PermissionRequest",
	"PreCompact",
	"PostCompact",
];

describe("codex-hook-command.test.ts — fixture replay (item 3)", () => {
	for (const event of CODEX_EVENTS) {
		test(`${event}: byte-exact body, right headers and ?event=, delivered detached`, async () => {
			const stub = startStub();
			stops.push(stub.stop);
			const home = join(tmp, `home-${event}`);
			await mkdir(join(home, "tmp"), { recursive: true });

			const cmd = buildBashHookCommand({
				baseUrl: stub.url,
				direct: false,
				agent: "codex_cli",
				event,
			});
			const fixture = await loadFixture(CODEX_FIXTURES_DIR, event);
			const result = await runSh(cmd, fixture, baseEnv(home));

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");

			const delivered = await waitFor(() => stub.requests.length > 0);
			expect(delivered).toBe(true);
			const req = stub.requests[0];
			expect(req.search).toBe(`?event=${event}`);
			expect(req.headers["x-agent-type"]).toBe("codex_cli");
			expect(new TextDecoder().decode(fixture)).toBe(req.body);
		});
	}

	test("SessionEnd replay explicitly", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const home = join(tmp, "home-end");
		await mkdir(join(home, "tmp"), { recursive: true });
		const cmd = buildBashHookCommand({
			baseUrl: stub.url,
			direct: false,
			agent: "codex_cli",
			event: "SessionEnd",
		});
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "SessionEnd");
		await runSh(cmd, fixture, baseEnv(home));
		expect(await waitFor(() => stub.requests.length > 0)).toBe(true);
		expect(stub.requests[0].search).toBe("?event=SessionEnd");
	});

	test("Interrupt replay explicitly", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const home = join(tmp, "home-interrupt");
		await mkdir(join(home, "tmp"), { recursive: true });
		const cmd = buildBashHookCommand({
			baseUrl: stub.url,
			direct: false,
			agent: "codex_cli",
			event: "Interrupt",
		});
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Interrupt");
		await runSh(cmd, fixture, baseEnv(home));
		expect(await waitFor(() => stub.requests.length > 0)).toBe(true);
		expect(stub.requests[0].search).toBe("?event=Interrupt");
	});

	test("exits 0 when the server is unreachable (closed port)", async () => {
		const home = join(tmp, "home-down");
		await mkdir(join(home, "tmp"), { recursive: true });
		const cmd = buildBashHookCommand({
			baseUrl: await closedPort(),
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Stop");
		const result = await runSh(cmd, fixture, baseEnv(home));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("F43: the generated direct command contains no key literal and no $(cat", async () => {
		const home = join(tmp, "home-static");
		await writeFile(join(home, ".secret-marker"), "", { flag: "wx" }).catch(() => {});
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).not.toContain("$(cat");
		expect(cmd).toMatch(/-H "@\$f"/);
	});

	test("F49: hook-auth-header present → Authorization arrives; missing/empty → no Authorization header", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const cmd = buildBashHookCommand({
			baseUrl: stub.url,
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Stop");

		// present
		{
			const home = join(tmp, "home-auth-present");
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await mkdir(join(home, "tmp"), { recursive: true });
			await writeFile(
				join(home, ".agentpulse/hook-auth-header"),
				"Authorization: Bearer ap_test\n",
			);
			await runSh(cmd, fixture, baseEnv(home));
			expect(await waitFor(() => stub.requests.length >= 1)).toBe(true);
			expect(stub.requests.at(-1)?.headers.authorization).toBe("Bearer ap_test");
		}
		// missing
		{
			const home = join(tmp, "home-auth-missing");
			await mkdir(join(home, "tmp"), { recursive: true });
			await runSh(cmd, fixture, baseEnv(home));
			expect(await waitFor(() => stub.requests.length >= 2)).toBe(true);
			expect(stub.requests.at(-1)?.headers.authorization).toBeUndefined();
		}
		// empty file
		{
			const home = join(tmp, "home-auth-empty");
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await mkdir(join(home, "tmp"), { recursive: true });
			await writeFile(join(home, ".agentpulse/hook-auth-header"), "");
			await runSh(cmd, fixture, baseEnv(home));
			expect(await waitFor(() => stub.requests.length >= 3)).toBe(true);
			expect(stub.requests.at(-1)?.headers.authorization).toBeUndefined();
		}
	});
});

describe("codex-hook-command.test.ts — r6 detached-shape timing + cleanup (item 12)", () => {
	test("process exit is bounded (D32: <750ms and 5x margin vs. a synchronous curl) against a never-responding stub; p95 recorded", async () => {
		const never = startNeverRespondingStub();
		stops.push(never.stop);
		const home = join(tmp, "home-timing");
		await mkdir(join(home, "tmp"), { recursive: true });
		const cmd = buildBashHookCommand({
			baseUrl: never.url,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Stop");

		const samples: number[] = [];
		for (let i = 0; i < 20; i++) {
			const result = await runSh(cmd, fixture, baseEnv(home));
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			// D32 (F205): this is the empirical proof that the shim doesn't block
			// on the detached child — a flat host-independent bound, not a
			// wall-clock number that just measures the CI runner's scheduler.
			assertBoundedExit(result.ms);
			samples.push(result.ms);
		}
		samples.sort((a, b) => a - b);
		const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? samples[samples.length - 1] ?? 0;
		console.log(
			`[codex-hook-command] p95 exit time over 20 runs: ${p95.toFixed(2)}ms (strict budget: ${STRICT_P95_BOUND_MS}ms, checked only when AGENTPULSE_PERF_TESTS=1)`,
		);
		// D32: strict mode only — the tighter D13 budget stays meaningful on a
		// quiet machine but never gates the default CI/dev run.
		if (PERF_TESTS) {
			expect(p95).toBeLessThanOrEqual(STRICT_P95_BOUND_MS);
		}
	}, 15000);

	test("D32 mutant: a synchronous-curl command (backgrounding removed) fails the default bounded-exit contract", async () => {
		const never = startNeverRespondingStub();
		stops.push(never.stop);
		const home = join(tmp, "home-timing-mutant");
		await mkdir(join(home, "tmp"), { recursive: true });
		const realCmd = buildBashHookCommand({
			baseUrl: never.url,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const mutantCmd = toSynchronousMutant(realCmd);
		expect(mutantCmd).not.toBe(realCmd);
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Stop");

		const result = await runSh(mutantCmd, fixture, baseEnv(home));

		// The mutant still exits 0 with no stdout (removing `&` doesn't change
		// the redirects) — only its *timing* should differ. This is the proof
		// that assertBoundedExit's thresholds are load-bearing: a shim that
		// forgot to detach reliably fails them, instead of the test vacuously
		// passing regardless of implementation.
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.ms).toBeGreaterThanOrEqual(DEFAULT_EXIT_BOUND_MS);
		expect(result.ms).toBeGreaterThanOrEqual(SYNC_MARGIN_BOUND_MS);
	}, 15000);

	test("temp file is gone after delivery; server-down leaves no leftover after 3s", async () => {
		const stub = startStub();
		stops.push(stub.stop);
		const home = join(tmp, "home-cleanup");
		const tmpDir = join(home, "tmp");
		await mkdir(tmpDir, { recursive: true });
		const cmd = buildBashHookCommand({
			baseUrl: stub.url,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Stop");
		await runSh(cmd, fixture, baseEnv(home));
		expect(await waitFor(() => stub.requests.length > 0)).toBe(true);
		expect(await waitFor(async () => (await readdir(tmpDir)).length === 0)).toBe(true);

		// server down
		const home2 = join(tmp, "home-cleanup-down");
		const tmpDir2 = join(home2, "tmp");
		await mkdir(tmpDir2, { recursive: true });
		const cmdDown = buildBashHookCommand({
			baseUrl: await closedPort(),
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		await runSh(cmdDown, fixture, baseEnv(home2));
		await Bun.sleep(3000);
		expect((await readdir(tmpDir2)).length).toBe(0);
	}, 15000);
});

const ALL_AGENT_FIXTURES: Array<{ agent: string; event: string; dir: string }> = [
	...CODEX_EVENTS.map((event) => ({ agent: "codex_cli", event, dir: CODEX_FIXTURES_DIR })),
	...[
		"sessionStart",
		"sessionEnd",
		"userPromptSubmitted",
		"postToolUse",
		"postToolUseFailure",
		"agentStop",
		"subagentStart",
		"subagentStop",
		"preCompact",
		"errorOccurred",
	].map((event) => ({ agent: "copilot_cli", event, dir: COPILOT_FIXTURES_DIR })),
];

describe("codex-hook-command.test.ts — item 13: no stdout / never fail closed / bounded, every fixture", () => {
	for (const { agent, event, dir } of ALL_AGENT_FIXTURES) {
		describe(`${agent} ${event}`, () => {
			test("healthy stub", async () => {
				const stub = startStub();
				stops.push(stub.stop);
				const home = join(tmp, `h-${agent}-${event}-healthy`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const cmd = buildBashHookCommand({ baseUrl: stub.url, direct: false, agent, event });
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, baseEnv(home));
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}, 15_000);

			test("stub returns 500", async () => {
				const stub = startStub(() => new Response("boom", { status: 500 }));
				stops.push(stub.stop);
				const home = join(tmp, `h-${agent}-${event}-500`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const cmd = buildBashHookCommand({ baseUrl: stub.url, direct: false, agent, event });
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, baseEnv(home));
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}, 15_000);

			test("stub returns a non-JSON body", async () => {
				const stub = startStub(() => new Response("<html>not json</html>", { status: 200 }));
				stops.push(stub.stop);
				const home = join(tmp, `h-${agent}-${event}-nonjson`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const cmd = buildBashHookCommand({ baseUrl: stub.url, direct: false, agent, event });
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, baseEnv(home));
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}, 15_000);

			test("stub returns a JSON body shaped like a hook decision", async () => {
				const stub = startStub(
					() =>
						new Response(JSON.stringify({ decision: "block", permissionDecision: "deny" }), {
							status: 200,
							headers: { "Content-Type": "application/json" },
						}),
				);
				stops.push(stub.stop);
				const home = join(tmp, `h-${agent}-${event}-decision`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const cmd = buildBashHookCommand({ baseUrl: stub.url, direct: false, agent, event });
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, baseEnv(home));
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}, 15_000);

			test("server down", async () => {
				const home = join(tmp, `h-${agent}-${event}-down`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const cmd = buildBashHookCommand({
					baseUrl: await closedPort(),
					direct: false,
					agent,
					event,
				});
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, baseEnv(home));
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}, 15_000);

			test("TMPDIR unwritable — mktemp fails, stub receives zero requests", async () => {
				const stub = startStub();
				stops.push(stub.stop);
				const home = join(tmp, `h-${agent}-${event}-rotmp`);
				const roTmp = join(home, "ro-tmp");
				await mkdir(roTmp, { recursive: true });
				await chmod(roTmp, 0o500);
				const cmd = buildBashHookCommand({ baseUrl: stub.url, direct: false, agent, event });
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: home,
					TMPDIR: roTmp,
				});
				await chmod(roTmp, 0o700);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
				await Bun.sleep(100);
				expect(stub.requests.length).toBe(0);
			}, 15_000);

			test("no curl on PATH", async () => {
				const home = join(tmp, `h-${agent}-${event}-nocurl`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const fakeBin = join(tmp, "fakebin");
				await mkdir(fakeBin, { recursive: true });
				for (const tool of ["sh", "mktemp", "cat", "grep", "head", "mkdir", "rm"]) {
					const real = Bun.which(tool);
					if (real) await symlink(real, join(fakeBin, tool)).catch(() => {});
				}
				const cmd = buildBashHookCommand({
					baseUrl: "http://127.0.0.1:1",
					direct: false,
					agent,
					event,
				});
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, {
					PATH: fakeBin,
					HOME: home,
					TMPDIR: join(home, "tmp"),
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("");
				expect(result.stderr).toBe("");
			}, 15_000);

			test("bounded (D32): process exit is <750ms and 5x margin vs. a synchronous curl, against a never-responding stub", async () => {
				const never = startNeverRespondingStub();
				stops.push(never.stop);
				const home = join(tmp, `h-${agent}-${event}-bounded`);
				await mkdir(join(home, "tmp"), { recursive: true });
				const cmd = buildBashHookCommand({ baseUrl: never.url, direct: false, agent, event });
				const fixture = await loadFixture(dir, event);
				const result = await runSh(cmd, fixture, baseEnv(home));
				expect(result.exitCode).toBe(0);
				assertBoundedExit(result.ms);
			}, 15_000);
		});
	}
});

describe("codex-hook-command.test.ts — parity guard self-test: no-stdout rule catches an injected echo", () => {
	test("appending `; echo ok` to a generated command is detectable by the same shape rule the guard applies", () => {
		const cmd = buildBashHookCommand({
			baseUrl: "http://localhost:4000",
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const tampered = `${cmd}; echo ok`;
		expect(tampered).toMatch(/\becho\b/);
		expect(cmd).not.toMatch(/\becho\b/);
	});
});
