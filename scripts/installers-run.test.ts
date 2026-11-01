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
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
// Before config.js: the test process shares one module registry, and config
// is read once, so the harness's env has to be in place first.
import "../src/server/db/__test_db.js";
import {
	CODEX_APPROVE_LINE,
	CODEX_REAPPROVE_LINE,
	EXCLUDE_CHECK_HINT,
} from "../src/shared/hook-headers.js";
import { expectClaudeHooksCarrySkip } from "./claude-hook-assertions.js";
import {
	HAS_ICONV,
	MESSAGES,
	extractMarkerBlock,
	fakeBun,
	lsStub,
	makeFakeBunZip,
	stubDir as makeStubDir,
	pathWithout,
	run as runBash,
	shellQuote,
	spawnChecked,
} from "./lib/installer-test-utils.ts";

const { config } = await import("../src/server/config.js");
const { setup } = await import("../src/server/routes/setup.js");
const { buildCodexHooksFile, buildCopilotHooksFile } = await import(
	"../src/shared/hook-command.js"
);

const INSTALLER = join(import.meta.dir, "setup-relay.sh");
const RELAY_SRC = join(import.meta.dir, "relay.ts");
const STATUSLINE_SRC = join(import.meta.dir, "statusline.sh");
// F46: the real Bun is reached through a symlink in a private directory of its own, so the
// owner and mode rules judge Bun itself and not whatever directory it was installed into.
let bunLinkDir: string;
// Each case runs a real installer in a subprocess; several take most of the 5 s default on a loaded machine.
setDefaultTimeout(30_000);
const RUN_TIMEOUT = 60_000;
/** Under RUN_TIMEOUT, so a hung installer is killed before its test gives up. */
const INSTALLER_TIMEOUT = 50_000;

const INGEST_ONLY_KEY = "ap_test_ingest_only";
const RELAY_KEY = "ap_test_relay_key";
/** Authenticated per HTTP status, but the body says neither authenticated nor scopes. */
const ODD_KEY = "ap_test_no_auth_flag";
const KEY_PROMPT = "API key (Hook ingest + Observe)";
const POLICY_LINE = (policy: string) =>
	`Codex names: ${policy} — pass --codex-names agentpulse|codex to change`;

let root: string;
let stubDir: string;
let sanitizedPath: string;
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
		/** Replaces the real Bun's directory and the inherited PATH after the stubs. */
		basePath?: string;
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
		// A test that times out kills its installer instead of leaving it running.
		timeout: INSTALLER_TIMEOUT,
		killSignal: "SIGKILL",
		env: {
			PATH: `${opts.pathPrefix ? `${opts.pathPrefix}:` : ""}${stubDir}:${opts.basePath ?? `${bunLinkDir}:${sanitizedPath}`}`,
			HOME: home,
			TMPDIR: tmp,
			// Apple's python3 shim writes a bytecode cache under HOME, which the "writes nothing" cases would count.
			PYTHONDONTWRITEBYTECODE: "1",
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
	if (proc.signalCode === "SIGKILL")
		throw new Error(`the installer ran past ${INSTALLER_TIMEOUT} ms`);
	return { code: proc.exitCode, out: stdout + stderr, stubLog: await readFile(stubLog, "utf-8") };
}

/** The installed check: present, byte for byte the generator's, mode 0500, in a ~/.agentpulse only its owner can use. */
async function expectCheckScriptInstalled(home: string) {
	const { buildBashExcludeScript } = await import("../src/shared/hook-command.js");
	const script = join(home, ".agentpulse", "exclude-check.sh");
	expect(await readFile(script, "utf-8")).toBe(buildBashExcludeScript());
	expect(await modeOf(script)).toBe(0o500);
	expect(await modeOf(join(home, ".agentpulse"))).toBe(0o700);
}

async function readJson(path: string) {
	return JSON.parse(await readFile(path, "utf-8"));
}

async function modeOf(path: string) {
	return (await stat(path)).mode & 0o777;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "ap-installers-run-"));
	const realCurl = Bun.which("curl");
	if (!realCurl) throw new Error("curl isn't on PATH");
	const stubs: Record<string, string> = {
		// F186: the default relay port is the developer's own live relay, so any
		// request to it is refused and logged; everything else is real curl.
		curl: [
			'for a in "$@"; do',
			'  case "$a" in',
			// A test that sets AP_FAKE_ZIP gets it in place of the pinned Bun release. The stub
			// ignores --proto: it stands for GitHub, and the zip's hash is what the script checks.
			"    https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-*.zip)",
			'      if [ -n "${AP_FAKE_ZIP-}" ]; then',
			'        echo "curl served $a" >> "$AP_STUB_LOG"',
			'        out=""; prev=""',
			'        for b in "$@"; do if [ "$prev" = "-o" ]; then out="$b"; fi; prev="$b"; done',
			'        cp "$AP_FAKE_ZIP" "$out"; exit 0',
			"      fi",
			'      echo "curl blocked $a" >> "$AP_STUB_LOG"; exit 7 ;;',
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
	stubDir = makeStubDir([], stubs, root);
	bunLinkDir = join(root, "real-bun");
	await mkdir(bunLinkDir, { mode: 0o700 });
	await symlink(process.execPath, join(bunLinkDir, "bun"));
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

	// D8: the Copilot detection-gated tests need "copilot not on PATH" to be
	// deterministic regardless of what's installed on the machine running this
	// suite; pathWithout mirrors each PATH directory holding a `copilot` so the
	// other binaries in it (python3, curl…) still resolve.
	sanitizedPath = pathWithout(["copilot"], undefined, root);
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
			// the relay form: no key in the file, the skip header left unexpanded
			expectClaudeHooksCarrySkip(settings, { allowedEnvVars: ["AGENTPULSE_SKIP"] });
			for (const entries of Object.values(settings.hooks) as {
				hooks: { headers: Record<string, string> }[];
			}[][]) {
				expect(entries[0]?.hooks[0]?.headers.Authorization).toBeUndefined();
			}

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
		"a stub copilot on PATH → agentpulse.json has exactly the 10 CopilotEvent keys, each with its own ?event= and X-Agent-Type; the key never appears",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const copilotStubDir = join(root, `copilot-stub-${relative(root, home)}`);
			await mkdir(copilotStubDir, { recursive: true });
			await writeFile(join(copilotStubDir, "copilot"), "#!/bin/sh\nexit 0\n");
			await chmod(join(copilotStubDir, "copilot"), 0o755);

			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin", pathPrefix: copilotStubDir },
			);
			expect(res.code).toBe(0);

			const copilotFile = join(home, ".copilot", "hooks", "agentpulse.json");
			const written = JSON.parse(await readFile(copilotFile, "utf-8"));
			const keys = Object.keys(written.hooks);
			expect(keys.length).toBe(10);
			for (const event of keys) {
				const bash = written.hooks[event][0].bash as string;
				expect(bash).toContain(`?event=${event}`);
				expect(bash).toContain("X-Agent-Type: copilot_cli");
				// The key never appears in the command. (A bare "ap_" prefix check
				// is no longer meaningful: the exclusion check's own variables are
				// named ap_dir, ap_rules, ...)
				expect(bash).not.toContain(RELAY_KEY);
			}
			expect(written).toEqual(
				JSON.parse(buildCopilotHooksFile({ baseUrl: `http://localhost:${port}`, direct: false })),
			);

			await expectCheckScriptInstalled(home);

			const installed = await readJson(join(home, ".agentpulse", "installed.json"));
			expect(typeof installed.copilotHooksWrittenAt).toBe("string");
			expect(Number.isNaN(Date.parse(installed.copilotHooksWrittenAt))).toBe(false);
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
			await writeFile(tty, "ap_test_should_never_be_read\n");
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

/** The relay installer's shared Bun block, as the script carries it. */
const BUN_BLOCK = extractMarkerBlock(readFileSync(INSTALLER, "utf-8"), "agentpulse-bun");
const HINT_BLOCK = extractMarkerBlock(readFileSync(INSTALLER, "utf-8"), "agentpulse-pkg-hint");
const RELEASE_URL_RE = /curl blocked https:\/\/github\.com\/oven-sh/;

/** The pinned asset and install hint the script would compute here, under the same stubbed uname. */
function inScript(uname: "Darwin" | "Linux", body: string) {
	return runBash("bash", `${BUN_BLOCK}\n${HINT_BLOCK}\n${body}`, [], {
		PATH: `${stubDir}:${sanitizedPath}`,
		AP_TEST_UNAME: uname,
	});
}

type FakeRelease = { zip: string; script: string; asset: string; scriptDir: string };
const fakeReleases = new Map<string, FakeRelease>();

/**
 * A fake Bun release zip for this host's asset, and a copy of the installer
 * whose pinned hash for that asset is the zip's (the only line that differs).
 * The negative control runs the unmodified script against the same zip.
 */
async function fakeRelease(uname: "Darwin" | "Linux"): Promise<FakeRelease> {
	const cached = fakeReleases.get(uname);
	if (cached) return cached;
	const asset = inScript(uname, "ap_bun_asset").out;
	expect(asset).not.toBe("");
	const dir = join(root, `fake-release-${uname}`);
	await mkdir(dir, { recursive: true });
	const { zip, sha } = makeFakeBunZip(dir, asset);

	const original = await readFile(INSTALLER, "utf-8");
	const lines = original.split("\n");
	const pinned = lines.filter((l) => l.startsWith(`    ${asset}) echo "`));
	expect(pinned).toHaveLength(1);
	const modified = lines.map((l) => (l === pinned[0] ? `    ${asset}) echo "${sha}" ;;` : l));
	expect(modified.filter((l, i) => l !== lines[i])).toHaveLength(1);
	const scriptDir = join(dir, "scripts");
	await mkdir(scriptDir, { recursive: true });
	const script = join(scriptDir, "setup-relay.sh");
	await writeFile(script, modified.join("\n"));
	await writeFile(join(scriptDir, "relay.ts"), await readFile(RELAY_SRC));
	await writeFile(join(scriptDir, "statusline.sh"), await readFile(STATUSLINE_SRC));
	const release = { zip, script, asset, scriptDir };
	fakeReleases.set(uname, release);
	return release;
}

let noBunBase: string | undefined;
/** The inherited PATH minus every `bun`, so nothing on this machine can be chosen. */
function pathNoBun() {
	noBunBase ??= pathWithout(["bun"], sanitizedPath, root);
	return noBunBase;
}

async function plistProgramArguments(plist: string): Promise<string[]> {
	const proc = spawnChecked([
		"python3",
		"-I",
		"-c",
		"import json, plistlib, sys\nprint(json.dumps(plistlib.load(open(sys.argv[1], 'rb'))['ProgramArguments']))",
		plist,
	]);
	expect(proc.exitCode).toBe(0);
	return JSON.parse(proc.stdout.toString());
}

const plistPath = (home: string) =>
	join(home, "Library", "LaunchAgents", "dev.agentpulse.relay.plist");
const unitPath = (home: string) =>
	join(home, ".config", "systemd", "user", "agentpulse-relay.service");

/** A home at an exact name under root, for the cases whose HOME has to hold odd characters. */
async function namedHome(name: string) {
	const home = join(root, name);
	await mkdir(home, { recursive: true });
	return home;
}

/** A directory laid out like Homebrew's bin: a good Bun in a group-writable (775) directory. */
async function groupWritableBunDir(label: string) {
	const dir = join(root, `${label}-${homeCounter}`);
	const bun = await fakeBun(dir, "1.3.12");
	await chmod(dir, 0o775);
	return { dir, bun };
}

describe("F190: the relay service runs on a Bun that keeps its files private", () => {
	const relayArgs = (port: number) => [
		"--url",
		authUrl,
		"--key",
		RELAY_KEY,
		"--port",
		String(port),
	];

	test(
		"a Bun older than the floor in ~/.bun is named and skipped for the good one on PATH",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const oldBun = await fakeBun(join(home, ".bun", "bin"), "1.1.30");
			const goodBin = join(root, `good-bun-${homeCounter}`);
			const goodBun = await fakeBun(goodBin, "1.3.12");
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Darwin",
				pathPrefix: goodBin,
			});
			expect(res.code).toBe(0);
			expect(res.out).toContain(
				MESSAGES.notUsing(shellQuote("bash", oldBun), MESSAGES.reason.older("1.1.30")),
			);
			const args = await plistProgramArguments(plistPath(home));
			expect(args[0]).toBe(goodBun);
			expect(await readFile(plistPath(home), "utf-8")).not.toContain(oldBun);
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
			const res = await runInstaller(home, relayArgs(port), { uname: "Linux", pathPrefix: oldBin });
			// The download is refused by the curl stub, so the install stops there.
			// F197: the pinned download is now the release zip itself, not the
			// bun.sh installer script.
			expect(res.stubLog).toContain(
				"curl blocked https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-",
			);
			expect(res.code).not.toBe(0);
			await expect(stat(unitPath(home))).rejects.toThrow();
			await expect(stat(join(home, ".agentpulse", "config.json"))).rejects.toThrow();
		},
		RUN_TIMEOUT,
	);

	test(
		"a missing unzip is refused with the fix, before the key is asked for or anything is downloaded",
		async () => {
			const home = await newHome();
			const noUnzipPath = pathWithout(["bun", "unzip"], sanitizedPath, root);
			const probe = runBash("bash", "command -v unzip", [], { PATH: noUnzipPath });
			expect(probe.code).toBe(1);
			const tty = join(root, `tty-nounzip-${homeCounter}`);
			await writeFile(tty, `${RELAY_KEY}\n`);
			seenAuthHeaders = [];
			// A stub brew is first on PATH, so the hint is the literal Homebrew command on any machine.
			const res = await runInstaller(home, ["--url", authUrl], {
				uname: "Darwin",
				basePath: noUnzipPath,
				pathPrefix: makeStubDir([], { brew: "exit 0" }, root),
				env: { AGENTPULSE_TTY: tty },
			});
			expect(res.code).toBe(1);
			expect(res.out).toContain(MESSAGES.fetch.tool("unzip", "brew install unzip"));
			expect(res.out).not.toContain(KEY_PROMPT);
			expect(seenAuthHeaders).toEqual([]);
			expect(res.stubLog).not.toMatch(RELEASE_URL_RE);
			expect(await listTree(home)).toEqual([]);
		},
		RUN_TIMEOUT,
	);

	test(
		"a first run under umask 002 has ~/.agentpulse at 700 before Bun is fetched, and after",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const rel = await fakeRelease("Linux");
			const relayDir = join(home, ".agentpulse");
			const seen = join(root, `relay-dir-at-fetch-${homeCounter}`);
			const wrapper = join(root, `umask-002-${homeCounter}.sh`);
			await writeFile(wrapper, `umask 002\nexec bash '${rel.script}' "$@"\n`);
			// Records the mode of the relay directory at the moment the Bun release is requested.
			const recorder = makeStubDir(
				[],
				{
					curl: [
						'case "$*" in *github.com/oven-sh/*)',
						`  ls -ldn '${relayDir}' > '${seen}' 2>&1 ;;`,
						"esac",
						`exec '${join(stubDir, "curl")}' "$@"`,
					].join("\n"),
				},
				root,
			);
			await expect(stat(relayDir)).rejects.toThrow();
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Linux",
				script: wrapper,
				pathPrefix: recorder,
				basePath: pathNoBun(),
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(res.code).toBe(0);
			expect(res.stubLog).toContain("curl served https://github.com/oven-sh/");
			const atFetch = await readFile(seen, "utf-8");
			expect(atFetch.startsWith("drwx------")).toBe(true);
			expect(await modeOf(relayDir)).toBe(0o700);
		},
		RUN_TIMEOUT,
	);

	for (const uname of ["Darwin", "Linux"] as const) {
		test(
			`${uname}: with no Bun anywhere, the pinned release is fetched, checked, installed and used`,
			async () => {
				const home = await newHome();
				const port = await freePort();
				const rel = await fakeRelease(uname);
				const res = await runInstaller(home, relayArgs(port), {
					uname,
					script: rel.script,
					basePath: pathNoBun(),
					env: { AP_FAKE_ZIP: rel.zip },
				});
				expect(res.code).toBe(0);
				const bun = join(home, ".agentpulse", "bun", "bin", "bun");
				expect(res.out).toContain(
					`Installing Bun 1.3.12 for the relay into ${join(home, ".agentpulse", "bun")}`,
				);
				expect(res.out).toContain(`✓ Bun: ${bun} (1.3.12)`);
				expect(await modeOf(bun)).toBe(0o755);
				if (uname === "Darwin") {
					expect((await plistProgramArguments(plistPath(home)))[0]).toBe(bun);
				} else {
					expect(await readFile(unitPath(home), "utf-8")).toContain(`ExecStart="${bun}" `);
				}
				const leftovers = (await listTree(join(root, `tmp-${relative(root, home)}`))).filter(
					(p) => p.includes("agentpulse-relay-setup") || p.includes(".bun."),
				);
				expect(leftovers).toEqual([]);
				expect((await listTree(join(home, ".agentpulse", "bun", "bin"))).sort()).toEqual(["bun"]);
			},
			RUN_TIMEOUT,
		);
	}

	test(
		"negative control: the unmodified script refuses the same fake zip on its checksum and installs nothing",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const rel = await fakeRelease("Linux");
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Linux",
				basePath: pathNoBun(),
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(res.code).toBe(1);
			expect(res.out).toContain(MESSAGES.fetch.checksum);
			await expect(stat(join(home, ".agentpulse", "bun", "bin", "bun"))).rejects.toThrow();
		},
		RUN_TIMEOUT,
	);

	test(
		"Darwin: a good Bun in a Homebrew-style 775 directory owned by admin (gid 80) is used as it is",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const { dir, bun } = await groupWritableBunDir("brew-bin");
			const lsDir = makeStubDir([], { ls: lsStub(process.getuid?.() ?? 0, 80, dir) }, root);
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Darwin",
				pathPrefix: `${lsDir}:${dir}`,
			});
			expect(res.code).toBe(0);
			expect(res.out).not.toContain("Not using");
			expect((await plistProgramArguments(plistPath(home)))[0]).toBe(bun);
			await expect(stat(join(home, ".bun"))).rejects.toThrow();
		},
		RUN_TIMEOUT,
	);

	test(
		"Linux: the same Bun in a group-writable directory is refused, and the private copy is installed and used",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const { dir, bun } = await groupWritableBunDir("group-bin");
			const rel = await fakeRelease("Linux");
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Linux",
				pathPrefix: dir,
				env: { AP_FAKE_ZIP: rel.zip },
				script: rel.script,
			});
			expect(res.code).toBe(0);
			expect(res.out).toContain(
				MESSAGES.notUsing(shellQuote("bash", bun), MESSAGES.reason.groupWritable),
			);
			expect(await readFile(unitPath(home), "utf-8")).toContain(
				`ExecStart="${join(home, ".agentpulse", "bun", "bin", "bun")}" `,
			);
		},
		RUN_TIMEOUT,
	);

	test(
		"a fresh relay with no Bun anywhere gets past the early Bun check to the key check (set -u)",
		async () => {
			const home = await newHome();
			seenAuthHeaders = [];
			const res = await runInstaller(home, ["--url", authUrl, "--key", RELAY_KEY], {
				uname: "Linux",
				basePath: pathNoBun(),
			});
			expect(res.out).not.toContain("unbound variable");
			expect(seenAuthHeaders).toEqual([`Bearer ${RELAY_KEY}`]);
		},
		RUN_TIMEOUT,
	);

	for (const [label, dirName] of [
		["a space", "my home"],
		["non-ASCII", "hömé"],
	] as const) {
		for (const uname of ["Darwin", "Linux"] as const) {
			const run = dirName === "hömé" && !HAS_ICONV ? test.skip : test;
			run(
				`${uname}: a HOME with ${label} installs, writes exact service paths, and isn't downloaded for twice`,
				async () => {
					const home = await namedHome(`${dirName}-${uname}`);
					const port = await freePort();
					const rel = await fakeRelease(uname);
					const opts = {
						uname,
						script: rel.script,
						basePath: pathNoBun(),
						env: { AP_FAKE_ZIP: rel.zip },
					};
					const first = await runInstaller(home, relayArgs(port), opts);
					expect(first.code).toBe(0);
					const bun = join(home, ".agentpulse", "bun", "bin", "bun");
					const relay = join(home, ".agentpulse", "relay.ts");
					const config = join(home, ".agentpulse", "config.json");
					if (uname === "Darwin") {
						expect(await plistProgramArguments(plistPath(home))).toEqual([
							bun,
							relay,
							"--config",
							config,
						]);
					} else {
						expect(await readFile(unitPath(home), "utf-8")).toContain(
							`ExecStart="${bun}" "${relay}" --config "${config}"\n`,
						);
					}
					const second = await runInstaller(home, relayArgs(port), opts);
					expect(second.code).toBe(0);
					expect(second.stubLog).not.toContain("github.com/oven-sh");
					expect(second.out).not.toContain("Installing Bun");
				},
				RUN_TIMEOUT,
			);
		}
	}

	for (const [label, dirName] of [
		["%", "h%x"],
		["$", "h$x"],
	] as const) {
		test(
			`a HOME with ${label} is refused up front with the exact line, before the key prompt, writing nothing`,
			async () => {
				const home = await namedHome(dirName);
				const tty = join(root, `tty-refuse-${homeCounter}-${dirName.length}`);
				await writeFile(tty, `${RELAY_KEY}\n`);
				seenAuthHeaders = [];
				const res = await runInstaller(home, ["--url", authUrl], { env: { AGENTPULSE_TTY: tty } });
				expect(res.code).toBe(1);
				expect(res.out).toContain(
					MESSAGES.relayHome(shellQuote("bash", home), MESSAGES.reason.badChars),
				);
				expect(res.out).not.toContain(KEY_PROMPT);
				expect(seenAuthHeaders).toEqual([]);
				expect(await listTree(home)).toEqual([]);
			},
			RUN_TIMEOUT,
		);
	}

	for (const uname of ["Darwin", "Linux"] as const) {
		test(
			`${uname}: a re-run over group-writable (775) private Bun directories repairs them, accepts the Bun and downloads nothing`,
			async () => {
				const home = await newHome();
				const port = await freePort();
				const agentpulse = join(home, ".agentpulse");
				const bunDir = join(agentpulse, "bun");
				const bun = await fakeBun(join(bunDir, "bin"), "1.3.12");
				for (const d of [agentpulse, bunDir, join(bunDir, "bin")]) await chmod(d, 0o775);
				const res = await runInstaller(home, relayArgs(port), {
					uname,
					basePath: pathNoBun(),
				});
				expect(res.code).toBe(0);
				expect(res.stubLog).not.toMatch(RELEASE_URL_RE);
				expect(res.out).not.toContain("Installing Bun");
				expect(res.out).not.toContain("Not using");
				expect(res.out).toContain(`✓ Bun: ${bun} (1.3.12)`);
				for (const d of [bunDir, join(bunDir, "bin")]) expect(await modeOf(d)).toBe(0o755);
			},
			RUN_TIMEOUT,
		);
	}

	test(
		"a fresh relay with a pre-existing group-writable ~/.agentpulse installs the private Bun",
		async () => {
			const home = await newHome();
			const port = await freePort();
			await mkdir(join(home, ".agentpulse"));
			await chmod(join(home, ".agentpulse"), 0o775);
			const rel = await fakeRelease("Linux");
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Linux",
				script: rel.script,
				basePath: pathNoBun(),
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(res.code).toBe(0);
			expect(res.out).toContain(
				`✓ Bun: ${join(home, ".agentpulse", "bun", "bin", "bun")} (1.3.12)`,
			);
		},
		RUN_TIMEOUT,
	);

	test(
		"a trailing slash on HOME gives the same service paths as none",
		async () => {
			const home = await namedHome("h-slash");
			const port = await freePort();
			const rel = await fakeRelease("Linux");
			const res = await runInstaller(`${home}/`, relayArgs(port), {
				uname: "Linux",
				script: rel.script,
				basePath: pathNoBun(),
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(res.code).toBe(0);
			const bun = join(home, ".agentpulse", "bun", "bin", "bun");
			const unit = await readFile(unitPath(home), "utf-8");
			expect(unit).toContain(`ExecStart="${bun}" "${home}/.agentpulse/relay.ts" `);
			expect(unit).not.toContain("//.agentpulse");
		},
		RUN_TIMEOUT,
	);

	test(
		"when the download fails, no Bun, stage file or temporary directory is left behind",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const res = await runInstaller(home, relayArgs(port), {
				uname: "Linux",
				basePath: pathNoBun(),
			});
			expect(res.code).not.toBe(0);
			expect(res.stubLog).toMatch(RELEASE_URL_RE);
			const homeTree = await listTree(home);
			expect(homeTree.filter((p) => p.endsWith("/bun") || p.includes(".bun."))).toEqual([]);
			const tmpTree = await listTree(join(root, `tmp-${relative(root, home)}`));
			expect(tmpTree.filter((p) => p.includes("agentpulse-relay-setup"))).toEqual([]);
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
			// the hooks carry the gate, so the script the gate runs must be there
			await expectCheckScriptInstalled(home);

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

	test(
		"an existing hooks.json keeps another tool's hooks and unknown keys; a re-run changes nothing; malformed JSON is left alone",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const hooksPath = join(home, ".codex", "hooks.json");
			await mkdir(join(home, ".codex"), { recursive: true });
			const theirs = {
				"x-other-tool": { enabled: true },
				hooks: {
					SessionStart: [
						{ matcher: "startup", hooks: [{ type: "command", command: "othertool start" }] },
					],
					PreToolUse: [
						{ matcher: "Bash", hooks: [{ type: "command", command: "othertool guard" }] },
					],
				},
			};
			await writeFile(hooksPath, `${JSON.stringify(theirs, null, 2)}\n`);
			const args = ["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)];

			const run1 = await runInstaller(home, args, { uname: "Darwin" });
			expect(run1.code).toBe(0);
			const merged = await readJson(hooksPath);
			expect(merged["x-other-tool"]).toEqual({ enabled: true });
			expect(merged.hooks.SessionStart[0]).toEqual(theirs.hooks.SessionStart[0]);
			expect(merged.hooks.PreToolUse[0]).toEqual(theirs.hooks.PreToolUse[0]);
			expect(merged.hooks.SessionStart).toHaveLength(2);
			expect(Object.keys(merged.hooks)).toHaveLength(12);
			const bytes1 = await readFile(hooksPath, "utf-8");
			const ino1 = (await stat(hooksPath)).ino;

			const run2 = await runInstaller(home, args, { uname: "Darwin" });
			expect(run2.code).toBe(0);
			expect(run2.out).toContain("Codex hooks unchanged — no re-trust needed");
			expect(await readFile(hooksPath, "utf-8")).toBe(bytes1);
			expect((await stat(hooksPath)).ino).toBe(ino1);

			const home2 = await newHome();
			await mkdir(join(home2, ".codex"), { recursive: true });
			await writeFile(join(home2, ".codex", "hooks.json"), "{not json");
			const run3 = await runInstaller(home2, args, { uname: "Darwin" });
			expect(run3.code).toBe(0);
			expect(run3.out).toContain("Codex hooks not updated");
			expect(await readFile(join(home2, ".codex", "hooks.json"), "utf-8")).toBe("{not json");
			expect(
				(await readdir(join(home2, ".codex"))).filter((f) => f.includes("agentpulse-bak")),
			).toHaveLength(0);
		},
		RUN_TIMEOUT,
	);
});

describe("the relay installer's closing lines about the exclude rules", () => {
	test(
		"a fresh install ends with the Codex approve line and prints the exclude hint; an unchanged re-run does not ask again",
		async () => {
			const home = await newHome();
			const port = await freePort();
			const args = ["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)];
			const first = await runInstaller(home, args, { uname: "Darwin" });
			expect(first.code).toBe(0);
			expect(first.out).toContain(EXCLUDE_CHECK_HINT);
			expect(
				first.out.trimEnd().endsWith(CODEX_APPROVE_LINE),
				"a fresh install asks to approve",
			).toBe(true);
			expect(first.out).not.toContain(CODEX_REAPPROVE_LINE);

			const second = await runInstaller(home, args, { uname: "Darwin" });
			expect(second.code).toBe(0);
			expect(second.out).toContain(EXCLUDE_CHECK_HINT);
			expect(second.out).not.toContain(CODEX_REAPPROVE_LINE);
			expect(second.out).not.toContain(CODEX_APPROVE_LINE);
		},
		RUN_TIMEOUT,
	);
});

describe("a symlinked ~/.claude/settings.json is never severed (real setup-relay.sh subprocess)", () => {
	test(
		"the link survives, the user's other settings survive, and the target is either written through or left alone with a message",
		async () => {
			const home = await newHome();
			const port = await freePort();
			await mkdir(join(home, ".claude"), { recursive: true });
			await mkdir(join(home, "dotfiles"), { recursive: true });
			const target = join(home, "dotfiles", "settings.json");
			await writeFile(target, `${JSON.stringify({ theme: "dark" })}\n`);
			const link = join(home, ".claude", "settings.json");
			await symlink(target, link);

			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin" },
			);
			expect((await lstat(link)).isSymbolicLink(), "the link was replaced by a regular file").toBe(
				true,
			);
			const after = await readJson(target);
			expect(after.theme).toBe("dark");
			if (res.code === 0) {
				expect(
					Object.keys(after.hooks ?? {}).length,
					"written through to the target",
				).toBeGreaterThan(0);
			} else {
				expect(res.out).toMatch(/refusing to write through a symlink/);
			}
		},
		RUN_TIMEOUT,
	);
});

describe("F232 (xander, Medium) — Codex/Copilot hooks.json writes refuse a symlinked destination (real setup-relay.sh subprocess)", () => {
	test(
		"~/.codex/hooks.json as a symlink: installer exits non-zero, the symlink's target is untouched",
		async () => {
			const home = await newHome();
			const port = await freePort();
			await mkdir(join(home, ".codex"), { recursive: true });
			const decoy = join(home, "decoy-codex-hooks.json");
			await writeFile(decoy, "should never change\n");
			await symlink(decoy, join(home, ".codex", "hooks.json"));

			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin" },
			);
			expect(res.code).not.toBe(0);
			expect(res.out).toMatch(/refusing to write through a symlink/);
			expect(await readFile(decoy, "utf-8")).toBe("should never change\n");
		},
		RUN_TIMEOUT,
	);

	test(
		"~/.copilot/hooks/agentpulse.json as a symlink (copilot detected): installer exits non-zero, the symlink's target is untouched",
		async () => {
			const home = await newHome();
			const root2 = dirname(home);
			const copilotStubDir = join(root2, `copilot-stub-write-no-follow-${relative(root, home)}`);
			await mkdir(copilotStubDir, { recursive: true });
			await writeFile(join(copilotStubDir, "copilot"), "#!/bin/sh\nexit 0\n");
			await chmod(join(copilotStubDir, "copilot"), 0o755);

			const port = await freePort();
			await mkdir(join(home, ".copilot", "hooks"), { recursive: true });
			const decoy = join(home, "decoy-copilot-hooks.json");
			await writeFile(decoy, "should never change\n");
			await symlink(decoy, join(home, ".copilot", "hooks", "agentpulse.json"));

			const res = await runInstaller(
				home,
				["--url", authUrl, "--key", RELAY_KEY, "--port", String(port)],
				{ uname: "Darwin", pathPrefix: copilotStubDir },
			);
			expect(res.code).not.toBe(0);
			expect(res.out).toMatch(/refusing to write through a symlink/);
			expect(await readFile(decoy, "utf-8")).toBe("should never change\n");
		},
		RUN_TIMEOUT,
	);
});
