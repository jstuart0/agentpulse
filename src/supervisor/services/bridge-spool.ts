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
import { unlinkSync } from "node:fs";
import { lstat as fsLstat, readdir as fsReaddir } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { disposeRuntimesAndExit } from "./fatal-exit.js";
import {
	type PrivateFileRead,
	SESSION_ID_PATTERN,
	isPrivateOwnStat,
	readPrivateFileNoFollow,
} from "./private-store.js";
import type { ReportGate } from "./report-gate.js";
import { type CredentialTripwire, classifyReportFailure } from "./report-resilience.js";

/** A report older than this when the drain first sees it is a replay (late), however it is stamped. */
export const LATE_ARRIVAL_MS = 60_000;
export const MAX_ACTIVE_DIRS = 256;
export const MAX_FILES_PER_DIR = 50;
export const MAX_FILES_PER_TICK = 200;
export const SCAN_INTERVAL_MS = 60_000;
/** A directory admitted by a launch but whose bridge hasn't written anything yet is followed this long. */
const MISSING_REPORTS_GRACE_MS = 10 * 60_000;
const BRIDGE_ALIVE_MS = 90_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CONTENT_CHARS = 64 * 1024;
const MAX_RAW_PAYLOAD_KEYS = 4;
const MAX_RAW_PAYLOAD_BYTES = 1024;
const MAX_METADATA_KEYS = 8;
const MAX_METADATA_BYTES = 4096;
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
	gate: Pick<ReportGate, "reportState" | "reportEvents">;
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
}

export interface BridgeSpoolDrain {
	/** Follows this bridge directory (a launch's correlation id). */
	admit(sessionId: string): void;
	/** One pass over the followed directories; an overlapping call returns the pass already running. */
	drain(): Promise<void>;
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
	firstSeen: Map<string, number>;
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

/** The state body a bridge may send, or null. `id` is the vetted directory name. */
function validState(body: unknown, id: string): ManagedSessionStateInput | null {
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
	if (!boundedObject(body.metadata, MAX_METADATA_KEYS, MAX_METADATA_BYTES)) return null;
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
	/** Names seen by the parent scan, with the directory's mtime when last examined. */
	const known = new Map<string, number>();
	let lastScanAt = Number.NEGATIVE_INFINITY;
	let running: Promise<void> | null = null;
	let sent = 0;
	let lostCount = 0;

	function follow(id: string): Followed | null {
		const existing = followed.get(id);
		if (existing) return existing;
		if (followed.size >= MAX_ACTIVE_DIRS) return null;
		const dir = join(root, id);
		const entry: Followed = {
			id,
			dir,
			reportsDir: join(dir, "reports"),
			admittedAt: now(),
			lastMtimeMs: null,
			backlog: false,
			firstSeen: new Map(),
			warned: new Set(),
		};
		followed.set(id, entry);
		return entry;
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

	function warnOnce(entry: Followed, key: string, line: string) {
		if (entry.warned.has(key)) return;
		entry.warned.add(key);
		log(line);
	}

	function discard(entry: Followed, name: string, countLost: boolean) {
		entry.firstSeen.delete(name);
		try {
			// A path, never followed: unlink removes a link itself.
			unlinkSync(join(entry.reportsDir, name));
		} catch {
			// already gone, or not ours to remove: nothing more to do
		}
		if (countLost) lostCount++;
	}

	async function credentialRejected(): Promise<void> {
		if (deps.credentialTripwire.record() === "confirmed") await onCredentialRejected();
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
			const state = validState(envelope.body, id);
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
						occurredAt: new Date(now()).toISOString(),
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
				followed.delete(entry.id);
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
		if (st.mtimeMs === entry.lastMtimeMs && !entry.backlog) return { used: 0, stopAll: false };

		let names: string[];
		try {
			names = await readdir(entry.reportsDir);
		} catch {
			return { used: 0, stopAll: false };
		}
		const files = names.filter((n) => ENTRY_PATTERN.test(n)).sort();
		for (const known of [...entry.firstSeen.keys()]) {
			if (!files.includes(known)) entry.firstSeen.delete(known);
		}
		for (const name of files) if (!entry.firstSeen.has(name)) entry.firstSeen.set(name, now());
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
		if (!stopAll && !stopDir && names.includes("lost")) {
			const verdict = await sendLostDelta(entry);
			if (verdict === "stopAll") stopAll = true;
		}
		entry.backlog = remaining > 0;
		if (!entry.backlog && !stopAll && !stopDir && !(await bridgeAlive(entry))) {
			followed.delete(entry.id);
		}
		return { used, stopAll };
	}

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
		const fresh: Array<{ name: string; mtimeMs: number }> = [];
		for (const name of names) {
			if (!SESSION_ID_PATTERN.test(name) || followed.has(name)) continue;
			let st: SpoolStat;
			try {
				st = await stat(join(root, name));
			} catch {
				continue;
			}
			if (known.get(name) === st.mtimeMs) continue;
			if (!privateDir(st)) {
				known.set(name, st.mtimeMs);
				continue;
			}
			const probe: Followed = {
				id: name,
				dir: join(root, name),
				reportsDir: join(root, name, "reports"),
				admittedAt: now(),
				lastMtimeMs: null,
				backlog: false,
				firstSeen: new Map(),
				warned: new Set(),
			};
			if (nonceOf(probe) === null) {
				known.set(name, st.mtimeMs);
				continue;
			}
			fresh.push({ name, mtimeMs: st.mtimeMs });
		}
		fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const { name, mtimeMs } of fresh) {
			if (followed.size >= MAX_ACTIVE_DIRS) break;
			known.set(name, mtimeMs);
			follow(name);
		}
	}

	async function tick() {
		if (now() - lastScanAt >= SCAN_INTERVAL_MS) await scan();
		let budget = MAX_FILES_PER_TICK;
		for (const entry of [...followed.values()]) {
			if (budget <= 0) break;
			const result = await serve(entry, budget);
			budget -= result.used;
			if (result.stopAll) break;
		}
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

	return {
		admit,
		drain,
		liveBridgeCount,
		scrubLegacyBridgeConfigs,
		stats: () => ({ sent, lost: lostCount, followed: followed.size }),
	};
}
