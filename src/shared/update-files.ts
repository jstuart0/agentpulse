/**
 * Read-only parsers for the small files the updater and the supervisor keep under `~/.agentpulse/`:
 * the local consent, the updater's state, the supervisor's status and the drain request. Each goes through
 * `readPrivateFileNoFollow`, so a file that is missing, unreadable, not private, owned by someone else, too
 * large or not shaped as expected reads as "off" or "unknown", never as a guess (rule 3). Nothing here writes;
 * the server imports this module and has no way to start or change an update through it.
 */
import { join } from "node:path";
import { readPrivateFileNoFollow } from "./private-read.js";
import type { LastSeen } from "./release-manifest.js";
import { UPDATE_OUTCOME_CODES, type UpdateOutcomeCode } from "./update-status.js";

export const UPDATE_CONSENT_FILE = "update-consent.json";
export const UPDATE_STATE_FILE = "update-state.json";
export const SUPERVISOR_STATUS_FILE = "supervisor-status.json";
export const UPDATE_DRAIN_FILE = "update-drain.json";
const MAX_FILE_BYTES = 32 * 1024;
const WINDOW_PATTERN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const VERSION_KEY = /^[0-9A-Za-z.+-]{1,48}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(home: string, name: string): Record<string, unknown> | null {
	const file = readPrivateFileNoFollow(join(home, ".agentpulse", name), MAX_FILE_BYTES);
	if (file.kind !== "ok") return null;
	try {
		const parsed: unknown = JSON.parse(file.text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export interface AppConsent {
	on: boolean;
	allowMigrations: boolean;
	/** `HH:MM-HH:MM` in local time, or null for any time. */
	window: string | null;
}

/** The app's consent to apply updates by itself. Anything but a well-formed `app.on === true` is off. */
export function readConsent(home: string): AppConsent {
	const off: AppConsent = { on: false, allowMigrations: false, window: null };
	const raw = readJson(home, UPDATE_CONSENT_FILE);
	if (!raw || raw.schema !== 1 || !isRecord(raw.app)) return off;
	const app = raw.app;
	if (app.on !== true) return off;
	const window =
		typeof app.window === "string" && WINDOW_PATTERN.test(app.window) ? app.window : null;
	return { on: true, allowMigrations: app.allowMigrations === true, window };
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

/** The updater's own state; an unreadable file is the empty state (the fresh-install case). */
export function readUpdateState(home: string): UpdaterState {
	const empty: UpdaterState = { last: null, revoked: [], refused: {} };
	const raw = readJson(home, UPDATE_STATE_FILE);
	if (!raw || raw.schema !== 1) return empty;
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
	return {
		last: parseLast(raw.last),
		revoked,
		refused: { ...refused },
		...(lastOutcome ? { lastOutcome } : {}),
		...(target ? { lastTarget: target } : {}),
		...(at ? { at } : {}),
		...(waitingSince ? { waitingSince } : {}),
	};
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
