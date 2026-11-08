/**
 * One live Claude canary run at a time per machine (AGEN-119..123, F46): each run spends from its own cap
 * and several would trip the API's rate limit together. The lock is a file in the temporary directory
 * (never under a home directory) holding the holder's pid. A run that finds it held by a live pid waits; one
 * that finds a dead holder's file takes it over. Only ever asks whether a pid exists (signal 0); signals nothing.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CANARY_LOCK_NAME = "agentpulse-claude-canary.lock";

export interface CanaryLockDeps {
	dir?: string;
	pid?: number;
	/** Whether a pid exists. */
	alive: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** How long to wait for a live holder before giving up. */
	timeoutMs?: number;
	pollMs?: number;
	log?: (line: string) => void;
}

export class CanaryLockTimeout extends Error {
	constructor(readonly holder: number) {
		super(`another canary run (pid ${holder}) still holds the lock`);
		this.name = "CanaryLockTimeout";
	}
}

function holderOf(path: string): number | null {
	try {
		const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** Takes the lock, waiting for a live holder. Returns the function that releases it (idempotent). */
export async function acquireCanaryLock(deps: CanaryLockDeps): Promise<() => void> {
	const path = join(deps.dir ?? tmpdir(), CANARY_LOCK_NAME);
	const pid = deps.pid ?? process.pid;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const deadline = now() + (deps.timeoutMs ?? 30 * 60_000);
	let announced = false;
	for (;;) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, `${pid}\n`);
			closeSync(fd);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				// Only our own file: a lock another run took over after we were thought dead is not ours to remove.
				if (holderOf(path) === pid) {
					try {
						unlinkSync(path);
					} catch {
						// already gone
					}
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const holder = holderOf(path);
		if (holder === null || (holder !== pid && !deps.alive(holder))) {
			// A dead or unreadable holder: take the file over.
			try {
				unlinkSync(path);
			} catch {
				// someone else just did
			}
			continue;
		}
		if (holder === pid) throw new Error("this run already holds the canary lock");
		if (now() >= deadline) throw new CanaryLockTimeout(holder);
		if (!announced) {
			announced = true;
			deps.log?.(`[claude] another canary run (pid ${holder}) is in progress; waiting for it`);
		}
		await sleep(deps.pollMs ?? 5_000);
	}
}
