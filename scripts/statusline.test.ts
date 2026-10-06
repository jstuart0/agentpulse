/**
 * Phase 3 (D17, bob L1): statusline.sh pushes a native name only when it
 * differs from the cached last push, confines its cache to cache/, never
 * sends an unsafe session id over the wire, and appends the relay status hint
 * without breaking the one-line statusline protocol.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "statusline.sh");

// Every test starts real shell processes; on a loaded machine one can pass Bun's 5 s default.
setDefaultTimeout(20_000);

/** What the script stores for a pushed name: POSIX `cksum` of it (checksum and length), not the name. */
async function cksumOf(name: string): Promise<string> {
	const proc = Bun.spawn(["sh", "-c", "cksum | cut -d' ' -f1,2"], {
		stdin: new TextEncoder().encode(name),
		stdout: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

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
let sessionLookup:
	| "ok"
	| "excluded"
	| "unknown"
	| "missing"
	| "full"
	| "error"
	| "slow"
	| "rules_invalid";
let server: ReturnType<typeof Bun.serve>;
/** While set, the stub holds every PUT /native-name response until released (to order a background push against another render). */
let putGate: { promise: Promise<void>; release: () => void } | null = null;
const holdPuts = () => {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	putGate = { promise, release };
	return putGate;
};

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-statusline-test-"));
	requests = [];
	putGate = null;
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
				if (sessionLookup === "rules_invalid")
					return Response.json({ error: "rules_invalid" }, { status: 404 });
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
				if (putGate) await putGate.promise;
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

/**
 * Waits until no background push of the script is still running. The script
 * backgrounds the name push and returns at once; its subshell keeps the script's
 * own command line, so "no `bash <script>` process left" means every push has
 * finished writing (or giving up). A check that nothing happened must wait for
 * this first, or a slow machine passes it vacuously.
 */
async function settle(timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ps = Bun.spawn(["ps", "-axo", "command"], { stdout: "pipe" });
		const out = await new Response(ps.stdout).text();
		await ps.exited;
		if (!out.split("\n").some((line) => line.startsWith(`bash ${SCRIPT}`))) return;
		if (Date.now() > deadline) throw new Error("a background push never finished");
		await Bun.sleep(20);
	}
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
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
		// a digest of the name, never the name
		expect(await readFile(cacheFile, "utf-8")).toBe(await cksumOf("my-thread"));

		await run(input);
		await settle();
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
		await settle();
		expect(await Bun.file(join(agentpulseDir(), "cache", "native-name-retry-1")).exists()).toBe(
			false,
		);
	});

	test("a session_id containing ../ never escapes cache/ and is never sent to the relay", async () => {
		const { stdout, code } = await run({ session_id: "../../escape", session_name: "evil" });
		expect(code).toBe(0);
		expect(stdout.split("\n").filter(Boolean)).toHaveLength(1);
		await settle();
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
			await settle();
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
		await settle();
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
			await settle();
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
			await settle();
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
		await settle();
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
		await settle();
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

describe("statusline.sh — the name lookup is the small read, and no display name is kept", () => {
	const INPUT = {
		session_id: "abc123",
		model: { display_name: "Opus" },
		context_window: { used_percentage: 10 },
	};
	const lookups = () =>
		requests.filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/sessions/"));
	const shownName = (stdout: string) => stripAnsi(stdout);
	const cache = () => join(agentpulseDir(), "cache");

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

	test("a found name is not written to disk", async () => {
		await run(INPUT);
		await settle();
		// If the name were remembered, a name- file would appear here.
		expect(await readdir(cache()).catch(() => [])).toEqual([]);
	});

	for (const mode of [
		"error",
		"slow",
		"unknown",
		"missing",
		"excluded",
		"rules_invalid",
	] as const) {
		test(`when the lookup says ${mode}, the line shows the short session id, even beside a leftover name file from an intermediate build`, async () => {
			await mkdir(cache(), { recursive: true });
			await writeFile(join(cache(), "name-abc123"), "stale-leftover");
			sessionLookup = mode;
			const out = shownName((await run(INPUT)).stdout);
			expect(out).not.toContain("stale-leftover");
			expect(out).toContain("abc123");
			// the leftover is neither read nor touched
			expect(await readFile(join(cache(), "name-abc123"), "utf-8")).toBe("stale-leftover");
		});
	}

	test("when nothing answers at all, the line shows the short session id too", async () => {
		await mkdir(cache(), { recursive: true });
		await writeFile(join(cache(), "name-abc123"), "stale-leftover");
		server.stop(true);
		const out = shownName((await run(INPUT)).stdout);
		expect(out).not.toContain("stale-leftover");
		expect(out).toContain("abc123");
	});

	test("a server name with control characters can't break the line, and an unsafe id never reaches the cache", async () => {
		serverDisplayName = "evil\u001b[2Jname\nsecond";
		const { stdout } = await run(INPUT);
		expect(stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(stdout).not.toContain("\u001b[2J");
		await run({ ...INPUT, session_id: "../../etc/x" });
		await settle();
		expect(
			(await readdir(agentpulseDir()).catch(() => [])).filter((n) => n.includes("etc")),
		).toEqual([]);
	});

	test("with AGENTPULSE_SKIP set nothing is asked and nothing is written", async () => {
		await run(INPUT, { AGENTPULSE_SKIP: "1" });
		await settle();
		expect(lookups()).toEqual([]);
		expect(await readdir(agentpulseDir()).catch(() => [])).not.toContain("cache");
	});
});

describe("statusline.sh — the pushed-name record is kept only while it may be, and holds no name", () => {
	const INPUT = {
		session_id: "abc123",
		session_name: "native-thread",
		model: { display_name: "Opus" },
	};
	const cache = () => join(agentpulseDir(), "cache");
	const nativeFile = () => join(cache(), "native-name-abc123");
	const exists = (f: string) => Bun.file(f).exists();

	async function pushed() {
		await run(INPUT);
		await waitFor(() => exists(nativeFile()));
		await settle();
		requests.length = 0;
	}

	test("it holds a digest, never the name", async () => {
		await pushed();
		const content = await readFile(nativeFile(), "utf-8");
		expect(content).toBe(await cksumOf("native-thread"));
		expect(content).not.toContain("native-thread");
	});

	test("an excluded answer removes it", async () => {
		await pushed();
		sessionLookup = "excluded";
		await run(INPUT);
		expect(await exists(nativeFile())).toBe(false);
	});

	test("a push still in flight when another render learns 'excluded' writes after the removal: the file that appears holds only a digest, and the next render removes it", async () => {
		// A real backgrounded push, ordered deterministically: the stub holds its PUT
		// response, render B (excluded) runs and removes nothing-yet, then the PUT is
		// released and the push's own subshell writes the record.
		const gate = holdPuts();
		await run(INPUT);
		await waitFor(() => puts().length === 1);
		sessionLookup = "excluded";
		await run(INPUT);
		expect(await exists(nativeFile())).toBe(false);
		gate.release();
		putGate = null;
		await settle();
		const left = await readFile(nativeFile(), "utf-8");
		expect(left).toBe(await cksumOf("native-thread"));
		expect(left).not.toContain("native-thread");
		await run(INPUT);
		expect(await exists(nativeFile())).toBe(false);
	});

	test("while AGENTPULSE_SKIP is active it is removed too", async () => {
		await pushed();
		await run(INPUT, { AGENTPULSE_SKIP: "1" });
		expect(await exists(nativeFile())).toBe(false);
	});

	test("an unknown session or a failed lookup leaves it (the name was accepted before; nothing says to forget it)", async () => {
		await pushed();
		for (const mode of ["unknown", "error"] as const) {
			sessionLookup = mode;
			await run(INPUT);
		}
		await settle();
		expect(await exists(nativeFile())).toBe(true);
	});

	test("a changed name is pushed and recorded; the same name is not pushed again", async () => {
		await pushed();
		await run(INPUT);
		await settle();
		expect(puts()).toHaveLength(0);
		await run({ ...INPUT, session_name: "second-name" });
		await waitFor(() => puts().length === 1);
		await waitFor(
			async () => (await readFile(nativeFile(), "utf-8")) === (await cksumOf("second-name")),
		);
	});
});

describe("statusline.sh — the pushed-name record is private and never followed through a link", () => {
	const INPUT = {
		session_id: "abc123",
		session_name: "native-thread",
		model: { display_name: "Opus" },
	};
	const cache = () => join(agentpulseDir(), "cache");
	const nativeFile = () => join(cache(), "native-name-abc123");
	const mode = async (f: string) => (await lstat(f)).mode & 0o777;
	const withUmask022 = async () => {
		const proc = Bun.spawn(["sh", "-c", 'umask 022; exec bash "$0"', SCRIPT], {
			stdin: new TextEncoder().encode(JSON.stringify(INPUT)),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: tmp,
				AGENTPULSE_PORT: String(server.port),
				AGENTPULSE_DIR: agentpulseDir(),
			},
		});
		await new Response(proc.stdout).text();
		await proc.exited;
	};

	test("under umask 022 the directory is 0700 and the file 0600, an existing looser directory is tightened, and no temp file is left", async () => {
		await mkdir(cache(), { recursive: true, mode: 0o755 });
		await chmod(cache(), 0o755);
		await withUmask022();
		await waitFor(() => Bun.file(nativeFile()).exists());
		await settle();
		expect(await mode(cache())).toBe(0o700);
		expect(await mode(nativeFile())).toBe(0o600);
		expect((await readdir(cache())).filter((n) => n.startsWith(".tmp"))).toEqual([]);
	});

	test("an older, looser directory and file are tightened whenever the script touches them, even when the name is unchanged and nothing is written", async () => {
		await mkdir(cache(), { recursive: true });
		await writeFile(nativeFile(), await cksumOf("native-thread"));
		await chmod(cache(), 0o755);
		await chmod(nativeFile(), 0o644);
		await run(INPUT);
		await settle();
		expect(puts()).toHaveLength(0);
		expect(await mode(cache())).toBe(0o700);
		expect(await mode(nativeFile())).toBe(0o600);
	});

	test("a symlink at the record is not trusted, even when its target holds the right digest: the push still happens", async () => {
		const outside = join(tmp, "outside-correct");
		await writeFile(outside, await cksumOf("native-thread"));
		await mkdir(cache(), { recursive: true });
		await symlink(outside, nativeFile());
		await run(INPUT);
		await waitFor(() => puts().length === 1);
		await settle();
		// If the link had been read, the digest would match and nothing would be pushed.
		expect(puts()).toHaveLength(1);
		// and the link is still a link to the untouched target
		expect((await lstat(nativeFile())).isSymbolicLink()).toBe(true);
		expect(await readlink(nativeFile())).toBe(outside);
		expect(await readFile(outside, "utf-8")).toBe(await cksumOf("native-thread"));
	});

	test("a planted symlink is never written through, never loosened, and is left in place after the write is refused", async () => {
		const outside = join(tmp, "outside-native");
		await writeFile(outside, "untouched");
		await chmod(outside, 0o644);
		await mkdir(cache(), { recursive: true });
		await symlink(outside, nativeFile());
		await run(INPUT);
		await waitFor(() => puts().length >= 1);
		await settle();
		expect(await readFile(outside, "utf-8")).toBe("untouched");
		expect((await lstat(outside)).mode & 0o777).toBe(0o644);
		expect((await lstat(nativeFile())).isSymbolicLink()).toBe(true);
		expect(await readlink(nativeFile())).toBe(outside);
		expect((await readdir(cache())).filter((n) => n.startsWith(".tmp"))).toEqual([]);
	});

	test("a cache directory that is itself a symlink is not used, and stays a symlink", async () => {
		const elsewhere = join(tmp, "elsewhere");
		await mkdir(elsewhere, { recursive: true });
		await mkdir(agentpulseDir(), { recursive: true });
		await symlink(elsewhere, cache());
		await run(INPUT);
		await waitFor(() => puts().length >= 1);
		await settle();
		expect(await readdir(elsewhere)).toEqual([]);
		expect((await lstat(cache())).isSymbolicLink()).toBe(true);
	});

	test("a record path that is not a regular file is not read or replaced, and nothing is put inside it", async () => {
		await mkdir(nativeFile(), { recursive: true });
		await run(INPUT);
		await waitFor(() => puts().length >= 1);
		await settle();
		expect((await lstat(nativeFile())).isDirectory()).toBe(true);
		expect(await readdir(nativeFile())).toEqual([]);
		expect((await readdir(cache())).filter((n) => n.startsWith(".tmp"))).toEqual([]);
	});
});

describe("statusline.sh — the pushed-name records don't pile up", () => {
	const INPUT = (id: string, name = "native-thread") => ({
		session_id: id,
		session_name: name,
		model: { display_name: "Opus" },
	});
	const cache = () => join(agentpulseDir(), "cache");
	const DAY = 86_400;
	const old = async (dir: string, name: string, days: number) => {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, name), "old");
		const when = Date.now() / 1000 - days * DAY;
		await utimes(join(dir, name), when, when);
	};
	const pushNew = async (id: string, name?: string) => {
		const before = puts().length;
		await run(INPUT(id, name));
		await waitFor(() => puts().length === before + 1);
		await waitFor(() => Bun.file(join(cache(), `native-name-${id}`)).exists());
		await settle();
	};

	test("records untouched for 30 days go the next time one is written, recent ones stay", async () => {
		await old(cache(), "native-name-stale1", 45);
		await old(cache(), "native-name-recent", 5);
		await pushNew("fresh1");
		const left = (await readdir(cache())).sort();
		expect(left).toContain("native-name-fresh1");
		expect(left).toContain("native-name-recent");
		expect(left).not.toContain("native-name-stale1");
	});

	test("only the cache directory is swept: an old file of that name directly in the AgentPulse directory, or one in a directory under cache/, is left alone", async () => {
		await old(agentpulseDir(), "native-name-x", 45);
		await old(join(cache(), "nested"), "native-name-y", 45);
		await old(cache(), "native-name-stale", 45);
		await pushNew("fresh2");
		expect(await Bun.file(join(cache(), "native-name-stale")).exists()).toBe(false);
		// If the sweep were rooted higher, or went deeper, these would be gone.
		expect(await Bun.file(join(agentpulseDir(), "native-name-x")).exists()).toBe(true);
		expect(await Bun.file(join(cache(), "nested", "native-name-y")).exists()).toBe(true);
	});

	test("leftover name-* files from an intermediate build are never read and are not pruned (nothing owns them any more)", async () => {
		await old(cache(), "name-leftover", 45);
		await pushNew("fresh3");
		expect(await Bun.file(join(cache(), "name-leftover")).exists()).toBe(true);
	});

	test("the sweep is rate limited: a second one inside a day finds nothing to do, one after a day does", async () => {
		await pushNew("fresh4");
		await old(cache(), "native-name-stale2", 45);
		await pushNew("fresh5");
		expect(await Bun.file(join(cache(), "native-name-stale2")).exists()).toBe(true);
		const longAgo = Date.now() / 1000 - 2 * DAY;
		await utimes(join(cache(), ".swept"), longAgo, longAgo);
		await pushNew("fresh6");
		expect(await Bun.file(join(cache(), "native-name-stale2")).exists()).toBe(false);
	});

	test("a render that writes nothing never sweeps", async () => {
		await pushNew("fresh7");
		await old(cache(), "native-name-stale3", 45);
		await rm(join(cache(), ".swept"), { force: true });
		await run(INPUT("fresh7"));
		await settle();
		expect(await Bun.file(join(cache(), "native-name-stale3")).exists()).toBe(true);
	});
});

describe("statusline.sh — what is printed is a plain name", () => {
	const INPUT = { session_id: "abc123", model: { display_name: "Opus" } };
	const U = (code: number) => String.fromCodePoint(code);
	const printedFor = async (name: string) => {
		serverDisplayName = name;
		const out = (await run(INPUT)).stdout;
		return { out, plain: stripAnsi(out) };
	};

	// Every character the script strips, at both ends of every range it names.
	const STRIPPED: Array<[string, number]> = [
		["DEL", 0x7f],
		["the first C1 control", 0x80],
		["the last C1 control", 0x9f],
		["the first zero-width format character, U+200B", 0x200b],
		["the last of that range, U+200F", 0x200f],
		["the first bidi embedding, U+202A", 0x202a],
		["the last, U+202E", 0x202e],
		["the first of the word-joiner range, U+2060", 0x2060],
		["the last, U+2064", 0x2064],
		["the first bidi isolate, U+2066", 0x2066],
		["the last, U+2069", 0x2069],
		["the BOM, U+FEFF", 0xfeff],
	];
	for (const [label, code] of STRIPPED) {
		test(`strips ${label}`, async () => {
			const { out, plain } = await printedFor(`a${U(code)}b`);
			expect(plain).not.toContain(U(code));
			expect(plain).toContain("ab");
			expect(out.trimEnd().split("\n")).toHaveLength(1);
		});
	}

	test("strips an ESC sequence and keeps the line one line", async () => {
		const { out, plain } = await printedFor(`a${U(0x1b)}[2Jb`);
		expect(out.trimEnd().split("\n")).toHaveLength(1);
		expect(plain).not.toContain(U(0x1b));
	});

	// The neighbours just outside each range, and ordinary text, which must come through.
	const KEPT: Array<[string, string]> = [
		["U+00A0, the no-break space just past the C1 range", `a${U(0xa0)}b`],
		["U+200A, the hair space just before the zero-width range", `a${U(0x200a)}b`],
		["U+2010, a hyphen after the bidi range's neighbours", `a${U(0x2010)}b`],
		["an accented letter", "Zoë-Müller"],
		["CJK", "日本語のセッション"],
		["an emoji", `rocket-${U(0x1f680)}-ship`],
		["accents and a space", "naïve café"],
	];
	for (const [label, name] of KEPT) {
		test(`keeps ${label}`, async () => {
			const { plain } = await printedFor(name);
			expect(plain).toContain(name);
		});
	}
});
