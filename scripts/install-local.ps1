param(
  [string]$Ref = "main",
  [string]$Repo = "https://github.com/jstuart0/agentpulse.git",
  [string]$Dir = "$HOME\.agentpulse\app",
  [string]$DataDir = "$HOME\.agentpulse\data",
  [int]$Port = 3000,
  [string]$HostName = "0.0.0.0",
  [string]$PublicUrl = "",
  [bool]$DisableAuth = $true,
  [string]$ApiKey = "",
  [switch]$SkipHooks,
  [switch]$SkipSupervisor,
  # OpenCode (AGEN-141): set up whenever it is found; -NoOpenCode removes our plugins and
  # -OpenCodeForce writes the 1.x plugin where OpenCode 1.x has no plugin SDK yet.
  [switch]$NoOpenCode,
  [switch]$OpenCodeForce,
  # Phase 5: dot-source with -FunctionsOnly to load the hook-command
  # generators (New-ApHookCommand / New-ApCodexHooksFile / New-ApHookAuthHeaderFile)
  # without running the installer's main flow — used by
  # scripts/test-install-local.ps1 and scripts/hook-command-parity.test.ts.
  [switch]$FunctionsOnly
)

$ErrorActionPreference = "Stop"

if (-not $PublicUrl) {
  $PublicUrl = "http://localhost:$Port"
}

$AgentPulseDir = Join-Path $HOME ".agentpulse"
$LogDir = Join-Path $AgentPulseDir "logs"
$SupervisorConfigPath = Join-Path $AgentPulseDir "supervisor.json"
$EnvFile = Join-Path $Dir ".env.local"
$ServerTask = "AgentPulseLocal"
$SupervisorTask = "AgentPulseSupervisor"

# The OpenCode plugin texts (AGEN-141), with their @@AP_OPENCODE_*@@ holes, written by
# `bun run embed:opencode-plugin`. Do not edit between the markers.
# @@AGENTPULSE_OPENCODE_PLUGIN_1@@ BEGIN
$ApOpenCodePlugin1Template = @'
// agentpulse-opencode-plugin f28559765093d2
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Shared core of the AgentPulse plugins for OpenCode 1.x and 2.x (AGEN-141).
// The installers write one self-contained file per line: this core followed by
// the line's own hooks. The plugin only observes. A hook filters and enqueues
// and returns at once; it never awaits a request, never throws and never
// changes what OpenCode passed it. Sending, the exclude check and the
// credential read happen later, off the hook path, in a per-session chain.

const AP_CONFIG = { baseUrl: "@@AP_OPENCODE_BASE_URL@@", direct: "@@AP_OPENCODE_DIRECT@@" === "1" };

// @@AP_GENERATED BEGIN
const AP_BUILD = "f28559765093d2";
const AP_SKIP_VALUES = JSON.parse("[\"1\",\"true\",\"yes\",\"on\"]");
const AP_SEND_STATUS = 42;
const AP_AGENTPULSE_DIR = ".agentpulse";
const AP_RULES_FILE = "exclude";
const AP_MARKER_FILE = "exclude.invalid";
const AP_SCRIPT_FILE = "exclude-check.sh";
const AP_AUTH_HEADER_FILE = "hook-auth-header";
const AP_DELIVERY_HEADER = "X-AgentPulse-Delivery-Id";
const AP_HOST_HEADER = "X-AgentPulse-Host";
const AP_KNOWN_ERROR_NAMES = JSON.parse("[\"Error\",\"APIError\",\"Tool.Error\",\"MessageAbortedError\",\"aborted\",\"provider.invalid-request\"]");
const AP_GATE_PIECE = "w=\u0024(printf ' \\t\\r\\n.'); w=\u0024{w%.}; x=\u0024{AGENTPULSE_SKIP:-}; y=\u0024{x%%[!\"\u0024w\"]*}; x=\u0024{x#\"\u0024y\"}; y=\u0024{x##*[!\"\u0024w\"]}; x=\u0024{x%\"\u0024y\"}; case \u0024x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; d=\u0024HOME/.agentpulse; g=0; if [ -n \"\u0024HOME\" ] && [ ! -e \"\u0024d/exclude\" ] && [ ! -L \"\u0024d/exclude\" ] && [ ! -e \"\u0024d/exclude.invalid\" ] && [ ! -L \"\u0024d/exclude.invalid\" ]; then if [ -d \"\u0024d\" ] && [ -x \"\u0024d\" ]; then g=1; elif [ ! -e \"\u0024d\" ] && [ ! -L \"\u0024d\" ] && [ -d \"\u0024HOME\" ] && [ -x \"\u0024HOME\" ]; then g=1; fi; fi; if [ \"\u0024g\" != 1 ]; then l=\u0024(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn \"\u0024d/\" \"\u0024d/exclude-check.sh\" 2>/dev/null) || exit 0; u=\u0024(id -u 2>/dev/null); ap_f() { y=\u0024{x%%[!\" \"]*}; x=\u0024{x#\"\u0024y\"}; y=\u0024{x%%\" \"*}; x=\u0024{x#\"\u0024y\"}; }; ap_v() { x=\u00241; ap_f; k=\u0024{y%[@+.]}; ap_f; ap_f; [ -n \"\u0024y\" ] && [ \"\u0024y\" = \"\u0024u\" ] && case \u0024k in \u00242[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; n=\u0024{w#???}; ap_v \"\u0024{l%%\"\u0024n\"*}\" d && ap_v \"\u0024{l#*\"\u0024n\"}\" - && { /bin/sh \"\u0024d/exclude-check.sh\"; [ \u0024? = 42 ]; } || exit 0; fi; ";
// @@AP_GENERATED END

const AP_TEST = undefined;
const apEnv = () => process.env;
const apPlatform = () => process.platform;
const apGetuid = () => process.getuid;
const apNow = () => Date.now();
const apArgv = () => process.argv;
const apFetch = () => globalThis.fetch;

const STRING_CAP = 65536;
const BODY_CAP = 262144;
const SESSION_ITEMS = 500;
const SESSION_BYTES = 1048576;
const PROCESS_ITEMS = 2000;
const PROCESS_BYTES = 8388608;
const SESSION_LIMIT = 1024;
const SEEN_LIMIT = 4096;
const CALL_LIMIT = 512;
const MAP_LIMIT = 256;
const SEND_LIMIT = 4;
const GATE_LIMIT = 2;
const POST_TIMEOUT_MS = 2000;
const GATE_TIMEOUT_MS = 2000;
const GATE_TTL_MS = 60000;
const HOLD_MS = 2000;
const RULES_MAX_BYTES = 1048576;
const INPUT_DEPTH = 12;
const INPUT_NODES = 20000;
// Under BODY_CAP, so a bounded input still fits in one envelope.
const INPUT_BYTES = 245760;
const TRUNCATED = "\n[truncated by the AgentPulse plugin]";
const ID_RE = /^[A-Za-z0-9_-]+$/;
const ERR_RE = /^[A-Za-z0-9_.-]+$/;
const AUTH_LINE_RE = /^Authorization: Bearer ap_[A-Za-z0-9_-]+$/;

function apIsSkip(value) {
	if (typeof value !== "string") return false;
	const t = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
	return t !== "" && AP_SKIP_VALUES.indexOf(t) !== -1;
}

// ---- process-wide record ----------------------------------------------------

function newRecord(replaced) {
	return {
		version: 1,
		build: AP_BUILD,
		instances: 0,
		sessions: new Map(),
		info: new Map(),
		seen: new Map(),
		claims: new Map(),
		queuedItems: 0,
		queuedBytes: 0,
		inflight: 0,
		sendWaiters: [],
		gateActive: 0,
		gateWaiters: [],
		gateCache: new Map(),
		gateInflight: new Map(),
		verdicts: new Map(),
		exitHooked: false,
		hostHeader: undefined,
		counters: {
			posts: 0,
			failedPosts: 0,
			droppedOverflow: 0,
			droppedDir: 0,
			droppedClaim: 0,
			droppedSeen: 0,
			evicted: 0,
			swallowed: 0,
			replaced: replaced || 0,
			gateSpawns: 0,
			gateTimeouts: 0,
		},
	};
}

function validRecord(r) {
	return (
		r !== null &&
		typeof r === "object" &&
		r.version === 1 &&
		r.build === AP_BUILD &&
		r.sessions instanceof Map &&
		r.info instanceof Map &&
		r.seen instanceof Map &&
		r.claims instanceof Map &&
		r.gateCache instanceof Map &&
		r.gateInflight instanceof Map &&
		r.verdicts instanceof Map &&
		Array.isArray(r.sendWaiters) &&
		Array.isArray(r.gateWaiters) &&
		r.counters !== null &&
		typeof r.counters === "object"
	);
}

function getRecord() {
	const key = Symbol.for("agentpulse.opencode." + AP_BUILD);
	const found = globalThis[key];
	if (validRecord(found)) return found;
	const fresh = newRecord(found === undefined ? 0 : 1);
	globalThis[key] = fresh;
	return fresh;
}

function swallow(rec) {
	try {
		rec.counters.swallowed += 1;
	} catch {
		// nothing to report to
	}
}

function lruTouch(map, key, value, limit) {
	map.delete(key);
	map.set(key, value);
	while (map.size > limit) {
		const oldest = map.keys().next().value;
		map.delete(oldest);
	}
}

// ---- values the wire accepts -------------------------------------------------

function apIdOf(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && ID_RE.test(value)
		? value
		: null;
}

function capString(value) {
	if (value.length <= STRING_CAP) return value;
	return value.slice(0, STRING_CAP - TRUNCATED.length) + TRUNCATED;
}

function capValue(value, depth, budget) {
	budget.nodes += 1;
	if (budget.nodes > INPUT_NODES || depth > INPUT_DEPTH || budget.bytes >= INPUT_BYTES)
		return "[omitted]";
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		let capped = capString(value);
		const room = INPUT_BYTES - budget.bytes;
		if (room <= TRUNCATED.length) return "[omitted]";
		if (capped.length > room) capped = capped.slice(0, room - TRUNCATED.length) + TRUNCATED;
		budget.bytes += capped.length;
		return capped;
	}
	if (Array.isArray(value)) {
		const out = [];
		for (let i = 0; i < value.length; i++) out.push(capValue(value[i], depth + 1, budget));
		return out;
	}
	if (typeof value === "object") {
		const out = {};
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i++) {
			if (keys[i] === "__proto__") continue;
			budget.bytes += keys[i].length;
			out[keys[i]] = capValue(value[keys[i]], depth + 1, budget);
		}
		return out;
	}
	return "[unsupported]";
}

function capInput(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return capValue(value, 0, { nodes: 0, bytes: 0 });
}

function errorName(raw) {
	return typeof raw === "string" &&
		raw.length <= 64 &&
		ERR_RE.test(raw) &&
		AP_KNOWN_ERROR_NAMES.indexOf(raw) !== -1
		? raw
		: "Error";
}

function wireError(name, status) {
	const out = { name: errorName(name) };
	if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
		out.status = status;
	return out;
}

/** A call id as the plugin may send it: plain text, and never the server's reserved approval: prefix. */
function callIdOf(value) {
	const id = plainText(value, 150);
	return id !== undefined && id.toLowerCase().indexOf("approval:") !== 0 ? id : undefined;
}

function plainText(value, max) {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!/\p{Cc}/u.test(value)
		? value
		: undefined;
}

// ---- sessions, children and call numbering -----------------------------------

function sessionInfo(rec, sid) {
	return rec.info.get(sid);
}

function rememberSession(rec, sid, parent, dir, version) {
	const prev = rec.info.get(sid) || {};
	lruTouch(
		rec.info,
		sid,
		{
			parent: parent || prev.parent,
			dir: dir || prev.dir,
			version: version || prev.version,
		},
		SESSION_LIMIT * 4,
	);
}

function rootOf(rec, sid) {
	let cur = sid;
	for (let i = 0; i < 8; i++) {
		const info = rec.info.get(cur);
		if (!info || !info.parent || info.parent === cur) return cur;
		cur = info.parent;
	}
	return cur;
}

function stateOf(rec, root) {
	let st = rec.sessions.get(root);
	if (st) {
		rec.sessions.delete(root);
		rec.sessions.set(root, st);
		return st;
	}
	st = {
		root: root,
		q: [],
		bytes: 0,
		running: false,
		dead: false,
		calls: new Map(),
		roles: new Map(),
		texts: new Map(),
		perms: new Map(),
		lastVerdict: undefined,
		skipIdle: false,
		hold: [],
	};
	rec.sessions.set(root, st);
	while (rec.sessions.size > SESSION_LIMIT) {
		const oldestKey = rec.sessions.keys().next().value;
		const old = rec.sessions.get(oldestKey);
		rec.sessions.delete(oldestKey);
		if (old) {
			old.dead = true;
			rec.queuedItems -= old.q.length;
			rec.queuedBytes -= old.bytes;
			rec.counters.droppedOverflow += old.q.length;
			rec.counters.evicted += 1;
			old.q = [];
			old.bytes = 0;
		}
	}
	return st;
}

/** The first event of a call assigns its number; a callID seen again after its terminal event is a new call. */
function callEntry(st, callID, starts) {
	let entry = st.calls.get(callID);
	if (!entry) {
		entry = { n: 1, closed: false, partStatus: undefined, pending: undefined, timer: undefined };
	} else if (starts && entry.closed) {
		entry = {
			n: entry.n + 1,
			closed: false,
			partStatus: undefined,
			pending: undefined,
			timer: undefined,
		};
	}
	lruTouch(st.calls, callID, entry, CALL_LIMIT);
	return entry;
}

function toolUseId(callID, entry) {
	return entry.n === 1 ? callID : callID + "#" + entry.n;
}

// ---- queue --------------------------------------------------------------------

function seenBefore(rec, evt) {
	if (rec.seen.has(evt)) return true;
	lruTouch(rec.seen, evt, 1, SEEN_LIMIT);
	return false;
}

function dropOldest(rec, st) {
	const old = st.q.shift();
	if (!old) return;
	st.bytes -= old.size;
	rec.queuedItems -= 1;
	rec.queuedBytes -= old.size;
	rec.counters.droppedOverflow += 1;
}

/** Serialize now, queue, and start the chain. Never throws, never awaits. */
function enqueue(rec, st, envelope, meta) {
	try {
		const body = JSON.stringify(envelope);
		const size = Buffer.byteLength(body);
		if (size > BODY_CAP) {
			rec.counters.droppedOverflow += 1;
			return;
		}
		const item = {
			body: body,
			size: size,
			dirs: meta.dirs,
			evt: meta.evt,
			key: meta.key,
			sid: envelope.session_id,
			name: envelope.hook_event_name,
		};
		st.q.push(item);
		st.bytes += size;
		rec.queuedItems += 1;
		rec.queuedBytes += size;
		while (st.q.length > SESSION_ITEMS || st.bytes > SESSION_BYTES) dropOldest(rec, st);
		while (rec.queuedItems > PROCESS_ITEMS || rec.queuedBytes > PROCESS_BYTES) {
			let victim;
			for (const s of rec.sessions.values()) {
				if (s.q.length > 0) {
					victim = s;
					break;
				}
			}
			if (!victim) break;
			dropOldest(rec, victim);
		}
		kick(rec, st);
	} catch {
		swallow(rec);
	}
}

function kick(rec, st) {
	if (st.running || st.dead) return;
	st.running = true;
	queueMicrotask(() => {
		drain(rec, st).catch(() => {
			swallow(rec);
		});
	});
}

async function drain(rec, st) {
	try {
		while (st.q.length > 0 && !st.dead) {
			// The item stays at the head while it is judged and sent, so a process that exits meanwhile can still flush it.
			const item = st.q[0];
			try {
				await deliver(rec, st, item);
			} catch {
				swallow(rec);
			}
			if (st.q[0] === item) {
				st.q.shift();
				st.bytes -= item.size;
				rec.queuedItems -= 1;
				rec.queuedBytes -= item.size;
			}
		}
	} finally {
		st.running = false;
		if (st.q.length > 0 && !st.dead) kick(rec, st);
	}
}

async function deliver(rec, st, item) {
	for (let i = 0; i < item.dirs.length; i++) {
		const send = await judge(rec, item.dirs[i]);
		if (!send) {
			st.lastVerdict = false;
			rec.counters.droppedDir += 1;
			return;
		}
	}
	st.lastVerdict = true;
	for (let i = 0; i < item.dirs.length; i++) {
		const dir = item.dirs[i];
		if (typeof dir === "string" && dir !== "") lruTouch(rec.verdicts, dir, apNow(), 256);
	}
	if (item.evt !== undefined && seenBefore(rec, item.evt)) {
		rec.counters.droppedSeen += 1;
		return;
	}
	await acquireSend(rec);
	try {
		await post(rec, item);
	} finally {
		releaseSend(rec);
	}
}

function acquireSend(rec) {
	if (rec.inflight < SEND_LIMIT) {
		rec.inflight += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		rec.sendWaiters.push(resolve);
	});
}

function releaseSend(rec) {
	const next = rec.sendWaiters.shift();
	if (next) next();
	else rec.inflight -= 1;
}

// ---- sending ------------------------------------------------------------------

function homeDir() {
	const env = apEnv();
	const home = apPlatform() === "win32" ? env.USERPROFILE : env.HOME;
	return typeof home === "string" && home !== "" ? home : undefined;
}

async function readAuthHeader() {
	// undefined: send without Authorization. null: send nothing. string: the header value.
	const home = homeDir();
	if (!home) return null;
	const file = path.join(home, AP_AGENTPULSE_DIR, AP_AUTH_HEADER_FILE);
	let handle;
	try {
		if (apPlatform() === "win32") {
			const l = await fsp.lstat(file);
			if (!l.isFile() || l.isSymbolicLink()) return null;
			handle = await fsp.open(file, "r");
		} else {
			handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		}
		const st = await handle.stat();
		if (!st.isFile()) return null;
		if (apPlatform() !== "win32") {
			const getuid = apGetuid();
			if (typeof getuid === "function" && st.uid !== getuid.call(process)) return null;
			if ((st.mode & 0o022) !== 0) return null;
		}
		if (st.size === 0) return undefined;
		if (st.size > 4096) return null;
		const text = (await handle.readFile({ encoding: "utf8" })).replace(/\r?\n$/, "");
		if (text === "") return undefined;
		if (!AUTH_LINE_RE.test(text)) return null;
		return text.slice("Authorization: ".length);
	} catch (e) {
		return e && e.code === "ENOENT" ? undefined : null;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}

function hostHeaderValue(rec) {
	if (rec.hostHeader !== undefined) return rec.hostHeader;
	let value = "";
	try {
		const cleaned = os
			.hostname()
			.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "")
			.replace(/[\s\p{Zs}]+/gu, " ")
			.trim();
		const capped = Array.from(cleaned).slice(0, 128).join("").trim();
		value = capped === "" ? "" : encodeURIComponent(capped);
	} catch {
		value = "";
	}
	rec.hostHeader = value;
	return value;
}

function deliveryId(item) {
	const basis = item.key !== undefined ? item.key : item.evt !== undefined ? item.evt : item.body;
	return crypto
		.createHash("sha256")
		.update(AP_CONFIG.baseUrl + "|" + item.sid + "|" + basis)
		.digest("hex")
		.slice(0, 32);
}

async function post(rec, item) {
	const headers = {
		"Content-Type": "application/json",
		"X-Agent-Type": "opencode",
		[AP_DELIVERY_HEADER]: deliveryId(item),
	};
	if (AP_CONFIG.direct) {
		const auth = await readAuthHeader();
		if (auth === null) return;
		if (auth !== undefined) headers.Authorization = auth;
		const host = hostHeaderValue(rec);
		if (host !== "") headers[AP_HOST_HEADER] = host;
	}
	const url = AP_CONFIG.baseUrl + "/api/v1/hooks?event=" + encodeURIComponent(item.name);
	try {
		const res = await apFetch()(url, {
			method: "POST",
			headers: headers,
			body: item.body,
			redirect: "error",
			signal: AbortSignal.timeout(POST_TIMEOUT_MS),
		});
		rec.counters.posts += 1;
		if (res && res.body && typeof res.body.cancel === "function")
			await res.body.cancel().catch(() => {});
	} catch {
		rec.counters.failedPosts += 1;
	}
}

// ---- the exit flush ------------------------------------------------------------
// A one-shot "opencode run" exits right after the turn ends, and a POST the chain has not started by then is
// lost. At exit the plugin sends what is still queued with a synchronous curl, within a fixed budget, and only
// for a directory it already judged "send" in this process (no gate runs at exit). Nothing secret or
// user-authored is in argv: the body goes on stdin and the credential is read by curl from the key file.

const EXIT_BUDGET_MS = 300;
const CURL = "/usr/bin/curl";

/** "opencode run" on 1.x, and on 2.x the private "serve --stdio" server that run starts. A long-lived service is neither. */
function oneShot() {
	const argv = apArgv();
	return argv[2] === "run" || (argv[2] === "serve" && argv.indexOf("--stdio") !== -1);
}

function exitAuthArgs() {
	// [] : no credential header. null : send nothing. [..] : curl arguments.
	if (!AP_CONFIG.direct) return [];
	const home = homeDir();
	if (!home) return null;
	const file = path.join(home, AP_AGENTPULSE_DIR, AP_AUTH_HEADER_FILE);
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return null;
		if (apPlatform() !== "win32") {
			const getuid = apGetuid();
			if (typeof getuid === "function" && st.uid !== getuid.call(process)) return null;
			if ((st.mode & 0o022) !== 0) return null;
		}
		if (st.size === 0) return [];
		if (st.size > 4096) return null;
		const text = fs.readFileSync(fd, "utf8").replace(/\r?\n$/, "");
		if (text === "") return [];
		return AUTH_LINE_RE.test(text) ? ["-H", "@" + file] : null;
	} catch (e) {
		return e && e.code === "ENOENT" ? [] : null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// nothing to do
			}
		}
	}
}

/** True when a rules file or marker of any kind exists (a dangling link, or a path that can't be read, counts). Synchronous. */
function rulesOrMarkerPresentSync() {
	const home = homeDir();
	if (!home) return true;
	const d = path.join(home, AP_AGENTPULSE_DIR);
	for (const name of [AP_RULES_FILE, AP_MARKER_FILE]) {
		try {
			fs.lstatSync(path.join(d, name));
			return true;
		} catch (e) {
			if (!e || e.code !== "ENOENT") return true;
		}
	}
	return false;
}

/** True when anything could still forbid a send: the skip variable, or the rules state above. */
function exitStateForbids() {
	return apIsSkip(apEnv().AGENTPULSE_SKIP) || rulesOrMarkerPresentSync();
}

/** A directory the process judged "send" within the gate's time-to-live. */
function freshVerdict(rec, dir) {
	if (typeof dir !== "string" || dir === "") return false;
	const at = rec.verdicts.get(dir);
	return typeof at === "number" && apNow() - at < GATE_TTL_MS;
}

function flushAtExit(rec) {
	try {
		if (!oneShot()) return;
		if (exitStateForbids()) return;
		const deadline = Date.now() + EXIT_BUDGET_MS;
		const auth = exitAuthArgs();
		if (auth === null) return;
		const curl = (AP_TEST && AP_TEST.curl) || CURL;
		for (const st of rec.sessions.values()) {
			for (const item of st.q) {
				const left = deadline - Date.now();
				if (left <= 0) return;
				if (!item.dirs.every((d) => freshVerdict(rec, d))) break;
				if (item.evt !== undefined && seenBefore(rec, item.evt)) continue;
				const args = [
					"-q",
					"-sS",
					"--max-time",
					String(Math.max(0.05, left / 1000)),
					"-o",
					"/dev/null",
					"-X",
					"POST",
					"--data-binary",
					"@-",
					"-H",
					"Content-Type: application/json",
					"-H",
					"X-Agent-Type: opencode",
					"-H",
					AP_DELIVERY_HEADER + ": " + deliveryId(item),
					...auth,
				];
				if (AP_CONFIG.direct) {
					const host = hostHeaderValue(rec);
					if (host !== "") args.push("-H", AP_HOST_HEADER + ": " + host);
				}
				args.push(AP_CONFIG.baseUrl + "/api/v1/hooks?event=" + encodeURIComponent(item.name));
				cp.spawnSync(curl, args, {
					input: item.body,
					env: { PATH: "/usr/bin:/bin" },
					stdio: ["pipe", "ignore", "ignore"],
					timeout: left,
				});
			}
		}
	} catch {
		// the process is exiting
	}
}

function hookExit(rec) {
	if (rec.exitHooked) return;
	rec.exitHooked = true;
	if (AP_TEST) AP_TEST.exitFlush = () => flushAtExit(rec);
	process.on("exit", () => flushAtExit(rec));
}

// ---- the exclude check --------------------------------------------------------

async function exists(p) {
	try {
		await fsp.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function isLink(p) {
	try {
		return (await fsp.lstat(p)).isSymbolicLink();
	} catch {
		return false;
	}
}

async function searchable(p) {
	try {
		const st = await fsp.stat(p);
		if (!st.isDirectory()) return false;
		await fsp.access(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The exact predicate of the shell gate's step b: nothing to evaluate, send. */
async function noRulesFastPath(home) {
	const d = path.join(home, AP_AGENTPULSE_DIR);
	const rules = path.join(d, AP_RULES_FILE);
	const marker = path.join(d, AP_MARKER_FILE);
	if (
		(await exists(rules)) ||
		(await isLink(rules)) ||
		(await exists(marker)) ||
		(await isLink(marker))
	)
		return false;
	if (await searchable(d)) return true;
	return !(await exists(d)) && !(await isLink(d)) && (await searchable(home));
}

async function fileIdentity(p) {
	try {
		const st = await fsp.lstat(p);
		return st.mode + ":" + st.uid + ":" + st.ino + ":" + st.size;
	} catch {
		return "-";
	}
}

async function fileDigest(p) {
	try {
		const st = await fsp.stat(p);
		if (!st.isFile()) return "-";
		if (st.size > RULES_MAX_BYTES) return "big";
		return crypto
			.createHash("sha256")
			.update(await fsp.readFile(p))
			.digest("hex");
	} catch {
		return "-";
	}
}

async function judge(rec, dir) {
	if (apIsSkip(apEnv().AGENTPULSE_SKIP)) return false;
	const home = homeDir();
	if (!home) return false;
	if (apPlatform() === "win32") {
		const d = path.join(home, AP_AGENTPULSE_DIR);
		const present =
			(await isLink(path.join(d, AP_RULES_FILE))) || (await exists(path.join(d, AP_RULES_FILE)));
		const marked =
			(await isLink(path.join(d, AP_MARKER_FILE))) || (await exists(path.join(d, AP_MARKER_FILE)));
		return !present && !marked;
	}
	if (await noRulesFastPath(home)) return true;
	if (typeof dir !== "string" || dir === "") return false;
	const d = path.join(home, AP_AGENTPULSE_DIR);
	const rulesPath = path.join(d, AP_RULES_FILE);
	let real;
	try {
		real = await fsp.realpath(dir);
	} catch {
		return false;
	}
	const rulesDigest = await fileDigest(rulesPath);
	if (rulesDigest === "big") return false;
	const scriptPath = path.join(d, AP_SCRIPT_FILE);
	const key = [
		real,
		rulesDigest,
		await fileIdentity(rulesPath),
		await fileIdentity(path.join(d, AP_MARKER_FILE)),
		await fileIdentity(scriptPath),
		await fileDigest(scriptPath),
		await fileIdentity(d),
	].join("|");
	const hit = rec.gateCache.get(key);
	if (hit && apNow() - hit.at < GATE_TTL_MS) return hit.send;
	const running = rec.gateInflight.get(key);
	if (running) return running;
	const promise = runGate(rec, home, real, key).finally(() => {
		rec.gateInflight.delete(key);
	});
	rec.gateInflight.set(key, promise);
	return promise;
}

function acquireGate(rec) {
	if (rec.gateActive < GATE_LIMIT) {
		rec.gateActive += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		rec.gateWaiters.push(resolve);
	});
}

function releaseGate(rec) {
	const next = rec.gateWaiters.shift();
	if (next) next();
	else rec.gateActive -= 1;
}

async function runGate(rec, home, dir, key) {
	await acquireGate(rec);
	try {
		const env = { HOME: home, PATH: "/usr/bin:/bin" };
		const skip = apEnv().AGENTPULSE_SKIP;
		if (typeof skip === "string") env.AGENTPULSE_SKIP = skip;
		const verdict = await new Promise((resolve) => {
			let child;
			let done = false;
			const handle = {};
			const finish = (value) => {
				if (done) return;
				done = true;
				clearTimeout(handle.timer);
				resolve(value);
			};
			try {
				rec.counters.gateSpawns += 1;
				child = cp.spawn("/bin/sh", ["-c", AP_GATE_PIECE + "exit " + AP_SEND_STATUS], {
					cwd: dir,
					env: env,
					stdio: "ignore",
					detached: true,
				});
			} catch {
				finish({ send: false, cache: false });
				return;
			}
			handle.timer = setTimeout(() => {
				rec.counters.gateTimeouts += 1;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						child.kill("SIGKILL");
					} catch {
						// already gone
					}
				}
				finish({ send: false, cache: false });
			}, GATE_TIMEOUT_MS);
			if (typeof handle.timer.unref === "function") handle.timer.unref();
			child.on("error", () => {
				finish({ send: false, cache: false });
			});
			child.on("exit", (code) => {
				finish({ send: code === AP_SEND_STATUS, cache: typeof code === "number" });
			});
		});
		if (verdict.cache) lruTouch(rec.gateCache, key, { at: apNow(), send: verdict.send }, 256);
		return verdict.send;
	} finally {
		releaseGate(rec);
	}
}

// ---- helpers shared by both lines ---------------------------------------------

function envelopeBase(line, version, sid, parent, cwd) {
	const info = { line: line, protocol: 1 };
	if (typeof version === "string" && version !== "")
		info.version = version.length <= 64 ? version : undefined;
	const env = { session_id: sid, hook_event_name: "", opencode: info };
	if (cwd) env.cwd = cwd;
	if (parent) env.parent_session_id = parent;
	return env;
}

/** The directories an item is judged by: its own and, for a child, the root session's. */
function judgedDirs(rec, sid, own) {
	const root = rootOf(rec, sid);
	const dirs = [own];
	if (root !== sid) {
		const rootInfo = rec.info.get(root);
		dirs.push(rootInfo ? rootInfo.dir : undefined);
	}
	return dirs;
}

function rememberRole(st, id, role) {
	lruTouch(st.roles, id, role, MAP_LIMIT);
}

function rememberText(st, id, messageID, sid, text) {
	lruTouch(st.texts, id, { messageID: messageID, sid: sid, text: text }, MAP_LIMIT);
}

/** The newest assistant text part of one session, when the plugin knows the message is the assistant's. */
function lastAssistantText(st, sid) {
	let found;
	for (const entry of st.texts.values()) {
		if (entry.sid === sid && st.roles.get(entry.messageID) === "assistant" && entry.text !== "")
			found = entry.text;
	}
	return found === undefined ? undefined : capString(found);
}
// ---- OpenCode 1.x ---------------------------------------------------------------

const V1_EXIT_WAIT_MS = 2000;

// The event names this plugin forwards. scripts/check-hook-event-parity.ts holds this list to OpenCodeV1Event
// in src/shared/types.ts, and emit() sends nothing that isn't on it.
const AP_FORWARDED = [
	"session.created",
	"chat.message",
	"tool.execute.before",
	"tool.execute.after",
	"permission.asked",
	"permission.replied",
	"session.error",
	"session.idle",
];

export const AgentPulse = async (ctx) => {
	let rec;
	try {
		rec = getRecord();
		rec.instances += 1;
		hookExit(rec);
	} catch {
		return {};
	}
	const ctxDir = plainText(ctx && ctx.directory, 4096);
	let lastVersion;

	function emit(sid, name, data, opts) {
		if (AP_FORWARDED.indexOf(name) === -1) return;
		const root = rootOf(rec, sid);
		const info = sessionInfo(rec, sid) || {};
		// With several instances in one process, a session of unknown directory has no safe owner: judged as unknown, it is dropped when rules exist.
		const own = info.dir || (rec.instances <= 1 ? ctxDir : undefined);
		const env = envelopeBase(
			1,
			info.version || lastVersion,
			sid,
			root !== sid ? root : undefined,
			own,
		);
		env.hook_event_name = name;
		env.data = data;
		if (opts && opts.model) env.model = opts.model;
		if (opts && opts.last) env.last_assistant_message = opts.last;
		enqueue(rec, stateOf(rec, root), env, {
			dirs: judgedDirs(rec, sid, own),
			evt: opts && opts.evt,
			key: opts && opts.key,
		});
	}

	function isChild(sid) {
		const info = sessionInfo(rec, sid);
		return !!(info && info.parent);
	}

	function finishCall(sid, callID, entry, status) {
		const pending = entry.pending;
		if (!pending || entry.closed) return;
		clearTimeout(entry.timer);
		entry.pending = undefined;
		entry.closed = true;
		if (status === "error") {
			pending.status = "error";
			pending.error = wireError("Error");
			pending.output = undefined;
			pending.exit_code = undefined;
		}
		emit(sid, "tool.execute.after", pending, { key: pending.tool_use_id + "|after" });
	}

	function flushPending(sid) {
		const st = stateOf(rec, rootOf(rec, sid));
		for (const [callID, entry] of st.calls) {
			if (entry.pending && entry.sid === sid) finishCall(sid, callID, entry, entry.partStatus);
		}
	}

	function onToolPart(sid, part) {
		const callID = callIdOf(part.callID);
		const status = part.state && part.state.status;
		if (!callID || (status !== "completed" && status !== "error")) return;
		const st = stateOf(rec, rootOf(rec, sid));
		const entry = callEntry(st, callID, false);
		if (entry.closed) return;
		if (entry.pending) {
			finishCall(sid, callID, entry, status);
			return;
		}
		if (status === "completed") {
			entry.partStatus = "completed";
			return;
		}
		// A tool that threw never fires tool.execute.after: the part is the only signal.
		entry.closed = true;
		const tool = plainText(part.tool, 128);
		if (!tool) return;
		emit(
			sid,
			"tool.execute.after",
			{
				tool: tool,
				tool_use_id: toolUseId(callID, entry),
				input: capInput(part.state.input),
				status: "error",
				error: wireError("Error"),
			},
			{ key: toolUseId(callID, entry) + "|after" },
		);
	}

	function onEvent(ev) {
		const p = (ev && ev.properties) || {};
		const evt = typeof ev.id === "string" ? ev.id : undefined;
		switch (ev.type) {
			case "session.created": {
				const info = p.info || {};
				const sid = apIdOf(info.id || p.sessionID);
				if (!sid) return;
				const version = plainText(info.version, 64);
				if (version) lastVersion = version;
				rememberSession(rec, sid, apIdOf(info.parentID), plainText(info.directory, 4096), version);
				emit(sid, "session.created", {}, { evt: evt });
				return;
			}
			case "message.updated": {
				const info = p.info || {};
				const sid = apIdOf(info.sessionID || p.sessionID);
				if (!sid || typeof info.id !== "string" || typeof info.role !== "string") return;
				rememberRole(stateOf(rec, rootOf(rec, sid)), info.id, info.role);
				return;
			}
			case "message.part.updated": {
				const part = p.part;
				const sid = apIdOf(p.sessionID || (part && part.sessionID));
				if (!sid || !part || typeof part !== "object") return;
				const st = stateOf(rec, rootOf(rec, sid));
				if (
					part.type === "text" &&
					typeof part.text === "string" &&
					!part.synthetic &&
					!part.ignored
				) {
					if (
						st.lastVerdict !== false &&
						typeof part.messageID === "string" &&
						typeof part.id === "string"
					) {
						rememberText(st, part.id, part.messageID, sid, capString(part.text));
					}
				} else if (part.type === "tool") {
					onToolPart(sid, part);
				}
				return;
			}
			case "permission.asked": {
				const sid = apIdOf(p.sessionID);
				const per = plainText(p.id, 200);
				if (!sid || !per) return;
				const st = stateOf(rec, rootOf(rec, sid));
				const callID = callIdOf(p.tool && p.tool.callID);
				const tuid = callID ? toolUseId(callID, callEntry(st, callID, true)) : "perm:" + per;
				lruTouch(st.perms, per, tuid, MAP_LIMIT);
				const patterns = Array.isArray(p.patterns)
					? p.patterns.filter((x) => typeof x === "string" && x.length <= 1024).slice(0, 32)
					: undefined;
				const data = {
					request_id: per,
					tool_use_id: tuid,
					permission: plainText(p.permission, 128) || "unknown",
				};
				if (patterns) data.patterns = patterns;
				emit(sid, "permission.asked", data, { evt: evt });
				return;
			}
			case "permission.replied": {
				const sid = apIdOf(p.sessionID);
				const per = plainText(p.requestID, 200);
				if (!sid || !per) return;
				const st = stateOf(rec, rootOf(rec, sid));
				const tuid = st.perms.get(per) || "perm:" + per;
				const reply =
					typeof p.reply === "string" && /^[a-z_-]{1,32}$/.test(p.reply) ? p.reply : "unknown";
				emit(
					sid,
					"permission.replied",
					{ request_id: per, tool_use_id: tuid, reply: reply },
					{ evt: evt },
				);
				return;
			}
			case "session.error": {
				const sid = apIdOf(p.sessionID);
				if (!sid) return;
				const error = p.error || {};
				emit(
					sid,
					"session.error",
					{ error: wireError(error.name, error.data && error.data.statusCode) },
					{ evt: evt },
				);
				// A user abort is followed by session.idle; that is not a finished turn.
				if (error.name === "MessageAbortedError" && !isChild(sid)) {
					stateOf(rec, rootOf(rec, sid)).skipIdle = true;
				}
				return;
			}
			case "session.idle": {
				const sid = apIdOf(p.sessionID);
				if (!sid) return;
				const st = stateOf(rec, rootOf(rec, sid));
				flushPending(sid);
				const last = isChild(sid) ? undefined : lastAssistantText(st, sid);
				for (const [id, entry] of st.texts) if (entry.sid === sid) st.texts.delete(id);
				// 1.x sends session.idle (twice, measured) after an abort. The abort is already an
				// Interrupt; a Stop would make the session read WAITING. The next prompt ends this.
				if (!isChild(sid) && st.skipIdle) return;
				emit(sid, "session.idle", {}, { evt: evt, last: last });
				return;
			}
			default:
		}
	}

	return {
		event: (input) => {
			try {
				const ev = input && input.event;
				if (ev && typeof ev.type === "string") onEvent(ev);
			} catch {
				swallow(rec);
			}
		},
		"chat.message": (input, output) => {
			try {
				const sid = apIdOf(input && input.sessionID);
				if (!sid || isChild(sid)) return;
				const st = stateOf(rec, rootOf(rec, sid));
				st.skipIdle = false;
				const parts = output && Array.isArray(output.parts) ? output.parts : [];
				const text = parts
					.filter(
						(x) =>
							x && x.type === "text" && typeof x.text === "string" && !x.synthetic && !x.ignored,
					)
					.map((x) => x.text)
					.join("\n");
				if (text === "") return;
				const m = output.message && output.message.model;
				const model =
					m && typeof m.providerID === "string" && typeof m.modelID === "string"
						? plainText(m.providerID + "/" + m.modelID, 256)
						: undefined;
				emit(sid, "chat.message", { text: capString(text) }, { model: model });
			} catch {
				swallow(rec);
			}
		},
		"tool.execute.before": (input, output) => {
			try {
				const sid = apIdOf(input && input.sessionID);
				const callID = callIdOf(input && input.callID);
				const tool = plainText(input && input.tool, 128);
				if (!sid || !callID || !tool) return;
				const entry = callEntry(stateOf(rec, rootOf(rec, sid)), callID, true);
				const tuid = toolUseId(callID, entry);
				emit(
					sid,
					"tool.execute.before",
					{ tool: tool, tool_use_id: tuid, input: capInput(output && output.args) },
					{ key: tuid + "|before" },
				);
			} catch {
				swallow(rec);
			}
		},
		"tool.execute.after": (input, output) => {
			try {
				const sid = apIdOf(input && input.sessionID);
				const callID = callIdOf(input && input.callID);
				const tool = plainText(input && input.tool, 128);
				if (!sid || !callID || !tool) return;
				const st = stateOf(rec, rootOf(rec, sid));
				const entry = callEntry(st, callID, false);
				if (entry.closed) return;
				const data = {
					tool: tool,
					tool_use_id: toolUseId(callID, entry),
					input: capInput(input.args),
					status: "completed",
				};
				const exit = output && output.metadata && output.metadata.exit;
				if (typeof exit === "number" && Number.isInteger(exit)) data.exit_code = exit;
				if (output && typeof output.output === "string") data.output = capString(output.output);
				entry.sid = sid;
				entry.pending = data;
				if (entry.partStatus === "completed") {
					finishCall(sid, callID, entry, "completed");
					return;
				}
				entry.timer = setTimeout(() => {
					try {
						finishCall(sid, callID, entry, entry.partStatus);
					} catch {
						swallow(rec);
					}
				}, V1_EXIT_WAIT_MS);
				if (typeof entry.timer.unref === "function") entry.timer.unref();
			} catch {
				swallow(rec);
			}
		},
	};
};

'@
# @@AGENTPULSE_OPENCODE_PLUGIN_1@@ END
# @@AGENTPULSE_OPENCODE_PLUGIN_2@@ BEGIN
$ApOpenCodePlugin2Template = @'
// agentpulse-opencode-plugin 2078077c6d538b
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Shared core of the AgentPulse plugins for OpenCode 1.x and 2.x (AGEN-141).
// The installers write one self-contained file per line: this core followed by
// the line's own hooks. The plugin only observes. A hook filters and enqueues
// and returns at once; it never awaits a request, never throws and never
// changes what OpenCode passed it. Sending, the exclude check and the
// credential read happen later, off the hook path, in a per-session chain.

const AP_CONFIG = { baseUrl: "@@AP_OPENCODE_BASE_URL@@", direct: "@@AP_OPENCODE_DIRECT@@" === "1" };

// @@AP_GENERATED BEGIN
const AP_BUILD = "2078077c6d538b";
const AP_SKIP_VALUES = JSON.parse("[\"1\",\"true\",\"yes\",\"on\"]");
const AP_SEND_STATUS = 42;
const AP_AGENTPULSE_DIR = ".agentpulse";
const AP_RULES_FILE = "exclude";
const AP_MARKER_FILE = "exclude.invalid";
const AP_SCRIPT_FILE = "exclude-check.sh";
const AP_AUTH_HEADER_FILE = "hook-auth-header";
const AP_DELIVERY_HEADER = "X-AgentPulse-Delivery-Id";
const AP_HOST_HEADER = "X-AgentPulse-Host";
const AP_KNOWN_ERROR_NAMES = JSON.parse("[\"Error\",\"APIError\",\"Tool.Error\",\"MessageAbortedError\",\"aborted\",\"provider.invalid-request\"]");
const AP_GATE_PIECE = "w=\u0024(printf ' \\t\\r\\n.'); w=\u0024{w%.}; x=\u0024{AGENTPULSE_SKIP:-}; y=\u0024{x%%[!\"\u0024w\"]*}; x=\u0024{x#\"\u0024y\"}; y=\u0024{x##*[!\"\u0024w\"]}; x=\u0024{x%\"\u0024y\"}; case \u0024x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; d=\u0024HOME/.agentpulse; g=0; if [ -n \"\u0024HOME\" ] && [ ! -e \"\u0024d/exclude\" ] && [ ! -L \"\u0024d/exclude\" ] && [ ! -e \"\u0024d/exclude.invalid\" ] && [ ! -L \"\u0024d/exclude.invalid\" ]; then if [ -d \"\u0024d\" ] && [ -x \"\u0024d\" ]; then g=1; elif [ ! -e \"\u0024d\" ] && [ ! -L \"\u0024d\" ] && [ -d \"\u0024HOME\" ] && [ -x \"\u0024HOME\" ]; then g=1; fi; fi; if [ \"\u0024g\" != 1 ]; then l=\u0024(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn \"\u0024d/\" \"\u0024d/exclude-check.sh\" 2>/dev/null) || exit 0; u=\u0024(id -u 2>/dev/null); ap_f() { y=\u0024{x%%[!\" \"]*}; x=\u0024{x#\"\u0024y\"}; y=\u0024{x%%\" \"*}; x=\u0024{x#\"\u0024y\"}; }; ap_v() { x=\u00241; ap_f; k=\u0024{y%[@+.]}; ap_f; ap_f; [ -n \"\u0024y\" ] && [ \"\u0024y\" = \"\u0024u\" ] && case \u0024k in \u00242[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; n=\u0024{w#???}; ap_v \"\u0024{l%%\"\u0024n\"*}\" d && ap_v \"\u0024{l#*\"\u0024n\"}\" - && { /bin/sh \"\u0024d/exclude-check.sh\"; [ \u0024? = 42 ]; } || exit 0; fi; ";
// @@AP_GENERATED END

const AP_TEST = undefined;
const apEnv = () => process.env;
const apPlatform = () => process.platform;
const apGetuid = () => process.getuid;
const apNow = () => Date.now();
const apArgv = () => process.argv;
const apFetch = () => globalThis.fetch;

const STRING_CAP = 65536;
const BODY_CAP = 262144;
const SESSION_ITEMS = 500;
const SESSION_BYTES = 1048576;
const PROCESS_ITEMS = 2000;
const PROCESS_BYTES = 8388608;
const SESSION_LIMIT = 1024;
const SEEN_LIMIT = 4096;
const CALL_LIMIT = 512;
const MAP_LIMIT = 256;
const SEND_LIMIT = 4;
const GATE_LIMIT = 2;
const POST_TIMEOUT_MS = 2000;
const GATE_TIMEOUT_MS = 2000;
const GATE_TTL_MS = 60000;
const HOLD_MS = 2000;
const RULES_MAX_BYTES = 1048576;
const INPUT_DEPTH = 12;
const INPUT_NODES = 20000;
// Under BODY_CAP, so a bounded input still fits in one envelope.
const INPUT_BYTES = 245760;
const TRUNCATED = "\n[truncated by the AgentPulse plugin]";
const ID_RE = /^[A-Za-z0-9_-]+$/;
const ERR_RE = /^[A-Za-z0-9_.-]+$/;
const AUTH_LINE_RE = /^Authorization: Bearer ap_[A-Za-z0-9_-]+$/;

function apIsSkip(value) {
	if (typeof value !== "string") return false;
	const t = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
	return t !== "" && AP_SKIP_VALUES.indexOf(t) !== -1;
}

// ---- process-wide record ----------------------------------------------------

function newRecord(replaced) {
	return {
		version: 1,
		build: AP_BUILD,
		instances: 0,
		sessions: new Map(),
		info: new Map(),
		seen: new Map(),
		claims: new Map(),
		queuedItems: 0,
		queuedBytes: 0,
		inflight: 0,
		sendWaiters: [],
		gateActive: 0,
		gateWaiters: [],
		gateCache: new Map(),
		gateInflight: new Map(),
		verdicts: new Map(),
		exitHooked: false,
		hostHeader: undefined,
		counters: {
			posts: 0,
			failedPosts: 0,
			droppedOverflow: 0,
			droppedDir: 0,
			droppedClaim: 0,
			droppedSeen: 0,
			evicted: 0,
			swallowed: 0,
			replaced: replaced || 0,
			gateSpawns: 0,
			gateTimeouts: 0,
		},
	};
}

function validRecord(r) {
	return (
		r !== null &&
		typeof r === "object" &&
		r.version === 1 &&
		r.build === AP_BUILD &&
		r.sessions instanceof Map &&
		r.info instanceof Map &&
		r.seen instanceof Map &&
		r.claims instanceof Map &&
		r.gateCache instanceof Map &&
		r.gateInflight instanceof Map &&
		r.verdicts instanceof Map &&
		Array.isArray(r.sendWaiters) &&
		Array.isArray(r.gateWaiters) &&
		r.counters !== null &&
		typeof r.counters === "object"
	);
}

function getRecord() {
	const key = Symbol.for("agentpulse.opencode." + AP_BUILD);
	const found = globalThis[key];
	if (validRecord(found)) return found;
	const fresh = newRecord(found === undefined ? 0 : 1);
	globalThis[key] = fresh;
	return fresh;
}

function swallow(rec) {
	try {
		rec.counters.swallowed += 1;
	} catch {
		// nothing to report to
	}
}

function lruTouch(map, key, value, limit) {
	map.delete(key);
	map.set(key, value);
	while (map.size > limit) {
		const oldest = map.keys().next().value;
		map.delete(oldest);
	}
}

// ---- values the wire accepts -------------------------------------------------

function apIdOf(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && ID_RE.test(value)
		? value
		: null;
}

function capString(value) {
	if (value.length <= STRING_CAP) return value;
	return value.slice(0, STRING_CAP - TRUNCATED.length) + TRUNCATED;
}

function capValue(value, depth, budget) {
	budget.nodes += 1;
	if (budget.nodes > INPUT_NODES || depth > INPUT_DEPTH || budget.bytes >= INPUT_BYTES)
		return "[omitted]";
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		let capped = capString(value);
		const room = INPUT_BYTES - budget.bytes;
		if (room <= TRUNCATED.length) return "[omitted]";
		if (capped.length > room) capped = capped.slice(0, room - TRUNCATED.length) + TRUNCATED;
		budget.bytes += capped.length;
		return capped;
	}
	if (Array.isArray(value)) {
		const out = [];
		for (let i = 0; i < value.length; i++) out.push(capValue(value[i], depth + 1, budget));
		return out;
	}
	if (typeof value === "object") {
		const out = {};
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i++) {
			if (keys[i] === "__proto__") continue;
			budget.bytes += keys[i].length;
			out[keys[i]] = capValue(value[keys[i]], depth + 1, budget);
		}
		return out;
	}
	return "[unsupported]";
}

function capInput(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return capValue(value, 0, { nodes: 0, bytes: 0 });
}

function errorName(raw) {
	return typeof raw === "string" &&
		raw.length <= 64 &&
		ERR_RE.test(raw) &&
		AP_KNOWN_ERROR_NAMES.indexOf(raw) !== -1
		? raw
		: "Error";
}

function wireError(name, status) {
	const out = { name: errorName(name) };
	if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
		out.status = status;
	return out;
}

/** A call id as the plugin may send it: plain text, and never the server's reserved approval: prefix. */
function callIdOf(value) {
	const id = plainText(value, 150);
	return id !== undefined && id.toLowerCase().indexOf("approval:") !== 0 ? id : undefined;
}

function plainText(value, max) {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!/\p{Cc}/u.test(value)
		? value
		: undefined;
}

// ---- sessions, children and call numbering -----------------------------------

function sessionInfo(rec, sid) {
	return rec.info.get(sid);
}

function rememberSession(rec, sid, parent, dir, version) {
	const prev = rec.info.get(sid) || {};
	lruTouch(
		rec.info,
		sid,
		{
			parent: parent || prev.parent,
			dir: dir || prev.dir,
			version: version || prev.version,
		},
		SESSION_LIMIT * 4,
	);
}

function rootOf(rec, sid) {
	let cur = sid;
	for (let i = 0; i < 8; i++) {
		const info = rec.info.get(cur);
		if (!info || !info.parent || info.parent === cur) return cur;
		cur = info.parent;
	}
	return cur;
}

function stateOf(rec, root) {
	let st = rec.sessions.get(root);
	if (st) {
		rec.sessions.delete(root);
		rec.sessions.set(root, st);
		return st;
	}
	st = {
		root: root,
		q: [],
		bytes: 0,
		running: false,
		dead: false,
		calls: new Map(),
		roles: new Map(),
		texts: new Map(),
		perms: new Map(),
		lastVerdict: undefined,
		skipIdle: false,
		hold: [],
	};
	rec.sessions.set(root, st);
	while (rec.sessions.size > SESSION_LIMIT) {
		const oldestKey = rec.sessions.keys().next().value;
		const old = rec.sessions.get(oldestKey);
		rec.sessions.delete(oldestKey);
		if (old) {
			old.dead = true;
			rec.queuedItems -= old.q.length;
			rec.queuedBytes -= old.bytes;
			rec.counters.droppedOverflow += old.q.length;
			rec.counters.evicted += 1;
			old.q = [];
			old.bytes = 0;
		}
	}
	return st;
}

/** The first event of a call assigns its number; a callID seen again after its terminal event is a new call. */
function callEntry(st, callID, starts) {
	let entry = st.calls.get(callID);
	if (!entry) {
		entry = { n: 1, closed: false, partStatus: undefined, pending: undefined, timer: undefined };
	} else if (starts && entry.closed) {
		entry = {
			n: entry.n + 1,
			closed: false,
			partStatus: undefined,
			pending: undefined,
			timer: undefined,
		};
	}
	lruTouch(st.calls, callID, entry, CALL_LIMIT);
	return entry;
}

function toolUseId(callID, entry) {
	return entry.n === 1 ? callID : callID + "#" + entry.n;
}

// ---- queue --------------------------------------------------------------------

function seenBefore(rec, evt) {
	if (rec.seen.has(evt)) return true;
	lruTouch(rec.seen, evt, 1, SEEN_LIMIT);
	return false;
}

function dropOldest(rec, st) {
	const old = st.q.shift();
	if (!old) return;
	st.bytes -= old.size;
	rec.queuedItems -= 1;
	rec.queuedBytes -= old.size;
	rec.counters.droppedOverflow += 1;
}

/** Serialize now, queue, and start the chain. Never throws, never awaits. */
function enqueue(rec, st, envelope, meta) {
	try {
		const body = JSON.stringify(envelope);
		const size = Buffer.byteLength(body);
		if (size > BODY_CAP) {
			rec.counters.droppedOverflow += 1;
			return;
		}
		const item = {
			body: body,
			size: size,
			dirs: meta.dirs,
			evt: meta.evt,
			key: meta.key,
			sid: envelope.session_id,
			name: envelope.hook_event_name,
		};
		st.q.push(item);
		st.bytes += size;
		rec.queuedItems += 1;
		rec.queuedBytes += size;
		while (st.q.length > SESSION_ITEMS || st.bytes > SESSION_BYTES) dropOldest(rec, st);
		while (rec.queuedItems > PROCESS_ITEMS || rec.queuedBytes > PROCESS_BYTES) {
			let victim;
			for (const s of rec.sessions.values()) {
				if (s.q.length > 0) {
					victim = s;
					break;
				}
			}
			if (!victim) break;
			dropOldest(rec, victim);
		}
		kick(rec, st);
	} catch {
		swallow(rec);
	}
}

function kick(rec, st) {
	if (st.running || st.dead) return;
	st.running = true;
	queueMicrotask(() => {
		drain(rec, st).catch(() => {
			swallow(rec);
		});
	});
}

async function drain(rec, st) {
	try {
		while (st.q.length > 0 && !st.dead) {
			// The item stays at the head while it is judged and sent, so a process that exits meanwhile can still flush it.
			const item = st.q[0];
			try {
				await deliver(rec, st, item);
			} catch {
				swallow(rec);
			}
			if (st.q[0] === item) {
				st.q.shift();
				st.bytes -= item.size;
				rec.queuedItems -= 1;
				rec.queuedBytes -= item.size;
			}
		}
	} finally {
		st.running = false;
		if (st.q.length > 0 && !st.dead) kick(rec, st);
	}
}

async function deliver(rec, st, item) {
	for (let i = 0; i < item.dirs.length; i++) {
		const send = await judge(rec, item.dirs[i]);
		if (!send) {
			st.lastVerdict = false;
			rec.counters.droppedDir += 1;
			return;
		}
	}
	st.lastVerdict = true;
	for (let i = 0; i < item.dirs.length; i++) {
		const dir = item.dirs[i];
		if (typeof dir === "string" && dir !== "") lruTouch(rec.verdicts, dir, apNow(), 256);
	}
	if (item.evt !== undefined && seenBefore(rec, item.evt)) {
		rec.counters.droppedSeen += 1;
		return;
	}
	await acquireSend(rec);
	try {
		await post(rec, item);
	} finally {
		releaseSend(rec);
	}
}

function acquireSend(rec) {
	if (rec.inflight < SEND_LIMIT) {
		rec.inflight += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		rec.sendWaiters.push(resolve);
	});
}

function releaseSend(rec) {
	const next = rec.sendWaiters.shift();
	if (next) next();
	else rec.inflight -= 1;
}

// ---- sending ------------------------------------------------------------------

function homeDir() {
	const env = apEnv();
	const home = apPlatform() === "win32" ? env.USERPROFILE : env.HOME;
	return typeof home === "string" && home !== "" ? home : undefined;
}

async function readAuthHeader() {
	// undefined: send without Authorization. null: send nothing. string: the header value.
	const home = homeDir();
	if (!home) return null;
	const file = path.join(home, AP_AGENTPULSE_DIR, AP_AUTH_HEADER_FILE);
	let handle;
	try {
		if (apPlatform() === "win32") {
			const l = await fsp.lstat(file);
			if (!l.isFile() || l.isSymbolicLink()) return null;
			handle = await fsp.open(file, "r");
		} else {
			handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		}
		const st = await handle.stat();
		if (!st.isFile()) return null;
		if (apPlatform() !== "win32") {
			const getuid = apGetuid();
			if (typeof getuid === "function" && st.uid !== getuid.call(process)) return null;
			if ((st.mode & 0o022) !== 0) return null;
		}
		if (st.size === 0) return undefined;
		if (st.size > 4096) return null;
		const text = (await handle.readFile({ encoding: "utf8" })).replace(/\r?\n$/, "");
		if (text === "") return undefined;
		if (!AUTH_LINE_RE.test(text)) return null;
		return text.slice("Authorization: ".length);
	} catch (e) {
		return e && e.code === "ENOENT" ? undefined : null;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}

function hostHeaderValue(rec) {
	if (rec.hostHeader !== undefined) return rec.hostHeader;
	let value = "";
	try {
		const cleaned = os
			.hostname()
			.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "")
			.replace(/[\s\p{Zs}]+/gu, " ")
			.trim();
		const capped = Array.from(cleaned).slice(0, 128).join("").trim();
		value = capped === "" ? "" : encodeURIComponent(capped);
	} catch {
		value = "";
	}
	rec.hostHeader = value;
	return value;
}

function deliveryId(item) {
	const basis = item.key !== undefined ? item.key : item.evt !== undefined ? item.evt : item.body;
	return crypto
		.createHash("sha256")
		.update(AP_CONFIG.baseUrl + "|" + item.sid + "|" + basis)
		.digest("hex")
		.slice(0, 32);
}

async function post(rec, item) {
	const headers = {
		"Content-Type": "application/json",
		"X-Agent-Type": "opencode",
		[AP_DELIVERY_HEADER]: deliveryId(item),
	};
	if (AP_CONFIG.direct) {
		const auth = await readAuthHeader();
		if (auth === null) return;
		if (auth !== undefined) headers.Authorization = auth;
		const host = hostHeaderValue(rec);
		if (host !== "") headers[AP_HOST_HEADER] = host;
	}
	const url = AP_CONFIG.baseUrl + "/api/v1/hooks?event=" + encodeURIComponent(item.name);
	try {
		const res = await apFetch()(url, {
			method: "POST",
			headers: headers,
			body: item.body,
			redirect: "error",
			signal: AbortSignal.timeout(POST_TIMEOUT_MS),
		});
		rec.counters.posts += 1;
		if (res && res.body && typeof res.body.cancel === "function")
			await res.body.cancel().catch(() => {});
	} catch {
		rec.counters.failedPosts += 1;
	}
}

// ---- the exit flush ------------------------------------------------------------
// A one-shot "opencode run" exits right after the turn ends, and a POST the chain has not started by then is
// lost. At exit the plugin sends what is still queued with a synchronous curl, within a fixed budget, and only
// for a directory it already judged "send" in this process (no gate runs at exit). Nothing secret or
// user-authored is in argv: the body goes on stdin and the credential is read by curl from the key file.

const EXIT_BUDGET_MS = 300;
const CURL = "/usr/bin/curl";

/** "opencode run" on 1.x, and on 2.x the private "serve --stdio" server that run starts. A long-lived service is neither. */
function oneShot() {
	const argv = apArgv();
	return argv[2] === "run" || (argv[2] === "serve" && argv.indexOf("--stdio") !== -1);
}

function exitAuthArgs() {
	// [] : no credential header. null : send nothing. [..] : curl arguments.
	if (!AP_CONFIG.direct) return [];
	const home = homeDir();
	if (!home) return null;
	const file = path.join(home, AP_AGENTPULSE_DIR, AP_AUTH_HEADER_FILE);
	let fd;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return null;
		if (apPlatform() !== "win32") {
			const getuid = apGetuid();
			if (typeof getuid === "function" && st.uid !== getuid.call(process)) return null;
			if ((st.mode & 0o022) !== 0) return null;
		}
		if (st.size === 0) return [];
		if (st.size > 4096) return null;
		const text = fs.readFileSync(fd, "utf8").replace(/\r?\n$/, "");
		if (text === "") return [];
		return AUTH_LINE_RE.test(text) ? ["-H", "@" + file] : null;
	} catch (e) {
		return e && e.code === "ENOENT" ? [] : null;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// nothing to do
			}
		}
	}
}

/** True when a rules file or marker of any kind exists (a dangling link, or a path that can't be read, counts). Synchronous. */
function rulesOrMarkerPresentSync() {
	const home = homeDir();
	if (!home) return true;
	const d = path.join(home, AP_AGENTPULSE_DIR);
	for (const name of [AP_RULES_FILE, AP_MARKER_FILE]) {
		try {
			fs.lstatSync(path.join(d, name));
			return true;
		} catch (e) {
			if (!e || e.code !== "ENOENT") return true;
		}
	}
	return false;
}

/** True when anything could still forbid a send: the skip variable, or the rules state above. */
function exitStateForbids() {
	return apIsSkip(apEnv().AGENTPULSE_SKIP) || rulesOrMarkerPresentSync();
}

/** A directory the process judged "send" within the gate's time-to-live. */
function freshVerdict(rec, dir) {
	if (typeof dir !== "string" || dir === "") return false;
	const at = rec.verdicts.get(dir);
	return typeof at === "number" && apNow() - at < GATE_TTL_MS;
}

function flushAtExit(rec) {
	try {
		if (!oneShot()) return;
		if (exitStateForbids()) return;
		const deadline = Date.now() + EXIT_BUDGET_MS;
		const auth = exitAuthArgs();
		if (auth === null) return;
		const curl = (AP_TEST && AP_TEST.curl) || CURL;
		for (const st of rec.sessions.values()) {
			for (const item of st.q) {
				const left = deadline - Date.now();
				if (left <= 0) return;
				if (!item.dirs.every((d) => freshVerdict(rec, d))) break;
				if (item.evt !== undefined && seenBefore(rec, item.evt)) continue;
				const args = [
					"-q",
					"-sS",
					"--max-time",
					String(Math.max(0.05, left / 1000)),
					"-o",
					"/dev/null",
					"-X",
					"POST",
					"--data-binary",
					"@-",
					"-H",
					"Content-Type: application/json",
					"-H",
					"X-Agent-Type: opencode",
					"-H",
					AP_DELIVERY_HEADER + ": " + deliveryId(item),
					...auth,
				];
				if (AP_CONFIG.direct) {
					const host = hostHeaderValue(rec);
					if (host !== "") args.push("-H", AP_HOST_HEADER + ": " + host);
				}
				args.push(AP_CONFIG.baseUrl + "/api/v1/hooks?event=" + encodeURIComponent(item.name));
				cp.spawnSync(curl, args, {
					input: item.body,
					env: { PATH: "/usr/bin:/bin" },
					stdio: ["pipe", "ignore", "ignore"],
					timeout: left,
				});
			}
		}
	} catch {
		// the process is exiting
	}
}

function hookExit(rec) {
	if (rec.exitHooked) return;
	rec.exitHooked = true;
	if (AP_TEST) AP_TEST.exitFlush = () => flushAtExit(rec);
	process.on("exit", () => flushAtExit(rec));
}

// ---- the exclude check --------------------------------------------------------

async function exists(p) {
	try {
		await fsp.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function isLink(p) {
	try {
		return (await fsp.lstat(p)).isSymbolicLink();
	} catch {
		return false;
	}
}

async function searchable(p) {
	try {
		const st = await fsp.stat(p);
		if (!st.isDirectory()) return false;
		await fsp.access(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** The exact predicate of the shell gate's step b: nothing to evaluate, send. */
async function noRulesFastPath(home) {
	const d = path.join(home, AP_AGENTPULSE_DIR);
	const rules = path.join(d, AP_RULES_FILE);
	const marker = path.join(d, AP_MARKER_FILE);
	if (
		(await exists(rules)) ||
		(await isLink(rules)) ||
		(await exists(marker)) ||
		(await isLink(marker))
	)
		return false;
	if (await searchable(d)) return true;
	return !(await exists(d)) && !(await isLink(d)) && (await searchable(home));
}

async function fileIdentity(p) {
	try {
		const st = await fsp.lstat(p);
		return st.mode + ":" + st.uid + ":" + st.ino + ":" + st.size;
	} catch {
		return "-";
	}
}

async function fileDigest(p) {
	try {
		const st = await fsp.stat(p);
		if (!st.isFile()) return "-";
		if (st.size > RULES_MAX_BYTES) return "big";
		return crypto
			.createHash("sha256")
			.update(await fsp.readFile(p))
			.digest("hex");
	} catch {
		return "-";
	}
}

async function judge(rec, dir) {
	if (apIsSkip(apEnv().AGENTPULSE_SKIP)) return false;
	const home = homeDir();
	if (!home) return false;
	if (apPlatform() === "win32") {
		const d = path.join(home, AP_AGENTPULSE_DIR);
		const present =
			(await isLink(path.join(d, AP_RULES_FILE))) || (await exists(path.join(d, AP_RULES_FILE)));
		const marked =
			(await isLink(path.join(d, AP_MARKER_FILE))) || (await exists(path.join(d, AP_MARKER_FILE)));
		return !present && !marked;
	}
	if (await noRulesFastPath(home)) return true;
	if (typeof dir !== "string" || dir === "") return false;
	const d = path.join(home, AP_AGENTPULSE_DIR);
	const rulesPath = path.join(d, AP_RULES_FILE);
	let real;
	try {
		real = await fsp.realpath(dir);
	} catch {
		return false;
	}
	const rulesDigest = await fileDigest(rulesPath);
	if (rulesDigest === "big") return false;
	const scriptPath = path.join(d, AP_SCRIPT_FILE);
	const key = [
		real,
		rulesDigest,
		await fileIdentity(rulesPath),
		await fileIdentity(path.join(d, AP_MARKER_FILE)),
		await fileIdentity(scriptPath),
		await fileDigest(scriptPath),
		await fileIdentity(d),
	].join("|");
	const hit = rec.gateCache.get(key);
	if (hit && apNow() - hit.at < GATE_TTL_MS) return hit.send;
	const running = rec.gateInflight.get(key);
	if (running) return running;
	const promise = runGate(rec, home, real, key).finally(() => {
		rec.gateInflight.delete(key);
	});
	rec.gateInflight.set(key, promise);
	return promise;
}

function acquireGate(rec) {
	if (rec.gateActive < GATE_LIMIT) {
		rec.gateActive += 1;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		rec.gateWaiters.push(resolve);
	});
}

function releaseGate(rec) {
	const next = rec.gateWaiters.shift();
	if (next) next();
	else rec.gateActive -= 1;
}

async function runGate(rec, home, dir, key) {
	await acquireGate(rec);
	try {
		const env = { HOME: home, PATH: "/usr/bin:/bin" };
		const skip = apEnv().AGENTPULSE_SKIP;
		if (typeof skip === "string") env.AGENTPULSE_SKIP = skip;
		const verdict = await new Promise((resolve) => {
			let child;
			let done = false;
			const handle = {};
			const finish = (value) => {
				if (done) return;
				done = true;
				clearTimeout(handle.timer);
				resolve(value);
			};
			try {
				rec.counters.gateSpawns += 1;
				child = cp.spawn("/bin/sh", ["-c", AP_GATE_PIECE + "exit " + AP_SEND_STATUS], {
					cwd: dir,
					env: env,
					stdio: "ignore",
					detached: true,
				});
			} catch {
				finish({ send: false, cache: false });
				return;
			}
			handle.timer = setTimeout(() => {
				rec.counters.gateTimeouts += 1;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						child.kill("SIGKILL");
					} catch {
						// already gone
					}
				}
				finish({ send: false, cache: false });
			}, GATE_TIMEOUT_MS);
			if (typeof handle.timer.unref === "function") handle.timer.unref();
			child.on("error", () => {
				finish({ send: false, cache: false });
			});
			child.on("exit", (code) => {
				finish({ send: code === AP_SEND_STATUS, cache: typeof code === "number" });
			});
		});
		if (verdict.cache) lruTouch(rec.gateCache, key, { at: apNow(), send: verdict.send }, 256);
		return verdict.send;
	} finally {
		releaseGate(rec);
	}
}

// ---- helpers shared by both lines ---------------------------------------------

function envelopeBase(line, version, sid, parent, cwd) {
	const info = { line: line, protocol: 1 };
	if (typeof version === "string" && version !== "")
		info.version = version.length <= 64 ? version : undefined;
	const env = { session_id: sid, hook_event_name: "", opencode: info };
	if (cwd) env.cwd = cwd;
	if (parent) env.parent_session_id = parent;
	return env;
}

/** The directories an item is judged by: its own and, for a child, the root session's. */
function judgedDirs(rec, sid, own) {
	const root = rootOf(rec, sid);
	const dirs = [own];
	if (root !== sid) {
		const rootInfo = rec.info.get(root);
		dirs.push(rootInfo ? rootInfo.dir : undefined);
	}
	return dirs;
}

function rememberRole(st, id, role) {
	lruTouch(st.roles, id, role, MAP_LIMIT);
}

function rememberText(st, id, messageID, sid, text) {
	lruTouch(st.texts, id, { messageID: messageID, sid: sid, text: text }, MAP_LIMIT);
}

/** The newest assistant text part of one session, when the plugin knows the message is the assistant's. */
function lastAssistantText(st, sid) {
	let found;
	for (const entry of st.texts.values()) {
		if (entry.sid === sid && st.roles.get(entry.messageID) === "assistant" && entry.text !== "")
			found = entry.text;
	}
	return found === undefined ? undefined : capString(found);
}
// ---- OpenCode 2.x ---------------------------------------------------------------

const V2_CLAIM_LIMIT = 4096;

// The event names this plugin forwards. scripts/check-hook-event-parity.ts holds this list to OpenCodeV2Event
// in src/shared/types.ts, and emit() sends nothing that isn't on it.
const AP_FORWARDED = [
	"session.created",
	"session.inbox.enqueued",
	"tool.before",
	"tool.after",
	"permission.asked",
	"permission.replied",
	"session.step.failed",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
];

export default {
	id: "agentpulse",
	async setup(ctx) {
		const noop = () => {};
		let rec;
		try {
			// The reduced ctx that OpenCode 1.x hands a 2.x-style file has none of these.
			if (
				!ctx ||
				!ctx.event ||
				typeof ctx.event.subscribe !== "function" ||
				!ctx.tool ||
				typeof ctx.tool.hook !== "function" ||
				!ctx.location
			) {
				return noop;
			}
			rec = getRecord();
		} catch {
			return noop;
		}
		const myDir = plainText(ctx.location.directory, 4096);
		if (!myDir) return noop;
		const appVersion = plainText(ctx.app && ctx.app.version, 64);
		rec.instances += 1;
		hookExit(rec);

		function emit(sid, name, data, opts) {
			if (AP_FORWARDED.indexOf(name) === -1) return;
			const root = rootOf(rec, sid);
			const info = sessionInfo(rec, sid) || {};
			// A claimed session lives in this instance's directory. One nobody claimed, seen by several instances, has no safe owner: judged as unknown, it is dropped when rules exist.
			const own =
				info.dir || (rec.claims.get(sid) === myDir || rec.instances <= 1 ? myDir : undefined);
			const env = envelopeBase(
				2,
				info.version || appVersion,
				sid,
				root !== sid ? root : undefined,
				own,
			);
			env.hook_event_name = name;
			env.data = data;
			if (opts && opts.last) env.last_assistant_message = opts.last;
			enqueue(rec, stateOf(rec, root), env, {
				dirs: judgedDirs(rec, sid, own),
				evt: opts && opts.evt,
				key: opts && opts.key,
			});
		}

		function isChild(sid) {
			const info = sessionInfo(rec, sid);
			return !!(info && info.parent);
		}

		/** "yes", "no", or "unknown" (no claim and no directory to claim by). */
		function mine(sid, evDir) {
			const claimant = rec.claims.get(sid);
			if (claimant !== undefined) return claimant === myDir ? "yes" : "no";
			const dir = evDir || (sessionInfo(rec, sid) || {}).dir;
			if (dir === undefined) return "unknown";
			if (dir !== myDir) return "no";
			lruTouch(rec.claims, sid, myDir, V2_CLAIM_LIMIT);
			return "yes";
		}

		function handle(ev, run) {
			const sid = apIdOf(ev.data && ev.data.sessionID);
			if (!sid) return;
			const evDir = plainText(ev.location && ev.location.directory, 4096);
			const verdict = mine(sid, evDir);
			if (verdict === "yes") {
				run(sid);
			} else if (verdict === "unknown") {
				if (rec.instances > 1) {
					run(sid);
					return;
				}
				// Nothing says whose session this is: wait briefly for a claim, then drop it.
				const timer = setTimeout(() => {
					try {
						if (mine(sid, evDir) === "yes") run(sid);
						else rec.counters.droppedClaim += 1;
					} catch {
						swallow(rec);
					}
				}, HOLD_MS);
				if (typeof timer.unref === "function") timer.unref();
			}
		}

		function errorOf(error) {
			const e = error || {};
			return wireError(e.type || e._tag || e.name, e.status);
		}

		function onEvent(ev) {
			const data = ev.data || {};
			const evt = typeof ev.id === "string" ? ev.id : undefined;
			switch (ev.type) {
				case "session.created": {
					const sid = apIdOf(data.sessionID);
					if (!sid) return;
					const dir = plainText(
						(data.location && data.location.directory) || (ev.location && ev.location.directory),
						4096,
					);
					rememberSession(rec, sid, apIdOf(data.parentID), dir, plainText(data.version, 64));
					handle(ev, () => {
						emit(sid, "session.created", {}, { evt: evt });
					});
					return;
				}
				case "session.inbox.enqueued":
					handle(ev, (sid) => {
						const item = data.item || {};
						const text = item.type === "user" && item.payload ? item.payload.text : undefined;
						if (isChild(sid) || typeof text !== "string" || text === "") return;
						emit(sid, "session.inbox.enqueued", { text: capString(text) }, { evt: evt });
					});
					return;
				case "session.text.ended":
					handle(ev, (sid) => {
						const st = stateOf(rec, rootOf(rec, sid));
						if (st.lastVerdict === false || typeof data.text !== "string") return;
						const msg = plainText(data.assistantMessageID, 200) || "msg";
						rememberRole(st, msg, "assistant");
						rememberText(st, msg + ":" + String(data.ordinal), msg, sid, capString(data.text));
					});
					return;
				case "session.step.failed":
				case "session.execution.failed":
					handle(ev, (sid) => {
						emit(sid, ev.type, { error: errorOf(data.error) }, { evt: evt });
					});
					return;
				case "session.execution.succeeded":
					handle(ev, (sid) => {
						const st = stateOf(rec, rootOf(rec, sid));
						const last = isChild(sid) ? undefined : lastAssistantText(st, sid);
						for (const [id, entry] of st.texts) if (entry.sid === sid) st.texts.delete(id);
						emit(sid, ev.type, {}, { evt: evt, last: last });
					});
					return;
				case "session.execution.interrupted":
					handle(ev, (sid) => {
						emit(sid, ev.type, {}, { evt: evt });
					});
					return;
				case "permission.asked":
					handle(ev, (sid) => {
						const per = plainText(data.id, 200);
						if (!per) return;
						const st = stateOf(rec, rootOf(rec, sid));
						const callID = callIdOf(data.source && data.source.id);
						const tuid = callID ? toolUseId(callID, callEntry(st, callID, true)) : "perm:" + per;
						lruTouch(st.perms, per, tuid, MAP_LIMIT);
						const out = {
							request_id: per,
							tool_use_id: tuid,
							permission: plainText(data.action, 128) || "unknown",
						};
						if (Array.isArray(data.resources)) {
							out.patterns = data.resources
								.filter((x) => typeof x === "string" && x.length <= 1024)
								.slice(0, 32);
						}
						emit(sid, ev.type, out, { evt: evt });
					});
					return;
				case "permission.replied":
					handle(ev, (sid) => {
						const per = plainText(data.requestID, 200);
						if (!per) return;
						const st = stateOf(rec, rootOf(rec, sid));
						const reply =
							typeof data.reply === "string" && /^[a-z_-]{1,32}$/.test(data.reply)
								? data.reply
								: "unknown";
						emit(
							sid,
							ev.type,
							{ request_id: per, tool_use_id: st.perms.get(per) || "perm:" + per, reply: reply },
							{ evt: evt },
						);
					});
					return;
				default:
			}
		}

		/** A tool hook runs on the instance of the session's own project (measured, G15). One that reaches another project's instance is skipped. */
		function ownTool(sid) {
			const claimant = rec.claims.get(sid);
			if (claimant !== undefined) return claimant === myDir;
			const known = (sessionInfo(rec, sid) || {}).dir;
			// Nobody claimed it and no directory is known: with rules in force, no instance may take it for its own.
			if (known === undefined) return !rulesOrMarkerPresentSync();
			return known === myDir;
		}

		function toolBefore(event) {
			const sid = apIdOf(event && event.sessionID);
			const callID = callIdOf(event && event.id);
			const tool = plainText(event && event.tool, 128);
			if (!sid || !callID || !tool) return;
			if (!ownTool(sid)) return;
			const entry = callEntry(stateOf(rec, rootOf(rec, sid)), callID, true);
			const tuid = toolUseId(callID, entry);
			emit(
				sid,
				"tool.before",
				{ tool: tool, tool_use_id: tuid, input: capInput(event.input) },
				{ key: tuid + "|before" },
			);
		}

		function toolAfter(event) {
			const sid = apIdOf(event && event.sessionID);
			const callID = callIdOf(event && event.id);
			const tool = plainText(event && event.tool, 128);
			if (!sid || !callID || !tool) return;
			if (!ownTool(sid)) return;
			const st = stateOf(rec, rootOf(rec, sid));
			const entry = callEntry(st, callID, false);
			entry.closed = true;
			const tuid = toolUseId(callID, entry);
			const data = {
				tool: tool,
				tool_use_id: tuid,
				input: capInput(event.input),
				status: "completed",
			};
			if (event.status === "error") {
				data.status = "error";
				data.error = errorOf(event.error);
			} else {
				const result = event.result || {};
				const meta = result.metadata || {};
				const out = result.output;
				const exit =
					typeof meta.exit === "number"
						? meta.exit
						: out && typeof out === "object"
							? out.exit
							: undefined;
				if (typeof exit === "number" && Number.isInteger(exit)) data.exit_code = exit;
				let text;
				if (out && typeof out === "object" && typeof out.output === "string") text = out.output;
				else if (typeof out === "string") text = out;
				else if (
					Array.isArray(result.content) &&
					result.content[0] &&
					typeof result.content[0].text === "string"
				)
					text = result.content[0].text;
				if (text !== undefined) data.output = capString(text);
			}
			emit(sid, "tool.after", data, { key: tuid + "|after" });
		}

		const ac = new AbortController();
		void (async () => {
			try {
				for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
					try {
						if (ev && typeof ev.type === "string") onEvent(ev);
					} catch {
						swallow(rec);
					}
				}
			} catch {
				swallow(rec);
			}
		})();
		try {
			await ctx.tool.hook("execute.before", (event) => {
				try {
					toolBefore(event);
				} catch {
					swallow(rec);
				}
			});
			await ctx.tool.hook("execute.after", (event) => {
				try {
					toolAfter(event);
				} catch {
					swallow(rec);
				}
			});
		} catch {
			swallow(rec);
		}
		return () => {
			try {
				ac.abort();
				rec.instances -= 1;
			} catch {
				swallow(rec);
			}
		};
	},
};

'@
# @@AGENTPULSE_OPENCODE_PLUGIN_2@@ END

# The OpenCode installer step (AGEN-141), written by `bun run embed:opencode-plugin`
# from scripts/opencode-installer/install.ps1. Never executed on Windows by this repo's tests.
# >>> agentpulse-opencode-install
# The OpenCode step of install-local.ps1 (AGEN-141). A template: `bun run embed:opencode-plugin`
# fills the @@AP_OC_*@@ lines from src/shared/opencode-plugin.ts and writes the result between
# the OPENCODE_INSTALL_PS1 markers of install-local.ps1. This has never been executed on Windows.
# It never runs `opencode`.
# In the all-gated layout -OpenCodeForce is remembered in a small file under .agentpulse; only -NoOpenCode
# clears it (and it removes the plugins too). Outside that layout nothing is remembered.
$script:ApOcSdkMarker = 'node_modules/@opencode-ai/plugin/package.json'
$script:ApOcSdkConfigDep = '"@opencode-ai/plugin"'
$script:ApOcSdkRule = 'sdk_present'
$script:ApOcSdkCheck = 'marker_only'
$script:ApOcForeignExts = @('js', 'ts')
$script:ApOcForeignOpens = 'yes'
$script:ApOcLayout = 'v1_flat_v2_dir'
$script:ApOcRemembersForce = $false
$script:ApOcHeaderPrefix = '// agentpulse-opencode-plugin '
$script:ApOcFromEnv = $false
$script:ApOcEntries = @(
  [pscustomobject]@{ Name = 'agentpulse-opencode-1.js'; File = 'agentpulse-opencode-1.js'; Line = 1; Gated = $true; Kind = 'file' }
  [pscustomobject]@{ Name = 'agentpulse-opencode-2'; File = 'agentpulse-opencode-2/index.js'; Line = 2; Gated = $false; Kind = 'dir' }
)
$script:ApOcMsgSkip = 'OpenCode 1.x plugin: not installed. OpenCode 1.x downloads its plugin SDK (@opencode-ai/plugin) into <dir> only when it finds a plugin there, and while it can''t reach the package registry each start then waits about 70 seconds. It hasn''t downloaded the SDK here, so AgentPulse left its 1.x plugin out. To add it, run install-local.ps1 with -OpenCodeForce (download it and run `powershell -ExecutionPolicy Bypass -File install-local.ps1 -OpenCodeForce`; the `irm ... | iex` form can''t pass a switch) while this machine is online: OpenCode 1.x downloads the SDK on its next start, and setup keeps the plugin from then on. If you don''t use OpenCode 1.x, nothing is needed.'
$script:ApOcMsgForce = 'OpenCode 1.x will download its plugin SDK into <dir> on its next start; until it can reach the package registry, each start waits about 70 seconds.'
$script:ApOcNoteServerFirst = 'Upgrade the AgentPulse server first: an older server stores OpenCode events as ordinary Claude Code sessions.'
$script:ApOcNoteServiceSkip = 'AGENTPULSE_SKIP set in your shell is not seen by a running OpenCode 2 background service; use an exclude rule (agentpulse exclude add <dir>), or stop the service so it restarts with your environment (opencode service stop).'

# Test-ApOcGateOpen: $true when the gated entries are written (the same table as ap_oc_gate_open and planOpenCodeInstall).
function Test-ApOcGateOpen {
  param([bool]$Sdk, [bool]$Foreign, [bool]$Force, [bool]$Remembered)
  if ($Force) { return $true }
  if ($script:ApOcRemembersForce -and $Remembered) { return $true }
  if ($script:ApOcSdkRule -eq 'sdk_present' -and $Sdk) { return $true }
  if ($script:ApOcForeignOpens -eq 'yes' -and $Foreign) { return $true }
  return $false
}

# A plain file in plugins that is not a dot file, not ours, and has a listed extension.
function Test-ApOcForeignPlugin {
  param([Parameter(Mandatory = $true)][string]$Plugins)
  if (-not (Test-Path -LiteralPath $Plugins -PathType Container)) { return $false }
  foreach ($f in @(Get-ChildItem -LiteralPath $Plugins -File -Force)) {
    $n = $f.Name
    if ($n.StartsWith('.')) { continue }
    if ($n -eq 'agentpulse-opencode-1.js' -or $n -eq 'agentpulse-opencode-2.js') { continue }
    foreach ($e in $script:ApOcForeignExts) {
      if ($n.Length -gt $e.Length + 1 -and $n.EndsWith(".$e")) { return $true }
    }
  }
  return $false
}

function Test-ApOcLink {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return [bool]($item -and (Get-Item -LiteralPath $Path -Force).LinkType)
}

function Get-ApOcRooted {
  param([string]$Value)
  return ($Value -and [System.IO.Path]::IsPathRooted($Value))
}

function Get-ApOcConfigDir {
  if (Get-ApOcRooted $env:OPENCODE_CONFIG_DIR) { $script:ApOcFromEnv = $true; return $env:OPENCODE_CONFIG_DIR.TrimEnd('\', '/') }
  $script:ApOcFromEnv = $false
  if (Get-ApOcRooted $env:XDG_CONFIG_HOME) { return (Join-Path $env:XDG_CONFIG_HOME.TrimEnd('\', '/') 'opencode') }
  return (Join-Path $HOME '.config\opencode')
}

function Get-ApOcDataDir {
  if (Get-ApOcRooted $env:XDG_DATA_HOME) { return (Join-Path $env:XDG_DATA_HOME.TrimEnd('\', '/') 'opencode') }
  return (Join-Path $HOME '.local\share\opencode')
}

function Test-ApOcOurHeader {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $first = Get-Content -LiteralPath $Path -TotalCount 1
  return [bool]($first -and $first.StartsWith($script:ApOcHeaderPrefix))
}

function Move-ApOcToBackups {
  param([Parameter(Mandatory = $true)][string]$Path)
  $dir = Join-Path $HOME '.agentpulse\backups\opencode'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $to = Join-Path $dir ("{0}.{1}" -f (Split-Path -Leaf $Path), (Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ'))
  Move-Item -LiteralPath $Path -Destination $to
  Write-Step "Moved $Path to $to"
}

function Remove-ApOcOurs {
  param([string]$Plugins, $Entry)
  $top = Join-Path $Plugins $Entry.Name
  if (-not (Test-Path -LiteralPath $top)) { return }
  if ($Entry.Kind -eq 'file') {
    if (Test-ApOcOurHeader -Path $top) {
      Remove-Item -LiteralPath $top -Force
      Write-Step "Removed OpenCode plugin $top"
    }
    return
  }
  $index = Join-Path $top 'index.js'
  if (-not (Test-ApOcOurHeader -Path $index)) { return }
  $others = @(Get-ChildItem -LiteralPath $top -Force | Where-Object { $_.Name -ne 'index.js' })
  if ($others.Count -eq 0) {
    Remove-Item -LiteralPath $index -Force
    Remove-Item -LiteralPath $top -Force
    Write-Step "Removed OpenCode plugin $top"
  } else {
    Move-ApOcToBackups -Path $top
  }
}

function Write-ApOcEntry {
  param([string]$Plugins, $Entry, [string]$BaseUrl, [bool]$Direct)
  $template = if ($Entry.Line -eq 1) { $ApOpenCodePlugin1Template } else { $ApOpenCodePlugin2Template }
  $text = $template.TrimEnd("`r", "`n").Replace('@@AP_OPENCODE_BASE_URL@@', $BaseUrl).Replace('@@AP_OPENCODE_DIRECT@@', $(if ($Direct) { '1' } else { '0' }))
  # Exactly one line break at the end, as buildOpenCodePluginFiles' text has.
  $text = $text + "`n"
  $abs = Join-Path $Plugins $Entry.File
  $top = Join-Path $Plugins $Entry.Name
  if ($Entry.Kind -eq 'dir' -and (Test-Path -LiteralPath $top -PathType Leaf)) { Move-ApOcToBackups -Path $top }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $abs) | Out-Null
  if (Test-Path -LiteralPath $abs -PathType Leaf) {
    if ([System.IO.File]::ReadAllText($abs) -ceq $text) {
      Write-Step "OpenCode plugin unchanged: $abs"
      return
    }
    if (-not (Test-ApOcOurHeader -Path $abs)) { Move-ApOcToBackups -Path $abs }
  }
  Write-ApFileNoFollow -Path $abs -Content $text
  Write-Step "OpenCode plugin -> $abs"
}

function Test-ApOcDetected {
  $cfg = Get-ApOcConfigDir
  return [bool]((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $cfg) -or (Test-Path -LiteralPath (Get-ApOcDataDir)))
}

# Returns $false only when it refused because something it would touch is a link.
function Install-ApOpenCode {
  param([string]$BaseUrl, [bool]$Direct, [bool]$Force, [bool]$NoOpenCode)
  $cfg = Get-ApOcConfigDir
  $plugins = Join-Path $cfg 'plugins'
  if (-not $NoOpenCode -and -not (Test-ApOcDetected)) {
    Write-Step 'OpenCode not detected (no opencode on PATH, no config or data folder); nothing written.'
    return $true
  }
  if (-not $NoOpenCode) {
    if ($BaseUrl -notmatch '^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$') { throw "invalid AgentPulse base URL for the OpenCode plugin: $BaseUrl" }
  }
  foreach ($p in (@($cfg, $plugins) + @($script:ApOcEntries | Where-Object { $_.Kind -eq 'dir' } | ForEach-Object { Join-Path $plugins $_.Name }))) {
    if (Test-ApOcLink -Path $p) {
      Write-Warning "OpenCode: refusing to touch ${p}: it is a link. Nothing was written or removed."
      return $false
    }
  }
  if ($NoOpenCode) {
    foreach ($entry in $script:ApOcEntries) { Remove-ApOcOurs -Plugins $plugins -Entry $entry }
    Write-Step 'OpenCode plugins removed (-NoOpenCode).'
    return $true
  }
  $sdk = Test-Path -LiteralPath (Join-Path $cfg $script:ApOcSdkMarker) -PathType Leaf
  if ($sdk -and $script:ApOcSdkCheck -ne 'marker_only') {
    $pkg = Join-Path $cfg 'package.json'
    $sdk = (Test-Path -LiteralPath $pkg -PathType Leaf) -and [bool](Select-String -LiteralPath $pkg -SimpleMatch $script:ApOcSdkConfigDep -Quiet)
  }
  $foreign = Test-ApOcForeignPlugin -Plugins $plugins
  $remembered = $false
  $rule = Test-ApOcGateOpen -Sdk $sdk -Foreign $foreign -Force $false -Remembered $false
  $open = Test-ApOcGateOpen -Sdk $sdk -Foreign $foreign -Force $Force -Remembered $remembered
  $touched = $false
  foreach ($entry in $script:ApOcEntries) {
    if ($entry.Gated -and -not $open) {
      Remove-ApOcOurs -Plugins $plugins -Entry $entry
    } else {
      Write-ApOcEntry -Plugins $plugins -Entry $entry -BaseUrl $BaseUrl -Direct $Direct
      $touched = $true
    }
  }
  if ($script:ApOcFromEnv) { Write-Step "OPENCODE_CONFIG_DIR is set; installing into $cfg\plugins." }
  if (-not $open) {
    Write-Step $script:ApOcMsgSkip.Replace('<dir>', $cfg)
  } elseif ($Force -and -not $rule) {
    Write-Step $script:ApOcMsgForce.Replace('<dir>', $cfg)
  }
  if ($touched) {
    Write-Step $script:ApOcNoteServerFirst
    Write-Step $script:ApOcNoteServiceSkip
  }
  return $true
}
# <<< agentpulse-opencode-install

function Write-Step($msg) {
  Write-Host "  $msg"
}

function Ensure-Command($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$name is required for Windows installation."
  }
  return $cmd.Source
}

function Ensure-Bun {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if ($bun) {
    Write-Step "✓ Bun: $($bun.Source)"
    return $bun.Source
  }

  $bunPath = Join-Path $HOME ".bun\bin\bun.exe"
  if (Test-Path $bunPath) {
    $env:Path = "$(Split-Path $bunPath);$env:Path"
    Write-Step "✓ Bun: $bunPath"
    return $bunPath
  }

  Write-Step "Installing Bun..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $bunPath = Join-Path $HOME ".bun\bin\bun.exe"
  $env:Path = "$(Split-Path $bunPath);$env:Path"
  Write-Step "✓ Bun: $bunPath"
  return $bunPath
}

function Ensure-Dir($path) {
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Url,
    [object]$Body = $null,
    [hashtable]$Headers = @{}
  )
  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $Headers
  }
  if ($null -ne $Body) {
    $params["ContentType"] = "application/json"
    $params["Body"] = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  Invoke-RestMethod @params
}

function Set-JsonFile {
  param(
    [string]$Path,
    [object]$Data
  )
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($Path))
  $Data | ConvertTo-Json -Depth 20 | Set-Content -Path $Path -Encoding UTF8
}

function Merge-Hashtable {
  param(
    [hashtable]$Base,
    [hashtable]$Overlay
  )
  foreach ($key in $Overlay.Keys) {
    if ($Base[$key] -is [hashtable] -and $Overlay[$key] -is [hashtable]) {
      Merge-Hashtable -Base $Base[$key] -Overlay $Overlay[$key]
    } else {
      $Base[$key] = $Overlay[$key]
    }
  }
}

# >>> agentpulse-hook-cmd
# D13: PowerShell transcription of buildBashHookCommand/buildCodexHooksFile
# (src/shared/hook-command.ts), verified structurally by
# scripts/hook-command-parity.test.ts (static string comparison — pwsh isn't
# available in the primary dev/CI environment; scripts/test-install-local.ps1
# is the real execution coverage, run by the "Windows Installer Validation"
# CI job). Do not hand-edit one copy without the other.
# The exclusion check is NOT inlined in the hook commands. It is two installed
# scripts, ~/.agentpulse/exclude-check.sh (run by Copilot's bash handler) and
# ~/.agentpulse/exclude-check.ps1 (run by the PowerShell handlers), written by
# Install-ApExcludeScripts, and each hook command runs one only when a rules file
# exists. Everything below is literal text held byte-identical to
# src/shared/hook-command.ts by scripts/hook-command-parity.test.ts: both scripts,
# the two command templates, and the pieces that fill them. The shell script holds
# three placeholders for the characters it needs as real bytes (tab, carriage
# return, byte order mark), restored when it is written. Never executed on
# Windows by anything in this change.
$script:ApExcludePsScript = @'
# agentpulse-exclude-check 0ab94c52bff92b
# Trust: the hook command runs this file only when it and ~/.agentpulse are owned by you
# and not group- or world-writable. Only that directory and this file are checked, not the
# directory's ancestors: a ~/.agentpulse symlink that points under a directory other users
# can write is not protected.
$apDir = Join-Path $HOME '.agentpulse'
$apRules = Join-Path $apDir 'exclude'
$apMarker = Join-Path $apDir 'exclude.invalid'
$apExcluded = $false
$apValid = $true
$apDirOk = $true
$apMatch = $false
$apNRules = 0

function ApIsReparsePoint($apPath) {
  $apItem = Get-Item -LiteralPath $apPath -Force -ErrorAction SilentlyContinue
  if (-not $apItem) { return $false }
  if ($apItem.LinkType) { return $true }
  return [bool]($apItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function ApHasMultipleHardLinks($apPath) {
  if (-not (Test-Path -LiteralPath $apPath)) { return $false }
  try {
    $apOutput = & fsutil hardlink list $apPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $apOutput) { return $false }
    $apCount = @($apOutput | Where-Object { $_.Trim().Length -gt 0 }).Count
    return $apCount -gt 1
  } catch {
    return $false
  }
}

function ApCheckSecurity($apPath) {
  try {
    $apAcl = Get-Acl -LiteralPath $apPath -ErrorAction Stop
  } catch {
    return $false
  }
  $apCurrentSid = $null
  try { $apCurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
  if (-not $apCurrentSid) { return $false }
  $apOwnerSid = $null
  try { $apOwnerSid = $apAcl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  if (-not $apOwnerSid) {
    try { $apOwnerSid = ([System.Security.Principal.NTAccount]$apAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  }
  $apExempt = @($apCurrentSid, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $apOwnerSid -or -not ($apExempt -contains $apOwnerSid)) { return $false }
  $apWriteNames = @('WriteData','AppendData','WriteAttributes','WriteExtendedAttributes','WriteDac','ChangePermissions','WriteOwner','TakeOwnership','Delete','DeleteSubdirectoriesAndFiles','Modify','FullControl','Write','GenericWrite','GenericAll')
  $apWriteRightsMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  foreach ($apAce in $apAcl.Access) {
    if ($apAce.AccessControlType.ToString() -ne 'Allow') { continue }
    $apRightsStr = $apAce.FileSystemRights.ToString().Trim()
    $apHasWrite = $false
    if ($apRightsStr -match '^-?\d+$') {
      if (([int64]$apRightsStr -band $apWriteRightsMask) -ne 0) { $apHasWrite = $true }
    } else {
      foreach ($apName in ($apRightsStr -split ',')) {
        if ($apWriteNames -contains $apName.Trim()) { $apHasWrite = $true; break }
      }
    }
    if (-not $apHasWrite) { continue }
    $apAceSid = $null
    try { $apAceSid = $apAce.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
    if ($apAceSid -and ($apExempt -contains $apAceSid)) { continue }
    return $false
  }
  return $true
}

function ApResolveLinks($apPath, $apDepth) {
  if ($apDepth -gt 32) { return $null }
  $apRoot = [System.IO.Path]::GetPathRoot($apPath)
  if ([string]::IsNullOrEmpty($apRoot)) { return $apPath }
  $apCur = $apRoot
  foreach ($apSeg in ($apPath.Substring($apRoot.Length) -split '[\\/]' | Where-Object { $_.Length -gt 0 })) {
    $apNext = Join-Path $apCur $apSeg
    $apItem = Get-Item -LiteralPath $apNext -Force -ErrorAction SilentlyContinue
    if ($apItem -and $apItem.LinkType) {
      $apTarget = @($apItem.Target)[0]
      if (-not [System.IO.Path]::IsPathRooted($apTarget)) { $apTarget = Join-Path $apCur $apTarget }
      $apNext = ApResolveLinks ([System.IO.Path]::GetFullPath($apTarget)) ($apDepth + 1)
      if ($null -eq $apNext) { return $null }
    }
    $apCur = $apNext
  }
  return $apCur
}

function ApResolve($apTarget) {
  $apFull = $apTarget
  try { $apFull = [System.IO.Path]::GetFullPath($apTarget) } catch {}
  $apOut = ApResolveLinks $apFull 0
  if ($null -eq $apOut) { return $apFull }
  return $apOut
}

$apSkipTrimmed = $env:AGENTPULSE_SKIP
if ($null -eq $apSkipTrimmed) { $apSkipTrimmed = '' }
$apSkipTrimmed = $apSkipTrimmed.Trim(' ', "`t", "`r", "`n").ToLowerInvariant()
if ([Array]::IndexOf(@('1','true','yes','on'), $apSkipTrimmed) -ge 0) { $apExcluded = $true }

$apPresent = $false
$apLookupError = $false
if (-not $apExcluded) {
  if ([string]::IsNullOrEmpty($HOME)) {
    $apExcluded = $true
  } else {
    try {
      $null = Get-Item -LiteralPath $apRules -Force -ErrorAction Stop
      $apPresent = $true
    } catch [System.Management.Automation.ItemNotFoundException] {
      $apPresent = $false
    } catch [System.Management.Automation.DriveNotFoundException] {
      $apPresent = $false
    } catch {
      $apPresent = $true
      $apLookupError = $true
    }
    if (-not $apPresent) {
      $apDirItem = Get-Item -LiteralPath $apDir -Force -ErrorAction SilentlyContinue
      if ($apDirItem -and $apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)) {
        $apPresent = $true
        $apLookupError = $true
      }
    }
  }
}

if (-not $apPresent -and -not $apExcluded) {
  if (Test-Path -LiteralPath $apMarker) {
    $apDirReal = ApResolveLinks $apDir 0
    if (-not [string]::IsNullOrEmpty($apDirReal) -and (Test-Path -LiteralPath $apDirReal -PathType Container) -and (ApCheckSecurity $apDirReal)) {
      Remove-Item -LiteralPath (Join-Path $apDirReal 'exclude.invalid') -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($apPresent) {
  $apDirReal = ApResolveLinks $apDir 0
  if ($apLookupError -or [string]::IsNullOrEmpty($apDirReal)) {
    $apDirOk = $false
  } elseif (-not (Test-Path -LiteralPath $apDirReal -PathType Container -ErrorAction SilentlyContinue)) {
    $apDirOk = $false
  } elseif (-not (ApCheckSecurity $apDirReal)) {
    $apDirOk = $false
  }
  $apValid = $apDirOk
  if ($apDirOk) {
    $apRules = Join-Path $apDirReal 'exclude'
    $apMarker = Join-Path $apDirReal 'exclude.invalid'
  }

  if ($apValid) {
    if (ApIsReparsePoint $apRules) {
      $apValid = $false
    } elseif (Test-Path -LiteralPath $apRules -PathType Container) {
      $apValid = $false
    } elseif (ApHasMultipleHardLinks $apRules) {
      $apValid = $false
    } elseif (-not (ApCheckSecurity $apRules)) {
      $apValid = $false
    } else {
      $apInfo = Get-Item -LiteralPath $apRules -Force -ErrorAction SilentlyContinue
      if ($null -eq $apInfo -or $apInfo.Length -gt 65536) { $apValid = $false }
    }
  }

  if ($apValid) {
    $apCwd = ApResolveLinks ((Get-Location).Path) 0
    $apText = $null
    try {
      $apText = [System.IO.File]::ReadAllText($apRules, (New-Object System.Text.UTF8Encoding($false)))
    } catch { $apValid = $false }
    if ($null -eq $apText) { $apValid = $false }
  }

  if ($apValid) {
    $apCwdCmp = ''
    if (-not [string]::IsNullOrEmpty($apCwd)) { $apCwdCmp = $apCwd.Replace('/', '\').ToLowerInvariant() }
    foreach ($apRawLine in ($apText -split "`n")) {
      $apLine = $apRawLine
      if ($apLine.EndsWith("`r")) { $apLine = $apLine.Substring(0, $apLine.Length - 1) }
      $apLine = $apLine.TrimEnd(' ', "`t")
      if ($apLine.Length -eq 0) { continue }
      if ($apLine.StartsWith('#')) { continue }
      $apNRules = $apNRules + 1
      if ($apNRules -gt 500) { $apValid = $false; break }
      if ($apLine -match '[*?\[\]]') { $apValid = $false; break }
      $apIsAbsolute = $apLine.StartsWith('/') -or $apLine -eq '~' -or $apLine.StartsWith('~/') -or ($apLine -match '^[A-Za-z]:[\\/]')
      if (-not $apIsAbsolute) { $apValid = $false; break }
      $apSegments = $apLine -split '[\\/]' | Where-Object { $_.Length -gt 0 }
      if (($apSegments -contains '.') -or ($apSegments -contains '..')) { $apValid = $false; break }
      if ($apMatch) { continue }
      if ($apLine -eq '~') {
        $apExpanded = $HOME
      } elseif ($apLine.StartsWith('~/')) {
        $apExpanded = Join-Path $HOME ($apLine.Substring(2))
      } else {
        $apExpanded = $apLine
      }
      $apResolved = ApResolve $apExpanded
      if ($apResolved -notmatch '^[A-Za-z]:[\\/]' -and -not $apResolved.StartsWith('\\')) { $apValid = $false; break }
      $apResolvedCmp = $apResolved.Replace('/', '\').ToLowerInvariant()
      $apResolvedIsRoot = $apResolvedCmp -match '^[a-z]:\\$'
      $apResolvedWithSep = if ($apResolvedIsRoot) { $apResolvedCmp } else { "$apResolvedCmp\" }
      if ([string]::Equals($apCwdCmp, $apResolvedCmp, 'Ordinal') -or $apCwdCmp.StartsWith($apResolvedWithSep, 'Ordinal')) {
        $apMatch = $true
      }
    }
    if ($apValid -and $apNRules -gt 0 -and [string]::IsNullOrEmpty($apCwd)) { $apMatch = $true }
  }

  if ($apValid) {
    Remove-Item -LiteralPath $apMarker -Force -ErrorAction SilentlyContinue
    if ($apMatch) { $apExcluded = $true }
  } else {
    if ($apDirOk -and -not (ApIsReparsePoint $apMarker)) {
      try {
        $apFs = [System.IO.File]::Open($apMarker, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $apFs.Close()
      } catch {}
    }
    $apExcluded = $true
  }
}
if ($apExcluded) { exit 1 }
exit 42
'@

$script:ApExcludeBashScript = @'
#!/bin/sh
# agentpulse-exclude-check 1eceddec1f369c
# Trust: the hook command runs this file only when it and ~/.agentpulse are owned by you
# and not group- or world-writable. Only that directory and this file are checked, not the
# directory's ancestors: a ~/.agentpulse symlink that points under a directory other users
# can write is not protected.
ap_dir="$HOME/.agentpulse"
ap_rules="$ap_dir/exclude"
ap_marker="$ap_dir/exclude.invalid"
ap_excluded=0
ap_valid=1
ap_dir_ok=1
ap_match=0
ap_nrules=0
ap_cr='@@AP_CR@@'
ap_bom='@@AP_BOM@@'
ap_trimset=" @@AP_TAB@@$ap_cr
"
ap_ascii='] !"#$%&'\''()*+,./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\^_`abcdefghijklmnopqrstuvwxyz{|}~-'
ap_is_darwin=0
if [ -d /System/Library/CoreServices ]; then ap_is_darwin=1; fi

ap_lower() {
  ap_lc_in="$1"
  ap_lc_out=""
  while :; do
    case "$ap_lc_in" in
      *[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*) : ;;
      *) break ;;
    esac
    ap_lc_pre=${ap_lc_in%%[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*}
    ap_lc_in=${ap_lc_in#"$ap_lc_pre"}
    ap_lc_c=${ap_lc_in%"${ap_lc_in#?}"}
    ap_lc_in=${ap_lc_in#?}
    case "$ap_lc_c" in
      A) ap_lc_c=a ;; B) ap_lc_c=b ;; C) ap_lc_c=c ;; D) ap_lc_c=d ;; E) ap_lc_c=e ;;
      F) ap_lc_c=f ;; G) ap_lc_c=g ;; H) ap_lc_c=h ;; I) ap_lc_c=i ;; J) ap_lc_c=j ;;
      K) ap_lc_c=k ;; L) ap_lc_c=l ;; M) ap_lc_c=m ;; N) ap_lc_c=n ;; O) ap_lc_c=o ;;
      P) ap_lc_c=p ;; Q) ap_lc_c=q ;; R) ap_lc_c=r ;; S) ap_lc_c=s ;; T) ap_lc_c=t ;;
      U) ap_lc_c=u ;; V) ap_lc_c=v ;; W) ap_lc_c=w ;; X) ap_lc_c=x ;; Y) ap_lc_c=y ;;
      Z) ap_lc_c=z ;;
    esac
    ap_lc_out="$ap_lc_out$ap_lc_pre$ap_lc_c"
  done
  ap_lc_out="$ap_lc_out$ap_lc_in"
}

ap_stat() {
  ap_stat_mode=""
  ap_stat_line=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$1" 2>/dev/null) || return 1
  IFS=" " read -r ap_stat_mode ap_stat_nlink ap_stat_uid ap_stat_gid ap_stat_size ap_stat_tail <<AP_STAT_EOF
$ap_stat_line
AP_STAT_EOF
  ap_stat_m=$ap_stat_mode
  case "$ap_stat_m" in *[@+.]) ap_stat_m=${ap_stat_m%?} ;; esac
  case "$ap_stat_m" in
    [-dlcbpsDw?][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]) : ;;
    *) return 1 ;;
  esac
  case "$ap_stat_nlink" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_uid" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_size" in ""|*[!0-9]*) return 1 ;; esac
  ap_stat_rest=${ap_stat_m#?????}
  ap_stat_gw=${ap_stat_rest%"${ap_stat_rest#?}"}
  ap_stat_rest2=${ap_stat_m#????????}
  ap_stat_ow=${ap_stat_rest2%"${ap_stat_rest2#?}"}
  return 0
}

ap_physical() {
  if [ "$ap_is_darwin" = "1" ]; then
    case "$1" in
      *[!"$ap_ascii"]*) /bin/pwd -P 2>/dev/null; return ;;
    esac
  fi
  pwd -P 2>/dev/null
}

ap_skip_raw=${AGENTPULSE_SKIP:-}
while :; do
  case "$ap_skip_raw" in
    *["$ap_trimset"]) ap_skip_raw=${ap_skip_raw%?} ;;
    *) break ;;
  esac
done
while :; do
  case "$ap_skip_raw" in
    ["$ap_trimset"]*) ap_skip_raw=${ap_skip_raw#?} ;;
    *) break ;;
  esac
done
case "$ap_skip_raw" in
  [1]|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) ap_excluded=1 ;;
esac

ap_present=0
if [ "$ap_excluded" != "1" ]; then
  if [ -z "$HOME" ]; then
    ap_excluded=1
  elif [ -e "$ap_rules" ] || [ -L "$ap_rules" ]; then
    ap_present=1
  else
    case "$ap_dir" in /*) ap_wp="" ;; *) ap_wp="." ;; esac
    ap_wrest=${ap_dir#/}
    while [ -n "$ap_wrest" ]; do
      case "$ap_wrest" in
        */*)
          ap_wseg=${ap_wrest%%/*}
          ap_wrest=${ap_wrest#*/}
          ;;
        *)
          ap_wseg="$ap_wrest"
          ap_wrest=""
          ;;
      esac
      if [ -z "$ap_wseg" ]; then continue; fi
      ap_wp="$ap_wp/$ap_wseg"
      if [ -L "$ap_wp" ] && [ ! -e "$ap_wp" ]; then ap_present=1; break; fi
      if [ -d "$ap_wp" ]; then
        if [ ! -x "$ap_wp" ]; then ap_present=1; break; fi
      else
        break
      fi
    done
  fi
fi

ap_check_dir() {
  ap_dir_ok=1
  if [ -L "$ap_dir" ]; then
    ap_dir_real=$(cd "$ap_dir" 2>/dev/null && pwd -P 2>/dev/null)
  else
    ap_dir_real="$ap_dir"
  fi
  if [ -z "$ap_dir_real" ] || [ ! -d "$ap_dir_real" ] || [ ! -x "$ap_dir_real" ]; then
    ap_dir_ok=0
  else
    ap_my_uid=$(id -u 2>/dev/null)
    case "$ap_my_uid" in ""|*[!0-9]*) ap_dir_ok=0 ;; esac
    if ap_stat "$ap_dir_real"; then
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_dir_ok=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_dir_ok=0; fi
    else
      ap_dir_ok=0
    fi
  fi
}

if [ "$ap_present" != "1" ] && [ "$ap_excluded" != "1" ]; then
  if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then
    ap_check_dir
    if [ "$ap_dir_ok" = "1" ]; then rm -f "$ap_dir_real/exclude.invalid" 2>/dev/null; fi
  fi
fi

if [ "$ap_present" = "1" ]; then
  ap_check_dir
  ap_valid=$ap_dir_ok
  ap_marker="$ap_dir_real/exclude.invalid"

  if [ "$ap_valid" = "1" ]; then
    if [ -L "$ap_rules" ]; then
      ap_valid=0
    elif [ ! -f "$ap_rules" ]; then
      ap_valid=0
    elif ap_stat "$ap_rules"; then
      if [ "$ap_stat_nlink" -gt 1 ]; then ap_valid=0; fi
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_valid=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ ! -r "$ap_rules" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ "$ap_stat_size" -gt 65536 ]; then ap_valid=0; fi
    else
      ap_valid=0
    fi
  fi

  if [ "$ap_valid" = "1" ]; then
    ap_cwd=$(pwd -P 2>/dev/null)
    if [ -n "$ap_cwd" ] && [ ! -d "$ap_cwd" ]; then ap_cwd=""; fi
    if [ "$ap_is_darwin" = "1" ]; then
      case "$ap_cwd" in
        *[!"$ap_ascii"]*) ap_cwd=$(/bin/pwd -P 2>/dev/null) ;;
      esac
      ap_lower "$ap_cwd"
      ap_cwd="$ap_lc_out"
    fi

    ap_line_no=0
    ap_read_ok=0
    {
    while IFS= read -r ap_line || [ -n "$ap_line" ]; do
      ap_line_no=$((ap_line_no + 1))
      case "$ap_line" in *"$ap_cr") ap_line=${ap_line%"$ap_cr"} ;; esac
      if [ "$ap_line_no" = "1" ]; then
        case "$ap_line" in "$ap_bom"*) ap_line=${ap_line#"$ap_bom"} ;; esac
      fi
      while :; do
        case "$ap_line" in
          *["$ap_trimset"]) ap_line=${ap_line%?} ;;
          *) break ;;
        esac
      done
      case "$ap_line" in
        "") continue ;;
        "#"*) continue ;;
      esac
      ap_nrules=$((ap_nrules + 1))
      if [ "$ap_nrules" -gt 500 ]; then ap_valid=0; break; fi
      case "$ap_line" in
        *'*'*|*'?'*|*'['*|*']'*) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        /*) : ;;
        "~") : ;;
        "~/"*) : ;;
        *) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        "~") ap_expanded="$HOME" ;;
        "~/"*) ap_expanded="$HOME/${ap_line#\~/}" ;;
        *) ap_expanded="$ap_line" ;;
      esac
      case "/$ap_expanded/" in
        *"/./"*|*"/../"*) ap_valid=0; break ;;
      esac
      if [ "$ap_match" = "1" ]; then continue; fi

      ap_seg_rest=${ap_expanded#/}
      ap_prefix=""
      ap_needs_resolve=0
      ap_deepest=""
      ap_remainder=""
      while [ -n "$ap_seg_rest" ]; do
        case "$ap_seg_rest" in
          */*)
            ap_seg=${ap_seg_rest%%/*}
            ap_seg_rest=${ap_seg_rest#*/}
            ;;
          *)
            ap_seg="$ap_seg_rest"
            ap_seg_rest=""
            ;;
        esac
        if [ -z "$ap_seg" ]; then continue; fi
        ap_prefix="$ap_prefix/$ap_seg"
        if [ -L "$ap_prefix" ]; then ap_needs_resolve=1; fi
        if [ -e "$ap_prefix" ]; then
          ap_deepest="$ap_prefix"
          ap_remainder=""
        else
          ap_remainder="$ap_remainder/$ap_seg"
        fi
      done
      if [ -z "$ap_prefix" ]; then ap_prefix="/"; fi
      if [ "$ap_is_darwin" = "1" ]; then
        case "$ap_deepest" in
          *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-]*)
            case "$ap_deepest" in
              *[!"$ap_ascii"]*) ap_needs_resolve=1 ;;
            esac ;;
        esac
      fi

      if [ "$ap_needs_resolve" = "1" ]; then
        ap_rt="${ap_deepest:-/}"
        ap_rrem="$ap_remainder"
        while :; do
          ap_resolved=$(cd "$ap_rt" 2>/dev/null && ap_physical "$ap_rt")
          if [ -n "$ap_resolved" ]; then break; fi
          if [ "$ap_rt" = "/" ]; then ap_resolved="/"; break; fi
          ap_rrem="/${ap_rt##*/}$ap_rrem"
          ap_rt=${ap_rt%/*}
          if [ -z "$ap_rt" ]; then ap_rt="/"; fi
        done
        if [ "$ap_resolved" = "/" ]; then ap_resolved=""; fi
        ap_resolved="$ap_resolved$ap_rrem"
        if [ -z "$ap_resolved" ]; then ap_resolved="/"; fi
      else
        ap_resolved="$ap_prefix"
      fi

      if [ "$ap_is_darwin" = "1" ]; then
        ap_lower "$ap_resolved"
        ap_resolved="$ap_lc_out"
      fi

      if [ "$ap_resolved" = "/" ]; then
        ap_match=1
      elif [ "$ap_cwd" = "$ap_resolved" ]; then
        ap_match=1
      else
        ap_rem=${ap_cwd#"$ap_resolved"/}
        if [ "$ap_rem" != "$ap_cwd" ]; then ap_match=1; fi
      fi
    done
    ap_read_ok=1
    } 2>/dev/null < "$ap_rules"
    if [ "$ap_read_ok" != "1" ]; then ap_valid=0; fi
    if [ "$ap_valid" = "1" ] && [ "$ap_nrules" -gt 0 ] && [ -z "$ap_cwd" ]; then ap_match=1; fi
  fi

  if [ "$ap_valid" = "1" ]; then
    if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then rm -f "$ap_marker" 2>/dev/null; fi
    if [ "$ap_match" = "1" ]; then ap_excluded=1; fi
  else
    if [ "$ap_dir_ok" = "1" ] && [ ! -L "$ap_marker" ]; then { :; } 2>/dev/null >"$ap_marker"; fi
    ap_excluded=1
  fi
fi
if [ "$ap_excluded" = "1" ]; then exit 1; fi
exit 42
'@

$script:ApShCommandTemplate = @'
t=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ( trap 'rm -f "$t"' EXIT; trap 'exit 1' HUP INT TERM; @@AP_MARKER@@@@AP_GATE@@@@AP_SEND@@ ) </dev/null >/dev/null 2>&1 & exit 0
'@

$script:ApShGatePiece = @'
w=$(printf ' \t\r\n.'); w=${w%.}; x=${AGENTPULSE_SKIP:-}; y=${x%%[!"$w"]*}; x=${x#"$y"}; y=${x##*[!"$w"]}; x=${x%"$y"}; case $x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; d=$HOME/.agentpulse; g=0; if [ -n "$HOME" ] && [ ! -e "$d/exclude" ] && [ ! -L "$d/exclude" ] && [ ! -e "$d/exclude.invalid" ] && [ ! -L "$d/exclude.invalid" ]; then if [ -d "$d" ] && [ -x "$d" ]; then g=1; elif [ ! -e "$d" ] && [ ! -L "$d" ] && [ -d "$HOME" ] && [ -x "$HOME" ]; then g=1; fi; fi; if [ "$g" != 1 ]; then l=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$d/" "$d/exclude-check.sh" 2>/dev/null) || exit 0; u=$(id -u 2>/dev/null); ap_f() { y=${x%%[!" "]*}; x=${x#"$y"}; y=${x%%" "*}; x=${x#"$y"}; }; ap_v() { x=$1; ap_f; k=${y%[@+.]}; ap_f; ap_f; [ -n "$y" ] && [ "$y" = "$u" ] && case $k in $2[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; n=${w#???}; ap_v "${l%%"$n"*}" d && ap_v "${l#*"$n"}" - && { /bin/sh "$d/exclude-check.sh"; [ $? = 42 ]; } || exit 0; fi; 
'@

$script:ApPsCommandTemplate = @'
$ErrorActionPreference = 'SilentlyContinue'
$d = Join-Path $env:TEMP 'agentpulse-hooks'
New-Item -ItemType Directory -Force $d | Out-Null
$t = Join-Path $d ([guid]::NewGuid().ToString())
$raw = [Console]::In.ReadToEnd()
[IO.File]::WriteAllText($t, $raw)
@@AP_HEADER_FILE@@
$apJob = {
  param($t, $f, $url, $agent, $apJobCwd, $apJobSkip)
  try {
@@AP_PRELUDE@@
@@AP_MARKER@@@@AP_GATE@@
  if ($apGo) {
    @@AP_AUTH_ARG@@
    $curlArgs = @('-sS','--max-time','2','-o','NUL','-X','POST',$url,'-H','Content-Type: application/json','-H',"X-Agent-Type: $agent") + $headerArgs + @('--data-binary',"@$t")
    $curlLine = @($curlArgs | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
    Start-Process -FilePath curl.exe -WindowStyle Hidden -ArgumentList $curlLine -Wait
  }
  } finally {
    Remove-Item -Force $t -ErrorAction SilentlyContinue
  }
}
$apArgs = foreach ($apV in @($t, $f, '@@AP_URL@@', '@@AP_AGENT@@', (Get-Location).Path, $env:AGENTPULSE_SKIP)) { if ($null -eq $apV) { '$null' } else { "'" + ([string]$apV).Replace("'", "''") + "'" } }
$apCmd = '& {' + $apJob.ToString() + '} ' + ($apArgs -join ' ')
Start-Process -FilePath (Get-Process -Id $PID).Path -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($apCmd)))
Get-ChildItem $d -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue
exit 0
'@

$script:ApPsPreludePiece = @'
  function ApIsReparsePoint($apPath) {
    $apItem = Get-Item -LiteralPath $apPath -Force -ErrorAction SilentlyContinue
    if (-not $apItem) { return $false }
    if ($apItem.LinkType) { return $true }
    return [bool]($apItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  }
'@

$script:ApPsMarkerPiece = @'
$jobRaw = [IO.File]::ReadAllText($t); $sid = [regex]::Match($jobRaw, '"session_id"\s*:\s*"([A-Za-z0-9-]{1,128})"').Groups[1].Value; if ($sid) { $md = Join-Path $HOME '.agentpulse\codex-native'; if (-not (ApIsReparsePoint $md)) { New-Item -ItemType Directory -Force $md -ErrorAction SilentlyContinue | Out-Null; $mf = Join-Path $md $sid; if (-not (ApIsReparsePoint $mf)) { try { [IO.File]::Open($mf, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite).Close() } catch {} } } }
'@

$script:ApPsGatePiece = @'
  $apGo = $true
  $apSkip = $apJobSkip
  if ($null -eq $apSkip) { $apSkip = '' }
  if (@('1','true','yes','on') -contains $apSkip.Trim(' ', "`t", "`r", "`n").ToLowerInvariant()) { $apGo = $false }
  elseif ([string]::IsNullOrEmpty($HOME)) { $apGo = $false }
  else {
    $apDir = Join-Path $HOME '.agentpulse'
    $apHand = $false
    try { $null = Get-Item -LiteralPath (Join-Path $apDir 'exclude') -Force -ErrorAction Stop; $apHand = $true }
    catch [System.Management.Automation.ItemNotFoundException] { }
    catch [System.Management.Automation.DriveNotFoundException] { }
    catch { $apHand = $true }
    if (-not $apHand) {
      try { $null = Get-Item -LiteralPath (Join-Path $apDir 'exclude.invalid') -Force -ErrorAction Stop; $apHand = $true }
      catch [System.Management.Automation.ItemNotFoundException] { }
      catch [System.Management.Automation.DriveNotFoundException] { }
      catch { $apHand = $true }
    }
    if (-not $apHand) {
      $apDirItem = Get-Item -LiteralPath $apDir -Force -ErrorAction SilentlyContinue
      if ($apDirItem -and $apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)) { $apHand = $true }
    }
    if ($apHand) {
      $apGo = $false
      function ApCheckSecurity($apPath) {
        try {
          $apAcl = Get-Acl -LiteralPath $apPath -ErrorAction Stop
        } catch {
          return $false
        }
        $apCurrentSid = $null
        try { $apCurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
        if (-not $apCurrentSid) { return $false }
        $apOwnerSid = $null
        try { $apOwnerSid = $apAcl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
        if (-not $apOwnerSid) {
          try { $apOwnerSid = ([System.Security.Principal.NTAccount]$apAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
        }
        $apExempt = @($apCurrentSid, 'S-1-5-18', 'S-1-5-32-544')
        if (-not $apOwnerSid -or -not ($apExempt -contains $apOwnerSid)) { return $false }
        $apWriteNames = @('WriteData','AppendData','WriteAttributes','WriteExtendedAttributes','WriteDac','ChangePermissions','WriteOwner','TakeOwnership','Delete','DeleteSubdirectoriesAndFiles','Modify','FullControl','Write','GenericWrite','GenericAll')
        $apWriteRightsMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
        foreach ($apAce in $apAcl.Access) {
          if ($apAce.AccessControlType.ToString() -ne 'Allow') { continue }
          $apRightsStr = $apAce.FileSystemRights.ToString().Trim()
          $apHasWrite = $false
          if ($apRightsStr -match '^-?\d+$') {
            if (([int64]$apRightsStr -band $apWriteRightsMask) -ne 0) { $apHasWrite = $true }
          } else {
            foreach ($apName in ($apRightsStr -split ',')) {
              if ($apWriteNames -contains $apName.Trim()) { $apHasWrite = $true; break }
            }
          }
          if (-not $apHasWrite) { continue }
          $apAceSid = $null
          try { $apAceSid = $apAce.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
          if ($apAceSid -and ($apExempt -contains $apAceSid)) { continue }
          return $false
        }
        return $true
      }
      $apScript = Join-Path $apDir 'exclude-check.ps1'
      if ((Test-Path -LiteralPath $apScript -PathType Leaf) -and -not (ApIsReparsePoint $apScript) -and (ApCheckSecurity $apDir) -and (ApCheckSecurity $apScript)) {
        $apHost = (Get-Process -Id $PID).Path
        $apProc = Start-Process -FilePath $apHost -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $apScript + '"')) -WorkingDirectory $apJobCwd -WindowStyle Hidden -Wait -PassThru
        if ($apProc -and $apProc.ExitCode -eq 42) { $apGo = $true }
      }
    }
  }
'@

# A checkout that converts line endings must not change any of the text above.
foreach ($apName in @('ApExcludePsScript','ApExcludeBashScript','ApShCommandTemplate','ApShGatePiece','ApPsCommandTemplate','ApPsPreludePiece','ApPsMarkerPiece','ApPsGatePiece')) {
  Set-Variable -Scope Script -Name $apName -Value ((Get-Variable -Scope Script -Name $apName -ValueOnly).Replace("`r`n", "`n"))
}

function New-ApHookCommand {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct,
    [Parameter(Mandatory = $true)][string]$AgentType,
    [Parameter(Mandatory = $true)][string]$EventName
  )
  if ($BaseUrl -notmatch '^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$') {
    throw "invalid AgentPulse base URL for a hook command: $BaseUrl"
  }
  $url = "$BaseUrl/api/v1/hooks?event=$EventName"
  $headerFile = if ($Direct) { "`$f = Join-Path `$HOME '.agentpulse\hook-auth-header'" } else { "`$f = `$null" }
  $authArg = "`$headerArgs = @()`n    if (`$f -and (Test-Path `$f -ErrorAction SilentlyContinue) -and (Get-Item `$f -ErrorAction SilentlyContinue).Length -gt 0) { `$headerArgs = @('-H', `"@`$f`") }"
  # The marker runs INSIDE the detached block, reading the temp file there; the
  # parent only drains stdin and writes the temp file.
  $marker = ""
  if ($AgentType -eq "codex_cli") {
    $marker = "  " + $script:ApPsMarkerPiece + "`n"
  }
  # The template, and the pieces that fill it, are the generator's text (see above);
  # each hole is filled by one plain substitution.
  $command = $script:ApPsCommandTemplate + "`n"
  $command = $command.Replace('@@AP_HEADER_FILE@@', $headerFile)
  $command = $command.Replace('@@AP_PRELUDE@@', $script:ApPsPreludePiece)
  $command = $command.Replace('@@AP_MARKER@@', $marker)
  $command = $command.Replace('@@AP_GATE@@', $script:ApPsGatePiece)
  $command = $command.Replace('@@AP_AUTH_ARG@@', $authArg)
  $command = $command.Replace('@@AP_URL@@', $url)
  $command = $command.Replace('@@AP_AGENT@@', $AgentType)
  return $command
}

# ConvertTo-Json writes ', <, > and & as \uXXXX and leaves other non-ASCII
# characters raw; the TypeScript and shell writers do the opposite (those four
# raw, every character outside space..~ as a lowercase \uXXXX). Normalise to the
# shared form so the same hooks compare equal across installers and Codex isn't
# asked to approve them again. Never executed on Windows by anything in this change.
function ConvertTo-ApHooksJson {
  param([Parameter(Mandatory = $true)][object]$Data)
  $json = $Data | ConvertTo-Json -Depth 100
  $json = [regex]::Replace($json, '\\u(0027|003c|003e|0026)', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }, 'IgnoreCase')
  $json = [regex]::Replace($json, '[^\x20-\x7e\r\n]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return $json + "`n"
}

function New-ApCodexHooksFile {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct
  )
  $codexEvents = @("SessionStart","SessionEnd","PreToolUse","PostToolUse","UserPromptSubmit","Stop","Interrupt","SubagentStart","SubagentStop","PermissionRequest","PreCompact","PostCompact")
  $hooks = [ordered]@{}
  foreach ($event in $codexEvents) {
    $cmd = New-ApHookCommand -BaseUrl $BaseUrl -Direct $Direct -AgentType "codex_cli" -EventName $event
    $hooks[$event] = @(
      [ordered]@{
        hooks = @(
          [ordered]@{ type = "command"; command = $cmd; async = $false; timeout = 1 }
        )
      }
    )
  }
  $obj = [ordered]@{ hooks = $hooks }
  return ConvertTo-ApHooksJson -Data $obj
}

# Merging AgentPulse's Codex hooks into an existing hooks.json (the sh copy is
# ap_codex_merge_hooks_json, the reference is mergeCodexHooksFile in
# src/shared/hook-command.ts; scripts/codex-hooks-merge.test.ts holds the
# markers and the flow to the same text by reading). A handler is AgentPulse's
# when its "command" contains BOTH /api/v1/hooks?event= and X-Agent-Type; every
# other handler, event and top-level key stays where it is, in the same order.
# Duplicate keys in the existing file keep only the last one, in every copy.
# Returns a hashtable: Status is "changed" (Text is the file to write),
# "unchanged", "unusable" (Reason says why; the file must be left alone) or
# "needs-pwsh7" (this PowerShell cannot do the comparison; leave the file alone).
# An absent or empty file needs no merge and works on every PowerShell.
#
# Other tools' bytes are never altered. ConvertFrom-Json changes some values
# (ISO-date strings become DateTime, large or fractional numbers are re-typed,
# ConvertTo-Json truncates past its depth), so before anything is written the
# parsed file is serialised again and compared, through one JSON writer
# (System.Text.Json), with the original text; any difference at all makes the file
# unusable. Objects are ordinal-comparer ordered dictionaries, so "Stop" and
# "stop", or "command" and "Command", never collapse.
# Never executed on Windows by anything in this change.
function ConvertTo-ApOrdered {
  param([AllowNull()]$Value)
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $o = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
    foreach ($p in $Value.PSObject.Properties) { $o[$p.Name] = ConvertTo-ApOrdered $p.Value }
    return $o
  }
  if ($Value -is [System.Collections.IList]) {
    $items = New-Object System.Collections.ArrayList
    foreach ($i in $Value) { [void]$items.Add((ConvertTo-ApOrdered $i)) }
    return ,($items.ToArray())
  }
  return $Value
}

# The comparison below needs System.Text.Json.Nodes (.NET 6+, PowerShell 7.2+);
# Windows PowerShell 5.1 does not have it, and a missing type only fails at the
# moment it is used. So the types are touched ONLY inside this function and
# Get-ApCanonicalJson, each within try/catch, and Merge-ApCodexHooksFile asks
# here first: where this says no, an existing hooks.json is left alone.
function Test-ApJsonNodesAvailable {
  $v = $PSVersionTable.PSVersion
  if ($v.Major -lt 7 -or ($v.Major -eq 7 -and $v.Minor -lt 2)) { return $false }
  try {
    [void][System.Text.Json.Nodes.JsonNode]::Parse('{}')
    return $true
  } catch {
    return $false
  }
}

function Get-ApCanonicalJson {
  param([string]$Text)
  try { return [System.Text.Json.Nodes.JsonNode]::Parse($Text).ToJsonString() } catch { return $null }
}

function Test-ApAgentPulseHandler {
  param([AllowNull()]$Handler)
  return ($Handler -is [System.Collections.IDictionary]) -and $Handler.Contains('command') -and ($Handler['command'] -is [string]) -and $Handler['command'].Contains('/api/v1/hooks?event=') -and $Handler['command'].Contains('X-Agent-Type')
}

function Merge-ApCodexHooksFile {
  param(
    [AllowNull()][string]$Existing,
    [Parameter(Mandatory = $true)][string]$Ours
  )
  if ($null -eq $Existing -or $Existing.Trim() -eq '') {
    return @{ Status = 'changed'; Text = $Ours }
  }
  if (-not (Test-ApJsonNodesAvailable)) {
    return @{ Status = 'needs-pwsh7' }
  }
  $oursHooks = (ConvertTo-ApOrdered (ConvertFrom-Json $Ours))['hooks']
  try {
    $doc = ConvertTo-ApOrdered (ConvertFrom-Json $Existing)
  } catch {
    return @{ Status = 'unusable'; Reason = 'is not valid JSON' }
  }
  if ($doc -isnot [System.Collections.Specialized.OrderedDictionary]) {
    return @{ Status = 'unusable'; Reason = 'is not a JSON object' }
  }
  if ($doc.Contains('hooks') -and ($doc['hooks'] -isnot [System.Collections.Specialized.OrderedDictionary])) {
    return @{ Status = 'unusable'; Reason = 'has a "hooks" entry that is not an object' }
  }
  $before = ConvertTo-ApHooksJson -Data $doc
  $canonicalExisting = Get-ApCanonicalJson -Text $Existing
  if ($null -eq $canonicalExisting -or $canonicalExisting -cne (Get-ApCanonicalJson -Text $before)) {
    return @{ Status = 'unusable'; Reason = 'has content that cannot be kept exactly as written' }
  }
  $hooks = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
  if ($doc.Contains('hooks')) {
    foreach ($k in @($doc['hooks'].Keys)) { $hooks[$k] = $doc['hooks'][$k] }
  }
  foreach ($event in @($oursHooks.Keys)) {
    if ($hooks.Contains($event) -and ($hooks[$event] -isnot [System.Array])) {
      return @{ Status = 'unusable'; Reason = "has a non-list `"$event`" entry" }
    }
  }
  foreach ($event in @($hooks.Keys)) {
    $groups = $hooks[$event]
    if ($groups -isnot [System.Array]) { continue }
    $kept = New-Object System.Collections.ArrayList
    $slot = -1
    foreach ($g in $groups) {
      $handlers = $null
      if ($g -is [System.Collections.IDictionary] -and $g.Contains('hooks')) { $handlers = $g['hooks'] }
      $hasOurs = $false
      if ($handlers -is [System.Array]) {
        foreach ($h in $handlers) { if (Test-ApAgentPulseHandler -Handler $h) { $hasOurs = $true } }
      }
      if (-not $hasOurs) { [void]$kept.Add($g); continue }
      if ($slot -eq -1) { $slot = $kept.Count }
      $rest = @($handlers | Where-Object { -not (Test-ApAgentPulseHandler -Handler $_) })
      if ($rest.Count -gt 0) {
        $g2 = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
        foreach ($k in @($g.Keys)) { $g2[$k] = $g[$k] }
        $g2['hooks'] = $rest
        [void]$kept.Add($g2)
      }
    }
    $pos = if ($slot -eq -1) { $kept.Count } else { $slot }
    if ($oursHooks.Contains($event)) {
      $kept.InsertRange($pos, [object[]]$oursHooks[$event])
    }
    if ($kept.Count -gt 0 -or $slot -eq -1) { $hooks[$event] = $kept.ToArray() } else { $hooks.Remove($event) }
  }
  foreach ($event in @($oursHooks.Keys)) {
    if (-not $hooks.Contains($event)) { $hooks[$event] = $oursHooks[$event] }
  }
  $doc['hooks'] = $hooks
  $after = ConvertTo-ApHooksJson -Data $doc
  if ($after -ceq $before) { return @{ Status = 'unchanged' } }
  return @{ Status = 'changed'; Text = $after }
}

# The POSIX `sh` equivalent of New-ApHookCommand, built natively in PowerShell
# (never shells out to bash) from the generator's template — Copilot's
# agentpulse.json carries both a `bash` and a `powershell` handler per event, and
# this builds the former. Copilot only: no Codex marker here (compare
# buildBashHookCommand's `agent === "codex_cli"` check).
function New-ApCopilotBashHookCommand {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct,
    [Parameter(Mandatory = $true)][string]$EventName
  )
  $curl = "curl -sS --max-time 2 -o /dev/null -X POST '$BaseUrl/api/v1/hooks?event=$EventName' -H 'Content-Type: application/json' -H 'X-Agent-Type: copilot_cli'"
  $withHeader = "$curl" + " -H `"@`$f`" --data-binary `"@`$t`""
  $withoutHeader = "$curl --data-binary `"@`$t`""
  $send = if ($Direct) {
    "f=`"`$HOME/.agentpulse/hook-auth-header`"; if [ -s `"`$f`" ]; then $withHeader; else $withoutHeader; fi"
  } else {
    "$withoutHeader"
  }
  $command = $script:ApShCommandTemplate
  $command = $command.Replace('@@AP_MARKER@@', '')
  $command = $command.Replace('@@AP_GATE@@', $script:ApShGatePiece)
  $command = $command.Replace('@@AP_SEND@@', $send)
  return $command
}

function New-ApCopilotHooksFile {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct
  )
  $copilotEvents = @("sessionStart","sessionEnd","userPromptSubmitted","postToolUse","postToolUseFailure","agentStop","subagentStart","subagentStop","preCompact","errorOccurred")
  $hooks = [ordered]@{}
  foreach ($event in $copilotEvents) {
    $bash = New-ApCopilotBashHookCommand -BaseUrl $BaseUrl -Direct $Direct -EventName $event
    $ps = New-ApHookCommand -BaseUrl $BaseUrl -Direct $Direct -AgentType "copilot_cli" -EventName $event
    $hooks[$event] = @(
      [ordered]@{ type = "command"; bash = $bash; powershell = $ps; timeoutSec = 5 }
    )
  }
  $obj = [ordered]@{ version = 1; hooks = $hooks }
  return ConvertTo-ApHooksJson -Data $obj
}

# F233 (xander, Medium): true for a symlink OR a junction/mount-point
# reparse point at $Path — `.LinkType` alone misses some reparse-point
# kinds (e.g. a mount point has no LinkType but does carry the
# ReparsePoint attribute), so both are checked. A missing path (the common
# case — nothing to refuse) returns $false, not an error.
function Test-ApReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $false }
  if ($item.LinkType) { return $true }
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# F242 (xander, re-verify): true when $Path already has more than one hard
# link — a second directory entry pointing at the same NTFS data stream,
# which `fsutil hardlink list` enumerates without needing elevation (it's
# a read-only query). Best-effort: `fsutil` can be missing, blocked by
# policy, or fail on a non-NTFS volume — any of that fails OPEN (returns
# $false) rather than blocking a legitimate install, since the caller's
# reparse-point check plus the temp-file+Move-Item replace pattern (which
# never writes into the target's existing data stream in place) are
# already the primary defense. This is the one part of F242 not verified
# against a real Windows machine in this environment — Windows CI
# (scripts/test-install-local.ps1) is the real check; flag to xander if it
# proves unreliable there.
function Test-ApMultipleHardLinks {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $output = & fsutil hardlink list $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) { return $false }
    $count = @($output | Where-Object { $_.Trim().Length -gt 0 }).Count
    return $count -gt 1
  } catch {
    return $false
  }
}

# F232 (xander, Medium): writes $Content to $Path via a same-directory temp
# file + atomic Move-Item, refusing a reparse point (symlink/junction) at
# $Path or at its parent directory — never a plain Set-Content/Copy-Item,
# both of which write through a reparse point at the destination. Used for
# both a Codex/Copilot hooks.json write and its timestamped backup (same
# primitive, different path) — mirrors ap_write_no_follow in the bash
# installers (scripts/setup-hooks.sh et al). F242: also refuses a
# multiply-hard-linked target — see Test-ApMultipleHardLinks above.
function Write-ApFileNoFollow {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  if (Test-ApReparsePoint -Path $Path) {
    throw "refusing to write through a reparse point: $Path"
  }
  if (Test-ApMultipleHardLinks -Path $Path) {
    throw "refusing to write through a multiply-linked file: $Path"
  }
  $dir = Split-Path -Parent $Path
  if (Test-ApReparsePoint -Path $dir) {
    throw "refusing to write into a reparse-point directory: $dir"
  }
  $tmp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  # Written through .NET with an explicit no-BOM encoding: Windows PowerShell 5.1's own UTF8
  # encoding for Set-Content adds a byte order mark, and the installed check would then
  # differ from the generated text.
  [System.IO.File]::WriteAllText($tmp, $Content, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -Force -Path $tmp -Destination $Path
}

# D13: writes ~/.agentpulse/hook-auth-header with a single-ACE ACL for the
# current user (Windows equivalent of `umask 077`).
#
# F208: narrow the parent .agentpulse directory's ACL to the current user
# *before* creating the file inside it, so a freshly-created file inherits
# a private ACL from the instant it exists. Set-Content-then-icacls-the-
# file alone (the prior shape) left a window where a newly (over)written
# file briefly held the directory's broader, inherited ACL before icacls
# narrowed it. The file-level icacls call stays too, so re-running this
# against a pre-existing file (from before this fix, or one an operator
# copied in some other way) still ends up narrowed, not just new ones.
#
# F233 (xander, Medium): neither the directory nor the file had a
# reparse-point guard — a junction at .agentpulse, or a symlink at
# hook-auth-header itself, could redirect the API key to an
# attacker-chosen location. Checked before either write, same as the bash
# installers' `[ -L "$AP_AUTH_HEADER_FILE" ]` guard. F242: also refuses a
# multiply-hard-linked target file — see Test-ApMultipleHardLinks above.
#
# AGEN-21: both icacls calls are best-effort — a missing/
# blocked icacls (non-NTFS volume, policy restriction) must not crash the
# install over an ACL that couldn't be verified. Matches Write-ApPrivateFile
# below and private-file.ts's tightenWindowsAclBestEffort on the TS side. A
# failure is not silent, though: see Write-ApAclWarning.
function New-ApHookAuthHeaderFile {
  param([Parameter(Mandatory = $true)][string]$ApiKey)
  $d = Join-Path $HOME ".agentpulse"
  if (Test-ApReparsePoint -Path $d) {
    throw "refusing to write through a reparse point: $d"
  }
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  try {
    $icaclsOutput = icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
    Remove-ApOtherAces -Path $d
  } catch {
    Write-ApAclWarning -Path $d -Detail $_.Exception.Message
  }
  $f = Join-Path $d "hook-auth-header"
  if (Test-ApMultipleHardLinks -Path $f) {
    throw "refusing to write through a multiply-linked file: $f"
  }
  if (Test-ApReparsePoint -Path $f) {
    throw "refusing to write through a reparse point: $f"
  }
  Set-Content -NoNewline -Path $f -Value "Authorization: Bearer $ApiKey`n" -Encoding UTF8
  try {
    $icaclsOutput = icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
    Remove-ApOtherAces -Path $f
  } catch {
    Write-ApAclWarning -Path $f -Detail $_.Exception.Message
  }
}

# The shell check as written to disk: the placeholders become the real tab,
# carriage return and byte order mark, then any CRLF a checkout introduced is
# normalised to LF (the script must be LF-only for sh).
function Get-ApExcludeBashScriptText {
  return ($script:ApExcludeBashScript + "`n").Replace('@@AP_TAB@@', [string][char]9).Replace('@@AP_CR@@', [string][char]13).Replace('@@AP_BOM@@', [string][char]0xFEFF).Replace("`r`n", "`n")
}

# Installs (or refreshes) ~/.agentpulse/exclude-check.sh and exclude-check.ps1,
# the checks every hook command runs when a rules file exists. Written through
# Write-ApFileNoFollow (temp file, atomic move, never through a reparse point). A
# directory that is a link, or a target that can't be written, prints a warning and
# installs nothing: the hooks still send as before until a rules file exists, and
# with one present they send nothing until the checks are installed. Never executed
# on Windows by anything in this change.
function Install-ApExcludeScripts {
  $dir = Join-Path $HOME ".agentpulse"
  if (Test-ApReparsePoint -Path $dir) {
    Write-Host "! Exclusion check not installed: $dir is a link; remove it and run this again."
    return
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $files = @(
    @{ Path = (Join-Path $dir "exclude-check.sh"); Content = (Get-ApExcludeBashScriptText) },
    @{ Path = (Join-Path $dir "exclude-check.ps1"); Content = ($script:ApExcludePsScript + "`n") }
  )
  foreach ($file in $files) {
    try {
      Write-ApFileNoFollow -Path $file.Path -Content $file.Content
      if ([System.IO.File]::ReadAllText($file.Path, (New-Object System.Text.UTF8Encoding($false))) -ne $file.Content) {
        Remove-Item -LiteralPath $file.Path -Force -ErrorAction SilentlyContinue
        Write-Host "! Exclusion check not installed: what was written to $($file.Path) could not be verified; run this again."
        return
      }
    } catch {
      Write-Host "! Exclusion check not installed: $($_.Exception.Message)"
      return
    }
  }
  Write-Step "Exclusion check installed: $dir"
}
# <<< agentpulse-hook-cmd

# Narrowing an ACL is best-effort (restricted and non-NTFS volumes), but a
# failure must never be silent: until it is fixed, other local users may be
# able to read what was just written there.
function Write-ApAclWarning {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Detail
  )
  Write-Warning "Could not restrict access to $Path ($Detail). Other local users may be able to read the API key or credentials stored there."
}

# `icacls /inheritance:r /grant:r <user>` drops inherited entries and replaces
# that user's own entry, but any other entry set directly on the path survives:
# a directory that already allows Users stays readable by Users. This removes
# those too, so the path ends up with the current user's entry alone. Each step
# only takes access away. If the current user has no entry (the grant above went
# to a different name), it does nothing rather than risk a lockout, and warns.
function Remove-ApOtherAces {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $apMe = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $apAllowSids = @(
      (Get-Acl -LiteralPath $Path).Access |
        Where-Object { $_.AccessControlType.ToString() -eq 'Allow' } |
        ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } |
        Select-Object -Unique
    )
    if ($apAllowSids -notcontains $apMe) {
      throw "the current user has no entry on it"
    }
    foreach ($apSid in $apAllowSids) {
      if ($apSid -eq $apMe) { continue }
      $icaclsOutput = icacls $Path /remove:g "*$apSid" 2>&1
      if ($LASTEXITCODE -ne 0) {
        throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
      }
    }
  } catch {
    Write-ApAclWarning -Path $Path -Detail $_.Exception.Message
  }
}

# AGEN-21 (security, Medium): .env.local and supervisor.json both hold
# secrets in plaintext (AGENTPULSE_INITIAL_API_KEY, and the supervisor
# credential/enrollment token respectively) and were previously written via
# plain Set-Content/Set-JsonFile — no reparse-point guard, and node's/
# PowerShell's mode bits don't narrow the ACL other local Windows accounts
# hold on the file. Write-ApPrivateFile reuses Write-ApFileNoFollow (the
# same reparse-point-safe primitive as the Codex/Copilot hooks writers
# above) then narrows the ACL to the current user only, mirroring
# New-ApHookAuthHeaderFile's `icacls ... /inheritance:r /grant:r
# "user:(R,W)"`. Kept outside the agentpulse-hook-cmd marker block above:
# it isn't part of the cross-file hook-install parity that block tracks.
#
# AGEN-21 (xander, High): narrows the parent directory's ACL *before*
# Write-ApFileNoFollow creates the file inside it — same F208 ordering as
# New-ApHookAuthHeaderFile. Directory-then-file (the prior shape) left a
# window where a freshly-created file briefly held the directory's
# broader, inherited ACL before the file-level icacls call narrowed it.
# Every icacls call is best-effort: a missing/blocked icacls (non-NTFS
# volume, policy restriction) must not fail the install over an ACL that
# couldn't be verified — matches Test-ApMultipleHardLinks's precedent and
# private-file.ts's tightenWindowsAclBestEffort on the TS side.
function Write-ApPrivateFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $dir = Split-Path -Parent $Path
  if (Test-ApReparsePoint -Path $dir) {
    throw "refusing to write into a reparse-point directory: $dir"
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  try {
    $icaclsOutput = icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
    Remove-ApOtherAces -Path $dir
  } catch {
    Write-ApAclWarning -Path $dir -Detail $_.Exception.Message
  }
  Write-ApFileNoFollow -Path $Path -Content $Content
  try {
    $icaclsOutput = icacls $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
    Remove-ApOtherAces -Path $Path
  } catch {
    Write-ApAclWarning -Path $Path -Detail $_.Exception.Message
  }
}

function Write-ApPrivateJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Data
  )
  Write-ApPrivateFile -Path $Path -Content ($Data | ConvertTo-Json -Depth 20)
}

function Configure-Hooks {
  Write-Step "Configuring Claude Code + Codex hooks..."

  # AGEN-49/H2 (xander): Claude Code's native HTTP hook expands
  # $env:AGENTPULSE_API_KEY from ITS OWN process environment, not the shell
  # that launched Claude Code — a GUI, IDE, or stale-terminal launch never
  # has HKCU\Environment's value in its process env either (that's set for
  # NEW processes launched after SetEnvironmentVariable("User", ...), not
  # ones already running), so the env-var form 401s silently there. This
  # installer has no project-scope option (it always targets $HOME), so a
  # supplied key gets the literal, more-reliable form — acceptable because
  # settings.json gets a single-ACE, user-only ACL below (icacls), never
  # broadly readable. No key at all keeps the env-var/allowedEnvVars form.
  $hookHeadersClaude = @{ "X-Agent-Type" = "claude_code"; "X-AgentPulse-Skip" = '$AGENTPULSE_SKIP' }
  if ($ApiKey) {
    $hookHeadersClaude["Authorization"] = "Bearer $ApiKey"
  }
  # Claude Code expands a header variable only for names listed in
  # allowedEnvVars, so the skip variable is listed in every form.
  $allowedEnvVars = @("AGENTPULSE_SKIP")
  if (-not $ApiKey) { $allowedEnvVars = @("AGENTPULSE_API_KEY", "AGENTPULSE_SKIP") }

  $claudeDir = Join-Path $HOME ".claude"
  $claudeSettings = Join-Path $claudeDir "settings.json"
  # F249 ordering: refuse a reparse point at the parent BEFORE Ensure-Dir
  # even runs (a directory create against an already-reparse-point path is
  # a silent no-op success), then refuse one at the file itself before any
  # read/write. settings.json holds other user settings we must preserve,
  # so this can't just delegate to New-ApHookAuthHeaderFile (which
  # overwrites the whole file).
  if (Test-ApReparsePoint -Path $claudeDir) {
    throw "refusing to write through a reparse point: $claudeDir"
  }
  Ensure-Dir $claudeDir
  if (Test-ApReparsePoint -Path $claudeSettings) {
    throw "refusing to write through a reparse point: $claudeSettings"
  }
  $claudeData = @{}
  if (Test-Path $claudeSettings) {
    $existing = Get-Content $claudeSettings -Raw | ConvertFrom-Json -AsHashtable
    if ($existing) { $claudeData = $existing }
  }
  if (-not $claudeData.ContainsKey("hooks")) {
    $claudeData["hooks"] = @{}
  }
  foreach ($eventName in @("SessionStart","SessionEnd","PreToolUse","PostToolUse","Stop","SubagentStart","SubagentStop","TaskCreated","TaskCompleted","UserPromptSubmit","PermissionRequest","PermissionDenied","Notification","PreCompact","PostCompact","PostToolUseFailure")) {
    $hook = @{
      matcher = ""
      hooks = @(@{
        type = "http"
        url = "$PublicUrl/api/v1/hooks"
        async = $true
        headers = $hookHeadersClaude
      })
    }
    $hook.hooks[0]["allowedEnvVars"] = $allowedEnvVars
    $claudeData["hooks"][$eventName] = @($hook)
  }
  Set-JsonFile -Path $claudeSettings -Data $claudeData
  if ($ApiKey) {
    # H2: a literal key is embedded above, so settings.json is narrowed to
    # a single ACE for the current user — never inherited/broadly readable.
    # AGEN-21 (xander, Medium): best-effort, matching every other icacls
    # call site — a missing/blocked icacls must not crash the install.
    try {
      $icaclsOutput = icacls $claudeSettings /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1
      if ($LASTEXITCODE -ne 0) {
        throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
      }
      Remove-ApOtherAces -Path $claudeSettings
    } catch {
      Write-ApAclWarning -Path $claudeSettings -Detail $_.Exception.Message
    }
  }

  # D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
  # $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
  $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  Ensure-Dir $codexDir
  $codexHooksFile = Join-Path $codexDir "hooks.json"

  if ($ApiKey) {
    New-ApHookAuthHeaderFile -ApiKey $ApiKey
  }
  Install-ApExcludeScripts

  $newCodexHooksJson = New-ApCodexHooksFile -BaseUrl $PublicUrl -Direct $true
  $existingCodexHooksJson = $null
  $codexReadFailed = $false
  if (Test-Path $codexHooksFile) {
    try {
      $existingCodexHooksJson = Get-Content $codexHooksFile -Raw -ErrorAction Stop
      if ($null -eq $existingCodexHooksJson) { $existingCodexHooksJson = "" }
    } catch {
      $codexReadFailed = $true
    }
  }
  $codexSkipTail = "It was left untouched. To add the AgentPulse hooks, fix or move that file and run this installer again."
  if ($codexReadFailed) {
    $codexMerge = @{ Status = "unreadable" }
  } else {
    $codexMerge = Merge-ApCodexHooksFile -Existing $existingCodexHooksJson -Ours $newCodexHooksJson
  }
  if ($codexMerge.Status -eq "unchanged") {
    Write-Step "Codex hooks unchanged — no re-trust needed"
  } elseif (Test-ApReparsePoint -Path $codexHooksFile) {
    throw "refusing to write through a reparse point: $codexHooksFile"
  } elseif ($codexMerge.Status -eq "unreadable") {
    Write-Host "! Codex hooks not updated: $codexHooksFile could not be read. $codexSkipTail"
  } elseif ($codexMerge.Status -eq "needs-pwsh7") {
    Write-Host "! Codex hooks not updated: merging needs PowerShell 7.2 or later; $codexHooksFile was left untouched. Install PowerShell 7 and run this installer again."
  } elseif ($codexMerge.Status -eq "unusable") {
    Write-Host "! Codex hooks not updated: $codexHooksFile $($codexMerge.Reason). $codexSkipTail"
  } else {
    $codexBackupFile = $null
    try {
      if ($null -ne $existingCodexHooksJson) {
        $codexBackupFile = "$codexHooksFile.agentpulse-bak.$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
        Write-ApFileNoFollow -Path $codexBackupFile -Content $existingCodexHooksJson
      }
      Write-ApFileNoFollow -Path $codexHooksFile -Content $codexMerge.Text
      $codexWritten = $true
    } catch {
      $codexWritten = $false
      if ($codexBackupFile) { Remove-Item -LiteralPath $codexBackupFile -Force -ErrorAction SilentlyContinue }
      Write-Host "! Codex hooks not updated: $codexHooksFile could not be written ($($_.Exception.Message)). $codexSkipTail"
    }
    if ($codexWritten) {
      if ($codexBackupFile) {
        $script:CodexHooksWritten = "updated"
        Write-Step "Backed up existing Codex hooks to $codexBackupFile"
      }
      Write-Step "Codex CLI hooks configured"
      Write-Step "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
      Write-Step "Re-trust after changing the AgentPulse URL or port."
      if ($script:CodexHooksWritten -ne "updated") { $script:CodexHooksWritten = "new" }
    }
  }
  Write-Step "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"
  # D12: codex_hooks is a deprecated (but still-working) legacy alias for
  # [features].hooks — left alone if present, never newly written.

  # D8: only written when copilot is detected — never create config for a
  # tool that isn't installed.
  $copilotDetected = (Get-Command copilot -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $HOME ".copilot"))
  if ($copilotDetected) {
    $copilotDir = Join-Path $HOME ".copilot\hooks"
    Ensure-Dir $copilotDir
    $copilotHooksFile = Join-Path $copilotDir "agentpulse.json"

    $newCopilotHooksJson = New-ApCopilotHooksFile -BaseUrl $PublicUrl -Direct $true
    $copilotUnchanged = $false
    if (Test-Path $copilotHooksFile) {
      $existingCopilotHooksJson = Get-Content $copilotHooksFile -Raw
      if ($existingCopilotHooksJson -eq $newCopilotHooksJson) {
        $copilotUnchanged = $true
      }
    }
    if ($copilotUnchanged) {
      Write-Step "Copilot hooks unchanged"
    } else {
      if (Test-Path $copilotHooksFile) {
        $copilotBackupFile = "$copilotHooksFile.agentpulse-bak.$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
        Write-ApFileNoFollow -Path $copilotBackupFile -Content $existingCopilotHooksJson
        Write-Step "Backed up existing Copilot hooks to $copilotBackupFile"
      }
      Write-ApFileNoFollow -Path $copilotHooksFile -Content $newCopilotHooksJson
      Write-Step "Copilot CLI hooks configured"
    }
    Write-Step "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"
  }

  # OpenCode (AGEN-141): set up whenever it is found; nothing here runs opencode.
  # The plugin reads $HOME\.agentpulse\hook-auth-header and the exclude check at send time.
  if ($NoOpenCode -or (Test-ApOcDetected)) {
    [void](Install-ApOpenCode -BaseUrl $PublicUrl -Direct $true -Force ([bool]$OpenCodeForce) -NoOpenCode ([bool]$NoOpenCode))
  }

  # D37/F243 (xander re-verify — "check whether install-local.ps1 persists
  # the key in a user env var or profile, and apply the same principle"):
  # checked. This writes to HKCU\Environment (SetEnvironmentVariable's
  # "User" target), a per-user registry hive — not a plaintext rc FILE.
  # Windows already isolates HKCU\Environment to the owning user's SID via
  # registry ACLs; another local account can't read it the way a
  # world-readable 0644 ~/.zshrc exposes a POSIX key to any local user.
  # That's the same owner-only guarantee D37 moved the POSIX key to
  # ~/.agentpulse/env (0600) to achieve, just via the platform-native
  # mechanism instead — no change needed here.
  if ($ApiKey) {
    [Environment]::SetEnvironmentVariable("AGENTPULSE_API_KEY", $ApiKey, "User")
    [Environment]::SetEnvironmentVariable("AGENTPULSE_URL", $PublicUrl, "User")
  }

  Write-Step "✓ Hooks configured"
}

function New-TaskActionForPowerShell {
  param([string]$ScriptPath)
  New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
}

function Register-OrUpdateTask {
  param(
    [string]$TaskName,
    [string]$ScriptPath,
    [string]$Description
  )
  $action = New-TaskActionForPowerShell -ScriptPath $ScriptPath
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description $Description -Force | Out-Null
}

function Start-TaskNow {
  param([string]$ScriptPath)
  Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$ScriptPath) | Out-Null
}

# Phase 5: every function above is now defined. Dot-sourcing with
# -FunctionsOnly stops here, before the main install flow runs, so tests can
# load New-ApHookCommand / New-ApCodexHooksFile / New-ApHookAuthHeaderFile
# (and the rest) without executing an install.
if ($FunctionsOnly) {
  return
}

Write-Host ""
Write-Host "  AgentPulse Local Install"
Write-Host "  ────────────────────────"
Write-Host "  Repo:       $Repo ($Ref)"
Write-Host "  Install:    $Dir"
Write-Host "  Data:       $DataDir"
Write-Host "  URL:        $PublicUrl"
Write-Host "  Hooks:      $(-not $SkipHooks)"
Write-Host "  Supervisor: $(-not $SkipSupervisor)"
Write-Host ""

$git = Ensure-Command git
$bun = Ensure-Bun
Ensure-Dir ([System.IO.Path]::GetDirectoryName($Dir))
Ensure-Dir $DataDir
Ensure-Dir $AgentPulseDir
Ensure-Dir $LogDir

if (Test-Path (Join-Path $Dir ".git")) {
  Write-Step "Updating existing checkout..."
  & $git -C $Dir fetch --tags origin
  & $git -C $Dir checkout $Ref
  try { & $git -C $Dir pull --ff-only origin $Ref } catch {}
} else {
  Write-Step "Cloning repository..."
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  & $git clone --branch $Ref --single-branch $Repo $Dir
}

Set-Location $Dir

Write-Step "Installing dependencies..."
& $bun install

Write-Step "Building application..."
& $bun run build

# AGEN-21: was a bare `Set-Content` — no reparse-point guard, and .env.local
# holds AGENTPULSE_INITIAL_API_KEY in plaintext. Write-ApPrivateFile writes
# it reparse-point-safe and ACL-narrowed to the current user only.
$envFileContent = @"
PORT=$Port
HOST=$HostName
PUBLIC_URL=$PublicUrl
DISABLE_AUTH=$DisableAuth
AGENTPULSE_INITIAL_API_KEY=$ApiKey
DATA_DIR=$DataDir
SQLITE_PATH=$DataDir\agentpulse.db
NODE_ENV=production
"@
Write-ApPrivateFile -Path $EnvFile -Content $envFileContent
Write-Step "✓ Wrote $EnvFile"

$serverScript = Join-Path $AgentPulseDir "start-agentpulse-server.ps1"
$supervisorScript = Join-Path $AgentPulseDir "start-agentpulse-supervisor.ps1"
$serverLog = Join-Path $LogDir "agentpulse.out.log"
$serverErr = Join-Path $LogDir "agentpulse.err.log"
$supervisorLog = Join-Path $LogDir "supervisor.out.log"
$supervisorErr = Join-Path $LogDir "supervisor.err.log"

@"
`$env:PORT = "$Port"
`$env:HOST = "$HostName"
`$env:PUBLIC_URL = "$PublicUrl"
`$env:DISABLE_AUTH = "$DisableAuth"
`$env:AGENTPULSE_INITIAL_API_KEY = "$ApiKey"
`$env:DATA_DIR = "$DataDir"
`$env:SQLITE_PATH = "$DataDir\agentpulse.db"
`$env:NODE_ENV = "production"
Set-Location "$Dir"
& "$bun" run start *>> "$serverLog" 2>> "$serverErr"
"@ | Set-Content -Path $serverScript -Encoding UTF8

Register-OrUpdateTask -TaskName $ServerTask -ScriptPath $serverScript -Description "AgentPulse local server"
Start-TaskNow -ScriptPath $serverScript
Write-Step "✓ Scheduled local server"

Write-Host ""
Write-Step "Waiting for AgentPulse to start..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-RestMethod "$PublicUrl/api/v1/health" | Out-Null
    $healthy = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $healthy) {
  throw "AgentPulse was installed but the health check did not pass in time."
}

Write-Step "✓ AgentPulse is running at $PublicUrl"
Write-Host ""

$supervisorEnrollmentToken = ""
if (-not $SkipSupervisor) {
  if (-not $DisableAuth) {
    if ($ApiKey) {
      Write-Step "Creating local supervisor enrollment token..."
      $resp = Invoke-JsonRequest -Method POST -Url "$PublicUrl/api/v1/supervisors/enroll" -Body @{ name = "local-supervisor" } -Headers @{ Authorization = "Bearer $ApiKey" }
      $supervisorEnrollmentToken = $resp.token
      Write-Step "✓ Enrollment token issued"
    } else {
      Write-Host "  ! Skipping supervisor auto-install because auth is enabled and no -ApiKey was provided."
      Write-Host "    Add a supervisor later from Hosts, or rerun with -ApiKey."
    }
  }

  if ($DisableAuth -or $supervisorEnrollmentToken) {
    $trustedRoot = Join-Path $HOME "dev"
    if (-not (Test-Path $trustedRoot)) { $trustedRoot = $HOME }
    $supervisorConfig = @{}
    if (Test-Path $SupervisorConfigPath) {
      $supervisorConfig = Get-Content $SupervisorConfigPath -Raw | ConvertFrom-Json -AsHashtable
    }
    $supervisorConfig["serverUrl"] = $PublicUrl
    if (-not $supervisorConfig["hostName"]) { $supervisorConfig["hostName"] = $env:COMPUTERNAME }
    if (-not $supervisorConfig["trustedRoots"]) { $supervisorConfig["trustedRoots"] = @($trustedRoot) }
    if ($ApiKey) { $supervisorConfig["apiKey"] = $ApiKey }
    if ($supervisorEnrollmentToken) { $supervisorConfig["enrollmentToken"] = $supervisorEnrollmentToken }
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if ($claude) { $supervisorConfig["claudeCommand"] = $claude.Source }
    if ($codex) { $supervisorConfig["codexCommand"] = $codex.Source }
    # AGEN-21: was Set-JsonFile (plain Set-Content, no reparse-point guard,
    # no ACL narrowing) — supervisor.json holds the supervisor credential /
    # enrollment token in plaintext.
    Write-ApPrivateJsonFile -Path $SupervisorConfigPath -Data $supervisorConfig
    Write-Step "✓ Wrote $SupervisorConfigPath"

    @"
`$env:PORT = "$Port"
`$env:HOST = "$HostName"
`$env:PUBLIC_URL = "$PublicUrl"
`$env:DISABLE_AUTH = "$DisableAuth"
`$env:AGENTPULSE_INITIAL_API_KEY = "$ApiKey"
`$env:DATA_DIR = "$DataDir"
`$env:SQLITE_PATH = "$DataDir\agentpulse.db"
`$env:NODE_ENV = "production"
`$env:HOME = "$HOME"
`$env:PATH = "$([System.IO.Path]::GetDirectoryName($bun));$env:PATH"
Set-Location "$Dir"
& "$bun" run supervisor *>> "$supervisorLog" 2>> "$supervisorErr"
"@ | Set-Content -Path $supervisorScript -Encoding UTF8

    Register-OrUpdateTask -TaskName $SupervisorTask -ScriptPath $supervisorScript -Description "AgentPulse local supervisor"
    Start-TaskNow -ScriptPath $supervisorScript
    Write-Step "✓ Scheduled local supervisor"
    Write-Host ""
  }
}

if (-not $SkipHooks) {
  if ($DisableAuth) {
    Configure-Hooks
  } elseif ($ApiKey) {
    Configure-Hooks
  } else {
    Write-Host "  ! Skipping automatic hook setup because auth is enabled and no -ApiKey was provided."
    Write-Host "    Re-run the installer with -ApiKey to configure hooks automatically."
    Write-Host ""
  }
}

Write-Host "  Local control plane:"
if ($SkipSupervisor) {
  Write-Host "    skipped (-SkipSupervisor)"
} else {
  Write-Host "    enabled"
}
Write-Host "  Open:"
Write-Host "    $PublicUrl"
if ($script:CodexHooksWritten -eq "new") {
  Write-Host ""
  Write-Step "Codex needs you to approve these hooks: run /hooks in Codex."
} elseif ($script:CodexHooksWritten -eq "updated") {
  Write-Host ""
  Write-Step "Codex: open /hooks and approve the updated AgentPulse hooks again; the hook command changed, so Codex asks once more."
}
