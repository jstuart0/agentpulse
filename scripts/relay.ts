#!/usr/bin/env bun
/**
 * AgentPulse localhost relay.
 *
 * Agents can only post hooks to localhost, so this process listens on
 * 127.0.0.1, queues hook events on disk and forwards them (with the API key)
 * to the remote AgentPulse server. It also syncs session names (Codex's
 * session_index.jsonl ⇄ the dashboard) and CLAUDE.md/AGENTS.md files.
 *
 * Self-contained by design: it runs from a single copied file on machines that
 * don't have the repo, so it imports only `node:` builtins and duplicates the
 * few server helpers it needs (sanitizeName, computeChecksum) under parity
 * tests (scripts/relay.test.ts).
 *
 * Every side effect (argv, Bun.serve, timers, banner, exit) lives under
 * `import.meta.main`, so tests can import this module freely (F9).
 */
import {
	constants,
	appendFile,
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const RELAY_FETCH_TIMEOUT_MS = 8_000;
const SYNC_FETCH_TIMEOUT_MS = 5_000;
const RELAY_IDLE_TIMEOUT_S = 30;
const HOOK_RETRY_BASE_MS = 2_000;
const HOOK_RETRY_MAX_MS = 60_000;
const HOOK_RETRY_POLL_MS = 5_000;
const DEFAULT_PORT = 4000;
const DEFAULT_SYNC_MS = 30_000;
const SCOPE_CHECK_MS = 10 * 60_000;
const DRIFT_CHECK_MS = 60 * 60_000;
const CODEX_PAGE_SIZE = 50;
const CODEX_MAX_PAGES = 4;
// F128: the narrow projection; a server without it ignores the parameter and
// returns full rows, which carry the same three fields.
const CODEX_LIST_FIELDS = "sessionId,displayName,nameSource";
const MAX_PUSHES_PER_TICK = CODEX_PAGE_SIZE * CODEX_MAX_PAGES;
const STORM_WINDOW_MS = 60 * 60_000;
/** F109: at most this many appends per Codex id per rolling STORM_WINDOW_MS, of any kind. */
const STORM_MAX_PUSHES = 3;
const PULL_MAX_CONSECUTIVE_404 = 5;
const PULL_STALE_ENTRY_MS = 24 * 60 * 60_000;
/** F125: bounds the post-restart burst against the server's /native-name rate limit. */
const MAX_PULL_PUTS_PER_TICK = 50;
const MAX_PULL_STATE_ENTRIES = 5000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const CLAUDE_MD_SESSION_LIMIT = 20;
/** F106: sessions this relay forwarded, remembered for CLAUDE.md sync. */
const MAX_LOCAL_SESSIONS = 1000;
/** F122: a revoked key must not grow the queue without bound. */
const MAX_QUEUE_FILES = 10_000;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60_000;
/** F109: past this many ledger lines, drop rows no longer in the index. */
const LEDGER_COMPACT_THRESHOLD = 2000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
// O_NOFOLLOW is POSIX-only; on platforms without it the lstat check still runs.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const REQUIRED_SCOPES = ["ingest", "observe"] as const;
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
const DEFAULT_AGENT_TYPE = "claude_code";
const USAGE =
	"Usage: relay.ts [<url>] [--config <path>] [--port N] [--key K] [--codex-name-policy agentpulse|codex]";

// ── Config ───────────────────────────────────────────────────────────────────

export type CodexNamePolicy = "agentpulse" | "codex";
const CODEX_NAME_POLICIES: readonly string[] = ["agentpulse", "codex"];

/** The installer-written config.json (snake_case keys). */
export type RelayFileConfig = {
	remote_url?: string;
	api_key?: string;
	port?: number;
	codex_name_policy?: string;
	state_dir?: string;
};

export type RelayConfig = {
	remoteUrl: string;
	apiKey: string;
	port: number;
	codexNamePolicy: CodexNamePolicy;
	/** Hook queue, status file, ledger and cache all live here (F51). */
	stateDir: string;
	configPath: string | null;
};

export type ParseResult = { ok: true; config: RelayConfig } | { ok: false; error: string };

const VALUE_FLAGS: Record<string, "port" | "key" | "config" | "policy"> = {
	"--port": "port",
	"--key": "key",
	"--config": "config",
	"--codex-name-policy": "policy",
};

/**
 * Pure: no I/O, no exit. Precedence is argv > config file > default, like
 * src/supervisor/config.ts. `env` carries the two environment-derived stateDir
 * fallbacks so the function stays deterministic.
 */
export function parseArgs(
	argv: string[],
	fileConfig: RelayFileConfig,
	env: { agentpulseDir?: string; scriptDir?: string } = {},
): ParseResult {
	const flags: Partial<Record<"url" | "port" | "key" | "config" | "policy", string>> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const name = VALUE_FLAGS[arg];
		if (name) {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				return { ok: false, error: `${arg} needs a value` };
			}
			flags[name] = value;
			i++;
			continue;
		}
		if (arg.startsWith("--")) return { ok: false, error: `unknown option ${arg}` };
		flags.url = arg;
	}

	const rawUrl = flags.url ?? fileConfig.remote_url;
	if (!rawUrl) return { ok: false, error: "the remote AgentPulse URL is required" };
	const remoteUrl = rawUrl.replace(/\/+$/, "");
	if (!/^https?:\/\/[^\s/]+/i.test(remoteUrl)) {
		return {
			ok: false,
			error: `the remote URL must start with http:// or https:// (${remoteUrl})`,
		};
	}

	const rawPort = flags.port ?? fileConfig.port ?? DEFAULT_PORT;
	const port = Number(rawPort);
	if (String(rawPort).trim() === "" || !Number.isInteger(port) || port < 0 || port > 65535) {
		return { ok: false, error: `invalid port ${String(rawPort)}` };
	}

	const policy = flags.policy ?? fileConfig.codex_name_policy ?? "codex";
	if (!CODEX_NAME_POLICIES.includes(policy)) {
		return { ok: false, error: `codex name policy must be agentpulse or codex (got ${policy})` };
	}

	const configPath = flags.config ?? null;
	const stateDir =
		fileConfig.state_dir ??
		(configPath ? dirname(configPath) : undefined) ??
		env.agentpulseDir ??
		env.scriptDir ??
		".";

	return {
		ok: true,
		config: {
			remoteUrl,
			apiKey: flags.key ?? fileConfig.api_key ?? "",
			port,
			codexNamePolicy: policy as CodexNamePolicy,
			stateDir,
			configPath,
		},
	};
}

/** Reads config.json. A missing file is `{}`; malformed JSON throws. */
export async function loadConfigFile(path: string): Promise<RelayFileConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return {};
		throw err;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path}: expected a JSON object`);
	}
	const o = parsed as Record<string, unknown>;
	const out: RelayFileConfig = {};
	if (typeof o.remote_url === "string") out.remote_url = o.remote_url;
	if (typeof o.api_key === "string") out.api_key = o.api_key;
	if (typeof o.port === "number" || (typeof o.port === "string" && o.port.trim() !== "")) {
		out.port = Number(o.port);
	}
	if (typeof o.codex_name_policy === "string") out.codex_name_policy = o.codex_name_policy;
	if (typeof o.state_dir === "string") out.state_dir = o.state_dir;
	return out;
}

function findConfigPath(argv: string[]): string | null {
	const i = argv.indexOf("--config");
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
}

// ── Duplicated server helpers (parity-tested) ────────────────────────────────

// Deliberate duplicate of src/server/services/name-sanitizer.ts. The global
// flag makes .test() stateful, so this pattern is only ever used with
// .replace() (F93).
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping C0/DEL control characters from untrusted input
const UNSAFE_NAME_CHARS_RE = /[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g;
const MAX_NAME_CODE_POINTS = 200;
const NAME_PRE_CAP_CODE_UNITS = 4096;

export function sanitizeName(raw: string): string {
	let bounded = raw;
	if (bounded.length > NAME_PRE_CAP_CODE_UNITS) {
		let end = NAME_PRE_CAP_CODE_UNITS;
		const lastUnit = bounded.charCodeAt(end - 1);
		if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
		bounded = bounded.slice(0, end);
	}
	const stripped = bounded.replace(UNSAFE_NAME_CHARS_RE, "").trim();
	const codePoints = [...stripped];
	return codePoints.length > MAX_NAME_CODE_POINTS
		? codePoints.slice(0, MAX_NAME_CODE_POINTS).join("")
		: stripped;
}

// F80: intentionally duplicates src/server/util/checksum.ts's computeChecksum
// (same algorithm, same `trimEnd` option) rather than importing it.
export async function computeChecksum(
	content: string,
	options?: { trimEnd?: boolean },
): Promise<string> {
	const input = options?.trimEnd ? content.trimEnd() : content;
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

// ── State and context ────────────────────────────────────────────────────────

export type DriftStatus = "ok" | "outdated" | "missing" | "unknown";
export type SyncStatus = {
	status: string;
	lastError: string | null;
	lastSuccessAt: string | null;
};
type PullEntryState = { seenKey: string | null; missKey: string | null; missCount: number };
export type LocalSession = { cwd: string; agentType: string | null; seenAt: string };

export function createRelayState() {
	return {
		queue: {
			lastHookEnqueuedAt: null as string | null,
			lastHookForwardedAt: null as string | null,
			lastHookFailureAt: null as string | null,
			lastHookError: null as string | null,
			consecutiveHookFailures: 0,
			dropped: 0,
		},
		lastEventAtByAgent: {} as Record<string, string>,
		/** F106: sessionId → cwd, only from hooks this relay enqueued. Map order = recency. */
		localSessions: new Map<string, LocalSession>(),
		localSessionsWrite: Promise.resolve() as Promise<void>,
		auth: {
			scopes: null as string[] | null,
			missing: [] as string[],
			hasManage: false,
			checkedAt: null as string | null,
			degraded: false,
			keyRejected: false,
			lastError: null as string | null,
		},
		sync: {
			codexNames: {
				status: "idle",
				lastError: null,
				lastSuccessAt: null,
				suppressedIds: [] as string[],
			} as SyncStatus & { suppressedIds: string[] },
			claudeMd: { status: "idle", lastError: null, lastSuccessAt: null } as SyncStatus,
		},
		drift: {
			relay: "unknown" as DriftStatus,
			statusline: "unknown" as DriftStatus,
			checkedAt: null as string | null,
		},
		relayHash: "",
		codexPull: new Map<string, PullEntryState>(),
		pullStateLoaded: false,
		/** F125: epoch ms before which the pull doesn't PUT (server Retry-After). */
		pullRetryAt: 0,
		pushGuard: {} as Record<string, number[]>,
		suppressedLogged: new Set<string>(),
		refusedWrites: new Set<string>(),
		localChecksums: new Map<string, string>(),
		lastAuthLine: null as string | null,
		/** undefined = never written, so the first sync always reconciles disk. */
		statusLineWritten: undefined as string | null | undefined,
		queueRunning: false,
		queueTimer: null as ReturnType<typeof setTimeout> | null,
	};
}
export type RelayState = ReturnType<typeof createRelayState>;

export type RelayPaths = {
	stateDir: string;
	hookPendingDir: string;
	hookProcessingDir: string;
	statusFile: string;
	ledgerFile: string;
	localSessionsFile: string;
	pullStateFile: string;
	home: string;
	codexIndexFile: string;
	installedStatuslineFile: string;
	relayScriptFile: string;
};

export type RelayContext = {
	config: RelayConfig;
	state: RelayState;
	paths: RelayPaths;
	/** The actually-bound port (differs from config.port when that is 0). */
	port: number;
	fetch: typeof fetch;
	now: () => number;
	log: (line: string) => void;
	/** false in tests: nothing is scheduled behind the caller's back. */
	autoSchedule: boolean;
	limits: RelayLimits;
};

export type RelayLimits = {
	maxLocalSessions: number;
	maxQueueFiles: number;
	maxQueueAgeMs: number;
	ledgerCompactThreshold: number;
};

const DEFAULT_LIMITS: RelayLimits = {
	maxLocalSessions: MAX_LOCAL_SESSIONS,
	maxQueueFiles: MAX_QUEUE_FILES,
	maxQueueAgeMs: MAX_QUEUE_AGE_MS,
	ledgerCompactThreshold: LEDGER_COMPACT_THRESHOLD,
};

type ContextOptions = {
	env?: { HOME?: string; CODEX_HOME?: string };
	scriptPath?: string;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (line: string) => void;
	state?: RelayState;
	limits?: Partial<RelayLimits>;
};

export function resolveRelayPaths(
	config: RelayConfig,
	env: { HOME?: string; CODEX_HOME?: string },
	scriptPath: string,
): RelayPaths {
	const home = env.HOME ?? "";
	const codexHome = env.CODEX_HOME || join(home, ".codex");
	const hookQueueDir = join(config.stateDir, "hook-queue");
	return {
		stateDir: config.stateDir,
		hookPendingDir: join(hookQueueDir, "pending"),
		hookProcessingDir: join(hookQueueDir, "processing"),
		statusFile: join(config.stateDir, "status"),
		ledgerFile: join(config.stateDir, "codex-pushed.jsonl"),
		localSessionsFile: join(config.stateDir, "local-sessions.json"),
		pullStateFile: join(config.stateDir, "codex-pull-state.json"),
		home,
		codexIndexFile: join(codexHome, "session_index.jsonl"),
		installedStatuslineFile: join(home, ".claude", "statusline-agentpulse.sh"),
		relayScriptFile: scriptPath,
	};
}

export function createRelayContext(config: RelayConfig, opts: ContextOptions = {}): RelayContext {
	const env = opts.env ?? { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
	return {
		config,
		state: opts.state ?? createRelayState(),
		paths: resolveRelayPaths(config, env, opts.scriptPath ?? import.meta.path),
		port: config.port,
		fetch: opts.fetch ?? fetch,
		now: opts.now ?? Date.now,
		log: opts.log ?? ((line) => console.log(line)),
		autoSchedule: false,
		limits: { ...DEFAULT_LIMITS, ...opts.limits },
	};
}

// ── Small helpers ────────────────────────────────────────────────────────────

function iso(ms: number) {
	return new Date(ms).toISOString();
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters before logging
const LOG_UNSAFE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** F111: server- and Codex-controlled text can't forge log lines or escapes. */
function logSafe(value: unknown): string {
	return String(value).replace(LOG_UNSAFE_RE, "");
}

async function ensurePrivateDir(path: string) {
	await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

async function writePrivateFile(path: string, content: string) {
	await writeFile(path, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
}

async function appendPrivateFile(path: string, content: string) {
	await appendFile(path, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
}

/** Atomic replace (temp + rename), private mode. */
async function replacePrivateFile(path: string, content: string) {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writePrivateFile(tmp, content);
	await chmod(tmp, PRIVATE_FILE_MODE);
	await rename(tmp, path);
}

type LstatKind = "file" | "symlink" | "other" | "missing";

async function lstatKind(path: string): Promise<LstatKind> {
	try {
		const st = await lstat(path);
		if (st.isSymbolicLink()) return "symlink";
		return st.isFile() ? "file" : "other";
	} catch {
		return "missing";
	}
}

/** F107: reads a regular file without following a symlink at the final component. */
async function readFileNoFollow(path: string): Promise<string> {
	if ((await lstatKind(path)) !== "file") throw new Error(`not a regular file: ${path}`);
	const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
	try {
		return await handle.readFile("utf-8");
	} finally {
		await handle.close();
	}
}

/** F107: writes (creating or truncating) without following a symlink. */
async function writeFileNoFollow(path: string, content: string) {
	const kind = await lstatKind(path);
	if (kind !== "file" && kind !== "missing")
		throw new Error(`refusing to write through ${kind}: ${path}`);
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
		0o644,
	);
	try {
		await handle.writeFile(content, "utf-8");
	} finally {
		await handle.close();
	}
}

async function readTextOrEmpty(path: string) {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return "";
	}
}

async function hashFile(path: string): Promise<string | null> {
	try {
		return await computeChecksum(await readFile(path, "utf-8"), { trimEnd: true });
	} catch {
		return null;
	}
}

function remoteFetch(
	ctx: RelayContext,
	path: string,
	init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<Response> {
	const headers: Record<string, string> = {};
	if (init.body !== undefined) headers["Content-Type"] = "application/json";
	if (ctx.config.apiKey && init.auth !== false) {
		headers.Authorization = `Bearer ${ctx.config.apiKey}`;
	}
	return ctx.fetch(`${ctx.config.remoteUrl}${path}`, {
		method: init.method ?? "GET",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
	});
}

// ── Scopes, status file, drift (D3, D10, D17) ────────────────────────────────

export type ScopeEvaluation = {
	scopes: string[] | null;
	missing: string[];
	hasManage: boolean;
	/** The server didn't say (pre-scope server or unexpected body). */
	degraded: boolean;
};

/** Evaluates a `GET /api/v1/auth/me` body. Never throws. */
export function evaluateScopes(me: unknown): ScopeEvaluation {
	const degraded: ScopeEvaluation = { scopes: null, missing: [], hasManage: false, degraded: true };
	if (!me || typeof me !== "object") return degraded;
	const body = me as { disableAuth?: unknown; authenticated?: unknown; user?: unknown };
	if (body.disableAuth === true) {
		return { scopes: null, missing: [], hasManage: true, degraded: false };
	}
	if (body.authenticated === false) {
		return { scopes: null, missing: [...REQUIRED_SCOPES], hasManage: false, degraded: false };
	}
	const raw = (body.user as { scopes?: unknown } | null | undefined)?.scopes;
	if (!Array.isArray(raw)) return degraded;
	const scopes = raw.filter((s): s is string => typeof s === "string");
	const all = scopes.includes("*");
	const hasManage = all || scopes.includes("manage");
	const missing: string[] = [];
	if (!all && !scopes.includes("ingest")) missing.push("ingest");
	// manage satisfies every observe read (route-scope-policy.ts).
	if (!hasManage && !scopes.includes("observe")) missing.push("observe");
	return { scopes, missing, hasManage, degraded: false };
}

function authWarning(state: RelayState): string | null {
	const a = state.auth;
	if (a.keyRejected) return "key rejected — re-run setup-relay";
	if (a.checkedAt && a.missing.length > 0) {
		return `key lacks ${a.missing.join(" + ")} — re-run setup-relay`;
	}
	return null;
}

/** Every current problem, most important first. */
export function computeWarnings(state: RelayState): string[] {
	const warnings: string[] = [];
	const auth = authWarning(state);
	if (auth) warnings.push(auth);
	if (state.drift.relay === "outdated") warnings.push("relay outdated — re-run setup-relay");
	if (state.drift.statusline === "outdated") {
		warnings.push("statusline outdated — re-run setup-relay");
	}
	return warnings;
}

/** The single line the statusline shows (D17), or null when healthy. */
export function computeStatusLine(state: RelayState): string | null {
	return computeWarnings(state)[0] ?? null;
}

export async function writeStatusFile(ctx: RelayContext) {
	const line = computeStatusLine(ctx.state);
	if (line === ctx.state.statusLineWritten) return;
	try {
		if (line === null) {
			await unlink(ctx.paths.statusFile).catch((err: { code?: string }) => {
				if (err.code !== "ENOENT") throw err;
			});
		} else {
			await ensurePrivateDir(ctx.paths.stateDir);
			await writePrivateFile(ctx.paths.statusFile, `${line}\n`);
		}
		ctx.state.statusLineWritten = line;
	} catch (err) {
		ctx.log(`[relay] couldn't update ${ctx.paths.statusFile}: ${errorMessage(err)}`);
	}
}

function announceAuth(ctx: RelayContext) {
	const line = authWarning(ctx.state);
	if (line === ctx.state.lastAuthLine) return;
	const previous = ctx.state.lastAuthLine;
	ctx.state.lastAuthLine = line;
	if (line) {
		const missing = ctx.state.auth.missing;
		ctx.log("");
		ctx.log(`  ! AgentPulse relay: ${line}`);
		if (missing.includes("observe")) {
			ctx.log("    Codex name sync and CLAUDE.md download are paused until the key can observe.");
		}
		ctx.log(
			'    Fix: Settings → API Keys → mint a key with "Hook ingest" + "Observe (read-only)", then re-run setup-relay.',
		);
		ctx.log("");
	} else if (previous) {
		ctx.log("[relay] API key scopes OK");
	}
}

export async function checkScopesTick(ctx: RelayContext) {
	const auth = ctx.state.auth;
	try {
		const res = await remoteFetch(ctx, "/api/v1/auth/me");
		if (res.status === 401) {
			Object.assign(auth, {
				scopes: null,
				missing: [...REQUIRED_SCOPES],
				hasManage: false,
				degraded: false,
				keyRejected: true,
				checkedAt: iso(ctx.now()),
				lastError: "HTTP 401 from /auth/me",
			});
		} else if (!res.ok) {
			auth.lastError = `HTTP ${res.status} from /auth/me`;
		} else {
			const body: unknown = await res.json().catch(() => null);
			Object.assign(auth, evaluateScopes(body), {
				keyRejected: false,
				checkedAt: iso(ctx.now()),
				lastError: null,
			});
		}
	} catch (err) {
		auth.lastError = errorMessage(err);
	}
	announceAuth(ctx);
	await writeStatusFile(ctx);
}

function compareHash(local: string | null, remote: unknown): DriftStatus {
	if (typeof remote !== "string" || !local) return "unknown";
	return local === remote ? "ok" : "outdated";
}

export async function checkDriftTick(ctx: RelayContext) {
	const state = ctx.state;
	if (!state.relayHash) state.relayHash = (await hashFile(ctx.paths.relayScriptFile)) ?? "";
	let clients: Record<string, unknown> | undefined;
	try {
		const res = await remoteFetch(ctx, "/api/v1/health", { auth: false });
		if (res.ok) {
			const body = (await res.json().catch(() => null)) as { clients?: unknown } | null;
			if (body?.clients && typeof body.clients === "object") {
				clients = body.clients as Record<string, unknown>;
			}
		}
	} catch {
		// Unreachable server: drift stays unknown for this round.
	}
	const installedStatusline = await hashFile(ctx.paths.installedStatuslineFile);
	const previous = `${state.drift.relay}/${state.drift.statusline}`;
	state.drift.relay = compareHash(state.relayHash || null, clients?.relay);
	state.drift.statusline =
		installedStatusline === null
			? "missing"
			: compareHash(installedStatusline, clients?.statusline);
	state.drift.checkedAt = iso(ctx.now());
	if (`${state.drift.relay}/${state.drift.statusline}` !== previous) {
		ctx.log(`[relay] drift: relay ${state.drift.relay}, statusline ${state.drift.statusline}`);
	}
	await writeStatusFile(ctx);
}

function observeMissing(ctx: RelayContext) {
	return ctx.state.auth.checkedAt !== null && ctx.state.auth.missing.includes("observe");
}

/** F106: fails closed — only a confirmed manage-capable key uploads. */
function canUpload(ctx: RelayContext) {
	const a = ctx.state.auth;
	return a.checkedAt !== null && !a.degraded && a.hasManage;
}

function setSyncStatus(
	ctx: RelayContext,
	key: "codexNames" | "claudeMd",
	status: string,
	error: string | null,
) {
	const s = ctx.state.sync[key];
	const previous = s.status;
	s.status = status;
	s.lastError = error;
	if (!error && !status.startsWith("disabled")) s.lastSuccessAt = iso(ctx.now());
	if (previous !== status) {
		ctx.log(`[sync] ${key}: ${status}${error ? ` (${error})` : ""}`);
	}
}

// ── Local request filter and instruction-file guard (D4, D11) ────────────────

export type LocalRequestVerdict =
	| { ok: true }
	| { ok: false; reason: "relay_rejects_browser_requests"; detail: "origin" | "host" };

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/i;

/**
 * Browsers always send Origin on cross-origin POSTs (the literal "null" from
 * sandboxed frames); agents and curl don't. A loopback Host with our exact
 * port defeats DNS rebinding. No path allowlist: same-user processes can read
 * config.json anyway.
 */
export function isAllowedLocalRequest(headers: Headers, port: number): LocalRequestVerdict {
	if (headers.has("origin")) {
		return { ok: false, reason: "relay_rejects_browser_requests", detail: "origin" };
	}
	const match = LOCAL_HOST_RE.exec(headers.get("host") ?? "");
	if (!match || Number(match[2]) !== port) {
		return { ok: false, reason: "relay_rejects_browser_requests", detail: "host" };
	}
	return { ok: true };
}

export type InstructionsPathVerdict =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "path_not_absolute"
				| "path_traversal_rejected"
				| "path_outside_session_cwd"
				| "path_forbidden_directory";
	  };

function hasDotDotSegment(path: string) {
	return path.split(/[\\/]/).includes("..");
}

function isWithin(child: string, parent: string) {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * F106 defense in depth: directories whose CLAUDE.md/AGENTS.md is never
 * synced — $HOME itself, any ancestor of it, and anything under ~/.claude or
 * ~/.codex (agent-global instructions and state). A relative cwd is refused.
 */
export function isForbiddenCwd(cwd: string, home: string): boolean {
	if (!isAbsolute(cwd)) return true;
	const c = resolve(cwd);
	if (c === sep) return true;
	if (!home || !isAbsolute(home)) return false;
	const h = resolve(home);
	return isWithin(h, c) || isWithin(c, join(h, ".claude")) || isWithin(c, join(h, ".codex"));
}

/**
 * The server may only write `<session cwd>/CLAUDE.md` or `AGENTS.md`, compared
 * byte-exactly (no case folding, even on case-insensitive filesystems). The
 * caller passes the cwd this relay itself recorded, never the server's (F106).
 */
export function isSafeInstructionsPath(
	path: string,
	cwd: string,
	home?: string,
): InstructionsPathVerdict {
	if (!isAbsolute(path)) return { ok: false, reason: "path_not_absolute" };
	if (hasDotDotSegment(path) || hasDotDotSegment(cwd)) {
		return { ok: false, reason: "path_traversal_rejected" };
	}
	if (!isAbsolute(cwd) || !INSTRUCTION_FILES.some((name) => path === join(cwd, name))) {
		return { ok: false, reason: "path_outside_session_cwd" };
	}
	if (home !== undefined && isForbiddenCwd(cwd, home)) {
		return { ok: false, reason: "path_forbidden_directory" };
	}
	return { ok: true };
}

/** CLAUDE.md first only for Claude Code (the default agent when unlabeled). */
export function instructionFileOrder(agentType?: string | null): string[] {
	return !agentType || agentType === DEFAULT_AGENT_TYPE
		? ["CLAUDE.md", "AGENTS.md"]
		: ["AGENTS.md", "CLAUDE.md"];
}

// ── CLAUDE.md / AGENTS.md sync (D11, F106, F107) ─────────────────────────────
//
// Only sessions this relay forwarded a hook for are synced, and only in the
// cwd that hook reported (the local session map, persisted under the state
// dir). The server's own `cwd` is never trusted: an ingest key can set it.

function parseLocalSessions(raw: string): Array<[string, LocalSession]> {
	const data = JSON.parse(raw) as { sessions?: Record<string, Partial<LocalSession>> };
	const entries: Array<[string, LocalSession]> = [];
	for (const [id, v] of Object.entries(data?.sessions ?? {})) {
		if (!v || typeof v.cwd !== "string" || !isAbsolute(v.cwd) || hasDotDotSegment(v.cwd)) continue;
		entries.push([
			id,
			{
				cwd: v.cwd,
				agentType: typeof v.agentType === "string" ? v.agentType : null,
				seenAt: typeof v.seenAt === "string" ? v.seenAt : "",
			},
		]);
	}
	return entries.sort((a, b) => a[1].seenAt.localeCompare(b[1].seenAt));
}

function trimLocalSessions(ctx: RelayContext): boolean {
	const map = ctx.state.localSessions;
	let trimmed = false;
	while (map.size > ctx.limits.maxLocalSessions) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
		trimmed = true;
	}
	return trimmed;
}

function persistLocalSessions(ctx: RelayContext): Promise<void> {
	const snapshot = `${JSON.stringify({ version: 1, sessions: Object.fromEntries(ctx.state.localSessions) })}\n`;
	const write = ctx.state.localSessionsWrite.then(async () => {
		try {
			await ensurePrivateDir(ctx.paths.stateDir);
			await replacePrivateFile(ctx.paths.localSessionsFile, snapshot);
		} catch (err) {
			ctx.log(
				`[relay] couldn't save ${ctx.paths.localSessionsFile}: ${logSafe(errorMessage(err))}`,
			);
		}
	});
	ctx.state.localSessionsWrite = write;
	return write;
}

/** Remembers the cwd a hook this relay forwarded reported for a session. */
export async function recordLocalSession(
	ctx: RelayContext,
	sessionId: string,
	cwd: unknown,
	agentType: string | null,
) {
	if (!sessionId || typeof cwd !== "string" || !isAbsolute(cwd) || hasDotDotSegment(cwd)) return;
	const map = ctx.state.localSessions;
	const previous = map.get(sessionId);
	map.delete(sessionId);
	map.set(sessionId, { cwd, agentType, seenAt: iso(ctx.now()) });
	const changed = !previous || previous.cwd !== cwd || previous.agentType !== agentType;
	if (trimLocalSessions(ctx) || changed) await persistLocalSessions(ctx);
}

export async function loadLocalSessions(ctx: RelayContext) {
	let raw: string;
	try {
		raw = await readFile(ctx.paths.localSessionsFile, "utf-8");
	} catch {
		return;
	}
	try {
		for (const [id, entry] of parseLocalSessions(raw)) ctx.state.localSessions.set(id, entry);
		trimLocalSessions(ctx);
	} catch (err) {
		ctx.log(
			`[relay] ignoring unreadable ${ctx.paths.localSessionsFile}: ${logSafe(errorMessage(err))}`,
		);
	}
}

function refuseOnce(ctx: RelayContext, sessionId: string, path: string, reason: string) {
	const key = `${sessionId}\0${path}\0${reason}`;
	if (ctx.state.refusedWrites.has(key)) return;
	ctx.state.refusedWrites.add(key);
	ctx.log(`[sync] Refused ${logSafe(path)} for ${logSafe(sessionId)}: ${reason}`);
}

async function uploadClaudeMd(
	ctx: RelayContext,
	sessionId: string,
	cwd: string,
	agentType?: string | null,
) {
	if (!sessionId || !cwd) return;
	if (isForbiddenCwd(cwd, ctx.paths.home)) {
		refuseOnce(ctx, sessionId, cwd, "path_forbidden_directory");
		return;
	}
	for (const name of instructionFileOrder(agentType)) {
		const filePath = join(cwd, name);
		const kind = await lstatKind(filePath);
		if (kind === "missing") continue;
		if (kind !== "file") {
			refuseOnce(ctx, sessionId, filePath, `refused_${kind}`);
			return;
		}
		try {
			const content = await readFileNoFollow(filePath);
			const checksum = await computeChecksum(content);
			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions/${encodeURIComponent(sessionId)}/claude-md`,
				{
					method: "PUT",
					body: { content, path: filePath, checksum },
				},
			);
			if (res.ok) {
				ctx.log(
					`[sync] Uploaded ${name} for ${logSafe(sessionId)} (${(content.length / 1024).toFixed(1)}KB)`,
				);
			}
		} catch {
			// Retried on the next sync tick while the server has no checksum.
		}
		return;
	}
}

type ClaudeMdSessionRow = {
	sessionId: string;
	cwd?: string | null;
	agentType?: string | null;
	claudeMdPath?: string | null;
	claudeMdChecksum?: string | null;
};

export async function syncClaudeMdTick(ctx: RelayContext) {
	if (observeMissing(ctx)) {
		setSyncStatus(ctx, "claudeMd", "disabled_missing_observe", null);
		return;
	}
	let sessions: ClaudeMdSessionRow[];
	try {
		const res = await remoteFetch(ctx, `/api/v1/sessions?limit=${CLAUDE_MD_SESSION_LIMIT}`);
		if (!res.ok) {
			setSyncStatus(ctx, "claudeMd", "error", `HTTP ${res.status} on GET /sessions`);
			return;
		}
		const data = (await res.json()) as { sessions?: ClaudeMdSessionRow[] };
		sessions = Array.isArray(data.sessions) ? data.sessions : [];
	} catch (err) {
		setSyncStatus(ctx, "claudeMd", "error", errorMessage(err));
		return;
	}

	const upload = canUpload(ctx);
	let error: string | null = null;
	for (const session of sessions) {
		const local = ctx.state.localSessions.get(session.sessionId);
		if (!local) continue;
		try {
			if (session.cwd && session.cwd !== local.cwd) {
				refuseOnce(ctx, session.sessionId, session.cwd, "server_cwd_mismatch");
				continue;
			}
			if (isForbiddenCwd(local.cwd, ctx.paths.home)) {
				refuseOnce(ctx, session.sessionId, local.cwd, "path_forbidden_directory");
				continue;
			}
			if (!session.claudeMdChecksum) {
				if (upload) {
					await uploadClaudeMd(
						ctx,
						session.sessionId,
						local.cwd,
						local.agentType ?? session.agentType,
					);
				}
				continue;
			}
			if (!session.claudeMdPath) continue;
			const lastKnown = ctx.state.localChecksums.get(session.sessionId);
			if (lastKnown === session.claudeMdChecksum) continue;

			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/claude-md`,
			);
			if (!res.ok) {
				error = `HTTP ${res.status} on GET /claude-md`;
				continue;
			}
			const md = (await res.json()) as { content?: string; path?: string; checksum?: string };
			if (!md.content || !md.path || !md.checksum) continue;

			const verdict = isSafeInstructionsPath(md.path, local.cwd, ctx.paths.home);
			if (!verdict.ok) {
				refuseOnce(ctx, session.sessionId, md.path, verdict.reason);
				continue;
			}
			const kind = await lstatKind(md.path);
			if (kind === "symlink" || kind === "other") {
				refuseOnce(ctx, session.sessionId, md.path, `refused_${kind}`);
				continue;
			}

			const localContent = kind === "file" ? await readFileNoFollow(md.path) : "";
			const localChecksum = localContent ? await computeChecksum(localContent) : "";
			if (localChecksum === md.checksum) {
				ctx.state.localChecksums.set(session.sessionId, md.checksum);
				continue;
			}
			if (lastKnown && localChecksum !== lastKnown) {
				ctx.log(`[sync] Conflict on ${logSafe(md.path)} -- server version wins`);
			}
			await writeFileNoFollow(md.path, md.content);
			ctx.state.localChecksums.set(session.sessionId, md.checksum);
			ctx.log(
				`[sync] Wrote ${logSafe(md.path)} from server (${(md.content.length / 1024).toFixed(1)}KB)`,
			);
		} catch (err) {
			error = errorMessage(err);
		}
	}
	setSyncStatus(
		ctx,
		"claudeMd",
		error ? "error" : upload ? "ok" : "upload_disabled_missing_manage",
		error,
	);
}

// ── Codex thread names (D2, D23) ─────────────────────────────────────────────
//
// ~/.codex/session_index.jsonl (or $CODEX_HOME/…) is append-only
// {id, thread_name, updated_at}; the last row per id wins. Codex's /resume
// picker reads it. Every row this relay appends is first recorded in
// <stateDir>/codex-pushed.jsonl (the ledger), so a row can always be told
// apart as AgentPulse-written or Codex-written.
//
// Policy `codex` (default): pull Codex-written names into the dashboard via
// PUT /native-name (a manual dashboard rename still wins, D2); push only
// (a) manual names, (b) names into unnamed threads, (c) restores over our own
// earlier rows. Policy `agentpulse`: never pull; push the dashboard name
// whenever the latest row differs. Every append is capped per id per
// rolling hour (the storm guard, F109), so no id is appended more than 3x/h.

export type CodexIndexRow = { id: string; thread_name: string; updated_at: string };
export type CodexSessionRow = {
	sessionId: string;
	displayName?: string | null;
	nameSource?: string | null;
};

function parseIndexLine(line: string): CodexIndexRow | null {
	if (!line.trim()) return null;
	try {
		const e = JSON.parse(line) as Record<string, unknown>;
		if (typeof e?.id !== "string" || !e.id) return null;
		if (typeof e.thread_name !== "string" || !e.thread_name) return null;
		return {
			id: e.id,
			thread_name: e.thread_name,
			updated_at: typeof e.updated_at === "string" ? e.updated_at : "",
		};
	} catch {
		return null;
	}
}

export function ledgerKey(row: CodexIndexRow): string {
	return JSON.stringify([row.id, row.thread_name, row.updated_at]);
}

/** Malformed ledger lines are skipped; valid ones around them are kept. */
export function parseLedger(raw: string): Set<string> {
	const keys = new Set<string>();
	for (const line of raw.split("\n")) {
		const row = parseIndexLine(line);
		if (row) keys.add(ledgerKey(row));
	}
	return keys;
}

export function parseCodexIndex(
	raw: string,
	ledger: Set<string>,
): { latest: Map<string, CodexIndexRow>; latestForeign: Map<string, CodexIndexRow> } {
	const latest = new Map<string, CodexIndexRow>();
	const latestForeign = new Map<string, CodexIndexRow>();
	for (const line of raw.split("\n")) {
		const row = parseIndexLine(line);
		if (!row) continue;
		latest.set(row.id, row);
		if (!ledger.has(ledgerKey(row))) latestForeign.set(row.id, row);
	}
	return { latest, latestForeign };
}

function shouldPush(
	policy: CodexNamePolicy,
	nameSource: string | null | undefined,
	current: CodexIndexRow | undefined,
	foreign: boolean,
) {
	if (policy === "agentpulse") return true;
	if (nameSource === "user") return true; // (a) a manual name wins
	if (!current) return true; // (b) fill an unnamed thread
	return !foreign; // (c) restore over our own row; never over Codex's
}

/**
 * Pure. Returns the rows to append this tick, the ids the storm guard held
 * back, and the next guard state (push timestamps per id, last hour only).
 */
export function planCodexPushes(
	sessions: CodexSessionRow[],
	latest: Map<string, CodexIndexRow>,
	ledger: Set<string>,
	policy: CodexNamePolicy,
	guard: Record<string, number[]>,
	now: number,
): { rows: CodexIndexRow[]; suppressedIds: string[]; guard: Record<string, number[]> } {
	const nextGuard: Record<string, number[]> = {};
	for (const [id, times] of Object.entries(guard)) {
		const recent = times.filter((t) => now - t < STORM_WINDOW_MS);
		if (recent.length > 0) nextGuard[id] = recent;
	}
	const rows: CodexIndexRow[] = [];
	const suppressedIds: string[] = [];
	const updatedAt = iso(now);
	// F124: offset paging over an activity-ordered list can repeat a row.
	const seen = new Set<string>();
	for (const session of sessions) {
		if (rows.length >= MAX_PUSHES_PER_TICK) break;
		if (!session.sessionId || typeof session.displayName !== "string") continue;
		if (seen.has(session.sessionId)) continue;
		seen.add(session.sessionId);
		const name = sanitizeName(session.displayName);
		if (!name) continue;
		const current = latest.get(session.sessionId);
		if (current?.thread_name === name) continue;
		const foreign = current !== undefined && !ledger.has(ledgerKey(current));
		if (!shouldPush(policy, session.nameSource, current, foreign)) continue;
		const recent = nextGuard[session.sessionId] ?? [];
		if (recent.length >= STORM_MAX_PUSHES) {
			suppressedIds.push(session.sessionId);
			continue;
		}
		nextGuard[session.sessionId] = [...recent, now];
		rows.push({ id: session.sessionId, thread_name: name, updated_at: updatedAt });
	}
	return { rows, suppressedIds, guard: nextGuard };
}

export type CodexIndexSnapshot = {
	ledger: Set<string>;
	ledgerRows: CodexIndexRow[];
	indexKeys: Set<string>;
	latest: Map<string, CodexIndexRow>;
	latestForeign: Map<string, CodexIndexRow>;
};

/** F129: read and parse the index and the ledger once per tick. */
export async function readCodexIndex(ctx: RelayContext): Promise<CodexIndexSnapshot> {
	const ledgerRaw = await readTextOrEmpty(ctx.paths.ledgerFile);
	const indexRaw = await readTextOrEmpty(ctx.paths.codexIndexFile);
	const ledgerRows: CodexIndexRow[] = [];
	for (const line of ledgerRaw.split("\n")) {
		const r = parseIndexLine(line);
		if (r) ledgerRows.push(r);
	}
	const ledger = new Set(ledgerRows.map(ledgerKey));
	const indexKeys = new Set<string>();
	for (const line of indexRaw.split("\n")) {
		const r = parseIndexLine(line);
		if (r) indexKeys.add(ledgerKey(r));
	}
	return { ledger, ledgerRows, indexKeys, ...parseCodexIndex(indexRaw, ledger) };
}

/**
 * F109: the ledger only needs rows that still exist in the index (they're what
 * it classifies). Dropping any row that is still in the index could make one
 * of our own rows look Codex-written, so that is the only compaction done.
 */
async function compactLedgerIfLarge(ctx: RelayContext, snap: CodexIndexSnapshot) {
	if (snap.ledgerRows.length <= ctx.limits.ledgerCompactThreshold) return;
	const kept = snap.ledgerRows.filter((r) => snap.indexKeys.has(ledgerKey(r)));
	await replacePrivateFile(ctx.paths.ledgerFile, kept.length ? jsonlLines(kept) : "");
	ctx.log(`[codex-name-sync] compacted ledger: ${snap.ledgerRows.length} → ${kept.length} rows`);
}

function setPullEntry(ctx: RelayContext, id: string, entry: PullEntryState) {
	const map = ctx.state.codexPull;
	map.delete(id);
	map.set(id, entry);
	while (map.size > MAX_PULL_STATE_ENTRIES) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

async function loadPullState(ctx: RelayContext) {
	ctx.state.pullStateLoaded = true;
	let raw: string;
	try {
		raw = await readFile(ctx.paths.pullStateFile, "utf-8");
	} catch {
		return;
	}
	try {
		const data = JSON.parse(raw) as { entries?: Record<string, Partial<PullEntryState>> };
		for (const [id, e] of Object.entries(data?.entries ?? {})) {
			if (!e || typeof e !== "object") continue;
			setPullEntry(ctx, id, {
				seenKey: typeof e.seenKey === "string" ? e.seenKey : null,
				missKey: typeof e.missKey === "string" ? e.missKey : null,
				missCount: typeof e.missCount === "number" && e.missCount >= 0 ? e.missCount : 0,
			});
		}
	} catch (err) {
		ctx.log(`[codex-name-sync] ignoring unreadable pull state: ${logSafe(errorMessage(err))}`);
	}
}

async function persistPullState(ctx: RelayContext) {
	try {
		await ensurePrivateDir(ctx.paths.stateDir);
		await replacePrivateFile(
			ctx.paths.pullStateFile,
			`${JSON.stringify({ version: 1, entries: Object.fromEntries(ctx.state.codexPull) })}\n`,
		);
	} catch (err) {
		ctx.log(`[codex-name-sync] couldn't save pull state: ${logSafe(errorMessage(err))}`);
	}
}

function retryAfterMs(res: Response, now: number): number {
	const header = res.headers.get("Retry-After");
	let ms = DEFAULT_RETRY_AFTER_MS;
	if (header && /^\d+$/.test(header.trim())) ms = Number(header.trim()) * 1000;
	else if (header && Number.isFinite(Date.parse(header))) ms = Date.parse(header) - now;
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

function isStaleEntry(entry: CodexIndexRow, now: number) {
	const t = Date.parse(entry.updated_at);
	return Number.isFinite(t) && now - t > PULL_STALE_ENTRY_MS;
}

type StepResult = { ok: true; rateLimited?: boolean } | { ok: false; error: string };

/**
 * Codex-written names → PUT /native-name (codex policy only). `applied:false`
 * (a pinned session) counts as seen. Unknown sessions (404) are retried at
 * most 5 times per index entry, or once if the entry is over 24h old, until
 * the entry changes (F18). The seen/miss state is persisted so a restart
 * doesn't re-PUT everything (F125); at most 50 PUTs go out per tick, and a
 * 429 pauses the pull until Retry-After. Any other failure stops the tick.
 */
export async function pullCodexNames(
	ctx: RelayContext,
	snapshot?: CodexIndexSnapshot,
): Promise<StepResult> {
	if (ctx.config.codexNamePolicy !== "codex") return { ok: true };
	if (!ctx.state.pullStateLoaded) await loadPullState(ctx);
	const now = ctx.now();
	if (now < ctx.state.pullRetryAt) return { ok: true, rateLimited: true };
	const { latestForeign } = snapshot ?? (await readCodexIndex(ctx));
	let puts = 0;
	let changed = false;
	let result: StepResult = { ok: true };
	for (const [id, entry] of latestForeign) {
		const key = ledgerKey(entry);
		const st = ctx.state.codexPull.get(id) ?? { seenKey: null, missKey: null, missCount: 0 };
		if (st.seenKey === key) continue;
		if (
			st.missKey === key &&
			(st.missCount >= PULL_MAX_CONSECUTIVE_404 || (isStaleEntry(entry, now) && st.missCount >= 1))
		) {
			continue;
		}
		if (puts >= MAX_PULL_PUTS_PER_TICK) break;
		puts++;
		let res: Response;
		try {
			res = await remoteFetch(ctx, `/api/v1/sessions/${encodeURIComponent(id)}/native-name`, {
				method: "PUT",
				body: { name: entry.thread_name },
			});
		} catch (err) {
			result = { ok: false, error: errorMessage(err) };
			break;
		}
		if (res.ok || res.status === 400) {
			// 400 = the name sanitizes to empty; retrying the same entry can't help.
			setPullEntry(ctx, id, { seenKey: key, missKey: null, missCount: 0 });
			changed = true;
			if (res.ok) {
				ctx.log(
					`[codex-name-sync] pull ${logSafe(id.slice(0, 8))} → ${logSafe(entry.thread_name)}`,
				);
			}
		} else if (res.status === 404) {
			const missCount = st.missKey === key ? st.missCount + 1 : 1;
			setPullEntry(ctx, id, { seenKey: st.seenKey, missKey: key, missCount });
			changed = true;
		} else if (res.status === 429) {
			ctx.state.pullRetryAt = now + retryAfterMs(res, now);
			result = { ok: true, rateLimited: true };
			break;
		} else {
			result = { ok: false, error: `HTTP ${res.status} on PUT /native-name` };
			break;
		}
	}
	if (changed) await persistPullState(ctx);
	return result;
}

async function fetchCodexSessions(
	ctx: RelayContext,
): Promise<{ ok: true; sessions: CodexSessionRow[] } | { ok: false; error: string }> {
	const sessions: CodexSessionRow[] = [];
	try {
		for (let page = 0; page < CODEX_MAX_PAGES; page++) {
			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions?agent_type=codex_cli&limit=${CODEX_PAGE_SIZE}&offset=${page * CODEX_PAGE_SIZE}&fields=${CODEX_LIST_FIELDS}`,
			);
			if (!res.ok) return { ok: false, error: `HTTP ${res.status} on GET /sessions` };
			const data = (await res.json()) as { sessions?: CodexSessionRow[] };
			const rows = Array.isArray(data.sessions) ? data.sessions : [];
			sessions.push(...rows);
			if (rows.length < CODEX_PAGE_SIZE) break;
		}
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
	return { ok: true, sessions };
}

function jsonlLines(rows: CodexIndexRow[]) {
	return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

/** Dashboard names → session_index.jsonl, ledger first (see header). */
export async function pushCodexNames(
	ctx: RelayContext,
	snapshot?: CodexIndexSnapshot,
): Promise<StepResult> {
	const listed = await fetchCodexSessions(ctx);
	if (!listed.ok) return listed;
	const snap = snapshot ?? (await readCodexIndex(ctx));
	const { latest, ledger } = snap;
	try {
		await compactLedgerIfLarge(ctx, snap);
	} catch (err) {
		ctx.log(`[codex-name-sync] ledger compaction failed: ${logSafe(errorMessage(err))}`);
	}
	const plan = planCodexPushes(
		listed.sessions,
		latest,
		ledger,
		ctx.config.codexNamePolicy,
		ctx.state.pushGuard,
		ctx.now(),
	);
	ctx.state.pushGuard = plan.guard;
	ctx.state.sync.codexNames.suppressedIds = plan.suppressedIds;
	for (const id of plan.suppressedIds) {
		if (ctx.state.suppressedLogged.has(id)) continue;
		ctx.state.suppressedLogged.add(id);
		ctx.log(
			`[codex-name-sync] ${logSafe(id.slice(0, 8))} renamed too often; pushes paused for up to an hour`,
		);
	}
	for (const id of ctx.state.suppressedLogged) {
		if (!plan.suppressedIds.includes(id)) ctx.state.suppressedLogged.delete(id);
	}
	if (plan.rows.length === 0) return { ok: true };
	const lines = jsonlLines(plan.rows);
	try {
		// Ledger first: a crash between the two appends leaves an unused ledger
		// row (harmless), never an index row that looks Codex-written.
		await ensurePrivateDir(ctx.paths.stateDir);
		await appendPrivateFile(ctx.paths.ledgerFile, lines);
		await ensurePrivateDir(dirname(ctx.paths.codexIndexFile));
		await appendPrivateFile(ctx.paths.codexIndexFile, lines);
	} catch (err) {
		return { ok: false, error: `append failed: ${errorMessage(err)}` };
	}
	for (const row of plan.rows) {
		ctx.log(`[codex-name-sync] push ${logSafe(row.id.slice(0, 8))} → ${logSafe(row.thread_name)}`);
	}
	return { ok: true };
}

export async function syncCodexNamesTick(ctx: RelayContext) {
	if (observeMissing(ctx)) {
		setSyncStatus(ctx, "codexNames", "disabled_missing_observe", null);
		return;
	}
	const snapshot = await readCodexIndex(ctx);
	const pull = await pullCodexNames(ctx, snapshot);
	const push = await pushCodexNames(ctx, snapshot);
	const error = (!pull.ok && pull.error) || (!push.ok && push.error) || null;
	const status = error
		? "error"
		: pull.ok && pull.rateLimited
			? "rate_limited"
			: ctx.state.sync.codexNames.suppressedIds.length > 0
				? "push_suppressed"
				: "ok";
	setSyncStatus(ctx, "codexNames", status, error);
}

// ── Hook queue and forwarding ────────────────────────────────────────────────

type HookQueueItem = {
	id: string;
	pathname: string;
	search: string;
	method: string;
	contentType: string;
	agentType: string | null;
	body: string;
	createdAt: string;
	attempts: number;
	nextAttemptAt: string;
	lastError: string | null;
};

export type ForwardVerdict = "delivered" | "retry" | "drop";

/** 2xx delivered; auth, timeout, rate-limit and server errors retry; other 4xx drop. */
export function classifyForwardStatus(status: number): ForwardVerdict {
	if (status >= 200 && status < 300) return "delivered";
	if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
		return "retry";
	}
	return "drop";
}

function agentKey(header: string | null): string {
	const value = (header ?? "").trim().toLowerCase();
	if (!value) return DEFAULT_AGENT_TYPE;
	return /^[a-z0-9_]{1,32}$/.test(value) ? value : "unknown";
}

async function ensureQueueDirs(ctx: RelayContext) {
	await ensurePrivateDir(ctx.paths.hookPendingDir);
	await ensurePrivateDir(ctx.paths.hookProcessingDir);
}

/**
 * F122: pending files are named `<enqueue ms>-<uuid>.json`, so the name order
 * is the age order. Drops everything past the max age, then the oldest past
 * the max count, with one log line per drop.
 */
async function enforceQueueLimits(ctx: RelayContext) {
	const names = (await readdir(ctx.paths.hookPendingDir)).filter((n) => n.endsWith(".json")).sort();
	const cutoff = ctx.now() - ctx.limits.maxQueueAgeMs;
	const drop: string[] = [];
	const keep: string[] = [];
	for (const name of names) {
		const enqueuedAt = Number(name.split("-")[0]);
		if (Number.isFinite(enqueuedAt) && enqueuedAt < cutoff) drop.push(name);
		else keep.push(name);
	}
	const overflow = keep.length - ctx.limits.maxQueueFiles;
	if (overflow > 0) drop.push(...keep.slice(0, overflow));
	if (drop.length === 0) return;
	for (const name of drop) {
		try {
			await unlink(join(ctx.paths.hookPendingDir, name));
		} catch {}
	}
	ctx.state.queue.dropped += drop.length;
	ctx.log(
		`[relay] dropped ${drop.length} queued hook(s): the queue keeps at most ${ctx.limits.maxQueueFiles} files, none older than ${Math.round(ctx.limits.maxQueueAgeMs / 3_600_000)}h`,
	);
}

async function forwardApiRequest(
	ctx: RelayContext,
	input: {
		pathname: string;
		search: string;
		method: string;
		contentType: string;
		agentType?: string | null;
		body?: string;
	},
) {
	const headers = new Headers();
	headers.set("Content-Type", input.contentType || "application/json");
	if (ctx.config.apiKey) headers.set("Authorization", `Bearer ${ctx.config.apiKey}`);
	if (input.agentType) headers.set("X-Agent-Type", input.agentType);

	const response = await ctx.fetch(`${ctx.config.remoteUrl}${input.pathname}${input.search}`, {
		method: input.method,
		headers,
		body: input.method !== "GET" ? input.body : undefined,
		signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
	});

	return new Response(await response.text(), {
		status: response.status,
		headers: {
			"Content-Type": response.headers.get("Content-Type") || "application/json",
		},
	});
}

function nextBackoffMs(attempts: number) {
	return Math.min(HOOK_RETRY_MAX_MS, HOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function scheduleQueue(ctx: RelayContext, delayMs = 0) {
	if (!ctx.autoSchedule) return;
	if (ctx.state.queueTimer) clearTimeout(ctx.state.queueTimer);
	ctx.state.queueTimer = setTimeout(() => {
		ctx.state.queueTimer = null;
		void processHookQueue(ctx);
	}, delayMs);
}

async function enqueueHook(ctx: RelayContext, req: Request, url: URL) {
	await ensureQueueDirs(ctx);
	const body = await req.text();
	const createdAt = iso(ctx.now());
	const item: HookQueueItem = {
		id: crypto.randomUUID(),
		pathname: url.pathname,
		search: url.search,
		method: req.method,
		contentType: req.headers.get("Content-Type") || "application/json",
		agentType: req.headers.get("X-Agent-Type"),
		body,
		createdAt,
		attempts: 0,
		nextAttemptAt: createdAt,
		lastError: null,
	};

	await writePrivateFile(
		join(ctx.paths.hookPendingDir, `${ctx.now()}-${item.id}.json`),
		JSON.stringify(item),
	);
	ctx.state.queue.lastHookEnqueuedAt = createdAt;
	ctx.state.lastEventAtByAgent[agentKey(item.agentType)] = createdAt;
	await enforceQueueLimits(ctx);
	scheduleQueue(ctx);

	try {
		const payload = JSON.parse(body) as {
			hook_event_name?: string;
			session_id?: string;
			cwd?: string;
		};
		// F106: the only source of the cwds CLAUDE.md sync may touch.
		if (typeof payload.session_id === "string" && payload.cwd) {
			await recordLocalSession(ctx, payload.session_id, payload.cwd, agentKey(item.agentType));
		}
		if (
			url.pathname === "/api/v1/hooks" &&
			payload.hook_event_name === "SessionStart" &&
			payload.cwd &&
			canUpload(ctx)
		) {
			void uploadClaudeMd(ctx, payload.session_id || "", payload.cwd, item.agentType);
		}
	} catch {
		// Not JSON: nothing to upload.
	}

	return { queued: true, queueId: item.id };
}

async function leaseNextHook(
	ctx: RelayContext,
): Promise<{ fileName: string; item: HookQueueItem } | null> {
	await ensureQueueDirs(ctx);
	const fileNames = (await readdir(ctx.paths.hookPendingDir))
		.filter((name) => name.endsWith(".json"))
		.sort();
	const now = Date.now();

	for (const fileName of fileNames) {
		const pendingPath = join(ctx.paths.hookPendingDir, fileName);
		try {
			const item = JSON.parse(await readFile(pendingPath, "utf-8")) as HookQueueItem;
			if (Date.parse(item.nextAttemptAt) > now) continue;
			await rename(pendingPath, join(ctx.paths.hookProcessingDir, fileName));
			return { fileName, item };
		} catch (error) {
			ctx.log(`[relay] Failed to lease queued hook: ${errorMessage(error)}`);
			try {
				await unlink(pendingPath);
			} catch {}
		}
	}

	return null;
}

async function releaseHookFailure(
	ctx: RelayContext,
	fileName: string,
	item: HookQueueItem,
	message: string,
) {
	const updated: HookQueueItem = {
		...item,
		attempts: item.attempts + 1,
		lastError: message,
		nextAttemptAt: new Date(Date.now() + nextBackoffMs(item.attempts + 1)).toISOString(),
	};

	try {
		await writePrivateFile(join(ctx.paths.hookPendingDir, fileName), JSON.stringify(updated));
	} finally {
		try {
			await unlink(join(ctx.paths.hookProcessingDir, fileName));
		} catch {}
	}

	const q = ctx.state.queue;
	q.lastHookFailureAt = iso(ctx.now());
	q.lastHookError = message;
	q.consecutiveHookFailures += 1;
	ctx.log(`[relay] Hook forward failed (${updated.attempts} attempts): ${message}`);
	scheduleQueue(ctx, nextBackoffMs(updated.attempts));
}

async function dropHook(ctx: RelayContext, fileName: string, status: number) {
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}
	const q = ctx.state.queue;
	q.lastHookFailureAt = iso(ctx.now());
	q.lastHookError = `dropped: HTTP ${status}`;
	q.consecutiveHookFailures += 1;
	ctx.log(`[relay] Dropped hook the server rejected (HTTP ${status})`);
}

async function completeHookSuccess(ctx: RelayContext, fileName: string) {
	try {
		await unlink(join(ctx.paths.hookProcessingDir, fileName));
	} catch {}
	const q = ctx.state.queue;
	q.lastHookForwardedAt = iso(ctx.now());
	q.lastHookError = null;
	q.consecutiveHookFailures = 0;
}

export async function processHookQueue(ctx: RelayContext) {
	if (ctx.state.queueRunning) return;
	ctx.state.queueRunning = true;
	try {
		while (true) {
			const leased = await leaseNextHook(ctx);
			if (!leased) break;
			try {
				const res = await forwardApiRequest(ctx, leased.item);
				const verdict = classifyForwardStatus(res.status);
				if (verdict === "delivered") await completeHookSuccess(ctx, leased.fileName);
				else if (verdict === "retry") {
					await releaseHookFailure(ctx, leased.fileName, leased.item, `HTTP ${res.status}`);
				} else await dropHook(ctx, leased.fileName, res.status);
			} catch (error) {
				await releaseHookFailure(ctx, leased.fileName, leased.item, errorMessage(error));
			}
		}
	} finally {
		ctx.state.queueRunning = false;
	}
}

export async function getQueueDiagnostics(ctx: RelayContext) {
	await ensureQueueDirs(ctx);
	const pending = (await readdir(ctx.paths.hookPendingDir)).filter((n) => n.endsWith(".json"));
	const processing = (await readdir(ctx.paths.hookProcessingDir)).filter((n) =>
		n.endsWith(".json"),
	);
	let oldestPendingAt: string | null = null;
	for (const fileName of pending) {
		try {
			const item = JSON.parse(
				await readFile(join(ctx.paths.hookPendingDir, fileName), "utf-8"),
			) as HookQueueItem;
			if (!oldestPendingAt || item.createdAt < oldestPendingAt) oldestPendingAt = item.createdAt;
		} catch {}
	}
	const q = ctx.state.queue;
	return {
		pending: pending.length,
		processing: processing.length,
		oldestPendingAt,
		lastHookEnqueuedAt: q.lastHookEnqueuedAt,
		lastHookForwardedAt: q.lastHookForwardedAt,
		lastHookFailureAt: q.lastHookFailureAt,
		lastHookError: q.lastHookError,
		consecutiveHookFailures: q.consecutiveHookFailures,
		dropped: q.dropped,
	};
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

/** Additive over the pre-Phase-3 shape {status, relay, remote, queue} (F34). */
export async function buildDiagnostics(ctx: RelayContext) {
	const { auth, sync, drift } = ctx.state;
	return {
		status: "ok",
		relay: true,
		remote: ctx.config.remoteUrl,
		queue: await getQueueDiagnostics(ctx),
		auth: {
			scopes: auth.scopes,
			missing: auth.missing,
			hasManage: auth.hasManage,
			checkedAt: auth.checkedAt,
			degraded: auth.degraded,
			keyRejected: auth.keyRejected,
			lastError: auth.lastError === null ? null : logSafe(auth.lastError),
		},
		sync: {
			codexNames: {
				status: sync.codexNames.status,
				lastError: sync.codexNames.lastError,
				lastSuccessAt: sync.codexNames.lastSuccessAt,
				policy: ctx.config.codexNamePolicy,
				suppressedIds: sync.codexNames.suppressedIds,
			},
			claudeMd: {
				status: sync.claudeMd.status,
				lastError: sync.claudeMd.lastError,
				lastSuccessAt: sync.claudeMd.lastSuccessAt,
			},
		},
		drift: { relay: drift.relay, statusline: drift.statusline },
		relayHash: ctx.state.relayHash,
		agents: Object.fromEntries(
			Object.entries(ctx.state.lastEventAtByAgent).map(([agent, lastEventAt]) => [
				agent,
				{ lastEventAt },
			]),
		),
	};
}

const SESSION_DETAIL_PATH_RE = /^\/api\/v1\/sessions\/[^/]+$/;
const NATIVE_NAME_PATH_RE = /^\/api\/v1\/sessions\/[^/]+\/native-name$/;

/**
 * F108: the proxy lends the relay's API key to any local process, so it
 * forwards only what local producers need: hooks, the statusline's session
 * lookup, and its native-name push.
 */
export function isForwardAllowed(method: string, pathname: string): boolean {
	if (pathname === "/api/v1/hooks" || pathname.startsWith("/api/v1/hooks/")) return true;
	const m = method.toUpperCase();
	if (m === "GET" && SESSION_DETAIL_PATH_RE.test(pathname)) return true;
	if (m === "PUT" && NATIVE_NAME_PATH_RE.test(pathname)) return true;
	return false;
}

/** F111: plain http:// to anything but loopback sends the key in the clear. */
export function isInsecureRemote(remoteUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(remoteUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "http:") return false;
	const host = url.hostname.toLowerCase();
	return !(host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host));
}

function startupWarnings(ctx: RelayContext) {
	if (isInsecureRemote(ctx.config.remoteUrl)) {
		ctx.log(
			"[relay] warning: the remote uses plain http:// to a non-loopback host; the API key and hook payloads travel unencrypted",
		);
	}
	// F126: statusline.sh reads ${AGENTPULSE_DIR:-$HOME/.agentpulse}/status.
	const home = ctx.paths.home;
	if (home && resolve(ctx.paths.stateDir) !== resolve(join(home, ".agentpulse"))) {
		ctx.log(
			`[relay] statusline: this relay's status file is ${ctx.paths.statusFile}; run Claude with AGENTPULSE_DIR=${ctx.paths.stateDir} so the statusline shows its hints`,
		);
	}
}

export function createFetchHandler(ctx: RelayContext) {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const verdict = isAllowedLocalRequest(req.headers, ctx.port);
		if (!verdict.ok) {
			ctx.log(
				`[relay] 403 ${verdict.reason} (${verdict.detail}) ${logSafe(req.method)} ${logSafe(url.pathname)}`,
			);
			return Response.json({ error: verdict.reason }, { status: 403 });
		}

		if (url.pathname === "/api/v1/health") {
			return Response.json({
				status: "ok",
				relay: true,
				remote: ctx.config.remoteUrl,
				warnings: computeWarnings(ctx.state),
			});
		}

		if (url.pathname === "/api/v1/relay/diagnostics") {
			return Response.json(await buildDiagnostics(ctx));
		}

		if (url.pathname.startsWith("/api/v1/hooks")) {
			const queued = await enqueueHook(ctx, req, url);
			return Response.json({ ok: true, relayed: false, ...queued });
		}

		if (url.pathname.startsWith("/api/")) {
			if (!isForwardAllowed(req.method, url.pathname)) {
				ctx.log(
					`[relay] 403 relay_path_not_allowed ${logSafe(req.method)} ${logSafe(url.pathname)}`,
				);
				return Response.json({ error: "relay_path_not_allowed" }, { status: 403 });
			}
			try {
				return await forwardApiRequest(ctx, {
					pathname: url.pathname,
					search: url.search,
					method: req.method,
					contentType: req.headers.get("Content-Type") || "application/json",
					agentType: req.headers.get("X-Agent-Type"),
					body: req.method !== "GET" ? await req.text() : undefined,
				});
			} catch {
				return Response.json({ error: "Relay failed" }, { status: 502 });
			}
		}

		return Response.json({
			message: "AgentPulse Relay",
			dashboard: ctx.config.remoteUrl,
			hint: `Open ${ctx.config.remoteUrl} in your browser for the dashboard`,
		});
	};
}

/** Runs `tick` every `ms`, skipping a round while the previous one is still running. */
function everyExclusive(ctx: RelayContext, ms: number, tick: (ctx: RelayContext) => Promise<void>) {
	let busy = false;
	return setInterval(() => {
		if (busy) return;
		busy = true;
		tick(ctx)
			.catch((err) => ctx.log(`[relay] background task failed: ${errorMessage(err)}`))
			.finally(() => {
				busy = false;
			});
	}, ms);
}

export async function startRelay(
	config: RelayConfig,
	opts: ContextOptions & { timers?: boolean; syncMs?: number } = {},
) {
	const timers = opts.timers ?? true;
	const ctx = createRelayContext(config, opts);
	ctx.autoSchedule = timers;
	await ensureQueueDirs(ctx);
	await loadLocalSessions(ctx);
	ctx.state.relayHash = (await hashFile(ctx.paths.relayScriptFile)) ?? "";
	startupWarnings(ctx);

	const handler = createFetchHandler(ctx);
	const server = Bun.serve({
		port: config.port,
		hostname: "127.0.0.1",
		idleTimeout: RELAY_IDLE_TIMEOUT_S,
		fetch: handler,
	});
	ctx.port = server.port ?? config.port;

	const intervals: ReturnType<typeof setInterval>[] = [];
	let stopped = false;
	let ready: Promise<void> = Promise.resolve();
	if (timers) {
		const syncMs = opts.syncMs ?? DEFAULT_SYNC_MS;
		intervals.push(
			setInterval(() => {
				void enforceQueueLimits(ctx)
					.catch(() => {})
					.then(() => processHookQueue(ctx));
			}, HOOK_RETRY_POLL_MS),
		);
		scheduleQueue(ctx, 250);
		// Scopes first, so the first sync round already knows what it may do.
		ready = (async () => {
			await checkScopesTick(ctx);
			await checkDriftTick(ctx);
			if (stopped) return;
			intervals.push(
				everyExclusive(ctx, SCOPE_CHECK_MS, checkScopesTick),
				everyExclusive(ctx, DRIFT_CHECK_MS, checkDriftTick),
				everyExclusive(ctx, syncMs, syncClaudeMdTick),
				everyExclusive(ctx, syncMs, syncCodexNamesTick),
			);
		})();
	}

	return {
		ctx,
		server,
		port: ctx.port,
		handler,
		ready,
		stop() {
			stopped = true;
			for (const interval of intervals) clearInterval(interval);
			if (ctx.state.queueTimer) clearTimeout(ctx.state.queueTimer);
			server.stop(true);
		},
	};
}

function parseSyncMs(raw: string | undefined) {
	const n = Number(raw);
	return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_MS;
}

async function main(argv: string[]) {
	const configPath = findConfigPath(argv);
	let fileConfig: RelayFileConfig = {};
	if (configPath) {
		try {
			fileConfig = await loadConfigFile(configPath);
		} catch (err) {
			console.error(`relay: can't read ${configPath}: ${errorMessage(err)}`);
			process.exit(1);
		}
	}
	const parsed = parseArgs(argv, fileConfig, {
		agentpulseDir: process.env.AGENTPULSE_DIR || undefined,
		scriptDir: import.meta.dir,
	});
	if (!parsed.ok) {
		console.error(`relay: ${parsed.error}`);
		console.error(USAGE);
		process.exit(1);
	}
	const syncMs = parseSyncMs(process.env.AGENTPULSE_RELAY_SYNC_MS);
	const relay = await startRelay(parsed.config, { syncMs });
	const { config } = relay.ctx;
	const seconds = `${Math.round(syncMs / 100) / 10}s`;

	console.log("");
	console.log("  AgentPulse Relay");
	console.log("  ────────────────");
	console.log(`  Local:     http://localhost:${relay.port} (hook forwarding)`);
	console.log(`  Remote:    ${config.remoteUrl} (dashboard)`);
	console.log(`  State:     ${config.stateDir}`);
	console.log("  Queue:     disk-backed hook queue with background retry");
	console.log(
		`  Sync:      CLAUDE.md every ${seconds} · Codex thread names every ${seconds} (policy: ${config.codexNamePolicy})`,
	);
	console.log(`  Auth:      ${config.apiKey ? "API key" : "none"}`);
	console.log("");
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(`relay: ${errorMessage(err)}`);
		process.exit(1);
	});
}
