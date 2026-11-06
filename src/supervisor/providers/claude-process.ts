/**
 * One `claude` child process on the stream-json wire (AGEN-117 T1, T11): spawn it, wire its pipes to a
 * `ClaudeLink`, and stop it with the one ladder. Shared by the login probes (initialize only) and the fork
 * (a long-lived conversation), so neither has a second way to start or end a Claude.
 *
 * The child is a direct child of this process and is never detached: the ladder reaches its tool processes by
 * process-table snapshot (they call `setsid`, so a group signal would miss them), and the root only by the
 * handle this module holds. Its stderr is drained and never kept: it can echo a credential or a prompt.
 */
import { spawn } from "node:child_process";
import {
	type DescendantReachOptions,
	type GracefulStep,
	TABLE_TIMEOUT_MS,
	descendantReach,
	runStopLadder,
} from "../process-stop.js";
import { ClaudeLink, type ClaudeLinkOptions } from "./claude-wire.js";

export type ClaudeStopTimings = {
	/** After the interrupt (a fork only). */
	interruptMs: number;
	/** After stdin closes. */
	stdinCloseMs: number;
	termMs: number;
	killMs: number;
};

/** A fork: interrupt for 5 s, close stdin for 5 s, SIGTERM for 2 s, SIGKILL (T11). */
export const FORK_STOP_TIMINGS: ClaudeStopTimings = {
	interruptMs: 5_000,
	stdinCloseMs: 5_000,
	termMs: 2_000,
	killMs: 1_000,
};

/** A probe never held a conversation: stdin first, and it leaves at once. */
/** How often the descendant reach checks that nothing is left (its own constant is private). */
const DESCENDANT_POLL_MS = 100;

export const PROBE_STOP_TIMINGS: ClaudeStopTimings = {
	interruptMs: 0,
	stdinCloseMs: 2_000,
	termMs: 2_000,
	killMs: 1_000,
};

export type ClaudeProcess = {
	link: ClaudeLink;
	pid: number;
	/** Resolves once, when the child has exited or never started. */
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	hasExited(): boolean;
	/** Bytes the child wrote to stderr, for the host log line. Never the text. */
	stderrBytes(): number;
	/**
	 * The ladder. A call while one runs returns that one's answer, and so does a call after one that found
	 * everything gone. An answer of `gone: false` is not remembered: a retry runs the ladder again.
	 */
	stop(options?: StopOptions): Promise<{ gone: boolean; checked: boolean }>;
};

export type StopOptions = {
	timings?: Partial<ClaudeStopTimings>;
	/** Run before any wait: the approval tracker's fence goes here. */
	before?: () => void | Promise<void>;
	reach?: Pick<DescendantReachOptions, "table" | "tableTimeoutMs" | "killPid" | "ownPid">;
};

export type SpawnClaudeOptions = {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	link?: ClaudeLinkOptions;
	timings?: ClaudeStopTimings;
};

/** Starts the child. A missing executable rejects here; a child that starts and says nothing is the caller's timeout. */
export async function spawnClaude(options: SpawnClaudeOptions): Promise<ClaudeProcess> {
	const child = spawn(options.executable, options.args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: options.cwd,
		env: options.env,
	});
	child.stdin.on("error", () => {});
	child.stdout.on("error", () => {});
	child.stderr.on("error", () => {});
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", () => reject(new Error("Claude could not be started")));
	});
	child.on("error", () => {});

	let stdinOpen = true;
	const link = new ClaudeLink(
		{
			write(line) {
				if (!stdinOpen || child.stdin.destroyed || child.stdin.writableEnded) return;
				try {
					child.stdin.write(`${line}\n`);
				} catch {
					// A pipe that closed under us is the child going away.
				}
			},
			closeStdin() {
				if (!stdinOpen) return;
				stdinOpen = false;
				try {
					child.stdin.end();
				} catch {}
			},
		},
		options.link,
	);

	let stderrBytes = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
	});
	child.stdout.on("data", (chunk: Buffer) => link.receive(chunk));
	child.stdout.once("end", () => link.transportClosed());

	let exited = false;
	const exitedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve) => {
			child.once("exit", (code, signal) => {
				exited = true;
				link.transportClosed(new Error("Claude exited"));
				resolve({ code, signal });
			});
		},
	);

	const timings = options.timings ?? FORK_STOP_TIMINGS;
	let stopping: Promise<{ gone: boolean; checked: boolean }> | undefined;

	const stop = (stopOptions: StopOptions = {}) => {
		if (stopping) return stopping;
		const t = { ...timings, ...stopOptions.timings };
		stopping = (async () => {
			await stopOptions.before?.();
			const reach = descendantReach(
				{
					pid: child.pid ?? 0,
					hasExited: () => exited,
					kill: (signal) => {
						child.kill(signal);
					},
				},
				stopOptions.reach,
			);
			const graceful: GracefulStep[] = [];
			if (t.interruptMs > 0) {
				graceful.push({
					name: "interrupt",
					act: () => {
						void link.interrupt().catch(() => {});
					},
					waitMs: t.interruptMs,
				});
			}
			graceful.push({
				name: "close stdin",
				act: () => link.close(),
				waitMs: t.stdinCloseMs,
			});
			const gone = await runStopLadder({
				reach,
				graceful,
				termMs: t.termMs,
				// After SIGKILL the process table is read to see that nothing is left; one read can take as long as
				// its timeout, so a shorter wait would call a tree gone (or not) before the table could say.
				killMs: Math.max(t.killMs, TABLE_TIMEOUT_MS + DESCENDANT_POLL_MS),
			});
			return { gone, checked: reach.treeChecked?.() ?? true };
		})();
		const current = stopping;
		// Not remembered when something was left: a retry must be able to try again, not read an old "not gone".
		current.then(
			(result) => {
				if (!result.gone && stopping === current) stopping = undefined;
			},
			() => {
				if (stopping === current) stopping = undefined;
			},
		);
		return current;
	};

	return {
		link,
		pid: child.pid ?? 0,
		exited: exitedPromise,
		hasExited: () => exited,
		stderrBytes: () => stderrBytes,
		stop,
	};
}
