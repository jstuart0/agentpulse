/**
 * Counts the EXTERNAL commands a POSIX sh snippet really executes.
 *
 * Method: the shell under test runs with PATH set to one directory that
 * holds a tiny counting wrapper for every executable found in the system
 * bin directories. A wrapper appends its own name to a log, then `exec`s
 * the real binary. The snippet therefore can't start any bare-name
 * external utility without it being recorded, whichever utility it picks
 * (a hand-written allowlist of "expected" commands would miss a new one).
 * Shell built-ins, `$(...)` subshell forks and redirections are not
 * process executions of a program and are not counted — that is the
 * definition of "external command" used by the latency budget.
 *
 * Not covered, by construction: a command invoked by absolute path
 * (`/bin/rm`) bypasses PATH. The snippet calls bare names, with one
 * deliberate exception (the external pwd for non-ASCII paths on macOS),
 * and the test asserting the count also asserts, via
 * findAbsoluteUtilityCalls, that no other absolute-path invocation exists.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SYSTEM_BIN_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const SAFE_NAME_RE = /^[A-Za-z0-9._+-]+$/;
const DEFAULT_RUN_TIMEOUT_MS = 20_000;

/** Builds the wrapper directory once; returns its path. */
export function buildCountingBin(rootDir: string): string {
	const binDir = join(rootDir, "counting-bin");
	mkdirSync(binDir, { recursive: true });
	const seen = new Set<string>();
	for (const dir of SYSTEM_BIN_DIRS) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (seen.has(name) || !SAFE_NAME_RE.test(name)) continue;
			const real = join(dir, name);
			seen.add(name);
			const wrapper = join(binDir, name);
			writeFileSync(
				wrapper,
				`#!/bin/sh\nprintf '%s\\n' '${name}' >> "$AP_SPAWN_LOG"\nexec '${real}' "$@"\n`,
			);
			chmodSync(wrapper, 0o755);
		}
	}
	return binDir;
}

export function readSpawnLog(logPath: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((l) => l.length > 0);
}

export interface CountedShell {
	bin: string;
	args?: string[];
}

/** Matches a system utility named by absolute path in snippet text, quoted or not (`/usr/bin/x`, `"/bin/x"`, `$("/usr/bin/x")`, `'/sbin/x'`) — such a call bypasses the counting PATH. */
const ABSOLUTE_UTILITY_RE = /(?:^|[\s;&|(`"'=])(\/(?:usr\/)?s?bin\/[A-Za-z0-9._+-]+)/gm;

/**
 * Every absolute-path utility invocation in `snippet` except the names in
 * `allowed`. Callers pass the one deliberate exception (the external
 * `/bin/pwd` used for non-ASCII paths on macOS) explicitly, so an
 * unplanned one is a test failure.
 */
export function findAbsoluteUtilityCalls(snippet: string, allowed: string[] = []): string[] {
	return [...snippet.matchAll(ABSOLUTE_UTILITY_RE)]
		.map((m) => m[1] as string)
		.filter((path) => !allowed.includes(path));
}

export interface CountedRun {
	/** Names of the external commands executed, in order. */
	commands: string[];
	excluded: boolean;
	/** Anything the snippet itself wrote (the test-only result marker is stripped). */
	stdout: string;
	stderr: string;
}

/**
 * Runs `snippet` under `shell` in `cwd` with PATH confined to the counting
 * wrapper dir. The result marker line is test-only instrumentation, built
 * from a shell built-in so it adds no execution of its own.
 */
export function runCounted(
	shell: CountedShell,
	binDir: string,
	logPath: string,
	snippet: string,
	opts: { home: string; cwd: string; skip?: string; timeoutMs?: number },
): CountedRun {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const scriptPath = `${logPath}.sh`;
	writeFileSync(scriptPath, `${snippet}\nprintf 'AP_RESULT=%s\\n' "$ap_excluded"\n`);
	writeFileSync(logPath, "");
	const result = spawnSync(shell.bin, [...(shell.args ?? []), scriptPath], {
		cwd: opts.cwd,
		env: {
			PATH: binDir,
			HOME: opts.home,
			AGENTPULSE_SKIP: opts.skip ?? "",
			AP_SPAWN_LOG: logPath,
		},
		encoding: "utf-8",
		timeout: timeoutMs,
	});
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
		throw new Error(`counted run timed out after ${timeoutMs} ms under ${shell.bin}`);
	}
	const stdout = result.stdout ?? "";
	const match = /AP_RESULT=(\d)/.exec(stdout);
	if (!match) {
		throw new Error(
			`no AP_RESULT marker (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(result.stderr)})`,
		);
	}
	return {
		commands: readSpawnLog(logPath),
		excluded: match[1] === "1",
		stdout: stdout.replace(/AP_RESULT=\d\n?/, ""),
		stderr: result.stderr ?? "",
	};
}

export interface CountedScriptRun {
	/** Names of the external commands executed, in order. */
	commands: string[];
	/** The script's exit status: 0 = send, anything else = don't. */
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Runs a whole script file (the installed check) under `shell`, the way the hook runs it, with PATH confined to the counting wrappers. */
export function runCountedScript(
	shell: CountedShell,
	binDir: string,
	logPath: string,
	scriptText: string,
	opts: { home: string; cwd: string; skip?: string; timeoutMs?: number },
): CountedScriptRun {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const scriptPath = `${logPath}.check.sh`;
	writeFileSync(scriptPath, scriptText);
	writeFileSync(logPath, "");
	const result = spawnSync(shell.bin, [...(shell.args ?? []), scriptPath], {
		cwd: opts.cwd,
		env: {
			PATH: binDir,
			HOME: opts.home,
			AGENTPULSE_SKIP: opts.skip ?? "",
			AP_SPAWN_LOG: logPath,
		},
		encoding: "utf-8",
		timeout: timeoutMs,
	});
	if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
		throw new Error(`counted script run timed out after ${timeoutMs} ms under ${shell.bin}`);
	}
	return {
		commands: readSpawnLog(logPath),
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export interface CountedHookRun {
	/** Names of the external commands executed, in order (the stub curl logs itself as `curl`, the wrapped interpreter as `sh`). */
	commands: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	/** Milliseconds until the hook's own process exited (the detached body may still be running). */
	parentMs: number;
}

/**
 * Writes the two stand-ins a hook run needs next to the counting wrappers: a
 * `curl` that logs itself (never a real network call) and a wrapper for the
 * explicit interpreter the hook command names (`/bin/sh` by absolute path
 * bypasses the PATH counter, so the test swaps that one path for a wrapper
 * that logs `sh` and then runs the real shell). Returns their paths.
 */
export function buildHookStubs(rootDir: string): { stubDir: string; countingSh: string } {
	const stubDir = join(rootDir, "hook-stubs");
	mkdirSync(stubDir, { recursive: true });
	writeFileSync(join(stubDir, "curl"), `#!/bin/sh\nprintf '%s\\n' curl >> "$AP_SPAWN_LOG"\n`);
	chmodSync(join(stubDir, "curl"), 0o755);
	const countingSh = join(rootDir, "counting-sh");
	writeFileSync(countingSh, `#!/bin/sh\nprintf '%s\\n' sh >> "$AP_SPAWN_LOG"\nexec /bin/sh "$@"\n`);
	chmodSync(countingSh, 0o755);
	return { stubDir, countingSh };
}

/**
 * Runs a generated hook COMMAND text under `shell -c`, with a payload on
 * stdin, and returns what it executed. The command's explicit `/bin/sh`
 * interpreter path is replaced (exactly once, asserted) with the logging
 * wrapper. Waits until the detached body has removed the temp payload.
 */
export async function runCountedHook(
	shell: CountedShell,
	paths: { binDir: string; stubDir: string; countingSh: string },
	logPath: string,
	command: string,
	opts: {
		home: string;
		cwd: string;
		tmp: string;
		skip?: string;
		env?: Record<string, string>;
		waitMs?: number;
	},
): Promise<CountedHookRun> {
	const marker = '/bin/sh "$d/exclude-check.sh"';
	const count = command.split(marker).length - 1;
	if (count !== 1) {
		throw new Error(
			`expected exactly one explicit interpreter call in the command, found ${count}`,
		);
	}
	const counted = command.replace(marker, `${paths.countingSh} "$d/exclude-check.sh"`);
	writeFileSync(logPath, "");
	const started = performance.now();
	const result = spawnSync(shell.bin, [...(shell.args ?? []), "-c", counted], {
		cwd: opts.cwd,
		input: '{"session_id":"sess-abc-123","hook_event_name":"Stop"}',
		env: {
			PATH: `${paths.stubDir}:${paths.binDir}`,
			HOME: opts.home,
			TMPDIR: opts.tmp,
			AGENTPULSE_SKIP: opts.skip ?? "",
			AP_SPAWN_LOG: logPath,
			...(opts.env ?? {}),
		},
		encoding: "utf-8",
		timeout: DEFAULT_RUN_TIMEOUT_MS,
	});
	const parentMs = performance.now() - started;
	const deadline = Date.now() + (opts.waitMs ?? 15_000);
	while (
		readdirSync(opts.tmp).some((n) => n.startsWith("agentpulse-hook.")) &&
		Date.now() < deadline
	) {
		await new Promise((r) => setTimeout(r, 25));
	}
	if (readdirSync(opts.tmp).some((n) => n.startsWith("agentpulse-hook."))) {
		throw new Error("the detached hook body never finished");
	}
	return {
		commands: readSpawnLog(logPath),
		exitCode: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		parentMs,
	};
}
