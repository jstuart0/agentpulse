/**
 * The MCP half of a fork's tool policy (AGEN-121). With MCP asked for, a valid fork MCP file and a Claude Code
 * version the option was measured on, the host writes exactly the file's servers into a private `--mcp-config`
 * copy, keeps `--strict-mcp-config` on, and binds the fork to what it started with:
 *
 * - the first `init` must name exactly the applied servers (a status of `failed` is fine) and every `mcp__`
 *   tool in it must belong to one of them, else the fork is ended (`mcp_servers_changed`);
 * - a digest of each server's canonical JSON is stored with the session, and a recovery refuses
 *   `mcp_servers_changed` unless the file still lists exactly those servers with those digests, so a server
 *   added or edited since the takeover never starts without the person continuing the original again.
 *
 * Where the file lives is set once at the composition root (`configureForkMcp`); an unconfigured host applies
 * nothing, so a test or a canary can never read the person's real file by accident.
 */
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fchmodSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FORK_TOOL_NAMES } from "../../shared/claude-fork-copy.js";
import { MCP_TOOL_PREFIX } from "../../shared/claude-fork-copy.js";
import { splitForkMcpToolName } from "../../shared/claude-fork-mcp.js";
import type { AppliedForkOptions, ForkOptionsRequest } from "../../shared/session-resume.js";
import { type ForkMcpServer, privateConfigText, readForkMcpFile } from "./claude-fork-mcp-file.js";
import type { ForkOptionsContext, ForkPolicyPart, PreparedPart } from "./claude-fork-tools.js";

export const FORK_MCP_FILE_NAME = "claude-fork-mcp.json";
export const FORK_MCP_COPY_DIR = "claude-fork-mcp";
/** A private copy no fork of this process holds and nobody has touched for this long is left over from a crash. */
const STALE_COPY_MS = 24 * 60 * 60 * 1000;

/** A recovery that can't start the servers the fork was started with. The takeover maps it to its refusal. */
export class ForkOptionsRefusal extends Error {
	readonly kind = "mcp_servers_changed" as const;
	constructor(detail: string) {
		super(`mcp_servers_changed: ${detail}`);
		this.name = "ForkOptionsRefusal";
	}
}

export interface ForkMcpConfig {
	/** The account's `.agentpulse` directory on this host. */
	agentpulseDir: string;
	/** The uid the file must belong to. Default: the supervisor's own. */
	uid?: number | null;
}

let configured: ForkMcpConfig | null = null;

/** Where the fork MCP file is looked for. Called once by the supervisor; `null` turns the option off. */
export function configureForkMcp(config: ForkMcpConfig | null): void {
	configured = config;
}

/** The private copies this process wrote and has not removed. */
const liveCopies = new Set<string>();
/** The private copy a policy's `--mcp-config` points at, found from the `mcpServers` list that was applied. */
const copyPathOf = new WeakMap<object, string>();

const isMcpName = (value: unknown): value is string =>
	typeof value === "string" && value.startsWith(MCP_TOOL_PREFIX);

function appliedNames(applied: AppliedForkOptions): string[] {
	return applied.mcpServers.map((s) => s.name);
}

function sameSet(a: readonly string[], b: ReadonlySet<string>): boolean {
	return a.length === b.size && new Set(a).size === a.length && a.every((x) => b.has(x));
}

/**
 * What the first `init` must show. The tool list is the six plus the `mcp__` tools of applied servers (a name
 * of any other server, or a malformed one, fails), and `mcp_servers` names exactly the applied servers.
 */
function initProblem(
	init: Record<string, unknown>,
	names: readonly string[],
): "tools" | "mcp_servers" | null {
	const applied = new Set(names);
	const listed = init.tools;
	if (!Array.isArray(listed)) return "tools";
	const own: unknown[] = [];
	const mcp: unknown[] = [];
	for (const entry of listed) (isMcpName(entry) ? mcp : own).push(entry);
	const six = new Set<string>(FORK_TOOL_NAMES);
	if (
		own.length !== six.size ||
		!own.every((t) => typeof t === "string" && six.has(t)) ||
		new Set(own).size !== six.size
	) {
		return "tools";
	}
	const mcpSeen = new Set<unknown>();
	for (const entry of mcp) {
		if (typeof entry !== "string" || mcpSeen.has(entry)) return "mcp_servers";
		mcpSeen.add(entry);
		if (splitForkMcpToolName(entry, names) === null) return "mcp_servers";
	}
	const servers = init.mcp_servers;
	if (!Array.isArray(servers)) return "mcp_servers";
	const reported: string[] = [];
	for (const s of servers) {
		if (typeof s !== "object" || s === null || typeof (s as { name?: unknown }).name !== "string") {
			return "mcp_servers";
		}
		reported.push((s as { name: string }).name);
	}
	return sameSet(reported, applied) ? null : "mcp_servers";
}

/** What the policy contributes for the MCP servers `applied` names. Null: nothing. */
export function mcpPolicyPart(applied: AppliedForkOptions): ForkPolicyPart | null {
	if (applied.mcpServers.length === 0) return null;
	const names = appliedNames(applied);
	const path = copyPathOf.get(applied.mcpServers);
	return {
		...(path !== undefined ? { mcpConfigPath: path } : {}),
		// Recomputed from scratch: the base check counts the `mcp__` tools as unknown tools.
		initToolsProblem: (init) => initProblem(init, names),
	};
}

/** Whether `toolName` is an MCP tool of an applied server. Null: not one. */
export function mcpToolKind(toolName: string, applied: AppliedForkOptions): "mcp" | null {
	if (applied.mcpServers.length === 0) return null;
	return splitForkMcpToolName(toolName, appliedNames(applied)) === null ? null : "mcp";
}

function sweepStaleCopies(dir: string, now: number): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const path = join(dir, name);
		if (liveCopies.has(path)) continue;
		try {
			if (now - statSync(path).mtimeMs > STALE_COPY_MS) rmSync(path, { force: true });
		} catch {
			// A copy that can't be examined is left for the next sweep.
		}
	}
}

/** The uid the copy directory must belong to: the configured one, else the supervisor's own. Null: not checked (Windows). */
function expectedUid(): number | null {
	if (configured?.uid !== undefined) return configured.uid;
	return process.getuid?.() ?? null;
}

/**
 * The private copy directory, made if missing. It is opened by descriptor without following a link, and the
 * mode is set on that descriptor, so nothing can be swapped between the check and the chmod; a directory that
 * isn't a plain directory of this account is refused (review L5), because the copies hold MCP credentials.
 */
export function privateCopyDirectory(root: string, uid: number | null = expectedUid()): string {
	const dir = join(root, FORK_MCP_COPY_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isDirectory()) throw new Error("the copy directory isn't plain");
		if (uid !== null && stat.uid !== uid)
			throw new Error("the copy directory isn't this account's");
		fchmodSync(fd, 0o700);
	} finally {
		closeSync(fd);
	}
	return dir;
}

/**
 * Removes every private copy left in the directory by an earlier process (a crash leaves 0600 files holding MCP
 * `env` and `headers` until a sweep reaches them). Run once at supervisor start, before any fork exists, so
 * nothing in it is held by this process; this account runs one supervisor at a time. A directory that isn't a
 * plain directory of this account is left alone. Returns how many files went.
 */
export function sweepLeftoverMcpCopies(): number {
	if (!configured) return 0;
	const dir = join(configured.agentpulseDir, FORK_MCP_COPY_DIR);
	let removed = 0;
	try {
		const stat = lstatSync(dir);
		const uid = expectedUid();
		if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
		if (uid !== null && stat.uid !== uid) return 0;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (liveCopies.has(path)) continue;
			try {
				if (lstatSync(path).isFile()) {
					rmSync(path, { force: true });
					removed++;
				}
			} catch {
				// A copy that can't be examined is left for the next sweep.
			}
		}
	} catch {
		// No directory yet: nothing was ever written.
	}
	return removed;
}

/** Writes the copy atomically (a temp file, then a rename), mode 0600, from the validated servers. */
function writePrivateCopy(dir: string, servers: readonly ForkMcpServer[]): string {
	const finalPath = join(dir, `${randomUUID()}.json`);
	const tempPath = `${finalPath}.tmp`;
	writeFileSync(tempPath, privateConfigText(servers), { mode: 0o600, flag: "wx" });
	renameSync(tempPath, finalPath);
	chmodSync(finalPath, 0o600);
	return finalPath;
}

function digestMap(list: readonly { name: string; digest: string }[]): Map<string, string> {
	return new Map(list.map((s) => [s.name, s.digest]));
}

/**
 * Reads the person's file and writes the private `--mcp-config` copy, when the request asks for MCP (a
 * takeover) or the fork was started with it (a recovery, `ctx.stored`). Null: nothing applied. A recovery whose
 * file no longer matches what the fork was started with throws `ForkOptionsRefusal`.
 */
export async function prepareMcp(
	asked: ForkOptionsRequest,
	ctx: ForkOptionsContext,
): Promise<PreparedPart | null> {
	const storedServers = ctx.stored?.mcpServers ?? [];
	const recovering = storedServers.length > 0;
	if (asked.mcp !== true && !recovering) return null;
	const log = (line: string) => ctx.log?.(`[claude-fork-mcp] ${line}`);
	if (!configured) {
		if (recovering) throw new ForkOptionsRefusal("the host doesn't know where the file is");
		return null;
	}
	const file = readForkMcpFile(join(configured.agentpulseDir, FORK_MCP_FILE_NAME), {
		uid: configured.uid,
	});
	if (!file.ok) {
		// The problem is a fixed word: nothing from the file is logged.
		log(`the fork MCP file can't be used: ${file.problem}`);
		if (recovering) throw new ForkOptionsRefusal(file.problem);
		return null;
	}
	if (recovering) {
		const now = digestMap(file.servers);
		const was = digestMap(storedServers);
		const same =
			now.size === was.size && [...was].every(([name, digest]) => now.get(name) === digest);
		if (!same) throw new ForkOptionsRefusal("the servers or their settings changed");
	} else if (file.servers.length === 0) {
		log("the fork MCP file lists no servers");
		return null;
	}

	const dir = privateCopyDirectory(configured.agentpulseDir);
	sweepStaleCopies(dir, Date.now());
	const path = writePrivateCopy(dir, file.servers);
	liveCopies.add(path);
	const mcpServers = file.servers.map((s) => ({ name: s.name, digest: s.digest }));
	copyPathOf.set(mcpServers, path);
	const applied: AppliedForkOptions = { mcpServers, subagents: false, claudeVersion: "" };
	return {
		applied: { mcpServers },
		part: mcpPolicyPart({ ...applied, claudeVersion: ctx.claudeVersion ?? "" }) ?? {},
		cleanup() {
			liveCopies.delete(path);
			rmSync(path, { force: true });
			rmSync(`${path}.tmp`, { force: true });
		},
	};
}
