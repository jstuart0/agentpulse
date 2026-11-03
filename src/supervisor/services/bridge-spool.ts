/**
 * Drains the interactive terminal bridge's spool through the report gate.
 *
 * The bridge (scripts/claude_terminal_bridge.py) runs in a terminal the user opened. It holds no credential
 * and opens no connection: everything it would report, the start state, each prompt typed, the exit state
 * and the end event, it writes as one private file per report into `<bridge dir>/reports/`. This drain,
 * which runs inside the supervisor, reads those files and sends them with the gate's `reportState` and
 * `reportEvents`, so the user's exclude rules apply to the bridge's reports exactly as to every other.
 *
 * What it trusts, and what it does not:
 *  - The directory a report belongs to is the bridge directory's name, which is the launch's correlation id.
 *    The gate judges that id by the directory THIS supervisor learned when it started the launch. The `cwd`
 *    in `bridge.json` is never read, because any process of this user can rewrite it. A directory the gate
 *    doesn't know is judged unknown: sent when there are no rules, excluded (dropped) while rules exist.
 *  - The nonce in `bridge.json` and in each report only tells a report written for this launch from a stale
 *    file an earlier launch left in the same directory. It is not a security control.
 *  - Each report is checked against a whitelist (exact keys, allowed event types, size caps) before it is
 *    handed to the gate; one that fails is deleted and counted lost.
 *
 * What it does with each answer from the gate (the report's file is `kept` or `unlinked`):
 *   sent / queued / excluded   unlinked
 *   blocked                    kept; the whole tick stops (the rules can't be trusted right now)
 *   thrown entry / session     unlinked, counted lost
 *   thrown network / server /
 *     backoff / stop / other   kept; this directory stops for the tick
 *   thrown credential          kept; the shared tripwire records it, and a confirmed rejection ends the supervisor
 *
 * Bounds: at most 256 directories are followed, 50 files are sent from one directory and 200 in all per tick,
 * one tick at a time. A directory that is idle costs one `stat` per tick; a history of thousands of finished
 * bridges costs one directory listing and one `lstat` each per minute, and no reads.
 */
import { createHash } from "node:crypto";
import { lstatSync, statSync, unlinkSync } from "node:fs";
import { lstat as fsLstat, readdir as fsReaddir } from "node:fs/promises";
import { join } from "node:path";
import { LATE_ARRIVAL_MS } from "../../shared/late-arrival.js";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { disposeRuntimesAndExit } from "./fatal-exit.js";
import {
	type PrivateFileRead,
	SESSION_ID_PATTERN,
	isPrivateOwnStat,
	isTrustedStateFileStat,
	readPrivateFileNoFollow,
} from "./private-store.js";
import type { ReportGate } from "./report-gate.js";
import { type CredentialTripwire, classifyReportFailure } from "./report-resilience.js";

export const MAX_ACTIVE_DIRS = 256;
export const MAX_FILES_PER_DIR = 50;
export const MAX_FILES_PER_TICK = 200;
export const SCAN_INTERVAL_MS = 60_000;
/** A directory admitted by a launch but whose bridge hasn't written anything yet is followed this long. */
const MISSING_REPORTS_GRACE_MS = 10 * 60_000;
const BRIDGE_ALIVE_MS = 90_000;
/** An idle followed directory is checked for a living bridge this often, with one stat. */
const LIVENESS_RECHECK_MS = 90_000;
/** Names read from one reports directory; the bridge never keeps more than ~2,000 and nothing else belongs there. */
const MAX_LISTED_NAMES = 2_000;
/** Directories found by the scan but not yet followed, because the followed set is full. */
const MAX_PENDING_ADMIT = 4_096;
/** The scan gives the event loop a turn this often. */
const SCAN_YIELD_EVERY = 200;
const MAX_UNLINK_FAILURES = 3;
/** Files whose removal has failed for good, remembered across a directory being dropped and followed again. */
const MAX_REMEMBERED_STUCK = 1_024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;
const MAX_RAW_PAYLOAD_KEYS = 4;
const MAX_RAW_PAYLOAD_BYTES = 1024;
const MAX_LOST_TOTAL = 10_000_000;
const ENTRY_PATTERN = /^\d{16}\.json$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const STATE_STATUSES = new Set(["active", "completed", "failed"]);
const STATE_MANAGED_STATES = new Set(["interactive_terminal", "completed", "failed"]);
const EVENT_TYPES = new Set(["InteractivePromptObserved", "InteractiveSessionEnded"]);
const EVENT_CATEGORIES = new Set(["prompt", "system_event"]);
const LEGACY_BRIDGE_KEYS = ["server_url", "supervisor_id", "supervisor_token", "api_key"];

/** What the drain needs to know about a file or directory (a subset of `fs.Stats`). */
export interface SpoolStat {
	mtimeMs: number;
	uid: number;
	mode: number;
	isSymbolicLink(): boolean;
	isDirectory(): boolean;
	isSocket(): boolean;
}

export interface BridgeSpoolDeps {
	gate: Pick<ReportGate, "reportState" | "reportEvents" | "isInteractiveLaunch">;
	home: string;
	now?: () => number;
	log?: (line: string) => void;
	/** The one tripwire the heartbeat and the outbox flush also feed. */
	credentialTripwire: CredentialTripwire;
	/** Called once the tripwire confirms the credential was rejected; the default disposes the runtimes and exits. */
	onCredentialRejected?: () => void | Promise<void>;
	/** Test seams for the filesystem; the defaults are the real one. */
	readdir?: (path: string) => Promise<string[]>;
	stat?: (path: string) => Promise<SpoolStat>;
	readFile?: (path: string, maxBytes: number) => PrivateFileRead;
	isPidAlive?: (pid: number) => boolean;
	/** Removes a handled report file; a test makes it fail to prove the same delivery id is resent. */
	unlink?: (path: string) => void;
}

export interface BridgeSpoolDrain {
	/** Follows this bridge directory (a launch's correlation id). */
	admit(sessionId: string): void;
	/** One pass over the followed directories; an overlapping call returns the pass already running. */
	drain(): Promise<void>;
	/** Whether this bridge directory is still in use: followed by the drain, or its pid file touched within 90 s. */
	isBridgeActive(sessionId: string): boolean;
	/** How many followed bridges are alive: a pid file naming a live process, touched within 90 s. */
	liveBridgeCount(): Promise<number>;
	/** Removes the credentials an older supervisor wrote into `bridge.json`; returns how many files it rewrote. */
	scrubLegacyBridgeConfigs(): Promise<number>;
	stats(): { sent: number; lost: number; followed: number };
}

interface Followed {
	id: string;
	dir: string;
	reportsDir: string;
	admittedAt: number;
	nonce?: string | null;
	lastMtimeMs: number | null;
	/** Files were left (kept or past the cap) at the last look, so the next tick looks again whatever the mtime says. */
	backlog: boolean;
	/** When this directory's bridge was last known alive, so an idle one is rechecked now and then. */
	livenessCheckedAt: number;
	firstSeen: Map<string, number>;
	/** Files that could not be removed after they were handled, with how many times: past a few they are left alone rather than resent every tick. */
	unlinkFailures: Map<string, number>;
	warned: Set<string>;
}

type FileVerdict = "next" | "stopDir" | "stopAll";

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === allowed.length && allowed.every((key) => keys.includes(key));
}

function boundedObject(value: unknown, maxKeys: number, maxBytes: number): boolean {
	if (!isObject(value)) return false;
	if (Object.keys(value).length > maxKeys) return false;
	return Buffer.byteLength(JSON.stringify(value), "utf-8") <= maxBytes;
}

const isSmallPositiveInt = (v: unknown) =>
	typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 2 ** 31;

/**
 * The metadata a bridge may send, exactly: `launchMode`, `interactiveBridge` (its own socket path, which is
 * known from the directory, and two process ids) and, once it has ended, `exitCode`.
 */
function validMetadata(metadata: unknown, dir: string, ended: boolean): boolean {
	if (!isObject(metadata)) return false;
	const keys = Object.keys(metadata);
	const allowed = ended
		? ["launchMode", "interactiveBridge", "exitCode"]
		: ["launchMode", "interactiveBridge"];
	if (keys.length !== allowed.length || !allowed.every((k) => keys.includes(k))) return false;
	if (metadata.launchMode !== "interactive_terminal") return false;
	const bridge = metadata.interactiveBridge;
	if (!isObject(bridge) || !hasExactKeys(bridge, ["socketPath", "bridgePid", "childPid"]))
		return false;
	if (bridge.socketPath !== join(dir, "control.sock")) return false;
	if (!isSmallPositiveInt(bridge.bridgePid) || !isSmallPositiveInt(bridge.childPid)) return false;
	if (ended) {
		const code = metadata.exitCode;
		if (typeof code !== "number" || !Number.isInteger(code) || code < -255 || code > 255)
			return false;
	}
	return true;
}

/** The state body a bridge may send, or null. `id` is the vetted directory name, `dir` its path. */
function validState(body: unknown, id: string, dir: string): ManagedSessionStateInput | null {
	if (!isObject(body)) return null;
	if (
		!hasExactKeys(body, [
			"sessionId",
			"status",
			"managedState",
			"providerSessionId",
			"correlationSource",
			"metadata",
		])
	) {
		return null;
	}
	if (body.sessionId !== id || body.providerSessionId !== id) return null;
	if (typeof body.status !== "string" || !STATE_STATUSES.has(body.status)) return null;
	if (typeof body.managedState !== "string" || !STATE_MANAGED_STATES.has(body.managedState)) {
		return null;
	}
	if (body.correlationSource !== "launch_correlation_id") return null;
	if (!validMetadata(body.metadata, dir, body.managedState !== "interactive_terminal")) return null;
	return body as unknown as ManagedSessionStateInput;
}

/** The one event a bridge may send, whitelisted field by field, or null. */
function validEvent(body: unknown): ManagedSessionEventInput | null {
	if (!isObject(body) || !hasExactKeys(body, ["events"])) return null;
	if (!Array.isArray(body.events) || body.events.length !== 1) return null;
	const event = body.events[0];
	if (!isObject(event)) return null;
	if (!hasExactKeys(event, ["eventType", "category", "content", "rawPayload"])) return null;
	if (typeof event.eventType !== "string" || !EVENT_TYPES.has(event.eventType)) return null;
	if (typeof event.category !== "string" || !EVENT_CATEGORIES.has(event.category)) return null;
	if (typeof event.content !== "string" || event.content.length > MAX_CONTENT_CHARS) return null;
	if (!boundedObject(event.rawPayload, MAX_RAW_PAYLOAD_KEYS, MAX_RAW_PAYLOAD_BYTES)) return null;
	return {
		eventType: event.eventType,
		category: event.category as ManagedSessionEventInput["category"],
		content: event.content,
		rawPayload: event.rawPayload as Record<string, unknown>,
	};
}

function lostId(dir: string, lostTotal: number): string {
	return createHash("sha256").update(`${dir}:lost:${lostTotal}`).digest("hex").slice(0, 32);
}

function clampLost(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_LOST_TOTAL, Math.max(0, Math.trunc(value)));
}

export function createBridgeSpoolDrain(deps: BridgeSpoolDeps): BridgeSpoolDrain {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? ((line: string) => console.log(line));
	const onCredentialRejected = deps.onCredentialRejected ?? disposeRuntimesAndExit;
	const root = join(deps.home, ".agentpulse", "interactive");

	const readdir = deps.readdir ?? ((path: string) => fsReaddir(path));
	const stat = deps.stat ?? (async (path: string) => (await fsLstat(path)) as unknown as SpoolStat);
	const readFile = deps.readFile ?? readPrivateFileNoFollow;
	const unlink = deps.unlink ?? unlinkSync;
	const isPidAlive =
		deps.isPidAlive ??
		((pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch (error) {
				return (error as NodeJS.ErrnoException)?.code === "EPERM";
			}
		});
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const privateDir = (st: SpoolStat) => isPrivateOwnStat(st, "directory", uid);

	const followed = new Map<string, Followed>();
	/** Names seen by the parent scan: the directory's mtime when last examined, and reports/'s too when it was dead and empty. */
	const known = new Map<string, { dir: number; reports?: number }>();
	/**
	 * Report files that could not be removed three times (an unwritable directory), by directory and name,
	 * with the file's identity. A directory dropped and followed again starts with no memory of its own, so
	 * without this each scan would send such a file three more times for ever. Bounded; forgotten at a
	 * restart (a restart sends the file up to three more times, then it is remembered again).
	 */
	const stuck = new Map<string, Map<string, string>>();
	let stuckCount = 0;
	/** Directories the scan found that wait for room among the followed ones: name, mtime, probed nonce. */
	const pendingAdmit = new Map<string, { mtimeMs: number; nonce: string }>();
	/** The first pass after the drain starts treats every file it finds as a replay: it was written before this process existed. */
	let firstPass = true;
	let lastScanAt = Number.NEGATIVE_INFINITY;
	let running: Promise<void> | null = null;
	let sent = 0;
	let lostCount = 0;

	function newFollowed(id: string): Followed {
		const dir = join(root, id);
		return {
			id,
			dir,
			reportsDir: join(dir, "reports"),
			admittedAt: now(),
			lastMtimeMs: null,
			backlog: false,
			livenessCheckedAt: now(),
			firstSeen: new Map(),
			unlinkFailures: new Map(),
			warned: new Set(),
		};
	}

	function follow(id: string, nonce?: string): Followed | null {
		const existing = followed.get(id);
		if (existing) return existing;
		if (followed.size >= MAX_ACTIVE_DIRS) return null;
		const entry = newFollowed(id);
		// A nonce the scan already read is not read again.
		if (nonce !== undefined) entry.nonce = nonce;
		followed.set(id, entry);
		return entry;
	}

	/**
	 * Stops following a bridge that looks gone. The scan's memory of the directory is forgotten with it: a
	 * bridge that was only asleep (a laptop closed) comes back without changing the directory's own mtime,
	 * so a scan that still remembered it would skip it for good.
	 */
	function drop(id: string) {
		followed.delete(id);
		known.delete(id);
	}

	function admit(sessionId: string) {
		if (SESSION_ID_PATTERN.test(sessionId)) follow(sessionId);
	}

	function nonceOf(entry: Followed): string | null {
		if (entry.nonce !== undefined) return entry.nonce;
		const found = readFile(join(entry.dir, "bridge.json"), MAX_CONFIG_BYTES);
		let nonce: string | null = null;
		if (found.kind === "ok") {
			try {
				const parsed: unknown = JSON.parse(found.text);
				if (isObject(parsed) && typeof parsed.launchNonce === "string") {
					if (NONCE_PATTERN.test(parsed.launchNonce)) nonce = parsed.launchNonce;
				}
			} catch {
				nonce = null;
			}
		}
		entry.nonce = nonce;
		return nonce;
	}

	/** Whether this directory's bridge is running: a pid file naming a live process that was touched lately. */
	async function bridgeAlive(entry: Followed): Promise<boolean> {
		const path = join(entry.dir, "bridge.pid");
		try {
			const st = await stat(path);
			if (now() - st.mtimeMs > BRIDGE_ALIVE_MS) return false;
		} catch {
			return false;
		}
		const found = readFile(path, 256);
		if (found.kind !== "ok") return false;
		try {
			const parsed: unknown = JSON.parse(found.text);
			const pid = isObject(parsed) ? parsed.pid : undefined;
			return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
		} catch {
			return false;
		}
	}

	/** One stat: the pid file was touched within the last 90 s. Enough to tell a dead bridge from a quiet one. */
	async function pidFresh(entry: Followed): Promise<boolean> {
		try {
			const st = await stat(join(entry.dir, "bridge.pid"));
			return now() - st.mtimeMs <= BRIDGE_ALIVE_MS;
		} catch {
			return false;
		}
	}

	function warnOnce(entry: Followed, key: string, line: string) {
		if (entry.warned.has(key)) return;
		entry.warned.add(key);
		log(line);
	}

	/** Removes a handled report file. If it can't be removed it stays, and so is sent again (same delivery id) on a later tick, a few times at most. */
	function discard(entry: Followed, name: string, countLost: boolean) {
		try {
			// A path, never followed: unlink removes a link itself.
			unlink(join(entry.reportsDir, name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				const failures = (entry.unlinkFailures.get(name) ?? 0) + 1;
				entry.unlinkFailures.set(name, failures);
				if (failures >= MAX_UNLINK_FAILURES) {
					rememberStuck(entry.id, name, join(entry.reportsDir, name));
					warnOnce(
						entry,
						`unlink-${name}`,
						`[supervisor] a handled bridge report can't be removed and is left alone: ${entry.id}`,
					);
				}
				return;
			}
		}
		entry.firstSeen.delete(name);
		entry.unlinkFailures.delete(name);
		forgetStuck(entry.id, name);
		if (countLost) lostCount++;
	}

	function identityOf(path: string): string | null {
		try {
			const st = lstatSync(path);
			// ctime moves on a rewrite or replacement and cannot be set back with utimes, so a changed file normally
			// doesn't match; on a filesystem with coarse timestamps a rewrite of equal size inside the same tick can
			// still look unchanged and is withheld until a restart (the bridge never rewrites a report). A link-count
			// or mode change moves ctime too, which only costs up to three more sends.
			return `${st.ino}:${st.size}:${st.ctimeMs}:${st.mtimeMs}`;
		} catch {
			return null;
		}
	}

	function rememberStuck(id: string, name: string, path: string) {
		const identity = identityOf(path);
		if (identity === null) return;
		let names = stuck.get(id);
		if (!names) {
			names = new Map();
			stuck.set(id, names);
		}
		if (!names.has(name)) stuckCount++;
		names.set(name, identity);
		// Over the bound, the oldest directory's memory goes first: its files are sent again, up to three times.
		while (stuckCount > MAX_REMEMBERED_STUCK) {
			const oldest = stuck.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			stuckCount -= stuck.get(oldest)?.size ?? 0;
			stuck.delete(oldest);
		}
	}

	function forgetStuck(id: string, name: string) {
		const names = stuck.get(id);
		if (names?.delete(name)) stuckCount--;
		if (names && names.size === 0) stuck.delete(id);
	}

	/** Carries what is remembered about this directory's unremovable files into its (possibly new) entry, for those still there and still the same file. */
	function restoreStuck(entry: Followed, listed: Set<string>) {
		const names = stuck.get(entry.id);
		if (!names) return;
		for (const [name, identity] of [...names]) {
			if (!listed.has(name)) {
				forgetStuck(entry.id, name); // gone: removed by someone else
			} else if (!entry.unlinkFailures.has(name)) {
				if (identityOf(join(entry.reportsDir, name)) === identity) {
					entry.unlinkFailures.set(name, MAX_UNLINK_FAILURES);
				} else {
					forgetStuck(entry.id, name); // a different file under that name: a new report
				}
			}
		}
	}

	async function credentialRejected(): Promise<void> {
		if (deps.credentialTripwire.record() === "confirmed") await onCredentialRejected();
	}

	/** Whether the file is a private plain file of this account whose only fault is being over the size limit. */
	function isTooLarge(path: string): boolean {
		try {
			const st = lstatSync(path);
			return (
				isTrustedStateFileStat(st, process.getuid?.(), Number.MAX_SAFE_INTEGER) &&
				st.size > MAX_FILE_BYTES
			);
		} catch {
			return false;
		}
	}

	/** Reads, checks and sends one report file. */
	async function sendFile(entry: Followed, name: string, nonce: string): Promise<FileVerdict> {
		const path = join(entry.reportsDir, name);
		const found = readFile(path, MAX_FILE_BYTES);
		if (found.kind === "absent") {
			entry.firstSeen.delete(name);
			return "next";
		}
		if (found.kind === "untrusted") {
			// A report this account wrote privately but that is larger than the bridge ever writes can never
			// be sent: it is removed and counted lost, not kept for ever as if it might be tampered with.
			if (isTooLarge(path)) {
				discard(entry, name, true);
				return "next";
			}
			warnOnce(
				entry,
				name,
				`[supervisor] a bridge report isn't a private plain file and was left alone: ${entry.id}`,
			);
			return "next";
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(found.text);
		} catch {
			envelope = null;
		}
		const checked = checkEnvelope(envelope, entry.id, nonce);
		if (!checked) {
			discard(entry, name, true);
			return "next";
		}
		const firstSeen = entry.firstSeen.get(name) ?? now();
		entry.firstSeen.set(name, firstSeen);
		const replay = now() - firstSeen > LATE_ARRIVAL_MS;
		try {
			const outcome =
				checked.kind === "state"
					? (await deps.gate.reportState(checked.state, { replay })).outcome
					: await deps.gate.reportEvents(
							entry.id,
							[{ ...checked.event, occurredAt: checked.occurredAt }],
							{ deliveryId: checked.deliveryId, replay },
						);
			if (outcome === "blocked") return "stopAll";
			// Only a report the server took proves the credential still works; one that was queued or
			// excluded never reached it.
			if (outcome === "sent") deps.credentialTripwire.reset();
			sent++;
			discard(entry, name, false);
			return "next";
		} catch (error) {
			const kind = classifyReportFailure(error);
			if (kind === "entry" || kind === "session") {
				discard(entry, name, true);
				return "next";
			}
			if (kind === "credential") await credentialRejected();
			return "stopDir";
		}
	}

	type Checked =
		| { kind: "state"; state: ManagedSessionStateInput; occurredAt: string }
		| {
				kind: "events";
				event: ManagedSessionEventInput;
				occurredAt: string;
				deliveryId: string;
		  };

	/** The report if its envelope and body pass the whitelist for this directory, else null. */
	function checkEnvelope(envelope: unknown, id: string, nonce: string): Checked | null {
		if (!isObject(envelope) || envelope.v !== 1 || envelope.nonce !== nonce) return null;
		if (typeof envelope.occurredAt !== "string") return null;
		if (parseStoredTimestamp(envelope.occurredAt) === null) return null;
		if (envelope.kind === "state") {
			if (!hasExactKeys(envelope, ["v", "nonce", "kind", "occurredAt", "body"])) return null;
			const state = validState(envelope.body, id, join(root, id));
			return state ? { kind: "state", state, occurredAt: envelope.occurredAt } : null;
		}
		if (envelope.kind === "events") {
			if (!hasExactKeys(envelope, ["v", "nonce", "kind", "occurredAt", "deliveryId", "body"])) {
				return null;
			}
			if (typeof envelope.deliveryId !== "string") return null;
			if (!DELIVERY_ID_PATTERN.test(envelope.deliveryId)) return null;
			const event = validEvent(envelope.body);
			return event
				? {
						kind: "events",
						event,
						occurredAt: envelope.occurredAt,
						deliveryId: envelope.deliveryId,
					}
				: null;
		}
		return null;
	}

	/** Reports the bridge's own count of reports it couldn't write, once per new total. */
	async function sendLostDelta(entry: Followed): Promise<FileVerdict> {
		const bridgeSays = readFile(join(entry.reportsDir, "lost"), 4096);
		if (bridgeSays.kind !== "ok") return "next";
		let total = 0;
		try {
			const parsed: unknown = JSON.parse(bridgeSays.text);
			total = isObject(parsed) ? clampLost(parsed.lostTotal) : 0;
		} catch {
			return "next";
		}
		let acked = 0;
		const ackedFile = readFile(join(entry.reportsDir, ".lost-acked"), 4096);
		if (ackedFile.kind === "ok") acked = clampLost(Number(ackedFile.text.trim()));
		if (total <= acked) return "next";
		const delta = total - acked;
		// The time is the lost file's own, so a retry of the same total carries the same bytes.
		let occurredAt: string;
		try {
			occurredAt = new Date((await stat(join(entry.reportsDir, "lost"))).mtimeMs).toISOString();
		} catch {
			return "next";
		}
		try {
			const outcome = await deps.gate.reportEvents(
				entry.id,
				[
					{
						eventType: "ManagedEventsLost",
						category: "system_event",
						source: "launch_system",
						content: `${delta === 1 ? "1 report from this terminal session wasn't" : `${delta} reports from this terminal session weren't`} delivered: the terminal's report spool was full or couldn't be written.`,
						rawPayload: { lost: delta },
						occurredAt,
					},
				],
				{ deliveryId: lostId(entry.id, total) },
			);
			if (outcome === "blocked") return "stopAll";
			writePrivateFileAtomicNoFollow(join(entry.reportsDir, ".lost-acked"), String(total));
			lostCount += delta;
			return "next";
		} catch (error) {
			const kind = classifyReportFailure(error);
			if (kind === "entry" || kind === "session") {
				writePrivateFileAtomicNoFollow(join(entry.reportsDir, ".lost-acked"), String(total));
				return "next";
			}
			if (kind === "credential") await credentialRejected();
			return "stopDir";
		}
	}

	/** One directory's turn. Returns how many files it used of the tick's budget, and whether the tick must stop. */
	async function serve(
		entry: Followed,
		budget: number,
	): Promise<{ used: number; stopAll: boolean }> {
		let st: SpoolStat;
		try {
			st = await stat(entry.reportsDir);
		} catch {
			if (now() - entry.admittedAt > MISSING_REPORTS_GRACE_MS && !(await bridgeAlive(entry))) {
				drop(entry.id);
			}
			return { used: 0, stopAll: false };
		}
		if (!privateDir(st)) {
			warnOnce(
				entry,
				"reports-dir",
				`[supervisor] a bridge's reports directory isn't private to this account and was left alone: ${entry.id}`,
			);
			return { used: 0, stopAll: false };
		}
		if (st.mtimeMs === entry.lastMtimeMs && !entry.backlog) {
			// Nothing changed. A bridge that has died leaves its directory quiet for good, so now and then
			// (one stat) a quiet directory is checked for a living bridge and let go if there is none.
			if (now() - entry.livenessCheckedAt >= LIVENESS_RECHECK_MS) {
				entry.livenessCheckedAt = now();
				if (!(await pidFresh(entry))) drop(entry.id);
			}
			return { used: 0, stopAll: false };
		}

		let names: string[];
		try {
			names = await readdir(entry.reportsDir);
		} catch {
			return { used: 0, stopAll: false };
		}
		// Only the first names are looked at, matched through a Set: nothing legitimate lists more, and an
		// agent planting a very large directory must not make each pass quadratic.
		const files = names
			.slice(0, MAX_LISTED_NAMES)
			.filter((n) => ENTRY_PATTERN.test(n))
			.sort();
		const listed = new Set(files);
		for (const known of [...entry.firstSeen.keys()]) {
			if (!listed.has(known)) entry.firstSeen.delete(known);
		}
		restoreStuck(entry, listed);
		for (const name of files) {
			if ((entry.unlinkFailures.get(name) ?? 0) >= MAX_UNLINK_FAILURES) continue;
			if (!entry.firstSeen.has(name)) {
				entry.firstSeen.set(name, firstPass ? now() - LATE_ARRIVAL_MS - 1 : now());
			}
		}
		entry.lastMtimeMs = st.mtimeMs;

		const nonce = nonceOf(entry);
		if (nonce === null) {
			// A directory with no usable nonce can't have its reports vouched for as this launch's.
			followed.delete(entry.id);
			return { used: 0, stopAll: false };
		}

		let used = 0;
		let remaining = files.length;
		let stopAll = false;
		let stopDir = false;
		for (const name of files) {
			if ((entry.unlinkFailures.get(name) ?? 0) >= MAX_UNLINK_FAILURES) {
				remaining--;
				continue;
			}
			if (used >= Math.min(MAX_FILES_PER_DIR, budget)) break;
			const verdict = await sendFile(entry, name, nonce);
			used++;
			if (!entry.firstSeen.has(name)) remaining--;
			if (verdict === "stopAll") {
				stopAll = true;
				break;
			}
			if (verdict === "stopDir") {
				stopDir = true;
				break;
			}
		}
		let lostPending = false;
		if (!stopAll && !stopDir) {
			const verdict = await sendLostDelta(entry);
			if (verdict === "stopAll") stopAll = true;
			if (verdict !== "next") lostPending = true;
		}
		// Something is left to do (files, or a lost count that couldn't be reported yet): look again next tick.
		entry.backlog = remaining > 0 || lostPending;
		if (!entry.backlog && !stopAll && !stopDir && !(await bridgeAlive(entry))) {
			drop(entry.id);
		}
		return { used, stopAll };
	}

	/**
	 * Looks through the interactive directory for bridges nobody told the drain about (a supervisor that was
	 * restarted while its bridges kept running). Only ids the gate knows as interactive launches of this
	 * supervisor are considered, so a directory an agent plants is never followed. Cheap things first: a bridge
	 * that is alive is followed before anything else, one that is gone only if it left reports behind, and a
	 * directory examined once is not looked at again until its mtime changes.
	 */
	async function scan() {
		lastScanAt = now();
		let names: string[];
		try {
			names = await readdir(root);
		} catch {
			return;
		}
		const present = new Set(names);
		for (const name of [...known.keys()]) if (!present.has(name)) known.delete(name);
		for (const name of [...pendingAdmit.keys()]) if (!present.has(name)) pendingAdmit.delete(name);
		const alive: Array<{ name: string; mtimeMs: number; nonce: string }> = [];
		const left: Array<{ name: string; mtimeMs: number; nonce: string }> = [];
		let examined = 0;
		for (const name of names) {
			if (!SESSION_ID_PATTERN.test(name) || followed.has(name) || pendingAdmit.has(name)) continue;
			if (++examined % SCAN_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
			if (!deps.gate.isInteractiveLaunch(name)) continue;
			let st: SpoolStat;
			try {
				st = await stat(join(root, name));
			} catch {
				continue;
			}
			const before = known.get(name);
			if (before !== undefined && before.dir === st.mtimeMs) {
				// Examined and unchanged. One that was dead with nothing in reports/ is checked once more
				// through reports/'s own mtime: a file written inside it does not move the directory above.
				if (before.reports === undefined) continue;
				try {
					if ((await stat(join(root, name, "reports"))).mtimeMs === before.reports) continue;
				} catch {
					continue;
				}
			}
			known.set(name, { dir: st.mtimeMs });
			if (!privateDir(st)) continue;
			const probe = newFollowed(name);
			const live = await bridgeAlive(probe);
			if (!live) {
				let reportsMtime: number | undefined;
				try {
					reportsMtime = (await stat(probe.reportsDir)).mtimeMs;
				} catch {
					// no reports/ to watch
				}
				let inside: string[];
				try {
					inside = await readdir(probe.reportsDir);
				} catch {
					continue;
				}
				if (!inside.slice(0, MAX_LISTED_NAMES).some((n) => ENTRY_PATTERN.test(n))) {
					// Dead and empty now: remember reports/'s time, so files that appear in it are noticed.
					known.set(name, { dir: st.mtimeMs, reports: reportsMtime });
					continue;
				}
			}
			const nonce = nonceOf(probe);
			if (nonce === null) continue;
			(live ? alive : left).push({ name, mtimeMs: st.mtimeMs, nonce });
		}
		const byAge = (a: { mtimeMs: number }, b: { mtimeMs: number }) => a.mtimeMs - b.mtimeMs;
		for (const { name, mtimeMs, nonce } of [...alive.sort(byAge), ...left.sort(byAge)]) {
			if (follow(name, nonce)) continue;
			if (pendingAdmit.size < MAX_PENDING_ADMIT) pendingAdmit.set(name, { mtimeMs, nonce });
		}
	}

	/** Follows what was waiting for room, as room appears. */
	function admitPending() {
		for (const [name, { nonce }] of pendingAdmit) {
			if (followed.size >= MAX_ACTIVE_DIRS) return;
			pendingAdmit.delete(name);
			follow(name, nonce);
		}
	}

	async function tick() {
		if (now() - lastScanAt >= SCAN_INTERVAL_MS) await scan();
		admitPending();
		let budget = MAX_FILES_PER_TICK;
		try {
			for (const entry of [...followed.values()]) {
				if (budget <= 0) break;
				const result = await serve(entry, budget);
				budget -= result.used;
				if (result.stopAll) break;
			}
		} finally {
			firstPass = false;
		}
		admitPending();
	}

	function drain(): Promise<void> {
		if (running) return running;
		running = tick()
			.catch((error) => {
				log(
					`[supervisor] draining the terminal bridge reports failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			})
			.finally(() => {
				running = null;
			});
		return running;
	}

	async function liveBridgeCount(): Promise<number> {
		let live = 0;
		for (const entry of followed.values()) if (await bridgeAlive(entry)) live++;
		return live;
	}

	async function scrubLegacyBridgeConfigs(): Promise<number> {
		let names: string[];
		try {
			names = await readdir(root);
		} catch {
			return 0;
		}
		let rewritten = 0;
		let checked = 0;
		for (const name of names) {
			if (!SESSION_ID_PATTERN.test(name)) continue;
			if (++checked % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			try {
				const st = await stat(join(root, name));
				if (!privateDir(st)) continue;
			} catch {
				continue;
			}
			const path = join(root, name, "bridge.json");
			const found = readFile(path, MAX_CONFIG_BYTES);
			if (found.kind !== "ok") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(found.text);
			} catch {
				continue;
			}
			if (!isObject(parsed) || !LEGACY_BRIDGE_KEYS.some((key) => key in parsed)) continue;
			for (const key of LEGACY_BRIDGE_KEYS) delete parsed[key];
			try {
				writePrivateFileAtomicNoFollow(path, JSON.stringify(parsed, null, 2));
				rewritten++;
			} catch {
				log(`[supervisor] couldn't remove the old credentials from a bridge config: ${name}`);
			}
		}
		return rewritten;
	}

	function isBridgeActive(sessionId: string): boolean {
		if (followed.has(sessionId)) return true;
		try {
			const st = statSync(join(root, sessionId, "bridge.pid"));
			return now() - st.mtimeMs <= BRIDGE_ALIVE_MS;
		} catch {
			return false;
		}
	}

	return {
		isBridgeActive,
		admit,
		drain,
		liveBridgeCount,
		scrubLegacyBridgeConfigs,
		stats: () => ({ sent, lost: lostCount, followed: followed.size }),
	};
}
