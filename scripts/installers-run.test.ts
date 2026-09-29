/**
 * Phase 4 (D10, D19, D22, D23, F29; contract Phase 4 items 4 and 6): the real
 * relay installer run as a subprocess against a temp HOME, with a real stub
 * `/auth/me` server and tiny PATH stubs for launchctl/systemctl/sleep/uname.
 *
 * The stubs come first on PATH so the real launchctl/systemctl are never
 * reached: a real `launchctl load` of dev.agentpulse.relay would replace the
 * developer's own running relay. The service tests assert the stub saw it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
// Before config.js: the test process shares one module registry, and config
// is read once, so the harness's env has to be in place first.
import "../src/server/db/__test_db.js";

const { config } = await import("../src/server/config.js");
const { setup } = await import("../src/server/routes/setup.js");

const INSTALLER = join(import.meta.dir, "setup-relay.sh");
const RELAY_SRC = join(import.meta.dir, "relay.ts");
const STATUSLINE_SRC = join(import.meta.dir, "statusline.sh");
const BUN_DIR = dirname(process.execPath);
const RUN_TIMEOUT = 60_000;

const INGEST_ONLY_KEY = "ap_testIngestOnlyKey";
const RELAY_KEY = "ap_testRelayKey";
const POLICY_LINE = (policy: string) =>
	`Codex names: ${policy} — pass --codex-names agentpulse|codex to change`;

let root: string;
let stubDir: string;
let authServer: ReturnType<typeof Bun.serve>;
let authUrl: string;
let seenAuthHeaders: string[] = [];
let homeCounter = 0;

function scopesFor(auth: string | null): Response {
	if (!auth) {
		return Response.json({ authenticated: false, user: null, disableAuth: false });
	}
	const key = auth.replace(/^Bearer /, "");
	const scopes =
		key === INGEST_ONLY_KEY ? ["ingest"] : key === RELAY_KEY ? ["ingest", "observe"] : null;
	if (!scopes) return Response.json({ error: "Invalid API key" }, { status: 401 });
	return Response.json({
		authenticated: true,
		user: { name: "test", source: "api_key", scopes },
		disableAuth: false,
	});
}

async function freePort() {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
}

async function newHome() {
	homeCounter += 1;
	const home = join(root, `home-${homeCounter}`);
	await mkdir(home, { recursive: true });
	return home;
}

async function listTree(dir: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(d: string) {
		for (const entry of await readdir(d, { withFileTypes: true })) {
			const p = join(d, entry.name);
			out.push(relative(dir, p));
			if (entry.isDirectory()) await walk(p);
		}
	}
	await walk(dir);
	return out.sort();
}

type RunResult = { code: number | null; out: string; stubLog: string };

async function runInstaller(
	home: string,
	args: string[],
	opts: { uname?: "Darwin" | "Linux"; script?: string } = {},
): Promise<RunResult> {
	const stubLog = join(home, "..", `stub-${relative(root, home)}.log`);
	await writeFile(stubLog, "");
	const tmp = join(root, `tmp-${relative(root, home)}`);
	await mkdir(tmp, { recursive: true });
	const proc = Bun.spawn(["bash", opts.script ?? INSTALLER, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${stubDir}:${BUN_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			HOME: home,
			TMPDIR: tmp,
			AP_STUB_LOG: stubLog,
			AP_TEST_UNAME: opts.uname ?? "Darwin",
		},
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: stdout + stderr, stubLog: await readFile(stubLog, "utf-8") };
}

async function readJson(path: string) {
	return JSON.parse(await readFile(path, "utf-8"));
}

async function modeOf(path: string) {
	return (await stat(path)).mode & 0o777;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ap-installers-run-"));
	stubDir = join(root, "stubs");
	await mkdir(stubDir);
	const stubs: Record<string, string> = {
		launchctl: 'echo "launchctl $*" >> "$AP_STUB_LOG"',
		systemctl: 'echo "systemctl $*" >> "$AP_STUB_LOG"',
		sleep: "exit 0",
		uname:
			'if [ $# -eq 0 ] || [ "$1" = "-s" ]; then echo "$AP_TEST_UNAME"; else exec /usr/bin/env -i PATH=/usr/bin:/bin uname "$@"; fi',
	};
	for (const [name, body] of Object.entries(stubs)) {
		const file = join(stubDir, name);
		await writeFile(file, `#!/bin/sh\n${body}\n`);
		await chmod(file, 0o755);
	}
	authServer = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/v1/auth/me") {
				const auth = req.headers.get("authorization");
				if (auth) seenAuthHeaders.push(auth);
				return scopesFor(auth);
			}
			return new Response("not found", { status: 404 });
		},
	});
	authUrl = `http://127.0.0.1:${authServer.port}`;
});

afterAll(async () => {
	authServer?.stop(true);
	await rm(root, { recursive: true, force: true });
});

describe("D10 preflight — refuse before writing anything", () => {
	test(
		"an ingest-only key exits non-zero, names the Observe checkbox, and writes nothing",
		async () => {
			const home = await newHome();
			seenAuthHeaders = [];
			const port = await freePort();
			const res = await runInstaller(home, [
				"--url",
				authUrl,
				"--key",
				INGEST_ONLY_KEY,
				"--port",
				String(port),
			]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("Observe (read-only)");
			expect(res.out).toContain("Hook ingest");
			expect(res.out).toContain("Settings → API Keys");
			expect(res.out).toContain("--allow-missing-observe");
			expect(res.out).not.toContain(INGEST_ONLY_KEY);
			expect(seenAuthHeaders).toEqual([`Bearer ${INGEST_ONLY_KEY}`]);
			expect(await listTree(home)).toEqual([]);
			expect(res.stubLog).toBe("");
		},
		RUN_TIMEOUT,
	);

	test(
		"a key the server rejects exits non-zero and writes nothing",
		async () => {
			const home = await newHome();
			const res = await runInstaller(home, ["--url", authUrl, "--key", "ap_unknownKey"]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("rejected");
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);

	test(
		"--codex-names with an unknown value exits non-zero and writes nothing",
		async () => {
			const home = await newHome();
			const res = await runInstaller(home, [
				"--url",
				authUrl,
				"--key",
				RELAY_KEY,
				"--codex-names",
				"bogus",
			]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("--codex-names");
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);

	test(
		"--allow-missing-observe installs with an ingest-only key and warns",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const res = await runInstaller(home, [
				"--url",
				authUrl,
				"--key",
				INGEST_ONLY_KEY,
				"--port",
				String(port),
				"--allow-missing-observe",
			]);
			expect(res.code).toBe(0);
			expect(res.out).toContain("Observe (read-only)");
			expect(await readFile(join(home, ".agentpulse", "relay.ts"), "utf-8")).toBe(
				await readFile(RELAY_SRC, "utf-8"),
			);
		},
		RUN_TIMEOUT,
	);
});

describe("an ingest+observe key installs the relay, statusline and service", () => {
	test(
		"macOS: exact relay.ts, private config, plist with no key, statusline, codex-hook.sh removed, installed.json",
		async () => {
			const home = await newHome();
			const port = await freePort();
			await mkdir(join(home, ".agentpulse"), { recursive: true });
			await writeFile(join(home, ".agentpulse", "codex-hook.sh"), "#!/bin/sh\n");

			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin" },
			);
			expect(res.code).toBe(0);

			const relayDir = join(home, ".agentpulse");
			expect(await readFile(join(relayDir, "relay.ts"))).toEqual(await readFile(RELAY_SRC));
			expect(await modeOf(relayDir)).toBe(0o700);

			const configFile = join(relayDir, "config.json");
			expect(await modeOf(configFile)).toBe(0o600);
			expect(await readJson(configFile)).toEqual({
				remote_url: authUrl,
				api_key: RELAY_KEY,
				port,
				codex_name_policy: "codex",
			});

			const plist = await readFile(
				join(home, "Library", "LaunchAgents", "dev.agentpulse.relay.plist"),
				"utf-8",
			);
			expect(plist).toContain("<string>--config</string>");
			expect(plist).toContain(`<string>${configFile}</string>`);
			expect(plist).not.toContain("ap_");
			expect(res.stubLog).toContain("launchctl load");

			const statusline = join(home, ".claude", "statusline-agentpulse.sh");
			expect(await readFile(statusline)).toEqual(await readFile(STATUSLINE_SRC));
			expect((await modeOf(statusline)) & 0o100).toBe(0o100);
			const settings = await readJson(join(home, ".claude", "settings.json"));
			expect(settings.statusLine).toEqual({
				type: "command",
				command: `AGENTPULSE_PORT=${port} ~/.claude/statusline-agentpulse.sh`,
			});
			expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);

			await expect(stat(join(relayDir, "codex-hook.sh"))).rejects.toThrow();
			expect(res.out).toContain("Removed obsolete ~/.agentpulse/codex-hook.sh");

			const installed = await readJson(join(relayDir, "installed.json"));
			expect(typeof installed.codexHooksWrittenAt).toBe("string");
			expect(Number.isNaN(Date.parse(installed.codexHooksWrittenAt))).toBe(false);
			expect(installed.copilotHooksWrittenAt).toBeNull();
			expect(await modeOf(join(relayDir, "installed.json"))).toBe(0o600);

			expect(res.out).toContain(POLICY_LINE("codex"));
			expect(res.out).not.toContain(RELAY_KEY);
		},
		RUN_TIMEOUT,
	);

	test(
		"Linux: a systemd user unit that starts the relay with --config and no key",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Linux" },
			);
			expect(res.code).toBe(0);
			const unit = await readFile(
				join(home, ".config", "systemd", "user", "agentpulse-relay.service"),
				"utf-8",
			);
			expect(unit).toContain(`--config "${join(home, ".agentpulse", "config.json")}"`);
			expect(unit).not.toContain("ap_");
			expect(res.stubLog).toContain("systemctl --user daemon-reload");
			expect(res.stubLog).toContain("systemctl --user enable agentpulse-relay");
			expect(res.stubLog).not.toContain("launchctl");
			expect(await readFile(join(home, ".agentpulse", "relay.ts"))).toEqual(
				await readFile(RELAY_SRC),
			);
		},
		RUN_TIMEOUT,
	);

	test(
		"the default port gets the plain statusLine command",
		async () => {
			const home = await newHome();
			const res = await runInstaller(home, ["--url", authUrl, "--key", RELAY_KEY], {
				uname: "Linux",
			});
			expect(res.code).toBe(0);
			const settings = await readJson(join(home, ".claude", "settings.json"));
			expect(settings.statusLine).toEqual({
				type: "command",
				command: "~/.claude/statusline-agentpulse.sh",
			});
		},
		RUN_TIMEOUT,
	);

	test(
		"an existing different statusLine is left alone and the opt-in line is printed",
		async () => {
			const home = await newHome();
			const port = await freePort();
			await mkdir(join(home, ".claude"), { recursive: true });
			const mine = { type: "command", command: "~/bin/my-statusline.sh" };
			await writeFile(
				join(home, ".claude", "settings.json"),
				JSON.stringify({ statusLine: mine, model: "opus" }),
			);
			const res = await runInstaller(home, [
				"--url",
				authUrl,
				"--key",
				RELAY_KEY,
				"--port",
				String(port),
			]);
			expect(res.code).toBe(0);
			const settings = await readJson(join(home, ".claude", "settings.json"));
			expect(settings.statusLine).toEqual(mine);
			expect(settings.model).toBe("opus");
			expect(res.out).toContain("already has a statusLine");
			expect(res.out).toContain(
				`"statusLine": {"type": "command", "command": "AGENTPULSE_PORT=${port} ~/.claude/statusline-agentpulse.sh"}`,
			);
			// The file itself is still installed, ready for the opt-in.
			expect(await readFile(join(home, ".claude", "statusline-agentpulse.sh"))).toEqual(
				await readFile(STATUSLINE_SRC),
			);
		},
		RUN_TIMEOUT,
	);

	test(
		"the body served by /setup-relay.sh installs the same bytes with no checkout beside it",
		async () => {
			const saved = { publicUrl: config.publicUrl, explicit: config.publicUrlExplicit };
			config.publicUrl = authUrl;
			config.publicUrlExplicit = true;
			let body: string;
			try {
				const res = await setup.request("/setup-relay.sh", {
					headers: { Host: "attacker.example" },
				});
				expect(res.status).toBe(200);
				body = await res.text();
			} finally {
				config.publicUrl = saved.publicUrl;
				config.publicUrlExplicit = saved.explicit;
			}
			const lonely = join(root, `served-${homeCounter}`);
			await mkdir(lonely, { recursive: true });
			const script = join(lonely, "setup-relay.sh");
			await writeFile(script, body);

			const home = await newHome();
			const port = await freePort();
			const res = await runInstaller(home, ["--key", RELAY_KEY, "--port", String(port)], {
				script,
				uname: "Linux",
			});
			expect(res.code).toBe(0);
			expect(await readFile(join(home, ".agentpulse", "relay.ts"))).toEqual(
				await readFile(RELAY_SRC),
			);
			expect(await readFile(join(home, ".claude", "statusline-agentpulse.sh"))).toEqual(
				await readFile(STATUSLINE_SRC),
			);
			expect((await readJson(join(home, ".agentpulse", "config.json"))).remote_url).toBe(authUrl);
		},
		RUN_TIMEOUT,
	);
});

describe("--codex-names round-trip (contract Phase 4 item 6, parsed config.json)", () => {
	test(
		"agentpulse is written, survives a re-run without the flag, and a fresh install defaults to codex",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const base = ["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)];
			const configFile = join(home, ".agentpulse", "config.json");

			const first = await runInstaller(home, [...base, "--codex-names", "agentpulse"]);
			expect(first.code).toBe(0);
			expect((await readJson(configFile)).codex_name_policy).toBe("agentpulse");
			expect(first.out).toContain(POLICY_LINE("agentpulse"));

			const rerun = await runInstaller(home, base);
			expect(rerun.code).toBe(0);
			expect((await readJson(configFile)).codex_name_policy).toBe("agentpulse");
			expect(rerun.out).toContain(POLICY_LINE("agentpulse"));

			const switched = await runInstaller(home, [...base, "--codex-names", "codex"]);
			expect(switched.code).toBe(0);
			expect((await readJson(configFile)).codex_name_policy).toBe("codex");
			expect(switched.out).toContain(POLICY_LINE("codex"));

			const freshHome = await newHome();
			const fresh = await runInstaller(freshHome, base);
			expect(fresh.code).toBe(0);
			expect(
				(await readJson(join(freshHome, ".agentpulse", "config.json"))).codex_name_policy,
			).toBe("codex");
			expect(fresh.out).toContain(POLICY_LINE("codex"));
		},
		RUN_TIMEOUT * 2,
	);
});
