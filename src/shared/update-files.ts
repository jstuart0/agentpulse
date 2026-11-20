/**
 * Read-only parsers for the small files the updater and the supervisor keep under `~/.agentpulse/`:
 * the local consent, the updater's state, the supervisor's status and the drain request. Each goes through
 * `readPrivateFileNoFollow`, so a file that is missing, unreadable, not private, owned by someone else, too
 * large or not shaped as expected reads as "off" or "unknown", never as a guess (rule 3). Nothing here writes;
 * the server imports this module and has no way to start or change an update through it.
 */
import { join } from "node:path";
import { type PrivateFileRead, readPrivateFileNoFollow } from "./private-read.js";
import type { LastSeen } from "./release-manifest.js";
import { UPDATE_OUTCOME_CODES, type UpdateOutcomeCode } from "./update-status.js";

export const UPDATE_CONSENT_FILE = "update-consent.json";
export const UPDATE_STATE_FILE = "update-state.json";
export const SUPERVISOR_STATUS_FILE = "supervisor-status.json";
export const UPDATE_DRAIN_FILE = "update-drain.json";
const MAX_FILE_BYTES = 32 * 1024;
export const UPDATE_WINDOW_PATTERN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const VERSION_KEY = /^[0-9A-Za-z.+-]{1,48}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type FileReader = (path: string, maxBytes: number) => PrivateFileRead;

function parseJsonRecord(file: PrivateFileRead): Record<string, unknown> | null {
	if (file.kind !== "ok") return null;
	try {
		const parsed: unknown = JSON.parse(file.text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function readJson(
	home: string,
	name: string,
	read: FileReader = readPrivateFileNoFollow,
): Record<string, unknown> | null {
	return parseJsonRecord(read(join(home, ".agentpulse", name), MAX_FILE_BYTES));
}

export interface AppConsent {
	on: boolean;
	allowMigrations: boolean;
	/** `HH:MM-HH:MM` in local time, or null for any time. */
	window: string | null;
}

function consentFrom(raw: Record<string, unknown> | null): AppConsent {
	const off: AppConsent = { on: false, allowMigrations: false, window: null };
	if (!raw || raw.schema !== 1 || !isRecord(raw.app)) return off;
	const app = raw.app;
	if (app.on !== true) return off;
	const window =
		typeof app.window === "string" && UPDATE_WINDOW_PATTERN.test(app.window) ? app.window : null;
	return { on: true, allowMigrations: app.allowMigrations === true, window };
}

/** The app's consent to apply updates by itself. Anything but a well-formed `app.on === true` is off. */
export function readConsent(home: string): AppConsent {
	return consentFrom(readJson(home, UPDATE_CONSENT_FILE));
}

/** `readConsent` over another file reader, so a test can judge the file as somebody else's. */
export function readConsentWith(home: string, read: FileReader): AppConsent {
	return consentFrom(readJson(home, UPDATE_CONSENT_FILE, read));
}

/**
 * The consent file as written, for a writer that has to keep the parts it doesn't own (the relay's `clients`
 * section). Null when the file is missing, not trusted or not a schema-1 object.
 */
export function readConsentDocument(home: string): Record<string, unknown> | null {
	const raw = readJson(home, UPDATE_CONSENT_FILE);
	return raw && raw.schema === 1 ? raw : null;
}

export interface UpdaterState {
	last: LastSeen | null;
	revoked: string[];
	/** Versions this machine rolled back from, and why: never tried again. */
	refused: Record<string, UpdateOutcomeCode>;
	lastOutcome?: UpdateOutcomeCode;
	lastTarget?: string;
	at?: string;
	waitingSince?: string;
	/** Automatic runs only: how many failures in a row, and not before when to try again. */
	backoff?: { failures: number; notBefore: string };
}

const OUTCOME_SET: ReadonlySet<string> = new Set(UPDATE_OUTCOME_CODES);

function parseLast(value: unknown): LastSeen | null {
	if (!isRecord(value)) return null;
	const { seq, issuedAt, fingerprint } = value;
	if (
		typeof seq !== "number" ||
		!Number.isSafeInteger(seq) ||
		seq < 0 ||
		typeof issuedAt !== "string" ||
		!ISO_TIME.test(issuedAt) ||
		typeof fingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(fingerprint)
	) {
		return null;
	}
	return { seq, issuedAt, fingerprint };
}

function outcomeOrUndefined(value: unknown): UpdateOutcomeCode | undefined {
	return typeof value === "string" && OUTCOME_SET.has(value)
		? (value as UpdateOutcomeCode)
		: undefined;
}

function parseBackoff(value: unknown): UpdaterState["backoff"] {
	if (!isRecord(value)) return undefined;
	const { failures, notBefore } = value;
	if (
		typeof failures !== "number" ||
		!Number.isSafeInteger(failures) ||
		failures < 1 ||
		failures > 1000 ||
		typeof notBefore !== "string" ||
		!ISO_TIME.test(notBefore)
	) {
		return undefined;
	}
	return { failures, notBefore };
}

function stateFrom(raw: Record<string, unknown>): UpdaterState | null {
	if (raw.schema !== 1) return null;
	const revoked = Array.isArray(raw.revoked)
		? raw.revoked.filter(
				(id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id),
			)
		: [];
	const refused: Record<string, UpdateOutcomeCode> = Object.create(null);
	if (isRecord(raw.refused)) {
		for (const [version, code] of Object.entries(raw.refused)) {
			const parsed = outcomeOrUndefined(code);
			if (VERSION_KEY.test(version) && parsed) refused[version] = parsed;
		}
	}
	const target =
		typeof raw.lastTarget === "string" && VERSION_KEY.test(raw.lastTarget)
			? raw.lastTarget
			: undefined;
	const at = typeof raw.at === "string" && ISO_TIME.test(raw.at) ? raw.at : undefined;
	const waitingSince =
		typeof raw.waitingSince === "string" && ISO_TIME.test(raw.waitingSince)
			? raw.waitingSince
			: undefined;
	const lastOutcome = outcomeOrUndefined(raw.lastOutcome);
	const backoff = parseBackoff(raw.backoff);
	return {
		last: parseLast(raw.last),
		revoked,
		refused: { ...refused },
		...(lastOutcome ? { lastOutcome } : {}),
		...(target ? { lastTarget: target } : {}),
		...(at ? { at } : {}),
		...(waitingSince ? { waitingSince } : {}),
		...(backoff ? { backoff } : {}),
	};
}

/** The updater's own state; an unreadable file is the empty state (the fresh-install case). */
export function readUpdateState(home: string): UpdaterState {
	const raw = readJson(home, UPDATE_STATE_FILE);
	return (raw ? stateFrom(raw) : null) ?? { last: null, revoked: [], refused: {} };
}

/**
 * The state file told apart from "nothing there": `absent` (the updater never ran), `invalid` (a file is
 * there and can't be believed: untrusted, unparseable or not schema 1) or its state. The server shows
 * nothing about a machine whose state file is invalid, rather than a guess.
 */
export function readUpdateStateChecked(
	home: string,
): { kind: "absent" } | { kind: "invalid" } | { kind: "ok"; state: UpdaterState } {
	const file = readPrivateFileNoFollow(
		join(home, ".agentpulse", UPDATE_STATE_FILE),
		MAX_FILE_BYTES,
	);
	if (file.kind === "absent") return { kind: "absent" };
	const raw = parseJsonRecord(file);
	const state = raw ? stateFrom(raw) : null;
	return state ? { kind: "ok", state } : { kind: "invalid" };
}

export interface SupervisorStatus {
	version: string;
	pid: number;
	/** `ps -o lstart=` for the supervisor's pid when it was written, compared only for equality. */
	processStartedAt: string | null;
	/** Epoch ms. */
	writtenAt: number;
	registered: boolean;
	/** Epoch ms since the supervisor has been continuously idle, or null while it is busy. */
	idleSince: number | null;
	inFlight: number;
	draining: boolean;
	drained: boolean;
}

/** The supervisor's status file, or null when it is missing, stale in form or not trusted. Freshness is the caller's call. */
export function readSupervisorStatus(home: string): SupervisorStatus | null {
	const raw = readJson(home, SUPERVISOR_STATUS_FILE);
	if (!raw) return null;
	const {
		version,
		pid,
		processStartedAt,
		writtenAt,
		registered,
		idleSince,
		inFlight,
		draining,
		drained,
	} = raw;
	if (
		typeof version !== "string" ||
		!VERSION_KEY.test(version) ||
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		(processStartedAt !== null && typeof processStartedAt !== "string") ||
		typeof writtenAt !== "number" ||
		!Number.isFinite(writtenAt) ||
		typeof registered !== "boolean" ||
		(idleSince !== null && (typeof idleSince !== "number" || !Number.isFinite(idleSince))) ||
		typeof inFlight !== "number" ||
		!Number.isSafeInteger(inFlight) ||
		typeof draining !== "boolean" ||
		typeof drained !== "boolean"
	) {
		return null;
	}
	return {
		version,
		pid,
		processStartedAt: typeof processStartedAt === "string" ? processStartedAt.slice(0, 64) : null,
		writtenAt,
		registered,
		idleSince: idleSince as number | null,
		inFlight,
		draining,
		drained,
	};
}

export interface DrainRequest {
	/** Epoch ms. */
	requestedAt: number;
	expiresAt: number;
}

/** The drain request file as written, or null for anything unreadable. Whether it is fresh is `drainIsFresh`'s call. */
export function readDrainRequest(home: string): DrainRequest | null {
	const raw = readJson(home, UPDATE_DRAIN_FILE);
	if (!raw || raw.schema !== 1) return null;
	const { requestedAt, expiresAt } = raw;
	if (
		typeof requestedAt !== "number" ||
		typeof expiresAt !== "number" ||
		!Number.isFinite(requestedAt) ||
		!Number.isFinite(expiresAt)
	) {
		return null;
	}
	return { requestedAt, expiresAt };
}
