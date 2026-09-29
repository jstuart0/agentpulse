/**
 * Phase 5 (D12/D13): the shared hook-command generators. Pure-function tests
 * — no network, no filesystem. scripts/codex-hook-command.test.ts covers
 * actually executing the generated command; scripts/hook-command-parity.test.ts
 * covers the bash/PowerShell transcriptions matching this module byte for
 * byte.
 */
import { describe, expect, test } from "bun:test";
import {
	CODEX_EVENT_ORDER,
	assertValidHookBaseUrl,
	buildBashHookCommand,
	buildCodexHooksFile,
	buildPowerShellHookCommand,
} from "./hook-command.js";

const BASE = "http://localhost:4000";

describe("buildBashHookCommand — relay mode", () => {
	test("has no Authorization header and no hook-auth-header reference", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).not.toContain("Authorization");
		expect(cmd).not.toContain("hook-auth-header");
	});

	test("targets the right URL, event and agent header", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "copilot_cli",
			event: "sessionStart",
		});
		expect(cmd).toContain(`'${BASE}/api/v1/hooks?event=sessionStart'`);
		expect(cmd).toContain("-H 'X-Agent-Type: copilot_cli'");
	});
});

describe("buildBashHookCommand — direct mode", () => {
	test('references hook-auth-header via -H "@$f" and has no $(cat', () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: true,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain('-H "@$f"');
		expect(cmd).toContain("$HOME/.agentpulse/hook-auth-header");
		expect(cmd).not.toContain("$(cat");
	});
});

describe("buildBashHookCommand — byte stability (trust-hash-stability property)", () => {
	test("two calls with the same input produce byte-identical output", () => {
		const opts = {
			baseUrl: BASE,
			direct: true,
			agent: "codex_cli",
			event: "SessionStart",
		} as const;
		const a = buildBashHookCommand(opts);
		const b = buildBashHookCommand(opts);
		expect(a).toBe(b);
	});
});

describe("buildBashHookCommand — D13 shape (r6 detached)", () => {
	test('contains mktemp, a backgrounded subshell with all streams redirected, and --data-binary "@$t"', () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain("mktemp");
		expect(cmd).toContain("</dev/null >/dev/null 2>&1 &");
		expect(cmd).toContain('--data-binary "@$t"');
		expect(cmd).not.toContain("--data-binary @-");
		expect(cmd).not.toContain("$(cat");
	});

	test("ends with the literal D13 tail", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd.endsWith(") </dev/null >/dev/null 2>&1 & exit 0")).toBe(true);
	});

	test('no-stdout shape: only non-curl stdin/stdout operation is `cat > "$t"` — no echo/printf/tee/jq, no bare cat', () => {
		for (const agent of ["codex_cli", "copilot_cli"]) {
			for (const direct of [false, true]) {
				const cmd = buildBashHookCommand({ baseUrl: BASE, direct, agent, event: "Stop" });
				expect(cmd).not.toMatch(/\becho\b/);
				expect(cmd).not.toMatch(/\bprintf\b/);
				expect(cmd).not.toMatch(/\btee\b/);
				expect(cmd).not.toMatch(/\bjq\b/);
				// every `cat` must be immediately followed by a redirect (`cat > "$t"`)
				const bareCat = cmd.match(/\bcat\b(?!\s*>)/g);
				expect(bareCat).toBeNull();
			}
		}
	});
});

describe("buildBashHookCommand — Codex native-coverage marker (cross-campaign, event-dedup D12/D19)", () => {
	test("codex_cli commands include the marker snippet; copilot_cli commands don't", () => {
		const codex = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const copilot = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "copilot_cli",
			event: "agentStop",
		});
		expect(codex).toContain("codex-native");
		expect(copilot).not.toContain("codex-native");
	});

	test("marker write happens before the curl invocation, inside the subshell", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		const markerIdx = cmd.indexOf("codex-native");
		const curlIdx = cmd.indexOf("curl -sS");
		expect(markerIdx).toBeGreaterThan(-1);
		expect(curlIdx).toBeGreaterThan(-1);
		expect(markerIdx).toBeLessThan(curlIdx);
		// both must be inside the backgrounded subshell, i.e. after the opening "( "
		const subshellStart = cmd.indexOf("( ");
		expect(subshellStart).toBeGreaterThan(-1);
		expect(subshellStart).toBeLessThan(markerIdx);
	});

	test("uses $HOME, not $AGENTPULSE_DIR or $CODEX_HOME, for the marker path", () => {
		const cmd = buildBashHookCommand({
			baseUrl: BASE,
			direct: false,
			agent: "codex_cli",
			event: "Stop",
		});
		expect(cmd).toContain('"$HOME/.agentpulse/codex-native"');
		expect(cmd).not.toContain("AGENTPULSE_DIR");
		expect(cmd).not.toContain("CODEX_HOME");
	});
});

describe("buildBashHookCommand / buildPowerShellHookCommand — base URL validation (F41)", () => {
	const badUrls = [
		"http://localhost:4000'; rm -rf /",
		'http://localhost:4000"',
		"http://localhost:4000$(whoami)",
		"http://localhost:4000`whoami`",
		"http://localhost:4000 evil",
		"http://localhost:4000\nrm -rf /",
		"http://localhost:4000/path",
		"not-a-url",
	];

	for (const baseUrl of badUrls) {
		test(`buildBashHookCommand throws on ${JSON.stringify(baseUrl)}`, () => {
			expect(() =>
				buildBashHookCommand({ baseUrl, direct: false, agent: "codex_cli", event: "Stop" }),
			).toThrow();
		});
		test(`buildPowerShellHookCommand throws on ${JSON.stringify(baseUrl)}`, () => {
			expect(() =>
				buildPowerShellHookCommand({ baseUrl, direct: false, agent: "codex_cli", event: "Stop" }),
			).toThrow();
		});
		test(`assertValidHookBaseUrl throws on ${JSON.stringify(baseUrl)}`, () => {
			expect(() => assertValidHookBaseUrl(baseUrl)).toThrow();
		});
	}

	const goodUrls = [
		"http://localhost:4000",
		"https://agentpulse.example.com",
		"https://agentpulse.example.com:8443",
		"http://127.0.0.1:3000",
		"http://[::1]:4000",
	];
	for (const baseUrl of goodUrls) {
		test(`accepts ${baseUrl}`, () => {
			expect(() => assertValidHookBaseUrl(baseUrl)).not.toThrow();
		});
	}
});

describe("buildCodexHooksFile (D12)", () => {
	test("all 12 CodexEvent members are present, no matcher key anywhere", () => {
		const text = buildCodexHooksFile({ baseUrl: BASE, direct: false });
		const parsed = JSON.parse(text);
		expect(Object.keys(parsed.hooks).sort()).toEqual([...CODEX_EVENT_ORDER].sort());
		expect(text).not.toContain('"matcher"');
	});

	test("every handler is command + async:false + timeout:1", () => {
		const parsed = JSON.parse(buildCodexHooksFile({ baseUrl: BASE, direct: true }));
		for (const event of CODEX_EVENT_ORDER) {
			const handler = parsed.hooks[event][0].hooks[0];
			expect(handler.type).toBe("command");
			expect(handler.async).toBe(false);
			expect(handler.timeout).toBe(1);
			expect(typeof handler.command).toBe("string");
		}
	});

	test("no http type anywhere", () => {
		const text = buildCodexHooksFile({ baseUrl: BASE, direct: false });
		expect(text).not.toContain('"type": "http"');
		expect(text).not.toContain('"type":"http"');
	});

	test('serialized with JSON.stringify(x, null, 2) + "\\n" — trailing newline, two-space indent', () => {
		const text = buildCodexHooksFile({ baseUrl: BASE, direct: false });
		expect(text.endsWith("\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
		expect(text).toContain('\n  "hooks"');
	});

	test("byte-stable across repeated calls", () => {
		const opts = { baseUrl: BASE, direct: true };
		expect(buildCodexHooksFile(opts)).toBe(buildCodexHooksFile(opts));
	});

	test("keys are emitted in CODEX_EVENT_ORDER", () => {
		const parsed = JSON.parse(buildCodexHooksFile({ baseUrl: BASE, direct: false }));
		expect(Object.keys(parsed.hooks)).toEqual([...CODEX_EVENT_ORDER]);
	});
});
