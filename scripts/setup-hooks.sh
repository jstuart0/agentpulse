#!/usr/bin/env bash
set -euo pipefail

# AgentPulse Hook Setup Script
# Usage: bash setup-hooks.sh --url https://your-server.com --key ap_xxxxx
# Or:    curl -fsSL --proto '=https' https://your-server.com/setup.sh | bash -s -- --url https://your-server.com --key ap_xxxxx
#
# F234: --key is briefly visible in `ps` during that one-time install.
# Prefer the env-var form instead:
#   AGENTPULSE_KEY=ap_xxxxx curl -fsSL --proto '=https' https://your-server.com/setup.sh | bash -s -- --url https://your-server.com

AGENTPULSE_URL=""
# F234 (Low): --key is briefly visible in `ps` during a curl|bash install —
# seed from $AGENTPULSE_KEY (if exported) so `AGENTPULSE_KEY=ap_xxx bash` is
# a viable alternative; an explicit --key below still overrides it.
AGENTPULSE_KEY="${AGENTPULSE_KEY:-}"
AGENT_TYPE="claude_code"
SCOPE="global"
# D39 (F246): explicit escape hatch for installing against a server that
# isn't reachable yet / whose auth/me can't be probed — otherwise
# ap_check_auth_before_write now refuses by default in that situation.
NO_AUTH_CHECK="0"
# Off by default: --statusline adds the Claude Code statusline (claude_code only).
WITH_STATUSLINE="0"
# Set when Codex hooks were really (re)written, so the closing line can ask the
# user to approve them again.
CODEX_HOOKS_WRITTEN="0"
# OpenCode (AGEN-141): set up whenever it is found; --no-opencode removes our plugins,
# --opencode-force writes the 1.x plugin where OpenCode 1.x has no plugin SDK yet.
OPENCODE_FORCE="0"
NO_OPENCODE="0"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) AGENTPULSE_URL="$2"; shift 2 ;;
    --key) AGENTPULSE_KEY="$2"; shift 2 ;;
    --agent) AGENT_TYPE="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --no-auth-check) NO_AUTH_CHECK="1"; shift ;;
    --statusline) WITH_STATUSLINE="1"; shift ;;
    --opencode-force) OPENCODE_FORCE="1"; shift ;;
    --no-opencode) NO_OPENCODE="1"; shift ;;
    -h|--help)
      echo "AgentPulse Hook Setup"
      echo ""
      echo "Usage: setup-hooks.sh --url <server_url> --key <api_key>"
      echo ""
      echo "Options:"
      echo "  --url    AgentPulse server URL (e.g. https://your-server.com)"
      echo "  --key    API key (starts with ap_). Prefer \$AGENTPULSE_KEY instead:"
      echo "           --key is briefly visible in \`ps\` during a curl|bash install."
      echo "  --agent  Agent type: claude_code (default), codex_cli, copilot_cli, or opencode"
      echo "  --scope  Scope: global (default) or project"
      echo "  --no-auth-check  Skip the auth/me probe — for installing"
      echo "                   against a server that isn't reachable yet or that"
      echo "                   runs with auth disabled but can't be probed."
      echo "  --statusline  Also install the Claude Code statusline (claude_code only;"
      echo "                off by default, never replaces an existing statusLine)"
      echo "  --no-opencode     Remove the OpenCode plugins (OpenCode is set up whenever it is found)"
      echo "  --opencode-force  Write OpenCode 1.x's plugin even where its plugin SDK isn't"
      echo "                    downloaded yet; run it while online (see the message it prints)"
      echo "  -h       Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$AGENTPULSE_URL" ]]; then
  echo "Error: --url is required"
  exit 1
fi

if [[ -z "$AGENTPULSE_KEY" ]]; then
  echo "Error: --key is required"
  exit 1
fi

# >>> agentpulse-hook-cmd
# D13: shared hook-command generators. Byte-identical to buildBashHookCommand/
# buildCodexHooksFile in src/shared/hook-command.ts (verified by
# scripts/hook-command-parity.test.ts) — this exact block also appears
# verbatim in scripts/setup-relay.sh and the /setup.sh template served by
# src/server/routes/setup.ts. Do not hand-edit one copy without the others.

# The OpenCode plugin texts (AGEN-141), with their @@AP_OPENCODE_*@@ holes, written by
# `bun run embed:opencode-plugin`. Do not edit between the markers.
# @@AGENTPULSE_OPENCODE_PLUGIN_1@@ BEGIN
ap_opencode_plugin_1_template() {
cat <<'AP_OPENCODE_PLUGIN_1_EOF'
// agentpulse-opencode-plugin 5aee272898f11e
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
const AP_BUILD = "5aee272898f11e";
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

// An event id is "claimed" (1) while its POST is in flight and "delivered" (2) once the server answered. A claim stops a
// second plugin instance in this process from sending the same event; only a delivery stops the exit flush, so an
// event whose POST never finished is still sent at exit (the server dedupes by delivery id).
const SEEN_CLAIMED = 1;
const SEEN_DELIVERED = 2;

function claimEvent(rec, evt) {
	if (rec.seen.has(evt)) return true;
	lruTouch(rec.seen, evt, SEEN_CLAIMED, SEEN_LIMIT);
	return false;
}

function deliveredEvent(rec, evt) {
	return rec.seen.get(evt) === SEEN_DELIVERED;
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
	if (item.evt !== undefined && claimEvent(rec, item.evt)) {
		rec.counters.droppedSeen += 1;
		return;
	}
	let delivered = false;
	try {
		await acquireSend(rec);
		try {
			delivered = await post(rec, item);
		} finally {
			releaseSend(rec);
		}
	} finally {
		if (item.evt !== undefined) {
			if (delivered) lruTouch(rec.seen, item.evt, SEEN_DELIVERED, SEEN_LIMIT);
			else rec.seen.delete(item.evt);
		}
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
		if (auth === null) return false;
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
		return true;
	} catch {
		rec.counters.failedPosts += 1;
		return false;
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
		const sentNow = new Set();
		for (const st of rec.sessions.values()) {
			for (const item of st.q) {
				const left = deadline - Date.now();
				if (left <= 0) return;
				if (!item.dirs.every((d) => freshVerdict(rec, d))) break;
				if (item.evt !== undefined) {
					if (deliveredEvent(rec, item.evt) || sentNow.has(item.evt)) continue;
					sentNow.add(item.evt);
				}
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
		// An instance that subscribed after the root was created never saw its directory; the instance that claimed it did.
		dirs.push((rootInfo && rootInfo.dir) || rec.claims.get(root));
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

AP_OPENCODE_PLUGIN_1_EOF
}
# @@AGENTPULSE_OPENCODE_PLUGIN_1@@ END
# @@AGENTPULSE_OPENCODE_PLUGIN_2@@ BEGIN
ap_opencode_plugin_2_template() {
cat <<'AP_OPENCODE_PLUGIN_2_EOF'
// agentpulse-opencode-plugin dba966b1d1ad22
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
const AP_BUILD = "dba966b1d1ad22";
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

// An event id is "claimed" (1) while its POST is in flight and "delivered" (2) once the server answered. A claim stops a
// second plugin instance in this process from sending the same event; only a delivery stops the exit flush, so an
// event whose POST never finished is still sent at exit (the server dedupes by delivery id).
const SEEN_CLAIMED = 1;
const SEEN_DELIVERED = 2;

function claimEvent(rec, evt) {
	if (rec.seen.has(evt)) return true;
	lruTouch(rec.seen, evt, SEEN_CLAIMED, SEEN_LIMIT);
	return false;
}

function deliveredEvent(rec, evt) {
	return rec.seen.get(evt) === SEEN_DELIVERED;
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
	if (item.evt !== undefined && claimEvent(rec, item.evt)) {
		rec.counters.droppedSeen += 1;
		return;
	}
	let delivered = false;
	try {
		await acquireSend(rec);
		try {
			delivered = await post(rec, item);
		} finally {
			releaseSend(rec);
		}
	} finally {
		if (item.evt !== undefined) {
			if (delivered) lruTouch(rec.seen, item.evt, SEEN_DELIVERED, SEEN_LIMIT);
			else rec.seen.delete(item.evt);
		}
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
		if (auth === null) return false;
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
		return true;
	} catch {
		rec.counters.failedPosts += 1;
		return false;
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
		const sentNow = new Set();
		for (const st of rec.sessions.values()) {
			for (const item of st.q) {
				const left = deadline - Date.now();
				if (left <= 0) return;
				if (!item.dirs.every((d) => freshVerdict(rec, d))) break;
				if (item.evt !== undefined) {
					if (deliveredEvent(rec, item.evt) || sentNow.has(item.evt)) continue;
					sentNow.add(item.evt);
				}
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
		// An instance that subscribed after the root was created never saw its directory; the instance that claimed it did.
		dirs.push((rootInfo && rootInfo.dir) || rec.claims.get(root));
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

AP_OPENCODE_PLUGIN_2_EOF
}
# @@AGENTPULSE_OPENCODE_PLUGIN_2@@ END

# F245 (High, codex r2 D38): same grammar as assertValidHookBaseUrl() in
# src/shared/hook-command.ts — bare http(s)://host[:port] or
# http(s)://[ipv6][:port], nothing else. The base URL is later embedded
# inside single-quoted curl text in the generated hook command (ap_hook_cmd
# below); a --url containing a quote, space, $(...), or backtick would
# persist as shell code in hooks.json/agentpulse.json and execute on the
# next hook fire. Call before any hook JSON generation at every site.
ap_validate_hook_base_url() {
	local url="$1"
	if [[ "$url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
		return 0
	fi
	if [[ "$url" =~ ^https?://\[[0-9A-Fa-f:]+\](:[0-9]{1,5})?$ ]]; then
		return 0
	fi
	echo "invalid AgentPulse base URL for a hook command: $url" >&2
	return 1
}

# F246 (High, codex r2 D38; tightened by D39): mirrors bin/cli.ts — with no
# key, against a server that requires auth, refuse before writing any
# command hooks. Without this, an auth-enabled server silently 401s every
# hook fire forever: the detached shim discards curl's output on its
# synchronous path by design (D13), so the failure is invisible.
#
# D39: fails CLOSED, not open. A key always skips the probe. With no key,
# only an explicit disableAuth:true in the response lets the install
# proceed — an unreachable server, a non-JSON response (e.g. a proxy's
# HTML error page), or JSON missing the field all refuse now, same as a
# real disableAuth:false. $3=1 (--no-auth-check) is the explicit escape
# hatch for installing before the server is up.
ap_check_auth_before_write() {
	local base="$1" key="$2" skip="${3:-}" body
	if [[ "$skip" == "1" ]]; then
		return 0
	fi
	# AGEN-92: with auth off the server refuses an address it doesn't accept (403 bad_origin), key or no
	# key, and a hook fire would then be dropped silently. The probe runs even when a key is given; any
	# other outcome with a key passes, as before.
	body="$(curl -sS -m 10 "${base}/api/v1/auth/me" 2>/dev/null)" || body=""
	if printf '%s' "$body" | python3 -c '
import json, sys
try:
    me = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if me.get("error") == "bad_origin" else 1)
'; then
		echo "The server refuses this address while authentication is off. Use an IP address or localhost, or add ${base} to PUBLIC_URL on the server." >&2
		return 1
	fi
	if [[ -n "$key" ]]; then
		return 0
	fi
	if printf '%s' "$body" | python3 -c '
import json, sys
try:
    me = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if me.get("disableAuth") is True else 1)
'; then
		return 0
	fi
	echo "This server requires an API key; pass --key (or AGENTPULSE_KEY), or bypass this check if this server runs with auth disabled." >&2
	return 1
}

# F252 (Medium/High, xander D39 re-verify): the inline secret writers
# (hook-auth-header for Codex/Copilot, ~/.agentpulse/env) checked only the
# final path component for a symlink and called mkdir -p BEFORE checking
# — a symlinked ~/.agentpulse parent directory would let mkdir -p silently
# succeed and the secret land wherever the parent symlink points,
# unrefused. Ports F249's ordering: refuse if the parent is a symlink,
# THEN mkdir, THEN refuse if the file itself is a symlink, THEN the
# umask-077 temp write + mv. $2 is the exact file content, including any
# trailing newline the caller wants — printf '%s' writes it verbatim, no
# extra formatting here.
#
# AGEN-21 (xander, High): the old `tmp="${path}.$$.tmp"` is predictable —
# an attacker doesn't need to win any race, just pre-plant a symlink at
# every plausible PID's tmp name before the script ever runs; the old
# `> "$tmp"` then follows straight through it. mktemp's XXXXXX suffix is
# unguessable and O_CREAT|O_EXCL under the hood (atomic — refuses if
# anything, symlink or not, already exists at that exact random path), so
# nothing can be pre-planted at it. The `[ -L "$tmp" ]` check afterward and
# `set -C`'s noclobber are belt-and-suspenders, not the primary defense: an
# environment with no mktemp falls back to a PID+$RANDOM name plus its own
# noclobber create-or-fail (uniqueness, not the atomicity mktemp gives).
ap_write_private_no_follow() {
	local path="$1" content="$2" dir tmp
	dir="$(dirname -- "$path")"
	if [ -L "$dir" ]; then
		echo "refusing to write into a symlinked directory: $dir" >&2
		return 1
	fi
	( umask 077 && mkdir -p "$dir" )
	if [ -L "$path" ]; then
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	if command -v mktemp >/dev/null 2>&1; then
		tmp="$(mktemp "${dir}/.$(basename -- "$path").XXXXXX")" || {
			echo "refusing: could not create a private temp file in $dir" >&2
			return 1
		}
	else
		tmp="${dir}/.$(basename -- "$path").$$.${RANDOM}${RANDOM}.tmp"
		if ! ( umask 077 && set -C && : > "$tmp" ) 2>/dev/null; then
			echo "refusing: could not create a private temp file: $tmp" >&2
			return 1
		fi
	fi
	if [ -L "$tmp" ]; then
		echo "refusing to write through a symlink: $tmp" >&2
		return 1
	fi
	if ! ( set -C && printf '%s' "$content" >| "$tmp" ); then
		echo "refusing: could not write private temp file: $tmp" >&2
		rm -f -- "$tmp" 2>/dev/null || true
		return 1
	fi
	mv -f -- "$tmp" "$path"
}

# The exclusion check: ONE script, ~/.agentpulse/exclude-check.sh, written once by
# ap_install_exclude_script and run by the hook command's gate only when a rules
# file exists (src/shared/hook-command.ts, buildBashExcludeScript). Carried as
# ASCII text with three placeholders for the characters the check needs as real
# bytes (tab, carriage return, byte order mark), so no editor or line-ending
# conversion can change them; restored here.
ap_load_exclude_script() {
	IFS= read -r -d '' ap_exclude_script_text <<'AP_EXCLUDE_SCRIPT_EOF' || true
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
AP_EXCLUDE_SCRIPT_EOF
	ap_exclude_script_text=${ap_exclude_script_text//@@AP_TAB@@/$'\t'}
	ap_exclude_script_text=${ap_exclude_script_text//@@AP_CR@@/$'\r'}
	ap_exclude_script_text=${ap_exclude_script_text//@@AP_BOM@@/$'\xef\xbb\xbf'}
}

# The two pieces of the hook command that carry logic (src/shared/hook-command.ts:
# CODEX_MARKER_SH_PIECE and SH_GATE_PIECE), stored verbatim.
ap_load_hook_pieces() {
	IFS= read -r -d '' ap_marker_piece <<'AP_MARKER_PIECE_EOF' || true
sid=$(grep -o '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9-]*"' "$t" | head -n1); sid=${sid%\"}; sid=${sid##*\"}; case "$sid" in ""|*[!A-Za-z0-9-]*) ;; *) if [ ${#sid} -le 128 ] && [ ! -L "$HOME/.agentpulse/codex-native" ]; then mkdir -p "$HOME/.agentpulse/codex-native" 2>/dev/null; set -C; { :; } 2>/dev/null >"$HOME/.agentpulse/codex-native/$sid"; set +C; fi ;; esac; 
AP_MARKER_PIECE_EOF
	ap_marker_piece=${ap_marker_piece%$'\n'}
	IFS= read -r -d '' ap_gate_piece <<'AP_GATE_PIECE_EOF' || true
w=$(printf ' \t\r\n.'); w=${w%.}; x=${AGENTPULSE_SKIP:-}; y=${x%%[!"$w"]*}; x=${x#"$y"}; y=${x##*[!"$w"]}; x=${x%"$y"}; case $x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; d=$HOME/.agentpulse; g=0; if [ -n "$HOME" ] && [ ! -e "$d/exclude" ] && [ ! -L "$d/exclude" ] && [ ! -e "$d/exclude.invalid" ] && [ ! -L "$d/exclude.invalid" ]; then if [ -d "$d" ] && [ -x "$d" ]; then g=1; elif [ ! -e "$d" ] && [ ! -L "$d" ] && [ -d "$HOME" ] && [ -x "$HOME" ]; then g=1; fi; fi; if [ "$g" != 1 ]; then l=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$d/" "$d/exclude-check.sh" 2>/dev/null) || exit 0; u=$(id -u 2>/dev/null); ap_f() { y=${x%%[!" "]*}; x=${x#"$y"}; y=${x%%" "*}; x=${x#"$y"}; }; ap_v() { x=$1; ap_f; k=${y%[@+.]}; ap_f; ap_f; [ -n "$y" ] && [ "$y" = "$u" ] && case $k in $2[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; n=${w#???}; ap_v "${l%%"$n"*}" d && ap_v "${l#*"$n"}" - && { /bin/sh "$d/exclude-check.sh"; [ $? = 42 ]; } || exit 0; fi; 
AP_GATE_PIECE_EOF
	ap_gate_piece=${ap_gate_piece%$'\n'}
}

# Installs (or refreshes) the check at ~/.agentpulse/exclude-check.sh: atomic
# (temp file in the same directory, then rename), never through a link, mode
# 0500. A missing ~/.agentpulse is created 0700; an existing one is never
# loosened, and is used only when it (or what a symlink resolves to) is a
# directory you own that nobody else can write. Anything else prints a warning
# and installs nothing: hooks still work, and a rules file then makes them send
# nothing (fail closed) until the check is installed.
ap_install_exclude_script() {
	local dir="$HOME/.agentpulse" real tmp perms
	if [ -z "$HOME" ]; then
		echo "! Exclusion check not installed: HOME is not set." >&2
		return 0
	fi
	if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
		if ! ( umask 077 && mkdir "$dir" ) 2>/dev/null; then
			echo "! Exclusion check not installed: could not create $dir." >&2
			return 0
		fi
	fi
	real="$(cd -P "$dir" 2>/dev/null && pwd -P)" || real=""
	perms="$(ls -ld "$real" 2>/dev/null)" || perms=""
	if [ -z "$real" ] || [ ! -d "$real" ] || [ ! -O "$real" ] || [ "${perms:5:1}" != "-" ] || [ "${perms:8:1}" != "-" ]; then
		echo "! Exclusion check not installed: $dir must be a directory you own that nobody else can write." >&2
		return 0
	fi
	if [ -L "$real/exclude-check.sh" ] || [ -d "$real/exclude-check.sh" ]; then
		echo "! Exclusion check not installed: $real/exclude-check.sh is a link or a directory; remove it and run this again." >&2
		return 0
	fi
	if ! command -v mktemp >/dev/null 2>&1; then
		echo "! Exclusion check not installed: mktemp not found." >&2
		return 0
	fi
	ap_load_exclude_script
	# A current copy (same text, mode 0500, ours) is left alone, like the TypeScript installer does.
	if [ -f "$real/exclude-check.sh" ] && [ -O "$real/exclude-check.sh" ] \
		&& [ "$(ls -ld "$real/exclude-check.sh" 2>/dev/null | cut -c1-10)" = "-r-x------" ] \
		&& [ "$(cat "$real/exclude-check.sh" 2>/dev/null)" = "${ap_exclude_script_text%$'\n'}" ]; then
		echo "Exclusion check is current: $real/exclude-check.sh"
		return 0
	fi
	tmp="$(mktemp "$real/.exclude-check.sh.XXXXXX")" || {
		echo "! Exclusion check not installed: could not create a temp file in $real." >&2
		return 0
	}
	if ! printf '%s' "$ap_exclude_script_text" >| "$tmp" || ! chmod 0500 "$tmp"; then
		rm -f -- "$tmp" 2>/dev/null || true
		echo "! Exclusion check not installed: could not write $tmp." >&2
		return 0
	fi
	sync 2>/dev/null || true
	mv -f -- "$tmp" "$real/exclude-check.sh"
	if [ "$(cat "$real/exclude-check.sh" 2>/dev/null)" != "${ap_exclude_script_text%$'\n'}" ]; then
		rm -f -- "$real/exclude-check.sh" 2>/dev/null || true
		echo "! Exclusion check not installed: what was written to $real/exclude-check.sh could not be verified; run this again." >&2
		return 0
	fi
	echo "Exclusion check installed: $real/exclude-check.sh"
}

ap_hook_cmd() {
	# $1=base $2=direct(0/1) $3=agent $4=event
	local base="$1" direct="$2" agent="$3" event="$4"
	local marker="" call_with_header call_without_header send
	ap_load_hook_pieces
	if [ "$agent" = "codex_cli" ]; then
		marker="$ap_marker_piece"
	fi
	call_with_header="curl -sS --max-time 2 -o /dev/null -X POST '${base}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'"' -H "@$f" --data-binary "@$t"'
	call_without_header="curl -sS --max-time 2 -o /dev/null -X POST '${base}/api/v1/hooks?event=${event}' -H 'Content-Type: application/json' -H 'X-Agent-Type: ${agent}'"' --data-binary "@$t"'
	if [ "$direct" = "1" ]; then
		send='f="$HOME/.agentpulse/hook-auth-header"; if [ -s "$f" ]; then '"$call_with_header"'; else '"$call_without_header"'; fi'
	else
		send="$call_without_header"
	fi
	printf '%s' 't=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ( trap '\''rm -f "$t"'\'' EXIT; trap '\''exit 1'\'' HUP INT TERM; '"$marker""$ap_gate_piece""$send"' ) </dev/null >/dev/null 2>&1 & exit 0'
}

ap_codex_hooks_json() {
	# $1=base $2=direct(0/1)
	local base="$1" direct="$2"
	local CODEX_EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "UserPromptSubmit" "Stop" "Interrupt" "SubagentStart" "SubagentStop" "PermissionRequest" "PreCompact" "PostCompact")
	local event
	{
		for event in "${CODEX_EVENTS[@]}"; do
			printf '%s\0%s\0' "$event" "$(ap_hook_cmd "$base" "$direct" "codex_cli" "$event")"
		done
	} | python3 -c '
import json, sys
data = sys.stdin.buffer.read().split(b"\x00")
pairs = [(data[i].decode(), data[i + 1].decode()) for i in range(0, len(data) - 1, 2)]
hooks = {}
for event, cmd in pairs:
    hooks[event] = [{"hooks": [{"type": "command", "command": cmd, "async": False, "timeout": 1}]}]
sys.stdout.write(json.dumps({"hooks": hooks}, indent=2) + "\n")
'
}

# Merges AgentPulse's Codex hooks into an existing hooks.json instead of
# replacing it (src/shared/hook-command.ts mergeCodexHooksFile is the
# reference; scripts/codex-hooks-merge.test.ts holds every copy to it).
# $1 = the hooks.json path, stdin = the file ap_codex_hooks_json generated.
# A handler is AgentPulse's when its "command" contains BOTH /api/v1/hooks?event=
# and X-Agent-Type (every generated command has both); every other handler,
# event and top-level key is kept in place. Other tools' bytes are never
# altered: a number that would not come back as the same text (beyond 15
# digits, 1.0, 1E5, -0, NaN) makes the file unusable. Duplicate keys in the
# existing file keep only the last one, in every copy. Writes nothing itself.
# Exit 0: stdout is the merged file, write it. Exit 3: nothing to change.
# Exit 4: the file is unreadable or not usable JSON of the expected shape; a
# message is printed and the file must be left alone. Exit 1: $1 is a symlink
# and a write would be needed.
ap_codex_merge_hooks_json() {
	local path="$1" ours py out rc=0
	ours="$(cat)"
	IFS= read -r -d '' py <<'AP_MERGE_PY_EOF' || true
import json, os, re, sys
mark = "/api/v1/hooks?event="
header = "X-Agent-Type"
q = chr(34)
path = sys.argv[1]
doc_ours = json.loads(sys.stdin.read())
ours = doc_ours["hooks"]
num_ok = re.compile(r"-?(?:0|[1-9][0-9]{0,14})|-?[1-9][0-9]{0,8}[.][0-9]{0,5}[1-9]|-?0[.][0-9]{0,3}[1-9]")
class Lossy(Exception):
    pass
def keep_number(tok):
    if tok == "-0" or not num_ok.fullmatch(tok):
        raise Lossy()
    return float(tok) if "." in tok else int(tok)
def bad_constant(tok):
    raise ValueError(tok)
def dump(o):
    return json.dumps(o, indent=2).replace(chr(127), chr(92) + "u007f")
def mine(h):
    return isinstance(h, dict) and isinstance(h.get("command"), str) and mark in h["command"] and header in h["command"]
def refuse(reason):
    sys.stderr.write("! Codex hooks not updated: " + path + " " + reason + ". It was left untouched. To add the AgentPulse hooks, fix or move that file and run this installer again." + chr(10))
    sys.exit(4)
raw = None
if os.path.exists(path):
    try:
        raw = open(path, "rb").read()
    except Exception:
        refuse("could not be read")
text = None
if raw is not None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        refuse("is not valid JSON")
if text is None or text.strip() == "":
    sys.stdout.write(dump(doc_ours) + chr(10))
    sys.exit(0)
try:
    json.loads(text, parse_constant=bad_constant)
except (ValueError, RecursionError):
    refuse("is not valid JSON")
try:
    doc = json.loads(text, parse_int=keep_number, parse_float=keep_number)
except Lossy:
    refuse("has a number that cannot be kept exactly as written")
if not isinstance(doc, dict):
    refuse("is not a JSON object")
if "hooks" in doc and not isinstance(doc["hooks"], dict):
    refuse("has a " + q + "hooks" + q + " entry that is not an object")
before = dump(doc)
hooks = dict(doc["hooks"]) if "hooks" in doc else {}
for event in ours:
    if event in hooks and not isinstance(hooks[event], list):
        refuse("has a non-list " + q + event + q + " entry")
for event in list(hooks):
    groups = hooks[event]
    if not isinstance(groups, list):
        continue
    kept = []
    slot = -1
    for g in groups:
        hs = g.get("hooks") if isinstance(g, dict) else None
        if not isinstance(hs, list) or not any(mine(h) for h in hs):
            kept.append(g)
            continue
        if slot == -1:
            slot = len(kept)
        rest = [h for h in hs if not mine(h)]
        if rest:
            g2 = dict(g)
            g2["hooks"] = rest
            kept.append(g2)
    pos = len(kept) if slot == -1 else slot
    kept[pos:pos] = ours.get(event, [])
    if kept or slot == -1:
        hooks[event] = kept
    else:
        del hooks[event]
for event in ours:
    if event not in hooks:
        hooks[event] = ours[event]
doc["hooks"] = hooks
after = dump(doc)
if after == before:
    sys.exit(3)
sys.stdout.write(after + chr(10))
AP_MERGE_PY_EOF
	if [ -L "$path" ]; then
		out="$(printf '%s\n' "$ours" | python3 -c "$py" "$path" 2>/dev/null)" || rc=$?
		if [ "$rc" = "3" ]; then return 3; fi
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	printf '%s\n' "$ours" | python3 -c "$py" "$path"
}

ap_copilot_hooks_json() {
	# $1=base $2=direct(0/1)
	local base="$1" direct="$2"
	local COPILOT_EVENTS=("sessionStart" "sessionEnd" "userPromptSubmitted" "postToolUse" "postToolUseFailure" "agentStop" "subagentStart" "subagentStop" "preCompact" "errorOccurred")
	local event
	{
		for event in "${COPILOT_EVENTS[@]}"; do
			printf '%s\0%s\0' "$event" "$(ap_hook_cmd "$base" "$direct" "copilot_cli" "$event")"
		done
	} | python3 -c '
import json, sys
data = sys.stdin.buffer.read().split(b"\x00")
pairs = [(data[i].decode(), data[i + 1].decode()) for i in range(0, len(data) - 1, 2)]
hooks = {}
for event, cmd in pairs:
    hooks[event] = [{"type": "command", "bash": cmd, "timeoutSec": 5}]
sys.stdout.write(json.dumps({"version": 1, "hooks": hooks}, indent=2) + "\n")
'
}

# F232 (xander, Medium): writes stdin to $1 via a same-directory temp file +
# atomic rename, refusing a symlink at $1 or at $1's parent directory —
# never a plain `>` redirect or `cp`, both of which follow a symlink at the
# destination. Used for both a Codex/Copilot hooks.json write and its
# timestamped backup (same primitive, different path).
#
# AGEN-21 (xander, High): same predictable-tmp-name fix as
# ap_write_private_no_follow above — mktemp's XXXXXX is unguessable and
# atomic (O_CREAT|O_EXCL), closing the pre-planted-symlink attack the old
# `tmp="${path}.$$.tmp"` was open to. See that function's comment for the
# full rationale; not repeated here.
ap_write_no_follow() {
	local path="$1" dir tmp
	if [ -L "$path" ]; then
		echo "refusing to write through a symlink: $path" >&2
		return 1
	fi
	dir="$(dirname -- "$path")"
	if [ -L "$dir" ]; then
		echo "refusing to write into a symlinked directory: $dir" >&2
		return 1
	fi
	if command -v mktemp >/dev/null 2>&1; then
		tmp="$(mktemp "${dir}/.$(basename -- "$path").XXXXXX")" || {
			echo "refusing: could not create a temp file in $dir" >&2
			return 1
		}
	else
		tmp="${dir}/.$(basename -- "$path").$$.${RANDOM}${RANDOM}.tmp"
		if ! ( umask 022 && set -C && : > "$tmp" ) 2>/dev/null; then
			echo "refusing: could not create a temp file: $tmp" >&2
			return 1
		fi
	fi
	if [ -L "$tmp" ]; then
		echo "refusing to write through a symlink: $tmp" >&2
		return 1
	fi
	if ! ( set -C && cat >| "$tmp" ); then
		echo "refusing: could not write temp file: $tmp" >&2
		rm -f -- "$tmp" 2>/dev/null || true
		return 1
	fi
	chmod 0644 "$tmp"
	mv -f -- "$tmp" "$path"
}

# D13/F57: -H "@$f" needs curl >= 7.55 (silently sends no auth below that).
# Only direct-mode sh installers call this — relay mode sends no auth header.
ap_require_curl_755() {
	local ver major minor rest
	ver="$(curl --version 2>/dev/null | head -n1 | sed -nE 's/^curl ([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
	if [ -z "$ver" ]; then
		echo "AgentPulse direct hooks need curl >= 7.55 (curl not found). Upgrade curl or use the relay installer." >&2
		exit 1
	fi
	major="${ver%%.*}"
	rest="${ver#*.}"
	minor="${rest%%.*}"
	if [ "$major" -lt 7 ] || { [ "$major" -eq 7 ] && [ "$minor" -lt 55 ]; }; then
		echo "AgentPulse direct hooks need curl >= 7.55 (found ${ver}). Upgrade curl or use the relay installer." >&2
		exit 1
	fi
}
# <<< agentpulse-hook-cmd

# The OpenCode installer step (AGEN-141), written by `bun run embed:opencode-plugin`
# from scripts/opencode-installer/install.sh. Do not edit between the markers.
# >>> agentpulse-opencode-install
# The OpenCode step of the shell installers (AGEN-141). This file is a template:
# `bun run embed:opencode-plugin` fills the @@AP_OC_*@@ lines from
# src/shared/opencode-plugin.ts and writes the result into setup-hooks.sh and
# setup-relay.sh (between their markers) and into the /setup.sh template.
# The host installer provides ap_opencode_plugin_1_template and
# ap_opencode_plugin_2_template (print the plugin text with its two holes), and
# ap_write_no_follow / ap_write_private_no_follow / ap_validate_hook_base_url.
# It never runs `opencode`.
# In the all-gated layout the force option is remembered in a small file under ~/.agentpulse; only the
# no-opencode option clears it (and it removes the plugins too). Outside that layout nothing is remembered.
AP_OC_SDK_MARKER='node_modules/@opencode-ai/plugin/package.json'
AP_OC_SDK_CONFIG_DEP='"@opencode-ai/plugin"'
AP_OC_SDK_RULE='sdk_present'
AP_OC_SDK_CHECK='marker_only'
AP_OC_FOREIGN_EXTS='js ts'
AP_OC_FOREIGN_OPENS='yes'
AP_OC_LAYOUT='v1_flat_v2_dir'
AP_OC_REMEMBERS_FORCE=0
AP_OC_HEADER_PREFIX='// agentpulse-opencode-plugin '
AP_OC_ENTRIES='agentpulse-opencode-1.js|agentpulse-opencode-1.js|1|1|file
agentpulse-opencode-2|agentpulse-opencode-2/index.js|2|0|dir'
AP_OC_MSG_SKIP='OpenCode 1.x plugin: not installed. OpenCode 1.x downloads its plugin SDK (@opencode-ai/plugin) into <dir> only when it finds a plugin there, and while it can'\''t reach the package registry each start then waits about 70 seconds. It hasn'\''t downloaded the SDK here, so AgentPulse left its 1.x plugin out. To add it, run setup-hooks.sh --opencode-force while this machine is online: OpenCode 1.x downloads the SDK on its next start, and setup keeps the plugin from then on. If you don'\''t use OpenCode 1.x, nothing is needed.'
AP_OC_MSG_FORCE='OpenCode 1.x will download its plugin SDK into <dir> on its next start; until it can reach the package registry, each start waits about 70 seconds.'
AP_OC_NOTE_SERVER_FIRST='Upgrade the AgentPulse server first: an older server stores OpenCode events as ordinary Claude Code sessions.'
AP_OC_NOTE_SERVICE_SKIP='AGENTPULSE_SKIP set in your shell is not seen by a running OpenCode 2 background service; use an exclude rule (agentpulse exclude add <dir>), or stop the service so it restarts with your environment (opencode service stop).'

# ap_oc_gate_open <sdk> <foreign> <force> <remembered>, each 0 or 1: exit 0 when the gated entries are written.
ap_oc_gate_open() {
	[ "$3" = 1 ] && return 0
	[ "$AP_OC_REMEMBERS_FORCE" = 1 ] && [ "$4" = 1 ] && return 0
	[ "$AP_OC_SDK_RULE" = sdk_present ] && [ "$1" = 1 ] && return 0
	[ "$AP_OC_FOREIGN_OPENS" = yes ] && [ "$2" = 1 ] && return 0
	return 1
}

# ap_oc_foreign_plugin_present <plugins dir>: a plain file there that is not a dot file, not ours, and has a listed extension.
ap_oc_foreign_plugin_present() {
	local p="$1" f n e
	[ -d "$p" ] || return 1
	for f in "$p"/*; do
		[ -f "$f" ] || continue
		n="${f##*/}"
		case "$n" in .*|agentpulse-opencode-1.js|agentpulse-opencode-2.js) continue ;; esac
		for e in $AP_OC_FOREIGN_EXTS; do
			case "$n" in ?*."$e") return 0 ;; esac
		done
	done
	return 1
}

# ap_oc_fill <text> <hole> <value>: <text> with every <hole> replaced by <value>, without any pattern or "&" meaning.
ap_oc_fill() {
	local t="$1" h="$2" v="$3" out=""
	while [[ "$t" == *"$h"* ]]; do
		out="$out${t%%"$h"*}$v"
		t="${t#*"$h"}"
	done
	printf '%s' "$out$t"
}

ap_oc_first_line_is_ours() {
	local first=""
	[ -f "$1" ] || return 1
	IFS= read -r first < "$1" || true
	case "$first" in "$AP_OC_HEADER_PREFIX"*) return 0 ;; esac
	return 1
}

ap_oc_config_dir() {
	local v
	if [ -n "${OPENCODE_CONFIG_DIR:-}" ] && [ "${OPENCODE_CONFIG_DIR#/}" != "$OPENCODE_CONFIG_DIR" ]; then
		v="$OPENCODE_CONFIG_DIR"
		while [ "${v%/}" != "$v" ]; do v="${v%/}"; done
		[ -n "$v" ] || v="/"
		printf '%s' "$v"
	elif [ -n "${XDG_CONFIG_HOME:-}" ] && [ "${XDG_CONFIG_HOME#/}" != "$XDG_CONFIG_HOME" ]; then
		printf '%s' "${XDG_CONFIG_HOME%/}/opencode"
	else
		printf '%s' "$HOME/.config/opencode"
	fi
}

ap_oc_data_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ] && [ "${XDG_DATA_HOME#/}" != "$XDG_DATA_HOME" ]; then
		printf '%s' "${XDG_DATA_HOME%/}/opencode"
	else
		printf '%s' "$HOME/.local/share/opencode"
	fi
}

# ap_oc_detected: OpenCode is here when `opencode` is on PATH or its config or data folder exists. Nothing is run.
ap_oc_detected() {
	local cfg data
	cfg="$(ap_oc_config_dir)"
	data="$(ap_oc_data_dir)"
	command -v opencode >/dev/null 2>&1 || [ -e "$cfg" ] || [ -L "$cfg" ] || [ -e "$data" ]
}

ap_oc_backup() {
	local path="$1" dir="$HOME/.agentpulse/backups/opencode" stamp to n=0
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	( umask 077 && mkdir -p "$dir" ) || return 1
	to="$dir/$(basename -- "$path").$stamp"
	# Never overwrite an earlier backup (and never let mv move into one that is a folder).
	while [ -e "$to" ] || [ -L "$to" ]; do n=$((n + 1)); to="$dir/$(basename -- "$path").$stamp.$n"; done
	mv -- "$path" "$to" || return 1
	echo "  ✓ Moved $path to $to"
}

# ap_oc_remove_ours <plugins dir> <entry> <file> : removes the entry only when line 1 of its file is our header.
ap_oc_remove_ours() {
	local plugins="$1" entry="$2" file="$3" top n extra=0
	top="$plugins/$entry"
	if [ "$entry" = "$file" ]; then
		if [ -f "$top" ] && [ ! -L "$top" ] && ap_oc_first_line_is_ours "$top"; then
			rm -f -- "$top"
			echo "  ✓ Removed OpenCode plugin $top"
		fi
		return 0
	fi
	[ -d "$top" ] && [ ! -L "$top" ] || return 0
	ap_oc_first_line_is_ours "$top/index.js" || return 0
	for n in "$top"/* "$top"/.[!.]* "$top"/..?*; do
		[ -e "$n" ] || [ -L "$n" ] || continue
		[ "${n##*/}" = "index.js" ] || extra=1
	done
	if [ "$extra" = 0 ]; then
		rm -f -- "$top/index.js"
		rmdir -- "$top"
		echo "  ✓ Removed OpenCode plugin $top"
	else
		ap_oc_backup "$top"
	fi
}

# ap_oc_write_entry <plugins dir> <entry> <file> <line 1|2> <base> <direct>: writes (or leaves unchanged) one entry.
ap_oc_write_entry() {
	local plugins="$1" entry="$2" file="$3" line="$4" base="$5" direct="$6" text abs top cur
	text="$(ap_opencode_plugin_${line}_template)"
	text="$(ap_oc_fill "$text" '@@AP_OPENCODE_BASE_URL@@' "$base")"
	text="$(ap_oc_fill "$text" '@@AP_OPENCODE_DIRECT@@' "$direct")"
	case "$text" in
		"$AP_OC_HEADER_PREFIX"*) ;;
		*) echo "  ✗ OpenCode: this copy of the installer doesn't carry the plugin text, so nothing was written. Use the installer your AgentPulse server serves." >&2; return 1 ;;
	esac
	# $(...) took the trailing line break off; the file ends with exactly one, as buildOpenCodePluginFiles' text does.
	text="$text"$'\n'
	abs="$plugins/$file"
	top="$plugins/$entry"
	if [ "$entry" != "$file" ] && [ -e "$top" ] && [ ! -d "$top" ]; then
		ap_oc_backup "$top" || return 1
	fi
	mkdir -p -- "$(dirname -- "$abs")"
	if [ -f "$abs" ] && [ ! -L "$abs" ]; then
		cur="$(cat -- "$abs"; printf x)"
		if [ "$cur" = "${text}x" ]; then
			echo "  ✓ OpenCode plugin unchanged: $abs"
			return 0
		fi
		if ! ap_oc_first_line_is_ours "$abs"; then ap_oc_backup "$abs" || return 1; fi
	fi
	printf '%s' "$text" | ap_write_no_follow "$abs" || return 1
	echo "  ✓ OpenCode plugin → $abs"
}

# ap_opencode_install <base url> <direct 0|1> <force 0|1> <no-opencode 0|1>
# Returns 1 only when it refused because something it would touch is a symlink.
ap_opencode_install() {
	local base="$1" direct="$2" force="$3" noop="$4"
	local cfg plugins marker="$HOME/.agentpulse/opencode-force" sdk=0 foreign=0 remembered=0 rule=0 open=0 touched=0 from_env=0
	local e_name e_file e_line e_gated e_kind p
	cfg="$(ap_oc_config_dir)"
	plugins="$cfg/plugins"
	from_env=0
	if [ -n "${OPENCODE_CONFIG_DIR:-}" ] && [ "${OPENCODE_CONFIG_DIR#/}" != "$OPENCODE_CONFIG_DIR" ]; then from_env=1; fi
	if [ "$cfg" = "/" ]; then
		echo "  ✗ OpenCode: refusing to use / as OpenCode's config folder (check OPENCODE_CONFIG_DIR). No OpenCode plugin was written or removed." >&2
		return 1
	fi
	if [ "$noop" != 1 ] && ! ap_oc_detected; then
		echo "  - OpenCode not detected (no \`opencode\` on PATH, no config or data folder); nothing written."
		return 0
	fi
	if [ "$noop" != 1 ]; then
		ap_validate_hook_base_url "$base" || return 1
		case "$base" in *'"'*|*'\'*|*'@@'*|*$'\n'*|*$'\r'*) echo "invalid AgentPulse base URL for the OpenCode plugin" >&2; return 1 ;; esac
	fi
	# Links first: nothing below writes or removes anything unless none of these is a link.
	while IFS='|' read -r e_name e_file e_line e_gated e_kind; do
		if [ -L "$plugins/$e_name" ]; then
			echo "  ✗ OpenCode: refusing to touch $plugins/$e_name: it is a symlink. No OpenCode plugin was written or removed." >&2
			return 1
		fi
	done <<< "$AP_OC_ENTRIES"
	for p in "$cfg" "$plugins"; do
		if [ -L "$p" ]; then
			echo "  ✗ OpenCode: refusing to touch $p: it is a symlink. No OpenCode plugin was written or removed." >&2
			return 1
		fi
	done
	if [ "$noop" = 1 ]; then
		while IFS='|' read -r e_name e_file e_line e_gated e_kind; do
				ap_oc_remove_ours "$plugins" "$e_name" "$e_file"
		done <<< "$AP_OC_ENTRIES"
		echo "  - OpenCode plugins removed (no-opencode)."
		return 0
	fi
	# What setup looks at, read-only; links are followed on purpose.
	if [ -f "$cfg/$AP_OC_SDK_MARKER" ]; then
		sdk=1
		if [ "$AP_OC_SDK_CHECK" != marker_only ]; then
			if [ -f "$cfg/package.json" ] && grep -qF -- "$AP_OC_SDK_CONFIG_DEP" "$cfg/package.json" 2>/dev/null; then :; else sdk=0; fi
		fi
	fi
	ap_oc_foreign_plugin_present "$plugins" && foreign=1
	[ "$force" = 1 ] || force=0
	ap_oc_gate_open "$sdk" "$foreign" 0 0 && rule=1
	ap_oc_gate_open "$sdk" "$foreign" "$force" "$remembered" && open=1
	while IFS='|' read -r e_name e_file e_line e_gated e_kind; do
		[ -n "$e_name" ] || continue
		if [ "$e_gated" = 1 ] && [ "$open" = 0 ]; then
			ap_oc_remove_ours "$plugins" "$e_name" "$e_file"
		else
			ap_oc_write_entry "$plugins" "$e_name" "$e_file" "$e_line" "$base" "$direct" || return 1
			touched=1
		fi
	done <<< "$AP_OC_ENTRIES"
	if [ "$from_env" = 1 ]; then echo "  - OPENCODE_CONFIG_DIR is set; installing into $cfg/plugins."; fi
	if [ "$open" = 0 ]; then
		echo "  $(ap_oc_fill "$AP_OC_MSG_SKIP" '<dir>' "$cfg")"
	elif [ "$force" = 1 ] && [ "$rule" = 0 ]; then
		echo "  $(ap_oc_fill "$AP_OC_MSG_FORCE" '<dir>' "$cfg")"
	fi
	if [ "$touched" = 1 ]; then
		echo "  $AP_OC_NOTE_SERVER_FIRST"
		echo "  $AP_OC_NOTE_SERVICE_SKIP"
	fi
	return 0
}
# <<< agentpulse-opencode-install

# --statusline: installs statusline.sh from next to this installer as
# ~/.claude/statusline-agentpulse.sh and enables it only when settings.json
# has no statusLine yet; someone else's is never replaced.
ap_install_statusline() {
  local self_script self_dir src dest settings result
  # Only the statusline.sh that ships next to this installer on disk is ever
  # copied. Piped into bash (`curl ... | bash`), or run from process
  # substitution, there is no file and BASH_SOURCE is empty or a pipe: falling
  # back to the working directory would install whatever ./statusline.sh is
  # sitting there as an executable.
  # A shell reading its script from a pipe may still report its own name as the
  # script (bash -s says "bash"), so the file must be named setup-hooks.sh and
  # identify itself as this installer, and the shell must not have been handed
  # the text on its command line or stdin.
  self_script="${BASH_SOURCE[0]:-}"
  self_dir=""
  src=""
  # A script given as text (`bash -c "$(curl ...)" setup-hooks.sh`, or `bash -s` on stdin) has
  # a name but no file: $- carries c or s then, and the name can be anything the caller typed.
  if [[ "$-" != *[cs]* && -n "$self_script" && "${self_script##*/}" == "setup-hooks.sh" && -f "$self_script" && ! -L "$self_script" ]] \
    && grep -q '^# AgentPulse Hook Setup Script' "$self_script" 2>/dev/null; then
    self_dir="$(cd "$(dirname -- "$self_script")" 2>/dev/null && pwd -P)" || self_dir=""
    [[ -n "$self_dir" ]] && src="$self_dir/statusline.sh"
  fi
  if [[ -z "$src" || -L "$src" || ! -f "$src" ]]; then
    echo "Statusline: --statusline needs the installer to be a file on disk next to a real statusline.sh, and this run has neither (piped installs have no file). Clone the repository and run scripts/setup-hooks.sh --statusline, or use the relay installer, which includes the statusline." >&2
    return 0
  fi
  dest="$HOME/.claude/statusline-agentpulse.sh"
  settings="$HOME/.claude/settings.json"
  ap_write_no_follow "$dest" < "$src" || return 1
  chmod 755 "$dest"
  result="$(AP_SETTINGS="$settings" AP_CMD="~/.claude/statusline-agentpulse.sh" python3 -c '
import json, os, shutil
# A symlinked settings.json (a dotfiles repo, say) is written through: the file
# it points at is replaced and the link is left as it was.
path = os.path.realpath(os.environ["AP_SETTINGS"])
want = {"type": "command", "command": os.environ["AP_CMD"]}
try:
    with open(path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}
except Exception:
    settings = None
if not isinstance(settings, dict):
    print("unreadable")
elif settings.get("statusLine") is None:
    settings["statusLine"] = want
    tmp = path + ".agentpulse.tmp"
    with open(tmp, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)
    print("set")
elif settings["statusLine"] == want:
    print("same")
else:
    print("other")
')"
  case "$result" in
    set) echo "Statusline installed and enabled ($dest)" ;;
    same) echo "Statusline updated ($dest)" ;;
    other) echo "Statusline installed at $dest; your settings.json already has a statusLine, so it was left alone." ;;
    *) echo "Statusline installed at $dest; settings.json could not be read as JSON, so it was left alone." ;;
  esac
  command -v jq >/dev/null 2>&1 || echo "! The statusline needs jq; install it to see session names there"
}

# F245: reject a malformed --url before any hook JSON generation.
ap_validate_hook_base_url "$AGENTPULSE_URL" || exit 1

# F246: before any file writes, refuse if this server needs a key we don't have.
ap_check_auth_before_write "$AGENTPULSE_URL" "$AGENTPULSE_KEY" "$NO_AUTH_CHECK" || exit 1

# Verify connectivity
echo "Checking AgentPulse server..."
if ! curl -sf "${AGENTPULSE_URL}/api/v1/health" > /dev/null 2>&1; then
  echo "Warning: Cannot reach ${AGENTPULSE_URL}/api/v1/health"
  echo "Continuing anyway -- make sure the server is running."
fi

# ─── Claude Code Setup ───────────────────────────────────────────────

if [[ "$AGENT_TYPE" == "claude_code" ]]; then
  if [[ "$SCOPE" == "global" ]]; then
    SETTINGS_FILE="$HOME/.claude/settings.json"
  else
    SETTINGS_FILE=".claude/settings.json"
    mkdir -p .claude
  fi

  echo "Configuring Claude Code hooks..."

  # Events to hook
  EVENTS=("SessionStart" "SessionEnd" "PreToolUse" "PostToolUse" "Stop" "SubagentStart" "SubagentStop" "TaskCreated" "TaskCompleted" "UserPromptSubmit" "PermissionRequest" "PermissionDenied" "Notification" "PreCompact" "PostCompact" "PostToolUseFailure")

  # AGEN-49/H2 (xander): Claude Code's native HTTP hook expands
  # $AGENTPULSE_API_KEY from ITS OWN process environment, not the shell that
  # launched Claude Code -- a GUI, IDE, or stale-terminal launch never
  # sources ~/.agentpulse/env, so the env-var form 401s silently there.
  # Global (user) scope trades that reliability gap for embedding the
  # literal key -- acceptable because settings.json is tightened to 0600
  # below (never world-readable). Project scope (a repo's
  # .claude/settings.json, which may be committed) never gets a literal key
  # -- it keeps the env-var/allowedEnvVars form, at the cost of the same
  # silent-401 risk this trade accepts for global scope.
  HOOKS_JSON="{"
  for i in "${!EVENTS[@]}"; do
    EVENT="${EVENTS[$i]}"
    if [[ $i -gt 0 ]]; then
      HOOKS_JSON+=","
    fi
    if [[ "$SCOPE" == "global" ]]; then
      HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_SKIP\"],\"headers\":{\"Authorization\":\"Bearer ${AGENTPULSE_KEY}\",\"X-Agent-Type\":\"claude_code\",\"X-AgentPulse-Skip\":\"\$AGENTPULSE_SKIP\"}}]}]"
    else
      HOOKS_JSON+="\"${EVENT}\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"http\",\"url\":\"${AGENTPULSE_URL}/api/v1/hooks\",\"async\":true,\"allowedEnvVars\":[\"AGENTPULSE_API_KEY\",\"AGENTPULSE_SKIP\"],\"headers\":{\"Authorization\":\"Bearer \$AGENTPULSE_API_KEY\",\"X-Agent-Type\":\"claude_code\",\"X-AgentPulse-Skip\":\"\$AGENTPULSE_SKIP\"}}]}]"
    fi
  done
  HOOKS_JSON+="}"

  # F<new> (H2): refuse a symlinked destination or its parent directory
  # before any write. settings.json holds other user settings we must
  # preserve, so this can't just delegate to ap_write_private_no_follow
  # (which overwrites the whole file) -- same ordering as that helper:
  # parent symlink check, mkdir, then the file's own symlink check.
  SETTINGS_DIR="$(dirname "$SETTINGS_FILE")"
  if [[ -L "$SETTINGS_DIR" ]]; then
    echo "refusing to write into a symlinked directory: $SETTINGS_DIR" >&2
    exit 1
  fi
  mkdir -p "$SETTINGS_DIR"
  if [[ -L "$SETTINGS_FILE" ]]; then
    echo "refusing to write through a symlink: $SETTINGS_FILE" >&2
    exit 1
  fi

  if [[ -f "$SETTINGS_FILE" ]]; then
    # Merge hooks into existing settings using jq if available
    if command -v jq &> /dev/null; then
      echo "Merging hooks into existing $SETTINGS_FILE..."
      # F<new> (High, xander re-verify): a plain "${SETTINGS_FILE}.tmp"
      # redirect target is predictable -- a pre-planted symlink there
      # would let this write (carrying the literal key, at global scope)
      # follow it, and the following `mv` would turn settings.json ITSELF
      # into that symlink; the trailing chmod 600 further down would then
      # narrow the attacker's file, not ours. mktemp's unpredictable
      # sibling name closes that: nothing can pre-plant a symlink at a
      # name it can't guess. The immediate -L check is defense in depth
      # against the (already vanishingly small) race between mktemp's own
      # atomic create and this check.
      TMP="$(umask 077 && mktemp "${SETTINGS_FILE}.XXXXXX")" || {
        echo "can't create a temp file for $SETTINGS_FILE" >&2
        exit 1
      }
      if [[ -L "$TMP" ]]; then
        echo "refusing to write through a symlinked temp file: $TMP" >&2
        rm -f "$TMP"
        exit 1
      fi
      EXISTING=$(cat "$SETTINGS_FILE")
      echo "$EXISTING" | jq --argjson hooks "$HOOKS_JSON" '.hooks = (.hooks // {}) * $hooks' > "$TMP"
      mv -f "$TMP" "$SETTINGS_FILE"
    else
      echo "Warning: jq not found. Cannot safely merge into existing settings."
      echo "Please manually add the following hooks to $SETTINGS_FILE:"
      echo ""
      echo "\"hooks\": $HOOKS_JSON"
      echo ""
    fi
  else
    # Create new settings file
    echo "{\"hooks\":$HOOKS_JSON}" | python3 -m json.tool > "$SETTINGS_FILE" 2>/dev/null || echo "{\"hooks\":$HOOKS_JSON}" > "$SETTINGS_FILE"
  fi

  # H2: global (user) scope gets the literal key above, so its settings.json
  # is tightened to owner-only -- never world-readable. Project scope keeps
  # whatever mode the repo's file already had (it's meant to be shared/
  # committed, and never carries the literal key in the first place).
  if [[ "$SCOPE" == "global" && -f "$SETTINGS_FILE" ]]; then
    chmod 600 "$SETTINGS_FILE"
  fi

  echo "Claude Code hooks configured in $SETTINGS_FILE"
  if [[ "$SCOPE" == "project" ]]; then
    echo "Restart Claude Code fully to pick up the key -- an app launched from a GUI or an IDE may not see \$AGENTPULSE_API_KEY from your shell."
  fi
  if [[ "$WITH_STATUSLINE" == "1" ]]; then
    ap_install_statusline
  else
    echo "Statusline: re-run with --statusline to add the AgentPulse statusline to Claude Code (it shows when rules are invalid or AGENTPULSE_SKIP is set)."
  fi

# ─── Codex CLI Setup ─────────────────────────────────────────────────

elif [[ "$AGENT_TYPE" == "codex_cli" ]]; then
  # D13/F57: below curl 7.55, -H "@$f" silently sends no auth header at all.
  ap_require_curl_755

  # D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
  # $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
  CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
  HOOKS_FILE="$CODEX_DIR/hooks.json"
  mkdir -p "$CODEX_DIR"

  echo "Configuring Codex CLI hooks..."

  # D13: the key never enters argv or the hooks file — the shim reads it
  # from this file at hook-fire time via curl -H "@$f".
  #
  # F207/F252: never write through a symlink at the destination or its
  # parent directory — see ap_write_private_no_follow above.
  AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
  printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}"
  ap_write_private_no_follow "$AP_AUTH_HEADER_FILE" "$AP_AUTH_HEADER_CONTENT" || exit 1

  ap_install_exclude_script
  NEW_CODEX_HOOKS_JSON="$(ap_codex_hooks_json "$AGENTPULSE_URL" "1")"
  CODEX_MERGE_RC=0
  MERGED_CODEX_HOOKS_JSON="$(printf '%s\n' "$NEW_CODEX_HOOKS_JSON" | ap_codex_merge_hooks_json "$HOOKS_FILE")" || CODEX_MERGE_RC=$?
  if [[ "$CODEX_MERGE_RC" == "3" ]]; then
    echo "Codex hooks unchanged — no re-trust needed"
  elif [[ "$CODEX_MERGE_RC" == "4" ]]; then
    : # ap_codex_merge_hooks_json already said why; the file is left as it was
  elif [[ "$CODEX_MERGE_RC" != "0" ]]; then
    exit 1
  else
    if [[ -f "$HOOKS_FILE" ]]; then
      CODEX_HOOKS_WRITTEN="updated"
      CODEX_BACKUP_FILE="${HOOKS_FILE}.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cat "$HOOKS_FILE" | ap_write_no_follow "$CODEX_BACKUP_FILE" || exit 1
      echo "Backed up existing $HOOKS_FILE to $CODEX_BACKUP_FILE"
    fi
    printf '%s\n' "$MERGED_CODEX_HOOKS_JSON" | ap_write_no_follow "$HOOKS_FILE" || exit 1
    echo "Codex CLI hooks configured in $HOOKS_FILE"
    echo "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks. Re-trust after changing the AgentPulse URL or port."
    [[ "$CODEX_HOOKS_WRITTEN" == "updated" ]] || CODEX_HOOKS_WRITTEN="new"
  fi
  echo "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"

  # D12: codex_hooks is a deprecated (but still-working) legacy alias for
  # [features].hooks — left alone if present, never newly written.

# ─── Copilot CLI Setup ───────────────────────────────────────────────

elif [[ "$AGENT_TYPE" == "copilot_cli" ]]; then
  # D8: Copilot's project-scoped hooks live in .github/hooks/, a path this
  # installer doesn't write — --scope project has nothing to do here.
  if [[ "$SCOPE" == "project" ]]; then
    echo "Error: --agent copilot_cli --scope project is not supported. Copilot CLI loads project-scoped hooks from .github/hooks/, which AgentPulse doesn't manage. Use the default global scope (~/.copilot/hooks/agentpulse.json)." >&2
    exit 1
  fi

  # D8: only write into a real Copilot install — never create config for a
  # tool that isn't there.
  if ! command -v copilot >/dev/null 2>&1 && [[ ! -d "$HOME/.copilot" ]]; then
    echo "Error: Copilot CLI not detected (no 'copilot' on PATH and no ~/.copilot directory). Install Copilot CLI first, then re-run this installer." >&2
    exit 1
  fi

  ap_require_curl_755

  COPILOT_DIR="$HOME/.copilot/hooks"
  COPILOT_HOOKS_FILE="$COPILOT_DIR/agentpulse.json"
  mkdir -p "$COPILOT_DIR"

  echo "Configuring Copilot CLI hooks..."

  AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
  printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}"
  ap_write_private_no_follow "$AP_AUTH_HEADER_FILE" "$AP_AUTH_HEADER_CONTENT" || exit 1

  ap_install_exclude_script
  NEW_COPILOT_HOOKS_JSON="$(ap_copilot_hooks_json "$AGENTPULSE_URL" "1")"
  if [[ -f "$COPILOT_HOOKS_FILE" ]] && [[ "$(cat "$COPILOT_HOOKS_FILE")" == "$NEW_COPILOT_HOOKS_JSON" ]]; then
    echo "Copilot hooks unchanged"
  else
    if [[ -f "$COPILOT_HOOKS_FILE" ]]; then
      COPILOT_BACKUP_FILE="${COPILOT_HOOKS_FILE}.agentpulse-bak.$(date -u +%Y%m%dT%H%M%SZ)"
      cat "$COPILOT_HOOKS_FILE" | ap_write_no_follow "$COPILOT_BACKUP_FILE" || exit 1
      echo "Backed up existing $COPILOT_HOOKS_FILE to $COPILOT_BACKUP_FILE"
    fi
    printf '%s\n' "$NEW_COPILOT_HOOKS_JSON" | ap_write_no_follow "$COPILOT_HOOKS_FILE" || exit 1
    echo "Copilot CLI hooks configured in $COPILOT_HOOKS_FILE"
  fi
  echo "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"

elif [[ "$AGENT_TYPE" == "opencode" ]]; then
  # AGEN-141: OpenCode loads plugins from its config folder; nothing here runs `opencode`.
  if [[ "$SCOPE" == "project" ]]; then
    echo "Error: --agent opencode --scope project is not supported. AgentPulse installs OpenCode's plugins in its global config folder only." >&2
    exit 1
  fi
  if [[ "$NO_OPENCODE" != "1" ]] && ! ap_oc_detected; then
    echo "Error: OpenCode not detected (no 'opencode' on PATH, no OpenCode config or data folder). Install OpenCode first, then re-run this installer." >&2
    exit 1
  fi
  echo "Configuring OpenCode plugins..."
  if [[ "$NO_OPENCODE" != "1" ]]; then
    if [[ -n "$AGENTPULSE_KEY" ]]; then
      AP_AUTH_HEADER_FILE="$HOME/.agentpulse/hook-auth-header"
      printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}"
      ap_write_private_no_follow "$AP_AUTH_HEADER_FILE" "$AP_AUTH_HEADER_CONTENT" || exit 1
    fi
    ap_install_exclude_script
  fi
  ap_opencode_install "$AGENTPULSE_URL" "1" "$OPENCODE_FORCE" "$NO_OPENCODE" || exit 1

else
  echo "Error: Unknown agent type '$AGENT_TYPE'. Use 'claude_code', 'codex_cli', 'copilot_cli', or 'opencode'."
  exit 1
fi

# OpenCode alongside the agent just configured (AGEN-141): set up when found, removed on --no-opencode.
if [[ "$AGENT_TYPE" != "opencode" ]] && { [[ "$NO_OPENCODE" == "1" ]] || ap_oc_detected; }; then
  if [[ "$NO_OPENCODE" != "1" ]]; then
    if [[ -n "$AGENTPULSE_KEY" ]]; then
      printf -v AP_AUTH_HEADER_CONTENT 'Authorization: Bearer %s\n' "${AGENTPULSE_KEY}"
      ap_write_private_no_follow "$HOME/.agentpulse/hook-auth-header" "$AP_AUTH_HEADER_CONTENT" || exit 1
    fi
    ap_install_exclude_script
  fi
  ap_opencode_install "$AGENTPULSE_URL" "1" "$OPENCODE_FORCE" "$NO_OPENCODE" || true
fi

# ─── Environment Variable (D37/F243) ─────────────────────────────────
#
# codex_cli/copilot_cli never reach this point with anything to write:
# they authenticate hook fires via ~/.agentpulse/hook-auth-header (0600,
# written above), not an exported env var — skip the profile entirely.
# claude_code's hooks.json embeds the literal key directly when one was
# given (see the Claude Code Setup section above), but AGENTPULSE_API_KEY/
# AGENTPULSE_URL are still exported for the user's own shell/CLI use —
# formerly appended to the rc file in plaintext, which is world-readable
# by default on many systems. Now written to a 0600 ~/.agentpulse/env
# instead, with only a key-free, idempotent source line in the rc file.

if [[ "$AGENT_TYPE" == "claude_code" ]]; then
  echo ""
  echo "Setting AGENTPULSE_API_KEY environment variable..."

  SHELL_NAME="$(basename "$SHELL")"
  if [[ "$SHELL_NAME" == "zsh" ]]; then
    PROFILE="$HOME/.zshrc"
  elif [[ "$SHELL_NAME" == "bash" ]]; then
    PROFILE="$HOME/.bashrc"
  else
    PROFILE="$HOME/.profile"
  fi

  if grep -q "^export AGENTPULSE_API_KEY=" "$PROFILE" 2>/dev/null; then
    echo "! $PROFILE already has a plaintext AGENTPULSE_API_KEY export from an" >&2
    echo "  earlier install. Leaving it, but it's world-readable by default on" >&2
    echo "  many systems — remove it by hand:" >&2
    echo "    sed -i.bak '/^export AGENTPULSE_API_KEY=/d' \"$PROFILE\"" >&2
  fi

  AP_ENV_FILE="$HOME/.agentpulse/env"
  printf -v AP_ENV_CONTENT 'export AGENTPULSE_API_KEY="%s"\nexport AGENTPULSE_URL="%s"\n' \
      "${AGENTPULSE_KEY}" "${AGENTPULSE_URL}"
  ap_write_private_no_follow "$AP_ENV_FILE" "$AP_ENV_CONTENT" || exit 1
  echo "Wrote AGENTPULSE_API_KEY/AGENTPULSE_URL to $AP_ENV_FILE (0600)"

  AP_SOURCE_LINE='[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"'
  if ! grep -qF "$AP_SOURCE_LINE" "$PROFILE" 2>/dev/null; then
    echo "" >> "$PROFILE"
    echo "# AgentPulse (key lives in ~/.agentpulse/env, not here)" >> "$PROFILE"
    echo "$AP_SOURCE_LINE" >> "$PROFILE"
    echo "Added a source line for ~/.agentpulse/env to $PROFILE"
  fi
fi

# ─── Verify ──────────────────────────────────────────────────────────

echo ""
echo "Sending test event..."
TEST_RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AGENTPULSE_URL}/api/v1/hooks" \
  -H "Authorization: Bearer ${AGENTPULSE_KEY}" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Type: ${AGENT_TYPE}" \
  -d "{\"session_id\":\"setup-test-$(date +%s)\",\"hook_event_name\":\"SessionStart\",\"cwd\":\"$(pwd)\",\"source\":\"setup-script\"}" 2>/dev/null || echo "000")

if [[ "$TEST_RESULT" == "200" ]]; then
  echo "Test event sent successfully!"
else
  echo "Warning: Test event returned HTTP $TEST_RESULT (expected 200)"
fi

echo ""
echo "Setup complete!"
if [[ "$AGENT_TYPE" == "claude_code" ]]; then
  echo "Restart your shell or run:"
  echo "  source $PROFILE"
  echo ""
fi
echo "Then start a new ${AGENT_TYPE} session to see it in AgentPulse."
if [[ "$CODEX_HOOKS_WRITTEN" == "new" ]]; then
  echo "Codex needs you to approve these hooks: run /hooks in Codex."
elif [[ "$CODEX_HOOKS_WRITTEN" == "updated" ]]; then
  echo "Codex: open /hooks and approve the updated AgentPulse hooks again; the hook command changed, so Codex asks once more."
fi
