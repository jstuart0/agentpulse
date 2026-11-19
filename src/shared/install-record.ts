/**
 * What this machine knows about how AgentPulse was installed: `~/.agentpulse/install.json`, written by
 * `install-local.sh`, and the kind of install a running process belongs to. The server, the updater and
 * the CLI all read it here, and nothing here writes it. A record that is missing, unreadable, not private
 * to this account or not shaped as expected reads as "no record": never a guess.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type PrivateFileRead, readPrivateFileNoFollow } from "./private-read.js";

export type InstallKind = "local" | "kubernetes" | "container" | "source";
export type InstallComponent = "server" | "supervisor";

export interface InstallRecord {
	schema: 1;
	kind: "local";
	components: InstallComponent[];
	repoUrl: string;
	track: "release" | "ref";
	ref: string;
	/** Realpath of the checkout. The server's working directory when it runs from this install. */
	installDir: string;
	/** Null for a supervisor-only install, which has no database. */
	dataDir: string | null;
	sqlitePath: string | null;
	dialect: "sqlite" | null;
	service: "launchd" | "systemd" | "none";
	serverUrl: string;
	serverTransport: "https" | "loopback" | "http";
	/** The port the local server listens on (the updater probes `127.0.0.1:<port>`); null for a supervisor-only install. */
	port: number | null;
	bunBin: string;
}

/** Test seams. Only the `...ForTests` entry points take these; production callers cannot. */
interface InstallRecordDeps {
	/** Reads the record file (a test passes one that judges ownership as another uid). */
	read?: (path: string, maxBytes: number) => PrivateFileRead;
	/** `existsSync`, for the container marker files. */
	exists?: (path: string) => boolean;
}

export const INSTALL_RECORD_FILE = "install.json";
const MAX_RECORD_BYTES = 16 * 1024;
const COMPONENTS: readonly string[] = ["server", "supervisor"];

function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,128}$/;

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !hasControlChar(value);
}
function isAbsolutePath(value: unknown): value is string {
	return isString(value) && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
function nullableString(value: unknown): value is string | null {
	return value === null || isString(value);
}

/** How a supervisor reaches the server at `url`, from the URL itself: never from a stored claim. */
export function serverTransportOf(url: string): InstallRecord["serverTransport"] | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol === "https:") return "https";
	if (parsed.protocol !== "http:") return null;
	return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ? "loopback" : "http";
}

function parseRecord(raw: unknown): InstallRecord | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const components = r.components;
	if (
		r.schema !== 1 ||
		r.kind !== "local" ||
		!Array.isArray(components) ||
		components.length === 0 ||
		!components.every((c) => typeof c === "string" && COMPONENTS.includes(c)) ||
		!isString(r.repoUrl) ||
		!oneOf(r.track, ["release", "ref"] as const) ||
		!isString(r.ref) ||
		!REF_PATTERN.test(r.ref) ||
		!isAbsolutePath(r.installDir) ||
		!nullableString(r.dataDir) ||
		!nullableString(r.sqlitePath) ||
		!(r.dialect === null || r.dialect === "sqlite") ||
		!oneOf(r.service, ["launchd", "systemd", "none"] as const) ||
		!isString(r.serverUrl) ||
		!isAbsolutePath(r.bunBin)
	) {
		return null;
	}
	const serverTransport = serverTransportOf(r.serverUrl);
	if (!serverTransport) return null;
	const port = r.port === undefined || r.port === null ? null : r.port;
	if (
		port !== null &&
		(typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
	) {
		return null;
	}
	return {
		schema: 1,
		kind: "local",
		components: [...new Set(components as InstallComponent[])],
		repoUrl: r.repoUrl,
		track: r.track,
		ref: r.ref,
		installDir: r.installDir,
		dataDir: r.dataDir,
		sqlitePath: r.sqlitePath,
		dialect: r.dialect,
		service: r.service,
		serverUrl: r.serverUrl,
		serverTransport,
		port,
		bunBin: r.bunBin,
	};
}

type RecordReader = (path: string, maxBytes: number) => PrivateFileRead;

function readRecordWith(home: string, read: RecordReader): InstallRecord | null {
	const file = read(join(home, ".agentpulse", INSTALL_RECORD_FILE), MAX_RECORD_BYTES);
	if (file.kind !== "ok") return null;
	try {
		return parseRecord(JSON.parse(file.text));
	} catch {
		return null;
	}
}

/** The install record under `home`, or null for anything but a private, well-formed one. */
export function readInstallRecord(home: string): InstallRecord | null {
	return readRecordWith(home, readPrivateFileNoFollow);
}

/** Test only: read the record through `read`, e.g. one that judges ownership as another uid. */
export function readInstallRecordForTests(home: string, read: RecordReader): InstallRecord | null {
	return readRecordWith(home, read);
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

function detectKind(
	env: Record<string, string | undefined>,
	cwd: string,
	home: string,
	deps: InstallRecordDeps,
): InstallKind {
	// What the process is running inside comes first: a record on disk can't turn a container or a pod
	// into a local install. The record may only upgrade a plain source checkout to `local`.
	if (env.KUBERNETES_SERVICE_HOST) return "kubernetes";
	const exists = deps.exists ?? existsSync;
	if (
		env.AGENTPULSE_INSTALL_KIND === "container" ||
		exists("/.dockerenv") ||
		exists("/run/.containerenv")
	) {
		return "container";
	}
	const record = readRecordWith(home, deps.read ?? readPrivateFileNoFollow);
	return record && samePath(record.installDir, cwd) ? "local" : "source";
}

/**
 * Which kind of install the process with working directory `cwd` belongs to: Kubernetes, then a
 * container, then (only when an install record names this directory) a local install, else a source
 * checkout or anything unrecognised.
 */
export function detectInstallKind(
	env: Record<string, string | undefined>,
	cwd: string,
	home: string,
): InstallKind {
	return detectKind(env, cwd, home, {});
}

/** Test only: `detectInstallKind` with the marker-file check and the record's owner uid injected. */
export function detectInstallKindForTests(
	env: Record<string, string | undefined>,
	cwd: string,
	home: string,
	deps: InstallRecordDeps,
): InstallKind {
	return detectKind(env, cwd, home, deps);
}
