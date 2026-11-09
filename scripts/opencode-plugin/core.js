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
// @@AP_GENERATED END

const AP_TEST =
	process.env.AP_TEST_SEAM === "1" ? globalThis[Symbol.for("agentpulse.opencode.seam")] : undefined;
const apEnv = () => (AP_TEST && AP_TEST.env) || process.env;
const apPlatform = () => (AP_TEST && AP_TEST.platform) || process.platform;
const apGetuid = () => (AP_TEST && "getuid" in AP_TEST ? AP_TEST.getuid : process.getuid);
const apNow = () => (AP_TEST && AP_TEST.now ? AP_TEST.now() : Date.now());
const apArgv = () => (AP_TEST && AP_TEST.argv) || process.argv;
const apFetch = () => (AP_TEST && AP_TEST.fetch) || globalThis.fetch;

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
	if (budget.nodes > INPUT_NODES || depth > INPUT_DEPTH) return "[omitted]";
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") return capString(value);
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
			out[keys[i]] = capValue(value[keys[i]], depth + 1, budget);
		}
		return out;
	}
	return "[unsupported]";
}

function capInput(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return capValue(value, 0, { nodes: 0 });
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
	for (let i = 0; i < item.dirs.length; i++)
		lruTouch(rec.verdicts, String(item.dirs[i]), apNow(), 256);
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

function flushAtExit(rec) {
	try {
		if (!oneShot()) return;
		const deadline = Date.now() + EXIT_BUDGET_MS;
		const auth = exitAuthArgs();
		if (auth === null) return;
		const curl = (AP_TEST && AP_TEST.curl) || CURL;
		for (const st of rec.sessions.values()) {
			for (const item of st.q) {
				const left = deadline - Date.now();
				if (left <= 0) return;
				if (!item.dirs.every((d) => rec.verdicts.has(String(d)))) break;
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
