/**
 * Phase 3 (D17, bob L1): statusline.sh pushes a native name only when it
 * differs from the cached last push, confines its cache to cache/, never
 * sends an unsafe session id over the wire, and appends the relay status hint
 * without breaking the one-line statusline protocol.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "statusline.sh");

type Recorded = { method: string; path: string; search: string; body: string };

let tmp: string;
let requests: Recorded[];
let serverDisplayName: string;
let nativeNameStatus: number;
/** What the stub's health endpoint says about being a relay; null makes it answer 404 (no relay). */
let healthRelay: boolean | null;
/** Whether the stub's health answer carries the field that says the relay enforces exclude rules (an older relay has none). */
let healthEnforces: boolean | undefined;
/** What the stub's session lookup answers: normally, with the relay's local 404 {error:"excluded"} or {error:"unknown_session"}, or with a plain 404. */
let sessionLookup: "ok" | "excluded" | "unknown" | "missing" | "full" | "error" | "slow";
let server: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-statusline-test-"));
	requests = [];
	serverDisplayName = "brave-falcon";
	nativeNameStatus = 200;
	healthRelay = null;
	healthEnforces = undefined;
	sessionLookup = "ok";
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? "" : await req.text();
			requests.push({ method: req.method, path: url.pathname, search: url.search, body });
			if (req.method === "GET" && url.pathname === "/api/v1/health") {
				return healthRelay === null
					? new Response("not found", { status: 404 })
					: Response.json({
							status: "ok",
							relay: healthRelay,
							...(healthEnforces === undefined ? {} : { enforcesExcludeRules: healthEnforces }),
						});
			}
			if (req.method === "GET" && url.pathname.startsWith("/api/v1/sessions/")) {
				if (sessionLookup === "excluded")
					return Response.json({ error: "excluded" }, { status: 404 });
				if (sessionLookup === "missing")
					return Response.json({ error: "not found" }, { status: 404 });
				if (sessionLookup === "unknown")
					return Response.json({ error: "unknown_session" }, { status: 404 });
				if (sessionLookup === "error") return Response.json({ error: "down" }, { status: 502 });
				if (sessionLookup === "slow") {
					await new Promise((resolve) => setTimeout(resolve, 1600));
					return Response.json({ session: { displayName: serverDisplayName } });
				}
				// a server that predates the name-only read: the whole detail, whatever the query
				if (sessionLookup === "full") {
					return Response.json({
						session: { sessionId: "x", displayName: serverDisplayName, agentType: "claude_code" },
						events: [{ id: 1, eventType: "PostToolUse" }],
						controlActions: [],
					});
				}
				return Response.json({ session: { displayName: serverDisplayName } });
			}
			if (req.method === "PUT" && url.pathname.endsWith("/native-name")) {
				return Response.json({ ok: nativeNameStatus === 200 }, { status: nativeNameStatus });
			}
			return new Response("not found", { status: 404 });
		},
	});
});

afterEach(async () => {
	server.stop(true);
	await rm(tmp, { recursive: true, force: true });
});

const agentpulseDir = () => join(tmp, "agentpulse");

async function run(input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
	const proc = Bun.spawn(["bash", SCRIPT], {
		stdin: new TextEncoder().encode(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: tmp,
			AGENTPULSE_PORT: String(server.port),
			AGENTPULSE_DIR: agentpulseDir(),
			...extraEnv,
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, code: proc.exitCode };
}

const puts = () => requests.filter((r) => r.method === "PUT");

type SettingsOptions = {
	/** The directory holding the `.claude` folder: the home (user settings) unless a project directory is given. */
	dir?: string;
	file?: "settings.json" | "settings.local.json";
	/** Whether a relay hook carries the skip header the installer writes (default: yes). */
	skipHeader?: boolean;
	/** Extra top-level text a settings file may hold (for the key-helper guard). */
	extra?: Record<string, unknown>;
};

/** What a Claude Code settings file says about where the hooks go: the local relay (no key header), a server directly (a key header), or nothing of ours. */
async function writeClaudeSettings(
	kind: "relay" | "direct" | "none",
	port = server.port,
	options: SettingsOptions = {},
) {
	const dir = options.dir ?? tmp;
	await mkdir(join(dir, ".claude"), { recursive: true });
	const relayHook = {
		type: "http",
		url: `http://localhost:${port}/api/v1/hooks`,
		...(options.skipHeader === false
			? {}
			: {
					allowedEnvVars: ["AGENTPULSE_SKIP"],
					headers: { "X-Agent-Type": "claude_code", "X-AgentPulse-Skip": "$AGENTPULSE_SKIP" },
				}),
	};
	const hook =
		kind === "relay"
			? relayHook
			: kind === "direct"
				? {
						type: "http",
						url: "https://agentpulse.example.test/api/v1/hooks",
						headers: { Authorization: "Bearer $AGENTPULSE_API_KEY" },
					}
				: { type: "http", url: "https://unrelated.example.test/other" };
	await writeFile(
		join(dir, ".claude", options.file ?? "settings.json"),
		JSON.stringify({
			...options.extra,
			hooks: { SessionStart: [{ matcher: "", hooks: [hook] }] },
		}),
	);
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out");
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes from captured terminal output
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function listRecursive(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { recursive: true })) as string[];
	} catch {
		return [];
	}
}

describe("statusline.sh", () => {
	test("carries the agentpulse-statusline marker", async () => {
		expect(await readFile(SCRIPT, "utf-8")).toContain("# agentpulse-statusline");
	});

	test("same name twice → one PUT; a different name → a second PUT", async () => {
		const input = {
			session_id: "abc-123_X",
			session_name: "my-thread",
			model: { display_name: "M" },
		};
		await run(input);
		const cacheFile = join(agentpulseDir(), "cache", "native-name-abc-123_X");
		await waitFor(() => puts().length === 1);
		await waitFor(() => Bun.file(cacheFile).exists());
		expect(await readFile(cacheFile, "utf-8")).toBe("my-thread");

		await run(input);
		await Bun.sleep(400);
		expect(puts()).toHaveLength(1);

		await run({ ...input, session_name: "renamed-thread" });
		await waitFor(() => puts().length === 2);
		expect(JSON.parse(puts()[1].body)).toEqual({ name: "renamed-thread" });
		expect(puts()[1].path).toBe("/api/v1/sessions/abc-123_X/native-name");
	});

	test("a failed push is not cached, so the next render retries", async () => {
		server.stop(true);
		const input = { session_id: "retry-1", session_name: "n1" };
		await run(input);
		await Bun.sleep(300);
		expect(await Bun.file(join(agentpulseDir(), "cache", "native-name-retry-1")).exists()).toBe(
			false,
		);
	});

	test("a session_id containing ../ never escapes cache/ and is never sent to the relay", async () => {
		const { stdout, code } = await run({ session_id: "../../escape", session_name: "evil" });
		expect(code).toBe(0);
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
		await Bun.sleep(400);
		expect(requests).toEqual([]);
		for (const rel of await listRecursive(tmp)) {
			if (rel.includes("escape")) expect(rel.startsWith(join("agentpulse", "cache"))).toBe(true);
		}
		expect(await Bun.file(join(tmp, "escape")).exists()).toBe(false);
		expect(await Bun.file(join(agentpulseDir(), "escape")).exists()).toBe(false);
	});

	test("status file present → the single stdout line ends with the hint", async () => {
		await mkdir(agentpulseDir(), { recursive: true });
		await writeFile(join(agentpulseDir(), "status"), "key lacks observe — re-run setup-relay\n");
		const { stdout, code } = await run({ session_id: "s-1", model: { display_name: "M" } });
		expect(code).toBe(0);
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(
			stripAnsi(lines[0]).endsWith(" · agentpulse: key lacks observe — re-run setup-relay"),
		).toBe(true);
	});

	test("control characters in the status file cannot inject a second line", async () => {
		await mkdir(agentpulseDir(), { recursive: true });
		await writeFile(join(agentpulseDir(), "status"), "first\rline\u001b[2J\nsecond line\n");
		const { stdout } = await run({ session_id: "s-2" });
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\r");
		expect(lines[0]).not.toContain("second line");
	});

	test("no status file → no hint", async () => {
		const { stdout } = await run({ session_id: "s-3", model: { display_name: "M" } });
		expect(stdout).not.toContain("agentpulse:");
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
	});
});

describe("statusline.sh — fix round (F110, F116)", () => {
	test("a server displayName with control characters can't break the line (F110)", async () => {
		serverDisplayName = "name\r\u001b[2Jfake\nsecond";
		const { stdout } = await run({ session_id: "s-ctl", model: { display_name: "M" } });
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\r");
		expect(lines[0]).not.toContain("\u001b[2J");
		expect(stripAnsi(lines[0])).toContain("name[2Jfakesecond");
	});

	for (const status of [429, 404]) {
		test(`a ${status} is not cached, so the next render PUTs again (F116)`, async () => {
			nativeNameStatus = status;
			const input = { session_id: `s-${status}`, session_name: "n1" };
			await run(input);
			await waitFor(() => puts().length === 1);
			await Bun.sleep(300);
			expect(
				await Bun.file(join(agentpulseDir(), "cache", `native-name-s-${status}`)).exists(),
			).toBe(false);
			await run(input);
			await waitFor(() => puts().length === 2);
		});
	}

	test("a 400 is cached as final, so the next render doesn't PUT (F116)", async () => {
		nativeNameStatus = 400;
		const input = { session_id: "s-400", session_name: "n1" };
		await run(input);
		const cacheFile = join(agentpulseDir(), "cache", "native-name-s-400");
		await waitFor(() => Bun.file(cacheFile).exists());
		await run(input);
		await Bun.sleep(400);
		expect(puts()).toHaveLength(1);
	});
});

describe("statusline.sh — exclude rules", () => {
	const markerPath = () => join(agentpulseDir(), "exclude.invalid");
	const INVALID_RELAY = "AgentPulse: paused, exclude rules invalid (run: agentpulse exclude check)";
	const INVALID_DIRECT =
		"AgentPulse: exclude rules invalid; Claude Code is still reporting (direct mode)";
	const SKIPPED = "AgentPulse: not reported (AGENTPULSE_SKIP)";
	const input = { session_id: "ex-1", session_name: "thread", model: { display_name: "M" } };

	async function plantMarker() {
		await mkdir(agentpulseDir(), { recursive: true });
		await writeFile(markerPath(), "");
	}

	function expectNoOverclaim(text: string) {
		expect(text).not.toContain("this machine has stopped");
		expect(text).not.toContain("nothing is being sent from this machine");
	}

	test("marker present and localhost answers health with relay:true -> the paused line", async () => {
		await plantMarker();
		healthRelay = true;
		const { stdout, code } = await run(input);
		expect(code).toBe(0);
		const lines = stdout.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toContain(INVALID_RELAY);
		expectNoOverclaim(stdout);
	});

	test("marker present and no relay answering -> the direct-mode line", async () => {
		await plantMarker();
		for (const relay of [null, false] as const) {
			healthRelay = relay;
			const { stdout } = await run(input);
			expect(stripAnsi(stdout)).toContain(INVALID_DIRECT);
			expect(stripAnsi(stdout)).not.toContain("paused");
			expectNoOverclaim(stdout);
		}
	});

	test("the marker line wins over the relay's own status hint", async () => {
		await plantMarker();
		await writeFile(join(agentpulseDir(), "status"), "key lacks observe — re-run setup-relay\n");
		healthRelay = true;
		const { stdout } = await run(input);
		const text = stripAnsi(stdout);
		expect(text).toContain(INVALID_RELAY);
		expect(text).not.toContain("key lacks observe");
	});

	const SKIPPED_DIRECT =
		"AgentPulse: skip requested; in direct mode the server discards it on arrival";

	test("an allowlisted AGENTPULSE_SKIP with an enforcing relay that this session's hooks point at: the not-reported line, and the only call is the health probe (no name lookup, no name push)", async () => {
		healthRelay = true;
		healthEnforces = true;
		await writeClaudeSettings("relay");
		for (const value of ["1", "true", " TRUE\t", "Yes\r", "\ton\n"]) {
			requests.length = 0;
			const { stdout, code } = await run(input, { AGENTPULSE_SKIP: value });
			expect(code).toBe(0);
			expect(stripAnsi(stdout)).toContain(SKIPPED);
			expect(stripAnsi(stdout)).not.toContain(SKIPPED_DIRECT);
			expectNoOverclaim(stdout);
			await Bun.sleep(150);
			expect(
				requests.map((r) => `${r.method} ${r.path}`),
				JSON.stringify(value),
			).toEqual(["GET /api/v1/health"]);
		}
	});

	test("an allowlisted AGENTPULSE_SKIP and an old relay (health without the enforcement field): nothing claims the session is not reported", async () => {
		healthRelay = true;
		await writeClaudeSettings("relay");
		requests.length = 0;
		const { stdout, code } = await run(input, { AGENTPULSE_SKIP: "1" });
		expect(code).toBe(0);
		expect(stripAnsi(stdout)).not.toContain("not reported");
		expect(stripAnsi(stdout)).not.toContain("AgentPulse:");
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
	});

	test("an allowlisted AGENTPULSE_SKIP and an enforcing relay, but this session's hooks go straight to a server: the direct-mode line, not 'not reported'", async () => {
		healthRelay = true;
		healthEnforces = true;
		for (const kind of ["direct", "none"] as const) {
			await writeClaudeSettings(kind);
			const { stdout } = await run(input, { AGENTPULSE_SKIP: "1" });
			expect(stripAnsi(stdout), kind).not.toContain("not reported");
			if (kind === "direct") expect(stripAnsi(stdout)).toContain(SKIPPED_DIRECT);
		}
	});

	test("hooks aimed at a relay on another port are not this relay: no 'not reported'", async () => {
		healthRelay = true;
		healthEnforces = true;
		await writeClaudeSettings("relay", (server.port ?? 0) + 1);
		const { stdout } = await run(input, { AGENTPULSE_SKIP: "1" });
		expect(stripAnsi(stdout)).not.toContain("not reported");
	});

	test("an allowlisted AGENTPULSE_SKIP with no relay answering (direct mode): the line says the server discards it on arrival, same single probe", async () => {
		for (const relay of [null, false] as const) {
			healthRelay = relay;
			requests.length = 0;
			const { stdout, code } = await run(input, { AGENTPULSE_SKIP: "1" });
			expect(code).toBe(0);
			expect(stripAnsi(stdout)).toContain(SKIPPED_DIRECT);
			expect(stripAnsi(stdout)).not.toContain(SKIPPED);
			expectNoOverclaim(stdout);
			await Bun.sleep(150);
			expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/health"]);
		}
	});

	test("an unreachable health endpoint also reads as direct mode, and the output is still one line", async () => {
		server.stop(true);
		const { stdout } = await run(input, { AGENTPULSE_SKIP: "1" });
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
		expect(stripAnsi(stdout)).toContain(SKIPPED_DIRECT);
	});

	test("a value that is not on the allowlist changes nothing", async () => {
		for (const value of ["0", "no", "1\f", "\u00a01"]) {
			requests.length = 0;
			const { stdout } = await run(input, { AGENTPULSE_SKIP: value });
			expect(stripAnsi(stdout)).not.toContain("AgentPulse:");
			expect(stripAnsi(stdout)).toContain("brave-falcon");
		}
	});

	test("marker and skip together: the marker line wins, and the only call is the health probe", async () => {
		await plantMarker();
		healthRelay = true;
		const { stdout } = await run(input, { AGENTPULSE_SKIP: "1" });
		expect(stripAnsi(stdout)).toContain(INVALID_RELAY);
		expect(stripAnsi(stdout)).not.toContain(SKIPPED);
		await Bun.sleep(150);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/health"]);
	});

	test("neither marker nor skip: no exclude wording and no health probe", async () => {
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).not.toContain("exclude");
		expect(requests.some((r) => r.path === "/api/v1/health")).toBe(false);
	});

	test("the output stays one line whatever the state", async () => {
		await plantMarker();
		healthRelay = true;
		const { stdout } = await run(input, { AGENTPULSE_SKIP: "1" });
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
	});
});

describe("statusline.sh — a session the relay refuses to look up", () => {
	const EXCLUDED = "AgentPulse: not reported (excluded)";
	const input = { session_id: "ex-2", session_name: "thread", model: { display_name: "M" } };

	test('a relay 404 {error:"excluded"} from an enforcing relay this session\'s hooks point at: the not-reported line, no name, and no native-name push', async () => {
		sessionLookup = "excluded";
		healthRelay = true;
		healthEnforces = true;
		await writeClaudeSettings("relay");
		const { stdout, code } = await run(input);
		expect(code).toBe(0);
		const lines = stdout.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toContain(EXCLUDED);
		expect(stripAnsi(lines[0] ?? "")).toContain("ex-2");
		await Bun.sleep(200);
		expect(puts()).toEqual([]);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/v1/sessions/ex-2",
			"GET /api/v1/health",
		]);
	});

	test('a relay 404 {error:"unknown_session"}: nothing about "not reported", and the native name is still offered', async () => {
		sessionLookup = "unknown";
		healthRelay = true;
		healthEnforces = true;
		await writeClaudeSettings("relay");
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).not.toContain("not reported");
		expect(stripAnsi(stdout)).not.toContain("AgentPulse:");
		await waitFor(() => puts().length === 1);
	});

	test('"excluded" from a relay that does not advertise enforcement (an old relay): no claim', async () => {
		sessionLookup = "excluded";
		healthRelay = true;
		await writeClaudeSettings("relay");
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).not.toContain("not reported");
	});

	test('"excluded" while this session\'s hooks go straight to a server (direct-mode Claude next to a relay): no claim', async () => {
		sessionLookup = "excluded";
		healthRelay = true;
		healthEnforces = true;
		for (const kind of ["direct", "none"] as const) {
			await writeClaudeSettings(kind);
			const { stdout } = await run(input);
			expect(stripAnsi(stdout), kind).not.toContain("not reported");
		}
	});

	test("a plain 404 is not 'excluded': no such line, and the native name is still pushed (nothing about the old behaviour changed)", async () => {
		sessionLookup = "missing";
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).not.toContain("not reported");
		await waitFor(() => puts().length === 1);
		expect(JSON.parse(puts()[0]?.body ?? "{}")).toEqual({ name: "thread" });
	});

	test("a 404 whose body only mentions the word, not the error code, is not 'excluded'", async () => {
		server.stop(true);
		server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ error: "not found", detail: "excluded" }, { status: 404 }),
		});
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).not.toContain("not reported");
	});

	test("only a 404 carries the verdict: the same body under any other status is not 'excluded'", async () => {
		for (const status of [200, 403, 500]) {
			server.stop(true);
			server = Bun.serve({
				port: 0,
				fetch: () => Response.json({ error: "excluded" }, { status }),
			});
			const { stdout } = await run(input);
			expect(stripAnsi(stdout), `status ${status}`).not.toContain("not reported");
		}
	});

	test("the name comes only from a 200: the same body under any other status is not used", async () => {
		for (const status of [201, 204, 301, 403, 404, 429, 500, 502]) {
			server.stop(true);
			server = Bun.serve({
				port: 0,
				fetch: () => Response.json({ session: { displayName: "leaky-name" } }, { status }),
			});
			const { stdout } = await run(input);
			expect(stripAnsi(stdout), `status ${status}`).not.toContain("leaky-name");
		}
	});

	test("a 200 with a name is untouched (the control)", async () => {
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).toContain("brave-falcon");
		expect(stripAnsi(stdout)).not.toContain("not reported");
	});

	test("the exclude-rules-invalid marker still wins over the excluded line", async () => {
		sessionLookup = "excluded";
		healthRelay = true;
		await mkdir(agentpulseDir(), { recursive: true });
		await writeFile(join(agentpulseDir(), "exclude.invalid"), "");
		const { stdout } = await run(input);
		expect(stripAnsi(stdout)).toContain("exclude rules invalid");
		expect(stripAnsi(stdout)).not.toContain("not reported (excluded)");
	});
});

describe("statusline.sh — which hooks count as this session's", () => {
	const SKIPPED = "AgentPulse: not reported (AGENTPULSE_SKIP)";
	const EXCLUDED = "AgentPulse: not reported (excluded)";
	let project: string;
	const input = () => ({
		session_id: "hk-1",
		session_name: "thread",
		model: { display_name: "M" },
		workspace: { project_dir: project, current_dir: project },
		cwd: project,
	});
	const skipRun = (extraEnv: Record<string, string> = {}) =>
		run(input(), { AGENTPULSE_SKIP: "1", ...extraEnv });

	beforeEach(async () => {
		project = join(tmp, "a-project");
		await mkdir(project, { recursive: true });
		healthRelay = true;
		healthEnforces = true;
	});

	test("the control: every hook this session has goes to the relay with the skip header, at the user level or the project level: claimed", async () => {
		await writeClaudeSettings("relay");
		expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
		await writeClaudeSettings("relay", server.port, { dir: project });
		await writeClaudeSettings("relay", server.port, { dir: project, file: "settings.local.json" });
		expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
	});

	test("a relay hook without the skip header does not carry AGENTPULSE_SKIP: nothing claims the session is not reported", async () => {
		await writeClaudeSettings("relay", server.port, { skipHeader: false });
		const { stdout } = await skipRun();
		expect(stripAnsi(stdout)).not.toContain("not reported");
		expect(stripAnsi(stdout)).not.toContain("AgentPulse:");
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
	});

	test("the header is matched in any case, and it must be passed on: a header whose variable is not allowed through is not carried either", async () => {
		await mkdir(join(tmp, ".claude"), { recursive: true });
		const hookWith = (extra: Record<string, unknown>) =>
			writeFile(
				join(tmp, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						SessionStart: [
							{
								matcher: "",
								hooks: [
									{ type: "http", url: `http://localhost:${server.port}/api/v1/hooks`, ...extra },
								],
							},
						],
					},
				}),
			);
		await hookWith({
			allowedEnvVars: ["AGENTPULSE_SKIP"],
			headers: { "x-agentpulse-skip": "$AGENTPULSE_SKIP" },
		});
		expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
		await hookWith({ headers: { "X-AgentPulse-Skip": "$AGENTPULSE_SKIP" } });
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
		await hookWith({
			allowedEnvVars: ["AGENTPULSE_SKIP"],
			headers: { "X-AgentPulse-Skip": "constant" },
		});
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
	});

	test("a relay hook without the header still gets the path-based claim: the relay applies path rules whatever the hook sends", async () => {
		sessionLookup = "excluded";
		await writeClaudeSettings("relay", server.port, { skipHeader: false });
		const { stdout } = await run(input());
		expect(stripAnsi(stdout)).toContain(EXCLUDED);
	});

	for (const file of ["settings.json", "settings.local.json"] as const) {
		test(`a direct hook in the project's ${file} beside a relay hook at the user level: no claim of either kind`, async () => {
			await writeClaudeSettings("relay");
			await writeClaudeSettings("direct", server.port, { dir: project, file });
			expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
			sessionLookup = "excluded";
			expect(stripAnsi((await run(input())).stdout)).not.toContain("not reported");
		});
	}

	test("a project-level relay hook without the header, beside user-level ones with it: AGENTPULSE_SKIP is not claimed", async () => {
		await writeClaudeSettings("relay");
		await writeClaudeSettings("relay", server.port, { dir: project, skipHeader: false });
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
	});

	test("a project hook aimed at some other relay, beside hooks for this one: its events go somewhere else, so nothing is claimed", async () => {
		await writeClaudeSettings("relay");
		await writeClaudeSettings("relay", (server.port ?? 0) + 1, { dir: project });
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
		sessionLookup = "excluded";
		expect(stripAnsi((await run(input())).stdout)).not.toContain("not reported");
	});

	test("settings of some other directory are not this session's: a direct hook there changes nothing", async () => {
		await writeClaudeSettings("relay");
		const other = join(tmp, "another-project");
		await writeClaudeSettings("direct", server.port, { dir: other });
		expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
	});

	test("the project is found by any of the directories Claude Code reports, and an input without them still works", async () => {
		await writeClaudeSettings("relay");
		await writeClaudeSettings("direct", server.port, { dir: project });
		for (const workspace of [
			{ workspace: { project_dir: project } },
			{ workspace: { current_dir: project } },
			{ cwd: project },
		]) {
			const { stdout } = await run(
				{ session_id: "hk-1", model: { display_name: "M" }, ...workspace },
				{ AGENTPULSE_SKIP: "1" },
			);
			expect(stripAnsi(stdout), JSON.stringify(workspace)).not.toContain("not reported");
		}
		const { stdout } = await run(
			{ session_id: "hk-1", model: { display_name: "M" } },
			{ AGENTPULSE_SKIP: "1" },
		);
		expect(stripAnsi(stdout)).toContain(SKIPPED);
	});

	test("a settings file that cannot be read as JSON means the hooks are not known: no claim", async () => {
		await writeClaudeSettings("relay");
		await mkdir(join(project, ".claude"), { recursive: true });
		await writeFile(join(project, ".claude", "settings.json"), "{ not json");
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
		sessionLookup = "excluded";
		expect(stripAnsi((await run(input())).stdout)).not.toContain("not reported");
	});

	test("a settings file that names the hook auth header file is direct reporting, whatever else it holds; the same file without it is not", async () => {
		const keyed = { headersHelper: "cat ~/.agentpulse/hook-auth-header" };
		await writeClaudeSettings("relay", server.port, { extra: keyed });
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
		await writeClaudeSettings("relay", server.port, { extra: { headersHelper: "cat ~/other" } });
		expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
		await writeClaudeSettings("relay");
		expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
	});

	test("the same guard applies to a project-level file", async () => {
		await writeClaudeSettings("relay");
		await writeClaudeSettings("relay", server.port, {
			dir: project,
			extra: { headersHelper: "cat ~/.agentpulse/hook-auth-header" },
		});
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
	});
});

describe("statusline.sh — settings that are this session's, in the corners", () => {
	const SKIPPED = "AgentPulse: not reported (AGENTPULSE_SKIP)";
	const DIRECT_LINE =
		"AgentPulse: skip requested; in direct mode the server discards it on arrival";
	let project: string;
	const input = () => ({
		session_id: "hk-1",
		model: { display_name: "M" },
		workspace: { project_dir: project, current_dir: project },
		cwd: project,
	});
	const skipRun = (extraEnv: Record<string, string> = {}) =>
		run(input(), { AGENTPULSE_SKIP: "1", ...extraEnv });
	const relayWithHeader = (value: string) =>
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						matcher: "",
						hooks: [
							{
								type: "http",
								url: `http://localhost:${server.port}/api/v1/hooks`,
								allowedEnvVars: ["AGENTPULSE_SKIP"],
								headers: { "X-AgentPulse-Skip": value },
							},
						],
					},
				],
			},
		});
	const writeUserSettings = async (content: string) => {
		await mkdir(join(tmp, ".claude"), { recursive: true });
		await writeFile(join(tmp, ".claude", "settings.json"), content);
	};

	beforeEach(async () => {
		project = join(tmp, "a-project");
		await mkdir(project, { recursive: true });
		healthRelay = true;
		healthEnforces = true;
	});

	test("CLAUDE_CONFIG_DIR replaces ~/.claude as the user-level settings directory", async () => {
		await mkdir(join(tmp, "cfg"), { recursive: true });
		await writeClaudeSettings("direct");
		await writeFile(join(tmp, "cfg", "settings.json"), relayWithHeader("$AGENTPULSE_SKIP"));
		expect(stripAnsi((await skipRun({ CLAUDE_CONFIG_DIR: join(tmp, "cfg") })).stdout)).toContain(
			SKIPPED,
		);
		// without it, ~/.claude is read: a direct hook there is direct reporting
		expect(stripAnsi((await skipRun()).stdout)).toContain(DIRECT_LINE);
		// an empty value is no value
		expect(stripAnsi((await skipRun({ CLAUDE_CONFIG_DIR: "" })).stdout)).toContain(DIRECT_LINE);
	});

	for (const header of [
		"$AGENTPULSE_SKIPPED",
		"$AGENTPULSE_SKIP2",
		"$AGENTPULSE_SKIP_X",
		"${AGENTPULSE_SKIPPED}",
	]) {
		test(`a header that passes ${header} on is not the skip variable: no claim`, async () => {
			await writeUserSettings(relayWithHeader(header));
			expect(stripAnsi((await skipRun()).stdout)).not.toContain("not reported");
		});
	}

	for (const header of ["$AGENTPULSE_SKIP", "${AGENTPULSE_SKIP}", "x-$AGENTPULSE_SKIP-y"]) {
		test(`a header that passes ${header} on carries the skip variable: claimed`, async () => {
			await writeUserSettings(relayWithHeader(header));
			expect(stripAnsi((await skipRun()).stdout)).toContain(SKIPPED);
		});
	}

	test("an unreadable settings file beats a direct one, whichever level each is at: the hooks are not known, so no line at all", async () => {
		await writeClaudeSettings("direct");
		await mkdir(join(project, ".claude"), { recursive: true });
		await writeFile(join(project, ".claude", "settings.json"), "{ not json");
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("AgentPulse:");

		await writeUserSettings("{ not json");
		await writeClaudeSettings("direct", server.port, { dir: project });
		expect(stripAnsi((await skipRun()).stdout)).not.toContain("AgentPulse:");

		// the control: the direct hook alone is the direct line
		await writeUserSettings(JSON.stringify({}));
		expect(stripAnsi((await skipRun()).stdout)).toContain(DIRECT_LINE);
	});
});

describe("statusline.sh — against a real relay with rules", () => {
	type RelayModule = typeof import("./relay.ts");
	let relay: Awaited<ReturnType<RelayModule["startRelay"]>> | undefined;
	let upstreamCalls: string[];

	async function startRealRelay(rules: string[]) {
		const R = (await import("./relay.ts?module")) as RelayModule;
		await mkdir(join(tmp, ".agentpulse"), { recursive: true, mode: 0o700 });
		await chmod(join(tmp, ".agentpulse"), 0o700);
		await writeFile(join(tmp, ".agentpulse", "exclude"), `${rules.join("\n")}\n`, { mode: 0o600 });
		upstreamCalls = [];
		relay = await R.startRelay(
			{
				remoteUrl: "http://upstream.invalid",
				apiKey: "ap_TESTKEY_statusline_0123456789",
				port: 0,
				codexNamePolicy: "codex",
				stateDir: agentpulseDir(),
				configPath: null,
			},
			{
				timers: false,
				env: { HOME: tmp },
				// the account's home would come from the user database, which ignores HOME
				accountHome: () => undefined,
				log: () => {},
				fetch: (async (input: unknown) => {
					upstreamCalls.push(String(input));
					return Response.json({ session: { displayName: "brave-falcon" } });
				}) as unknown as typeof fetch,
			} as never,
		);
		return relay;
	}

	afterEach(() => {
		relay?.stop();
		relay = undefined;
	});

	const input = { session_id: "real-1", session_name: "thread", model: { display_name: "M" } };
	const runAgainst = (port: number, extraEnv: Record<string, string> = {}) =>
		run(input, { AGENTPULSE_PORT: String(port), ...extraEnv });

	test("direct-mode Claude next to a relay that has rules: a session the relay never saw is not called 'not reported'", async () => {
		const live = await startRealRelay([join(tmp, "secret")]);
		await writeClaudeSettings("direct");
		const { stdout } = await runAgainst(live.port);
		expect(stripAnsi(stdout)).not.toContain("not reported");
		expect(upstreamCalls).toEqual([]);
	});

	test("hooks pointed at that relay and a session in an excluded directory: the not-reported line", async () => {
		const live = await startRealRelay([join(tmp, "secret")]);
		await mkdir(join(tmp, "secret"), { recursive: true });
		await writeClaudeSettings("relay", live.port);
		await fetch(`http://127.0.0.1:${live.port}/api/v1/hooks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				session_id: "real-1",
				hook_event_name: "SessionStart",
				cwd: join(tmp, "secret"),
			}),
		});
		const { stdout } = await runAgainst(live.port);
		expect(stripAnsi(stdout)).toContain("AgentPulse: not reported (excluded)");
		expect(upstreamCalls).toEqual([]);
	});

	test("direct-mode Claude, AGENTPULSE_SKIP set, relay with rules: the direct-mode line, not 'not reported'", async () => {
		const live = await startRealRelay([join(tmp, "secret")]);
		await writeClaudeSettings("direct");
		const { stdout } = await runAgainst(live.port, { AGENTPULSE_SKIP: "1" });
		expect(stripAnsi(stdout)).not.toContain("not reported");
		expect(stripAnsi(stdout)).toContain("direct mode");
	});
});

describe("statusline.sh — the name lookup is the small read", () => {
	const INPUT = {
		session_id: "abc123",
		model: { display_name: "Opus" },
		context_window: { used_percentage: 10 },
	};
	const lookups = () =>
		requests.filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/sessions/"));
	const shownName = (stdout: string) => stdout.replace(/\x1b\[[0-9;]*m/g, "");

	test("it asks for the name only: ?fields=displayName on the session path, once", async () => {
		const { stdout } = await run(INPUT);
		// If the script still asked for the whole detail, search would be empty.
		expect(lookups().map((r) => `${r.path}${r.search}`)).toEqual([
			"/api/v1/sessions/abc123?fields=displayName",
		]);
		expect(shownName(stdout)).toContain("brave-falcon");
	});

	test("a server that predates the read answers the whole detail: the name still shows, with no second request", async () => {
		sessionLookup = "full";
		const { stdout } = await run(INPUT);
		expect(shownName(stdout)).toContain("brave-falcon");
		expect(lookups()).toHaveLength(1);
	});

	test("found: the name is remembered; unknown and excluded: it is not shown and no remembered name is used", async () => {
		await run(INPUT);
		expect(await readFile(join(agentpulseDir(), "cache", "name-abc123"), "utf-8")).toBe(
			"brave-falcon",
		);
		for (const mode of ["unknown", "excluded", "missing"] as const) {
			sessionLookup = mode;
			const { stdout } = await run(INPUT);
			expect({ mode, line: shownName(stdout).includes("brave-falcon") }).toEqual({
				mode,
				line: false,
			});
			expect(shownName(stdout)).toContain("abc123".slice(0, 8));
		}
	});

	test("the lookup failing (a server error, or no answer in time) shows the last name seen for this session, not the id", async () => {
		await run(INPUT);
		for (const mode of ["error", "slow"] as const) {
			sessionLookup = mode;
			const { stdout } = await run(INPUT);
			expect({ mode, name: shownName(stdout).includes("brave-falcon") }).toEqual({
				mode,
				name: true,
			});
		}
		server.stop(true);
		const { stdout } = await run(INPUT);
		expect(shownName(stdout)).toContain("brave-falcon");
	});

	test("a lookup that fails for a session never seen shows the id, as before", async () => {
		sessionLookup = "error";
		const { stdout } = await run(INPUT);
		expect(shownName(stdout)).toContain("abc123");
		expect(shownName(stdout)).not.toContain("brave-falcon");
	});

	test("a name that changed replaces the remembered one; one that didn't isn't rewritten", async () => {
		await run(INPUT);
		const file = join(agentpulseDir(), "cache", "name-abc123");
		const before = (await Bun.file(file).stat()).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await run(INPUT);
		expect((await Bun.file(file).stat()).mtimeMs).toBe(before);
		serverDisplayName = "renamed-otter";
		await run(INPUT);
		expect(await readFile(file, "utf-8")).toBe("renamed-otter");
	});

	test("a remembered name with control characters can't break the line, and an unsafe id never reaches the cache", async () => {
		await mkdir(join(agentpulseDir(), "cache"), { recursive: true });
		await writeFile(join(agentpulseDir(), "cache", "name-abc123"), "evil\u001b[2Jname\nsecond");
		sessionLookup = "error";
		const { stdout } = await run(INPUT);
		expect(stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(stdout).not.toContain("\u001b[2J");
		await run({ ...INPUT, session_id: "../../etc/x" });
		expect((await readdir(agentpulseDir())).filter((n) => n.includes("etc"))).toEqual([]);
	});

	test("with AGENTPULSE_SKIP set nothing is asked and no remembered name is read or written", async () => {
		await run(INPUT, { AGENTPULSE_SKIP: "1" });
		expect(lookups()).toEqual([]);
		await rm(join(agentpulseDir(), "cache"), { recursive: true, force: true });
		await run(INPUT, { AGENTPULSE_SKIP: "1" });
		expect(await readdir(agentpulseDir()).catch(() => [])).not.toContain("cache");
	});
});
