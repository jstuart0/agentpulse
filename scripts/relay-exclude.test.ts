/**
 * The relay's exclude-rule enforcement, driven through its real HTTP surface
 * (a port-0 relay with an upstream `fetch` spy, so every outbound request is
 * seen) and through its exported gate. Nothing here talks to a real server,
 * binds port 4000, or touches a real home: every case gets its own temp HOME
 * and state dir.
 *
 * What is held to account: the relay evaluates BEFORE anything touches disk or
 * the network; "excluded" is sticky per session id (bounded, persisted, ids
 * only); queue replay re-evaluates; every outbound path is gated; a dropped
 * hook looks exactly like a forwarded one to the agent.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type RelayModule = typeof import("./relay.ts");
let loaded: RelayModule | undefined;
// "?module": scripts/check-installers.ts requires relay.ts to be imported with a query.
async function mod(): Promise<RelayModule> {
	loaded ??= await import("./relay.ts?module");
	return loaded;
}

const RELAY_PATH = join(import.meta.dir, "relay.ts");
const KEY = "ap_TESTKEY_exclude_0123456789";
const PORT = 47931;

let root: string;
let home: string;
let stateDir: string;
let workDir: string;
let otherDir: string;
const stops: Array<() => unknown> = [];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-relay-exclude-")));
	home = join(root, "home");
	stateDir = join(root, "state");
	workDir = join(root, "work", "secret");
	otherDir = join(root, "work", "open");
	for (const d of [home, stateDir, workDir, otherDir]) mkdirSync(d, { recursive: true });
});

afterEach(async () => {
	while (stops.length) await stops.pop()?.();
	rmSync(root, { recursive: true, force: true });
});

function writeRules(lines: string[], mode = 0o600): string {
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	const file = join(dir, "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`);
	chmodSync(file, mode);
	return file;
}

type Upstream = { calls: { method: string; url: string; body: string }[] };

function upstreamSpy(respond?: (url: URL, method: string) => Response | undefined) {
	const up: Upstream = { calls: [] };
	const fetchSpy = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		up.calls.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? "") });
		return (
			respond?.(new URL(url), init?.method ?? "GET") ??
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		);
	}) as unknown as typeof fetch;
	return { up, fetchSpy };
}

async function startRelay(
	opts: {
		fetchSpy?: typeof fetch;
		limits?: Record<string, number>;
		excludeFs?: unknown;
		log?: (line: string) => void;
		port?: number;
		accountHome?: () => string | undefined;
	} = {},
) {
	const R = await mod();
	const relay = await R.startRelay(
		{
			remoteUrl: "http://upstream.invalid",
			apiKey: KEY,
			port: opts.port ?? 0,
			codexNamePolicy: "codex",
			stateDir,
			configPath: null,
		},
		{
			timers: false,
			env: { HOME: home },
			scriptPath: RELAY_PATH,
			log: opts.log ?? (() => {}),
			fetch: opts.fetchSpy,
			limits: opts.limits,
			...(opts.excludeFs ? { excludeFs: opts.excludeFs } : {}),
			// Never the real account's home: a test names its own, or none.
			accountHome: opts.accountHome ?? (() => undefined),
		} as never,
	);
	stops.push(() => relay.stop());
	return relay;
}

async function newCtx(
	opts: { fetchSpy?: typeof fetch; limits?: Record<string, number>; excludeFs?: unknown } = {},
) {
	const R = await mod();
	return R.createRelayContext(
		{
			remoteUrl: "http://upstream.invalid",
			apiKey: KEY,
			port: PORT,
			codexNamePolicy: "codex",
			stateDir,
			configPath: null,
		},
		{
			env: { HOME: home },
			scriptPath: RELAY_PATH,
			log: () => {},
			fetch: opts.fetchSpy,
			limits: opts.limits,
			...(opts.excludeFs ? { excludeFs: opts.excludeFs } : {}),
		} as never,
	);
}

async function postHook(
	relay: { port: number },
	payload: unknown,
	opts: { path?: string; skip?: string; agent?: string; raw?: string } = {},
) {
	const res = await fetch(`http://127.0.0.1:${relay.port}${opts.path ?? "/api/v1/hooks"}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Type": opts.agent ?? "claude_code",
			...(opts.skip !== undefined ? { "X-AgentPulse-Skip": opts.skip } : {}),
		},
		body: opts.raw ?? JSON.stringify(payload),
	});
	return { status: res.status, headers: res.headers, text: await res.text() };
}

function pendingFiles(): string[] {
	const dir = join(stateDir, "hook-queue", "pending");
	return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else out.push(full);
	}
	return out;
}

const hook = (sessionId: string, cwd: string | undefined, event = "SessionStart") => ({
	session_id: sessionId,
	hook_event_name: event,
	...(cwd !== undefined ? { cwd } : {}),
});

describe("gateSession — the one decision every outbound path asks", () => {
	test("no rules and no skip: send", async () => {
		const R = await mod();
		const ctx = await newCtx();
		expect(R.gateSession(ctx, { sessionId: "s1", cwd: workDir })).toEqual({ send: true });
	});

	test("the skip header value: allowlisted values drop, even with no rules file; unexpanded, empty and overlong values do not", async () => {
		const R = await mod();
		const ctx = await newCtx();
		for (const skip of ["1", "true", " Yes\r", "\tON\n"]) {
			const v = R.gateSession(ctx, { sessionId: `s-${skip}`, cwd: otherDir, skip });
			expect(v, JSON.stringify(skip)).toMatchObject({ send: false, reason: "skip" });
		}
		for (const skip of ["$AGENTPULSE_SKIP", "", "0", "false", "off", `${" ".repeat(80)}1`]) {
			const v = R.gateSession(ctx, { sessionId: `t-${skip.length}`, cwd: otherDir, skip });
			expect(v, JSON.stringify(skip)).toEqual({ send: true });
		}
	});

	test("a skipped event makes the id excluded for its life: a later event without the header, from a clean directory, is still dropped", async () => {
		const R = await mod();
		const ctx = await newCtx();
		expect(
			R.gateSession(ctx, { sessionId: "skipped-once", cwd: otherDir, skip: "1" }),
		).toMatchObject({
			reason: "skip",
		});
		expect(R.gateSession(ctx, { sessionId: "skipped-once", cwd: otherDir })).toMatchObject({
			send: false,
			reason: "sticky",
		});
		// ... while an id that was never skipped is unaffected
		expect(R.gateSession(ctx, { sessionId: "never-skipped", cwd: otherDir })).toEqual({
			send: true,
		});
	});

	test("a rule that matches the cwd drops with reason path; a clean directory sends", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		expect(R.gateSession(ctx, { sessionId: "a", cwd: workDir })).toMatchObject({
			send: false,
			reason: "path",
		});
		expect(R.gateSession(ctx, { sessionId: "b", cwd: otherDir })).toEqual({ send: true });
		expect(R.gateSession(ctx, { sessionId: "c", cwd: join(workDir, "deep", "er") })).toMatchObject({
			send: false,
			reason: "path",
		});
	});

	test("sticky: once an event of a session is excluded, the id stays excluded when later events come from a clean directory", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		R.gateSession(ctx, { sessionId: "s", cwd: workDir });
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toMatchObject({
			send: false,
			reason: "sticky",
		});
		expect([...ctx.state.exclude.excludedIds.keys()]).toEqual(["s"]);
	});

	test("included is never sticky: a clean event does not protect or poison the id", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toEqual({ send: true });
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toEqual({ send: true });
		expect(ctx.state.exclude.excludedIds.size).toBe(0);
		expect(R.gateSession(ctx, { sessionId: "s", cwd: workDir })).toMatchObject({ send: false });
	});

	test("precedence: skip, then sticky, then path", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		R.gateSession(ctx, { sessionId: "s", cwd: workDir });
		expect(R.gateSession(ctx, { sessionId: "s", cwd: workDir, skip: "1" })).toMatchObject({
			reason: "skip",
		});
		expect(R.gateSession(ctx, { sessionId: "s", cwd: workDir })).toMatchObject({
			reason: "sticky",
		});
		expect(R.gateSession(ctx, { sessionId: "new", cwd: workDir })).toMatchObject({
			reason: "path",
		});
	});

	test("cwd-less traffic: a sticky id drops; an id with a known cwd is evaluated on it; an unknown id is dropped as no_cwd only while rules exist", async () => {
		const R = await mod();
		const ctx = await newCtx();
		// no rules: everything cwd-less is forwarded
		expect(R.gateSession(ctx, { sessionId: "unknown" })).toEqual({ send: true });
		writeRules([workDir]);
		await R.recordLocalSession(ctx, "clean-known", otherDir, "claude_code");
		await R.recordLocalSession(ctx, "now-excluded-known", workDir, "claude_code");
		R.gateSession(ctx, { sessionId: "sticky-one", cwd: workDir });
		expect(R.gateSession(ctx, { sessionId: "sticky-one" })).toMatchObject({ reason: "sticky" });
		expect(R.gateSession(ctx, { sessionId: "clean-known" })).toEqual({ send: true });
		expect(R.gateSession(ctx, { sessionId: "now-excluded-known" })).toMatchObject({
			reason: "path",
		});
		expect(R.gateSession(ctx, { sessionId: "unknown" })).toMatchObject({
			send: false,
			reason: "no_cwd",
		});
		expect(R.gateSession(ctx, {})).toMatchObject({ reason: "no_cwd" });
	});

	test("invalid rules: nothing is sent, the verdict says hold, the marker file appears and warnings say so; fixing the file resumes and clears both", async () => {
		const R = await mod();
		const file = writeRules([workDir, "relative/path"]);
		const ctx = await newCtx();
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toEqual({
			send: false,
			reason: "rules_invalid",
			hold: true,
		});
		expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(true);
		expect(R.computeWarnings(ctx.state)[0]).toBe(
			"exclude rules invalid (line 2): the relay is sending no session data; run: agentpulse exclude check",
		);
		writeFileSync(file, `${workDir}\n`);
		chmodSync(file, 0o600);
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toEqual({ send: true });
		expect(existsSync(join(home, ".agentpulse", "exclude.invalid"))).toBe(false);
		expect(R.computeWarnings(ctx.state).some((w) => w.includes("exclude rules invalid"))).toBe(
			false,
		);
	});

	test("an empty HOME fails closed, like the shell check: nothing is sent", async () => {
		const R = await mod();
		const ctx = R.createRelayContext(
			{
				remoteUrl: "http://upstream.invalid",
				apiKey: KEY,
				port: PORT,
				codexNamePolicy: "codex",
				stateDir,
				configPath: null,
			},
			{ env: { HOME: "" }, homedir: () => "", scriptPath: RELAY_PATH, log: () => {} } as never,
		);
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toMatchObject({
			send: false,
			reason: "rules_invalid",
		});
	});
});

describe("the sticky set — bounded, least recently seen, persisted as ids only", () => {
	test("bounded: the least recently seen id is evicted, and every event touches its id", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx({ limits: { maxExcludedIds: 3 } });
		for (const id of ["a", "b", "c"]) R.gateSession(ctx, { sessionId: id, cwd: workDir });
		R.gateSession(ctx, { sessionId: "a" }); // touched: now the most recent
		R.gateSession(ctx, { sessionId: "d", cwd: workDir });
		expect([...ctx.state.exclude.excludedIds.keys()]).toEqual(["c", "a", "d"]);
	});

	test("an evicted id whose next event still comes from an excluded directory is excluded again by the path rule", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx({ limits: { maxExcludedIds: 2 } });
		for (const id of ["a", "b", "c"]) R.gateSession(ctx, { sessionId: id, cwd: workDir });
		expect(ctx.state.exclude.excludedIds.has("a")).toBe(false);
		expect(R.gateSession(ctx, { sessionId: "a", cwd: workDir })).toMatchObject({
			send: false,
			reason: "path",
		});
	});

	test("persisted: ids only, mode 0600, and a new relay context starts with them", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		R.gateSession(ctx, { sessionId: "persist-me", cwd: workDir });
		await ctx.state.exclude.write;
		const file = ctx.paths.excludedSessionsFile;
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const text = readFileSync(file, "utf-8");
		expect(text).toContain("persist-me");
		expect(text).not.toContain(workDir);
		expect(text).not.toContain("secret");

		const again = await newCtx();
		await R.loadExcludedIds(again);
		expect(again.state.exclude.excludedIds.has("persist-me")).toBe(true);
		expect(R.gateSession(again, { sessionId: "persist-me", cwd: otherDir })).toMatchObject({
			reason: "sticky",
		});
	});

	test("an unreadable or foreign-shaped file is ignored, not trusted", async () => {
		const R = await mod();
		const ctx = await newCtx();
		writeFileSync(
			ctx.paths.excludedSessionsFile,
			'{"version":1,"ids":["ok-id",7,null,"x/../y"]}\n',
		);
		await R.loadExcludedIds(ctx);
		expect([...ctx.state.exclude.excludedIds.keys()]).toEqual(["ok-id"]);
		writeFileSync(ctx.paths.excludedSessionsFile, "not json");
		const ctx2 = await newCtx();
		await R.loadExcludedIds(ctx2);
		expect(ctx2.state.exclude.excludedIds.size).toBe(0);
	});
});

describe("the rules file is read when it changes, not per request", () => {
	test("many decisions, one load; a changed file is loaded again", async () => {
		const R = await mod();
		const file = writeRules([workDir]);
		const ctx = await newCtx();
		for (let i = 0; i < 50; i++) R.gateSession(ctx, { sessionId: `s${i}`, cwd: otherDir });
		expect(ctx.state.exclude.loads).toBe(1);
		writeFileSync(file, `${workDir}\n${otherDir}\n`);
		chmodSync(file, 0o600);
		expect(R.gateSession(ctx, { sessionId: "z", cwd: otherDir })).toMatchObject({ reason: "path" });
		expect(ctx.state.exclude.loads).toBe(2);
		for (let i = 0; i < 20; i++) R.gateSession(ctx, { sessionId: `t${i}`, cwd: join(root, "x") });
		expect(ctx.state.exclude.loads).toBe(2);
	});

	test("a deleted file is noticed (no rules again); a file that appears is noticed", async () => {
		const R = await mod();
		const file = writeRules([workDir]);
		const ctx = await newCtx();
		expect(R.gateSession(ctx, { sessionId: "a", cwd: workDir })).toMatchObject({ send: false });
		rmSync(file);
		expect(R.gateSession(ctx, { sessionId: "b", cwd: workDir })).toEqual({ send: true });
		writeRules([workDir]);
		expect(R.gateSession(ctx, { sessionId: "c", cwd: workDir })).toMatchObject({ send: false });
	});

	test("filesystem calls per decision are pinned: one stat of the directory and one lstat of the rules file, nothing else on the steady path", async () => {
		const R = await mod();
		writeRules([workDir]);
		const calls: string[] = [];
		const fs = await import("node:fs");
		const excludeFs = {
			statSync: (p: string) => {
				calls.push("stat");
				return fs.statSync(p);
			},
			lstatSync: (p: string) => {
				calls.push("lstat");
				return fs.lstatSync(p);
			},
		};
		const ctx = await newCtx({ excludeFs });
		R.gateSession(ctx, { sessionId: "warm", cwd: otherDir });
		calls.length = 0;
		for (let i = 0; i < 10; i++) R.gateSession(ctx, { sessionId: "same", cwd: otherDir });
		expect(calls).toEqual(Array.from({ length: 10 }, () => ["stat", "lstat"]).flat());
		expect(ctx.state.exclude.loads).toBe(1);
	});

	test("with no rules file the steady path is the same two probes and no load beyond the first", async () => {
		const R = await mod();
		const ctx = await newCtx();
		for (let i = 0; i < 30; i++) R.gateSession(ctx, { sessionId: `s${i}`, cwd: otherDir });
		expect(ctx.state.exclude.loads).toBe(1);
		expect(ctx.state.exclude.probes).toBe(30);
	});
});

describe("hook receive: evaluated before anything touches disk or the network", () => {
	test("an excluded hook leaves nothing: no queue file, no local session, no upload, no upstream call, no cwd on disk", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		relay.ctx.state.auth.checkedAt = new Date().toISOString();
		relay.ctx.state.auth.hasManage = true;
		await Bun.write(join(workDir, "CLAUDE.md"), "# secret instructions\n");
		const res = await postHook(relay, hook("excl-1", workDir));
		expect(res.status).toBe(200);
		expect(pendingFiles()).toEqual([]);
		expect(relay.ctx.state.localSessions.has("excl-1")).toBe(false);
		await Bun.sleep(50);
		const R = await mod();
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		for (const file of walkFiles(stateDir)) {
			expect(readFileSync(file, "utf-8"), file).not.toContain(workDir);
		}
		expect(relay.ctx.state.exclude.drops.path).toBe(1);
	});

	test("the agent cannot tell: a dropped hook's response has the same status, content type and body shape as a forwarded one", async () => {
		writeRules([workDir]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const kept = await postHook(relay, hook("keep-1", otherDir));
		const dropped = await postHook(relay, hook("drop-1", workDir));
		const viaSkip = await postHook(relay, hook("drop-2", otherDir), { skip: "1" });
		expect(kept.status).toBe(200);
		for (const res of [dropped, viaSkip]) {
			expect(res.status).toBe(kept.status);
			expect(res.headers.get("content-type")).toBe(kept.headers.get("content-type"));
			const a = JSON.parse(kept.text) as Record<string, unknown>;
			const b = JSON.parse(res.text) as Record<string, unknown>;
			expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
			expect(b.ok).toBe(a.ok);
			expect(b.relayed).toBe(a.relayed);
			expect(b.queued).toBe(a.queued);
			expect(typeof b.queueId).toBe("string");
			expect(b.queueId).not.toBe(a.queueId);
		}
		expect(pendingFiles().length).toBe(1);
	});

	test("a clean hook is queued, remembered and forwarded exactly as before (the control)", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("keep-1", otherDir));
		expect(pendingFiles().length).toBe(1);
		expect(relay.ctx.state.localSessions.get("keep-1")?.cwd).toBe(otherDir);
		const R = await mod();
		await R.processHookQueue(relay.ctx);
		expect(up.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"POST /api/v1/hooks",
		]);
	});

	test("the skip header: honoured with no rules file; a literal $AGENTPULSE_SKIP is forwarded", async () => {
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("skip-1", otherDir), { skip: "1" });
		await postHook(relay, hook("lit-1", otherDir), { skip: "$AGENTPULSE_SKIP" });
		expect(pendingFiles().length).toBe(1);
		const R = await mod();
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
		expect(up.calls[0]?.body).toContain("lit-1");
	});

	test("status updates and native-name traffic carry no cwd: a sticky id is dropped, a known clean id is forwarded, an unknown id is dropped while rules exist", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await postHook(relay, hook("sticky-1", workDir));
		await postHook(relay, hook("clean-1", otherDir));
		await postHook(
			relay,
			{ session_id: "sticky-1", status: "working" },
			{ path: "/api/v1/hooks/status" },
		);
		await postHook(
			relay,
			{ session_id: "clean-1", status: "working" },
			{ path: "/api/v1/hooks/status" },
		);
		await postHook(
			relay,
			{ session_id: "stranger", status: "working" },
			{ path: "/api/v1/hooks/status" },
		);
		await R.processHookQueue(relay.ctx);
		const bodies = up.calls.map((c) => c.body).join("\n");
		expect(bodies).toContain("clean-1");
		expect(bodies).not.toContain("sticky-1");
		expect(bodies).not.toContain("stranger");
		const diag = (await (
			await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`)
		).json()) as { exclude: { drops: Record<string, number> } };
		expect(diag.exclude.drops.sticky).toBe(1);
		expect(diag.exclude.drops.no_cwd).toBe(1);
		expect(diag.exclude.drops.path).toBe(1);
		const noRules = await postHook(relay, { not: "json-with-session" }, { raw: "not json" });
		expect(noRules.status).toBe(200);
	});

	test("invalid rules: live hooks are dropped (and counted), none reach the queue", async () => {
		writeRules([workDir, "relative"]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const res = await postHook(relay, hook("s", otherDir));
		expect(res.status).toBe(200);
		expect(pendingFiles()).toEqual([]);
		expect(up.calls).toEqual([]);
		expect(relay.ctx.state.exclude.drops.rules_invalid).toBe(1);
	});
});

describe("a queued hook is never visible half-written (a lease would delete it as corrupt)", () => {
	test("while many large hooks are being queued, every .json file the queue directory shows parses, and none is lost", async () => {
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		const total = 12;
		const filler = "x".repeat(2_000_000);
		const seen = new Set<string>();
		let torn = 0;
		let polling = true;
		const poller = (async () => {
			const dir = join(stateDir, "hook-queue", "pending");
			while (polling) {
				let names: string[] = [];
				try {
					names = readdirSync(dir).filter((n) => n.endsWith(".json"));
				} catch {}
				for (const name of names) {
					if (seen.has(name)) continue;
					try {
						JSON.parse(readFileSync(join(dir, name), "utf-8"));
						seen.add(name);
					} catch (err) {
						if ((err as { code?: string }).code !== "ENOENT") torn++;
					}
				}
				await new Promise((r) => setImmediate(r));
			}
		})();
		await Promise.all(
			Array.from({ length: total }, (_, i) =>
				postHook(relay, { ...hook(`big-${i}`, otherDir, "PreToolUse"), filler }),
			),
		);
		polling = false;
		await poller;
		expect(torn, "a half-written queue file was visible").toBe(0);
		// nothing was lost: every one of them is forwarded exactly once
		await R.processHookQueue(relay.ctx);
		const posts = up.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/v1/hooks"));
		expect(posts.length).toBe(total);
		expect(pendingFiles()).toEqual([]);
		expect(readdirSync(join(stateDir, "hook-queue", "processing"))).toEqual([]);
		expect(seen.size).toBeGreaterThan(0);
	}, 30_000);
});

describe("a queue file is never half-written where a lease can see it, on every path that writes one (deterministic: the write calls back at each stage)", () => {
	type Stage = { stage: string; tmp: string; final: string; visible: string[] };

	function recordStages(relay: { ctx: { queueWriteHook?: unknown } }): Stage[] {
		const stages: Stage[] = [];
		relay.ctx.queueWriteHook = (stage: string, tmp: string, final: string) => {
			const dir = join(stateDir, "hook-queue", "pending");
			stages.push({ stage, tmp, final, visible: readdirSync(dir) });
		};
		return stages;
	}

	function expectNeverLeasable(stages: Stage[], label: string) {
		expect(stages.length, `${label}: the write reported its stages`).toBeGreaterThanOrEqual(2);
		for (const { stage, tmp, final, visible } of stages) {
			expect(tmp.endsWith(".json"), `${label}/${stage}: the temp name is one no lease reads`).toBe(
				false,
			);
			expect(
				visible,
				`${label}/${stage}: the item is not visible under its final name yet`,
			).not.toContain(final.split("/").pop() as string);
			for (const name of visible.filter((n) => n.endsWith(".json"))) {
				expect(
					() => JSON.parse(readFileSync(join(stateDir, "hook-queue", "pending", name), "utf-8")),
					`${label}/${stage}: ${name} parses`,
				).not.toThrow();
			}
		}
		expect(stages.some((s) => s.stage === "written")).toBe(true);
	}

	test("enqueue, release after a server error, and hold while the rules are invalid", async () => {
		const R = await mod();
		const { fetchSpy } = upstreamSpy(() => new Response("down", { status: 503 }));
		const relay = await startRelay({ fetchSpy });

		const enqueue = recordStages(relay);
		await postHook(relay, hook("seam-1", otherDir));
		expectNeverLeasable(enqueue, "enqueue");

		const release = recordStages(relay);
		await R.processHookQueue(relay.ctx);
		expectNeverLeasable(release, "release");

		// make the item due again, then break the rules so it is held
		const queued = join(stateDir, "hook-queue", "pending", pendingFiles()[0] as string);
		const item = JSON.parse(readFileSync(queued, "utf-8"));
		item.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
		writeFileSync(queued, JSON.stringify(item));
		writeRules(["relative/not-absolute"]);
		const hold = recordStages(relay);
		await R.processHookQueue(relay.ctx);
		expectNeverLeasable(hold, "hold");
	});
});

describe("queue replay re-evaluates against the current rules", () => {
	test("a rule added while the item waits: the item is deleted on replay, never sent", async () => {
		const R = await mod();
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("late-1", workDir));
		expect(pendingFiles().length).toBe(1);
		writeRules([workDir]);
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		expect(pendingFiles()).toEqual([]);
		expect(readdirSync(join(stateDir, "hook-queue", "processing"))).toEqual([]);
	});

	test("rules that become invalid while an item for a clean directory waits: held, not sent, not deleted; sent exactly once after the file is fixed", async () => {
		const R = await mod();
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("held-1", otherDir));
		const file = writeRules([workDir, "relative"]);
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		expect(pendingFiles().length).toBe(1);
		const diag = (await (
			await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`)
		).json()) as {
			exclude: { held: number };
			queue: {
				pending: number;
				consecutiveHookFailures: number;
				lastHookError: string | null;
				lastHookFailureAt: string | null;
			};
		};
		expect(diag.exclude.held).toBe(1);
		// holding is not the server failing: no failure is recorded for it
		expect(diag.queue.consecutiveHookFailures).toBe(0);
		expect(diag.queue.lastHookError).toBeNull();
		expect(diag.queue.lastHookFailureAt).toBeNull();
		expect(diag.queue.pending).toBe(1);

		writeFileSync(file, `${workDir}\n`);
		chmodSync(file, 0o600);
		// the held item waits out its normal backoff; make it due
		const queued = join(stateDir, "hook-queue", "pending", pendingFiles()[0] as string);
		const item = JSON.parse(readFileSync(queued, "utf-8"));
		item.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
		writeFileSync(queued, JSON.stringify(item));
		await R.processHookQueue(relay.ctx);
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
		expect(up.calls[0]?.body).toContain("held-1");
		expect(pendingFiles()).toEqual([]);
	});

	test("a sticky id drops its queued items too", async () => {
		const R = await mod();
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("sticky-q", otherDir, "PreToolUse"));
		writeRules([workDir]);
		R.gateSession(relay.ctx, { sessionId: "sticky-q", cwd: workDir });
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		expect(pendingFiles()).toEqual([]);
	});
});

describe("every outbound path is gated", () => {
	test('the proxy: an excluded id gets a local 404 {error:"excluded"} and no upstream call, for the session lookup and the native-name push', async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("proxy-excl", workDir));
		await postHook(relay, hook("proxy-ok", otherDir));
		const base = `http://127.0.0.1:${relay.port}`;
		const lookup = await fetch(`${base}/api/v1/sessions/proxy-excl`);
		expect(lookup.status).toBe(404);
		expect(await lookup.json()).toEqual({ error: "excluded" });
		const put = await fetch(`${base}/api/v1/sessions/proxy-excl/native-name`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x" }),
		});
		expect(put.status).toBe(404);
		expect(up.calls).toEqual([]);
		const ok = await fetch(`${base}/api/v1/sessions/proxy-ok`);
		expect(ok.status).toBe(200);
		expect(up.calls.length).toBe(1);
	});

	test("the CLAUDE.md sync: an upload and a download for a session whose directory is now excluded never go out", async () => {
		const { up, fetchSpy } = upstreamSpy((url) => {
			if (url.pathname === "/api/v1/sessions" && url.searchParams.get("limit") === "20") {
				return Response.json({
					sessions: [
						{ sessionId: "md-excl", cwd: workDir, agentType: "claude_code" },
						{ sessionId: "md-ok", cwd: otherDir, agentType: "claude_code" },
					],
				});
			}
			return undefined;
		});
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		// both were recorded while no rule existed
		await R.recordLocalSession(relay.ctx, "md-excl", workDir, "claude_code");
		await R.recordLocalSession(relay.ctx, "md-ok", otherDir, "claude_code");
		await Bun.write(join(workDir, "CLAUDE.md"), "# secret\n");
		await Bun.write(join(otherDir, "CLAUDE.md"), "# open\n");
		relay.ctx.state.auth.checkedAt = new Date().toISOString();
		relay.ctx.state.auth.hasManage = true;
		writeRules([workDir]);
		await R.syncClaudeMdTick(relay.ctx);
		const sent = up.calls.filter((c) => c.method === "PUT");
		expect(sent.length).toBe(1);
		expect(sent[0]?.url).toContain("/sessions/md-ok/claude-md");
		expect(up.calls.map((c) => c.url).join("\n")).not.toContain("md-excl");
	});

	test("the CLAUDE.md sync's DOWNLOAD side: a listed session that already has a checksum and path, recorded before the rule, is never fetched; a clean one is (the control)", async () => {
		const mdFor = (dir: string) => ({
			content: "# from the server\n",
			path: join(dir, "CLAUDE.md"),
			checksum: "server-checksum",
		});
		const { up, fetchSpy } = upstreamSpy((url) => {
			if (url.pathname === "/api/v1/sessions" && url.searchParams.get("limit") === "20") {
				return Response.json({
					sessions: [
						{
							sessionId: "dl-excl",
							cwd: workDir,
							agentType: "claude_code",
							claudeMdPath: join(workDir, "CLAUDE.md"),
							claudeMdChecksum: "server-checksum",
						},
						{
							sessionId: "dl-ok",
							cwd: otherDir,
							agentType: "claude_code",
							claudeMdPath: join(otherDir, "CLAUDE.md"),
							claudeMdChecksum: "server-checksum",
						},
					],
				});
			}
			if (url.pathname === "/api/v1/sessions/dl-excl/claude-md")
				return Response.json(mdFor(workDir));
			if (url.pathname === "/api/v1/sessions/dl-ok/claude-md")
				return Response.json(mdFor(otherDir));
			return undefined;
		});
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await R.recordLocalSession(relay.ctx, "dl-excl", workDir, "claude_code");
		await R.recordLocalSession(relay.ctx, "dl-ok", otherDir, "claude_code");
		relay.ctx.state.auth.checkedAt = new Date().toISOString();
		relay.ctx.state.auth.hasManage = true;
		writeRules([workDir]);
		await R.syncClaudeMdTick(relay.ctx);
		const mdCalls = up.calls.filter((c) => c.url.includes("/claude-md"));
		expect(mdCalls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"GET /api/v1/sessions/dl-ok/claude-md",
		]);
		expect(existsSync(join(workDir, "CLAUDE.md"))).toBe(false);
		expect(readFileSync(join(otherDir, "CLAUDE.md"), "utf-8")).toBe("# from the server\n");
	});

	test("uploadClaudeMd asks the gate itself: called directly for an excluded session it sends nothing; for a clean one it uploads", async () => {
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await Bun.write(join(workDir, "CLAUDE.md"), "# secret\n");
		await Bun.write(join(otherDir, "CLAUDE.md"), "# open\n");
		writeRules([workDir]);
		await R.uploadClaudeMd(relay.ctx, "direct-excl", workDir, "claude_code");
		expect(up.calls).toEqual([]);
		await R.uploadClaudeMd(relay.ctx, "direct-ok", otherDir, "claude_code");
		expect(up.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			"PUT /api/v1/sessions/direct-ok/claude-md",
		]);
	});

	test("the Codex name sync: an excluded or unknown id is never PUT while rules exist; a known clean id is; with no rules, an unknown id is free again but an excluded one stays excluded", async () => {
		const R = await mod();
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const ctx = relay.ctx;
		const index = join(home, ".codex", "session_index.jsonl");
		mkdirSync(join(home, ".codex"), { recursive: true });
		const rows = ["cx-excl", "cx-ok", "cx-unknown"].map((id) =>
			JSON.stringify({ id, thread_name: `name ${id}`, updated_at: "2026-09-28T11:00:00.000Z" }),
		);
		writeFileSync(index, `${rows.join("\n")}\n`);
		await R.recordLocalSession(ctx, "cx-excl", workDir, "codex_cli");
		await R.recordLocalSession(ctx, "cx-ok", otherDir, "codex_cli");
		writeRules([workDir]);
		await R.pullCodexNames(ctx);
		const puts = up.calls.filter((c) => c.method === "PUT").map((c) => c.url);
		expect(puts.some((u) => u.includes("/sessions/cx-ok/native-name"))).toBe(true);
		expect(puts.some((u) => u.includes("cx-excl"))).toBe(false);
		expect(puts.some((u) => u.includes("cx-unknown"))).toBe(false);

		rmSync(join(home, ".agentpulse", "exclude"));
		ctx.state.codexPull.clear();
		up.calls.length = 0;
		await R.pullCodexNames(ctx);
		// the unknown id is free again; the excluded one stays excluded for its life (sticky)
		const afterPuts = up.calls.filter((c) => c.method === "PUT").map((c) => c.url);
		expect(afterPuts.length).toBe(2);
		expect(afterPuts.some((u) => u.includes("cx-unknown"))).toBe(true);
		expect(afterPuts.some((u) => u.includes("cx-excl"))).toBe(false);
	});
});

describe("diagnostics, warnings, the check endpoint and file modes", () => {
	test("the exclude block: state, rule count, mode, mtime, drop counts and held count — no paths, no session ids", async () => {
		writeRules([workDir, otherDir]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("diag-secret-id", workDir));
		const res = await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`);
		const text = await res.text();
		const d = JSON.parse(text) as {
			exclude: {
				state: string;
				ruleCount: number;
				mode: string;
				mtime: string;
				invalidLine: number | null;
				drops: Record<string, number>;
				held: number;
			};
		};
		expect(d.exclude.state).toBe("ok");
		expect(d.exclude.ruleCount).toBe(2);
		expect(d.exclude.mode).toBe("0600");
		expect(Number.isFinite(Date.parse(d.exclude.mtime))).toBe(true);
		expect(d.exclude.invalidLine).toBeNull();
		expect(Object.keys(d.exclude.drops).sort()).toEqual(
			["no_cwd", "path", "rules_invalid", "skip", "sticky"].sort(),
		);
		expect(d.exclude.drops.path).toBe(1);
		expect(d.exclude.held).toBe(0);
		expect(text).not.toContain(workDir);
		expect(text).not.toContain(otherDir);
		expect(text).not.toContain("diag-secret-id");
		expect(text).not.toContain(root);
	});

	test("diagnostics for invalid rules name the line and nothing from the file", async () => {
		writeRules([workDir, "relative/dir"]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const text = await (
			await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`)
		).text();
		const d = JSON.parse(text) as { exclude: { state: string; invalidLine: number } };
		expect(d.exclude.state).toBe("invalid");
		expect(d.exclude.invalidLine).toBe(2);
		expect(text).not.toContain("relative/dir");
	});

	test("the invalid-rules warning is the status line and lands in the status file", async () => {
		writeRules(["relative/dir"]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		R.gateSession(relay.ctx, { sessionId: "s", cwd: otherDir });
		await R.writeStatusFile(relay.ctx);
		expect(readFileSync(relay.ctx.paths.statusFile, "utf-8").trim()).toBe(
			`exclude rules invalid (line 1): use an absolute path (or ~/...): ${join(home, "relative/dir")}; the relay is sending no session data; run: agentpulse exclude check`,
		);
		const health = (await (await fetch(`http://127.0.0.1:${relay.port}/api/v1/health`)).json()) as {
			warnings: string[];
		};
		expect(health.warnings[0]).toContain("the relay is sending no session data");
	});

	test("GET /api/v1/relay/exclude-check?cwd=… answers for an excluded and a clean directory, without changing what is sticky", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const base = `http://127.0.0.1:${relay.port}/api/v1/relay/exclude-check`;
		const excluded = (await (await fetch(`${base}?cwd=${encodeURIComponent(workDir)}`)).json()) as {
			excluded: boolean;
			reason: string;
			rulesState: string;
		};
		expect(excluded).toMatchObject({ excluded: true, reason: "path", rulesState: "ok" });
		const clean = (await (await fetch(`${base}?cwd=${encodeURIComponent(otherDir)}`)).json()) as {
			excluded: boolean;
		};
		expect(clean.excluded).toBe(false);
		expect(relay.ctx.state.exclude.excludedIds.size).toBe(0);
		expect(up.calls).toEqual([]);
		const missing = await fetch(base);
		expect(missing.status).toBe(400);
	});

	test("the check endpoint refuses a browser (Origin) and a wrong Host, like every other local endpoint", async () => {
		writeRules([workDir]);
		const relay = await startRelay({});
		const url = `http://127.0.0.1:${relay.port}/api/v1/relay/exclude-check?cwd=${encodeURIComponent(workDir)}`;
		const withOrigin = await fetch(url, { headers: { Origin: "https://evil.example" } });
		expect(withOrigin.status).toBe(403);
		const wrongHost = await fetch(url, { headers: { Host: "evil.example" } });
		expect(wrongHost.status).toBe(403);
	});

	test("startup tightens the rules file to 0600 with the rest of the relay's state", async () => {
		const file = writeRules([workDir], 0o644);
		await startRelay({});
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

/**
 * A tripwire on the relay's source text, not a proof that nothing else can send: it reads names, so a
 * send that goes through a name this scan does not know (a helper in another module, a computed
 * property) is not seen. What it does hold: every place the relay's two outbound primitives are
 * called is on the list below, once for each entry; the primitives are only ever called by name; and
 * the usual other ways out (a bare, destructured or stored fetch, a network module, a process spawn)
 * are not there.
 */
describe("every outbound call site goes through the gate or is on the not-session-data list", () => {
	const realSource = readFileSync(RELAY_PATH, "utf-8");

	/** [enclosing function, a distinguishing text of the call, how it is classified, why] */
	const EXPECTED: [string, string, "gated" | "allowed", string][] = [
		["remoteFetch", "ctx.fetch(", "allowed", "the primitive the sites below call"],
		["forwardApiRequest", "ctx.fetch(", "allowed", "the primitive the gated forwards below call"],
		["checkScopesTick", "/api/v1/auth/me", "allowed", "the key's own scopes; no session data"],
		[
			"checkDriftTick",
			"/api/v1/health",
			"allowed",
			"health and version checksums; no session data",
		],
		["uploadClaudeMd", "/claude-md", "gated", "CLAUDE.md upload"],
		[
			"syncClaudeMdTick",
			"limit=${CLAUDE_MD_SESSION_LIMIT}",
			"allowed",
			"the session list read; no id or content is sent",
		],
		["syncClaudeMdTick", "/claude-md", "gated", "CLAUDE.md download"],
		["pullCodexNames", "/native-name", "gated", "Codex name pull"],
		[
			"fetchCodexSessions",
			"/api/v1/sessions?agent_type=codex_cli",
			"allowed",
			"the list read; no id or content is sent",
		],
		["handleLeasedHook", "forwardApiRequest(", "gated", "queue replay"],
		["createFetchHandler", "forwardApiRequest(", "gated", "the proxy"],
	];

	/** Source with comments removed (same length, so offsets still line up): a call named in a comment is not a call. */
	function withoutComments(source: string): string {
		return source
			.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
			.replace(
				/(^|[^:"'`\\])\/\/[^\n]*/g,
				(m, lead: string) => lead + " ".repeat(m.length - lead.length),
			);
	}

	/** The function a position is in: the nearest `function name(` before it, wherever on its line it sits (a one-line function counts). */
	function enclosingFunction(code: string, index: number): string {
		const matches = [...code.slice(0, index).matchAll(/(?<![\w.])function\s+(\w+)\s*\(/g)];
		return matches.at(-1)?.[1] ?? "<top level>";
	}

	/** Every place the primitives are called (a function's own declaration is not a call). */
	function callSites(code: string): { fn: string; at: number; text: string }[] {
		const out: { fn: string; at: number; text: string }[] = [];
		for (const m of code.matchAll(
			/(?<!function\s)\b(remoteFetch|forwardApiRequest)\(|\bctx\.fetch\(/g,
		)) {
			const at = m.index as number;
			out.push({ fn: enclosingFunction(code, at), at, text: code.slice(at, at + 260) });
		}
		return out;
	}

	/** Anything that can send a request other than through the two primitives (and the one place the global fetch is read). */
	function strayOutboundUses(code: string): string[] {
		const snippet = (at: number) => code.slice(Math.max(0, at - 20), at + 40).replace(/\s+/g, " ");
		const out: string[] = [];
		// a bare fetch call
		for (const m of code.matchAll(/(?<![\w.$])fetch\s*\(/g))
			out.push(`bare fetch call: ${snippet(m.index ?? 0)}`);
		// any property named fetch other than ctx.fetch( and the context's own default (opts.fetch ?? fetch)
		for (const m of code.matchAll(
			/(?<![\w$])(\w+)\s*(?:\.|\?\.)\s*fetch\b|\[\s*["'`]fetch["'`]\s*\]/g,
		)) {
			const text = code.slice(m.index ?? 0, (m.index ?? 0) + 40);
			if (/^ctx\.fetch\(/.test(text) || /^opts\.fetch \?\? fetch/.test(text)) continue;
			out.push(`other fetch access: ${snippet(m.index ?? 0)}`);
		}
		// the global fetch read anywhere but the context's default
		for (const m of code.matchAll(/(?<![.\w$])(?<!typeof )fetch\b(?!\s*[(:?])/g)) {
			const text = code
				.slice(Math.max(0, (m.index ?? 0) - 14), (m.index ?? 0) + 5)
				.replace(/\s+/g, " ");
			if (text !== "opts.fetch ?? fetch") out.push(`global fetch read: ${snippet(m.index ?? 0)}`);
		}
		// a destructured fetch: an assignment, or the parameter list of a function or arrow function
		for (const m of code.matchAll(
			/\{[^{}]*(?<![\w$.])fetch\b[^{}]*\}\s*=(?![=>])|\bfunction\b[^(]*\(\s*\{[^{}]*(?<![\w$.])fetch\b[^{}]*\}|\(\s*\{[^{}]*(?<![\w$.])fetch\b[^{}]*\}[^()]*\)\s*=>/g,
		)) {
			out.push(`destructured fetch: ${snippet(m.index ?? 0)}`);
		}
		// a dynamic import of a module that can open a connection
		for (const m of code.matchAll(
			/\bimport\s*\(\s*["'](?:node:)?(?:https?|net|tls|dgram|dns|http2|child_process)["']\s*\)/g,
		)) {
			out.push(`dynamic network import: ${snippet(m.index ?? 0)}`);
		}
		// a process spawn: the one allowed is the PowerShell ACL query inside the shared evaluator
		for (const m of code.matchAll(
			/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g,
		)) {
			if (m[1]?.trim() !== "execFileSync") out.push(`spawn import: ${snippet(m.index ?? 0)}`);
		}
		for (const m of code.matchAll(
			/\bBun\s*\.\s*(?:(?:spawn|spawnSync)\b|\$)|(?<![\w$.])(?:spawn|spawnSync|exec|execSync|execFile|fork)\s*\(/g,
		)) {
			out.push(`process spawn: ${snippet(m.index ?? 0)}`);
		}
		const execs = [...code.matchAll(/(?<![\w$.])execFileSync\s*\(\s*([^,)]*)/g)];
		for (const m of execs) {
			if (m[1]?.trim() !== '"powershell"')
				out.push(`execFileSync of ${m[1]}: ${snippet(m.index ?? 0)}`);
		}
		if (execs.length > 1) out.push(`${execs.length} execFileSync calls (one is expected)`);
		// other ways out of the process
		for (const m of code.matchAll(
			/from\s+["'](?:node:)?(?:https?|net|tls|dgram|dns|http2)["']|require\(\s*["'](?:node:)?(?:https?|net|tls|dgram|dns|http2)["']\s*\)|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bBun\.(?:connect|listen|udpSocket)\b/g,
		)) {
			out.push(`other network use: ${snippet(m.index ?? 0)}`);
		}
		return out;
	}

	/** Everything wrong with `source` against the table: empty means every outbound path is accounted for. */
	function outboundProblems(source: string): string[] {
		const code = withoutComments(source);
		const sites = callSites(code);
		const problems: string[] = [...strayOutboundUses(code)];
		// Every site is accounted for by one entry, and every entry by one site: a second call to a
		// primitive inside a function that is already listed has no entry left to explain it.
		const unmatched = [...EXPECTED];
		for (const site of sites) {
			const at = unmatched.findIndex(
				([fn, needle]) =>
					fn === site.fn &&
					(needle === "ctx.fetch("
						? site.text.startsWith("ctx.fetch(")
						: site.text.includes(needle)),
			);
			if (at < 0) {
				problems.push(
					`unclassified outbound call (or one too many) in ${site.fn}: ${site.text.slice(0, 80)}`,
				);
				continue;
			}
			unmatched.splice(at, 1);
		}
		for (const [fn, needle] of unmatched) problems.push(`${fn} / ${needle} is expected to exist`);
		for (const [fn, needle, kind] of EXPECTED) {
			if (kind !== "gated") continue;
			const site = sites.find((s) => s.fn === fn && s.text.includes(needle));
			if (!site) continue;
			const fnStart = code.search(new RegExp(`function ${fn}\\b`));
			if (code.slice(fnStart, site.at).search(/gateSession\(|gateQueuedItem\(/) === -1) {
				problems.push(`${fn} sends without asking the gate first`);
			}
		}
		const ctxFetchFns = new Set(
			sites.filter((s) => s.text.startsWith("ctx.fetch(")).map((s) => s.fn),
		);
		if ([...ctxFetchFns].sort().join() !== "forwardApiRequest,remoteFetch") {
			problems.push(`ctx.fetch is called from: ${[...ctxFetchFns].sort().join(", ")}`);
		}
		for (const name of ["remoteFetch", "forwardApiRequest", "ctx\\.fetch"]) {
			for (const m of code.matchAll(new RegExp(`(?<!function\\s)\\b${name}\\b(?!\\()`, "g"))) {
				problems.push(
					`${name} used other than by a direct call: ${code.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 40).replace(/\s+/g, " ")}`,
				);
			}
		}
		return problems;
	}

	test("the real relay: every outbound call is classified, every gated one asks the gate first, nothing else can send, and the primitives are only called by name", () => {
		expect(outboundProblems(realSource)).toEqual([]);
	});

	test("every classification carries a reason", () => {
		for (const [fn, needle, , why] of EXPECTED) {
			expect(why.trim().length, `${fn} / ${needle} needs a reason`).toBeGreaterThan(8);
		}
	});

	test("the checker is not blind: a new fetch call, a globalThis.fetch call, a stored fetch, an unlisted primitive call or another network module turns it red, one-line functions included", () => {
		const plant = (code: string) => `${realSource}\n${code}\n`;
		const planted: [string, string][] = [
			[
				"a one-line function with a bare fetch",
				'async function leakOne(url: string) { return fetch("https://x.example/" + url); }',
			],
			[
				"a multi-line function with a bare fetch",
				"async function leakMulti(url: string) {\n\treturn fetch(`https://x.example/${url}`);\n}",
			],
			[
				"globalThis.fetch in a one-line function",
				"function leakTwo(url: string) { return globalThis.fetch(url); }",
			],
			["a stored fetch", "const grabbed = globalThis.fetch;"],
			["a bracketed fetch", 'const other = globalThis["fetch"];'],
			[
				"ctx.fetch in an unlisted one-line function",
				'function leakThree(ctx: RelayContext) { return ctx.fetch("https://x.example/"); }',
			],
			[
				"a primitive call in an unlisted one-line function",
				'function leakFour(ctx: RelayContext) { return remoteFetch(ctx, "/x"); }',
			],
			[
				"a forward in an unlisted one-line function",
				"function leakFive(ctx: RelayContext) { return forwardApiRequest(ctx, { pathname: '/x', search: '', method: 'GET', contentType: '' }); }",
			],
			["a primitive passed on", "const alias = remoteFetch;"],
			["another network module", 'import { request } from "node:https";'],
			["a socket", "const ws = new WebSocket('wss://x.example');"],
		];
		for (const [label, code] of planted) {
			expect(outboundProblems(plant(code)).length, label).toBeGreaterThan(0);
		}
	});

	test("a second call to a primitive inside a function that is already listed turns it red, whichever of its lines it sits on", () => {
		const insertAfter = (needle: string, add: string) => {
			expect(realSource.split(needle).length, `${needle} is in the real source once`).toBe(2);
			return realSource.replace(needle, `${needle}\n${add}`);
		};
		const cases: [string, string][] = [
			[
				"a second forward in the queue replay",
				insertAfter(
					"const gate = gateQueuedItem(ctx, leased.item);",
					"void forwardApiRequest(ctx, { ...leased.item });",
				),
			],
			[
				"a second ctx.fetch in the forwarding primitive",
				insertAfter(
					'const headers = new Headers();\n\theaders.set("Content-Type"',
					'await ctx.fetch("https://x.example/");',
				),
			],
			[
				"a second remote call in a listed sender",
				(() => {
					const signature = /async function uploadClaudeMd\([^)]*\)[^{]*\{/;
					expect(realSource).toMatch(signature);
					return realSource.replace(
						signature,
						(head) => `${head}\n\tvoid remoteFetch(ctx, "/api/v1/sessions/x/claude-md", {});`,
					);
				})(),
			],
		];
		for (const [label, source] of cases) {
			expect(outboundProblems(source).length, label).toBeGreaterThan(0);
		}
	});

	test("the other ways out are seen too: a destructured fetch, a dynamic import of a network module, and a process spawn", () => {
		const plant = (code: string) => `${realSource}\n${code}\n`;
		const planted: [string, string][] = [
			["a renamed destructured fetch", "const { fetch: send } = ctx;"],
			["a destructured fetch", "const { fetch } = ctx;"],
			[
				"a destructured fetch parameter",
				"function leakSix({ fetch: send }: RelayContext) { return send; }",
			],
			["a dynamic import of node:https", 'const https = await import("node:https");'],
			["a dynamic import of http", "const http = await import('http');"],
			["a dynamic import of node:net", 'const net = await import("node:net");'],
			["a spawn import", 'import { spawn } from "node:child_process";'],
			["Bun.spawn", 'const p = Bun.spawn(["curl", "https://x.example"]);'],
			["Bun's shell", "const out = await Bun.$`curl https://x.example`;"],
			["a second execFileSync of curl", 'const c = execFileSync("curl", ["https://x.example"]);'],
			[
				"a second execFileSync of powershell",
				'const e = execFileSync("powershell", ["-Command", "x"]);',
			],
			["execSync", 'const d = execSync("curl https://x.example");'],
		];
		for (const [label, code] of planted) {
			expect(outboundProblems(plant(code)).length, label).toBeGreaterThan(0);
		}
		// the one process the relay starts is the PowerShell ACL query; the same call aimed elsewhere is not
		expect(realSource).toContain('execFileSync("powershell"');
		expect(
			outboundProblems(realSource.replace('execFileSync("powershell"', 'execFileSync("curl"'))
				.length,
		).toBeGreaterThan(0);
	});

	test("a call named only in a comment is not a call", () => {
		expect(
			outboundProblems(
				`${realSource}\n// fetch("https://x.example") is never made\n/* globalThis.fetch(url) */\n`,
			),
		).toEqual([]);
	});
});

describe("the proxy tells an unknown session from an excluded one", () => {
	const lookup = (relay: { port: number }, id: string, headers: Record<string, string> = {}) =>
		fetch(`http://127.0.0.1:${relay.port}/api/v1/sessions/${id}`, { headers });

	test("a session id the relay has never seen is answered unknown_session, never excluded; excluded is for skip, sticky and path", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("by-path", workDir));
		await postHook(relay, hook("by-skip", otherDir), { skip: "1" });

		const stranger = await lookup(relay, "never-seen");
		expect(stranger.status).toBe(404);
		expect(await stranger.json()).toEqual({ error: "unknown_session" });

		for (const id of ["by-path", "by-skip"]) {
			const res = await lookup(relay, id);
			expect(res.status, id).toBe(404);
			expect(await res.json(), id).toEqual({ error: "excluded" });
		}
		const viaHeader = await lookup(relay, "fresh-skip", { "X-AgentPulse-Skip": "1" });
		expect(await viaHeader.json()).toEqual({ error: "excluded" });
		expect(up.calls).toEqual([]);
	});

	test("the native-name push for an unknown id gets the same unknown_session answer, and nothing goes upstream", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const put = await fetch(
			`http://127.0.0.1:${relay.port}/api/v1/sessions/never-seen/native-name`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "x" }),
			},
		);
		expect(put.status).toBe(404);
		expect(await put.json()).toEqual({ error: "unknown_session" });
		expect(up.calls).toEqual([]);
	});

	test("while the rules are invalid the answer is neither excluded nor unknown_session", async () => {
		writeRules([workDir, "relative/dir"]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const res = await lookup(relay, "any-id");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "rules_invalid" });
		expect(up.calls).toEqual([]);
	});

	test("/api/v1/sessions/stats is not a session id: it is forwarded with rules present", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const res = await lookup(relay, "stats");
		expect(res.status).toBe(200);
		expect(up.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v1/sessions/stats"]);
		expect(relay.ctx.state.exclude.drops.no_cwd).toBe(0);
	});

	test("health says the relay enforces exclude rules, with and without a rules file", async () => {
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const health = async () =>
			(await (await fetch(`http://127.0.0.1:${relay.port}/api/v1/health`)).json()) as {
				enforcesExcludeRules?: boolean;
			};
		expect((await health()).enforcesExcludeRules).toBe(true);
		writeRules([workDir]);
		expect((await health()).enforcesExcludeRules).toBe(true);
	});
});

describe("the session id is read the way the server reads it", () => {
	const copilot = (id: string, cwd: string | undefined, extra: Record<string, unknown> = {}) => ({
		sessionId: id,
		...(cwd !== undefined ? { cwd } : {}),
		toolName: "bash",
		...extra,
	});

	test("a Copilot session (camelCase sessionId) excluded by its directory stays excluded after it moves: zero upstream requests", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await postHook(relay, copilot("cp-moves", workDir), { agent: "copilot_cli" });
		expect([...relay.ctx.state.exclude.excludedIds.keys()]).toEqual(["cp-moves"]);
		await postHook(relay, copilot("cp-moves", otherDir), { agent: "copilot_cli" });
		await postHook(
			relay,
			{ sessionId: "cp-moves", status: "working" },
			{
				agent: "copilot_cli",
				path: "/api/v1/hooks/status",
			},
		);
		await R.processHookQueue(relay.ctx);
		expect(pendingFiles()).toEqual([]);
		expect(up.calls).toEqual([]);
		expect(relay.ctx.state.exclude.drops.sticky).toBe(2);
	});

	test("a Copilot session from a clean directory is forwarded and remembered with its directory", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await postHook(relay, copilot("cp-open", otherDir), { agent: "copilot_cli" });
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
		expect(relay.ctx.state.localSessions.get("cp-open")?.cwd).toBe(otherDir);
	});

	test("the id is whichever of session_id and sessionId is a non-empty string; every id present is made sticky together", async () => {
		writeRules([workDir]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, { session_id: "", sessionId: "camel-only", cwd: workDir });
		await postHook(relay, { session_id: "snake-both", sessionId: "camel-both", cwd: workDir });
		expect([...relay.ctx.state.exclude.excludedIds.keys()].sort()).toEqual(
			["camel-both", "camel-only", "snake-both"].sort(),
		);
	});

	test("a present but non-string id is unknown: the path rule decides, nothing becomes sticky", async () => {
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await postHook(relay, { session_id: 5, sessionId: { a: 1 }, cwd: workDir });
		expect(relay.ctx.state.exclude.excludedIds.size).toBe(0);
		expect(relay.ctx.state.exclude.drops.path).toBe(1);
		await postHook(relay, { session_id: 5, cwd: otherDir });
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
	});

	test("the gate takes several ids at once: a sticky one among them drops the event and makes the rest sticky", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		R.gateSession(ctx, { sessionId: "first", cwd: workDir });
		const verdict = R.gateSession(ctx, { sessionIds: ["second", "first"], cwd: otherDir });
		expect(verdict).toMatchObject({ send: false, reason: "sticky" });
		expect([...ctx.state.exclude.excludedIds.keys()].sort()).toEqual(["first", "second"]);
	});
});

describe("rule directories are re-resolved on the periodic tick", () => {
	test("a rule naming a directory that is created later as a symlink starts matching without a restart", async () => {
		const R = await mod();
		const later = join(root, "later");
		writeRules([later]);
		const ctx = await newCtx();
		// the rule names a path that does not exist yet
		expect(R.gateSession(ctx, { sessionId: "pre", cwd: workDir })).toEqual({ send: true });
		symlinkSync(workDir, later);
		await R.excludeTick(ctx);
		expect(R.gateSession(ctx, { sessionId: "post", cwd: workDir })).toMatchObject({
			send: false,
			reason: "path",
		});
		expect(R.gateSession(ctx, { sessionId: "via-link", cwd: later })).toMatchObject({
			send: false,
			reason: "path",
		});
		expect(R.gateSession(ctx, { sessionId: "other", cwd: otherDir })).toEqual({ send: true });
	});

	test("a symlink in a rule that is retargeted follows the new target, and stops covering the old one", async () => {
		const R = await mod();
		const link = join(root, "movable");
		symlinkSync(otherDir, link);
		writeRules([link]);
		const ctx = await newCtx();
		expect(R.gateSession(ctx, { sessionId: "old", cwd: otherDir })).toMatchObject({
			reason: "path",
		});
		rmSync(link);
		symlinkSync(workDir, link);
		await R.excludeTick(ctx);
		expect(R.gateSession(ctx, { sessionId: "new", cwd: workDir })).toMatchObject({
			send: false,
			reason: "path",
		});
		expect(R.gateSession(ctx, { sessionId: "old-again", cwd: otherDir })).toEqual({ send: true });
	});

	test("the tick does not read the rules file again when only a symlink moved", async () => {
		const R = await mod();
		const link = join(root, "movable");
		symlinkSync(otherDir, link);
		writeRules([link]);
		const ctx = await newCtx();
		R.gateSession(ctx, { sessionId: "x", cwd: workDir });
		const loads = ctx.state.exclude.loads;
		rmSync(link);
		symlinkSync(workDir, link);
		await R.excludeTick(ctx);
		expect(ctx.state.exclude.loads).toBe(loads);
	});

	test("the tick over invalid or absent rules does nothing and does not throw", async () => {
		const R = await mod();
		const ctx = await newCtx();
		await R.excludeTick(ctx);
		writeRules(["relative/dir"]);
		await R.excludeTick(ctx);
		expect(ctx.state.exclude.rules.state).toBe("invalid");
	});
});

describe("a session that becomes excluded is forgotten by the local session map", () => {
	const mapFile = () => join(stateDir, "local-sessions.json");

	test("its cwd leaves the map in memory and on disk, so a lost sticky file cannot make cwd-less traffic fall back to it", async () => {
		const R = await mod();
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		// included at first: the relay records its directory
		await postHook(relay, hook("was-clean", otherDir));
		expect(relay.ctx.state.localSessions.get("was-clean")?.cwd).toBe(otherDir);
		expect(readFileSync(mapFile(), "utf-8")).toContain("was-clean");

		// a rule now covers that directory; the next event makes the session excluded
		writeRules([otherDir]);
		await postHook(relay, hook("was-clean", otherDir, "Stop"));
		expect(relay.ctx.state.exclude.excludedIds.has("was-clean")).toBe(true);
		await relay.ctx.state.localSessionsWrite;
		expect(relay.ctx.state.localSessions.has("was-clean")).toBe(false);
		expect(readFileSync(mapFile(), "utf-8")).not.toContain("was-clean");

		// the sticky set is lost: the old included cwd must not come back from the map
		relay.ctx.state.exclude.excludedIds.clear();
		writeRules([workDir]);
		expect(R.gateSession(relay.ctx, { sessionId: "was-clean" })).toMatchObject({
			send: false,
			reason: "no_cwd",
		});
	});

	test("a session excluded by the skip header is forgotten the same way", async () => {
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("skipped-later", otherDir));
		await postHook(relay, hook("skipped-later", otherDir, "Stop"), { skip: "1" });
		await relay.ctx.state.localSessionsWrite;
		expect(relay.ctx.state.localSessions.has("skipped-later")).toBe(false);
		expect(readFileSync(mapFile(), "utf-8")).not.toContain("skipped-later");
	});
});

describe("the sticky set: an unreadable file is not an empty one, and a failed save is not silent", () => {
	const stickyFile = () => join(stateDir, "excluded-sessions.json");
	const statusText = () => {
		try {
			return readFileSync(join(stateDir, "status"), "utf-8");
		} catch {
			return "";
		}
	};

	test("a sticky file that exists but does not parse: traffic without a directory is dropped, a warning is in the status file, the file is left alone", async () => {
		writeFileSync(stickyFile(), "{ this is not json");
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await R.writeStatusFile(relay.ctx);
		expect(statusText()).toContain("excluded-session list");

		await postHook(
			relay,
			{ session_id: "no-cwd", status: "working" },
			{ path: "/api/v1/hooks/status" },
		);
		const lookup = await fetch(`http://127.0.0.1:${relay.port}/api/v1/sessions/no-cwd`);
		expect(lookup.status).toBe(404);
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);

		// events that carry a directory are still judged by the rules
		await postHook(relay, hook("with-cwd", otherDir));
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);

		// a new exclusion does not overwrite the unreadable file (the evidence stays for the user)
		await postHook(relay, hook("skip-me", otherDir), { skip: "1" });
		await relay.ctx.state.exclude.write;
		expect(readFileSync(stickyFile(), "utf-8")).toBe("{ this is not json");
	});

	test("a sticky path that cannot be read (a directory) is treated the same way", async () => {
		mkdirSync(stickyFile());
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await postHook(
			relay,
			{ session_id: "no-cwd", status: "working" },
			{ path: "/api/v1/hooks/status" },
		);
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		await R.writeStatusFile(relay.ctx);
		expect(statusText()).toContain("excluded-session list");
	});

	test("no sticky file at all, and a valid one, are not unknown (the controls)", async () => {
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		await postHook(
			relay,
			{ session_id: "no-cwd", status: "working" },
			{ path: "/api/v1/hooks/status" },
		);
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
		expect(statusText()).not.toContain("excluded-session list");
	});

	test("entries the relay does not recognise (another version's, or typed by hand) are kept as they were when the list is saved, and never match anything", async () => {
		const odd = ["has space", "x".repeat(300), 5, null, { a: 1 }, ["nested"], "../../etc"];
		writeFileSync(stickyFile(), `${JSON.stringify({ version: 1, ids: ["known-1", ...odd] })}\n`);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		expect(R.gateSession(relay.ctx, { sessionId: "known-1", cwd: otherDir })).toMatchObject({
			send: false,
			reason: "sticky",
		});
		expect(R.gateSession(relay.ctx, { sessionId: "has space", cwd: otherDir })).toEqual({
			send: true,
		});

		await postHook(relay, hook("newly-excluded", otherDir), { skip: "1" });
		await relay.ctx.state.exclude.write;
		const saved = JSON.parse(readFileSync(stickyFile(), "utf-8")) as { ids: unknown[] };
		expect(saved.ids).toContain("known-1");
		expect(saved.ids).toContain("newly-excluded");
		for (const entry of odd) expect(saved.ids).toContainEqual(entry);
		expect(saved.ids).toHaveLength(2 + odd.length);
	});

	test("what is kept verbatim is bounded like the rest of the list", async () => {
		const many = Array.from({ length: 10 }, (_, i) => `has space ${i}`);
		writeFileSync(stickyFile(), `${JSON.stringify({ version: 1, ids: many })}\n`);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy, limits: { maxExcludedIds: 3 } });
		await postHook(relay, hook("one-more", otherDir), { skip: "1" });
		await relay.ctx.state.exclude.write;
		const saved = JSON.parse(readFileSync(stickyFile(), "utf-8")) as { ids: unknown[] };
		expect(saved.ids).toContain("one-more");
		expect(saved.ids.length).toBeLessThanOrEqual(1 + 3);
		expect(saved.ids.filter((id) => many.includes(id as string)).length).toBeGreaterThan(0);
	});

	test("a failure to save the sticky set is in the status file, and clears when a later save works", async () => {
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const R = await mod();
		// the save target can't be replaced: a directory with something in it
		mkdirSync(stickyFile());
		writeFileSync(join(stickyFile(), "keep"), "x");
		await postHook(relay, hook("s1", otherDir), { skip: "1" });
		await relay.ctx.state.exclude.write;
		await R.writeStatusFile(relay.ctx);
		expect(statusText()).toContain("couldn't save the excluded-session list");
		expect(readdirSync(stateDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

		rmSync(stickyFile(), { recursive: true });
		await postHook(relay, hook("s2", otherDir), { skip: "1" });
		await relay.ctx.state.exclude.write;
		await R.writeStatusFile(relay.ctx);
		expect(statusText()).not.toContain("couldn't save the excluded-session list");
	});
});

describe("the local session map is persisted and trimmed by last-seen", () => {
	test("a session that stays active (same directory) is refreshed on disk, so a restart with a smaller cap evicts the idle one, not it", async () => {
		const R = await mod();
		let clock = Date.parse("2026-01-01T00:00:00Z");
		const mk = (maxLocalSessions: number) =>
			R.createRelayContext(
				{
					remoteUrl: "http://upstream.invalid",
					apiKey: KEY,
					port: PORT,
					codexNamePolicy: "codex",
					stateDir,
					configPath: null,
				},
				{
					env: { HOME: home },
					scriptPath: RELAY_PATH,
					log: () => {},
					now: () => clock,
					limits: { maxLocalSessions },
				} as never,
			);
		const ctx = mk(10);
		await R.recordLocalSession(ctx, "active", otherDir, "claude_code");
		clock += 60_000;
		await R.recordLocalSession(ctx, "idle-1", otherDir, "claude_code");
		clock += 3_600_000;
		await R.recordLocalSession(ctx, "active", otherDir, "claude_code");
		await ctx.state.localSessionsWrite;

		const restarted = mk(1);
		await R.loadLocalSessions(restarted);
		expect([...restarted.state.localSessions.keys()]).toEqual(["active"]);
	});
});

describe("the local check endpoint answers yes or no, never the rule", () => {
	test("the answer carries only excluded, the reason code and the rules state: no rule text, no line number", async () => {
		const secretDir = join(root, "work", "very-private-client-name");
		mkdirSync(secretDir, { recursive: true });
		writeRules(["# my notes", secretDir]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const base = `http://127.0.0.1:${relay.port}/api/v1/relay/exclude-check`;
		for (const cwd of [secretDir, join(secretDir, "sub"), otherDir]) {
			const text = await (await fetch(`${base}?cwd=${encodeURIComponent(cwd)}`)).text();
			const body = JSON.parse(text) as Record<string, unknown>;
			expect(Object.keys(body).sort(), cwd).toEqual(["excluded", "reason", "rulesState"]);
			expect(text).not.toContain("very-private-client-name");
			expect(text).not.toContain(root);
		}
		const hit = (await (await fetch(`${base}?cwd=${encodeURIComponent(secretDir)}`)).json()) as {
			excluded: boolean;
			reason: string;
		};
		expect(hit).toMatchObject({ excluded: true, reason: "path" });
	});
});

describe("a very long directory is no directory, and an odd session id is still remembered", () => {
	const longCwd = (n: number) => `${workDir}/${"x".repeat(n)}`;

	test("a cwd longer than 4 KiB is unknown while rules exist (even one that would match), and never recorded", async () => {
		const R = await mod();
		writeRules([workDir]);
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		const verdict = R.gateSession(relay.ctx, { sessionId: "long", cwd: longCwd(5000) });
		expect(verdict).toMatchObject({ send: false, reason: "no_cwd" });
		await R.recordLocalSession(relay.ctx, "long", longCwd(5000), "claude_code");
		expect(relay.ctx.state.localSessions.has("long")).toBe(false);
		expect(up.calls).toEqual([]);
	});

	test("a multi-megabyte cwd costs the relay next to nothing", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		const huge = `/${"y/".repeat(2_000_000)}`;
		const started = performance.now();
		const verdict = R.gateSession(ctx, { sessionId: "huge", cwd: huge });
		expect(performance.now() - started).toBeLessThan(100);
		expect(verdict).toMatchObject({ send: false, reason: "no_cwd" });
		expect(
			R.evaluateExclusion({ cwd: huge, skip: undefined, rules: ctx.state.exclude.rules }),
		).toEqual({
			excluded: true,
			reason: "no_cwd",
		});
	});

	test("a session id outside the allowed pattern is remembered as excluded by its hash, persisted without the id, and still sticky", async () => {
		const R = await mod();
		writeRules([workDir]);
		const ctx = await newCtx();
		const odd = "weird id/with spaces and ünïcode";
		const huge = "z".repeat(10_000);
		for (const id of [odd, huge]) {
			expect(R.gateSession(ctx, { sessionId: id, cwd: workDir })).toMatchObject({ reason: "path" });
			expect(R.gateSession(ctx, { sessionId: id, cwd: otherDir })).toMatchObject({
				send: false,
				reason: "sticky",
			});
		}
		expect(R.gateSession(ctx, { sessionId: "unrelated", cwd: otherDir })).toEqual({ send: true });
		await ctx.state.exclude.write;
		const saved = readFileSync(ctx.paths.excludedSessionsFile, "utf-8");
		expect(saved).not.toContain("weird id");
		expect(saved).not.toContain("zzzzzzzz");
		const again = await newCtx();
		await R.loadExcludedIds(again);
		expect(R.gateSession(again, { sessionId: odd, cwd: otherDir })).toMatchObject({
			reason: "sticky",
		});
	});
});

describe("the queue cleans up after itself", () => {
	const pendingDir = () => join(stateDir, "hook-queue", "pending");
	const processingDir = () => join(stateDir, "hook-queue", "processing");

	function plantOldTmp(name: string, ageMs = 10 * 60_000) {
		mkdirSync(pendingDir(), { recursive: true });
		const file = join(pendingDir(), name);
		writeFileSync(file, JSON.stringify({ body: "payload that must not linger" }));
		const old = new Date(Date.now() - ageMs);
		utimesSync(file, old, old);
		return file;
	}

	test("an orphaned temp file is removed at startup, and on the periodic work; a fresh one (a write in flight) is left alone", async () => {
		const old = plantOldTmp("1700000000000-aaaa.json.4242.tmp");
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		expect(existsSync(old)).toBe(false);

		const later = plantOldTmp("1700000000001-bbbb.json.4242.tmp");
		const fresh = plantOldTmp("1700000000002-cccc.json.4243.tmp", 0);
		await postHook(relay, hook("tick", otherDir));
		expect(existsSync(later)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	test("an item a crashed run left in processing/ goes back to pending/ at startup and is judged by the current rules", async () => {
		mkdirSync(processingDir(), { recursive: true });
		const item = {
			id: "stuck-1",
			pathname: "/api/v1/hooks",
			search: "",
			method: "POST",
			contentType: "application/json",
			agentType: "claude_code",
			body: JSON.stringify(hook("stuck-session", otherDir)),
			createdAt: new Date().toISOString(),
			attempts: 0,
			nextAttemptAt: new Date().toISOString(),
			lastError: null,
		};
		writeFileSync(join(processingDir(), `${Date.now()}-stuck-1.json`), JSON.stringify(item));
		const { fetchSpy } = upstreamSpy();
		await startRelay({ fetchSpy });
		expect(readdirSync(processingDir())).toEqual([]);
		expect(pendingFiles().length).toBe(1);
	});

	test("an error while releasing an item neither loses it nor leaves it in processing/, and processing the queue does not reject", async () => {
		const R = await mod();
		const logs: string[] = [];
		const { up, fetchSpy } = upstreamSpy(() => new Response("down", { status: 503 }));
		const relay = await startRelay({ fetchSpy, log: (l) => logs.push(l) });
		await postHook(relay, hook("release-fails", otherDir));
		const name = pendingFiles()[0] as string;
		// the temp name the release would write to is already taken, so the write throws
		writeFileSync(join(pendingDir(), `${name}.${process.pid}.tmp`), "taken");
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
		expect(readdirSync(processingDir())).toEqual([]);
		expect(pendingFiles()).toEqual([name]);
		expect(logs.some((l) => l.includes("queue"))).toBe(true);
	});
});

describe("an item the relay cannot handle does not hold up the queue", () => {
	const pendingDir = () => join(stateDir, "hook-queue", "pending");
	const processingDir = () => join(stateDir, "hook-queue", "processing");
	const parkedDir = () => join(stateDir, "hook-queue", "parked");
	const parkedFiles = () => (existsSync(parkedDir()) ? readdirSync(parkedDir()) : []);
	const statusText = () => {
		try {
			return readFileSync(join(stateDir, "status"), "utf-8");
		} catch {
			return "";
		}
	};
	/** How many attempts an item gets before it is set aside (the relay's own number is not part of the contract; this is the most a test ever waits for). */
	const MOST_ATTEMPTS = 12;

	/** A relay whose upstream refuses the hook for `poison-1` (503) and takes everything else. */
	async function poisonedRelay() {
		const bodies: string[] = [];
		const fetchSpy = (async (_input: unknown, init?: RequestInit) => {
			const body = String(init?.body ?? "");
			bodies.push(body);
			return new Response(body.includes("poison-1") ? "down" : "{}", {
				status: body.includes("poison-1") ? 503 : 200,
			});
		}) as unknown as typeof fetch;
		const logs: string[] = [];
		const relay = await startRelay({ fetchSpy, log: (l) => logs.push(l) });
		await postHook(relay, hook("poison-1", otherDir));
		await Bun.sleep(5);
		await postHook(relay, hook("good-1", otherDir));
		// the relay's own clock from here on, so a test can wait out a backoff without waiting
		let clock = Date.now();
		relay.ctx.now = () => clock;
		return {
			relay,
			logs,
			sentFor: (id: string) => bodies.filter((b) => b.includes(id)).length,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	test("one whose handling keeps failing (here: it can never be written back) backs off while the items behind it go out, and after a few attempts it is set aside on disk, never deleted", async () => {
		const R = await mod();
		const p = await poisonedRelay();
		const { relay } = p;
		// from now on every queue write fails, as on a full disk: the 503'd item cannot be released
		relay.ctx.queueWriteHook = () => {
			throw new Error("disk full");
		};

		await R.processHookQueue(relay.ctx);
		expect(p.sentFor("good-1"), "the item behind it went out in the same pass").toBe(1);
		expect(p.sentFor("poison-1")).toBe(1);

		await R.processHookQueue(relay.ctx);
		expect(p.sentFor("poison-1"), "it waits out a backoff instead of being tried at once").toBe(1);

		for (let i = 0; i < MOST_ATTEMPTS && parkedFiles().length === 0; i++) {
			p.advance(10 * 60_000);
			await R.processHookQueue(relay.ctx);
		}
		expect(parkedFiles()).toHaveLength(1);
		expect(readFileSync(join(parkedDir(), parkedFiles()[0] as string), "utf-8")).toContain(
			"poison-1",
		);
		expect(pendingFiles()).toEqual([]);
		expect(readdirSync(processingDir())).toEqual([]);
		const sentWhenParked = p.sentFor("poison-1");
		expect(sentWhenParked).toBeGreaterThan(1);
		expect(sentWhenParked).toBeLessThanOrEqual(MOST_ATTEMPTS);

		p.advance(24 * 3_600_000);
		await R.processHookQueue(relay.ctx);
		expect(p.sentFor("poison-1"), "a parked item is not tried again").toBe(sentWhenParked);
		expect(parkedFiles()).toHaveLength(1);
		expect(p.sentFor("good-1")).toBe(1);

		await R.writeStatusFile(relay.ctx);
		expect(statusText()).toContain("set aside");
		const diagnostics = (await (
			await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`)
		).json()) as { queue: { parked: number; pending: number } };
		expect(diagnostics.queue).toMatchObject({ parked: 1, pending: 0 });
	});

	test("an item is set aside on exactly its fifth failed handling: not on the fourth, not on the sixth", async () => {
		const R = await mod();
		const p = await poisonedRelay();
		p.relay.ctx.queueWriteHook = () => {
			throw new Error("disk full");
		};
		const parkedAfter: [number, number][] = [];
		for (let i = 0; i < 8; i++) {
			await R.processHookQueue(p.relay.ctx);
			parkedAfter.push([p.sentFor("poison-1"), parkedFiles().length]);
			p.advance(10 * 60_000);
		}
		// [attempts made so far, how many are set aside]: set aside right after the fifth attempt, and only then
		for (const [attempts, parked] of parkedAfter) {
			expect(parked, `after ${attempts} attempts`).toBe(attempts >= 5 ? 1 : 0);
		}
		expect(Math.max(...parkedAfter.map(([attempts]) => attempts))).toBe(5);
	});

	test("what is set aside is capped: past the cap the oldest is dropped, and the log names only its file", async () => {
		const R = await mod();
		const bodies: string[] = [];
		const fetchSpy = (async (_input: unknown, init?: RequestInit) => {
			bodies.push(String(init?.body ?? ""));
			return new Response("down", { status: 503 });
		}) as unknown as typeof fetch;
		const logs: string[] = [];
		const relay = await startRelay({
			fetchSpy,
			log: (l) => logs.push(l),
			limits: { maxParkedItems: 3 },
		});
		for (let i = 1; i <= 5; i++) {
			await postHook(relay, hook(`private-session-${i}`, otherDir));
			await Bun.sleep(3);
		}
		const queued = pendingFiles().sort();
		expect(queued).toHaveLength(5);
		let clock = Date.now();
		relay.ctx.now = () => clock;
		relay.ctx.queueWriteHook = () => {
			throw new Error("disk full");
		};
		for (let i = 0; i < 8; i++) {
			await R.processHookQueue(relay.ctx);
			clock += 10 * 60_000;
		}
		expect(parkedFiles().sort()).toEqual(queued.slice(2).sort());
		const dropped = logs.filter((l) => l.includes("dropped") && l.includes("parked"));
		expect(dropped).toHaveLength(2);
		for (const [i, line] of dropped.entries()) {
			expect(line).toContain(queued[i] as string);
			expect(line).not.toContain("private-session");
		}
		await R.writeStatusFile(relay.ctx);
		const diagnostics = (await (
			await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`)
		).json()) as { queue: { parked: number } };
		expect(diagnostics.queue.parked).toBe(3);
	});

	test("the cap is 500 and the lease timeout outlasts a slow forward, by default", async () => {
		const R = await mod();
		const ctx = await newCtx();
		const limits = ctx.limits as unknown as Record<string, number>;
		expect(limits.maxParkedItems).toBe(500);
		expect(limits.leaseTimeoutMs).toBeGreaterThanOrEqual(60_000);
		expect(R).toBeDefined();
	});

	test("what was set aside is still there, still listed and still not retried after a restart, and the queue's age and size limits never touch it", async () => {
		const R = await mod();
		const p = await poisonedRelay();
		p.relay.ctx.queueWriteHook = () => {
			throw new Error("disk full");
		};
		for (let i = 0; i < MOST_ATTEMPTS && parkedFiles().length === 0; i++) {
			await R.processHookQueue(p.relay.ctx);
			p.advance(10 * 60_000);
		}
		expect(parkedFiles()).toHaveLength(1);
		const name = parkedFiles()[0] as string;
		p.relay.stop();
		await Bun.sleep(20);

		const restarted = await startRelay({
			fetchSpy: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
			limits: { maxQueueAgeMs: 1, maxQueueFiles: 0 },
		});
		await postHook(restarted, hook("after-restart", otherDir));
		await R.writeStatusFile(restarted.ctx);
		expect(statusText()).toContain("set aside");
		expect(parkedFiles()).toEqual([name]);
		expect(pendingFiles()).toEqual([]);
	});

	/** The queue item a hook post writes, planted by hand where a lease would have put it. */
	function plantLeased(sessionId: string, name = `${Date.now()}-planted-${sessionId}.json`) {
		mkdirSync(processingDir(), { recursive: true });
		const item = {
			id: `planted-${sessionId}`,
			pathname: "/api/v1/hooks",
			search: "",
			method: "POST",
			contentType: "application/json",
			agentType: "claude_code",
			body: JSON.stringify(hook(sessionId, otherDir)),
			createdAt: new Date().toISOString(),
			attempts: 0,
			nextAttemptAt: new Date().toISOString(),
			lastError: null,
		};
		writeFileSync(join(processingDir(), name), JSON.stringify(item));
		return name;
	}

	test("an item this relay leased and could not hand back is recovered on the next round, not only at restart", async () => {
		const R = await mod();
		let calls = 0;
		const bodies: string[] = [];
		const fetchSpy = (async (_input: unknown, init?: RequestInit) => {
			calls += 1;
			bodies.push(String(init?.body ?? ""));
			if (calls === 1) {
				// while the item is out, the pending directory disappears: it can be neither released nor returned
				rmSync(pendingDir(), { recursive: true, force: true });
				return new Response("down", { status: 503 });
			}
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("stranded-1", otherDir));
		let clock = Date.now();
		relay.ctx.now = () => clock;
		await R.processHookQueue(relay.ctx);
		expect(readdirSync(processingDir()).length, "the item is stranded").toBe(1);

		clock += 10 * 60_000;
		await R.processHookQueue(relay.ctx);
		expect(bodies.filter((b) => b.includes("stranded-1")).length).toBeGreaterThanOrEqual(2);
		expect(readdirSync(processingDir())).toEqual([]);
	});

	test("an item some other relay leased a moment ago is left alone by a round; one whose lease is older than the lease timeout is queued again", async () => {
		const R = await mod();
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy, limits: { leaseTimeoutMs: 60_000 } });
		const name = plantLeased("foreign-1");
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		expect(readdirSync(processingDir())).toEqual([name]);

		let clock = Date.now();
		relay.ctx.now = () => clock;
		clock += 59_000;
		await R.processHookQueue(relay.ctx);
		expect(readdirSync(processingDir()), "not yet: the lease is still within its timeout").toEqual([
			name,
		]);

		clock += 2_000;
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);
		expect(up.calls[0]?.body).toContain("foreign-1");
		expect(readdirSync(processingDir())).toEqual([]);
	});

	test("at startup everything in processing/ is queued again, whoever leased it", async () => {
		plantLeased("startup-1");
		const { up, fetchSpy } = upstreamSpy();
		await startRelay({ fetchSpy, limits: { leaseTimeoutMs: 3_600_000 } });
		expect(readdirSync(processingDir())).toEqual([]);
		expect(pendingFiles().length + up.calls.length).toBe(1);
	});

	test("an item in processing/ for a directory that has since been excluded is dropped when recovered, like any other queued item", async () => {
		const R = await mod();
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		await postHook(relay, hook("stranded-2", workDir));
		const name = pendingFiles()[0] as string;
		renameSync(join(pendingDir(), name), join(processingDir(), name));
		// a lease that is no longer fresh: some other relay's, long gone
		relay.ctx.now = () => Date.now() + 3_600_000;
		writeRules([workDir]);
		await R.processHookQueue(relay.ctx);
		expect(up.calls).toEqual([]);
		expect(readdirSync(processingDir())).toEqual([]);
		expect(pendingFiles()).toEqual([]);
	});
});

describe("rules under the account's home that the relay never reads", () => {
	let account: string;
	beforeEach(() => {
		account = join(root, "account");
		mkdirSync(join(account, ".agentpulse"), { recursive: true });
	});
	const plant = () => writeFileSync(join(account, ".agentpulse", "exclude"), `${workDir}\n`);

	test("the relay logs one warning naming both homes, still sends exactly what it did, and says nothing in its status, diagnostics or health", async () => {
		plant();
		const logs: string[] = [];
		const { up, fetchSpy } = upstreamSpy();
		const relay = await startRelay({
			fetchSpy,
			log: (l) => logs.push(l),
			accountHome: () => account,
		});
		const warnings = logs.filter((l) => l.includes("not being applied"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(account);
		expect(warnings[0]).toContain(home);

		// behaviour is unchanged: the rules under the other home are not applied
		await postHook(relay, hook("not-covered", workDir));
		const R = await mod();
		await R.processHookQueue(relay.ctx);
		expect(up.calls.length).toBe(1);

		await R.writeStatusFile(relay.ctx);
		const surfaces = [
			existsSync(join(stateDir, "status")) ? readFileSync(join(stateDir, "status"), "utf-8") : "",
			await (await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`)).text(),
			await (await fetch(`http://127.0.0.1:${relay.port}/api/v1/health`)).text(),
		];
		for (const text of surfaces) {
			expect(text).not.toContain(account);
			expect(text).not.toContain("not being applied");
		}
	});

	test("no warning when the account has no rules file, when it is the same home, or when the system has no home to offer", async () => {
		for (const accountHome of [() => account, () => home, () => undefined]) {
			const logs: string[] = [];
			const relay = await startRelay({ log: (l) => logs.push(l), accountHome });
			expect(logs.filter((l) => l.includes("not being applied"))).toEqual([]);
			relay.stop();
		}
	});
});

describe("the home directory, and what the invalid-rules status says", () => {
	const statusText = (ctx: { paths: { statusFile: string } }) =>
		readFileSync(ctx.paths.statusFile, "utf-8").trim();

	function ctxWith(env: { HOME?: string }, homedir: () => string) {
		return mod().then((R) =>
			R.createRelayContext(
				{
					remoteUrl: "http://upstream.invalid",
					apiKey: KEY,
					port: PORT,
					codexNamePolicy: "codex",
					stateDir,
					configPath: null,
				},
				{ env, homedir, scriptPath: RELAY_PATH, log: () => {} } as never,
			),
		);
	}

	test("with HOME unset or empty the relay falls back to the account's home directory, so a user with no rules is not silenced", async () => {
		const R = await mod();
		for (const env of [{}, { HOME: "" }]) {
			const ctx = await ctxWith(env, () => home);
			expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir }), JSON.stringify(env)).toEqual({
				send: true,
			});
		}
		writeRules([workDir]);
		const ctx = await ctxWith({}, () => home);
		expect(R.gateSession(ctx, { sessionId: "a", cwd: workDir })).toMatchObject({ reason: "path" });
		expect(R.gateSession(ctx, { sessionId: "b", cwd: otherDir })).toEqual({ send: true });
	});

	test("only when no home directory can be found at all does it fail closed, and the status line says why", async () => {
		const R = await mod();
		const ctx = await ctxWith({}, () => "");
		expect(R.gateSession(ctx, { sessionId: "s", cwd: otherDir })).toMatchObject({
			send: false,
			reason: "rules_invalid",
		});
		await R.writeStatusFile(ctx);
		expect(statusText(ctx)).toContain("HOME is not set");
		expect(statusText(ctx)).toContain("agentpulse exclude check");
	});

	test("status writes happen one after the other: a later write never starts while an earlier one is still being written, so the last state computed is the last file in place", async () => {
		const R = await mod();
		const ctx = await ctxWith({}, () => home);
		const events: string[] = [];
		let releaseFirst: () => void = () => {};
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let writes = 0;
		ctx.statusWriteHook = (stage) => {
			if (stage === "opened") {
				writes += 1;
				events.push(`opened-${writes}`);
				return writes === 1 ? firstHeld : undefined;
			}
			events.push(`written-${writes}`);
			return undefined;
		};
		ctx.state.auth.keyRejected = true;
		const first = R.writeStatusFile(ctx);
		await Bun.sleep(20);
		// the state moves on while the first write is still open, and a second write is asked for
		ctx.state.auth.keyRejected = false;
		ctx.state.auth.checkedAt = new Date().toISOString();
		ctx.state.auth.missing = ["observe"];
		const second = R.writeStatusFile(ctx);
		await Bun.sleep(20);
		expect(events, "the second write has not started while the first is open").toEqual([
			"opened-1",
		]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(events).toEqual(["opened-1", "written-1", "opened-2", "written-2"]);
		expect(statusText(ctx)).toBe("key lacks observe — re-run setup-relay");
	});

	test("the status file is never empty or partial at any point of a write, and a write replaces the file instead of rewriting it in place (deterministic: the write calls back at each stage)", async () => {
		const R = await mod();
		const ctx = await ctxWith({}, () => home);
		const readNow = () => {
			try {
				return readFileSync(ctx.paths.statusFile, "utf-8");
			} catch (err) {
				if ((err as { code?: string }).code === "ENOENT") return null;
				throw err;
			}
		};
		type Seen = { stage: string; writing: string; visible: string | null };
		const seen: Seen[] = [];
		ctx.statusWriteHook = (stage, writing) => {
			seen.push({ stage, writing, visible: readNow() });
		};

		ctx.state.auth.keyRejected = true;
		await R.writeStatusFile(ctx);
		const first = readNow();
		expect(first).toBe("key rejected — re-run setup-relay\n");

		ctx.state.auth.keyRejected = false;
		ctx.state.auth.checkedAt = new Date().toISOString();
		ctx.state.auth.missing = ["observe"];
		seen.length = 0;
		await R.writeStatusFile(ctx);
		const second = readNow();
		expect(second).toBe("key lacks observe — re-run setup-relay\n");

		expect(seen.map((s) => s.stage)).toEqual(["opened", "written"]);
		for (const s of seen) {
			expect([first, second], `${s.stage}: what a reader sees is a whole line`).toContain(
				s.visible,
			);
			expect(
				s.writing,
				`${s.stage}: the content goes to a file of its own, not into the status file`,
			).not.toBe(ctx.paths.statusFile);
		}
		expect(seen.map((s) => s.visible)).toEqual([first, first]);
		expect(readdirSync(dirname(ctx.paths.statusFile)).filter((n) => n.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	test("the invalid-rules line carries the reason and the next step; the health warning carries the next step but never the rule's text", async () => {
		const R = await mod();
		writeRules(["relative/very-private-client"]);
		const { fetchSpy } = upstreamSpy();
		const relay = await startRelay({ fetchSpy });
		R.gateSession(relay.ctx, { sessionId: "s", cwd: otherDir });
		await R.writeStatusFile(relay.ctx);
		const line = statusText(relay.ctx);
		expect(line).toContain("use an absolute path");
		expect(line).toContain("sending no session data");
		expect(line).toContain("run: agentpulse exclude check");
		expect(line).not.toContain("sending nothing");

		const healthText = await (await fetch(`http://127.0.0.1:${relay.port}/api/v1/health`)).text();
		expect(healthText).toContain("run: agentpulse exclude check");
		expect(healthText).toContain("sending no session data");
		expect(healthText).not.toContain("very-private-client");
	});
});
