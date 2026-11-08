/**
 * The person's fork MCP file (AGEN-121): `~/.agentpulse/claude-fork-mcp.json`, in Claude's `mcpServers` shape.
 * It is the consent artifact. A fork starts exactly the servers this file lists, nothing Claude's own
 * configuration, plugins or account hold, and the host never reads `~/.claude.json`.
 *
 * The file must be a plain file owned by the account that runs the supervisor, mode 0600, at most 64 KiB, with
 * at most 16 servers named `^[A-Za-z0-9-]{1,32}$`. Each server is stdio (`command`, `args`, `env`) or
 * `http`/`sse` (`url`, `headers`). Anything else makes the whole file invalid: nothing is applied, and no part
 * of a half-valid file is used. The bytes are read once from one open descriptor; the digests and the private
 * copy a fork starts from are built from what was parsed from those bytes, never from a second read.
 */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
	FORK_MCP_FILE_MAX_BYTES,
	FORK_MCP_MAX_SERVERS,
	FORK_MCP_SERVER_NAME,
	isPlainObject,
} from "../../shared/claude-fork-mcp.js";

/** One server as the file lists it, validated. `type` is always present once read. */
export type ForkMcpServerConfig =
	| { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
	| { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export interface ForkMcpServer {
	name: string;
	config: ForkMcpServerConfig;
	/** sha256 of the server's canonical JSON. */
	digest: string;
}

export type ForkMcpFileProblem =
	| "missing"
	| "unreadable"
	| "not_plain_file"
	| "not_owned"
	| "bad_mode"
	| "too_big"
	| "not_json"
	| "bad_shape"
	| "too_many_servers"
	| "bad_server_name"
	| "bad_server";

export type ForkMcpFileResult =
	| { ok: true; servers: ForkMcpServer[] }
	| { ok: false; problem: ForkMcpFileProblem };

const COMMAND_MAX = 4096;
const ARG_MAX = 4096;
const ARGS_MAX = 256;
const ENV_MAX = 64;
const VALUE_MAX = 8192;
const URL_MAX = 4096;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** An HTTP header name, token characters only. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,128}$/;

const has = (value: Record<string, unknown>, key: string) =>
	Object.hasOwn(value, key) && value[key] !== undefined;

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function stringMap(value: unknown, name: RegExp, max: number): Record<string, string> | null {
	if (!isPlainObject(value)) return null;
	const entries = Object.entries(value);
	if (entries.length > max) return null;
	const out: Record<string, string> = {};
	for (const [key, v] of entries) {
		if (!name.test(key) || typeof v !== "string" || v.length > VALUE_MAX) return null;
		out[key] = v;
	}
	return out;
}

function readServer(raw: unknown): ForkMcpServerConfig | null {
	if (!isPlainObject(raw)) return null;
	const type = has(raw, "type") ? raw.type : "stdio";
	if (type === "stdio") {
		if (!onlyKeys(raw, ["type", "command", "args", "env"])) return null;
		const { command } = raw;
		if (typeof command !== "string" || command === "" || command.length > COMMAND_MAX) return null;
		const out: ForkMcpServerConfig = { type: "stdio", command };
		if (has(raw, "args")) {
			const { args } = raw;
			if (!Array.isArray(args) || args.length > ARGS_MAX) return null;
			if (!args.every((a) => typeof a === "string" && a.length <= ARG_MAX)) return null;
			out.args = args as string[];
		}
		if (has(raw, "env")) {
			const env = stringMap(raw.env, ENV_NAME, ENV_MAX);
			if (!env) return null;
			out.env = env;
		}
		return out;
	}
	if (type === "http" || type === "sse") {
		if (!onlyKeys(raw, ["type", "url", "headers"])) return null;
		const { url } = raw;
		if (typeof url !== "string" || url === "" || url.length > URL_MAX) return null;
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		const out: ForkMcpServerConfig = { type, url };
		if (has(raw, "headers")) {
			const headers = stringMap(raw.headers, HEADER_NAME, ENV_MAX);
			if (!headers) return null;
			out.headers = headers;
		}
		return out;
	}
	return null;
}

/** JSON with keys sorted at every level, so two spellings of the same server hash the same. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isPlainObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function serverDigest(config: ForkMcpServerConfig): string {
	return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** The validated servers of already-read file text, in file order. */
export function parseForkMcpText(text: string): ForkMcpFileResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, problem: "not_json" };
	}
	if (!isPlainObject(parsed) || !onlyKeys(parsed, ["mcpServers"])) {
		return { ok: false, problem: "bad_shape" };
	}
	const list = parsed.mcpServers;
	if (!isPlainObject(list)) return { ok: false, problem: "bad_shape" };
	const names = Object.keys(list);
	if (names.length > FORK_MCP_MAX_SERVERS) return { ok: false, problem: "too_many_servers" };
	const servers: ForkMcpServer[] = [];
	for (const name of names) {
		if (!FORK_MCP_SERVER_NAME.test(name)) return { ok: false, problem: "bad_server_name" };
		const config = readServer(list[name]);
		if (!config) return { ok: false, problem: "bad_server" };
		servers.push({ name, config, digest: serverDigest(config) });
	}
	return { ok: true, servers };
}

export interface ForkMcpFileDeps {
	/** The uid the supervisor runs as; the file must be owned by it. Default `process.getuid()`. */
	uid?: number | null;
}

/**
 * Reads and checks the file at `path`. The checks run on the descriptor that is read (a link in place of the
 * file is refused at open), so nothing can be swapped between the check and the read.
 */
export function readForkMcpFile(path: string, deps: ForkMcpFileDeps = {}): ForkMcpFileResult {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return { ok: false, problem: "missing" };
		if (code === "ELOOP") return { ok: false, problem: "not_plain_file" };
		return { ok: false, problem: "unreadable" };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return { ok: false, problem: "not_plain_file" };
		const uid = deps.uid === undefined ? (process.getuid?.() ?? null) : deps.uid;
		if (uid !== null && stat.uid !== uid) return { ok: false, problem: "not_owned" };
		if ((stat.mode & 0o777) !== 0o600) return { ok: false, problem: "bad_mode" };
		if (stat.size > FORK_MCP_FILE_MAX_BYTES) return { ok: false, problem: "too_big" };
		const buffer = Buffer.alloc(stat.size);
		let read = 0;
		while (read < buffer.length) {
			const n = readSync(fd, buffer, read, buffer.length - read, read);
			if (n === 0) break;
			read += n;
		}
		return parseForkMcpText(buffer.subarray(0, read).toString("utf8"));
	} catch {
		return { ok: false, problem: "unreadable" };
	} finally {
		closeSync(fd);
	}
}

/**
 * The text a fork's private `--mcp-config` holds: exactly the validated servers, serialised from what was
 * parsed (so it can't differ from what was hashed).
 */
export function privateConfigText(servers: readonly ForkMcpServer[]): string {
	const mcpServers: Record<string, ForkMcpServerConfig> = {};
	for (const server of servers) mcpServers[server.name] = server.config;
	return `${JSON.stringify({ mcpServers })}\n`;
}
