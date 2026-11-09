/**
 * The one place a canary starts OpenCode (AGEN-141, phase 0). Rules in `opencode-canary-safety.ts`. Before every
 * spawn: the binary is pinned (absolute path, version and sha256), the argv is allow-listed, and
 * `assertOpenCodeSandbox` has judged an environment built from nothing and a cwd inside scratch. stdin is
 * always closed (a `run` on 1.x waits on an open stdin forever), every child is detached with a kill timer, and
 * every pid is recorded: cleanup signals only recorded pids or processes naming this run's XDG_DATA_HOME.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	createReadStream,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OPENCODE_PINS, type OpenCodeLine, type OpenCodePin } from "./opencode-canary-pins.js";
import {
	NETWORK_PROFILE,
	type SANDBOX_DIR_VARS,
	SANDBOX_EXEC,
	assertAllowedOpenCodeArgs,
	assertOpenCodeSandbox,
	buildOpenCodeEnv,
} from "./opencode-canary-safety.js";
import { killOwnOpenCodeProcesses } from "./opencode-own-pids.js";

/** Pids and process groups this process started. */
export const startedPids = new Set<number>();

export interface Sandbox {
	scratchRoot: string;
	/** Everything of one OpenCode "person": home, the XDG tree, tmp. */
	stateDir: string;
	paths: Record<(typeof SANDBOX_DIR_VARS)[number], string>;
}

/** Lays out (and creates) one throwaway state directory under `scratchRoot`. */
export function makeSandbox(scratchRoot: string, label: string): Sandbox {
	const stateDir = join(scratchRoot, "state", label);
	const paths = {
		HOME: join(stateDir, "home"),
		XDG_CONFIG_HOME: join(stateDir, "xdg-config"),
		XDG_DATA_HOME: join(stateDir, "xdg-data"),
		XDG_STATE_HOME: join(stateDir, "xdg-state"),
		XDG_CACHE_HOME: join(stateDir, "xdg-cache"),
		XDG_RUNTIME_DIR: join(stateDir, "xdg-runtime"),
		TMPDIR: join(stateDir, "tmp"),
	};
	for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	return { scratchRoot, stateDir, paths };
}

const hashCache = new Map<string, string>();

/** sha256 of a file, streamed (the binaries are 180 to 230 MB), cached per path, size and mtime. */
export async function sha256File(path: string): Promise<string> {
	const st = statSync(path);
	const key = `${path}:${st.size}:${st.mtimeMs}`;
	const cached = hashCache.get(key);
	if (cached) return cached;
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve());
	});
	const digest = hash.digest("hex");
	hashCache.set(key, digest);
	return digest;
}

/** Throws unless `bin` is an absolute path whose sha256 equals the pin for `line`. */
export async function assertPinnedBinary(
	bin: string,
	line: OpenCodeLine,
	pins: Record<OpenCodeLine, OpenCodePin> = OPENCODE_PINS,
): Promise<void> {
	if (!bin.startsWith("/")) throw new Error("the OpenCode binary must be an absolute path");
	const pin = pins[line];
	const actual = await sha256File(bin);
	if (actual !== pin.sha256) {
		throw new Error(`${bin} is not the pinned ${line} build (sha256 ${actual})`);
	}
}

export interface OpenCodeStart {
	line: OpenCodeLine;
	bin: string;
	args: readonly string[];
	sandbox: Sandbox;
	cwd: string;
	/** `OPENCODE_CONFIG_DIR` (inside scratch), when the run measures what it does. */
	configDir?: string;
	db?: string;
	/** `PROBE_*`, `STUB_*` and `AGENTPULSE_SKIP` only. */
	extraEnv?: Record<string, string>;
	timeoutMs?: number;
	/** Where stdout and stderr go (`<logBase>.out`, `<logBase>.err`). */
	logBase: string;
}

export interface OpenCodeChild {
	pid: number;
	child: ChildProcess;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>;
	stdoutPath: string;
	stderrPath: string;
	env: Record<string, string>;
	/** Ends the child's process group (this run's own). */
	kill(signal?: NodeJS.Signals): void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** `pins` is a test seam: a stand-in executable gets a pin of its own; a canary passes nothing. */
export async function startOpenCode(
	options: OpenCodeStart,
	pins: Record<OpenCodeLine, OpenCodePin> = OPENCODE_PINS,
): Promise<OpenCodeChild> {
	await assertPinnedBinary(options.bin, options.line, pins);
	const { sandbox } = options;
	assertAllowedOpenCodeArgs(options.args, sandbox.scratchRoot);
	const env = buildOpenCodeEnv(sandbox.paths, {
		...(options.configDir ? { configDir: options.configDir } : {}),
		...(options.db ? { db: options.db } : {}),
		...(options.extraEnv ? { extra: options.extraEnv } : {}),
	});
	assertOpenCodeSandbox(env, sandbox.scratchRoot, options.cwd);
	const stdoutPath = `${options.logBase}.out`;
	const stderrPath = `${options.logBase}.err`;
	const outFd = openSync(stdoutPath, "a");
	const errFd = openSync(stderrPath, "a");
	// Every child runs under the loopback-only network profile; there is no way to ask for another.
	const profilePath = join(sandbox.stateDir, "loopback-only.sb");
	writeFileSync(profilePath, NETWORK_PROFILE);
	let child: ChildProcess;
	try {
		child = spawn(SANDBOX_EXEC, ["-f", profilePath, options.bin, ...options.args], {
			cwd: options.cwd,
			env,
			detached: true,
			stdio: ["ignore", outFd, errFd],
		});
	} finally {
		closeSync(outFd);
		closeSync(errFd);
	}
	const pid = child.pid;
	if (pid === undefined) throw new Error("opencode did not start");
	startedPids.add(pid);
	let timedOut = false;
	const kill = (signal: NodeJS.Signals = "SIGKILL") => {
		try {
			process.kill(-pid, signal);
		} catch {
			try {
				process.kill(pid, signal);
			} catch {
				// Already gone.
			}
		}
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill("SIGKILL");
	}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	timer.unref();
	const exited = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
	}>((resolve) => {
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			startedPids.delete(pid);
			resolve({ code, signal, timedOut });
		});
	});
	return { pid, child, exited, stdoutPath, stderrPath, env, kill };
}

export interface OpenCodeRunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	ms: number;
	pid: number;
}

/** Starts, waits for exit, and returns the captured output. */
export async function runOpenCode(
	options: OpenCodeStart,
	pins: Record<OpenCodeLine, OpenCodePin> = OPENCODE_PINS,
): Promise<OpenCodeRunResult> {
	const t0 = performance.now();
	const child = await startOpenCode(options, pins);
	const end = await child.exited;
	const read = (path: string) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	};
	return {
		...end,
		stdout: read(child.stdoutPath),
		stderr: read(child.stderrPath),
		ms: performance.now() - t0,
		pid: child.pid,
	};
}

/** Ends everything this run left in `sandbox`: recorded pids first, then processes naming its XDG_DATA_HOME. */
export function cleanupSandbox(sandbox: Sandbox): void {
	for (const pid of startedPids) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Exited.
			}
		}
	}
	killOwnOpenCodeProcesses(sandbox.paths.XDG_DATA_HOME, "SIGKILL");
}
