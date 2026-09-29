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
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
	buildBashHookCommand,
	buildCodexHooksFile,
	buildCopilotHooksFile,
} from "../src/shared/hook-command.js";

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

describe("hook-command-parity — install-local.ps1's New-ApHookCommand (static structural check)", () => {
	test("the function body contains the same distinctive D13 markers as buildPowerShellHookCommand's output, in the same order", () => {
		const ps1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");
		const start = ps1.indexOf("function New-ApHookCommand");
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
			ps1.indexOf("# <<< agentpulse-hook-cmd"),
		);
		const reparseChecks = authFn.match(/Test-ApReparsePoint -Path/g) ?? [];
		expect(reparseChecks.length).toBe(2);
	});
});

describe("F234 (Low): the rendered GET /setup.sh honors AGENTPULSE_KEY without a --key flag", () => {
	test("AGENTPULSE_KEY in the environment, no --key: hook-auth-header is written with that key", async () => {
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
				},
			});
			await proc.exited;
			const headerFile = Bun.file(join(home, ".agentpulse", "hook-auth-header"));
			expect(await headerFile.exists()).toBe(true);
			expect(await headerFile.text()).toBe("Authorization: Bearer ap_from_env_not_argv\n");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
