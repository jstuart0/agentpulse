import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LoadExcludeRulesResult, evaluateExclusion } from "../../shared/exclude-rules.js";
import {
	CODEX_NATIVE_MARKER_DIR,
	DELIVERY_ID_HEADER,
	ORIGIN_CODEX_OBSERVER,
	ORIGIN_HEADER,
} from "../../shared/hook-headers.js";

const CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
const STATE_FILE = join(homedir(), ".agentpulse", "codex-observer-state.json");
const SCAN_INTERVAL_MS = 5_000;
// Eviction (Decision 19) runs at most once an hour, from inside the 5s scan
// loop. Not unit-tested directly — evictNativeMarkers (the pure function it
// calls) is.
const EVICTION_INTERVAL_MS = 60 * 60 * 1000;
// Default: only today's rollouts (UTC). Set AGENTPULSE_CODEX_BACKFILL_DAYS
// to 1+ to include older days at first scan. A large backfill against a
// cold dashboard can emit thousands of events in a burst, so it's opt-in.
const BACKFILL_DAYS = Math.max(
	0,
	Number.parseInt(process.env.AGENTPULSE_CODEX_BACKFILL_DAYS ?? "0", 10) || 0,
);
// The observer only ever tails today's files plus BACKFILL_DAYS, so a
// marker older than that plus a small margin is safe to evict.
const NATIVE_MARKER_MAX_AGE_MS = (BACKFILL_DAYS + 2) * 24 * 60 * 60 * 1000;

export type FileState = {
	offset: number;
	sessionId: string;
	/** The directory the session is in, from the latest session_meta; null = looked for and not found, undefined = never looked. Never kept for an excluded session. */
	cwd?: string | null;
	/** Set once the directory was covered by an exclude rule; never cleared. The only thing kept about such a session besides where its file was read to. */
	excluded?: boolean;
};
export type ObserverState = { files: Record<string, FileState> };

export function loadState(path: string = STATE_FILE): ObserverState {
	try {
		if (!existsSync(path)) return { files: {} };
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { files?: Record<string, unknown> };
		if (!parsed || typeof parsed !== "object" || !parsed.files) return { files: {} };
		const files: Record<string, FileState> = {};
		for (const [file, entry] of Object.entries(parsed.files)) {
			const clean = sanitizeEntry(entry);
			if (clean) files[file] = clean;
		}
		return { files };
	} catch {
		return { files: {} };
	}
}

/** An entry from before the directory and exclusion fields has neither; one with a field of the wrong type loses just that field. */
function sanitizeEntry(entry: unknown): FileState | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, unknown>;
	if (typeof e.offset !== "number" || !Number.isFinite(e.offset) || e.offset < 0) return null;
	if (typeof e.sessionId !== "string") return null;
	const clean: FileState = { offset: e.offset, sessionId: e.sessionId };
	if (typeof e.cwd === "string" || e.cwd === null) clean.cwd = e.cwd;
	if (e.excluded === true) clean.excluded = true;
	return clean;
}

let warnedPlantedTmpPath = false;

/** Reset for tests only — the once-per-process planted-tmp-path warning. */
export function _resetSaveStateWarnForTest(): void {
	warnedPlantedTmpPath = false;
}

/**
 * Atomic write (F43 / F73 seam): write to a fresh, randomly-suffixed tmp
 * path, then rename over `path`. renameSync is atomic on the same
 * filesystem, so a crash mid-write never leaves a half-written state file —
 * readers see either the old state or the new one, never a torn one. `path`
 * is injectable for tests (O9); `tmpPath` is injectable too, only for
 * exercising the collision-refusal branch deterministically (F107) —
 * production callers use the default STATE_FILE and let the random suffix
 * be generated.
 *
 * F107 (closes F101's residual TOCTOU): F101's lstat-then-write check still
 * had a window between the check and the write where an attacker could
 * plant a symlink. Writing with `{ flag: "wx" }` (O_CREAT | O_EXCL) makes
 * "does this path already exist, as anything, including a symlink" and
 * "create it" a single atomic filesystem operation — there is no window to
 * race. Randomizing the tmp path's suffix per call means an attacker can no
 * longer even predict the path to pre-plant at; F101's fixed `${path}.tmp`
 * name is not otherwise touched by this function, so any legacy leftover at
 * that literal path is simply irrelevant, not "cleaned up" or "blocked" —
 * see O9's updated expectations. On refusal (EEXIST — a plant that won by
 * guessing, or a same-tick collision) the write is skipped for this cycle
 * (the next scan retries) and a static, identifier-free warning is logged
 * once per process, so a local racer can't silently suppress persistence
 * without it showing up in the logs. The state file itself is written with
 * mode 0600 — it's process-local bookkeeping, not meant to be group/world
 * readable.
 */
export function saveState(
	state: ObserverState,
	path: string = STATE_FILE,
	tmpPath = `${path}.${randomBytes(8).toString("hex")}.tmp`,
): void {
	try {
		writeFileSync(tmpPath, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
		renameSync(tmpPath, path);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "EEXIST" && !warnedPlantedTmpPath) {
			warnedPlantedTmpPath = true;
			console.warn(JSON.stringify({ kind: "codex_observer_tmp_path_refused", level: "warn" }));
		}
		// disk full / permissions / readonly / a planted path — skip; next
		// scan will retry with a fresh random suffix.
	}
}

function listRolloutFiles(sinceDaysAgo: number): string[] {
	const result: string[] = [];
	const now = new Date();
	for (let i = 0; i <= sinceDaysAgo; i++) {
		const d = new Date(now.getTime() - i * 86_400_000);
		const year = String(d.getUTCFullYear());
		const month = String(d.getUTCMonth() + 1).padStart(2, "0");
		const day = String(d.getUTCDate()).padStart(2, "0");
		const dir = join(CODEX_SESSIONS_ROOT, year, month, day);
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
					result.push(join(dir, entry));
				}
			}
		} catch {
			// unreadable dir — skip
		}
	}
	return result;
}

// A plain function shape, not `typeof fetch` — Bun's global fetch type
// carries extra static members (e.g. `preconnect`) that a test's fake
// fetchImpl has no reason to implement.
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// F81: this local type gains tool_use_id/turn_id. The shared
// HookEventPayload (src/shared/types.ts) is deliberately not edited here —
// the server doesn't read turn_id in this plan, and the sibling campaign's
// D21 adds that exact field; editing both would conflict.
type HookPayload = {
	session_id: string;
	hook_event_name: string;
	cwd?: string;
	model?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_response?: unknown;
	tool_use_id?: string;
	turn_id?: string;
	last_assistant_message?: string;
	prompt?: string;
};

/** Hex sha256 of a UTF-8 string. */
function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Deterministic per-line delivery id: the first 32 hex chars of
 * sha256(`${filePath}\0${lineStartByteOffset}`). Every rollout line maps
 * to at most one HTTP POST here, so (file, line-start-offset) alone is a
 * stable identity — a replay of the same file always recomputes the same
 * id for the same line, and a state-loss replay is exactly-once at the
 * server via the durable dedup_key this stamps (Phase 7).
 */
function deliveryIdFor(filePath: string, lineStartOffset: number): string {
	return sha256Hex(`${filePath}\u0000${lineStartOffset}`).slice(0, 32);
}

async function postHook(
	fetchImpl: FetchLike,
	serverUrl: string,
	apiKey: string | null,
	payload: HookPayload,
	deliveryId: string,
) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Agent-Type": "codex_cli",
		[ORIGIN_HEADER]: ORIGIN_CODEX_OBSERVER,
		[DELIVERY_ID_HEADER]: deliveryId,
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetchImpl(`${serverUrl}/api/v1/hooks`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		throw new Error(`ingest ${res.status} ${res.statusText}`);
	}
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
			parts.push(b.text);
		}
	}
	return parts.join("\n").trim();
}

// Decision 21 (F71): skip a user-role item if ANY of its input_text blocks
// begins (after leading whitespace, including a leading newline) with
// "<environment_context". 15/15 sampled injected-context items carry it;
// 0/15 real prompts do. The offset still advances for a skipped line — the
// caller `continue`s after the byte-offset bookkeeping, not before it.
const INJECTED_CONTEXT_PREFIX = /^\s*<environment_context/;

function isInjectedContextItem(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (
			b.type === "input_text" &&
			typeof b.text === "string" &&
			INJECTED_CONTEXT_PREFIX.test(b.text)
		) {
			return true;
		}
	}
	return false;
}

function tryParseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** What the observer asks of the exclude rules: their state as it is now. */
export interface ObserverRules {
	current(): LoadExcludeRulesResult;
}

/** What a caller that passed no rules gets: nothing can be judged, so nothing is posted (the same as while the rules file is invalid). */
const NO_RULES_GIVEN: LoadExcludeRulesResult = { state: "invalid", rules: [] };
/** How much of a file's start is read to find its first session_meta. */
const HEAD_SCAN_BYTES = 256 * 1024;

/**
 * The directory in a rollout file's first session_meta, read from the start of
 * the file (never posting anything); null when there is none to be found. Only
 * for an entry saved before the directory was recorded.
 */
function discoverCwd(filePath: string): string | null {
	let head: string;
	try {
		const fd = openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(HEAD_SCAN_BYTES);
			const n = readSync(fd, buf, 0, HEAD_SCAN_BYTES, 0);
			head = buf.subarray(0, n).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
	const lines = head.split("\n");
	lines.pop(); // the last element is an unfinished line or the empty tail
	for (const line of lines) {
		if (!line.includes('"session_meta"')) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
			if (entry.type === "session_meta") {
				return typeof entry.payload?.cwd === "string" ? entry.payload.cwd : null;
			}
		} catch {}
	}
	return null;
}

type Posting = "post" | "paused" | "excluded";

/** What may be posted for a session in `cwd` under these rules: everything, nothing for now (invalid rules), or nothing ever (covered, or not known while rules exist). */
function postingFor(rules: LoadExcludeRulesResult, cwd: string | null): Posting {
	if (rules.state === "invalid") return "paused";
	if (rules.state === "none") return "post";
	if (cwd === null) return "excluded";
	return evaluateExclusion({ cwd, skip: undefined, rules }).excluded ? "excluded" : "post";
}

type CallMap = Map<string, string>; // call_id -> tool_name

// ── Decision 19: the native-coverage marker ─────────────────────────────

const SESSION_ID_CHARSET = /^[A-Za-z0-9-]{1,128}$/;

// Positive results only — a missing marker is re-checked on every call
// (fail-open; a marker written after a negative check is seen next call).
// Keyed by (home, sessionId) so tests never need a reset hook: every
// observer test uses a fresh tmp homeDir and a fresh session id.
const nativeCoverageCache = new Set<string>();

export function codexNativeMarkerPath(home: string, sessionId: string): string {
	return join(home, CODEX_NATIVE_MARKER_DIR, sessionId);
}

/**
 * True when `$HOME/.agentpulse/codex-native/<sessionId>` exists. The
 * charset check runs first and unconditionally, before any filesystem
 * access — an invalid id (path traversal, empty, oversized, containing a
 * path separator) can never reach the filesystem via this function, no
 * matter what happens to exist on disk at a naively-joined path.
 */
export function isNativeCovered(sessionId: string, home: string = homedir()): boolean {
	if (!SESSION_ID_CHARSET.test(sessionId)) return false;
	const cacheKey = `${home}\u0000${sessionId}`;
	if (nativeCoverageCache.has(cacheKey)) return true;
	const covered = existsSync(codexNativeMarkerPath(home, sessionId));
	if (covered) {
		nativeCoverageCache.add(cacheKey);
		// F100: logged exactly once per session per process — the cache Set
		// above gates this branch to only the first true result for this
		// (home, sessionId) pair; every later call short-circuits on the
		// `.has(cacheKey)` check before reaching here.
		console.warn(`[codex-observer] session ${sessionId} skipped: native marker present`);
	}
	return covered;
}

/**
 * At most once an hour (caller's responsibility — see scan() below):
 * delete regular files directly in the marker directory whose names match
 * the session-id charset and whose mtime is older than maxAgeMs. Never
 * follows symlinks (lstat, not stat) and never touches directories — both
 * are left alone entirely, not just their contents. The shim never
 * deletes markers; only the observer does, and only stale, well-formed
 * ones.
 */
export function evictNativeMarkers(home: string, now: number, maxAgeMs: number): void {
	const dir = join(home, CODEX_NATIVE_MARKER_DIR);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // missing directory — nothing to evict
	}
	for (const name of entries) {
		if (!SESSION_ID_CHARSET.test(name)) continue;
		const fullPath = join(dir, name);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(fullPath);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue; // directories and symlinks are left alone
		if (now - stat.mtimeMs > maxAgeMs) {
			try {
				unlinkSync(fullPath);
			} catch {
				// best-effort; the next hourly pass will retry
			}
		}
	}
}

/** F73 seam: `env.AGENTPULSE_CODEX_OBSERVER === "off"` (case-sensitive) is
 * the only way to disable the observer. Everything else — unset, "", "on",
 * or any other casing — leaves it enabled. */
export function isCodexObserverEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.AGENTPULSE_CODEX_OBSERVER !== "off";
}

export async function processRolloutFile(
	filePath: string,
	stateEntry: FileState | undefined,
	serverUrl: string,
	apiKey: string | null,
	callMap: CallMap,
	fetchImpl: FetchLike = fetch,
	homeDir: string = homedir(),
	rules?: ObserverRules,
): Promise<FileState> {
	const stat = statSync(filePath);
	const startOffset = stateEntry?.offset ?? 0;
	// Excluded is sticky: nothing of this session is read or posted again, whatever happens to the rules.
	if (stateEntry?.excluded) {
		return { offset: stat.size, sessionId: stateEntry.sessionId, excluded: true };
	}
	if (stat.size === startOffset) {
		return stateEntry ?? { offset: 0, sessionId: "" };
	}
	if (stat.size < startOffset) {
		// file truncated / replaced — restart from 0
		return processRolloutFile(
			filePath,
			undefined,
			serverUrl,
			apiKey,
			callMap,
			fetchImpl,
			homeDir,
			rules,
		);
	}

	// The rules as they are now, asked for once. The directory is known from the saved entry, or
	// (for an entry saved before it was recorded) read from the file's first session_meta; a new
	// file has none until its session_meta line comes up below.
	const currentRules = rules?.current() ?? NO_RULES_GIVEN;
	let cwd: string | null | undefined = stateEntry?.cwd;
	if (cwd === undefined && stateEntry && startOffset > 0) cwd = discoverCwd(filePath);
	let posting: Posting | "pending" = cwd === undefined ? "pending" : postingFor(currentRules, cwd);
	if (posting === "excluded") {
		return { offset: stat.size, sessionId: stateEntry?.sessionId ?? "", excluded: true };
	}

	const bytesToRead = stat.size - startOffset;
	const buf = Buffer.alloc(bytesToRead);
	const fd = await open(filePath, "r");
	try {
		await fd.read(buf, 0, bytesToRead, startOffset);
	} finally {
		await fd.close();
	}

	const chunk = buf.toString("utf8");
	const endsWithNewline = chunk.endsWith("\n");
	// Every element of `allLines` except the last is guaranteed to be
	// followed by exactly one "\n" byte in the chunk — true whether or not
	// the chunk itself ends with a newline (split("\n") always appends a
	// trailing "" when it does). This lets the loop below track each
	// line's start byte offset precisely, which the delivery id needs.
	const allLines = chunk.split("\n");
	const completeLines = allLines.slice(0, -1);
	const incomplete = endsWithNewline ? "" : (allLines[allLines.length - 1] ?? "");
	const consumedBytes = bytesToRead - Buffer.byteLength(incomplete, "utf8");
	const newOffset = startOffset + consumedBytes;

	let sessionId = stateEntry?.sessionId ?? "";
	// Decision 19: checked once per call (not per line) — negative results
	// are re-evaluated on the next call; a positive result caches.
	let covered = sessionId ? isNativeCovered(sessionId, homeDir) : false;
	/** Posts only while posting is allowed; while the rules are invalid the line is read and its offset advances, nothing more. */
	const post = async (payload: HookPayload, deliveryId: string) => {
		if (posting === "post") await postHook(fetchImpl, serverUrl, apiKey, payload, deliveryId);
	};

	// Rollout lines whose `type` isn't one of the cases handled below fall
	// through silently and are skipped. This is intentional forward-compat:
	// Codex 0.143.0+ introduced a "WorldState" rollout record variant (a
	// point-in-time filesystem/context snapshot, not an event stream item),
	// and future unknown RolloutItem variants are expected on the same
	// additive-but-unversioned upstream format. Skipping unknown variants
	// keeps this observer forward-compatible without an upstream schema
	// version to key off of; there is nothing here for us to normalize.
	// developer / reasoning / world_state / token_count all fall through
	// here, deliberately.
	//
	// This function and src/server/services/transcript-sync.ts's
	// parseCodexTranscriptDelta() both parse Codex rollout files, but with
	// different shapes and for different purposes (full hook-event replay
	// here vs. assistant-message-only deltas there). Consolidating the two
	// parsers is an explicit non-goal this campaign — see "Out of scope" in
	// thoughts/shared/plans/active/2026-07-17-deliver-client-currency-remediation.md.
	let lineStartOffset = startOffset;
	for (const line of completeLines) {
		const thisLineStart = lineStartOffset;
		lineStartOffset += Buffer.byteLength(line, "utf8") + 1; // +1 for the "\n"

		if (!line.trim()) continue;
		let entry: { type?: string; payload?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const deliveryId = deliveryIdFor(filePath, thisLineStart);

		if (entry.type === "session_meta") {
			const p = entry.payload ?? {};
			sessionId = typeof p.id === "string" ? p.id : sessionId;
			covered = sessionId ? isNativeCovered(sessionId, homeDir) : covered;
			const startedIn = typeof p.cwd === "string" ? p.cwd : undefined;
			// Every session_meta is judged by its own directory: a file can hold more than one session.
			cwd = startedIn ?? null;
			posting = postingFor(currentRules, cwd);
			if (posting === "excluded") {
				return { offset: startOffset + consumedBytes, sessionId, excluded: true };
			}
			if (covered) continue;
			const model = typeof p.model === "string" ? p.model : undefined;
			if (sessionId) {
				await post(
					{ session_id: sessionId, hook_event_name: "SessionStart", cwd: startedIn, model },
					deliveryId,
				);
			}
			continue;
		}

		if (!sessionId || covered) continue;

		if (entry.type === "response_item") {
			const p = entry.payload ?? {};
			const kind = typeof p.type === "string" ? p.type : "";

			if (kind === "message") {
				const role = typeof p.role === "string" ? p.role : "";
				if (role === "user") {
					// Decision 21: skip without posting, offset already advanced.
					if (isInjectedContextItem(p.content)) continue;
					const text = extractTextContent(p.content);
					if (!text) continue;
					await post(
						{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: text },
						deliveryId,
					);
				}
				// Decision 18: assistant response_items never post on their own —
				// only the turn's task_complete/task_completed does, below.
				continue;
			}

			if (kind === "function_call") {
				const callId = typeof p.call_id === "string" ? p.call_id : "";
				const toolName = typeof p.name === "string" ? p.name : "unknown_tool";
				const toolInput = tryParseJson(p.arguments);
				if (callId) callMap.set(callId, toolName);
				await post(
					{
						session_id: sessionId,
						hook_event_name: "PreToolUse",
						tool_name: toolName,
						tool_input: toolInput,
						tool_use_id: callId || undefined,
					},
					deliveryId,
				);
				continue;
			}

			if (kind === "function_call_output") {
				const callId = typeof p.call_id === "string" ? p.call_id : "";
				// The one documented reader-state field (D22): tool_name comes
				// from callMap, which is per-process and lost on restart. A
				// resumed run whose function_call fell in the previous run
				// reports "unknown_tool" here — everything else about this
				// line's body is derived purely from the line itself.
				const toolName = callMap.get(callId) ?? "unknown_tool";
				const rawOutput = (p as { output?: unknown }).output;
				const toolResponse = tryParseJson(rawOutput);
				await post(
					{
						session_id: sessionId,
						hook_event_name: "PostToolUse",
						tool_name: toolName,
						tool_response: toolResponse,
						tool_use_id: callId || undefined,
					},
					deliveryId,
				);
				continue;
			}
			// custom_tool_call and any other response_item kind: no post.
			continue;
		}

		if (entry.type === "event_msg") {
			const p = entry.payload ?? {};
			// Decision 18: one Stop per turn, on task_complete (current) or
			// task_completed (legacy 0.145 name some builds still emit), never
			// per-assistant-item.
			if (p.type === "task_complete" || p.type === "task_completed") {
				const turnId = typeof p.turn_id === "string" ? p.turn_id : undefined;
				const lastAgentMessage =
					typeof p.last_agent_message === "string" && p.last_agent_message.length > 0
						? p.last_agent_message
						: undefined;
				await post(
					{
						session_id: sessionId,
						hook_event_name: "Stop",
						turn_id: turnId,
						last_assistant_message: lastAgentMessage,
					},
					deliveryId,
				);
			}
		}
	}

	return { offset: newOffset, sessionId, ...(cwd === undefined ? {} : { cwd }) };
}

export interface ScanContext {
	state: ObserverState;
	callMapsByFile: Map<string, CallMap>;
	serverUrl: string;
	apiKey: string | null;
	rules?: ObserverRules;
	fetchImpl?: FetchLike;
	homeDir?: string;
	/** Called only when an entry was added or changed. */
	save: (state: ObserverState) => void;
}

/**
 * One pass over the rollout files: each is processed against one snapshot of the
 * rules, and the state file is rewritten only when an entry actually changed.
 */
export async function scanRolloutFiles(files: string[], ctx: ScanContext): Promise<void> {
	// One signature check for the whole scan; every file is judged against that snapshot.
	const snapshot = ctx.rules?.current();
	const rulesView = snapshot ? { current: () => snapshot } : undefined;
	for (const file of files) {
		try {
			let callMap = ctx.callMapsByFile.get(file);
			if (!callMap) {
				callMap = new Map<string, string>();
				ctx.callMapsByFile.set(file, callMap);
			}
			const previous = ctx.state.files[file];
			const next = await processRolloutFile(
				file,
				previous,
				ctx.serverUrl,
				ctx.apiKey,
				callMap,
				ctx.fetchImpl,
				ctx.homeDir,
				rulesView,
			);
			ctx.state.files[file] = next;
			if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) ctx.save(ctx.state);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[codex-observer] ${file}: ${message}`);
		}
	}
}

export async function startCodexObserver(options: {
	serverUrl: string;
	apiKey: string | null;
	/** The exclude rules, shared with the report gate. The observer does not see AGENTPULSE_SKIP; path rules are what cover it. */
	rules?: ObserverRules;
}) {
	if (!existsSync(CODEX_SESSIONS_ROOT)) {
		console.log("[codex-observer] no ~/.codex/sessions directory; observer idle");
		return;
	}

	const state = loadState();
	const callMapsByFile = new Map<string, CallMap>();
	let lastEvictionAt = 0;

	async function scan() {
		await scanRolloutFiles(listRolloutFiles(BACKFILL_DAYS), {
			state,
			callMapsByFile,
			serverUrl: options.serverUrl,
			apiKey: options.apiKey,
			rules: options.rules,
			save: (saved) => saveState(saved),
		});

		const now = Date.now();
		if (now - lastEvictionAt >= EVICTION_INTERVAL_MS) {
			lastEvictionAt = now;
			evictNativeMarkers(homedir(), now, NATIVE_MARKER_MAX_AGE_MS);
		}
	}

	console.log("[codex-observer] scanning ~/.codex/sessions every", SCAN_INTERVAL_MS / 1000, "s");
	await scan();
	setInterval(scan, SCAN_INTERVAL_MS).unref();
}
