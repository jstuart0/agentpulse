/**
 * End to end: a real relay process (random port, throwaway HOME and state
 * directory, never port 4000 or 3000) in front of an upstream stub that
 * records EVERY request it receives. An excluded session must produce zero
 * upstream requests that mention it, whatever path it takes: hook events,
 * status updates, native-name pushes, CLAUDE.md uploads (both of them), the
 * proxy, the Codex name sync, a relay restart, and the statusline. A control
 * session in another directory, in the same run, is forwarded normally.
 *
 * Nothing here touches a real home directory, the real relay or the network:
 * the upstream is a Bun.serve on 127.0.0.1 and each relay is killed by the PID
 * this file started.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(90_000);

const RELAY = join(import.meta.dir, "relay.ts");
const STATUSLINE = join(import.meta.dir, "statusline.sh");
const KEY = "ap_E2E_exclude_key_0123456789";

/** Claude Code's settings.json for a user whose hooks go to the local relay: no key header, and the skip header the relay installer writes. */
function pointClaudeHooksAtRelay(relay: { home: string; port: number }) {
	mkdirSync(join(relay.home, ".claude"), { recursive: true });
	writeFileSync(
		join(relay.home, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						matcher: "",
						hooks: [
							{
								type: "http",
								url: `http://localhost:${relay.port}/api/v1/hooks`,
								allowedEnvVars: ["AGENTPULSE_SKIP"],
								headers: { "X-Agent-Type": "claude_code", "X-AgentPulse-Skip": "$AGENTPULSE_SKIP" },
							},
						],
					},
				],
			},
		}),
	);
}

type Recorded = { method: string; path: string; search: string; body: string; at: number };

type UpstreamState = {
	requests: Recorded[];
	/** POST /api/v1/hooks answers 503 while this is set (so a queued item stays queued). */
	failHooks: boolean;
	/** What GET /api/v1/sessions?limit=20 lists (the CLAUDE.md sync reads it). */
	claudeMdSessions: Array<Record<string, unknown>>;
	/** What GET /api/v1/sessions/<id>/claude-md answers per session id (404 for any other). */
	claudeMdDownloads: Record<string, { content: string; path: string; checksum: string }>;
};

let root: string;
let upstream: ReturnType<typeof Bun.serve>;
const state: UpstreamState = {
	requests: [],
	failHooks: false,
	claudeMdSessions: [],
	claudeMdDownloads: {},
};
/** The most recently started relay's log, for a failure message. */
let currentOutput: () => string = () => "";
const children: Array<{ proc: ReturnType<typeof Bun.spawn>; pid: number }> = [];
let runIndex = 0;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-exclude-e2e-")));
	upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? "" : await req.text();
			state.requests.push({
				method: req.method,
				path: url.pathname,
				search: url.search,
				body,
				at: Date.now(),
			});
			if (url.pathname === "/api/v1/auth/me") {
				return Response.json({
					authenticated: true,
					user: { scopes: ["ingest", "observe", "manage"] },
				});
			}
			if (url.pathname === "/api/v1/health") return Response.json({ status: "ok", clients: {} });
			if (url.pathname === "/api/v1/hooks" || url.pathname === "/api/v1/hooks/status") {
				if (state.failHooks && url.pathname === "/api/v1/hooks") {
					return Response.json({ error: "down" }, { status: 503 });
				}
				return Response.json({ ok: true });
			}
			if (req.method === "GET" && url.pathname === "/api/v1/sessions") {
				if (url.searchParams.get("agent_type") === "codex_cli") {
					return Response.json({ sessions: [] });
				}
				return Response.json({ sessions: state.claudeMdSessions });
			}
			if (req.method === "GET" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
				return Response.json({ session: { displayName: "upstream-name" } });
			}
			if (req.method === "GET" && url.pathname.endsWith("/claude-md")) {
				const id = url.pathname.split("/")[4] ?? "";
				const download = state.claudeMdDownloads[id];
				return download
					? Response.json(download)
					: Response.json({ error: "none" }, { status: 404 });
			}
			return Response.json({ ok: true });
		},
	});
});

afterEach(async () => {
	state.failHooks = false;
	state.claudeMdSessions = [];
	state.claudeMdDownloads = {};
	while (children.length) {
		const child = children.pop();
		if (!child) break;
		child.proc.kill();
		await child.proc.exited;
	}
});

afterAll(() => {
	upstream.stop(true);
	rmSync(root, { recursive: true, force: true });
});

type Relay = {
	port: number;
	base: string;
	home: string;
	dir: string;
	pid: number;
	stop: () => Promise<void>;
};

async function waitFor<T>(
	label: string,
	probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const v = await probe();
			if (v) return v as T;
			last = v;
		} catch (err) {
			last = err;
		}
		await Bun.sleep(40);
	}
	throw new Error(
		`timed out waiting for ${label} (last: ${String(last)})\n--- upstream requests ---\n${dump()}\n--- relay output ---\n${currentOutput()}`,
	);
}

/** Starts a relay against the stub. A second call with the same `name` restarts it over the same home and state. */
async function startRelay(name: string, opts: { syncMs?: number } = {}): Promise<Relay> {
	const base = join(root, name);
	const home = join(base, "home");
	const dir = join(home, ".agentpulse");
	const codexHome = join(home, ".codex");
	for (const d of [codexHome, dir]) mkdirSync(d, { recursive: true });
	chmodSync(dir, 0o700);
	const configPath = join(dir, "config.json");
	if (!existsSync(configPath)) {
		writeFileSync(
			configPath,
			JSON.stringify({ remote_url: `http://127.0.0.1:${upstream.port}`, api_key: KEY, port: 0 }),
			{ mode: 0o600 },
		);
	}
	// `--port 0` on the command line as well as in the config: a relay that ignored the
	// config must never fall back to 4000, where a developer's real relay listens.
	const proc = Bun.spawn([process.execPath, RELAY, "--config", configPath, "--port", "0"], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			HOME: home,
			CODEX_HOME: codexHome,
			// no account home: the default would ask the user database, which ignores HOME
			AGENTPULSE_TEST_RELAY_ACCOUNT_HOME: "",
			AGENTPULSE_RELAY_SYNC_MS: String(opts.syncMs ?? 200),
		},
	});
	let output = "";
	const decoder = new TextDecoder();
	currentOutput = () => output;
	for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
		void (async () => {
			for await (const chunk of stream) output += decoder.decode(chunk);
		})();
	}
	const port = await waitFor(
		`${name} banner`,
		() => {
			const m = /Local:\s+http:\/\/localhost:(\d+)/.exec(output);
			return m ? Number(m[1]) : undefined;
		},
		15_000,
	).catch((err) => {
		proc.kill();
		throw new Error(`${String(err)}\n--- relay output ---\n${output}`);
	});
	expect(port).not.toBe(4000);
	expect(port).not.toBe(3000);
	children.push({ proc, pid: proc.pid });
	appendFileSync(join(root, "started.log"), `relay ${name} pid=${proc.pid} port=${port}\n`);
	return {
		port,
		base: `http://127.0.0.1:${port}`,
		home,
		dir,
		pid: proc.pid,
		stop: async () => {
			proc.kill();
			await proc.exited;
			const i = children.findIndex((c) => c.pid === proc.pid);
			if (i >= 0) children.splice(i, 1);
		},
	};
}

function writeRules(relay: Relay, lines: string[]) {
	const file = join(relay.dir, "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	return file;
}

function newDir(name: string): string {
	const d = join(root, `dir-${++runIndex}`, name);
	mkdirSync(d, { recursive: true });
	return d;
}

/** One line per upstream request, for a failure message. */
const dump = () =>
	state.requests.map((r) => `${r.method} ${r.path}${r.search} ${r.body.slice(0, 80)}`).join("\n");

const mentions = (id: string) =>
	state.requests.filter((r) => `${r.path}${r.search}${r.body}`.includes(id));

const hookBody = (sessionId: string, cwd: string, event = "SessionStart") => ({
	session_id: sessionId,
	hook_event_name: event,
	cwd,
});

async function postHook(
	relay: Relay,
	payload: unknown,
	opts: { path?: string; skip?: string; agent?: string } = {},
) {
	const res = await fetch(`${relay.base}${opts.path ?? "/api/v1/hooks"}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Type": opts.agent ?? "claude_code",
			...(opts.skip !== undefined ? { "X-AgentPulse-Skip": opts.skip } : {}),
		},
		body: JSON.stringify(payload),
	});
	return { status: res.status, type: res.headers.get("content-type"), json: await res.json() };
}

function queueDir(relay: Relay, which: "pending" | "processing") {
	return join(relay.dir, "hook-queue", which);
}
const pending = (relay: Relay) =>
	existsSync(queueDir(relay, "pending"))
		? readdirSync(queueDir(relay, "pending")).filter((n) => n.endsWith(".json"))
		: [];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

async function diagnostics(relay: Relay) {
	const text = await (await fetch(`${relay.base}/api/v1/relay/diagnostics`)).text();
	return {
		text,
		json: JSON.parse(text) as {
			exclude: {
				state: string;
				ruleCount: number;
				held: number;
				drops: Record<string, number>;
			};
		},
	};
}

describe("an excluded session produces zero upstream requests, a control session is forwarded", () => {
	test("every path: hooks, status, native name, proxy, CLAUDE.md, Codex names, restart, statusline", async () => {
		const secret = newDir("secret-project");
		const open = newDir("open-project");
		writeFileSync(join(secret, "CLAUDE.md"), "# secret instructions\n");
		writeFileSync(join(open, "CLAUDE.md"), "# open instructions\n");
		const relay = await startRelay("main");
		writeRules(relay, [secret]);
		const codexIndex = join(relay.home, ".codex", "session_index.jsonl");
		const row = (id: string) =>
			JSON.stringify({ id, thread_name: `thread ${id}`, updated_at: "2026-09-28T11:00:00.000Z" });
		const EX = "e2e-excluded-claude";
		const CTL = "e2e-control-claude";
		const CX_EX = "e2e-excluded-codex";
		const CX_CTL = "e2e-control-codex";
		const CX_UNKNOWN = "e2e-unknown-codex";
		state.claudeMdSessions = [
			{ sessionId: EX, cwd: secret, agentType: "claude_code" },
			{ sessionId: CTL, cwd: open, agentType: "claude_code" },
		];

		// the excluded Claude session: every kind of delivery
		const keptResponse = await postHook(relay, hookBody(CTL, open));
		const droppedResponse = await postHook(relay, hookBody(EX, secret));
		await postHook(relay, hookBody(EX, secret, "PreToolUse"));
		await postHook(relay, hookBody(EX, secret, "Stop"));
		await postHook(relay, { session_id: EX, status: "working" }, { path: "/api/v1/hooks/status" });
		await fetch(`${relay.base}/api/v1/sessions/${EX}/native-name`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "named" }),
		});
		const lookup = await fetch(`${relay.base}/api/v1/sessions/${EX}`);
		expect(lookup.status).toBe(404);
		expect(await lookup.json()).toEqual({ error: "excluded" });

		// the excluded Codex session, and one the relay never saw
		await postHook(relay, hookBody(CX_EX, secret, "SessionStart"), { agent: "codex_cli" });
		writeFileSync(codexIndex, `${[CX_EX, CX_CTL, CX_UNKNOWN].map(row).join("\n")}\n`);
		await postHook(relay, hookBody(CX_CTL, open, "SessionStart"), { agent: "codex_cli" });

		// the control Claude session: events, a status update and a native-name push, each forwarded
		await postHook(relay, hookBody(CTL, open, "PreToolUse"));
		await postHook(relay, { session_id: CTL, status: "working" }, { path: "/api/v1/hooks/status" });
		const putControl = await fetch(`${relay.base}/api/v1/sessions/${CTL}/native-name`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "control-name" }),
		});
		expect(putControl.status).toBe(200);

		await waitFor(
			"the control's events to reach the upstream",
			() => mentions(CTL).filter((r) => r.path === "/api/v1/hooks").length >= 2,
		);
		await waitFor("the control's CLAUDE.md upload", () =>
			mentions(CTL).some((r) => r.method === "PUT" && r.path.endsWith("/claude-md")),
		);
		await waitFor("the control Codex name push", () =>
			mentions(CX_CTL).some((r) => r.method === "PUT" && r.path.endsWith("/native-name")),
		);
		// let several sync ticks pass so a periodic path would have shown itself
		await Bun.sleep(1200);

		await waitFor("the control's status update", () =>
			mentions(CTL).some((r) => r.path === "/api/v1/hooks/status"),
		);
		expect(
			mentions(CTL).some((r) => r.method === "PUT" && r.path.endsWith("/native-name")),
			dump(),
		).toBe(true);
		for (const id of [EX, CX_EX, CX_UNKNOWN]) {
			expect(mentions(id), `requests that mention ${id}`).toEqual([]);
		}
		expect(state.requests.map((r) => `${r.path}${r.search}${r.body}`).join("\n")).not.toContain(
			secret,
		);

		// the agent cannot tell a dropped hook from a forwarded one
		expect(droppedResponse.status).toBe(keptResponse.status);
		expect(droppedResponse.type).toBe(keptResponse.type);
		expect(Object.keys(droppedResponse.json).sort()).toEqual(Object.keys(keptResponse.json).sort());
		expect(droppedResponse.json.queueId).not.toBe(keptResponse.json.queueId);

		// nothing for the excluded session on disk: no queue file, no cwd text anywhere in the state
		expect(pending(relay)).toEqual([]);
		for (const file of walk(relay.dir)) {
			// the rules file is the user's own and names the directory by design
			if (file === join(relay.dir, "exclude")) continue;
			expect(readFileSync(file, "utf-8"), file).not.toContain(secret);
		}

		// diagnostics: counts, no paths, no ids
		const diag = await diagnostics(relay);
		expect(diag.json.exclude.state).toBe("ok");
		expect(diag.json.exclude.ruleCount).toBe(1);
		expect(diag.json.exclude.drops.path + diag.json.exclude.drops.sticky).toBeGreaterThan(0);
		for (const forbidden of [secret, open, EX, CX_EX, CTL, relay.home]) {
			expect(diag.text).not.toContain(forbidden);
		}

		// the statusline: "not reported (excluded)", and nothing about the session goes upstream
		pointClaudeHooksAtRelay(relay);
		const before = state.requests.length;
		const statusline = Bun.spawn(["bash", STATUSLINE], {
			stdin: new TextEncoder().encode(
				JSON.stringify({ session_id: EX, session_name: "native", model: { display_name: "M" } }),
			),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: relay.home,
				AGENTPULSE_PORT: String(relay.port),
				AGENTPULSE_DIR: relay.dir,
			},
		});
		const slOut = await new Response(statusline.stdout).text();
		await statusline.exited;
		expect(slOut).toContain("not reported (excluded)");
		await Bun.sleep(300);
		expect(mentions(EX)).toEqual([]);
		expect(state.requests.slice(before).some((r) => r.path.includes(EX))).toBe(false);

		// a relay restart keeps the session excluded, even from a directory that is not
		await waitFor("the sticky set on disk", () =>
			existsSync(join(relay.dir, "excluded-sessions.json")),
		);
		await relay.stop();
		const again = await startRelay("main");
		await postHook(again, hookBody(EX, open, "UserPromptSubmit"));
		await postHook(again, { session_id: EX, status: "working" }, { path: "/api/v1/hooks/status" });
		await Bun.sleep(800);
		expect(mentions(EX), "after a restart").toEqual([]);
		// ... while the control session still goes through
		await postHook(again, hookBody(CTL, open, "PostToolUse"));
		await waitFor("the control's event after the restart", () =>
			mentions(CTL).some((r) => r.body.includes("PostToolUse")),
		);
	});

	test("the skip header: honoured, even with no rules file at all", async () => {
		const open = newDir("skip-project");
		const relay = await startRelay("skip", { syncMs: 3_600_000 });
		const SK = "e2e-skip-session";
		const KEEP = "e2e-skip-control";
		await postHook(relay, hookBody(SK, open), { skip: "1" });
		await postHook(relay, hookBody(SK, open, "Stop"), { skip: "TRUE" });
		await postHook(relay, hookBody(KEEP, open), { skip: "$AGENTPULSE_SKIP" });
		await waitFor("the unexpanded-variable hook to be forwarded", () => mentions(KEEP).length >= 1);
		await Bun.sleep(500);
		expect(mentions(SK)).toEqual([]);
		// the statusline in relay mode names the skip variable and sends nothing about the session
		pointClaudeHooksAtRelay(relay);
		const sl = Bun.spawn(["bash", STATUSLINE], {
			stdin: new TextEncoder().encode(
				JSON.stringify({ session_id: SK, model: { display_name: "M" } }),
			),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: relay.home,
				AGENTPULSE_PORT: String(relay.port),
				AGENTPULSE_DIR: relay.dir,
				AGENTPULSE_SKIP: "1",
			},
		});
		expect(await new Response(sl.stdout).text()).toContain("not reported (AGENTPULSE_SKIP)");
		await sl.exited;
		await Bun.sleep(300);
		expect(mentions(SK)).toEqual([]);
	});

	test("a rule added after a session was already being synced stops the periodic CLAUDE.md sync, too", async () => {
		const later = newDir("later-excluded");
		writeFileSync(join(later, "CLAUDE.md"), "# later secret\n");
		const relay = await startRelay("later");
		const LATE = "e2e-later-excluded";
		state.claudeMdSessions = [{ sessionId: LATE, cwd: later, agentType: "claude_code" }];
		await postHook(relay, hookBody(LATE, later));
		await waitFor("the first upload, before any rule", () =>
			mentions(LATE).some((r) => r.method === "PUT" && r.path.endsWith("/claude-md")),
		);
		// From now on the server lists the session WITH a CLAUDE.md checksum and path, so the sync's
		// download side is reachable; a clean control session shows that it is.
		const CTL = "e2e-later-control";
		const open = newDir("later-control");
		await postHook(relay, hookBody(CTL, open));
		const download = (dir: string) => ({
			content: "# from the server\n",
			path: join(dir, "CLAUDE.md"),
			checksum: "server-side-checksum",
		});
		state.claudeMdDownloads[LATE] = download(later);
		state.claudeMdDownloads[CTL] = download(open);
		state.claudeMdSessions = [
			{
				sessionId: LATE,
				cwd: later,
				agentType: "claude_code",
				claudeMdPath: join(later, "CLAUDE.md"),
				claudeMdChecksum: "server-side-checksum",
			},
			{
				sessionId: CTL,
				cwd: open,
				agentType: "claude_code",
				claudeMdPath: join(open, "CLAUDE.md"),
				claudeMdChecksum: "server-side-checksum",
			},
		];
		writeRules(relay, [later]);
		const mark = state.requests.length;
		await waitFor("the control session's CLAUDE.md download", () =>
			state.requests
				.slice(mark)
				.some((r) => r.method === "GET" && r.path === `/api/v1/sessions/${CTL}/claude-md`),
		);
		await Bun.sleep(1500); // several more sync ticks (200 ms) with both listed upstream and both known locally
		expect(
			state.requests.slice(mark).filter((r) => `${r.path}${r.search}${r.body}`.includes(LATE)),
		).toEqual([]);
		expect(readFileSync(join(later, "CLAUDE.md"), "utf-8")).toBe("# later secret\n");
		await postHook(relay, hookBody(LATE, later, "PreToolUse"));
		await Bun.sleep(400);
		expect(
			state.requests.slice(mark).filter((r) => `${r.path}${r.search}${r.body}`.includes(LATE)),
		).toEqual([]);
	});
});

describe("the queue replays against the current rules", () => {
	test("a rule added while an item waits: the item is dropped on replay, never sent again", async () => {
		const dir = newDir("queued-then-excluded");
		const relay = await startRelay("queue-drop", { syncMs: 3_600_000 });
		const Q = "e2e-queued-then-excluded";
		state.failHooks = true;
		await postHook(relay, hookBody(Q, dir));
		await waitFor(
			"the first (failed) attempt, back in the queue",
			() => mentions(Q).length >= 1 && pending(relay).length === 1,
		);
		writeRules(relay, [dir]);
		await waitFor("the item to be dropped on replay", () => pending(relay).length === 0, 30_000);
		const attempts = mentions(Q).length;
		state.failHooks = false;
		await Bun.sleep(1500);
		expect(mentions(Q).length, "nothing was sent for it after the rule").toBe(attempts);
		expect(readdirSync(queueDir(relay, "processing"))).toEqual([]);
	});

	test("rules become invalid while an item for a clean directory waits: held, then sent exactly once after the fix", async () => {
		const dir = newDir("held-clean");
		const relay = await startRelay("queue-hold", { syncMs: 3_600_000 });
		const H = "e2e-held-session";
		state.failHooks = true;
		await postHook(relay, hookBody(H, dir));
		await waitFor(
			"the first (failed) attempt, back in the queue",
			() => mentions(H).length >= 1 && pending(relay).length === 1,
		);
		const rules = writeRules(relay, [dir.replace(/[^/]+$/, "elsewhere"), "relative/not-absolute"]);
		const attemptsBefore = mentions(H).length;
		await waitFor(
			"the item to be held",
			async () => (await diagnostics(relay)).json.exclude.held === 1,
			30_000,
		);
		expect(pending(relay).length).toBe(1);
		state.failHooks = false;
		await Bun.sleep(1500);
		expect(mentions(H).length, "nothing leaves while the rules are invalid").toBe(attemptsBefore);
		expect(existsSync(join(relay.dir, "exclude.invalid"))).toBe(true);

		writeFileSync(rules, `${dir.replace(/[^/]+$/, "elsewhere")}\n`);
		chmodSync(rules, 0o600);
		await waitFor(
			"the held item to be delivered",
			() => mentions(H).some((r) => r.path === "/api/v1/hooks" && r.body.includes("SessionStart")),
			40_000,
		);
		await waitFor("the queue to empty", () => pending(relay).length === 0);
		await Bun.sleep(1500);
		const delivered = mentions(H).filter((r) => r.path === "/api/v1/hooks").length - attemptsBefore;
		expect(delivered, "exactly one delivery after the fix").toBe(1);
		expect(existsSync(join(relay.dir, "exclude.invalid"))).toBe(false);
	});
});

describe("the check endpoint is local only", () => {
	test("a browser Origin or a foreign Host is refused; a plain local request is answered", async () => {
		const dir = newDir("endpoint");
		const relay = await startRelay("endpoint", { syncMs: 3_600_000 });
		writeRules(relay, [dir]);
		const url = `${relay.base}/api/v1/relay/exclude-check?cwd=${encodeURIComponent(dir)}`;
		const ok = await fetch(url);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ excluded: true, reason: "path" });
		expect((await fetch(url, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
		expect((await fetch(url, { headers: { Host: "evil.example" } })).status).toBe(403);
		expect((await fetch(url, { headers: { Host: `127.0.0.1:${relay.port + 1}` } })).status).toBe(
			403,
		);
		expect(state.requests.filter((r) => r.path.includes("exclude-check"))).toEqual([]);
	});
});
