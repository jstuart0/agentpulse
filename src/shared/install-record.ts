/**
 * What this machine knows about how AgentPulse was installed: `~/.agentpulse/install.json`, written by
 * `install-local.sh`, and the kind of install a running process belongs to. The server, the updater and
 * the CLI all read it here, and nothing here writes it. A record that is missing, unreadable, not private
 * to this account or not shaped as expected reads as "no record": never a guess.
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readPrivateFileNoFollow } from "./private-read.js";

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
	bunBin: string;
}

export interface InstallRecordDeps {
	/** The uid the record's file and directory must belong to; this process's by default. */
	ownerUid?: number;
	/** `existsSync`, for the container marker files. */
	exists?: (path: string) => boolean;
}

export const INSTALL_RECORD_FILE = "install.json";
const MAX_RECORD_BYTES = 16 * 1024;
const COMPONENTS: readonly string[] = ["server", "supervisor"];

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
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
		!isAbsolutePath(r.installDir) ||
		!nullableString(r.dataDir) ||
		!nullableString(r.sqlitePath) ||
		!(r.dialect === null || r.dialect === "sqlite") ||
		!oneOf(r.service, ["launchd", "systemd", "none"] as const) ||
		!isString(r.serverUrl) ||
		!oneOf(r.serverTransport, ["https", "loopback", "http"] as const) ||
		!isAbsolutePath(r.bunBin)
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
		serverTransport: r.serverTransport,
		bunBin: r.bunBin,
	};
}

/** The install record under `home`, or null for anything but a private, well-formed one. */
export function readInstallRecord(
	home: string,
	deps: InstallRecordDeps = {},
): InstallRecord | null {
	const read = readPrivateFileNoFollow(
		join(home, ".agentpulse", INSTALL_RECORD_FILE),
		MAX_RECORD_BYTES,
		...(deps.ownerUid === undefined ? [] : [deps.ownerUid]),
	);
	if (read.kind !== "ok") return null;
	try {
		return parseRecord(JSON.parse(read.text));
	} catch {
		return null;
	}
}

function samePath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/**
 * Which kind of install the process with working directory `cwd` belongs to: a matching install record
 * first, then Kubernetes, then a container, else a source checkout (or anything unrecognised).
 */
export function detectInstallKind(
	env: Record<string, string | undefined>,
	cwd: string,
	home: string,
	deps: InstallRecordDeps = {},
): InstallKind {
	const record = readInstallRecord(home, deps);
	if (record && samePath(record.installDir, cwd)) return "local";
	if (env.KUBERNETES_SERVICE_HOST) return "kubernetes";
	const exists = deps.exists ?? existsSync;
	if (
		env.AGENTPULSE_INSTALL_KIND === "container" ||
		exists("/.dockerenv") ||
		exists("/run/.containerenv")
	) {
		return "container";
	}
	return "source";
}
