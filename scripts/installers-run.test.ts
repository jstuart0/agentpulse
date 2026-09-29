/**
 * Phase 4 (D10, D19, D22, D23, F29; contract Phase 4 items 4 and 6): the real
 * relay installer run as a subprocess against a temp HOME, with a real stub
 * `/auth/me` server and tiny PATH stubs for launchctl/systemctl/sleep/uname.
 *
 * The stubs come first on PATH so the real launchctl/systemctl are never
 * reached: a real `launchctl load` of dev.agentpulse.relay would replace the
 * developer's own running relay. The service tests assert the stub saw it.
 * A curl stub refuses anything aimed at the default relay port, :4000 (F186),
 * and any Bun download (F190), so no test fetches Bun from the network.
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
const { buildCodexHooksFile } = await import("../src/shared/hook-command.js");

const INSTALLER = join(import.meta.dir, "setup-relay.sh");
const RELAY_SRC = join(import.meta.dir, "relay.ts");
const STATUSLINE_SRC = join(import.meta.dir, "statusline.sh");
const BUN_DIR = dirname(process.execPath);
const RUN_TIMEOUT = 60_000;

const INGEST_ONLY_KEY = "ap_testIngestOnlyKey";
const RELAY_KEY = "ap_testRelayKey";
/** Authenticated per HTTP status, but the body says neither authenticated nor scopes. */
const ODD_KEY = "ap_testNoAuthFlagKey";
const KEY_PROMPT = "API key (Hook ingest + Observe)";
const POLICY_LINE = (policy: string) =>
	`Codex names: ${policy} — pass --codex-names agentpulse|codex to change`;

let root: string;
let stubDir: string;
let authServer: ReturnType<typeof Bun.serve>;
let authUrl: string;
let openServer: ReturnType<typeof Bun.serve>;
let openUrl: string;
let servedBody: string | null = null;
let seenAuthHeaders: string[] = [];
let homeCounter = 0;

function scopesFor(auth: string | null): Response {
	if (!auth) {
		return Response.json({ authenticated: false, user: null, disableAuth: false });
	}
	const key = auth.replace(/^Bearer /, "");
	if (key === ODD_KEY) return Response.json({ user: { name: "test" } });
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
	opts: {
		uname?: "Darwin" | "Linux";
		script?: string;
		env?: Record<string, string>;
		/** Run as `curl -sS <url> | bash -s -- <args>`, the way users do. */
		pipeFrom?: string;
		/** Directories searched before the stubs and the real Bun. */
		pathPrefix?: string;
	} = {},
): Promise<RunResult> {
	const stubLog = join(home, "..", `stub-${relative(root, home)}.log`);
	await writeFile(stubLog, "");
	const tmp = join(root, `tmp-${relative(root, home)}`);
	await mkdir(tmp, { recursive: true });
	const cmd = opts.pipeFrom
		? ["bash", "-c", 'curl -sS "$AP_PIPE_URL" | bash -s -- "$@"', "installer", ...args]
		: ["bash", opts.script ?? INSTALLER, ...args];
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${opts.pathPrefix ? `${opts.pathPrefix}:` : ""}${stubDir}:${BUN_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			HOME: home,
			TMPDIR: tmp,
			AP_STUB_LOG: stubLog,
			AP_TEST_UNAME: opts.uname ?? "Darwin",
			// Never the developer's terminal: a prompt would hang the test.
			AGENTPULSE_TTY: join(root, "no-tty"),
			...(opts.pipeFrom ? { AP_PIPE_URL: opts.pipeFrom } : {}),
			...opts.env,
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
	const realCurl = Bun.which("curl");
	if (!realCurl) throw new Error("curl isn't on PATH");
	const stubs: Record<string, string> = {
		// F186: the default relay port is the developer's own live relay, so any
		// request to it is refused and logged; everything else is real curl.
		curl: [
			'for a in "$@"; do',
			'  case "$a" in',
			"    *://127.0.0.1:4000|*://127.0.0.1:4000/*|*://localhost:4000|*://localhost:4000/*|https://bun.sh/*|https://github.com/oven-sh/*)",
			'      echo "curl blocked $a" >> "$AP_STUB_LOG"; exit 7 ;;',
			"  esac",
			"done",
			`exec "${realCurl}" "$@"`,
		].join("\n"),
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
			if (url.pathname === "/setup-relay.sh" && servedBody !== null) {
				return new Response(servedBody);
			}
			return new Response("not found", { status: 404 });
		},
	});
	authUrl = `http://127.0.0.1:${authServer.port}`;
	openServer = Bun.serve({
		port: 0,
		fetch: () => Response.json({ authenticated: false, user: null, disableAuth: true }),
	});
	openUrl = `http://127.0.0.1:${openServer.port}`;
});

/**
 * The body /setup-relay.sh serves, with PUBLIC_URL pointed at the stub server.
 * The stub is on 127.0.0.1, and F172 only hands a loopback PUBLIC_URL to a
 * requester on the same machine, so the request comes from localhost.
 */
async function serveInstallerBody() {
	const saved = { publicUrl: config.publicUrl, explicit: config.publicUrlExplicit };
	config.publicUrl = authUrl;
	config.publicUrlExplicit = true;
	try {
		const res = await setup.request("/setup-relay.sh", { headers: { Host: "localhost" } });
		expect(res.status).toBe(200);
		servedBody = await res.text();
		return servedBody;
	} finally {
		config.publicUrl = saved.publicUrl;
		config.publicUrlExplicit = saved.explicit;
	}
}

afterAll(async () => {
	authServer?.stop(true);
	openServer?.stop(true);
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
			// F186: the health probe went to the default port, and the curl stub
			// refused it, so the developer's own relay on :4000 was never touched.
			expect(res.stubLog).toContain("curl blocked http://127.0.0.1:4000/api/v1/health");
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
			const body = await serveInstallerBody();
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

describe("key handling (F167, F168, F169)", () => {
	test(
		"AGENTPULSE_KEY supplies the key without --key, and it never reaches the output",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const res = await runInstaller(home, ["--url", authUrl, "--port", String(port)], {
				env: { AGENTPULSE_KEY: RELAY_KEY },
			});
			expect(res.code).toBe(0);
			expect((await readJson(join(home, ".agentpulse", "config.json"))).api_key).toBe(RELAY_KEY);
			expect(res.out).not.toContain(RELAY_KEY);
			expect(res.out).not.toContain(KEY_PROMPT);
			// A loopback http:// server gets no plain-http warning.
			expect(res.out).not.toContain("plain http://");
		},
		RUN_TIMEOUT,
	);

	test(
		"with no key and no terminal, it says how to pass one and writes nothing",
		async () => {
			const home = await newHome();
			const res = await runInstaller(home, ["--url", authUrl]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("--key");
			expect(res.out).toContain("AGENTPULSE_KEY");
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);

	test(
		"with no key, it asks on the terminal and uses what's typed",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const tty = join(root, `tty-${homeCounter}`);
			await writeFile(tty, `${RELAY_KEY}\n`);
			const res = await runInstaller(home, ["--url", authUrl, "--port", String(port)], {
				env: { AGENTPULSE_TTY: tty },
			});
			expect(res.code).toBe(0);
			expect(res.out).toContain(KEY_PROMPT);
			expect(res.out).not.toContain(RELAY_KEY);
			expect((await readJson(join(home, ".agentpulse", "config.json"))).api_key).toBe(RELAY_KEY);
		},
		RUN_TIMEOUT,
	);

	test(
		"a server with auth disabled needs no key, so nothing is asked",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const tty = join(root, `tty-open-${homeCounter}`);
			await writeFile(tty, "ap_shouldNeverBeRead\n");
			const res = await runInstaller(home, ["--url", openUrl, "--port", String(port)], {
				env: { AGENTPULSE_TTY: tty },
			});
			expect(res.code).toBe(0);
			expect(res.out).not.toContain(KEY_PROMPT);
			expect((await readJson(join(home, ".agentpulse", "config.json"))).api_key).toBe("");
		},
		RUN_TIMEOUT,
	);

	test(
		"F168: an answer that isn't an authenticated identity is refused, not taken for an older server",
		async () => {
			const home = await newHome();
			const res = await runInstaller(home, ["--url", authUrl, "--key", ODD_KEY]);
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("unexpected answer");
			expect(res.out).not.toContain("older server");
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);

	test(
		"F169: a key bound for a non-loopback http:// server gets a warning first",
		async () => {
			const home = await newHome();
			const res = await runInstaller(home, [
				"--url",
				"http://agentpulse.invalid",
				"--key",
				RELAY_KEY,
			]);
			expect(res.out).toContain("plain http://");
			expect(res.code).not.toBe(0);
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);
});

describe("F184: curl | bash", () => {
	test(
		"a refusal ends cleanly: bash has read the whole script, so curl never hits a closed pipe",
		async () => {
			await serveInstallerBody();
			const home = await newHome();
			const res = await runInstaller(home, ["--key", INGEST_ONLY_KEY], {
				pipeFrom: `${authUrl}/setup-relay.sh`,
			});
			expect(res.code).not.toBe(0);
			expect(res.out).toContain("Observe (read-only)");
			expect(res.out).not.toContain("(23)");
			expect(res.out).not.toContain("Failure writing output");
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);
});

/** A `bun` that only answers --version; the service is stubbed, so it never runs. */
async function fakeBun(dir: string, version: string) {
	await mkdir(dir, { recursive: true });
	const file = join(dir, "bun");
	await writeFile(file, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}"\nexit 0\n`);
	await chmod(file, 0o755);
	return file;
}

describe("F190: the relay service runs on a Bun that keeps its files private", () => {
	test(
		"a Bun older than the floor on PATH is skipped for one that meets it",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const oldBin = join(root, `old-bun-${homeCounter}`);
			const oldBun = await fakeBun(oldBin, "1.1.30");
			const newBun = await fakeBun(join(home, ".bun", "bin"), "1.3.12");
			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin", pathPrefix: oldBin },
			);
			expect(res.code).toBe(0);
			expect(res.out).toContain("1.1.30");
			const plist = await readFile(
				join(home, "Library", "LaunchAgents", "dev.agentpulse.relay.plist"),
				"utf-8",
			);
			expect(plist).toContain(`<string>${newBun}</string>`);
			expect(plist).not.toContain(oldBun);
		},
		RUN_TIMEOUT,
	);

	test(
		"with only an old Bun around, the pinned one is fetched, never the old one used",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const oldBin = join(root, `old-bun-${homeCounter}`);
			await fakeBun(oldBin, "1.1.30");
			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Linux", pathPrefix: oldBin },
			);
			// The download is refused by the curl stub, so the install stops there.
			// F197: the pinned download is now the release zip itself, not the
			// bun.sh installer script.
			expect(res.stubLog).toContain(
				"curl blocked https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-",
			);
			expect(res.code).not.toBe(0);
			await expect(
				stat(join(home, ".config", "systemd", "user", "agentpulse-relay.service")),
			).rejects.toThrow();
			await expect(stat(join(home, ".agentpulse", "config.json"))).rejects.toThrow();
		},
		RUN_TIMEOUT,
	);
});

describe("D12/D13 — Codex command hooks (F50, F52, r6 CODEX_HOME)", () => {
	test(
		"the written ~/.codex/hooks.json deep-equals buildCodexHooksFile() for all 12 events",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin" },
			);
			expect(res.code).toBe(0);

			const hooksJson = await readFile(join(home, ".codex", "hooks.json"), "utf-8");
			const expected = buildCodexHooksFile({ baseUrl: `http://localhost:${port}`, direct: false });
			expect(hooksJson).toBe(expected);

			const parsed = JSON.parse(hooksJson);
			expect(Object.keys(parsed.hooks)).toHaveLength(12);
			expect(Object.keys(parsed.hooks)).toContain("Interrupt");
			for (const event of Object.keys(parsed.hooks)) {
				const handler = parsed.hooks[event][0].hooks[0];
				expect(handler.type).toBe("command");
				expect(handler.async).toBe(false);
				expect(handler.timeout).toBe(1);
			}
			expect(hooksJson).not.toContain('"matcher"');

			const configToml = await readFile(join(home, ".codex", "config.toml"), "utf-8").catch(
				() => "",
			);
			expect(configToml).not.toContain("codex_hooks");
		},
		RUN_TIMEOUT,
	);

	test(
		"CODEX_HOME places the hooks file (and its backups) outside ~/.codex",
		async () => {
			const home = await newHome();
			const codexHome = join(home, "codex-home-override");
			await mkdir(codexHome, { recursive: true });
			const port = await freePort();
			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin", env: { CODEX_HOME: codexHome } },
			);
			expect(res.code).toBe(0);

			await expect(readFile(join(codexHome, "hooks.json"))).resolves.toBeDefined();
			await expect(stat(join(home, ".codex", "hooks.json"))).rejects.toThrow();
		},
		RUN_TIMEOUT,
	);

	test(
		"backup rotation: a user-authored hooks.json is backed up once, unchanged re-runs print the no-re-trust line, and a URL change backs up again",
		async () => {
			const home = await newHome();
			const port = await freePort();
			await mkdir(join(home, ".codex"), { recursive: true });
			await writeFile(join(home, ".codex", "hooks.json"), '{"hooks":{"custom":"mine"}}\n');

			const run1 = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin" },
			);
			expect(run1.code).toBe(0);
			const backups1 = (await readdir(join(home, ".codex"))).filter((f) =>
				f.includes("agentpulse-bak"),
			);
			expect(backups1).toHaveLength(1);
			const firstBackupBytes = await readFile(join(home, ".codex", backups1[0]), "utf-8");
			expect(firstBackupBytes).toBe('{"hooks":{"custom":"mine"}}\n');

			const run2 = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin" },
			);
			expect(run2.code).toBe(0);
			expect(run2.out).toContain("Codex hooks unchanged — no re-trust needed");
			const backups2 = (await readdir(join(home, ".codex"))).filter((f) =>
				f.includes("agentpulse-bak"),
			);
			expect(backups2).toHaveLength(1);

			// The backup timestamp is second-precision (D12: hooks.json.agentpulse-bak.<UTC
			// yyyymmddTHHMMSSZ>); force a full second between runs so run3's backup
			// can't collide with run1's and silently overwrite it.
			await Bun.sleep(1100);

			const port3 = await freePort();
			const run3 = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port3)],
				{ uname: "Darwin" },
			);
			expect(run3.code).toBe(0);
			const backups3 = (await readdir(join(home, ".codex"))).filter((f) =>
				f.includes("agentpulse-bak"),
			);
			expect(backups3).toHaveLength(2);
			const stillFirstBackupBytes = await readFile(join(home, ".codex", backups1[0]), "utf-8");
			expect(stillFirstBackupBytes).toBe('{"hooks":{"custom":"mine"}}\n');
		},
		RUN_TIMEOUT,
	);
});
