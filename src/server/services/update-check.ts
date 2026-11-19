/**
 * The server's update check: once a day it reads the signed release manifest, verifies it, remembers what it
 * learned, and answers "is there a newer version" from memory. Everything else (the badge, `/health`,
 * `/capabilities`, the MCP tool) reads that one answer.
 *
 * It is a quiet check by design (rules 35 to 37 and 40):
 *  - one fixed https URL, a bare GET: no cookie, no query string, no custom header, no installation id;
 *  - 10 s deadline, 32 KiB cap, a redirect is a refusal;
 *  - a failure is silent: it never throws into boot or ingest, never degrades `/health`, backs off
 *    1 h, 6 h, 24 h, and logs at most one short line (a code, never content) per 24 h;
 *  - `AGENTPULSE_UPDATE_CHECK=off|false|0` turns it off entirely. That switch is separate from telemetry's:
 *    `DO_NOT_TRACK` and `AGENTPULSE_TELEMETRY` don't touch it, because this request carries nothing that
 *    identifies the install.
 *
 * What it remembers (protected `update.*` settings, never shown to a client): the envelope it last
 * verified, the newest `{seq, issuedAt, fingerprint}` it accepted (replay memory) and the union of every
 * revoked key id it has seen. Replay memory and revocations move only on a verified envelope: a failed or
 * replayed fetch changes neither. At boot the stored envelope is verified again against today's key list
 * and the remembered revocations, and one that no longer verifies is dropped and never served.
 *
 * Hides: the schedule, the caps, the backoff, the storage, the re-verification and the revocation memory.
 * The `ManifestSource` port is the only way bytes arrive, so tests use a fixture and never the network.
 */
import { eq } from "drizzle-orm";
import pkg from "../../../package.json" with { type: "json" };
import {
	type CappedFetchOptions,
	type CappedFetchResult,
	fetchCapped,
} from "../../shared/capped-fetch.js";
import { detectInstallKind, readInstallRecord } from "../../shared/install-record.js";
import type { InstallKind } from "../../shared/install-record.js";
import { MANIFEST_URL } from "../../shared/release-feed.js";
import { RELEASE_KEYS, type ReleaseKey } from "../../shared/release-keys.js";
import {
	type LastSeen,
	type Manifest,
	releaseFor,
	updateState,
	verifyManifest,
} from "../../shared/release-manifest.js";
import {
	UPDATE_CHECK_RESULTS,
	type UpdateCheckResult,
	type UpdateStatus,
} from "../../shared/update-status.js";
import { resolveHomeDir } from "../../supervisor/config.js";
import { getDb } from "../db/client.js";
import { settings } from "../db/schema/index.js";
import { installProbeOverride } from "./install-probe.js";
import { upsertSetting } from "./settings-service.js";

/** The one place a manifest is fetched from. Never taken from a response, an env var or a setting. */
export { MANIFEST_URL };

const FETCH_DEADLINE_MS = 10_000;
const FETCH_MAX_BYTES = 32 * 1024;
const FIRST_CHECK_MIN_MS = 60_000;
const FIRST_CHECK_SPREAD_MS = 240_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FAILURE_BACKOFF_MS = [HOUR_MS, 6 * HOUR_MS, DAY_MS] as const;
const LOG_INTERVAL_MS = DAY_MS;

export const UPDATE_ENVELOPE_SETTING = "update.envelope";
export const UPDATE_STATE_SETTING = "update.state";

export type SourceFailureCode = Extract<CappedFetchResult, { ok: false }>["code"];
export type SourceResult =
	| { ok: true; body: string }
	| {
			ok: false;
			code: SourceFailureCode /** The HTTP status, for `code: "status"`. */;
			status?: number;
	  };

/** Where envelope bytes come from. The https adapter and the test fixtures are the only implementations. */
export interface ManifestSource {
	fetchEnvelope(): Promise<SourceResult>;
}

function httpsSource(url: string, extra: Partial<CappedFetchOptions> = {}): ManifestSource {
	return {
		async fetchEnvelope(): Promise<SourceResult> {
			// https only, loopback included: `fetchCapped` alone would let a loopback http URL through.
			if (!url.startsWith("https://")) return { ok: false, code: "insecure" };
			const result = await fetchCapped(url, {
				deadlineMs: FETCH_DEADLINE_MS,
				maxBytes: FETCH_MAX_BYTES,
				httpsOrLoopbackOnly: true,
				...extra,
			});
			if (result.ok) return { ok: true, body: result.body };
			return {
				ok: false,
				code: result.code,
				...(result.status !== undefined ? { status: result.status } : {}),
			};
		},
	};
}

export function createHttpsManifestSource(): ManifestSource {
	return httpsSource(MANIFEST_URL);
}

/** Test only: the same adapter pointed at a local TLS server that a test CA vouches for. */
export function createHttpsManifestSourceForTests(options: {
	url: string;
	deadlineMs?: number;
	ca?: string;
}): ManifestSource {
	return httpsSource(options.url, {
		...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
		...(options.ca ? { tls: { ca: options.ca } } : {}),
	});
}

export interface StoredUpdateState {
	lastCheckedAt: string | null;
	lastResult: UpdateCheckResult | null;
	last: LastSeen | null;
	revoked: string[];
}

export interface StoredUpdate {
	envelope: string | null;
	state: StoredUpdateState;
}

/** Where the check keeps what it learned. The default is the protected `update.*` settings rows. */
export interface UpdateStore {
	load(): Promise<StoredUpdate>;
	save(next: { envelope?: string | null; state?: StoredUpdateState }): Promise<void>;
}

const EMPTY_STATE: StoredUpdateState = {
	lastCheckedAt: null,
	lastResult: null,
	last: null,
	revoked: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLast(value: unknown): LastSeen | null {
	if (!isRecord(value)) return null;
	const { seq, issuedAt, fingerprint } = value;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
	if (typeof issuedAt !== "string" || !Number.isFinite(Date.parse(issuedAt))) return null;
	if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
	return { seq, issuedAt, fingerprint };
}

/** A stored state row read defensively: anything malformed reads as "nothing remembered". */
function parseStoredState(value: unknown): StoredUpdateState {
	if (!isRecord(value)) return { ...EMPTY_STATE, revoked: [] };
	const revoked = Array.isArray(value.revoked)
		? value.revoked.filter(
				(id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id),
			)
		: [];
	return {
		lastCheckedAt:
			typeof value.lastCheckedAt === "string" && Number.isFinite(Date.parse(value.lastCheckedAt))
				? value.lastCheckedAt
				: null,
		lastResult: (UPDATE_CHECK_RESULTS as readonly unknown[]).includes(value.lastResult)
			? (value.lastResult as UpdateCheckResult)
			: null,
		last: parseLast(value.last),
		revoked,
	};
}

export function settingsUpdateStore(): UpdateStore {
	return {
		async load() {
			const rows = await getDb()
				.select()
				.from(settings)
				.where(eq(settings.key, UPDATE_ENVELOPE_SETTING));
			const stateRows = await getDb()
				.select()
				.from(settings)
				.where(eq(settings.key, UPDATE_STATE_SETTING));
			const envelope = rows[0]?.value;
			return {
				envelope: typeof envelope === "string" ? envelope : null,
				state: parseStoredState(stateRows[0]?.value),
			};
		},
		async save(next) {
			if (next.envelope !== undefined) {
				await upsertSetting(UPDATE_ENVELOPE_SETTING, next.envelope, { allowProtected: true });
			}
			if (next.state)
				await upsertSetting(UPDATE_STATE_SETTING, next.state, { allowProtected: true });
		},
	};
}

/** `AGENTPULSE_UPDATE_CHECK=off|false|0` (any case) turns the check off; nothing else does. */
export function updateCheckEnabled(env: Record<string, string | undefined>): boolean {
	const value = env.AGENTPULSE_UPDATE_CHECK?.trim().toLowerCase();
	return !(value === "off" || value === "false" || value === "0");
}

export interface UpdateCheckDeps {
	source: ManifestSource;
	store: UpdateStore;
	keys: readonly ReleaseKey[];
	/** The version this server is running. */
	currentVersion: string;
	/** What kind of install this is, asked lazily and only once it is needed. */
	install: () => { kind: InstallKind; track: "release" | "ref" | null };
	enabled: () => boolean;
	now: () => number;
	random: () => number;
	/** Runs `fn` after `ms` and returns a cancel function. */
	schedule: (fn: () => void, ms: number) => () => void;
	log: (line: string) => void;
}

export interface UpdateChecker {
	/** Loads and re-verifies what was stored, then schedules the first check. Returns stop. Inert when off. */
	start(): () => void;
	/** Resolves when `start` has finished loading what was stored. */
	whenReady(): Promise<void>;
	/** Resolves when no check is in flight. */
	whenIdle(): Promise<void>;
	/** Checks now (sharing one in-flight check) and answers with the resulting status. */
	checkNow(): Promise<UpdateStatus>;
	/** The status, from memory. */
	status(): UpdateStatus;
	/** The envelope last verified, as it was served, or null. */
	envelope(): string | null;
}

/** Results that don't count against the backoff: a source or verifier failure does; "nothing newer" and "nothing published yet" don't. */
const NO_NEWER_RESULTS: ReadonlySet<UpdateCheckResult> = new Set([
	"ok",
	"older",
	"replayed",
	"not_published",
]);

export function createUpdateChecker(deps: UpdateCheckDeps): UpdateChecker {
	let manifest: Manifest | null = null;
	let envelopeText: string | null = null;
	let fingerprint: string | null = null;
	let state: StoredUpdateState = { ...EMPTY_STATE, revoked: [] };
	let failures = 0;
	let lastLogAt = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<void> | null = null;
	let ready: Promise<void> = Promise.resolve();
	let cancelTimer: (() => void) | null = null;
	let started = false;

	function logOnce(code: string): void {
		const now = deps.now();
		if (now - lastLogAt < LOG_INTERVAL_MS) return;
		lastLogAt = now;
		try {
			deps.log(`[update-check] check failed: ${code}`);
		} catch {
			// a logger must not break the check
		}
	}

	/** The later of two replay memories, by (seq, issuedAt). */
	function laterOf(a: LastSeen | null, b: LastSeen | null): LastSeen | null {
		if (!a || !b) return a ?? b;
		if (a.seq !== b.seq) return a.seq > b.seq ? a : b;
		return Date.parse(a.issuedAt) >= Date.parse(b.issuedAt) ? a : b;
	}

	/**
	 * Writes what this replica learned without rewinding what another replica already stored: the later `last`,
	 * the union of revoked ids, the newer check time (and its result). An envelope is written only when it is at
	 * least as new as the stored replay memory. The merged memory is adopted here too, so this replica refuses
	 * what another has already superseded. Read-merge-write, not one transaction: two writers in the same
	 * instant can still interleave, and the only thing that costs is one extra daily check.
	 */
	async function persist(next: { envelope?: string | null }): Promise<void> {
		try {
			let other: StoredUpdate | null = null;
			try {
				other = await deps.store.load();
			} catch {
				other = null;
			}
			const mine = state.last;
			const merged: StoredUpdateState = { ...state, revoked: [...state.revoked] };
			if (other) {
				merged.last = laterOf(mine, other.state.last);
				merged.revoked = [...new Set([...state.revoked, ...other.state.revoked])];
				const otherChecked = Date.parse(other.state.lastCheckedAt ?? "");
				const ownChecked = Date.parse(state.lastCheckedAt ?? "");
				if (Number.isFinite(otherChecked) && !(otherChecked <= ownChecked)) {
					merged.lastCheckedAt = other.state.lastCheckedAt;
					merged.lastResult = other.state.lastResult;
				}
			}
			state = merged;
			const write: { envelope?: string | null; state: StoredUpdateState } = {
				state: { ...merged, revoked: [...merged.revoked] },
			};
			if (next.envelope === null) write.envelope = null;
			else if (next.envelope !== undefined && laterOf(mine, other?.state.last ?? null) === mine) {
				write.envelope = next.envelope;
			}
			await deps.store.save(write);
		} catch {
			logOnce("store_failed");
		}
	}

	async function load(): Promise<void> {
		let stored: StoredUpdate;
		try {
			stored = await deps.store.load();
		} catch {
			logOnce("store_failed");
			return;
		}
		state = { ...stored.state, revoked: [...stored.state.revoked] };
		if (stored.envelope === null) return;
		// Verified again against today's keys and every revocation remembered: no `last`, so the stored
		// envelope isn't refused as a replay of itself.
		const verdict = await verifyManifest(stored.envelope, {
			keys: deps.keys,
			revoked: new Set(state.revoked),
			now: deps.now(),
			last: null,
		});
		if (!verdict.ok) {
			await persist({ envelope: null });
			return;
		}
		manifest = verdict.manifest;
		envelopeText = stored.envelope;
		fingerprint = verdict.fingerprint;
		state.last ??= verdict.next;
		state.revoked = verdict.revoked;
	}

	async function runCheck(): Promise<void> {
		if (!deps.enabled()) return;
		const checkedAt = new Date(deps.now()).toISOString();
		let result: UpdateCheckResult;
		let nextEnvelope: string | undefined;
		try {
			await ready;
			if (deps.keys.length === 0) {
				// No release key ships in this build: nothing could be verified, so there is nothing to fetch.
				result = "not_published";
			} else {
				const fetched = await deps.source.fetchEnvelope();
				if (!fetched.ok) {
					if (fetched.code === "status" && fetched.status === 404) {
						result = "not_published";
					} else {
						result = "unreachable";
						logOnce(fetched.code);
					}
				} else {
					const verdict = await verifyManifest(fetched.body, {
						keys: deps.keys,
						revoked: new Set(state.revoked),
						now: deps.now(),
						last: state.last,
					});
					if (verdict.ok) {
						result = "ok";
						if (verdict.fingerprint !== fingerprint) nextEnvelope = fetched.body;
						manifest = verdict.manifest;
						envelopeText = fetched.body;
						fingerprint = verdict.fingerprint;
						state.last = verdict.next;
						state.revoked = verdict.revoked;
					} else {
						result = verdict.code;
						if (!NO_NEWER_RESULTS.has(result)) logOnce(result);
					}
				}
			}
		} catch {
			result = "unreachable";
			logOnce("unexpected");
		}
		failures = NO_NEWER_RESULTS.has(result) ? 0 : failures + 1;
		state.lastCheckedAt = checkedAt;
		state.lastResult = result;
		await persist(nextEnvelope !== undefined ? { envelope: nextEnvelope } : {});
	}

	function checkOnce(): Promise<void> {
		inFlight ??= runCheck().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	function nextDelayMs(): number {
		return failures === 0
			? DAY_MS
			: FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1];
	}

	function scheduleNext(delayMs: number): void {
		cancelTimer = deps.schedule(() => {
			const again = () => {
				if (started) scheduleNext(nextDelayMs());
			};
			void checkOnce().then(again, again);
		}, delayMs);
	}

	function status(): UpdateStatus {
		const install = deps.install();
		const derived = updateState(deps.currentVersion, manifest, {
			disabled: !deps.enabled(),
			now: deps.now(),
		});
		const latest = derived.latest ?? null;
		const latestEntry = manifest && latest ? releaseFor(manifest, latest) : null;
		return {
			current: deps.currentVersion,
			latest,
			state: derived.state,
			stale: derived.stale,
			severity: derived.state === "security" ? "security" : (latestEntry?.severity ?? null),
			checkedAt: state.lastCheckedAt,
			lastResult: state.lastResult,
			manifestIssuedAt: derived.state === "disabled" ? null : (manifest?.issuedAt ?? null),
			installKind: install.kind,
			track: install.kind === "local" ? install.track : null,
			localApply: null,
		};
	}

	return {
		start() {
			if (!deps.enabled() || started) return () => {};
			started = true;
			ready = load().catch(() => {
				// Whatever went wrong reading what was stored, start from nothing and keep the timer.
				state = { ...EMPTY_STATE, revoked: [] };
				logOnce("boot_failed");
			});
			scheduleNext(FIRST_CHECK_MIN_MS + Math.floor(deps.random() * FIRST_CHECK_SPREAD_MS));
			return () => {
				started = false;
				cancelTimer?.();
				cancelTimer = null;
			};
		},
		whenReady: () => ready,
		whenIdle: async () => {
			await inFlight;
		},
		checkNow: async () => {
			await checkOnce();
			return status();
		},
		status,
		envelope: () => (deps.enabled() ? envelopeText : null),
	};
}

// ── The process-wide instance ─────────────────────────────────────────────────────────────

let installOnce: { kind: InstallKind; track: "release" | "ref" | null } | null = null;

/** Detected once, the first time a status is built: it reads a small file under the home directory. */
function detectInstall(): { kind: InstallKind; track: "release" | "ref" | null } {
	const probe = installProbeOverride();
	if (probe) return probe();
	if (installOnce) return installOnce;
	const home = resolveHomeDir();
	let kind: InstallKind = "source";
	let track: "release" | "ref" | null = null;
	try {
		kind = detectInstallKind(process.env, process.cwd(), home);
		if (kind === "local") track = readInstallRecord(home)?.track ?? null;
	} catch {
		// an unreadable record reads as a source checkout: never a guess at "local"
	}
	installOnce = { kind, track };
	return installOnce;
}

let instance: UpdateChecker | null = null;

function defaultChecker(): UpdateChecker {
	instance ??= createUpdateChecker({
		source: createHttpsManifestSource(),
		store: settingsUpdateStore(),
		keys: RELEASE_KEYS,
		currentVersion: pkg.version,
		install: detectInstall,
		enabled: () => updateCheckEnabled(process.env),
		now: Date.now,
		random: Math.random,
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			timer.unref?.();
			return () => clearTimeout(timer);
		},
		log: (line) => console.warn(line),
	});
	return instance;
}

/** Test only: replaces the process-wide checker (null restores the default). */
export function setUpdateCheckerForTests(checker: UpdateChecker | null): void {
	instance = checker;
}

/** Starts the daily check. Call after the database is ready. Returns stop. */
export function startUpdateCheck(): () => void {
	return defaultChecker().start();
}

export function checkNow(): Promise<UpdateStatus> {
	return defaultChecker().checkNow();
}

/** The update status, from memory: no database read, no request. */
export function getUpdateStatus(): UpdateStatus {
	return defaultChecker().status();
}

/** The verified envelope, from memory, or null. */
export function getSignedEnvelope(): string | null {
	return defaultChecker().envelope();
}
