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

// D33 (F205): D32's flat 750ms/5x-margin bounds still occasionally measured
// host contention, not the shim — a single loaded-host gate run flaked on
// the bounded-exit test, the synchronous-curl mutant, and the temp-file
// cleanup check all at once. D33 widens the ratio further and switches from
// racing a fixed wall-clock number to ordering/deadline-based checks:
//   - Default bounded-exit: <5s against a stub that never answers — far
//     above any contention this shim has ever measured (observed max
//     ~1s under heavy load) and far below a stub that would legitimately
//     take 20s or longer to respond.
//   - The mutant proof no longer races a wall-clock number at all: a fully
//     synchronous, unbounded curl (backgrounding *and* --max-time both
//     removed) against a never-answering stub is *killed* by a 6s guard —
//     it would otherwise block indefinitely — while the real, detached
//     shim never approaches that guard. "Got killed" is itself the "the
//     mutant fails the default contract" result; there's no timing race.
//   - The temp-file cleanup check polls for the file's absence up to a
//     10s deadline instead of sleeping a fixed 3s, so it can't undercount
//     (finish checking before cleanup lands) or overpay wall-clock time on
//     a healthy run.
const DEFAULT_EXIT_BOUND_MS = 5000;
const MUTANT_KILL_GUARD_MS = 6000;
const TEMP_FILE_CLEANUP_DEADLINE_MS = 10_000;
// Strict mode (AGENTPULSE_PERF_TESTS=1): the tighter 150ms p95 budget from
// D13's original spec still runs, opt-in — p95 itself is always recorded.
const STRICT_P95_BOUND_MS = 150;
const PERF_TESTS = process.env.AGENTPULSE_PERF_TESTS === "1";

/** D33's default bounded-exit contract — see the block comment above. */
function assertBoundedExit(ms: number) {
	expect(ms).toBeLessThan(DEFAULT_EXIT_BOUND_MS);
}

/**
 * D33: strips both the backgrounding (`& exit 0` -> `; exit 0`) and the
 * client-side `--max-time 2` bound from a generated command, so running it
 * against a never-answering stub blocks genuinely indefinitely rather than
 * being saved by curl's own timeout (D12's Risks section calls --max-time a
 * *second*, independent backstop — stripping only the backgrounding, as
 * D32 did, still left that backstop in place and made the mutant's actual
 * runtime an unpredictable function of host/network timing instead of a
 * reliable "it hangs" signal). Used only to prove the default assertion
 * discriminates — see the "mutant" test below.
 */
function toSynchronousMutant(cmd: string): string {
	const detached = cmd.replace(
		/\) <\/dev\/null >\/dev\/null 2>&1 & exit 0$/,
		") </dev/null >/dev/null 2>&1; exit 0",
	);
	if (detached === cmd) {
		throw new Error(
			"toSynchronousMutant: the detached-tail pattern didn't match — command shape changed?",
		);
	}
	const unbounded = detached.replace(/--max-time 2 /g, "");
	if (unbounded === detached) {
		throw new Error(
			"toSynchronousMutant: the --max-time pattern didn't match — command shape changed?",
		);
	}
	return unbounded;
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

/**
 * D33: runs `cmd`, but forcibly kills it (SIGKILL) if it hasn't exited
 * within `guardMs`. `killed` — not the elapsed time — is the signal the
 * mutant test asserts on: proving a fully-synchronous, unbounded curl
 * actually hangs (and has to be killed) is a hard, ordering-based fact,
 * unlike racing its exit time against a fixed wall-clock number.
 */
async function runShWithGuard(
	cmd: string,
	stdin: Uint8Array | string,
	env: Record<string, string>,
	guardMs: number,
): Promise<{
	exitCode: number | null;
	stdout: string;
	stderr: string;
	ms: number;
	killed: boolean;
}> {
	const start = performance.now();
	const proc = Bun.spawn(["sh", "-c", cmd], {
		stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		proc.kill(9); // SIGKILL — deterministic, doesn't depend on the child trapping SIGTERM
	}, guardMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	const ms = performance.now() - start;
	return { exitCode, stdout, stderr, ms, killed };
}

/**
 * D33: polls `check` up to `timeoutMs`, never a fixed sleep. Fixed: `check`
 * previously only worked correctly for synchronous predicates — an async
 * predicate's Promise is a truthy object, so `if (check())` returned `true`
 * on the very first call regardless of what it resolved to, silently never
 * actually waiting. Every call site that passed an async check (the
 * temp-file-cleanup polls below) was vacuously passing.
 */
async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 3000,
	stepMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(stepMs);
	}
	return await check();
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

// D33: the mutant test's kill-guard runs push a single test body's wall
// time up to ~2x MUTANT_KILL_GUARD_MS; under contention the surrounding
// beforeEach/afterEach hooks need matching headroom, not bun:test's 5s
// default, or cleanup itself becomes the flake source D33 exists to remove.
const HOOK_TIMEOUT_MS = 30_000;
// Each cleanup step (stopping one stub, removing the temp dir) is itself
// bounded and best-effort: under extreme contention `rm -rf` on a dir that
// dozens of now-orphaned, fire-and-forget curl children may still be
// touching can occasionally be slow. Racing each step against a shorter
// deadline and moving on (rather than letting the *hook's own* timeout
// fire) keeps a single slow cleanup from blocking the whole suite's
// sequential progress — a leftover OS temp dir is harmless and self-cleans.
const CLEANUP_STEP_TIMEOUT_MS = 8_000;

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	try {
		await Promise.race([promise.then(() => undefined).catch(() => undefined), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-codex-hook-cmd-"));
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
	while (stops.length) {
		const stop = stops.pop();
		if (stop) await withTimeout(Promise.resolve(stop()), CLEANUP_STEP_TIMEOUT_MS);
	}
	await withTimeout(rm(tmp, { recursive: true, force: true }), CLEANUP_STEP_TIMEOUT_MS);
}, HOOK_TIMEOUT_MS);

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

	// F240 (tessa, Phase 7 panel): parametrized over both agents that use the
	// direct-mode hook-auth-header file — codex_cli originally, copilot_cli
	// added here. buildBashHookCommand's direct-mode body (the
	// `f="$HOME/.agentpulse/hook-auth-header"; if [ -s "$f" ]; then ...`
	// branch) is agent-agnostic, but F49 only ever exercised it via
	// codex_cli — this closes that gap for copilot_cli's own fixture/event.
	for (const { agent, event, dir } of [
		{ agent: "codex_cli" as const, event: "Stop", dir: CODEX_FIXTURES_DIR },
		{ agent: "copilot_cli" as const, event: "postToolUse", dir: COPILOT_FIXTURES_DIR },
	]) {
		test(`F49/F240 (${agent}): hook-auth-header present → Authorization arrives; missing/empty → no Authorization header`, async () => {
			const stub = startStub();
			stops.push(stub.stop);
			const cmd = buildBashHookCommand({
				baseUrl: stub.url,
				direct: true,
				agent,
				event,
			});
			const fixture = await loadFixture(dir, event);

			// present
			{
				const home = join(tmp, `home-auth-present-${agent}`);
				await mkdir(join(home, ".agentpulse"), { recursive: true });
				await mkdir(join(home, "tmp"), { recursive: true });
				await writeFile(
					join(home, ".agentpulse/hook-auth-header"),
					"Authorization: Bearer ap_test\n",
				);
				await runSh(cmd, fixture, baseEnv(home));
				expect(await waitFor(() => stub.requests.length >= 1)).toBe(true);
				expect(stub.requests.at(-1)?.headers.authorization).toBe("Bearer ap_test");
				expect(stub.requests.at(-1)?.headers["x-agent-type"]).toBe(agent);
			}
			// missing
			{
				const home = join(tmp, `home-auth-missing-${agent}`);
				await mkdir(join(home, "tmp"), { recursive: true });
				await runSh(cmd, fixture, baseEnv(home));
				expect(await waitFor(() => stub.requests.length >= 2)).toBe(true);
				expect(stub.requests.at(-1)?.headers.authorization).toBeUndefined();
			}
			// empty file
			{
				const home = join(tmp, `home-auth-empty-${agent}`);
				await mkdir(join(home, ".agentpulse"), { recursive: true });
				await mkdir(join(home, "tmp"), { recursive: true });
				await writeFile(join(home, ".agentpulse/hook-auth-header"), "");
				await runSh(cmd, fixture, baseEnv(home));
				expect(await waitFor(() => stub.requests.length >= 3)).toBe(true);
				expect(stub.requests.at(-1)?.headers.authorization).toBeUndefined();
			}
		});
	}
});

describe("F217: the D19 native-coverage marker sid gate, executed for real", () => {
	// The marker snippet runs textually before the curl call in the
	// generated command body (see buildBashHookCommand), in the same
	// backgrounded subshell — so once the stub has received the request,
	// whatever the marker gate decided has already happened. That makes
	// "request received" a reliable, ordering-based synchronization point
	// for these assertions, with no need to poll/sleep on the marker path
	// itself.
	async function runMarkerCase(home: string, payload: string) {
		const stub = startStub();
		stops.push(stub.stop);
		await mkdir(join(home, "tmp"), { recursive: true });
		const cmd = buildBashHookCommand({
			baseUrl: stub.url,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const result = await runSh(cmd, payload, baseEnv(home));
		expect(await waitFor(() => stub.requests.length > 0)).toBe(true);
		return result;
	}

	function markerPath(home: string, sid: string) {
		return join(home, ".agentpulse", "codex-native", sid);
	}

	// Bun.file(path).exists() is false for a *directory* (it's a file
	// handle, not a general path check) — a directory that exists but is
	// empty would false-pass a Bun.file(dir).exists() check. readdir gives
	// an unambiguous, type-correct "does this directory have anything in
	// it at all" signal, and "no directory" (ENOENT) counts as empty too.
	async function markerDirIsEmpty(home: string): Promise<boolean> {
		try {
			return (await readdir(join(home, ".agentpulse", "codex-native"))).length === 0;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw err;
		}
	}

	test("a valid sid writes the marker", async () => {
		const home = join(tmp, "home-marker-valid");
		const sid = "abc123-DEF456";
		const result = await runMarkerCase(home, JSON.stringify({ session_id: sid }));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(await Bun.file(markerPath(home, sid)).exists()).toBe(true);
	});

	test("a sid containing '/' leaves no marker file", async () => {
		const home = join(tmp, "home-marker-slash");
		const result = await runMarkerCase(home, JSON.stringify({ session_id: "abc/def" }));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(await markerDirIsEmpty(home)).toBe(true);
	});

	test("a sid containing '..' leaves no marker file", async () => {
		const home = join(tmp, "home-marker-dotdot");
		const result = await runMarkerCase(home, JSON.stringify({ session_id: "../../etc/passwd" }));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(await markerDirIsEmpty(home)).toBe(true);
	});

	test("a sid over 128 chars leaves no marker file", async () => {
		const home = join(tmp, "home-marker-toolong");
		const sid = "a".repeat(129); // all-valid charset, but over the length gate
		const result = await runMarkerCase(home, JSON.stringify({ session_id: sid }));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(await Bun.file(markerPath(home, sid)).exists()).toBe(false);
		expect(await markerDirIsEmpty(home)).toBe(true);
	});

	test("a payload with no session_id field leaves no marker file", async () => {
		const home = join(tmp, "home-marker-missing");
		const result = await runMarkerCase(home, JSON.stringify({ hook_event_name: "Stop" }));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(await markerDirIsEmpty(home)).toBe(true);
	});
});

describe("codex-hook-command.test.ts — r6 detached-shape timing + cleanup (item 12)", () => {
	test("process exit is bounded (D33: <5s) against a stub that never answers; p95 recorded", async () => {
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
			// D33 (F205): this is the empirical proof that the shim doesn't block
			// on the detached child — a wide, host-independent bound, not a
			// tight wall-clock number that just measures the CI runner's
			// scheduler under contention.
			assertBoundedExit(result.ms);
			samples.push(result.ms);
		}
		samples.sort((a, b) => a - b);
		const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? samples[samples.length - 1] ?? 0;
		console.log(
			`[codex-hook-command] p95 exit time over 20 runs: ${p95.toFixed(2)}ms (strict budget: ${STRICT_P95_BOUND_MS}ms, checked only when AGENTPULSE_PERF_TESTS=1)`,
		);
		// Strict mode only — the tighter D13 budget stays meaningful on a
		// quiet machine but never gates the default CI/dev run.
		if (PERF_TESTS) {
			expect(p95).toBeLessThanOrEqual(STRICT_P95_BOUND_MS);
		}
	}, 15000);

	test(
		"D33 mutant: a fully-synchronous, unbounded curl hits a 6s kill guard; the real (detached) shim never does",
		async () => {
			const never = startNeverRespondingStub();
			stops.push(never.stop);
			const realCmd = buildBashHookCommand({
				baseUrl: never.url,
				direct: false,
				agent: "codex_cli",
				event: "Stop",
			});
			const mutantCmd = toSynchronousMutant(realCmd);
			expect(mutantCmd).not.toBe(realCmd);
			expect(mutantCmd).not.toContain("--max-time");
			const fixture = await loadFixture(CODEX_FIXTURES_DIR, "Stop");

			// The real shim must never approach the guard — it's detached, so its
			// own exit is independent of how long the backgrounded curl call
			// actually takes.
			const homeReal = join(tmp, "home-timing-mutant-real");
			await mkdir(join(homeReal, "tmp"), { recursive: true });
			const realResult = await runShWithGuard(
				realCmd,
				fixture,
				baseEnv(homeReal),
				MUTANT_KILL_GUARD_MS,
			);
			expect(realResult.killed).toBe(false);
			expect(realResult.exitCode).toBe(0);
			expect(realResult.stdout).toBe("");

			// The mutant — now genuinely synchronous and unbounded against a stub
			// that never answers — must still be blocked on curl when the guard
			// fires. Getting killed *is* "the mutant fails the default bounded-exit
			// contract": it never even reaches its own `exit 0`.
			const homeMutant = join(tmp, "home-timing-mutant-fail");
			await mkdir(join(homeMutant, "tmp"), { recursive: true });
			const mutantResult = await runShWithGuard(
				mutantCmd,
				fixture,
				baseEnv(homeMutant),
				MUTANT_KILL_GUARD_MS,
			);
			expect(mutantResult.killed).toBe(true);
		},
		MUTANT_KILL_GUARD_MS * 2 + 8000,
	);

	test("temp file is gone after delivery; server-down leaves no leftover", async () => {
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
		// D33: poll to a deadline, never a fixed sleep.
		expect(
			await waitFor(
				async () => (await readdir(tmpDir)).length === 0,
				TEMP_FILE_CLEANUP_DEADLINE_MS,
			),
		).toBe(true);

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
		expect(
			await waitFor(
				async () => (await readdir(tmpDir2)).length === 0,
				TEMP_FILE_CLEANUP_DEADLINE_MS,
			),
		).toBe(true);
	}, 25000);
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

			test("bounded (D33): process exit is <5s against a never-responding stub", async () => {
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
