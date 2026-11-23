/**
 * The supervisor's half of an update: a status file the updater reads, and the drain request it may write.
 *
 * The updater first waits, without changing what the supervisor does, until this file says the host has
 * been idle for a minute. Only then does it write `update-drain.json`. While a fresh drain is present the
 * supervisor keeps both claim loops running and keeps handling stop, interrupt, rename, workarea cleanup
 * and approvals; it fails a claimed launch, prompt, resume, retry or fork at once with a fixed sentence.
 * So new work is refused only for the few minutes a drain lasts on a host that was already idle, and a
 * person can always stop a session.
 *
 * Idle means no Codex runtime, no headless or stream Claude runtime, no live terminal bridge (and the
 * count was learned: unknown is busy), no open approval and nothing in flight in the two handlers.
 *
 * A drain is believed only while it is fresh: it must parse, expire within 15 minutes, have been requested
 * within the last 15 minutes and not have expired. A same-user process can keep writing one (stated residual:
 * that is same-user code, and Stop still works). Nothing here signals a process.
 */
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import { processIdentity } from "../../shared/process-identity.js";
import {
	type DrainRequest,
	SUPERVISOR_STATUS_FILE,
	type SupervisorStatus,
	readDrainRequest,
} from "../../shared/update-files.js";

const DRAIN_MAX_AHEAD_MS = 15 * 60_000;
const DRAIN_MAX_AGE_MS = 15 * 60_000;

/** What the idle test counts. `bridges` is null when the count could not be learned. */
export interface IdleCounts {
	codex: number;
	headless: number;
	bridges: number | null;
	approvals: number;
	inFlight: number;
}

/** Sibling of `shouldExitOnStaleHeartbeat`: whether an update may take this host down now. */
export function isUpdateIdle(counts: IdleCounts): boolean {
	return (
		counts.bridges === 0 &&
		counts.codex === 0 &&
		counts.headless === 0 &&
		counts.approvals === 0 &&
		counts.inFlight === 0
	);
}

/** True while `drain` is believable. */
export function drainIsFresh(drain: DrainRequest | null, now: number): boolean {
	if (!drain) return false;
	if (drain.expiresAt <= now) return false;
	if (drain.expiresAt - now > DRAIN_MAX_AHEAD_MS) return false;
	if (now - drain.requestedAt > DRAIN_MAX_AGE_MS) return false;
	return drain.requestedAt - now <= DRAIN_MAX_AHEAD_MS;
}

/** Both claim loops ask this for what they just claimed: true means "handle it as always". */
export function shouldClaimNormally(drain: DrainRequest | null, now: number): boolean {
	return !drainIsFresh(drain, now);
}

/** Work that still runs during a drain; everything else claimed is refused, including a kind this build doesn't know. */
const ALLOWED_UNDER_DRAIN: ReadonlySet<string> = new Set([
	"stop",
	"interrupt",
	"rename",
	"cleanup_workarea",
]);

/** Under a fresh drain: whether a claimed item of this kind is refused with the fixed sentence. */
export function refuseUnderDrain(kind: string): boolean {
	return !ALLOWED_UNDER_DRAIN.has(kind);
}

/**
 * What both claim loops do with a claimed launch or control action: under a fresh drain a kind that isn't
 * on the allowed list is refused with the fixed sentence (`refuse`), anything else runs as always (`handle`,
 * counted as in flight while it runs).
 */
export async function routeClaimed(input: {
	drain: UpdateDrain;
	kind: string;
	now?: () => number;
	handle: () => Promise<void>;
	refuse: () => Promise<void>;
}): Promise<void> {
	const at = (input.now ?? Date.now)();
	if (!shouldClaimNormally(input.drain.current(), at) && refuseUnderDrain(input.kind)) {
		await input.refuse();
		return;
	}
	await input.drain.track(input.handle);
}

export interface UpdateDrainDeps {
	home: string;
	version: string;
	now?: () => number;
	/** The idle counts right now. A throw or a rejection reads as busy. */
	counts: () => Promise<Omit<IdleCounts, "inFlight">>;
	/** Test seam for the file read. */
	readDrain?: (home: string) => DrainRequest | null;
	write?: (path: string, content: string) => void;
	pid?: number;
	processStartedAt?: string | null;
}

export interface UpdateDrain {
	/** Counts one call to a handler for as long as it runs, so a busy handler keeps the host from reading idle. */
	track<T>(work: () => Promise<T>): Promise<T>;
	/** The drain request on disk, read fresh. Pass it to `shouldClaimNormally`. */
	current(): DrainRequest | null;
	/** Learns the idle state and writes the status file; never throws. Called from the watchdog tick. */
	tick(): Promise<void>;
	/** Registration happened: the status file says `registered: true` from the next tick on. */
	markRegistered(): void;
}

export function createUpdateDrain(deps: UpdateDrainDeps): UpdateDrain {
	const now = deps.now ?? Date.now;
	const readDrain = deps.readDrain ?? readDrainRequest;
	const write = deps.write ?? writePrivateFileAtomicNoFollow;
	const pid = deps.pid ?? process.pid;
	let startedAt = deps.processStartedAt;
	const path = join(deps.home, ".agentpulse", SUPERVISOR_STATUS_FILE);
	let inFlight = 0;
	let registered = false;
	let idleSince: number | null = null;

	return {
		async track(work) {
			inFlight++;
			try {
				return await work();
			} finally {
				inFlight--;
			}
		},
		current: () => readDrain(deps.home),
		markRegistered() {
			registered = true;
		},
		async tick() {
			try {
				const at = now();
				let idle = false;
				try {
					idle = isUpdateIdle({ ...(await deps.counts()), inFlight });
				} catch {
					idle = false;
				}
				idleSince = idle ? (idleSince ?? at) : null;
				if (startedAt === undefined) startedAt = processIdentity(pid);
				const draining = drainIsFresh(readDrain(deps.home), at);
				const status: SupervisorStatus = {
					version: deps.version,
					pid,
					processStartedAt: startedAt ?? null,
					writtenAt: at,
					registered,
					idleSince,
					inFlight,
					draining,
					drained: draining && idle,
				};
				write(path, `${JSON.stringify({ schema: 1, ...status })}\n`);
			} catch (error) {
				console.warn(
					`[supervisor] couldn't write the update status file: ${(error as Error).name}`,
				);
			}
		},
	};
}
