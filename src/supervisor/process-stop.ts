/**
 * The one stop ladder for every agent process this supervisor runs (AGEN-110, AGEN-117 T11).
 *
 * A ladder is an ordered list of polite steps (close stdin, interrupt), each with a wait, and then
 * SIGTERM and SIGKILL to whatever the process's *reach* covers. Two reaches exist because the two
 * agents leave different things behind:
 *  - `groupReach`: the child leads its own process group (Codex's app-server), so one group signal
 *    reaches it and everything it started that stayed in the group.
 *  - `descendantReach`: Claude's children (a Bash tool) call `setsid` and sit in their own groups, so a
 *    group signal misses them. The reach snapshots the process table from the child downwards and
 *    signals each member by pid, after checking the pid is still the process it recorded.
 *
 * Pid reuse: a recorded member is signalled only if the table still shows that pid with the same start
 * time (`lstart`). A process discovered by walking from a verified parent must also name that parent.
 * The root is never signalled by pid: it is signalled through the handle its spawner holds, which can't
 * be reused. A descendant that was reparented before the snapshot, or started after the last one, is
 * not reachable; that is a stated limit, not a case the ladder pretends to cover.
 *
 * No `pkill`, no name matching: only pids this module recorded from its own child's tree.
 */

export interface ProcessInfo {
	pid: number;
	ppid: number;
	/** `ps -o lstart`: when the process started, to the second. Only ever compared for equality. */
	started: string;
}

export interface ProcessTable {
	list(): Promise<ProcessInfo[]>;
}

/** What the ladder needs to know about the way a process is reached. */
export interface Reach {
	/** Called once before the first step, so a reach that must see the tree while the root lives can record it. */
	prepare?(): Promise<void>;
	signal(signal: "SIGTERM" | "SIGKILL"): Promise<void> | void;
	/**
	 * False when the reach could not look at what the root left behind (the process table never answered while
	 * the root lived), so `gone` is only an answer about the root. Absent means the reach always can.
	 */
	treeChecked?(): boolean;
	/** How often `gone` is checked, when this reach's check is dearer than the default (it runs `ps`). */
	pollMs?: number;
	/** True when nothing this reach covers is left. */
	gone(): Promise<boolean> | boolean;
}

export interface GracefulStep {
	name: string;
	act(): void | Promise<void>;
	/** How long the process gets to leave on its own after this step. */
	waitMs: number;
}

export interface LadderTimings {
	/** After SIGTERM. */
	termMs: number;
	/** After SIGKILL, before the ladder gives up waiting. */
	killMs: number;
}

export interface LadderOptions extends LadderTimings {
	reach: Reach;
	/** Steps tried in order before any signal. Empty: straight to SIGTERM. */
	graceful?: readonly GracefulStep[];
	/** How often `gone` is checked while waiting. */
	pollMs?: number;
}

const DEFAULT_POLL_MS = 25;
const DESCENDANT_POLL_MS = 100;

/**
 * Runs the ladder. Resolves true when everything the reach covers is gone, false when it is still
 * there after SIGKILL and `killMs`. Never throws for a process that is already gone.
 */
export async function runStopLadder(options: LadderOptions): Promise<boolean> {
	const { reach, termMs, killMs } = options;
	const pollMs = options.pollMs ?? reach.pollMs ?? DEFAULT_POLL_MS;

	async function waitGone(ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (!(await reach.gone())) {
			if (Date.now() >= deadline) return false;
			await Bun.sleep(pollMs);
		}
		return true;
	}

	await reach.prepare?.();
	for (const step of options.graceful ?? []) {
		await step.act();
		if (await waitGone(step.waitMs)) return true;
	}
	await reach.signal("SIGTERM");
	if (await waitGone(termMs)) return true;
	await reach.signal("SIGKILL");
	return await waitGone(killMs);
}

// ---- reaches ----

function isPosix(): boolean {
	return process.platform !== "win32";
}

/**
 * A pid this module will never signal, by pid or by group: not a positive integer above 1 (`kill(-1)` and
 * `kill(0)` reach everything the account can), and not this process or its parent. This is the floor under
 * every default killer; the reach logic is what narrows the target further.
 */
export function isSignalablePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

function refuse(pid: number): never {
	throw Object.assign(new Error(`refusing to signal pid ${pid}`), { code: "EPERM" });
}

/** Signals one pid. Refuses a pid `isSignalablePid` rejects, so a wrong target can never be the account. */
export function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
	if (!isSignalablePid(pid)) refuse(pid);
	process.kill(pid, signal);
}

/** Signals the process group a child leads. Refuses the same pids as `defaultKillPid`. */
export function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
	if (!isSignalablePid(pid)) refuse(pid);
	process.kill(-pid, signal);
}

type KillFn = (pid: number, signal: NodeJS.Signals) => void;

let descendantKiller: KillFn = defaultKillPid;
let groupKiller: KillFn = defaultKillGroup;

/**
 * Test seam: replaces the killer every `descendantReach` without its own `killPid` uses, and returns the
 * one it replaced. The supervisor test preload installs a killer that refuses every pid, so a test that
 * reaches the real process table can never signal a process it did not start.
 */
export function __setDescendantKillerForTests(killer: KillFn): KillFn {
	const previous = descendantKiller;
	descendantKiller = killer;
	return previous;
}

/**
 * Test seam: the same for `groupReach`, which signals the group its child leads. The supervisor test
 * preload installs a killer that signals a group only if it belongs to a direct child of the test process.
 */
export function __setGroupKillerForTests(killer: KillFn): KillFn {
	const previous = groupKiller;
	groupKiller = killer;
	return previous;
}

let groupLeaderRecorder: ((pid: number) => void) | null = null;

/**
 * Test seam: from now on every `groupReach` reports the pid of the child handle it was given to `record`.
 * A child that has exited can no longer be asked whether it was ours; the group it leaves behind (a
 * grandchild that outlived it) can only be told apart from a stranger's by a record made while the child
 * lived, so the recorder, not this module, decides whether the pid is worth remembering.
 */
export function __trackGroupLeadersForTests(record: (pid: number) => void): void {
	groupLeaderRecorder = record;
}

function groupAlive(pid: number): boolean {
	if (!isSignalablePid(pid)) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// EPERM means the group exists and is not ours to signal; only ESRCH means it is empty.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The child handle a group reach needs: its pid, whether it has exited, and a direct kill for Windows. */
export interface GroupChild {
	pid?: number;
	hasExited(): boolean;
	kill(signal: NodeJS.Signals): void;
}

export interface GroupReachOptions {
	/** Signals the group a pid leads. Default `defaultKillGroup`; a test substitutes a recorder. */
	killGroup?: KillFn;
}

/** The child leads its own process group (spawned `detached` on POSIX); one signal reaches the group. */
export function groupReach(child: GroupChild, options: GroupReachOptions = {}): Reach {
	const posix = isPosix();
	const killGroup = options.killGroup ?? ((pid, signal) => groupKiller(pid, signal));
	if (child.pid) groupLeaderRecorder?.(child.pid);
	return {
		signal(signal) {
			try {
				if (posix && child.pid && isSignalablePid(child.pid)) killGroup(child.pid, signal);
				else child.kill(signal);
			} catch {
				// Already gone.
			}
		},
		gone() {
			return child.hasExited() && (!posix || !child.pid || !groupAlive(child.pid));
		},
	};
}

function parsePsLine(line: string): ProcessInfo | null {
	const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
	if (!match) return null;
	return { pid: Number(match[1]), ppid: Number(match[2]), started: match[3] as string };
}

/** How long one `ps` may run. A hung `ps` must not hold up a stop: past this it is killed and the table is unreadable. */
export const TABLE_TIMEOUT_MS = 1_500;

export interface SystemProcessTableOptions {
	timeoutMs?: number;
	/** The command that lists processes. Default `ps`; a test substitutes one that hangs. */
	command?: readonly string[];
}

/**
 * The real process table, read with `ps`. A failure to run `ps`, or a `ps` that outlives `timeoutMs` (it is
 * killed through its handle), yields an empty table, never a throw and never a partial listing.
 */
export function createSystemProcessTable(options: SystemProcessTableOptions = {}): ProcessTable {
	const timeoutMs = options.timeoutMs ?? TABLE_TIMEOUT_MS;
	const cmd = [...(options.command ?? ["ps", "-A", "-o", "pid=,ppid=,lstart="])];
	return {
		async list() {
			let proc: ReturnType<typeof Bun.spawn>;
			try {
				proc = Bun.spawn({
					cmd,
					env: { ...process.env, LC_ALL: "C" },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
				});
			} catch {
				return [];
			}
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, timeoutMs);
			try {
				const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
				await proc.exited;
				if (timedOut) return [];
				return text
					.split("\n")
					.map(parsePsLine)
					.filter((row): row is ProcessInfo => row !== null);
			} catch {
				return [];
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

export const systemProcessTable: ProcessTable = createSystemProcessTable();

/** Reads the table, or null if it takes longer than `ms`: an unanswered read counts as an unreadable table. */
async function listWithin(table: ProcessTable, ms: number): Promise<ProcessInfo[] | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([table.list().catch(() => null), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** The root of a descendant reach: a child this process spawned and holds a handle to. */
export interface DescendantRoot {
	pid: number;
	hasExited(): boolean;
	kill(signal: NodeJS.Signals): void;
}

export interface DescendantReachOptions {
	table?: ProcessTable;
	/** Signals a recorded descendant. Default `defaultKillPid`; a test substitutes a recorder. */
	killPid?: KillFn;
	/** How long one read of the process table may take before it counts as unreadable. Default `TABLE_TIMEOUT_MS`. */
	tableTimeoutMs?: number;
	/** The pid whose children the root must be, to count as ours. Default this process. */
	ownPid?: number;
	log?: (line: string) => void;
}

/**
 * The root's descendants by process table snapshot. The root counts as ours only while the table shows
 * it as a child of this process, so a handle with a stale or invented pid (a test double, a pid that
 * since belongs to someone else) walks nothing and signals nothing but its own handle.
 */
export function descendantReach(root: DescendantRoot, options: DescendantReachOptions = {}): Reach {
	const table = options.table ?? systemProcessTable;
	const killPid = options.killPid ?? ((pid, signal) => descendantKiller(pid, signal));
	const ownPid = options.ownPid ?? process.pid;
	const tableTimeoutMs = options.tableTimeoutMs ?? TABLE_TIMEOUT_MS;
	const log = options.log ?? (() => {});
	const recorded = new Map<number, ProcessInfo>();
	let rootAliveAtStart = false;
	let tableReadWhileRootLived = false;

	/**
	 * Fresh listing: members still the process we recorded, plus any new descendants of a verified member.
	 * Null when the table can't be read (an empty listing is never real): nothing is verified then, so
	 * nothing is signalled and nothing is declared gone.
	 */
	async function refresh(): Promise<ProcessInfo[] | null> {
		const rootAlive = !root.hasExited();
		const rows = await listWithin(table, tableTimeoutMs);
		if (rows === null || rows.length === 0) return null;
		if (rootAlive) tableReadWhileRootLived = true;
		const byPid = new Map(rows.map((row) => [row.pid, row]));
		const members = new Map<number, ProcessInfo>();
		for (const [pid, known] of recorded) {
			const now = byPid.get(pid);
			// Reparenting changes ppid, so a recorded member is identified by pid and start time alone.
			if (now && now.started === known.started) members.set(pid, now);
		}
		const rootRow = byPid.get(root.pid);
		const rootIsOurs = !root.hasExited() && rootRow !== undefined && rootRow.ppid === ownPid;
		const parents = new Set<number>(members.keys());
		if (rootIsOurs) parents.add(root.pid);
		let grew = true;
		while (grew) {
			grew = false;
			for (const row of rows) {
				if (members.has(row.pid) || row.pid === root.pid || !parents.has(row.ppid)) continue;
				members.set(row.pid, row);
				parents.add(row.pid);
				grew = true;
			}
		}
		recorded.clear();
		for (const [pid, row] of members) recorded.set(pid, row);
		return [...members.values()];
	}

	return {
		// Each check of `gone` after the root has exited reads the table, which costs a `ps`.
		pollMs: DESCENDANT_POLL_MS,
		async prepare() {
			rootAliveAtStart = !root.hasExited();
			// One more try: a single slow or failed `ps` shouldn't turn a clean stop into an unchecked one.
			if ((await refresh()) === null && rootAliveAtStart) await refresh();
		},
		treeChecked() {
			return !rootAliveAtStart || tableReadWhileRootLived;
		},
		async signal(signal) {
			const members = (await refresh()) ?? [];
			// The root goes last, through its handle.
			for (const member of members) {
				try {
					killPid(member.pid, signal);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "ESRCH")
						log(`[process-stop] ${signal} to a descendant failed: ${code ?? error}`);
				}
			}
			try {
				// Through the handle, even for a root that looks exited: a handle never signals a reused pid.
				root.kill(signal);
			} catch {
				// Already gone.
			}
		},
		async gone() {
			if (!root.hasExited()) return false;
			if (recorded.size === 0) return true;
			const members = await refresh();
			return members !== null && members.length === 0;
		},
	};
}
