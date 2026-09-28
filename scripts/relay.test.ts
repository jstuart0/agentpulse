/**
 * Phase 3 (F9, D2, D4, D10, D11, D17, D23): the relay's pure seam and its
 * sync/diagnostics behavior, exercised against real port-0 stub servers.
 *
 * `relay.ts` is loaded lazily through `mod()` so the very first test can
 * prove the import itself is side-effect free (no port bound, no exit).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "../src/server/services/__fixtures__/native-name-sanitizer.json" with {
	type: "json",
};
import { sanitizeNativeName } from "../src/server/services/name-sanitizer.js";
import { computeChecksum as serverChecksum } from "../src/server/util/checksum.js";

type RelayModule = typeof import("./relay.ts");
let loaded: RelayModule | undefined;
async function mod(): Promise<RelayModule> {
	loaded ??= await import("./relay.ts");
	return loaded;
}

const RELAY_PATH = join(import.meta.dir, "relay.ts");
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-28T12:00:00.000Z");

type Recorded = { method: string; path: string; search: string; body: string };
type StubHandler = (
	method: string,
	url: URL,
	body: string,
) => Response | Promise<Response> | undefined;

function startStub(handler: StubHandler) {
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "GET" ? "" : await req.text();
			requests.push({ method: req.method, path: url.pathname, search: url.search, body });
			return (await handler(req.method, url, body)) ?? new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		stop: () => server.stop(true),
	};
}

let tmp: string;
const stops: Array<() => unknown> = [];

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-relay-test-"));
});

afterEach(async () => {
	while (stops.length) await stops.pop()?.();
	await rm(tmp, { recursive: true, force: true });
});

type Policy = "agentpulse" | "codex";

async function makeCtx(opts: {
	remote: string;
	policy?: Policy;
	now?: () => number;
	stateDir?: string;
	home?: string;
}) {
	const R = await mod();
	const stateDir = opts.stateDir ?? join(tmp, "state");
	const home = opts.home ?? join(tmp, "home");
	await mkdir(stateDir, { recursive: true });
	await mkdir(join(home, ".codex"), { recursive: true });
	return R.createRelayContext(
		{
			remoteUrl: opts.remote,
			apiKey: "ap_test_key",
			port: 0,
			codexNamePolicy: opts.policy ?? "codex",
			stateDir,
			configPath: null,
		},
		{
			env: { HOME: home },
			scriptPath: RELAY_PATH,
			now: opts.now,
			log: () => {},
		},
	);
}

function indexPath(home = join(tmp, "home")) {
	return join(home, ".codex", "session_index.jsonl");
}

async function readJsonl(path: string): Promise<Array<Record<string, string>>> {
	let raw = "";
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function row(id: string, thread_name: string, updated_at = "2026-09-28T11:00:00.000Z") {
	return { id, thread_name, updated_at };
}

function jsonl(rows: Array<Record<string, string>>) {
	return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

describe("seam (F9)", () => {
	test("importing relay.ts twice binds no port, does not exit, does not throw", async () => {
		const serveSpy = spyOn(Bun, "serve");
		// Throw instead of exiting: at the pre-seam base, importing relay.ts
		// called process.exit(1) and took the whole test runner down with it.
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called during import");
		});
		try {
			const a = await import("./relay.ts");
			const b = await import("./relay.ts");
			expect(typeof a.parseArgs).toBe("function");
			expect(b.parseArgs).toBe(a.parseArgs);
			expect(serveSpy).not.toHaveBeenCalled();
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			serveSpy.mockRestore();
			exitSpy.mockRestore();
		}
	});

	test("relay.ts imports only node: builtins (it must stay self-contained)", async () => {
		const src = await readFile(RELAY_PATH, "utf-8");
		const specifiers = [...src.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const s of specifiers) expect(s.startsWith("node:")).toBe(true);
		expect(src).not.toMatch(/await import\(/);
	});

	test("parseArgs with no URL returns {ok:false} instead of exiting", async () => {
		const R = await mod();
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});
		try {
			const res = R.parseArgs([], {});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toMatch(/url/i);
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("createRelayState returns independent instances", async () => {
		const R = await mod();
		const a = R.createRelayState();
		const b = R.createRelayState();
		a.lastEventAtByAgent.codex_cli = "2026-09-28T00:00:00.000Z";
		a.queue.consecutiveHookFailures = 3;
		a.codexPull.set("x", { seenKey: "k", missKey: null, missCount: 0 });
		expect(b.lastEventAtByAgent).toEqual({});
		expect(b.queue.consecutiveHookFailures).toBe(0);
		expect(b.codexPull.size).toBe(0);
	});
});

describe("parseArgs precedence (argv > --config > default)", () => {
	test("positional URL and --key keep working (back-compat with existing plists)", async () => {
		const R = await mod();
		const res = R.parseArgs(["https://ap.example.com/", "--port", "4001", "--key", "ap_k"], {});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.config.remoteUrl).toBe("https://ap.example.com");
		expect(res.config.port).toBe(4001);
		expect(res.config.apiKey).toBe("ap_k");
		expect(res.config.codexNamePolicy).toBe("codex");
	});

	test("config file supplies values argv omits; argv wins where both are set", async () => {
		const R = await mod();
		const file = { remote_url: "https://file.example.com", api_key: "ap_file", port: 4100 };
		const fromFile = R.parseArgs(["--config", "/cfg/relay/config.json"], file);
		expect(fromFile.ok).toBe(true);
		if (!fromFile.ok) return;
		expect(fromFile.config.remoteUrl).toBe("https://file.example.com");
		expect(fromFile.config.apiKey).toBe("ap_file");
		expect(fromFile.config.port).toBe(4100);
		expect(fromFile.config.configPath).toBe("/cfg/relay/config.json");

		const argvWins = R.parseArgs(
			["https://argv.example.com", "--port", "4200", "--key", "ap_argv", "--config", "/c.json"],
			file,
		);
		expect(argvWins.ok).toBe(true);
		if (!argvWins.ok) return;
		expect(argvWins.config.remoteUrl).toBe("https://argv.example.com");
		expect(argvWins.config.port).toBe(4200);
		expect(argvWins.config.apiKey).toBe("ap_argv");
	});

	test("defaults: port 4000, empty key, codex policy", async () => {
		const R = await mod();
		const res = R.parseArgs(["https://ap.example.com"], {});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.config.port).toBe(4000);
		expect(res.config.apiKey).toBe("");
		expect(res.config.codexNamePolicy).toBe("codex");
	});

	test("stateDir: state_dir > dir of --config > $AGENTPULSE_DIR > script dir", async () => {
		const R = await mod();
		const env = { agentpulseDir: "/env/agentpulse", scriptDir: "/script/dir" };
		const url = "https://ap.example.com";
		const pick = (argv: string[], file: Record<string, unknown>, e: typeof env | object) => {
			const res = R.parseArgs(argv, file, e);
			if (!res.ok) throw new Error(res.error);
			return res.config.stateDir;
		};
		expect(pick([url, "--config", "/cfg/x/config.json"], { state_dir: "/explicit" }, env)).toBe(
			"/explicit",
		);
		expect(pick([url, "--config", "/cfg/x/config.json"], {}, env)).toBe("/cfg/x");
		expect(pick([url], {}, env)).toBe("/env/agentpulse");
		expect(pick([url], {}, { scriptDir: "/script/dir" })).toBe("/script/dir");
	});

	test("invalid port, non-http URL and unknown flags are rejected", async () => {
		const R = await mod();
		expect(R.parseArgs(["https://ap.example.com", "--port", "abc"], {}).ok).toBe(false);
		expect(R.parseArgs(["https://ap.example.com", "--port", "70000"], {}).ok).toBe(false);
		expect(R.parseArgs(["ftp://ap.example.com"], {}).ok).toBe(false);
		expect(R.parseArgs(["https://ap.example.com", "--bogus"], {}).ok).toBe(false);
	});

	test("codexNamePolicy: argv > config > default codex; unknown value rejected (D23)", async () => {
		const R = await mod();
		const url = "https://ap.example.com";
		const policy = (argv: string[], file: Record<string, unknown>) => {
			const res = R.parseArgs(argv, file);
			return res.ok ? res.config.codexNamePolicy : "ERR";
		};
		expect(policy([url, "--codex-name-policy", "agentpulse"], { codex_name_policy: "codex" })).toBe(
			"agentpulse",
		);
		expect(policy([url], { codex_name_policy: "agentpulse" })).toBe("agentpulse");
		expect(policy([url], {})).toBe("codex");
		expect(policy([url, "--codex-name-policy", "bogus"], {})).toBe("ERR");
		expect(policy([url], { codex_name_policy: "bogus" })).toBe("ERR");
	});

	test("loadConfigFile reads the installer's snake_case file; a missing file is {}", async () => {
		const R = await mod();
		const p = join(tmp, "config.json");
		await writeFile(
			p,
			JSON.stringify({ remote_url: "https://f.example.com", api_key: "ap_f", port: 4300 }),
		);
		expect(await R.loadConfigFile(p)).toEqual({
			remote_url: "https://f.example.com",
			api_key: "ap_f",
			port: 4300,
		});
		expect(await R.loadConfigFile(join(tmp, "missing.json"))).toEqual({});
		await writeFile(p, "{not json");
		await expect(R.loadConfigFile(p)).rejects.toThrow();
	});
});

describe("evaluateScopes (D10)", () => {
	const me = (scopes?: unknown) => ({
		authenticated: true,
		user: scopes === undefined ? { name: "k", source: "api_key" } : { scopes },
	});

	test("scope table", async () => {
		const R = await mod();
		expect(R.evaluateScopes(me(["ingest"]))).toMatchObject({
			missing: ["observe"],
			hasManage: false,
			scopes: ["ingest"],
		});
		expect(R.evaluateScopes(me(["ingest", "observe"]))).toMatchObject({
			missing: [],
			hasManage: false,
		});
		expect(R.evaluateScopes(me(["*"]))).toMatchObject({ missing: [], hasManage: true });
		expect(R.evaluateScopes(me([]))).toMatchObject({ missing: ["ingest", "observe"] });
		expect(R.evaluateScopes(me(["ingest", "manage"]))).toMatchObject({
			missing: [],
			hasManage: true,
		});
	});

	test("a response with no scopes field is degraded, not a throw", async () => {
		const R = await mod();
		const res = R.evaluateScopes(me(undefined));
		expect(res.degraded).toBe(true);
		expect(res.scopes).toBeNull();
		expect(res.missing).toEqual([]);
		expect(R.evaluateScopes(null).degraded).toBe(true);
		expect(R.evaluateScopes("garbage").degraded).toBe(true);
	});

	test("disableAuth server → nothing missing; unauthenticated → both missing", async () => {
		const R = await mod();
		expect(R.evaluateScopes({ authenticated: false, disableAuth: true })).toMatchObject({
			missing: [],
			hasManage: true,
			degraded: false,
		});
		expect(R.evaluateScopes({ authenticated: false, disableAuth: false })).toMatchObject({
			missing: ["ingest", "observe"],
			hasManage: false,
		});
	});
});

describe("classifyForwardStatus", () => {
	test("table", async () => {
		const R = await mod();
		for (const s of [200, 201, 202, 204]) expect(R.classifyForwardStatus(s)).toBe("delivered");
		for (const s of [401, 403, 408, 429, 500, 502, 503])
			expect(R.classifyForwardStatus(s)).toBe("retry");
		for (const s of [400, 404, 413, 422]) expect(R.classifyForwardStatus(s)).toBe("drop");
	});
});

describe("isAllowedLocalRequest (D4)", () => {
	const h = (init: Record<string, string>) => new Headers(init);
	test("table", async () => {
		const R = await mod();
		expect(R.isAllowedLocalRequest(h({ host: "localhost:4000", origin: "null" }), 4000).ok).toBe(
			false,
		);
		expect(
			R.isAllowedLocalRequest(h({ host: "localhost:4000", origin: "https://evil.example" }), 4000)
				.ok,
		).toBe(false);
		expect(R.isAllowedLocalRequest(h({ host: "LOCALHOST:4000" }), 4000).ok).toBe(true);
		expect(R.isAllowedLocalRequest(h({ host: "localhost" }), 4000).ok).toBe(false);
		expect(R.isAllowedLocalRequest(h({ host: "[::1]:4000" }), 4000).ok).toBe(true);
		expect(R.isAllowedLocalRequest(h({ host: "127.0.0.1:4000" }), 4000).ok).toBe(true);
		expect(R.isAllowedLocalRequest(h({ host: "evil.example:4000" }), 4000).ok).toBe(false);
		expect(R.isAllowedLocalRequest(h({ host: "localhost:4001" }), 4000).ok).toBe(false);
		expect(R.isAllowedLocalRequest(h({}), 4000).ok).toBe(false);
		const rejected = R.isAllowedLocalRequest(h({ host: "localhost:4000", origin: "null" }), 4000);
		if (!rejected.ok) expect(rejected.reason).toBe("relay_rejects_browser_requests");
	});
});

describe("isSafeInstructionsPath (D11)", () => {
	test("bound to the session cwd", async () => {
		const R = await mod();
		expect(R.isSafeInstructionsPath("/w/CLAUDE.md", "/w")).toEqual({ ok: true });
		expect(R.isSafeInstructionsPath("/w/AGENTS.md", "/w")).toEqual({ ok: true });
		expect(R.isSafeInstructionsPath("/w/CLAUDE.md", "/w/")).toEqual({ ok: true });
		expect(R.isSafeInstructionsPath("/other/CLAUDE.md", "/w")).toEqual({
			ok: false,
			reason: "path_outside_session_cwd",
		});
		expect(R.isSafeInstructionsPath("/w/../etc/CLAUDE.md", "/w")).toEqual({
			ok: false,
			reason: "path_traversal_rejected",
		});
		expect(R.isSafeInstructionsPath("CLAUDE.md", "/w")).toEqual({
			ok: false,
			reason: "path_not_absolute",
		});
		expect(R.isSafeInstructionsPath("/w/sub/CLAUDE.md", "/w")).toEqual({
			ok: false,
			reason: "path_outside_session_cwd",
		});
		expect(R.isSafeInstructionsPath("/w/notes.md", "/w")).toEqual({
			ok: false,
			reason: "path_outside_session_cwd",
		});
	});

	test("matching is byte-exact: basename and cwd case are not folded (macOS default FS is case-insensitive)", async () => {
		const R = await mod();
		expect(R.isSafeInstructionsPath("/w/claude.md", "/w")).toEqual({
			ok: false,
			reason: "path_outside_session_cwd",
		});
		expect(R.isSafeInstructionsPath("/W/CLAUDE.md", "/w")).toEqual({
			ok: false,
			reason: "path_outside_session_cwd",
		});
	});

	test("a relative or traversing session cwd is itself rejected", async () => {
		const R = await mod();
		expect(R.isSafeInstructionsPath("/etc/CLAUDE.md", "/w/../etc")).toEqual({
			ok: false,
			reason: "path_traversal_rejected",
		});
		expect(R.isSafeInstructionsPath("/w/CLAUDE.md", "w")).toEqual({
			ok: false,
			reason: "path_outside_session_cwd",
		});
	});

	test("instruction-file order: CLAUDE.md first only for claude_code", async () => {
		const R = await mod();
		expect(R.instructionFileOrder("claude_code")).toEqual(["CLAUDE.md", "AGENTS.md"]);
		expect(R.instructionFileOrder(null)).toEqual(["CLAUDE.md", "AGENTS.md"]);
		expect(R.instructionFileOrder("codex_cli")).toEqual(["AGENTS.md", "CLAUDE.md"]);
		expect(R.instructionFileOrder("copilot_cli")).toEqual(["AGENTS.md", "CLAUDE.md"]);
	});
});

describe("parseCodexIndex + ledger (D23)", () => {
	test("last-write-wins; a malformed line is skipped without dropping later lines", async () => {
		const R = await mod();
		const raw = `${JSON.stringify(row("a", "one"))}\n{not json\n${JSON.stringify(row("a", "two"))}\n${JSON.stringify(row("b", "bee"))}\n\n`;
		const { latest } = R.parseCodexIndex(raw, new Set());
		expect(latest.get("a")?.thread_name).toBe("two");
		expect(latest.get("b")?.thread_name).toBe("bee");
	});

	test("latestForeign skips ledger rows while latest includes them", async () => {
		const R = await mod();
		const codexRow = row("a", "codex-title", "2026-09-28T10:00:00.000Z");
		const ours = row("a", "dash-name", "2026-09-28T10:05:00.000Z");
		const ledger = R.parseLedger(jsonl([ours]));
		const { latest, latestForeign } = R.parseCodexIndex(jsonl([codexRow, ours]), ledger);
		expect(latest.get("a")?.thread_name).toBe("dash-name");
		expect(latestForeign.get("a")?.thread_name).toBe("codex-title");
	});

	test("a corrupt ledger line neither throws nor misclassifies rows (F60)", async () => {
		const R = await mod();
		const a = row("a", "ours-a", "2026-09-28T10:00:00.000Z");
		const c = row("c", "ours-c", "2026-09-28T10:02:00.000Z");
		const ledgerRaw = `${JSON.stringify(a)}\n{"id":"b","thread_name":\n${JSON.stringify(c)}\ngarbage\n`;
		const ledger = R.parseLedger(ledgerRaw);
		expect(ledger.size).toBe(2);
		const b = row("b", "codex-b", "2026-09-28T10:01:00.000Z");
		const { latest, latestForeign } = R.parseCodexIndex(jsonl([a, b, c]), ledger);
		expect(latest.size).toBe(3);
		expect(latestForeign.has("a")).toBe(false);
		expect(latestForeign.get("b")?.thread_name).toBe("codex-b");
		expect(latestForeign.has("c")).toBe(false);
	});
});

describe("sanitizeName parity with the server sanitizer (F79)", () => {
	test("shared fixture", async () => {
		const R = await mod();
		expect(fixtures.length).toBeGreaterThanOrEqual(6);
		for (const f of fixtures) expect(R.sanitizeName(f.input)).toBe(f.expected);
	});

	test("matches sanitizeNativeName on extra inputs, including U+202E + 300 code points", async () => {
		const R = await mod();
		const inputs = [
			`evil‮${"n".repeat(300)}`,
			"  padded  ",
			"a⁦b⁩c",
			"😀".repeat(250),
			"x".repeat(9000),
			"",
		];
		for (const input of inputs) expect(R.sanitizeName(input)).toBe(sanitizeNativeName(input));
		expect([...R.sanitizeName(`evil‮${"n".repeat(300)}`)].length).toBe(200);
		expect(R.sanitizeName("a‮b")).toBe("ab");
	});
});

describe("computeChecksum parity (D3)", () => {
	test("same algorithm and trimEnd option as the server copy", async () => {
		const R = await mod();
		for (const s of ["", "abc", "abc\n\n", "  x  \n"]) {
			expect(await R.computeChecksum(s)).toBe(await serverChecksum(s));
			expect(await R.computeChecksum(s, { trimEnd: true })).toBe(
				await serverChecksum(s, { trimEnd: true }),
			);
		}
	});
});

type Sess = { sessionId: string; displayName: string; nameSource?: string };
const S = (displayName: string, nameSource?: string, sessionId = "s1"): Sess => ({
	sessionId,
	displayName,
	...(nameSource === undefined ? {} : { nameSource }),
});

async function plan(
	policy: Policy,
	sessions: Sess[],
	indexRows: Array<Record<string, string>>,
	ledgerRows: Array<Record<string, string>> = [],
	guard: Record<string, number[]> = {},
	now = T0,
) {
	const R = await mod();
	const ledger = R.parseLedger(jsonl(ledgerRows));
	const { latest } = R.parseCodexIndex(jsonl(indexRows), ledger);
	return R.planCodexPushes(sessions, latest, ledger, policy, guard, now);
}

describe("planCodexPushes (D23) — shared table run for each policy", () => {
	const codexTitle = row("s1", "codex-title");
	const dashOurs = row("s1", "dash-name", "2026-09-28T11:30:00.000Z");
	type Case = {
		name: string;
		session: Sess;
		index: Array<Record<string, string>>;
		ledger?: Array<Record<string, string>>;
		expected: Record<Policy, string[]>;
	};
	const cases: Case[] = [
		{
			name: "manual name over an existing Codex-written row",
			session: S("dash-name", "user"),
			index: [codexTitle],
			expected: { codex: ["dash-name"], agentpulse: ["dash-name"] },
		},
		{
			name: "generated name over an existing Codex-written row",
			session: S("brave-falcon", "generated"),
			index: [codexTitle],
			expected: { codex: [], agentpulse: ["brave-falcon"] },
		},
		{
			name: "generated name with no row for the id (fill rule)",
			session: S("brave-falcon", "generated"),
			index: [],
			expected: { codex: ["brave-falcon"], agentpulse: ["brave-falcon"] },
		},
		{
			name: "manual name equal to the latest row (no duplicate)",
			session: S("codex-title", "user"),
			index: [codexTitle],
			expected: { codex: [], agentpulse: [] },
		},
		{
			name: "nameSource absent (older server) is treated as generated",
			session: S("brave-falcon"),
			index: [codexTitle],
			expected: { codex: [], agentpulse: ["brave-falcon"] },
		},
		{
			name: "after reset, latest row is AgentPulse-written → restore",
			session: S("codex-title", "native"),
			index: [codexTitle, dashOurs],
			ledger: [dashOurs],
			expected: { codex: ["codex-title"], agentpulse: ["codex-title"] },
		},
		{
			name: "after reset, latest row is Codex-written → no row",
			session: S("codex-title", "native"),
			index: [dashOurs, row("s1", "codex-title", "2026-09-28T11:45:00.000Z")],
			ledger: [dashOurs],
			expected: { codex: [], agentpulse: [] },
		},
		{
			name: "native name over a different Codex-written row",
			session: S("old-native", "native"),
			index: [row("s1", "newer-codex")],
			expected: { codex: [], agentpulse: ["old-native"] },
		},
	];

	for (const policy of ["codex", "agentpulse"] as const) {
		for (const c of cases) {
			test(`[${policy}] ${c.name}`, async () => {
				const res = await plan(policy, [c.session], c.index, c.ledger);
				expect(res.rows.map((r) => r.thread_name)).toEqual(c.expected[policy]);
				for (const r of res.rows) {
					expect(r.id).toBe("s1");
					expect(r.updated_at).toBe(new Date(T0).toISOString());
				}
			});
		}

		test(`[${policy}] applying the planned rows, then re-planning → no row (idempotent)`, async () => {
			for (const c of cases) {
				const first = await plan(policy, [c.session], c.index, c.ledger);
				const index = [...c.index, ...first.rows];
				const ledger = [...(c.ledger ?? []), ...first.rows];
				const second = await plan(policy, [c.session], index, ledger, first.guard, T0 + 1000);
				expect(second.rows).toEqual([]);
			}
		});
	}

	test("the pushed value is sanitized (U+202E stripped) and capped at 200 code points", async () => {
		const raw = `bad‮${"n".repeat(300)}`;
		const res = await plan("codex", [S(raw, "user")], []);
		expect(res.rows).toHaveLength(1);
		const pushed = res.rows[0].thread_name;
		expect(pushed).toBe(sanitizeNativeName(raw));
		expect(pushed.includes("‮")).toBe(false);
		expect([...pushed].length).toBe(200);
	});

	test("a displayName that sanitizes to empty is never pushed", async () => {
		const res = await plan("agentpulse", [S("‮​", "user")], []);
		expect(res.rows).toEqual([]);
	});
});

describe("planCodexPushes — agentpulse policy (D8)", () => {
	test("re-push when Codex writes a newer title after our push", async () => {
		const codexTitle = row("s1", "codex-title");
		const first = await plan("agentpulse", [S("brave-falcon", "generated")], [codexTitle]);
		expect(first.rows.map((r) => r.thread_name)).toEqual(["brave-falcon"]);
		const later = row("s1", "codex-title-2", "2026-09-28T12:00:30.000Z");
		const second = await plan(
			"agentpulse",
			[S("brave-falcon", "generated")],
			[codexTitle, ...first.rows, later],
			first.rows,
			first.guard,
			T0 + 60_000,
		);
		expect(second.rows.map((r) => r.thread_name)).toEqual(["brave-falcon"]);
	});

	test("manual and native nameSource push identically", async () => {
		const idx = [row("s1", "codex-title")];
		const a = await plan("agentpulse", [S("dash", "user")], idx);
		const b = await plan("agentpulse", [S("dash", "native")], idx);
		expect(a.rows.map((r) => r.thread_name)).toEqual(["dash"]);
		expect(b.rows.map((r) => r.thread_name)).toEqual(["dash"]);
	});

	test("more than 200 sessions → at most 200 rows", async () => {
		const sessions = Array.from({ length: 250 }, (_, i) => S(`name-${i}`, "generated", `s${i}`));
		const res = await plan("agentpulse", sessions, []);
		expect(res.rows).toHaveLength(200);
	});
});

describe("storm guard (D23, F60)", () => {
	// Three re-pushes over Codex-written rows at T0, T0+1s, T0+2s, then a
	// fourth attempt at `at`: suppressed while the T0 push is < 1 h old.
	async function fourthAttempt(at: number, policy: Policy = "agentpulse") {
		const session = S(policy === "codex" ? "dash" : "brave-falcon", "user");
		let index: Array<Record<string, string>> = [];
		let ledger: Array<Record<string, string>> = [];
		let guard: Record<string, number[]> = {};
		for (let i = 0; i < 3; i++) {
			index = [...index, row("s1", `codex-title-${i}`, `2026-09-28T12:00:0${i}.500Z`)];
			const r = await plan(policy, [session], index, ledger, guard, T0 + i * 1000);
			expect(r.rows).toHaveLength(1);
			index = [...index, ...r.rows];
			ledger = [...ledger, ...r.rows];
			guard = r.guard;
		}
		index = [...index, row("s1", "codex-title-3", "2026-09-28T12:00:03.500Z")];
		return plan(policy, [session], index, ledger, guard, at);
	}

	test("a 4th re-push within 60 minutes → no row, id in suppressedIds", async () => {
		const res = await fourthAttempt(T0 + 3000);
		expect(res.rows).toEqual([]);
		expect(res.suppressedIds).toEqual(["s1"]);
	});

	test("+59:59.999 after the first push → still suppressed", async () => {
		const res = await fourthAttempt(T0 + HOUR - 1);
		expect(res.rows).toEqual([]);
		expect(res.suppressedIds).toEqual(["s1"]);
	});

	test("+60:00.001 after the first push → pushed again", async () => {
		const res = await fourthAttempt(T0 + HOUR + 1);
		expect(res.rows).toHaveLength(1);
		expect(res.suppressedIds).toEqual([]);
	});

	test("the guard also bounds codex-policy manual re-pushes", async () => {
		const res = await fourthAttempt(T0 + 3000, "codex");
		expect(res.rows).toEqual([]);
		expect(res.suppressedIds).toEqual(["s1"]);
	});

	test("fills and restores don't count toward the guard", async () => {
		const res = await plan("agentpulse", [S("brave-falcon", "generated")], []);
		expect(res.guard).toEqual({});
	});
});

type StubSession = {
	sessionId: string;
	displayName: string;
	nameSource?: string;
	agentType?: string;
};

function sessionsStub(
	sessions: StubSession[],
	onNativeName?: (id: string, name: string) => unknown,
) {
	return startStub((method, url, body) => {
		if (method === "GET" && url.pathname === "/api/v1/sessions") {
			const limit = Number(url.searchParams.get("limit") ?? 50);
			const offset = Number(url.searchParams.get("offset") ?? 0);
			return Response.json({
				sessions: sessions.slice(offset, offset + limit),
				total: sessions.length,
			});
		}
		const m = /^\/api\/v1\/sessions\/([^/]+)\/native-name$/.exec(url.pathname);
		if (method === "PUT" && m) {
			const id = decodeURIComponent(m[1]);
			const s = sessions.find((x) => x.sessionId === id);
			if (!s) return Response.json({ error: "Session not found" }, { status: 404 });
			const { name } = JSON.parse(body) as { name: string };
			const applied = s.nameSource !== "user";
			if (applied) {
				s.displayName = name;
				s.nameSource = "native";
			}
			onNativeName?.(id, name);
			return Response.json({ ok: true, applied });
		}
		return undefined;
	});
}

const nativeNamePuts = (reqs: Recorded[]) =>
	reqs
		.filter((r) => r.method === "PUT" && r.path.endsWith("/native-name"))
		.map((r) => (JSON.parse(r.body) as { name: string }).name);

describe("Codex pull via /native-name (D2) and the ledger (D23)", () => {
	test("a pull tick after a push sends no /native-name PUT for the pushed name", async () => {
		const R = await mod();
		const stub = sessionsStub([
			{ sessionId: "s1", displayName: "brave-falcon", nameSource: "generated" },
		]);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.pushCodexNames(ctx);
		expect((await readJsonl(indexPath())).map((r) => r.thread_name)).toEqual(["brave-falcon"]);
		await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toEqual([]);
		expect(stub.requests.some((r) => r.path.includes("/rename"))).toBe(false);
	});

	test("pinned + newer Codex row → pull PUTs it (applied:false), next push re-appends the manual name", async () => {
		const R = await mod();
		const sessions = [{ sessionId: "s1", displayName: "dash-name", nameSource: "user" }];
		const stub = sessionsStub(sessions);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.pushCodexNames(ctx);
		await writeFile(
			indexPath(),
			jsonl([
				...(await readJsonl(indexPath())),
				row("s1", "codex-renamed", "2026-09-28T12:30:00.000Z"),
			]),
		);
		await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toEqual(["codex-renamed"]);
		expect(sessions[0].displayName).toBe("dash-name");
		await R.pushCodexNames(ctx);
		const rows = await readJsonl(indexPath());
		expect(rows.at(-1)?.thread_name).toBe("dash-name");
		await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toEqual(["codex-renamed"]);
	});

	test("after the session flips to native, a newer Codex row is adopted and no push follows", async () => {
		const R = await mod();
		const sessions = [{ sessionId: "s1", displayName: "codex-title", nameSource: "native" }];
		const stub = sessionsStub(sessions);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await writeFile(
			indexPath(),
			jsonl([row("s1", "codex-title"), row("s1", "codex-new", "2026-09-28T12:40:00.000Z")]),
		);
		await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toEqual(["codex-new"]);
		expect(sessions[0].displayName).toBe("codex-new");
		const before = (await readJsonl(indexPath())).length;
		await R.pushCodexNames(ctx);
		expect((await readJsonl(indexPath())).length).toBe(before);
	});

	test("every pushed row lands in <stateDir>/codex-pushed.jsonl and survives re-creating relay state", async () => {
		const R = await mod();
		const stub = sessionsStub([
			{ sessionId: "s1", displayName: "one", nameSource: "generated" },
			{ sessionId: "s2", displayName: "two", nameSource: "user" },
		]);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.pushCodexNames(ctx);
		const ledger = await readJsonl(join(tmp, "state", "codex-pushed.jsonl"));
		expect(ledger.map((r) => r.thread_name).sort()).toEqual(["one", "two"]);
		expect(await readJsonl(indexPath())).toEqual(ledger);

		const fresh = await makeCtx({ remote: stub.url });
		expect(fresh.state).not.toBe(ctx.state);
		await R.pullCodexNames(fresh);
		expect(nativeNamePuts(stub.requests)).toEqual([]);
	});

	test("policy switch agentpulse → codex consults the same ledger and never PUTs its own pushes (F60)", async () => {
		const R = await mod();
		const sessions = [{ sessionId: "s1", displayName: "brave-falcon", nameSource: "generated" }];
		const stub = sessionsStub(sessions);
		stops.push(stub.stop);
		const ap = await makeCtx({ remote: stub.url, policy: "agentpulse" });
		await writeFile(indexPath(), jsonl([row("s1", "codex-title")]));
		await R.syncCodexNamesTick(ap);
		expect((await readJsonl(indexPath())).at(-1)?.thread_name).toBe("brave-falcon");
		expect(nativeNamePuts(stub.requests)).toEqual([]);

		const cx = await makeCtx({ remote: stub.url, policy: "codex" });
		await R.pullCodexNames(cx);
		expect(nativeNamePuts(stub.requests)).toEqual(["codex-title"]);
		expect(nativeNamePuts(stub.requests)).not.toContain("brave-falcon");
	});

	test("under agentpulse the pull makes zero /native-name requests", async () => {
		const R = await mod();
		const stub = sessionsStub([{ sessionId: "s1", displayName: "g", nameSource: "generated" }]);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, policy: "agentpulse" });
		await writeFile(
			indexPath(),
			jsonl([row("s1", "codex-title-newer", "2026-09-28T12:50:00.000Z")]),
		);
		await R.pullCodexNames(ctx);
		expect(stub.requests).toEqual([]);
	});
});

describe("404 backoff (F18)", () => {
	test("count-based: 6 ticks against a 404 give exactly 5 PUTs; a changed entry retries", async () => {
		const R = await mod();
		const stub = sessionsStub([]);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, now: () => T0 });
		await writeFile(indexPath(), jsonl([row("ghost", "name", "2026-09-28T11:59:00.000Z")]));
		for (let i = 0; i < 6; i++) await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toHaveLength(5);
		await writeFile(
			indexPath(),
			jsonl([
				row("ghost", "name", "2026-09-28T11:59:00.000Z"),
				row("ghost", "renamed", "2026-09-28T11:59:30.000Z"),
			]),
		);
		await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toHaveLength(6);
	});

	test("age-based: an entry older than 24h gets one attempt, then no retry", async () => {
		const R = await mod();
		const stub = sessionsStub([]);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, now: () => T0 });
		await writeFile(indexPath(), jsonl([row("old", "name", "2026-09-26T11:00:00.000Z")]));
		for (let i = 0; i < 6; i++) await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toHaveLength(1);
	});

	test("age alone doesn't suppress a first delivery to a known session", async () => {
		const R = await mod();
		const sessions = [{ sessionId: "old", displayName: "g", nameSource: "generated" }];
		const stub = sessionsStub(sessions);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, now: () => T0 });
		await writeFile(indexPath(), jsonl([row("old", "named-long-ago", "2026-09-20T11:00:00.000Z")]));
		await R.pullCodexNames(ctx);
		expect(sessions[0].displayName).toBe("named-long-ago");
	});

	test("a 400 (name sanitizes to empty) is final; a 500 is retried every tick", async () => {
		const R = await mod();
		let status = 400;
		const stub = startStub((method, url) =>
			method === "PUT" && url.pathname.endsWith("/native-name")
				? Response.json({ error: "x" }, { status })
				: undefined,
		);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, now: () => T0 });
		await writeFile(indexPath(), jsonl([row("e", "‮​", "2026-09-28T11:59:00.000Z")]));
		for (let i = 0; i < 3; i++) await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toHaveLength(1);

		status = 500;
		const fresh = await makeCtx({ remote: stub.url, now: () => T0 });
		for (let i = 0; i < 3; i++) {
			const res = await R.pullCodexNames(fresh);
			expect(res.ok).toBe(false);
		}
		expect(nativeNamePuts(stub.requests)).toHaveLength(4);
	});

	test("applied:false counts as seen — the same entry is not re-PUT", async () => {
		const R = await mod();
		const stub = sessionsStub([{ sessionId: "p", displayName: "pinned", nameSource: "user" }]);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, now: () => T0 });
		await writeFile(indexPath(), jsonl([row("p", "codex-name")]));
		for (let i = 0; i < 3; i++) await R.pullCodexNames(ctx);
		expect(nativeNamePuts(stub.requests)).toEqual(["codex-name"]);
	});
});

describe("paging the Codex session list (D23, F60)", () => {
	const gets = (reqs: Recorded[]) =>
		reqs.filter((r) => r.method === "GET" && r.path === "/api/v1/sessions");

	test("201 sessions → exactly 4 GETs of 50, the 201st excluded", async () => {
		const R = await mod();
		const sessions = Array.from({ length: 201 }, (_, i) => ({
			sessionId: `s${String(i).padStart(3, "0")}`,
			displayName: `n${i}`,
			nameSource: "generated",
		}));
		const stub = sessionsStub(sessions);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, policy: "agentpulse" });
		await R.pushCodexNames(ctx);
		const g = gets(stub.requests);
		expect(g).toHaveLength(4);
		expect(g.map((r) => new URLSearchParams(r.search).get("offset"))).toEqual([
			"0",
			"50",
			"100",
			"150",
		]);
		for (const r of g) {
			const q = new URLSearchParams(r.search);
			expect(q.get("agent_type")).toBe("codex_cli");
			expect(q.get("limit")).toBe("50");
		}
		const pushed = await readJsonl(indexPath());
		expect(pushed).toHaveLength(200);
		expect(pushed.some((r) => r.id === "s200")).toBe(false);
	});

	test("65 sessions → exactly 2 GETs, stopping at the short page", async () => {
		const R = await mod();
		const sessions = Array.from({ length: 65 }, (_, i) => ({
			sessionId: `s${i}`,
			displayName: `n${i}`,
			nameSource: "generated",
		}));
		const stub = sessionsStub(sessions);
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url, policy: "codex" });
		await R.pushCodexNames(ctx);
		expect(gets(stub.requests)).toHaveLength(2);
		expect(await readJsonl(indexPath())).toHaveLength(65);
	});
});

describe("scope check, status file, sync gating (D10, D17)", () => {
	function authStub(me: unknown, status = 200) {
		return startStub((_method, url) => {
			if (url.pathname === "/api/v1/auth/me") return Response.json(me, { status });
			if (url.pathname === "/api/v1/sessions") return Response.json({ sessions: [], total: 0 });
			return undefined;
		});
	}

	test("ingest-only key → auth.missing [observe], status file line, Codex + CLAUDE.md sync skipped", async () => {
		const R = await mod();
		const stub = authStub({ authenticated: true, user: { scopes: ["ingest"] } });
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.checkScopesTick(ctx);
		expect(ctx.state.auth.missing).toEqual(["observe"]);
		expect(ctx.state.auth.checkedAt).not.toBeNull();
		const status = await readFile(join(tmp, "state", "status"), "utf-8");
		expect(status).toBe("key lacks observe — re-run setup-relay\n");

		await writeFile(indexPath(), jsonl([row("s1", "codex-title")]));
		const before = stub.requests.length;
		await R.syncCodexNamesTick(ctx);
		await R.syncClaudeMdTick(ctx);
		expect(stub.requests.length).toBe(before);
		expect(ctx.state.sync.codexNames.status).toBe("disabled_missing_observe");
		expect(ctx.state.sync.claudeMd.status).toBe("disabled_missing_observe");
	});

	test("401 → key rejected line; a healthy key deletes the status file", async () => {
		const R = await mod();
		const bad = authStub({ error: "Unauthorized" }, 401);
		stops.push(bad.stop);
		const ctx = await makeCtx({ remote: bad.url });
		await R.checkScopesTick(ctx);
		expect(await readFile(join(tmp, "state", "status"), "utf-8")).toBe(
			"key rejected — re-run setup-relay\n",
		);
		const good = authStub({ authenticated: true, user: { scopes: ["ingest", "observe"] } });
		stops.push(good.stop);
		ctx.config.remoteUrl = good.url;
		await R.checkScopesTick(ctx);
		expect(await Bun.file(join(tmp, "state", "status")).exists()).toBe(false);
		expect(ctx.state.auth.missing).toEqual([]);
	});

	test("observe without manage → uploads skipped with upload_disabled_missing_manage", async () => {
		const R = await mod();
		const cwd = join(tmp, "proj");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "CLAUDE.md"), "# hi\n");
		const stub = startStub((_method, url) => {
			if (url.pathname === "/api/v1/auth/me")
				return Response.json({ authenticated: true, user: { scopes: ["ingest", "observe"] } });
			if (url.pathname === "/api/v1/sessions")
				return Response.json({ sessions: [{ sessionId: "c1", cwd }], total: 1 });
			return undefined;
		});
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.checkScopesTick(ctx);
		await R.syncClaudeMdTick(ctx);
		expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(ctx.state.sync.claudeMd.status).toBe("upload_disabled_missing_manage");
	});

	test("CLAUDE.md download is written only inside the session cwd (D11)", async () => {
		const R = await mod();
		const cwd = join(tmp, "proj");
		const outside = join(tmp, "elsewhere");
		await mkdir(cwd, { recursive: true });
		await mkdir(outside, { recursive: true });
		const stub = startStub((_method, url) => {
			if (url.pathname === "/api/v1/auth/me")
				return Response.json({ authenticated: true, user: { scopes: ["*"] } });
			if (url.pathname === "/api/v1/sessions")
				return Response.json({
					sessions: [
						{
							sessionId: "good",
							cwd,
							claudeMdPath: join(cwd, "CLAUDE.md"),
							claudeMdChecksum: "c1",
						},
						{
							sessionId: "bad",
							cwd,
							claudeMdPath: join(outside, "CLAUDE.md"),
							claudeMdChecksum: "c2",
						},
					],
					total: 2,
				});
			if (url.pathname === "/api/v1/sessions/good/claude-md")
				return Response.json({
					content: "server good\n",
					path: join(cwd, "CLAUDE.md"),
					checksum: "c1",
				});
			if (url.pathname === "/api/v1/sessions/bad/claude-md")
				return Response.json({
					content: "server bad\n",
					path: join(outside, "CLAUDE.md"),
					checksum: "c2",
				});
			return undefined;
		});
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.checkScopesTick(ctx);
		await R.syncClaudeMdTick(ctx);
		expect(await readFile(join(cwd, "CLAUDE.md"), "utf-8")).toBe("server good\n");
		expect(await Bun.file(join(outside, "CLAUDE.md")).exists()).toBe(false);
	});
});

describe("drift (D3)", () => {
	test("relay ok + installed statusline outdated → drift + status line", async () => {
		const R = await mod();
		const relayHash = await serverChecksum(await readFile(RELAY_PATH, "utf-8"), { trimEnd: true });
		const stub = startStub((_m, url) => {
			if (url.pathname === "/api/v1/health")
				return Response.json({
					status: "ok",
					clients: { relay: relayHash, statusline: "0000000000000000" },
				});
			if (url.pathname === "/api/v1/auth/me")
				return Response.json({ authenticated: true, user: { scopes: ["ingest", "observe"] } });
			return undefined;
		});
		stops.push(stub.stop);
		const home = join(tmp, "home");
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(join(home, ".claude", "statusline-agentpulse.sh"), "#!/bin/bash\necho old\n");
		const ctx = await makeCtx({ remote: stub.url });
		await R.checkScopesTick(ctx);
		await R.checkDriftTick(ctx);
		expect(ctx.state.relayHash).toBe(relayHash);
		expect(ctx.state.drift.relay).toBe("ok");
		expect(ctx.state.drift.statusline).toBe("outdated");
		expect(await readFile(join(tmp, "state", "status"), "utf-8")).toBe(
			"statusline outdated — re-run setup-relay\n",
		);
	});

	test("relay outdated; server without clients → unknown; no installed statusline → missing", async () => {
		const R = await mod();
		let clients: Record<string, string> | undefined = { relay: "ffffffffffffffff" };
		const stub = startStub((_m, url) => {
			if (url.pathname === "/api/v1/health")
				return Response.json({ status: "ok", ...(clients ? { clients } : {}) });
			return undefined;
		});
		stops.push(stub.stop);
		const ctx = await makeCtx({ remote: stub.url });
		await R.checkDriftTick(ctx);
		expect(ctx.state.drift.relay).toBe("outdated");
		expect(ctx.state.drift.statusline).toBe("missing");
		expect(await readFile(join(tmp, "state", "status"), "utf-8")).toBe(
			"relay outdated — re-run setup-relay\n",
		);
		clients = undefined;
		await R.checkDriftTick(ctx);
		expect(ctx.state.drift.relay).toBe("unknown");
	});
});

type SyncBlock = { status: string; lastError: unknown; lastSuccessAt: unknown };
type Diagnostics = {
	status: string;
	relay: boolean;
	remote: string;
	queue: Record<string, unknown>;
	auth: { scopes: unknown; missing: unknown; hasManage: unknown; checkedAt: unknown };
	sync: {
		codexNames: SyncBlock & { policy: string; suppressedIds: unknown };
		claudeMd: SyncBlock;
	};
	drift: { relay: unknown; statusline: unknown };
	relayHash: string;
	agents: unknown;
};

describe("the real port-0 relay server", () => {
	async function startAgainst(remote: string, policy: Policy = "codex") {
		const R = await mod();
		const stateDir = join(tmp, "state");
		await mkdir(stateDir, { recursive: true });
		const relay = await R.startRelay(
			{
				remoteUrl: remote,
				apiKey: "ap_test_key",
				port: 0,
				codexNamePolicy: policy,
				stateDir,
				configPath: null,
			},
			{ timers: false, env: { HOME: join(tmp, "home") }, scriptPath: RELAY_PATH, log: () => {} },
		);
		stops.push(() => relay.stop());
		return relay;
	}

	test("diagnostics: base keys and queue fields keep their names and types; new keys are additive (F34)", async () => {
		const stub = startStub(() => undefined);
		stops.push(stub.stop);
		const relay = await startAgainst(stub.url, "agentpulse");
		const res = await fetch(`http://127.0.0.1:${relay.port}/api/v1/relay/diagnostics`);
		expect(res.status).toBe(200);
		const d = (await res.json()) as Diagnostics;
		expect(d.status).toBe("ok");
		expect(d.relay).toBe(true);
		expect(d.remote).toBe(stub.url);
		const q = d.queue;
		expect(typeof q.pending).toBe("number");
		expect(typeof q.processing).toBe("number");
		for (const k of [
			"oldestPendingAt",
			"lastHookEnqueuedAt",
			"lastHookForwardedAt",
			"lastHookFailureAt",
			"lastHookError",
		]) {
			expect(k in q).toBe(true);
			expect(q[k] === null || typeof q[k] === "string").toBe(true);
		}
		expect(typeof q.consecutiveHookFailures).toBe("number");
		expect(Object.keys(q).sort()).toEqual(
			[
				"consecutiveHookFailures",
				"lastHookEnqueuedAt",
				"lastHookError",
				"lastHookFailureAt",
				"lastHookForwardedAt",
				"oldestPendingAt",
				"pending",
				"processing",
			].sort(),
		);
		expect(d.auth.scopes === null || Array.isArray(d.auth.scopes)).toBe(true);
		expect(Array.isArray(d.auth.missing)).toBe(true);
		expect(typeof d.auth.hasManage).toBe("boolean");
		expect(d.auth.checkedAt === null || typeof d.auth.checkedAt === "string").toBe(true);
		for (const k of ["codexNames", "claudeMd"] as const) {
			expect(typeof d.sync[k].status).toBe("string");
			expect("lastError" in d.sync[k]).toBe(true);
			expect("lastSuccessAt" in d.sync[k]).toBe(true);
		}
		expect(d.sync.codexNames.policy).toBe("agentpulse");
		expect(Array.isArray(d.sync.codexNames.suppressedIds)).toBe(true);
		expect(typeof d.drift.relay).toBe("string");
		expect(typeof d.drift.statusline).toBe("string");
		expect(d.relayHash).toMatch(/^[0-9a-f]{16}$/);
		expect(typeof d.agents).toBe("object");
	});

	test("/api/v1/health keeps {status, relay, remote} and appends warnings", async () => {
		const stub = startStub(() => undefined);
		stops.push(stub.stop);
		const relay = await startAgainst(stub.url);
		const res = await fetch(`http://127.0.0.1:${relay.port}/api/v1/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body.relay).toBe(true);
		expect(body.remote).toBe(stub.url);
		expect(Array.isArray(body.warnings)).toBe(true);
	});

	test("a no-Origin hook POST is accepted and tracked per agent; an Origin-bearing one is 403", async () => {
		const stub = startStub((_m, url) =>
			url.pathname === "/api/v1/hooks" ? Response.json({ ok: true }) : undefined,
		);
		stops.push(stub.stop);
		const relay = await startAgainst(stub.url);
		const base = `http://127.0.0.1:${relay.port}`;
		const ok = await fetch(`${base}/api/v1/hooks`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Agent-Type": "codex_cli" },
			body: JSON.stringify({ session_id: "x", hook_event_name: "Stop" }),
		});
		expect(ok.status).toBe(200);
		expect(relay.ctx.state.lastEventAtByAgent.codex_cli).toBeString();

		const bad = await fetch(`${base}/api/v1/sessions/x/prompt`, {
			method: "POST",
			headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
			body: "{}",
		});
		expect(bad.status).toBe(403);
		expect(((await bad.json()) as { error: string }).error).toBe("relay_rejects_browser_requests");
		expect(stub.requests.some((r) => r.path.includes("/prompt"))).toBe(false);

		const rebound = await relay.handler(
			new Request(`${base}/api/v1/sessions`, { headers: { host: `evil.example:${relay.port}` } }),
		);
		expect(rebound.status).toBe(403);
	});

	test("hook forwarding: 403 is retried (kept in queue), 400 is dropped", async () => {
		const R = await mod();
		let status = 403;
		const stub = startStub((_m, url) =>
			url.pathname === "/api/v1/hooks" ? Response.json({ error: "x" }, { status }) : undefined,
		);
		stops.push(stub.stop);
		const relay = await startAgainst(stub.url);
		const base = `http://127.0.0.1:${relay.port}`;
		const post = () =>
			fetch(`${base}/api/v1/hooks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ session_id: "q", hook_event_name: "Stop" }),
			});
		await post();
		await R.processHookQueue(relay.ctx);
		let q = await R.getQueueDiagnostics(relay.ctx);
		expect(q.pending).toBe(1);
		expect(q.consecutiveHookFailures).toBeGreaterThanOrEqual(1);
		expect(q.lastHookError).toContain("403");

		await rm(join(tmp, "state", "hook-queue"), { recursive: true, force: true });
		status = 400;
		await post();
		await R.processHookQueue(relay.ctx);
		q = await R.getQueueDiagnostics(relay.ctx);
		expect(q.pending).toBe(0);
		expect(q.processing).toBe(0);
		expect(q.lastHookError).toContain("400");
	});
});
