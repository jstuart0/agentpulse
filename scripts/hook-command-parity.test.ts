/**
 * Phase 5 (D13 golden test — coordinator's explicit ask): the three bash
 * sites (scripts/setup-relay.sh, scripts/setup-hooks.sh, the /setup.sh
 * template rendered by src/server/routes/setup.ts) each carry a verbatim
 * `ap_hook_cmd`/`ap_codex_hooks_json` transcription of
 * src/shared/hook-command.ts. This test sources the REAL function from each
 * file (never reimplements it) and asserts its output is character-for-
 * character equal to buildBashHookCommand's output for the same inputs.
 *
 * install-local.ps1's PowerShell transcription can't be executed here (no
 * pwsh in this environment/CI's non-Windows jobs) — that half is a static
 * structural check; scripts/test-install-local.ps1 (Phase 7's Windows CI
 * job) is the real execution coverage.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
// D40 (F251): belt-and-braces — bunfig.toml's [test] preload already sets
// safe env defaults before any test file's own imports run, but this file
// dynamically imports src/server/routes/setup.ts (which statically imports
// config.js) via renderedSetupSh() below, so keep it self-sufficient too.
import "../src/server/db/__test_db.js";
import {
	CODEX_MARKER_SH_PIECE,
	PS_CODEX_MARKER_PIECE,
	PS_COMMAND_TEMPLATE,
	PS_GATE_PIECE,
	PS_PRELUDE_PIECE,
	SH_COMMAND_TEMPLATE,
	SH_GATE_PIECE,
	buildBashExcludeScriptForInstaller,
	buildBashHookCommand,
	buildCodexHooksFile,
	buildCopilotHooksFile,
	buildPowerShellExcludeScript,
	buildPowerShellHookCommand,
} from "../src/shared/hook-command.js";
import * as hookCommandModule from "../src/shared/hook-command.js";
import { psFunctionBody, runPsBuilder } from "./powershell-installer-eval.js";

// These tests start real shell installers; under load one can take longer than Bun's 5 s default.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

type Cell = { agent: "codex_cli" | "copilot_cli"; direct: boolean; event: string };

const MATRIX: Cell[] = [
	{ agent: "codex_cli", direct: false, event: "SessionStart" },
	{ agent: "codex_cli", direct: true, event: "Stop" },
	{ agent: "copilot_cli", direct: false, event: "sessionStart" },
	{ agent: "copilot_cli", direct: true, event: "agentStop" },
];

const BASE = "http://localhost:4000";

async function callApHookCmd(scriptPath: string, cell: Cell): Promise<string> {
	const source = readFileSync(scriptPath, "utf-8");
	if (!source.includes("ap_hook_cmd()")) {
		throw new Error(`ap_hook_cmd() not found in ${scriptPath}`);
	}
	const startMarker = "# >>> agentpulse-hook-cmd";
	const endMarker = "# <<< agentpulse-hook-cmd";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1) {
		throw new Error(`agentpulse-hook-cmd markers not found in ${scriptPath}`);
	}
	const block = source.slice(start, end + endMarker.length);
	const script = `${block}\nap_hook_cmd '${BASE}' '${cell.direct ? "1" : "0"}' '${cell.agent}' '${cell.event}'`;
	const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`ap_hook_cmd exited ${exitCode} for ${scriptPath}: ${stderr}`);
	}
	return stdout;
}

describe("hook-command-parity — scripts/setup-relay.sh's ap_hook_cmd equals buildBashHookCommand", () => {
	for (const cell of MATRIX) {
		test(`${cell.agent} ${cell.direct ? "direct" : "relay"} ${cell.event}`, async () => {
			const extracted = await callApHookCmd(join(ROOT, "scripts/setup-relay.sh"), cell);
			const expected = buildBashHookCommand({
				baseUrl: BASE,
				direct: cell.direct,
				agent: cell.agent,
				event: cell.event,
			});
			expect(extracted).toBe(expected);
		});
	}
});

describe("hook-command-parity — scripts/setup-hooks.sh's ap_hook_cmd equals buildBashHookCommand", () => {
	for (const cell of MATRIX) {
		test(`${cell.agent} ${cell.direct ? "direct" : "relay"} ${cell.event}`, async () => {
			const extracted = await callApHookCmd(join(ROOT, "scripts/setup-hooks.sh"), cell);
			const expected = buildBashHookCommand({
				baseUrl: BASE,
				direct: cell.direct,
				agent: cell.agent,
				event: cell.event,
			});
			expect(extracted).toBe(expected);
		});
	}
});

describe("hook-command-parity — the rendered GET /setup.sh body's ap_hook_cmd equals buildBashHookCommand", () => {
	test("all matrix cells, sourced from the rendered HTTP response (not setup.ts source)", async () => {
		const { setup } = await import("../src/server/routes/setup.ts");
		const app = new Hono().route("/", setup);
		const res = await app.request("http://localhost/setup.sh", {
			headers: { Host: "localhost:3000" },
		});
		expect(res.status).toBe(200);
		const rendered = await res.text();

		const startMarker = "# >>> agentpulse-hook-cmd";
		const endMarker = "# <<< agentpulse-hook-cmd";
		const start = rendered.indexOf(startMarker);
		const end = rendered.indexOf(endMarker);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(-1);
		const block = rendered.slice(start, end + endMarker.length);

		for (const cell of MATRIX) {
			const script = `${block}\nap_hook_cmd '${BASE}' '${cell.direct ? "1" : "0"}' '${cell.agent}' '${cell.event}'`;
			const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, `stderr: ${stderr}`).toBe(0);
			const expected = buildBashHookCommand({
				baseUrl: BASE,
				direct: cell.direct,
				agent: cell.agent,
				event: cell.event,
			});
			expect(stdout).toBe(expected);
		}
	});
});

describe("hook-command-parity — ap_codex_hooks_json equals buildCodexHooksFile byte-for-byte", () => {
	for (const site of ["scripts/setup-relay.sh", "scripts/setup-hooks.sh"]) {
		for (const direct of [false, true]) {
			test(`${site} direct=${direct}`, async () => {
				const source = readFileSync(join(ROOT, site), "utf-8");
				const start = source.indexOf("# >>> agentpulse-hook-cmd");
				const end = source.indexOf("# <<< agentpulse-hook-cmd");
				const block = source.slice(start, end + "# <<< agentpulse-hook-cmd".length);
				const script = `${block}\nap_codex_hooks_json '${BASE}' '${direct ? "1" : "0"}'`;
				const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode, `stderr: ${stderr}`).toBe(0);
				expect(stdout).toBe(buildCodexHooksFile({ baseUrl: BASE, direct }));
			});
		}
	}
});

describe("hook-command-parity — ap_copilot_hooks_json equals buildCopilotHooksFile byte-for-byte", () => {
	for (const site of ["scripts/setup-relay.sh", "scripts/setup-hooks.sh"]) {
		for (const direct of [false, true]) {
			test(`${site} direct=${direct}`, async () => {
				const source = readFileSync(join(ROOT, site), "utf-8");
				const start = source.indexOf("# >>> agentpulse-hook-cmd");
				const end = source.indexOf("# <<< agentpulse-hook-cmd");
				const block = source.slice(start, end + "# <<< agentpulse-hook-cmd".length);
				const script = `${block}\nap_copilot_hooks_json '${BASE}' '${direct ? "1" : "0"}'`;
				const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode, `stderr: ${stderr}`).toBe(0);
				expect(stdout).toBe(buildCopilotHooksFile({ baseUrl: BASE, direct }));
			});
		}
	}

	test("the rendered GET /setup.sh body's ap_copilot_hooks_json equals buildCopilotHooksFile", async () => {
		const { setup } = await import("../src/server/routes/setup.ts");
		const app = new Hono().route("/", setup);
		const res = await app.request("http://localhost/setup.sh", {
			headers: { Host: "localhost:3000" },
		});
		expect(res.status).toBe(200);
		const rendered = await res.text();
		const start = rendered.indexOf("# >>> agentpulse-hook-cmd");
		const end = rendered.indexOf("# <<< agentpulse-hook-cmd");
		const block = rendered.slice(start, end + "# <<< agentpulse-hook-cmd".length);
		const script = `${block}\nap_copilot_hooks_json '${BASE}' '1'`;
		const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `stderr: ${stderr}`).toBe(0);
		expect(stdout).toBe(buildCopilotHooksFile({ baseUrl: BASE, direct: true }));
	});
});

describe("hook-command-parity — install-local.ps1's New-ApHookCommand (static structural check; never executed)", () => {
	test("the function body contains the same distinctive D13 markers as buildPowerShellHookCommand's output, in the same order", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const start = ps1.indexOf("# >>> agentpulse-hook-cmd");
		const end = ps1.indexOf("function New-ApCodexHooksFile");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(-1);
		const body = ps1.slice(start, end);

		const expected = buildBashHookCommand({
			baseUrl: BASE,
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(expected).toContain("mktemp"); // sanity: the bash reference shape

		// Distinctive D13 markers — proves the PowerShell implementation
		// shares the same detached-and-cleanup shape as the bash/TS reference
		// even though the languages (and PowerShell's pre-declare-then-return
		// structure) differ enough that source-text order isn't meaningful.
		const markers = [
			"ErrorActionPreference",
			"agentpulse-hooks",
			"[Console]::In.ReadToEnd()",
			"hook-auth-header",
			"session_id",
			"codex-native",
			"Start-Job",
			"curl.exe",
			"--max-time",
			"X-Agent-Type",
			"data-binary",
			"Remove-Item",
			"AddMinutes(-5)",
			"exit 0",
		];
		for (const marker of markers) {
			expect(body, `expected marker ${JSON.stringify(marker)}`).toContain(marker);
		}
	});

	test("the marker hole sits INSIDE the Start-Job block of the template, and the marker reads the temp file itself", () => {
		const startJob = PS_COMMAND_TEMPLATE.indexOf("Start-Job -ScriptBlock {");
		const markerHole = PS_COMMAND_TEMPLATE.indexOf("@@AP_MARKER@@");
		expect(startJob).toBeGreaterThan(-1);
		expect(markerHole).toBeGreaterThan(startJob);
		expect(PS_CODEX_MARKER_PIECE).toContain("[IO.File]::ReadAllText($t)");
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const body = ps1.slice(
			ps1.indexOf("function New-ApHookCommand"),
			ps1.indexOf("function New-ApCodexHooksFile"),
		);
		// the marker is only supplied for Codex
		expect(body).toMatch(
			/if \(\$AgentType -eq "codex_cli"\) \{\n\s+\$marker = " {2}" \+ \$script:ApPsMarkerPiece \+ "`n"/,
		);
	});

	test("New-ApCodexHooksFile emits all 12 events with async=$false, timeout=1, no matcher key", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const start = ps1.indexOf("function New-ApCodexHooksFile");
		const end = ps1.indexOf("function New-ApCopilotBashHookCommand");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(-1);
		const body = ps1.slice(start, end);
		expect(body).not.toContain("matcher");
		expect(body).toContain("async = $false");
		expect(body).toContain("timeout = 1");
		const expected = buildCodexHooksFile({ baseUrl: BASE, direct: true });
		const parsed = JSON.parse(expected);
		for (const event of Object.keys(parsed.hooks)) {
			expect(body).toContain(`"${event}"`);
		}
	});

	test("New-ApCopilotHooksFile emits all 10 CopilotEvent keys with type=command, timeoutSec=5, both bash and powershell handlers, no preToolUse/permissionRequest", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const start = ps1.indexOf("function New-ApCopilotBashHookCommand");
		const end = ps1.indexOf("function New-ApHookAuthHeaderFile");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(-1);
		const body = ps1.slice(start, end);
		expect(body).toContain('type = "command"');
		expect(body).toContain("timeoutSec = 5");
		expect(body).toContain("$bash");
		expect(body).toContain("$ps");
		expect(body).not.toContain("preToolUse");
		expect(body).not.toContain("permissionRequest");
		const expected = buildCopilotHooksFile({ baseUrl: BASE, direct: true });
		const parsed = JSON.parse(expected);
		for (const event of Object.keys(parsed.hooks)) {
			expect(body).toContain(`"${event}"`);
		}
	});

	test("F232/F233 (xander, Medium, static structural check): Test-ApReparsePoint and Write-ApFileNoFollow exist and are wired into every write site — real execution is scripts/test-install-local.ps1, run by Windows CI", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");

		expect(ps1).toContain("function Test-ApReparsePoint");
		expect(ps1).toContain("function Write-ApFileNoFollow");
		// F232: LinkType alone misses junctions/mount points without one —
		// the ReparsePoint attribute check is the part that actually covers
		// those.
		expect(ps1).toContain(".LinkType");
		expect(ps1).toContain("ReparsePoint");
		// F232: Write-ApFileNoFollow refuses at $Path and at the parent dir,
		// then writes via a temp file + atomic Move-Item — never a bare
		// Set-Content/Copy-Item at the final path.
		const writeFn = ps1.slice(
			ps1.indexOf("function Write-ApFileNoFollow"),
			ps1.indexOf("function New-ApHookAuthHeaderFile"),
		);
		expect(writeFn).toContain("Test-ApReparsePoint -Path $Path");
		expect(writeFn).toContain("Test-ApReparsePoint -Path $dir");
		expect(writeFn).toContain("Move-Item -Force");
		expect(writeFn).not.toMatch(/Set-Content[^\n]*-Path \$Path\b/);

		// F232: the 4 hooks.json write sites (Codex write+backup, Copilot
		// write+backup) all go through Write-ApFileNoFollow, not
		// Set-Content/Copy-Item directly.
		const configureHooks = ps1.slice(
			ps1.indexOf("function Configure-Hooks"),
			ps1.indexOf("function New-TaskActionForPowerShell"),
		);
		const noFollowCalls = configureHooks.match(/Write-ApFileNoFollow/g) ?? [];
		expect(noFollowCalls.length).toBe(4);
		expect(configureHooks).not.toContain("Copy-Item");
		expect(configureHooks).not.toMatch(/Set-Content[^\n]*hooksFile/);

		// F233: New-ApHookAuthHeaderFile checks both the parent .agentpulse
		// directory and the file itself before writing.
		const authFn = ps1.slice(
			ps1.indexOf("function New-ApHookAuthHeaderFile"),
			ps1.indexOf("# The shell check as written to disk"),
		);
		const reparseChecks = authFn.match(/Test-ApReparsePoint -Path/g) ?? [];
		expect(reparseChecks.length).toBe(2);
	});
});

describe("F234 (Low): the rendered GET /setup.sh honors AGENTPULSE_KEY without a --key flag", () => {
	// The installer picks the rc file from $SHELL. Left unset, bash fills in the
	// invoking user's login shell, so the result depended on who ran the test.
	test.each([
		["/bin/zsh", ".zshrc"],
		["/bin/bash", ".bashrc"],
	])(
		"AGENTPULSE_KEY in the environment, no --key, SHELL=%s: hook-auth-header is written with that key and the rc file is %s",
		async (loginShell, rcName) => {
			const { mkdtemp, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");

			const { setup } = await import("../src/server/routes/setup.ts");
			const app = new Hono().route("/", setup);
			const res = await app.request("http://localhost/setup.sh", {
				headers: { Host: "localhost:3000" },
			});
			const rendered = await res.text();

			const home = await mkdtemp(join(tmpdir(), "ap-setup-sh-envkey-"));
			try {
				const proc = Bun.spawn(["bash", "-c", rendered, "installer"], {
					stdout: "pipe",
					stderr: "pipe",
					env: {
						PATH: process.env.PATH ?? "/usr/bin:/bin",
						HOME: home,
						AGENTPULSE_KEY: "ap_from_env_not_argv",
						SHELL: loginShell,
					},
				});
				await proc.exited;
				const headerFile = Bun.file(join(home, ".agentpulse", "hook-auth-header"));
				expect(await headerFile.exists()).toBe(true);
				expect(await headerFile.text()).toBe("Authorization: Bearer ap_from_env_not_argv\n");

				// The key lands in ~/.agentpulse/env (0600), never the
				// rc file — only a key-free source line goes there.
				const { stat } = await import("node:fs/promises");
				const envPath = join(home, ".agentpulse", "env");
				const envFile = await Bun.file(envPath).text();
				expect(envFile).toContain('export AGENTPULSE_API_KEY="ap_from_env_not_argv"');
				expect((await stat(envPath)).mode & 0o777).toBe(0o600);
				const rcFile = await Bun.file(join(home, rcName)).text();
				expect(rcFile).not.toContain("ap_from_env_not_argv");
				expect(rcFile).toContain('[ -f "$HOME/.agentpulse/env" ] && . "$HOME/.agentpulse/env"');
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		},
	);
});

describe("F246 (High, codex r2 D38): the rendered GET /setup.sh refuses to write anything against an auth-enabled server with no key", () => {
	function startAuthStub(disableAuth: boolean) {
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/api/v1/auth/me") {
					return Response.json({ authenticated: false, user: null, disableAuth });
				}
				if (url.pathname === "/api/v1/health") {
					return Response.json({ status: "ok" });
				}
				return new Response("not found", { status: 404 });
			},
		});
		return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
	}

	async function runRendered(home: string, args: string[], env: Record<string, string> = {}) {
		const { setup } = await import("../src/server/routes/setup.ts");
		const app = new Hono().route("/", setup);
		const res = await app.request("http://localhost/setup.sh", {
			headers: { Host: "localhost:3000" },
		});
		const rendered = await res.text();
		const proc = Bun.spawn(["bash", "-c", rendered, "installer", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		return { code: proc.exitCode, out: stdout + stderr };
	}

	test("auth enabled, no --key/AGENTPULSE_KEY: exits non-zero, writes nothing", async () => {
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const stub = startAuthStub(false);
		const home = await mkdtemp(join(tmpdir(), "ap-f246-noauth-"));
		try {
			const res = await runRendered(home, ["--url", stub.url]);
			expect(res.code).not.toBe(0);
			expect(res.out).toMatch(/requires an API key/);
			expect(await Bun.file(join(home, ".claude", "settings.json")).exists()).toBe(false);
			expect(await Bun.file(join(home, ".codex", "hooks.json")).exists()).toBe(false);
		} finally {
			stub.stop();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("auth enabled, a key IS supplied: proceeds and writes the hooks", async () => {
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const stub = startAuthStub(false);
		const home = await mkdtemp(join(tmpdir(), "ap-f246-withkey-"));
		try {
			const res = await runRendered(home, ["--url", stub.url, "--key", "ap_test123"]);
			expect(res.code).toBe(0);
			expect(await Bun.file(join(home, ".claude", "settings.json")).exists()).toBe(true);
			expect(await Bun.file(join(home, ".codex", "hooks.json")).exists()).toBe(true);
		} finally {
			stub.stop();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("auth disabled, no key: proceeds and writes the hooks", async () => {
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const stub = startAuthStub(true);
		const home = await mkdtemp(join(tmpdir(), "ap-f246-disabled-"));
		try {
			const res = await runRendered(home, ["--url", stub.url]);
			expect(res.code).toBe(0);
			expect(await Bun.file(join(home, ".claude", "settings.json")).exists()).toBe(true);
			expect(await Bun.file(join(home, ".codex", "hooks.json")).exists()).toBe(true);
		} finally {
			stub.stop();
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("F247 (High, codex r2 D38): the rendered GET /setup.sh writes Copilot hooks when Copilot is detected", () => {
	async function runRendered(
		home: string,
		args: string[],
		pathPrefix?: string,
		fullPath?: string,
	): Promise<{ code: number | null; out: string }> {
		const { setup } = await import("../src/server/routes/setup.ts");
		const app = new Hono().route("/", setup);
		const res = await app.request("http://localhost/setup.sh", {
			headers: { Host: "localhost:3000" },
		});
		const rendered = await res.text();
		const proc = Bun.spawn(["bash", "-c", rendered, "installer", ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH:
					fullPath ?? `${pathPrefix ? `${pathPrefix}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`,
				HOME: home,
			},
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		return { code: proc.exitCode, out: stdout + stderr };
	}

	test("copilot detected (stub binary on PATH): writes ~/.copilot/hooks/agentpulse.json matching buildCopilotHooksFile", async () => {
		const { mkdtemp, rm, writeFile, chmod } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { buildCopilotHooksFile } = await import("../src/shared/hook-command.ts");

		const home = await mkdtemp(join(tmpdir(), "ap-f247-detected-"));
		const stubDir = await mkdtemp(join(tmpdir(), "ap-f247-copilot-stub-"));
		await writeFile(join(stubDir, "copilot"), "#!/bin/sh\nexit 0\n");
		await chmod(join(stubDir, "copilot"), 0o755);
		try {
			const res = await runRendered(home, ["--key", "ap_test123"], stubDir);
			expect(res.code).toBe(0);
			const copilotFile = join(home, ".copilot", "hooks", "agentpulse.json");
			const written = await Bun.file(copilotFile).text();
			// F247's block calls ap_copilot_hooks_json with the script's
			// resolved default HOOK_URL — compare structurally (event set,
			// shape), not byte-for-byte against a fixed baseUrl.
			const parsed = JSON.parse(written);
			const expected = JSON.parse(buildCopilotHooksFile({ baseUrl: "http://x", direct: true }));
			expect(Object.keys(parsed.hooks).sort()).toEqual(Object.keys(expected.hooks).sort());
			expect(parsed.version).toBe(1);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(stubDir, { recursive: true, force: true });
		}
	});

	test("copilot NOT detected: no copilot file written, Claude/Codex still configured", async () => {
		const { mkdtemp, rm, mkdir, readdir, symlink } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const home = await mkdtemp(join(tmpdir(), "ap-f247-notdetected-"));
		// D8/installers-run.test.ts's own note applies here too: a real
		// `copilot` binary may already be installed on this machine's PATH
		// (this repo's own Phase 0 spike did, via Homebrew) — dropping the
		// whole directory that contains it would break python3/curl/etc
		// that share it. Mirror each PATH dir containing `copilot` into a
		// symlink-only copy with just that one entry omitted.
		const inherited = (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(Boolean);
		const mirrorRoot = await mkdtemp(join(tmpdir(), "ap-f247-path-mirror-"));
		const sanitizedDirs: string[] = [];
		for (const [i, dir] of inherited.entries()) {
			const hasCopilot = await Bun.file(join(dir, "copilot")).exists();
			if (!hasCopilot) {
				sanitizedDirs.push(dir);
				continue;
			}
			const mirror = join(mirrorRoot, String(i));
			await mkdir(mirror, { recursive: true });
			for (const entry of await readdir(dir)) {
				if (entry === "copilot") continue;
				try {
					await symlink(join(dir, entry), join(mirror, entry));
				} catch {
					// Dangling/unreadable entry — skip rather than fail the mirror.
				}
			}
			sanitizedDirs.push(mirror);
		}
		const sanitizedPath = sanitizedDirs.join(":");
		try {
			const res = await runRendered(home, ["--key", "ap_test123"], undefined, sanitizedPath);
			expect(res.code).toBe(0);
			expect(await Bun.file(join(home, ".copilot", "hooks", "agentpulse.json")).exists()).toBe(
				false,
			);
			expect(await Bun.file(join(home, ".claude", "settings.json")).exists()).toBe(true);
			expect(await Bun.file(join(home, ".codex", "hooks.json")).exists()).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("backup rotation: a pre-existing Copilot hooks file is backed up once, unchanged re-runs skip re-writing", async () => {
		const { mkdtemp, rm, mkdir, writeFile, chmod, readdir } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");

		const home = await mkdtemp(join(tmpdir(), "ap-f247-backup-"));
		const stubDir = await mkdtemp(join(tmpdir(), "ap-f247-copilot-stub-"));
		await writeFile(join(stubDir, "copilot"), "#!/bin/sh\nexit 0\n");
		await chmod(join(stubDir, "copilot"), 0o755);
		try {
			await mkdir(join(home, ".copilot", "hooks"), { recursive: true });
			await writeFile(
				join(home, ".copilot", "hooks", "agentpulse.json"),
				'{"hooks":{"custom":"mine"}}\n',
			);
			const res1 = await runRendered(home, ["--key", "ap_test123"], stubDir);
			expect(res1.code).toBe(0);
			const dirAfterRun1 = await readdir(join(home, ".copilot", "hooks"));
			const backups1 = dirAfterRun1.filter((f) => f.includes("agentpulse-bak"));
			expect(backups1).toHaveLength(1);

			const res2 = await runRendered(home, ["--key", "ap_test123"], stubDir);
			expect(res2.code).toBe(0);
			expect(res2.out).toContain("Copilot hooks unchanged");
			const dirAfterRun2 = await readdir(join(home, ".copilot", "hooks"));
			const backups2 = dirAfterRun2.filter((f) => f.includes("agentpulse-bak"));
			expect(backups2).toHaveLength(1);
		} finally {
			await rm(home, { recursive: true, force: true });
			await rm(stubDir, { recursive: true, force: true });
		}
	});
});

describe("hook-command-parity — every shell installer carries the check script and the hook command's pieces, held byte-identical to the generator", () => {
	const scriptHeredoc = `<<'AP_EXCLUDE_SCRIPT_EOF' || true\n${buildBashExcludeScriptForInstaller()}AP_EXCLUDE_SCRIPT_EOF\n`;
	const markerHeredoc = `<<'AP_MARKER_PIECE_EOF' || true\n${CODEX_MARKER_SH_PIECE}\nAP_MARKER_PIECE_EOF\n`;
	const gateHeredoc = `<<'AP_GATE_PIECE_EOF' || true\n${SH_GATE_PIECE}\nAP_GATE_PIECE_EOF\n`;

	for (const site of ["scripts/setup-relay.sh", "scripts/setup-hooks.sh"]) {
		test(`${site} carries the generator's script, marker and gate text in its here-documents, each once`, () => {
			const source = readFileSync(join(ROOT, site), "utf-8");
			for (const heredoc of [scriptHeredoc, markerHeredoc, gateHeredoc]) {
				expect(source.split(heredoc).length - 1).toBe(1);
			}
			expect(source).not.toContain("ap_load_exclude_snippet");
			expect(source).not.toContain("AP_EXCLUDE_SNIPPET_EOF");
		});
	}

	test("the rendered GET /setup.sh carries the generator's script, marker and gate text in its here-documents", async () => {
		const { setup } = await import("../src/server/routes/setup.ts");
		const app = new Hono().route("/", setup);
		const res = await app.request("http://localhost/setup.sh", {
			headers: { Host: "localhost:3000" },
		});
		const rendered = await res.text();
		for (const heredoc of [scriptHeredoc, markerHeredoc, gateHeredoc]) {
			expect(rendered).toContain(heredoc);
		}
	});

	test("install-local.ps1 carries both scripts, both command templates and every piece as literal here-strings, byte-identical to the generator (by reading; never executed)", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		// A PowerShell here-string holds its text without the newline before the closing '@.
		const literal = (name: string, text: string) =>
			`$script:${name} = @'\n${text.endsWith("\n") ? text : `${text}\n`}'@\n`;
		const cases: [string, string][] = [
			["ApExcludePsScript", buildPowerShellExcludeScript()],
			["ApExcludeBashScript", buildBashExcludeScriptForInstaller()],
			["ApShCommandTemplate", `${SH_COMMAND_TEMPLATE}`],
			["ApShGatePiece", SH_GATE_PIECE],
			["ApPsCommandTemplate", PS_COMMAND_TEMPLATE],
			["ApPsPreludePiece", PS_PRELUDE_PIECE],
			["ApPsMarkerPiece", PS_CODEX_MARKER_PIECE],
			["ApPsGatePiece", PS_GATE_PIECE],
		];
		for (const [name, text] of cases) {
			expect(ps1.split(literal(name, text)).length - 1, name).toBe(1);
		}
	});

	test("install-local.ps1 normalises CRLF to LF in every carried text, and in the shell script after the placeholders are restored (by reading; never executed)", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		expect(ps1).toContain('.Replace("`r`n", "`n")');
		const loop = ps1.slice(
			ps1.indexOf("foreach ($apName in @("),
			ps1.indexOf("function New-ApHookCommand"),
		);
		for (const name of [
			"ApExcludePsScript",
			"ApExcludeBashScript",
			"ApShCommandTemplate",
			"ApShGatePiece",
			"ApPsCommandTemplate",
			"ApPsPreludePiece",
			"ApPsMarkerPiece",
			"ApPsGatePiece",
		]) {
			expect(loop).toContain(`'${name}'`);
		}
		const fn = ps1.slice(
			ps1.indexOf("function Get-ApExcludeBashScriptText"),
			ps1.indexOf("function Install-ApExcludeScripts"),
		);
		expect(fn.indexOf("'@@AP_BOM@@'")).toBeLessThan(fn.lastIndexOf('.Replace("`r`n", "`n")'));
	});

	test("no installer source holds a literal CR or BOM (the snippet's invisible characters are placeholders)", () => {
		for (const site of [
			"scripts/setup-relay.sh",
			"scripts/setup-hooks.sh",
			"scripts/install-local.ps1",
			"src/server/routes/setup.ts",
		]) {
			const source = readFileSync(join(ROOT, site), "utf-8");
			expect(/[\r\uFEFF]/.test(source), site).toBe(false);
		}
	});

	test("install-local.ps1's Copilot bash command fills the generator's template: marker empty, the gate, the send (by reading; never executed)", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const start = ps1.indexOf("function New-ApCopilotBashHookCommand");
		const end = ps1.indexOf("function New-ApCopilotHooksFile");
		const body = ps1.slice(start, end);
		expect(body).toContain("$command = $script:ApShCommandTemplate");
		expect(body).toContain("$command.Replace('@@AP_MARKER@@', '')");
		expect(body).toContain("$command.Replace('@@AP_GATE@@', $script:ApShGatePiece)");
		expect(body).toContain("$command.Replace('@@AP_SEND@@', $send)");
		// and the template has exactly those three holes
		expect([...SH_COMMAND_TEMPLATE.matchAll(/@@AP_[A-Z_]+@@/g)].map((m) => m[0])).toEqual([
			"@@AP_MARKER@@",
			"@@AP_GATE@@",
			"@@AP_SEND@@",
		]);
	});

	test("install-local.ps1's New-ApHookCommand fills every hole of the generator's PowerShell template, once each (by reading; never executed)", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const body = ps1.slice(
			ps1.indexOf("function New-ApHookCommand"),
			ps1.indexOf("function New-ApCodexHooksFile"),
		);
		const holes = [
			...new Set([...PS_COMMAND_TEMPLATE.matchAll(/@@AP_[A-Z_]+@@/g)].map((m) => m[0])),
		];
		expect(holes.sort()).toEqual(
			[
				"@@AP_AGENT@@",
				"@@AP_AUTH_ARG@@",
				"@@AP_GATE@@",
				"@@AP_HEADER_FILE@@",
				"@@AP_MARKER@@",
				"@@AP_PRELUDE@@",
				"@@AP_URL@@",
			].sort(),
		);
		for (const hole of holes) {
			expect(body.split(`.Replace('${hole}',`).length - 1, hole).toBe(1);
		}
		expect(body).toContain("$command = $script:ApPsCommandTemplate");
	});

	test("install-local.ps1 installs both check scripts through the no-follow writer, before the hooks are written (by reading; never executed)", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const fn = ps1.slice(
			ps1.indexOf("function Install-ApExcludeScripts"),
			ps1.indexOf("# <<< agentpulse-hook-cmd"),
		);
		expect(fn).toContain("Test-ApReparsePoint -Path $dir");
		expect(fn).toContain('"exclude-check.sh"');
		expect(fn).toContain('"exclude-check.ps1"');
		expect(fn).toContain("Write-ApFileNoFollow -Path $file.Path -Content $file.Content");
		const configure = ps1.slice(
			ps1.indexOf("function Configure-Hooks"),
			ps1.indexOf("function New-TaskActionForPowerShell"),
		);
		expect(configure.indexOf("Install-ApExcludeScripts")).toBeGreaterThan(-1);
		expect(configure.indexOf("Install-ApExcludeScripts")).toBeLessThan(
			configure.indexOf("New-ApCodexHooksFile"),
		);
	});
});

describe("hook-command-parity — the checked-in Codex golden is the generator's output", () => {
	test("scripts/__golden__/codex-hooks.direct.json equals buildCodexHooksFile for http://localhost:3000, direct", () => {
		const golden = readFileSync(join(ROOT, "scripts/__golden__/codex-hooks.direct.json"), "utf-8");
		const generated = buildCodexHooksFile({ baseUrl: "http://localhost:3000", direct: true });
		// The golden is stored tab-indented; compare the parsed structure and the
		// commands byte for byte.
		expect(JSON.parse(golden)).toEqual(JSON.parse(generated));
	});
});

describe("the Windows installer test script's inputs (scripts/test-install-local.ps1; never executed)", () => {
	const TEST_PS1 = readFileSync(join(ROOT, "scripts/test-install-local.ps1"), "utf-8");

	/** The PowerShell Codex hooks file builder, looked up by name so its absence is a test failure and not an import error. */
	function buildPowerShellCodexHooksFile(opts: { baseUrl: string; direct: boolean }): string {
		const fn = (hookCommandModule as unknown as Record<string, unknown>)
			.buildPowerShellCodexHooksFile;
		if (typeof fn !== "function") throw new Error("buildPowerShellCodexHooksFile is not exported");
		return (fn as (o: object) => string)(opts);
	}

	test("the PowerShell golden is the PowerShell builder's output (PowerShell commands, the same file shape as the shell golden)", () => {
		const golden = readFileSync(
			join(ROOT, "scripts/__golden__/codex-hooks.direct.powershell.json"),
			"utf-8",
		);
		const generated = buildPowerShellCodexHooksFile({
			baseUrl: "http://localhost:3000",
			direct: true,
		});
		expect(JSON.parse(golden)).toEqual(JSON.parse(generated));
		const commands = Object.values(JSON.parse(golden).hooks).map(
			(e) => (e as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command ?? "",
		);
		expect(commands).toHaveLength(12);
		for (const command of commands) {
			expect(command).toContain("Start-Job");
			expect(command).not.toContain("/bin/sh");
			expect(command.length).toBeLessThan(8191);
		}
	});

	test("the shell golden and the PowerShell golden are different files with different commands", () => {
		const shell = readFileSync(join(ROOT, "scripts/__golden__/codex-hooks.direct.json"), "utf-8");
		const powershell = readFileSync(
			join(ROOT, "scripts/__golden__/codex-hooks.direct.powershell.json"),
			"utf-8",
		);
		expect(powershell).not.toBe(shell);
		expect(shell).not.toContain("Start-Job");
	});

	test("the test script compares New-ApCodexHooksFile with the PowerShell golden, never the shell one", () => {
		expect(TEST_PS1).toContain("codex-hooks.direct.powershell.json");
		expect(TEST_PS1).not.toContain("__golden__/codex-hooks.direct.json");
	});

	test("the test script expects what the installer emits for the skip variable: allowedEnvVars exactly AGENTPULSE_SKIP with a key, the skip header at every event", () => {
		expect(TEST_PS1).not.toContain("no allowedEnvVars when a key was supplied");
		expect(TEST_PS1).toContain("allowedEnvVars is exactly AGENTPULSE_SKIP");
		expect(TEST_PS1).toContain("X-AgentPulse-Skip");
		expect(TEST_PS1).toContain("AGENTPULSE_API_KEY,AGENTPULSE_SKIP");
	});

	test("without a key the installer writes no Authorization header, so the test no longer looks for an environment-variable placeholder in the file", () => {
		expect(TEST_PS1).not.toContain("settings.json references `$env:AGENTPULSE_API_KEY");
		expect(TEST_PS1).toContain("no Authorization header is written");
	});

	test("the test script waits for the detached job before reading its marker, and checks the installed scripts and the command sizes", () => {
		expect(TEST_PS1).toContain("function Wait-ApHookJob");
		expect(TEST_PS1).toContain("exclude-check.sh");
		expect(TEST_PS1).toContain("exclude-check.ps1");
		expect(TEST_PS1).toContain("-lt 8191");
	});
});

describe("install-local.ps1's command builders, evaluated and compared with the generator (never executed: no PowerShell host runs; a small evaluator runs the builders' own statements)", () => {
	const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8").replace(/\r\n/g, "\n");

	/** The here-string literals the installer carries, as PowerShell reads them (without the newline before the closing marker). */
	function carried(name: string): string {
		const m = new RegExp(`\\$script:${name} = @'\\n([\\s\\S]*?)\\n'@\\n`).exec(ps1);
		if (!m) throw new Error(`here-string ${name} not found`);
		return m[1] as string;
	}
	const scriptVars = () => ({
		"script:ApShCommandTemplate": carried("ApShCommandTemplate"),
		"script:ApShGatePiece": carried("ApShGatePiece"),
		"script:ApPsCommandTemplate": carried("ApPsCommandTemplate"),
		"script:ApPsPreludePiece": carried("ApPsPreludePiece"),
		"script:ApPsMarkerPiece": carried("ApPsMarkerPiece"),
		"script:ApPsGatePiece": carried("ApPsGatePiece"),
	});

	const EVENTS: [string, string][] = [
		["codex_cli", "SessionStart"],
		["codex_cli", "Stop"],
		["copilot_cli", "sessionStart"],
		["copilot_cli", "agentStop"],
	];
	const URLS = ["http://localhost:4000", "https://agentpulse.example.test", "http://[::1]:3000"];

	for (const baseUrl of URLS) {
		for (const direct of [false, true]) {
			test(`New-ApCopilotBashHookCommand builds exactly buildBashHookCommand's text [${baseUrl}, direct=${direct}]`, () => {
				const body = psFunctionBody(ps1, "New-ApCopilotBashHookCommand");
				for (const event of ["sessionStart", "agentStop", "errorOccurred"]) {
					const scope = runPsBuilder(body, {
						BaseUrl: baseUrl,
						Direct: direct,
						EventName: event,
						...scriptVars(),
					});
					expect(scope.command).toBe(
						buildBashHookCommand({ baseUrl, direct, agent: "copilot_cli", event }),
					);
				}
			});

			test(`New-ApHookCommand builds exactly buildPowerShellHookCommand's text for Codex and Copilot [${baseUrl}, direct=${direct}]`, () => {
				const body = psFunctionBody(ps1, "New-ApHookCommand");
				for (const [agent, event] of EVENTS) {
					const scope = runPsBuilder(body, {
						BaseUrl: baseUrl,
						Direct: direct,
						AgentType: agent,
						EventName: event,
						...scriptVars(),
					});
					expect(scope.command, `${agent} ${event}`).toBe(
						buildPowerShellHookCommand({ baseUrl, direct, agent, event }),
					);
				}
			});
		}
	}

	test("the evaluator is not vacuous: breaking one hole fill in a copy of the function makes the comparison fail", () => {
		const body = psFunctionBody(ps1, "New-ApCopilotBashHookCommand").replace(
			"$command.Replace('@@AP_SEND@@', $send)",
			"$command.Replace('@@AP_SEND@@', $withoutHeader)",
		);
		const scope = runPsBuilder(body, {
			BaseUrl: "http://localhost:4000",
			Direct: true,
			EventName: "agentStop",
			...scriptVars(),
		});
		expect(scope.command).not.toBe(
			buildBashHookCommand({
				baseUrl: "http://localhost:4000",
				direct: true,
				agent: "copilot_cli",
				event: "agentStop",
			}),
		);
	});

	test("the evaluator refuses a statement outside its subset instead of skipping it", () => {
		const body = `${psFunctionBody(ps1, "New-ApCopilotBashHookCommand")}\n  $command = Get-Date\n`;
		expect(() =>
			runPsBuilder(body, {
				BaseUrl: "http://localhost:4000",
				Direct: false,
				EventName: "agentStop",
				...scriptVars(),
			}),
		).toThrow(/outside the evaluator's subset/);
	});
});

describe("install-local.ps1 writes the installed files without a byte order mark and reads the checks back (by reading; never executed)", () => {
	const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
	const fn = (name: string): string => {
		const start = ps1.indexOf(`function ${name}`);
		expect(start, name).toBeGreaterThan(-1);
		const end = ps1.indexOf("\n}\n", start);
		return ps1.slice(start, end);
	};

	test("Write-ApFileNoFollow does not use Set-Content -Encoding UTF8, which writes a byte order mark in Windows PowerShell 5.1", () => {
		const body = fn("Write-ApFileNoFollow");
		expect(body).not.toContain("-Encoding UTF8");
		expect(body).toContain("UTF8Encoding($false)");
		expect(body).toContain("[System.IO.File]::WriteAllText($tmp");
	});

	test("Install-ApExcludeScripts reads each installed file back, compares it with what it meant to write, and removes a mismatch", () => {
		const body = fn("Install-ApExcludeScripts");
		expect(body).toContain("[System.IO.File]::ReadAllText($file.Path");
		expect(body).toContain("-ne $file.Content");
		expect(body).toContain("Remove-Item -LiteralPath $file.Path");
		expect(body).toContain("could not be verified");
	});
});

describe("the PowerShell gate treats an invalid marker like the shell gate does (by reading; never executed)", () => {
	const MARKER_PROBE = [
		"    if (-not $apHand) {",
		"      try { $null = Get-Item -LiteralPath (Join-Path $apDir 'exclude.invalid') -Force -ErrorAction Stop; $apHand = $true }",
		"      catch [System.Management.Automation.ItemNotFoundException] { }",
		"      catch [System.Management.Automation.DriveNotFoundException] { }",
		"      catch { $apHand = $true }",
		"    }",
	].join("\n");

	test("with no rules file but a marker present, the check script still decides: the marker is probed with the rules file's own three-way catch, before the hand-over", () => {
		const rulesProbe = PS_GATE_PIECE.indexOf("(Join-Path $apDir 'exclude') -Force");
		const markerProbe = PS_GATE_PIECE.indexOf(MARKER_PROBE);
		const handOver = PS_GATE_PIECE.indexOf("    if ($apHand) {");
		expect(rulesProbe).toBeGreaterThan(-1);
		expect(markerProbe).toBeGreaterThan(rulesProbe);
		expect(handOver).toBeGreaterThan(markerProbe);
	});

	test("the shell gate does the same (the behaviour being matched)", () => {
		expect(SH_GATE_PIECE).toContain(
			'[ ! -e "$d/exclude.invalid" ] && [ ! -L "$d/exclude.invalid" ]',
		);
	});
});
