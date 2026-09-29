/**
 * Phase 3 (F2, F51, D2, D10, D17, D23): the real app on port 0 with a temp
 * SQLite DB and auth on, the real relay as a subprocess (`--config` in a temp
 * dir, `HOME=<tmp>`), and the real statusline as a subprocess. Scenarios run
 * in order and share one server; each relay gets its own temp HOME + state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/server/db/__test_db.js";

const { config } = await import("../src/server/config.js");
const { initializeDatabase } = await import("../src/server/db/client.js");
const { app } = await import("../src/server/app.js");
const { createApiKey } = await import("../src/server/auth/api-key.js");
const { getSession } = await import("../src/server/services/session-tracker.js");
const { _resetDbReadyForTest } = await import("../src/server/routes/health.js");

const RELAY = join(import.meta.dir, "relay.ts");
const STATUSLINE = join(import.meta.dir, "statusline.sh");
const WORKTREE = join(import.meta.dir, "..");
const SCENARIO_TIMEOUT = 30_000;

type RelayProc = {
	proc: ReturnType<typeof Bun.spawn>;
	port: number;
	base: string;
	dir: string;
	home: string;
	output: () => string;
};

let root: string;
let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;
let manageKey: string;
let relayKey: string;
let gitStatusBefore: string;
let scriptsBefore: string[];
const running: RelayProc[] = [];
const originalDisableAuth = config.disableAuth;

async function gitStatus() {
	const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: WORKTREE, stdout: "pipe" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

async function waitFor<T>(
	label: string,
	probe: () => Promise<T | undefined | null | false>,
	timeoutMs = 12_000,
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
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${label} (last: ${String(last)})`);
}

async function spawnRelay(
	name: string,
	key: string,
	opts: {
		policy?: "agentpulse" | "codex";
		extraArgs?: string[];
		reuse?: boolean;
		/** Put config.json (and so the state dir) at <home>/.agentpulse, the installer default. */
		configInHome?: boolean;
	} = {},
): Promise<RelayProc> {
	const home = join(root, name, "home");
	const dir = opts.configInHome ? join(home, ".agentpulse") : join(root, name);
	if (!opts.reuse) {
		await mkdir(join(home, ".codex"), { recursive: true });
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "config.json"),
			JSON.stringify({
				remote_url: serverUrl,
				api_key: key,
				port: 0,
				...(opts.policy ? { codex_name_policy: opts.policy } : {}),
			}),
			{ mode: 0o600 },
		);
	}
	const proc = Bun.spawn(
		// `--port 0` in argv as well as the config: a relay that ignored --config
		// (the pre-Phase-3 one did) must never fall back to the default 4000,
		// which is where a developer's real relay listens.
		[
			process.execPath,
			RELAY,
			"--config",
			join(dir, "config.json"),
			"--port",
			"0",
			...(opts.extraArgs ?? []),
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: process.env.TMPDIR ?? "/tmp",
				HOME: home,
				AGENTPULSE_RELAY_SYNC_MS: "200",
			},
		},
	);
	let buf = "";
	const decoder = new TextDecoder();
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) buf += decoder.decode(chunk);
	};
	void pump(proc.stdout as ReadableStream<Uint8Array>);
	void pump(proc.stderr as ReadableStream<Uint8Array>);
	const port = await waitFor(
		`${name} banner`,
		async () => {
			const m = /Local:\s+http:\/\/localhost:(\d+)/.exec(buf);
			const n = m ? Number(m[1]) : 0;
			return n > 0 ? n : undefined;
		},
		10_000,
	).catch((err) => {
		proc.kill();
		throw new Error(`${String(err)}\n--- relay output ---\n${buf}`);
	});
	const relay: RelayProc = {
		proc,
		port,
		base: `http://127.0.0.1:${port}`,
		dir,
		home,
		output: () => buf,
	};
	running.push(relay);
	return relay;
}

async function stopRelay(relay: RelayProc) {
	relay.proc.kill();
	await relay.proc.exited;
	const i = running.indexOf(relay);
	if (i >= 0) running.splice(i, 1);
}

async function postHook(relay: RelayProc, agentType: string, payload: Record<string, unknown>) {
	const res = await fetch(`${relay.base}/api/v1/hooks`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Agent-Type": agentType },
		body: JSON.stringify(payload),
	});
	expect(res.status).toBe(200);
}

async function runStatusline(
	relay: RelayProc,
	input: Record<string, unknown>,
	opts: { homeOnly?: boolean } = {},
) {
	const proc = Bun.spawn(["bash", STATUSLINE], {
		stdin: new TextEncoder().encode(JSON.stringify(input)),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: relay.home,
			AGENTPULSE_PORT: String(relay.port),
			...(opts.homeOnly ? {} : { AGENTPULSE_DIR: relay.dir }),
		},
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

async function manage(path: string, body: unknown) {
	const res = await fetch(`${serverUrl}${path}`, {
		method: "PUT",
		headers: { Authorization: `Bearer ${manageKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
}

async function indexRows(relay: RelayProc, id: string) {
	let raw = "";
	try {
		raw = await readFile(join(relay.home, ".codex", "session_index.jsonl"), "utf-8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as { id: string; thread_name: string; updated_at: string })
		.filter((r) => r.id === id);
}

async function ledgerRows(relay: RelayProc, id: string) {
	let raw = "";
	try {
		raw = await readFile(join(relay.dir, "codex-pushed.jsonl"), "utf-8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as { id: string; thread_name: string; updated_at: string })
		.filter((r) => r.id === id);
}

async function appendCodexRow(relay: RelayProc, id: string, thread_name: string) {
	const line = JSON.stringify({ id, thread_name, updated_at: new Date().toISOString() });
	await appendFile(join(relay.home, ".codex", "session_index.jsonl"), `${line}\n`);
}

async function sessionNamed(id: string, name: string) {
	const s = await getSession(id);
	return s?.displayName === name ? s : undefined;
}

const CLAUDE_ID = "e2e-claude-0001";
const STRANGER_ID = "e2e-stranger-0001";
const CODEX3_ID = "019a0000-0000-7000-8000-000000000003";
const CODEX6_ID = "019a0000-0000-7000-8000-000000000006";
const CODEX7_ID = "019a0000-0000-7000-8000-000000000007";

let relay1: RelayProc;

beforeAll(async () => {
	gitStatusBefore = await gitStatus();
	scriptsBefore = (await readdir(join(WORKTREE, "scripts"))).sort();
	root = await mkdtemp(join(tmpdir(), "ap-relay-e2e-"));
	await initializeDatabase();
	_resetDbReadyForTest(true);
	config.disableAuth = false;
	server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
	serverUrl = `http://127.0.0.1:${server.port}`;
	manageKey = (await createApiKey("e2e-manage", ["manage"])).key;
	relayKey = (await createApiKey("e2e-relay", ["ingest", "observe"])).key;
});

afterAll(async () => {
	for (const r of [...running]) await stopRelay(r);
	server?.stop(true);
	config.disableAuth = originalDisableAuth;
	if (root) await rm(root, { recursive: true, force: true });
});

describe("relay e2e", () => {
	test(
		"1. Claude SessionStart through the relay creates the session",
		async () => {
			relay1 = await spawnRelay("relay1", relayKey);
			await postHook(relay1, "claude_code", {
				session_id: CLAUDE_ID,
				hook_event_name: "SessionStart",
				cwd: join(root, "claude-proj"),
				source: "startup",
			});
			const s = await waitFor("claude session", () => getSession(CLAUDE_ID));
			expect(s.agentType).toBe("claude_code");
			// F113: real drift check against the real server's /health clients.
			const drift = await waitFor("drift checked", async () => {
				const res = await fetch(`${relay1.base}/api/v1/relay/diagnostics`);
				const d = (await res.json()) as { drift: { relay: string } };
				return d.drift.relay !== "unknown" ? d.drift : undefined;
			});
			expect(drift.relay).toBe("ok");
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"1b. CLAUDE.md download round-trip for a forwarded session; a server-only session is never written (F113, F106)",
		async () => {
			const cwd = join(root, "claude-proj");
			await mkdir(cwd, { recursive: true });
			const content = "# from the server\n\nline two — é\n";
			await manage(`/api/v1/sessions/${CLAUDE_ID}/claude-md`, {
				content,
				path: join(cwd, "CLAUDE.md"),
			});
			await waitFor("CLAUDE.md written", async () => {
				const f = Bun.file(join(cwd, "CLAUDE.md"));
				return (await f.exists()) && (await f.text()) === content;
			});

			const strangerCwd = join(root, "stranger-proj");
			await mkdir(strangerCwd, { recursive: true });
			const direct = await fetch(`${serverUrl}/api/v1/hooks`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${relayKey}`,
					"Content-Type": "application/json",
					"X-Agent-Type": "claude_code",
				},
				body: JSON.stringify({
					session_id: STRANGER_ID,
					hook_event_name: "SessionStart",
					cwd: strangerCwd,
				}),
			});
			expect(direct.status).toBe(200);
			await waitFor("stranger session", () => getSession(STRANGER_ID));
			await manage(`/api/v1/sessions/${STRANGER_ID}/claude-md`, {
				content: "# should never land\n",
				path: join(strangerCwd, "CLAUDE.md"),
			});
			await Bun.sleep(1200);
			expect(await Bun.file(join(strangerCwd, "CLAUDE.md")).exists()).toBe(false);
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"2. statusline pushes the native name through the relay",
		async () => {
			await runStatusline(relay1, { session_id: CLAUDE_ID, session_name: "e2e-claude" });
			await waitFor("claude displayName", () => sessionNamed(CLAUDE_ID, "e2e-claude"));
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"3. a Codex session_index.jsonl name lands via /native-name",
		async () => {
			await postHook(relay1, "codex_cli", {
				session_id: CODEX3_ID,
				hook_event_name: "SessionStart",
				cwd: join(root, "codex-proj"),
				model: "gpt-test",
			});
			await waitFor("codex session", () => getSession(CODEX3_ID));
			await appendCodexRow(relay1, CODEX3_ID, "e2e-codex");
			const s = await waitFor("codex displayName", () => sessionNamed(CODEX3_ID, "e2e-codex"));
			expect(s.nameSource).toBe("native");
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"4. a manual pin survives a later statusline push",
		async () => {
			await manage(`/api/v1/sessions/${CLAUDE_ID}/rename`, {
				name: "pinned-by-user",
				source: "user",
			});
			await runStatusline(relay1, { session_id: CLAUDE_ID, session_name: "after-pin" });
			const s = await waitFor("nativeName recorded", async () => {
				const x = await getSession(CLAUDE_ID);
				return x?.nativeName === "after-pin" ? x : undefined;
			});
			expect(s.displayName).toBe("pinned-by-user");
			expect(s.nameSource).toBe("user");
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"5. an ingest-only key reports auth.missing [observe] and writes the status file",
		async () => {
			const ingestOnly = (await createApiKey("e2e-ingest-only", ["ingest"])).key;
			const relay5 = await spawnRelay("relay5", ingestOnly);
			const diag = await waitFor("auth checked", async () => {
				const res = await fetch(`${relay5.base}/api/v1/relay/diagnostics`);
				const d = (await res.json()) as { auth: { checkedAt: string | null; missing: string[] } };
				return d.auth.checkedAt ? d : undefined;
			});
			expect(diag.auth.missing).toEqual(["observe"]);
			const status = await waitFor("status file", async () => {
				const f = Bun.file(join(relay5.dir, "status"));
				return (await f.exists()) ? f.text() : undefined;
			});
			expect(status).toBe("key lacks observe — re-run setup-relay\n");
			// F117: the statusline the user sees carries the relay's hint.
			const hint = " · agentpulse: key lacks observe — re-run setup-relay";
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
			const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
			expect(plain(await runStatusline(relay5, { session_id: CLAUDE_ID })).endsWith(hint)).toBe(
				true,
			);
			await stopRelay(relay5);

			// F117/F126: with the installer's default layout (config at
			// ~/.agentpulse/config.json) the statusline needs nothing but HOME.
			const relay5b = await spawnRelay("relay5b", ingestOnly, { configInHome: true });
			await waitFor("status file (default layout)", () =>
				Bun.file(join(relay5b.home, ".agentpulse", "status")).exists(),
			);
			const line = await runStatusline(relay5b, { session_id: CLAUDE_ID }, { homeOnly: true });
			expect(plain(line).endsWith(hint)).toBe(true);
			await stopRelay(relay5b);
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"6. codex policy: a manual rename is pushed into Codex once, and reset restores Codex's name",
		async () => {
			await postHook(relay1, "codex_cli", {
				session_id: CODEX6_ID,
				hook_event_name: "SessionStart",
				cwd: join(root, "codex6"),
			});
			await waitFor("codex6 session", () => getSession(CODEX6_ID));
			await appendCodexRow(relay1, CODEX6_ID, "codex-title");
			await waitFor("codex-title adopted", () => sessionNamed(CODEX6_ID, "codex-title"));

			await manage(`/api/v1/sessions/${CODEX6_ID}/rename`, { name: "dash-name", source: "user" });
			await waitFor("dash-name pushed", async () => {
				const rows = await indexRows(relay1, CODEX6_ID);
				return rows.at(-1)?.thread_name === "dash-name";
			});
			expect((await ledgerRows(relay1, CODEX6_ID)).some((r) => r.thread_name === "dash-name")).toBe(
				true,
			);
			await Bun.sleep(900);
			expect(
				(await indexRows(relay1, CODEX6_ID)).filter((r) => r.thread_name === "dash-name"),
			).toHaveLength(1);

			await manage(`/api/v1/sessions/${CODEX6_ID}/rename`, { source: "reset" });
			await waitFor("reset to codex-title", () => sessionNamed(CODEX6_ID, "codex-title"));
			await waitFor("restore row", async () => {
				const rows = await indexRows(relay1, CODEX6_ID);
				const last = rows.at(-1);
				if (last?.thread_name !== "codex-title") return false;
				const ledger = await ledgerRows(relay1, CODEX6_ID);
				return ledger.some(
					(r) => r.thread_name === "codex-title" && r.updated_at === last.updated_at,
				);
			});
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"7. agentpulse policy: the dashboard name wins in Codex and nothing is pulled; switching to codex consults the ledger",
		async () => {
			const key7 = (await createApiKey("e2e-relay7", ["ingest", "observe"])).key;
			const relay7 = await spawnRelay("relay7", key7, { policy: "agentpulse" });
			await postHook(relay7, "codex_cli", {
				session_id: CODEX7_ID,
				hook_event_name: "SessionStart",
				cwd: join(root, "codex7"),
			});
			const created = await waitFor("codex7 session", () => getSession(CODEX7_ID));
			const generated = created.displayName;
			expect(generated).toBeTruthy();

			const lastIsGeneratedAfter = (marker: string) => async () => {
				const rows = await indexRows(relay7, CODEX7_ID);
				const markerAt = rows.map((r) => r.thread_name).lastIndexOf(marker);
				return (
					markerAt >= 0 && rows.length - 1 > markerAt && rows.at(-1)?.thread_name === generated
				);
			};
			await appendCodexRow(relay7, CODEX7_ID, "codex-title");
			await waitFor("generated re-pushed over codex-title", lastIsGeneratedAfter("codex-title"));
			const last = (await indexRows(relay7, CODEX7_ID)).at(-1);
			expect(
				(await ledgerRows(relay7, CODEX7_ID)).some(
					(r) => r.thread_name === generated && r.updated_at === last?.updated_at,
				),
			).toBe(true);

			await appendCodexRow(relay7, CODEX7_ID, "codex-title-2");
			await waitFor(
				"generated re-pushed over codex-title-2",
				lastIsGeneratedAfter("codex-title-2"),
			);
			await Bun.sleep(600);
			const s = await getSession(CODEX7_ID);
			expect(s?.displayName).toBe(generated);
			expect(s?.nativeName).toBeNull();

			await stopRelay(relay7);
			const relay7b = await spawnRelay("relay7", key7, {
				reuse: true,
				extraArgs: ["--codex-name-policy", "codex"],
			});
			const adopted = await waitFor("codex-title-2 adopted", async () => {
				const x = await getSession(CODEX7_ID);
				return x?.nativeName ? x : undefined;
			});
			expect(adopted.nativeName).toBe("codex-title-2");
			expect(adopted.displayName).toBe("codex-title-2");
			await stopRelay(relay7b);
		},
		SCENARIO_TIMEOUT,
	);

	test(
		"no cross-contamination between the Claude and Codex rows; the worktree is untouched (F51)",
		async () => {
			const claude = await getSession(CLAUDE_ID);
			expect(claude?.agentType).toBe("claude_code");
			expect(claude?.displayName).toBe("pinned-by-user");
			expect(claude?.nativeName).toBe("after-pin");
			const codex = await getSession(CODEX3_ID);
			expect(codex?.agentType).toBe("codex_cli");
			expect(codex?.displayName).toBe("e2e-codex");
			expect(codex?.nativeName).toBe("e2e-codex");

			for (const r of [...running]) await stopRelay(r);
			expect(await gitStatus()).toBe(gitStatusBefore);
			expect((await readdir(join(WORKTREE, "scripts"))).sort()).toEqual(scriptsBefore);
		},
		SCENARIO_TIMEOUT,
	);
});
