import type { SupervisorCapabilities } from "../../shared/types.js";

// Everything here treats supervisor-supplied data as hostile: only keys on the
// allowlist below are ever read (by own-property lookup, so names such as
// __proto__ or hasOwnProperty are just unknown keys), unknown keys are
// dropped, and sizes are capped.

const MAX_LIST_ITEMS = 64;
const MAX_TEXT = 256;
const MAX_PATH = 4096;
const MAX_TRUSTED_ROOTS = 64;
const EXECUTABLE_TOOLS = ["claude", "codex"] as const;
const EXECUTABLE_SOURCES = ["auto", "config"];

const INVALID = Symbol("invalid");
type Cleaned = unknown | typeof INVALID;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const has = (obj: Record<string, unknown>, key: string): boolean => Object.hasOwn(obj, key);

const isText = (v: unknown, max = MAX_TEXT): v is string =>
	typeof v === "string" && v.length <= max;

function cleanTextList(v: unknown): Cleaned {
	if (!Array.isArray(v) || v.length > MAX_LIST_ITEMS) return INVALID;
	return v.every((item) => isText(item)) ? [...v] : INVALID;
}

function cleanText(v: unknown): Cleaned {
	return isText(v) ? v : INVALID;
}

function cleanVersion(v: unknown): Cleaned {
	return typeof v === "number" && Number.isFinite(v) ? v : INVALID;
}

/** `reason` is optional; `{ available: true }` alone is valid. */
function cleanTerminalControl(v: unknown): Cleaned {
	if (!isPlainObject(v) || !has(v, "available") || typeof v.available !== "boolean") return INVALID;
	const out: Record<string, unknown> = { available: v.available };
	if (has(v, "reason") && v.reason !== undefined) {
		if (v.reason !== null && !isText(v.reason, 1024)) return INVALID;
		out.reason = v.reason;
	}
	return out;
}

function cleanExecutable(v: unknown): Cleaned {
	if (!isPlainObject(v) || !has(v, "available") || typeof v.available !== "boolean") return INVALID;
	const out: Record<string, unknown> = { available: v.available };
	if (has(v, "command") && v.command !== undefined) {
		if (!isText(v.command, MAX_PATH)) return INVALID;
		out.command = v.command;
	}
	if (has(v, "resolvedPath") && v.resolvedPath !== undefined) {
		if (v.resolvedPath !== null && !isText(v.resolvedPath, MAX_PATH)) return INVALID;
		out.resolvedPath = v.resolvedPath;
	}
	if (has(v, "source") && v.source !== undefined) {
		if (typeof v.source !== "string" || !EXECUTABLE_SOURCES.includes(v.source)) return INVALID;
		out.source = v.source;
	}
	if (has(v, "binaryVersion") && v.binaryVersion !== undefined) {
		if (v.binaryVersion !== null && !isText(v.binaryVersion)) return INVALID;
		out.binaryVersion = v.binaryVersion;
	}
	return out;
}

/** Strict: one bad entry makes the whole value invalid. Lenient: bad entries are dropped. */
function cleanExecutables(v: unknown, strict: boolean): Cleaned {
	if (!isPlainObject(v)) return INVALID;
	const out: Record<string, unknown> = {};
	for (const tool of EXECUTABLE_TOOLS) {
		if (!has(v, tool) || v[tool] === undefined) continue;
		const entry = cleanExecutable(v[tool]);
		if (entry === INVALID) {
			if (strict) return INVALID;
			continue;
		}
		out[tool] = entry;
	}
	return out;
}

const FIELDS: ReadonlyMap<string, (v: unknown, strict: boolean) => Cleaned> = new Map([
	["version", cleanVersion],
	["agentTypes", cleanTextList],
	["launchModes", cleanTextList],
	["os", cleanText],
	["terminalSupport", cleanTextList],
	["features", cleanTextList],
	["interactiveTerminalControl", cleanTerminalControl],
	["executables", cleanExecutables],
]);

function defaultCapabilities(): Record<string, unknown> {
	return {
		version: 1,
		agentTypes: [],
		launchModes: [],
		os: "unknown",
		terminalSupport: [],
		features: [],
	};
}

/**
 * Capabilities safe to dereference, whatever was stored: defaults, with each
 * allowlisted field replaced by the supervisor's value when it is valid.
 * Unknown keys are dropped. Never throws, so old rows holding `{}`, a partial
 * object or junk keep working.
 */
export function withCapabilityDefaults(raw: unknown): SupervisorCapabilities {
	const out = defaultCapabilities();
	if (isPlainObject(raw)) {
		for (const [key, clean] of FIELDS) {
			if (!has(raw, key) || raw[key] === undefined) continue;
			const value = clean(raw[key], false);
			if (value !== INVALID) out[key] = value;
		}
	}
	return out as unknown as SupervisorCapabilities;
}

export type CapabilityParseResult =
	| { ok: true; value: SupervisorCapabilities }
	| { ok: false; field: string };

/**
 * Registration-time check. A missing (or null) value becomes the defaults; a
 * partial object is filled in; a wrongly typed or oversized value is refused,
 * naming the field, instead of being stored.
 */
export function parseSupervisorCapabilities(raw: unknown): CapabilityParseResult {
	if (raw === undefined || raw === null) {
		return { ok: true, value: defaultCapabilities() as unknown as SupervisorCapabilities };
	}
	if (!isPlainObject(raw)) return { ok: false, field: "capabilities" };
	const out = defaultCapabilities();
	for (const [key, clean] of FIELDS) {
		if (!has(raw, key) || raw[key] === undefined) continue;
		const value = clean(raw[key], true);
		if (value === INVALID) return { ok: false, field: key };
		out[key] = value;
	}
	return { ok: true, value: out as unknown as SupervisorCapabilities };
}

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

export type TrustedRootsParseResult = { ok: true; value: string[] } | { ok: false };

/** Registration-time check: an array of non-empty absolute paths (missing means none). */
export function parseTrustedRoots(raw: unknown): TrustedRootsParseResult {
	if (raw === undefined || raw === null) return { ok: true, value: [] };
	if (!Array.isArray(raw) || raw.length > MAX_TRUSTED_ROOTS) return { ok: false };
	for (const root of raw) {
		if (!isText(root, MAX_PATH) || root.length === 0 || !ABSOLUTE_PATH.test(root)) {
			return { ok: false };
		}
	}
	return { ok: true, value: [...raw] };
}

/** Read side: anything but an array of strings means no trusted roots. */
export function readTrustedRoots(raw: unknown): string[] {
	if (!Array.isArray(raw) || !raw.every((root) => typeof root === "string")) return [];
	return [...raw];
}

export type RegistrationShape =
	| { ok: true; capabilities: SupervisorCapabilities; trustedRoots: string[] }
	| { ok: false; body: { error: string; field?: string } };

/** Both registration checks together, for the route. */
export function parseRegistrationShape(input: {
	capabilities?: unknown;
	trustedRoots?: unknown;
}): RegistrationShape {
	const capabilities = parseSupervisorCapabilities(input.capabilities);
	if (!capabilities.ok) {
		return { ok: false, body: { error: "invalid_capabilities", field: capabilities.field } };
	}
	const roots = parseTrustedRoots(input.trustedRoots);
	if (!roots.ok) return { ok: false, body: { error: "invalid_trusted_roots" } };
	return { ok: true, capabilities: capabilities.value, trustedRoots: roots.value };
}
