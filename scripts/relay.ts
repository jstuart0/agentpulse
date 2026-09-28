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
	access,
	appendFile,
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

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
const MAX_PUSHES_PER_TICK = CODEX_PAGE_SIZE * CODEX_MAX_PAGES;
const STORM_WINDOW_MS = 60 * 60_000;
const STORM_MAX_REPUSHES = 3;
const PULL_MAX_CONSECUTIVE_404 = 5;
const PULL_STALE_ENTRY_MS = 24 * 60 * 60_000;
const CLAUDE_MD_SESSION_LIMIT = 20;
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

export function createRelayState() {
	return {
		queue: {
			lastHookEnqueuedAt: null as string | null,
			lastHookForwardedAt: null as string | null,
			lastHookFailureAt: null as string | null,
			lastHookError: null as string | null,
			consecutiveHookFailures: 0,
		},
		lastEventAtByAgent: {} as Record<string, string>,
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
};

type ContextOptions = {
	env?: { HOME?: string; CODEX_HOME?: string };
	scriptPath?: string;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (line: string) => void;
	state?: RelayState;
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
	};
}

// ── Small helpers ────────────────────────────────────────────────────────────

function iso(ms: number) {
	return new Date(ms).toISOString();
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

async function fileExists(path: string) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
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
			await mkdir(ctx.paths.stateDir, { recursive: true });
			await writeFile(ctx.paths.statusFile, `${line}\n`, "utf-8");
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

function canUpload(ctx: RelayContext) {
	const a = ctx.state.auth;
	return a.checkedAt === null || a.degraded || a.hasManage;
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
			reason: "path_not_absolute" | "path_traversal_rejected" | "path_outside_session_cwd";
	  };

function hasDotDotSegment(path: string) {
	return path.split(/[\\/]/).includes("..");
}

/**
 * The server may only write `<session cwd>/CLAUDE.md` or `AGENTS.md`, compared
 * byte-exactly (no case folding, even on case-insensitive filesystems).
 */
export function isSafeInstructionsPath(path: string, cwd: string): InstructionsPathVerdict {
	if (!isAbsolute(path)) return { ok: false, reason: "path_not_absolute" };
	if (hasDotDotSegment(path) || hasDotDotSegment(cwd)) {
		return { ok: false, reason: "path_traversal_rejected" };
	}
	if (!isAbsolute(cwd) || !INSTRUCTION_FILES.some((name) => path === join(cwd, name))) {
		return { ok: false, reason: "path_outside_session_cwd" };
	}
	return { ok: true };
}

/** CLAUDE.md first only for Claude Code (the default agent when unlabeled). */
export function instructionFileOrder(agentType?: string | null): string[] {
	return !agentType || agentType === DEFAULT_AGENT_TYPE
		? ["CLAUDE.md", "AGENTS.md"]
		: ["AGENTS.md", "CLAUDE.md"];
}

// ── CLAUDE.md / AGENTS.md sync (D11) ─────────────────────────────────────────

async function uploadClaudeMd(
	ctx: RelayContext,
	sessionId: string,
	cwd: string,
	agentType?: string | null,
) {
	if (!sessionId || !cwd) return;
	for (const name of instructionFileOrder(agentType)) {
		const filePath = join(cwd, name);
		if (!(await fileExists(filePath))) continue;
		try {
			const content = await readFile(filePath, "utf-8");
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
					`[sync] Uploaded ${name} for ${sessionId} (${(content.length / 1024).toFixed(1)}KB)`,
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
		try {
			if (!session.claudeMdChecksum && session.cwd) {
				if (upload) await uploadClaudeMd(ctx, session.sessionId, session.cwd, session.agentType);
				continue;
			}
			if (!session.claudeMdPath || !session.claudeMdChecksum) continue;
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

			const verdict = isSafeInstructionsPath(md.path, session.cwd ?? "");
			if (!verdict.ok) {
				const key = `${session.sessionId}\0${md.path}\0${verdict.reason}`;
				if (!ctx.state.refusedWrites.has(key)) {
					ctx.state.refusedWrites.add(key);
					ctx.log(`[sync] Refused to write ${md.path}: ${verdict.reason}`);
				}
				continue;
			}

			const localContent = await readTextOrEmpty(md.path);
			const localChecksum = localContent ? await computeChecksum(localContent) : "";
			if (localChecksum === md.checksum) {
				ctx.state.localChecksums.set(session.sessionId, md.checksum);
				continue;
			}
			if (lastKnown && localChecksum !== lastKnown) {
				ctx.log(`[sync] Conflict on ${md.path} -- server version wins`);
			}
			await writeFile(md.path, md.content, "utf-8");
			ctx.state.localChecksums.set(session.sessionId, md.checksum);
			ctx.log(`[sync] Wrote ${md.path} from server (${(md.content.length / 1024).toFixed(1)}KB)`);
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
// whenever the latest row differs. Re-pushes over Codex-written rows are
// capped per id per rolling hour (the storm guard).

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
	for (const session of sessions) {
		if (rows.length >= MAX_PUSHES_PER_TICK) break;
		if (!session.sessionId || typeof session.displayName !== "string") continue;
		const name = sanitizeName(session.displayName);
		if (!name) continue;
		const current = latest.get(session.sessionId);
		if (current?.thread_name === name) continue;
		const foreign = current !== undefined && !ledger.has(ledgerKey(current));
		if (!shouldPush(policy, session.nameSource, current, foreign)) continue;
		if (foreign) {
			const recent = nextGuard[session.sessionId] ?? [];
			if (recent.length >= STORM_MAX_REPUSHES) {
				suppressedIds.push(session.sessionId);
				continue;
			}
			nextGuard[session.sessionId] = [...recent, now];
		}
		rows.push({ id: session.sessionId, thread_name: name, updated_at: updatedAt });
	}
	return { rows, suppressedIds, guard: nextGuard };
}

async function readCodexIndex(ctx: RelayContext) {
	const ledger = parseLedger(await readTextOrEmpty(ctx.paths.ledgerFile));
	return { ledger, ...parseCodexIndex(await readTextOrEmpty(ctx.paths.codexIndexFile), ledger) };
}

function isStaleEntry(entry: CodexIndexRow, now: number) {
	const t = Date.parse(entry.updated_at);
	return Number.isFinite(t) && now - t > PULL_STALE_ENTRY_MS;
}

type StepResult = { ok: true } | { ok: false; error: string };

/**
 * Codex-written names → PUT /native-name (codex policy only). `applied:false`
 * (a pinned session) counts as seen. Unknown sessions (404) are retried at
 * most 5 times per index entry, or once if the entry is over 24h old, until
 * the entry changes (F18). Any other failure stops the tick.
 */
export async function pullCodexNames(ctx: RelayContext): Promise<StepResult> {
	if (ctx.config.codexNamePolicy !== "codex") return { ok: true };
	const { latestForeign } = await readCodexIndex(ctx);
	const now = ctx.now();
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
		let res: Response;
		try {
			res = await remoteFetch(ctx, `/api/v1/sessions/${encodeURIComponent(id)}/native-name`, {
				method: "PUT",
				body: { name: entry.thread_name },
			});
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
		if (res.ok || res.status === 400) {
			// 400 = the name sanitizes to empty; retrying the same entry can't help.
			ctx.state.codexPull.set(id, { seenKey: key, missKey: null, missCount: 0 });
			if (res.ok) ctx.log(`[codex-name-sync] pull ${id.slice(0, 8)} → ${entry.thread_name}`);
		} else if (res.status === 404) {
			const missCount = st.missKey === key ? st.missCount + 1 : 1;
			ctx.state.codexPull.set(id, { seenKey: st.seenKey, missKey: key, missCount });
		} else {
			return { ok: false, error: `HTTP ${res.status} on PUT /native-name` };
		}
	}
	return { ok: true };
}

async function fetchCodexSessions(
	ctx: RelayContext,
): Promise<{ ok: true; sessions: CodexSessionRow[] } | { ok: false; error: string }> {
	const sessions: CodexSessionRow[] = [];
	try {
		for (let page = 0; page < CODEX_MAX_PAGES; page++) {
			const res = await remoteFetch(
				ctx,
				`/api/v1/sessions?agent_type=codex_cli&limit=${CODEX_PAGE_SIZE}&offset=${page * CODEX_PAGE_SIZE}`,
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
export async function pushCodexNames(ctx: RelayContext): Promise<StepResult> {
	const listed = await fetchCodexSessions(ctx);
	if (!listed.ok) return listed;
	const { latest, ledger } = await readCodexIndex(ctx);
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
			`[codex-name-sync] ${id.slice(0, 8)} keeps being retitled in Codex; pushes paused for up to an hour`,
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
		await mkdir(ctx.paths.stateDir, { recursive: true });
		await appendFile(ctx.paths.ledgerFile, lines, "utf-8");
		await mkdir(dirname(ctx.paths.codexIndexFile), { recursive: true });
		await appendFile(ctx.paths.codexIndexFile, lines, "utf-8");
	} catch (err) {
		return { ok: false, error: `append failed: ${errorMessage(err)}` };
	}
	for (const row of plan.rows) {
		ctx.log(`[codex-name-sync] push ${row.id.slice(0, 8)} → ${row.thread_name}`);
	}
	return { ok: true };
}

export async function syncCodexNamesTick(ctx: RelayContext) {
	if (observeMissing(ctx)) {
		setSyncStatus(ctx, "codexNames", "disabled_missing_observe", null);
		return;
	}
	const pull = await pullCodexNames(ctx);
	const push = await pushCodexNames(ctx);
	const error = (!pull.ok && pull.error) || (!push.ok && push.error) || null;
	const status = error
		? "error"
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
	await mkdir(ctx.paths.hookPendingDir, { recursive: true });
	await mkdir(ctx.paths.hookProcessingDir, { recursive: true });
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

	await writeFile(
		join(ctx.paths.hookPendingDir, `${Date.now()}-${item.id}.json`),
		JSON.stringify(item),
		"utf-8",
	);
	ctx.state.queue.lastHookEnqueuedAt = createdAt;
	ctx.state.lastEventAtByAgent[agentKey(item.agentType)] = createdAt;
	scheduleQueue(ctx);

	try {
		const payload = JSON.parse(body) as {
			hook_event_name?: string;
			session_id?: string;
			cwd?: string;
		};
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
		await writeFile(join(ctx.paths.hookPendingDir, fileName), JSON.stringify(updated), "utf-8");
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

export function createFetchHandler(ctx: RelayContext) {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const verdict = isAllowedLocalRequest(req.headers, ctx.port);
		if (!verdict.ok) {
			ctx.log(`[relay] 403 ${verdict.reason} (${verdict.detail}) ${req.method} ${url.pathname}`);
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
	ctx.state.relayHash = (await hashFile(ctx.paths.relayScriptFile)) ?? "";

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
		intervals.push(setInterval(() => void processHookQueue(ctx), HOOK_RETRY_POLL_MS));
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
