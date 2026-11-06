/**
 * The only way a supervisor test sends a real signal (D10). A guard knows which pids its test started;
 * `killPid` and `killGroup` signal one of those and throw `EPERM` for anything else, sending nothing, so a
 * stop path that picks the wrong target (a mutation, a bug) fails the test instead of reaching a process
 * the test doesn't own: the relay, the supervisor, someone's Claude session.
 *
 * A test records the pids it spawned with `allow`, passes `killPid`/`killGroup` to the code under test
 * (or installs them with `installDescendantKiller` where the code takes no option), and uses `kill` for
 * its own cleanup. Nothing here matches a process by name.
 */
import {
	__setDescendantKillerForTests,
	__setGroupKillerForTests,
	__trackGroupLeadersForTests,
	isSignalablePid,
} from "../process-stop.js";

export interface SignalGuard {
	/** Records a pid this test started (or a descendant of one it started). Returns the pid. */
	allow(pid: number): number;
	killPid(pid: number, signal: NodeJS.Signals): void;
	/** Signals the group a pid led, for a pid this test started as a group leader. */
	killGroup(pid: number, signal: NodeJS.Signals): void;
	/** Signals the guard let through, in order. */
	readonly sent: Array<[number, string]>;
	/** Signals the guard refused, in order. Every suite asserts this is empty in `afterEach`. */
	readonly refused: Array<[number, string]>;
	/** For a test that provokes a refusal on purpose: it asserts the refusal, then clears it. */
	clearRefused(): void;
}

function eperm(pid: number): Error {
	return Object.assign(new Error(`signal guard: pid ${pid} is not in this test's tree`), {
		code: "EPERM",
	});
}

export function createSignalGuard(): SignalGuard {
	const own = new Set<number>();
	const sent: Array<[number, string]> = [];
	const refused: Array<[number, string]> = [];

	function check(pid: number, signal: NodeJS.Signals) {
		if (!isSignalablePid(pid) || !own.has(pid)) {
			refused.push([pid, signal]);
			throw eperm(pid);
		}
		sent.push([pid, signal]);
	}

	return {
		allow(pid) {
			own.add(pid);
			return pid;
		},
		killPid(pid, signal) {
			check(pid, signal);
			process.kill(pid, signal);
		},
		killGroup(pid, signal) {
			check(pid, signal);
			process.kill(-pid, signal);
		},
		sent,
		refused,
		clearRefused() {
			refused.length = 0;
		},
	};
}

/** Makes `descendantReach` calls with no `killPid` option use this guard. Returns the restore function. */
export function installDescendantKiller(guard: SignalGuard): () => void {
	const previous = __setDescendantKillerForTests(guard.killPid);
	return () => void __setDescendantKillerForTests(previous);
}

/** The descendant killer the preload installs: every pid is refused, nothing is sent. */
export function refuseEverySignal(pid: number): never {
	throw eperm(pid);
}

/** `ppid` and `pgid` of a live process, from `ps`, or null when there is no such process. */
function psRow(pid: number): { ppid: number; pgid: number } | null {
	if (!Number.isInteger(pid) || pid <= 1) return null;
	const ps = Bun.spawnSync({
		cmd: ["ps", "-o", "ppid=,pgid=", "-p", String(pid)],
		stderr: "ignore",
	});
	const text = new TextDecoder().decode(ps.stdout).trim();
	if (text === "") return null;
	const [ppid, pgid] = text.split(/\s+/).map(Number);
	return { ppid: ppid as number, pgid: pgid as number };
}

/** Group leaders worth remembering: each was a live direct child of this process when it was recorded. */
const recordedLeaders = new Set<number>();

/**
 * Notes a pid `groupReach` was handed, but only if it is a live direct child of this process right now. An
 * invented pid (4242), a dead one, the parent or a stranger is ignored and so never authorises a signal.
 */
function recordGroupLeader(pid: number): void {
	if (psRow(pid)?.ppid === process.pid) recordedLeaders.add(pid);
}

/**
 * Names a group leader a test started so the preload's group killer may signal its group after the leader
 * has exited. Refuses (throws) a pid that is not a live direct child of this process: there is nothing a
 * test could legitimately mean by it.
 */
export function allowGroupSignalsTo(pid: number): number {
	if (psRow(pid)?.ppid !== process.pid) {
		throw new Error(`signal guard: pid ${pid} is not a live direct child of this test process`);
	}
	recordedLeaders.add(pid);
	return pid;
}

/**
 * Does `pid` lead a process group that belongs to this test process? Read from `ps` and from what was
 * recorded while the leader was a live child, never from what the code under test says about its target:
 *  - a live process is ours only if it is a direct child of this process and leads its own group;
 *  - a process that is gone left its group to whatever outlived it (a grandchild), and that group is ours
 *    only if its pid was recorded while it was a live direct child.
 * A foreign live pid (the parent, pid 1, a stranger's) fails the first test whatever was recorded.
 */
function leadsOurGroup(pid: number): boolean {
	const row = psRow(pid);
	if (row === null) return Number.isInteger(pid) && pid > 1 && recordedLeaders.has(pid);
	return row.ppid === process.pid && row.pgid === pid;
}

/** Builds the group killer the preload installs. */
function ownGroupKiller(pid: number, signal: NodeJS.Signals): void {
	if (!isSignalablePid(pid) || !leadsOurGroup(pid)) throw eperm(pid);
	process.kill(-pid, signal);
}

/** Installs both preload killers. The preload calls this; so does the canary that proves it ran. */
export function installPreloadKillers(): void {
	__setDescendantKillerForTests(refuseEverySignal);
	__trackGroupLeadersForTests(recordGroupLeader);
	__setGroupKillerForTests(ownGroupKiller);
}
