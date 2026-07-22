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

	test("canOrchestrate:true includes the default_tools_approval_mode governance line (H2)", () => {
		const out = emitCodexToml({
			url: "http://localhost:3000",
			keyRef: "ap_x",
			canOrchestrate: true,
		});
		expect(out).toContain("default_tools_approval_mode");
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
	test("default (no --orchestrate) → [observe]", () => {
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

	test("ingest-only key → refuses with a mint hint", async () => {
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
			/observe|manage|scope/i,
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
		expect(result.codexToml).toContain("default_tools_approval_mode");
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

	test("mint-with-auth precedence: when both --key and --mint are given, mint wins and --key is used only to authenticate the mint call", async () => {
		let authHeaderSeenViaClient = false;
		const client = fakeClient({
			createApiKey: async (name, scopes) => {
				authHeaderSeenViaClient = true;
				return { id: "k1", key: "ap_new_minted", name, scopes, message: "shown once" };
			},
		});

		const result = await runInstall(client, {
			url: "http://localhost:3000",
			key: "ap_bootstrap",
			mint: "mcp",
			orchestrate: false,
		});

		expect(authHeaderSeenViaClient).toBe(true);
		expect(result.keyRef).toBe("ap_new_minted");
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
});
