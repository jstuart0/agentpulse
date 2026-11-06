/**
 * The one place a canary starts Claude (AGEN-117, phase 0). Rules in `claude-canary-safety.ts`. In short: the
 * child's environment is an allowlist, never a copy of ours; the home and config directory are checked to be
 * throwaway before anything starts; only `--version`, `agents --json` and capped, model-named print or
 * stream-json argvs run (no terminal interface, no bypass of permissions, no login or service subcommands); a
 * credential is only in the environment, and everything logged is redacted; every child has a kill timer and is
 * ended by pid, never by name.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertThrowawayClaudeHome, redactKey } from "./claude-canary-safety.js";

export const CLAUDE_BIN = "/opt/homebrew/bin/claude";
export const CC_SOCKS_DIR = "/tmp/cc-socks";
/** Per-call budget ceiling the spawner accepts, in dollars. */
export const MAX_CALL_BUDGET_USD = 1;

export interface ClaudeRunOptions {
	/** The scratch root both directories must sit strictly inside. */
	scratchRoot: string;
	home: string;
	configDir: string;
	cwd: string;
	/** Becomes ANTHROPIC_API_KEY in the child's environment, and is redacted from everything logged or returned. */
	key?: string;
	/** Other environment for the child, e.g. a value an `apiKeyHelper` script prints. Names owned by the spawner or that mark a parent session are refused. */
	env?: Record<string, string>;
	/** Values to redact besides `key` (e.g. what `env` carries for a helper). */
	secrets?: readonly string[];
	/** Kill timer for the child. */
	timeoutMs?: number;
	/** Test seam: a stand-in executable. */
	bin?: string;
	/** The run names no `--model` on purpose (it measures what the config's default does); the budget cap still applies. */
	allowDefaultModel?: boolean;
	/** Where to write a redacted JSONL record of a stream's lines. */
	logPath?: string;
}

const PASSED_FROM_PARENT = ["PATH", "LANG", "SHELL", "TMPDIR"] as const;
const OWNED = [
	"HOME",
	"CLAUDE_CONFIG_DIR",
	"AGENTPULSE_SKIP",
	"DISABLE_AUTOUPDATER",
	"ANTHROPIC_API_KEY",
];
const PARENT_MARKERS =
	/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR|AI_AGENT|ANTHROPIC_.*|AWS_.*|GOOGLE_.*|CLOUD_ML_.*)$/;

/** The exact environment a child gets: this set of names and no others. */
export function claudeEnv(options: ClaudeRunOptions): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of PASSED_FROM_PARENT) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (OWNED.includes(name) || PARENT_MARKERS.test(name)) {
			throw new Error(`${name} is owned by the spawner or marks a parent session`);
		}
		env[name] = value;
	}
	env.HOME = options.home;
	env.CLAUDE_CONFIG_DIR = options.configDir;
	env.AGENTPULSE_SKIP = "1";
	env.DISABLE_AUTOUPDATER = "1";
	if (options.key) env.ANTHROPIC_API_KEY = options.key;
	return env;
}

const REFUSED_FIRST = [
	"attach",
	"login",
	"logout",
	"setup-token",
	"update",
	"install",
	"mcp",
	"plugin",
	"plugins",
	"auth",
	"doctor",
	"config",
	"daemon",
];
const REFUSED_FLAGS = [
	"--dangerously-skip-permissions",
	"--allow-dangerously-skip-permissions",
	"--bg",
	"--background",
	"--chrome",
];

/**
 * Throws unless `args` is something a canary may run: `--version`; `agents --json`; or a print / stream-json run
 * that names its model and caps its spend. The key is never an argument.
 */
export function assertAllowedClaudeArgs(
	args: readonly string[],
	secrets: readonly string[] = [],
	allowDefaultModel = false,
): void {
	for (const arg of args) {
		if (arg.includes("sk-ant-") || secrets.some((s) => s && arg.includes(s))) {
			throw new Error("a credential is in the argv");
		}
	}
	const [first, second] = args;
	if (args.length === 1 && first === "--version") return;
	if (args.length === 2 && first === "agents" && second === "--json") return;
	if (first === undefined || !first.startsWith("-")) {
		throw new Error(`claude ${args.join(" ") || "(no arguments)"} isn't allowed in a canary`);
	}
	if (REFUSED_FIRST.includes(first)) throw new Error(`claude ${first} isn't allowed in a canary`);
	for (const flag of REFUSED_FLAGS) {
		if (args.includes(flag)) throw new Error(`${flag} isn't allowed in a canary`);
	}
	const mode = args.indexOf("--permission-mode");
	if (mode >= 0 && args[mode + 1] === "bypassPermissions") {
		throw new Error("--permission-mode bypassPermissions isn't allowed in a canary");
	}
	const printing =
		args.includes("-p") ||
		args.includes("--print") ||
		args.includes("--output-format") ||
		args.includes("--input-format");
	if (!printing)
		throw new Error("a terminal interface isn't allowed in a canary (no -p, no stream-json)");
	if (!allowDefaultModel && args.indexOf("--model") < 0)
		throw new Error("a canary run names its model (the cheapest)");
	const budget = args.indexOf("--max-budget-usd");
	const amount = budget >= 0 ? Number(args[budget + 1]) : Number.NaN;
	if (!(amount > 0 && amount <= MAX_CALL_BUDGET_USD)) {
		throw new Error(`--max-budget-usd must be in (0, ${MAX_CALL_BUDGET_USD}]`);
	}
}

function checkOptions(args: readonly string[], options: ClaudeRunOptions): void {
	const real = homedir();
	assertThrowawayClaudeHome("HOME", options.home, options.scratchRoot, real);
	assertThrowawayClaudeHome("CLAUDE_CONFIG_DIR", options.configDir, options.scratchRoot, real);
	assertThrowawayClaudeHome("HOME", options.cwd, options.scratchRoot, real);
	assertAllowedClaudeArgs(
		args,
		[options.key ?? "", ...(options.secrets ?? [])],
		options.allowDefaultModel,
	);
}

const secretsOf = (options: ClaudeRunOptions): string[] =>
	[options.key, ...(options.secrets ?? [])].filter((s): s is string => Boolean(s));
const redactAll = (text: string, options: ClaudeRunOptions): string =>
	secretsOf(options).reduce((acc, secret) => redactKey(acc, secret), text);

/** Pids this process started, for the socket scrub and the end-of-run report. */
export const startedPids = new Set<number>();

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * Removes `<pid>.sock` for each of this run's own pids that has exited. A socket of any other pid, live or dead,
 * is someone else's and stays; so does an own pid's socket while the pid is alive (a reused pid is not ours).
 */
export function scrubOwnSockets(
	pids: Iterable<number> = startedPids,
	dir: string = CC_SOCKS_DIR,
	isAlive: (pid: number) => boolean = alive,
): string[] {
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return removed;
	}
	for (const pid of pids) {
		const name = `${pid}.sock`;
		if (!names.includes(name) || isAlive(pid)) continue;
		try {
			unlinkSync(join(dir, name));
			removed.push(name);
		} catch {}
	}
	return removed;
}

export interface ClaudeRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	ms: number;
}

/** Runs `--version` or `agents --json` to completion. */
export function runClaude(args: readonly string[], options: ClaudeRunOptions): ClaudeRunResult {
	checkOptions(args, options);
	const t0 = Date.now();
	const result = spawnSync(options.bin ?? CLAUDE_BIN, [...args], {
		cwd: options.cwd,
		env: claudeEnv(options),
		encoding: "utf8",
		timeout: options.timeoutMs ?? 30_000,
		killSignal: "SIGKILL",
	});
	if (result.pid) startedPids.add(result.pid);
	return {
		status: result.status,
		stdout: redactAll(result.stdout ?? "", options),
		stderr: redactAll(result.stderr ?? "", options),
		ms: Date.now() - t0,
	};
}

type Waiter = {
	pred: (line: Record<string, unknown>) => boolean;
	resolve: (line: Record<string, unknown> | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
	from: number;
};

/** A stream-json child: lines in, lines out, a redacted JSONL record, a kill timer, and an ending ladder by pid. */
export class ClaudeStream {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly lines: Record<string, unknown>[] = [];
	readonly t0 = Date.now();
	stderr = "";
	exitCode: number | null | undefined;
	private buffer = "";
	private waiters: Waiter[] = [];
	private readonly killTimer: ReturnType<typeof setTimeout>;
	private readonly exited: Promise<void>;

	constructor(
		readonly args: readonly string[],
		readonly options: ClaudeRunOptions,
	) {
		checkOptions(args, options);
		this.child = spawn(options.bin ?? CLAUDE_BIN, [...args], {
			cwd: options.cwd,
			env: claudeEnv(options),
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		if (!this.child.pid) throw new Error("claude did not start");
		this.pid = this.child.pid;
		startedPids.add(this.pid);
		this.log("proc", {
			argv: [options.bin ?? CLAUDE_BIN, ...args],
			cwd: options.cwd,
			pid: this.pid,
		});
		this.child.stdout?.on("data", (data: Buffer) => this.onData(String(data)));
		this.child.stderr?.on("data", (data: Buffer) => {
			this.stderr += redactAll(String(data), options);
		});
		this.child.stdin?.on("error", () => {});
		this.exited = new Promise((resolve) =>
			this.child.once("exit", (code) => {
				this.exitCode = code;
				this.log("exit", { code });
				for (const w of this.waiters) {
					clearTimeout(w.timer);
					w.resolve(undefined);
				}
				this.waiters = [];
				resolve();
			}),
		);
		this.killTimer = setTimeout(() => void this.finish(0), options.timeoutMs ?? 120_000);
	}

	private log(kind: string, message: unknown): void {
		if (!this.options.logPath) return;
		const line = JSON.stringify({
			t: Number(((Date.now() - this.t0) / 1000).toFixed(3)),
			d: kind,
			m: message,
		});
		appendFileSync(this.options.logPath, `${redactAll(line, this.options)}\n`);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
			const raw = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (!raw.trim()) continue;
			let line: Record<string, unknown>;
			try {
				line = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				line = { _raw: raw.slice(0, 2000) };
			}
			this.lines.push(line);
			this.log("out", line);
			for (const w of [...this.waiters]) {
				if (w.pred(line)) {
					clearTimeout(w.timer);
					this.waiters = this.waiters.filter((x) => x !== w);
					w.resolve(line);
				}
			}
		}
	}

	send(message: Record<string, unknown>): void {
		this.log("in", message);
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	initialize(request: Record<string, unknown> = {}): string {
		const id = `init-${Math.random().toString(16).slice(2, 10)}`;
		this.send({
			type: "control_request",
			request_id: id,
			request: { subtype: "initialize", ...request },
		});
		return id;
	}

	user(text: string, extra: Record<string, unknown> = {}): void {
		this.send({
			type: "user",
			session_id: "",
			message: { role: "user", content: [{ type: "text", text }] },
			parent_tool_use_id: null,
			...extra,
		});
	}

	respond(requestId: string, response: Record<string, unknown>): void {
		this.send({
			type: "control_response",
			response: { subtype: "success", request_id: requestId, response },
		});
	}

	respondError(requestId: string, error: string): void {
		this.send({
			type: "control_response",
			response: { subtype: "error", request_id: requestId, error },
		});
	}

	/** The first line from now on (or already seen at index `from`) matching `pred`, or undefined on timeout or exit. */
	waitFor(
		pred: (line: Record<string, unknown>) => boolean,
		timeoutMs: number,
		from = 0,
	): Promise<Record<string, unknown> | undefined> {
		const seen = this.lines.slice(from).find(pred);
		if (seen) return Promise.resolve(seen);
		if (this.exitCode !== undefined) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const waiter: Waiter = {
				pred,
				resolve,
				from,
				timer: setTimeout(() => {
					this.waiters = this.waiters.filter((w) => w !== waiter);
					resolve(undefined);
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	isAlive(): boolean {
		return this.exitCode === undefined;
	}

	/** Close stdin, wait `graceMs`, SIGTERM the group this run started, then SIGKILL last. Scrubs this pid's socket. */
	async finish(graceMs = 3000): Promise<number | null | undefined> {
		clearTimeout(this.killTimer);
		try {
			this.child.stdin?.end();
		} catch {}
		const exitedIn = (ms: number) =>
			Promise.race([
				this.exited.then(() => true),
				new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
			]);
		if (!(await exitedIn(graceMs))) {
			this.signalGroup("SIGTERM");
			if (!(await exitedIn(2000))) {
				this.signalGroup("SIGKILL");
				await exitedIn(2000);
			}
		}
		scrubOwnSockets([this.pid]);
		return this.exitCode;
	}

	private signalGroup(signal: NodeJS.Signals): void {
		try {
			process.kill(-this.pid, signal);
		} catch {
			try {
				process.kill(this.pid, signal);
			} catch {}
		}
	}
}
