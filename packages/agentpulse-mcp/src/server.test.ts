import { describe, expect, test } from "bun:test";
/**
 * Tests for server.ts — buildMcpServer, registerReadTool,
 * registerMutatingTool (AGEN-12 Phase 2, D3 seams 2-3, H5).
 *
 * Wrapper tests use a fake AgentPulseClient and, where the SDK's own
 * schema validation would intercept a bad call before the handler runs,
 * a real in-memory SDK Client/Server pair (D3 seam 3) so we're asserting
 * what actually crosses the wire, not implementation internals.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentPulseClient } from "./client.js";
import { ApiError } from "./client.js";
import {
	REQUIRES_USER_INTERACTION_META,
	type ToolContext,
	buildMcpServer,
	registerMutatingTool,
	registerReadTool,
} from "./server.js";
import { FAKE_STATS, fakeClient } from "./test-support.js";

function newContext(client: AgentPulseClient): ToolContext {
	const server = new McpServer({ name: "agentpulse-test", version: "0.0.0-test" });
	return { server, client, registry: [] };
}

describe("registerReadTool", () => {
	test("always sets annotations.readOnlyHint:true, even if not passed", () => {
		const ctx = newContext(fakeClient());
		registerReadTool(ctx, { name: "t1", description: "d" }, async () => ({}));
		expect(ctx.registry[0].annotations?.readOnlyHint).toBe(true);
		expect(ctx.registry[0].readOnly).toBe(true);
	});

	test("never stamps rUI meta", () => {
		const ctx = newContext(fakeClient());
		registerReadTool(ctx, { name: "t1", description: "d" }, async () => ({}));
		expect(ctx.registry[0].meta?.[REQUIRES_USER_INTERACTION_META]).toBeUndefined();
	});

	test("records the registration in ctx.registry", () => {
		const ctx = newContext(fakeClient());
		registerReadTool(ctx, { name: "t1", description: "d" }, async () => ({}));
		expect(ctx.registry.map((r) => r.name)).toEqual(["t1"]);
	});
});

describe("registerMutatingTool", () => {
	test("always stamps _meta[anthropic/requiresUserInteraction]:true, even when the handler doesn't set it", () => {
		const ctx = newContext(fakeClient());
		registerMutatingTool(ctx, { name: "m1", description: "d" }, async () => ({ ok: true }));
		expect(ctx.registry[0].meta?.[REQUIRES_USER_INTERACTION_META]).toBe(true);
		expect(ctx.registry[0].readOnly).toBe(false);
	});

	test("never sets annotations.readOnlyHint", () => {
		const ctx = newContext(fakeClient());
		registerMutatingTool(ctx, { name: "m1", description: "d" }, async () => ({ ok: true }));
		expect(ctx.registry[0].annotations?.readOnlyHint).toBeUndefined();
	});
});

/**
 * VD3 (Phase 4, catching up a Phase-2 deferred item): registerMutatingTool's
 * rUI stamping proven on the WIRE via a live InMemoryTransport tools/list —
 * Phase 2's coverage above only asserted against ctx.registry, which is the
 * wrapper's own bookkeeping (the same H-1 gap the drift guard's binding
 * correction closes for the full tool population; this closes it for the
 * registerMutatingTool unit itself, in isolation from any real tool file).
 */
describe("registerMutatingTool — rUI round-trips onto the wire (VD3, Phase 4 catch-up)", () => {
	test("a freshly-registered mutating tool carries rUI meta and no readOnlyHint in a live tools/list", async () => {
		const ctx = newContext(fakeClient());
		registerMutatingTool(ctx, { name: "vd3_mutating_tool", description: "d" }, async () => ({
			ok: true,
		}));

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "vd3-test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), ctx.server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		const tool = tools.find((t) => t.name === "vd3_mutating_tool");
		expect(tool).toBeDefined();
		expect(tool?.annotations?.readOnlyHint).toBeUndefined();
		expect(
			(tool?._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
		).toBe(true);
	});

	test("tools/call on a live mutating tool returns the handler's result, not isError", async () => {
		const ctx = newContext(fakeClient());
		registerMutatingTool(
			ctx,
			{ name: "vd3_callable_mutating_tool", description: "d" },
			async () => ({ applied: true }),
		);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "vd3-test-client-2", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), ctx.server.connect(serverTransport)]);

		const result = await mcpClient.callTool({ name: "vd3_callable_mutating_tool", arguments: {} });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(JSON.parse(text)).toEqual({ applied: true });
	});
});

describe("wrapper structural error mapping (fake client + direct handler invocation via in-memory protocol)", () => {
	test("a thrown ApiError from the handler is mapped to {isError:true}, not a protocol error", async () => {
		const ctx = newContext(fakeClient());
		registerReadTool(ctx, { name: "failing_tool", description: "d" }, async () => {
			throw new ApiError(403, { error: "insufficient_scope", required: "manage" });
		});

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([client.connect(clientTransport), ctx.server.connect(serverTransport)]);

		const result = await client.callTool({ name: "failing_tool", arguments: {} });
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toContain("manage");
	});

	test("an oversized handler result is auto-capped by the wrapper without the handler calling capList itself", async () => {
		const ctx = newContext(fakeClient());
		const bigList = Array.from({ length: 2000 }, (_, i) => ({ id: i, pad: "x".repeat(80) }));
		registerReadTool(ctx, { name: "oversized_tool", description: "d" }, async () => bigList);

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([client.connect(clientTransport), ctx.server.connect(serverTransport)]);

		const result = await client.callTool({ name: "oversized_tool", arguments: {} });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text.length).toBeLessThan(JSON.stringify(bigList).length);
	});
});

describe("in-memory protocol round-trip (D3 seam 3)", () => {
	test("initialize + tools/list includes get_stats for an observe-scoped server", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["observe"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.map((t) => t.name)).toContain("get_stats");
	});

	test("tools/call get_stats returns the mapped stats content, not isError", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["observe", "manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const result = await mcpClient.callTool({ name: "get_stats", arguments: {} });
		expect(result.isError).toBeFalsy();
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		const parsed = JSON.parse(text);
		expect(parsed).toEqual(FAKE_STATS);
	});

	test("get_stats carries readOnlyHint:true and no rUI meta in tools/list", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["observe"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		const getStats = tools.find((t) => t.name === "get_stats");
		expect(getStats?.annotations?.readOnlyHint).toBe(true);
		expect(
			(getStats?._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
		).toBeUndefined();
	});

	test("a server built with an empty scopes array registers no tools", async () => {
		const { registry } = buildMcpServer({ client: fakeClient(), scopes: [] });
		expect(registry.length).toBe(0);
	});

	test("a server built with only unrecognized scope strings still registers no tools (xander X6 fail-closed regression, never an all-tools fallback)", async () => {
		// In production, discoverScopes() throws before buildMcpServer ever
		// sees an unrecognized-only scopes array (scopes.test.ts pins that).
		// This case decouples the two: even called directly with garbage
		// content (not just an empty array — every registerXTools() gate is
		// `if (!flags.hasObserve && !flags.hasManage)`-shaped, so a future
		// edit that special-cased "non-empty array" instead of "recognized
		// scope present" would slip past the empty-array test above but not
		// this one), the registry must stay empty.
		const { registry } = buildMcpServer({ client: fakeClient(), scopes: ["admin"] });
		expect(registry.length).toBe(0);
	});

	test("a manage-only key still gets observe-gated read tools (manage implies observe-satisfied, D5)", async () => {
		const { registry } = buildMcpServer({ client: fakeClient(), scopes: ["manage"] });
		expect(registry.map((r) => r.name)).toContain("get_stats");
	});
});

describe("flat input schema (no root anyOf/oneOf/allOf) — schema-shape sanity for the one Phase 2 tool", () => {
	test("get_stats registers with a flat empty-object inputSchema", () => {
		let capturedSchema: unknown;
		const stubServer = {
			registerTool: (_name: string, config: { inputSchema?: unknown }) => {
				capturedSchema = config.inputSchema;
			},
		};
		const ctx = {
			server: stubServer,
			client: fakeClient(),
			registry: [],
		} as unknown as ToolContext;

		registerReadTool(
			ctx,
			{ name: "get_stats", description: "d", inputSchema: {} },
			async () => FAKE_STATS,
		);
		expect(capturedSchema).toEqual({});
	});
});

/**
 * Phase 3 registry-wide tests (test-contract Phase 3 assertions 14-15, plan
 * M7/M6): tools/list snapshot proving the C1 observe/manage split, the
 * schema-shape invariant over every registered tool (not just get_stats),
 * and the converse read-only check over the read registry.
 */
const OBSERVE_TOOL_NAMES = [
	"get_stats",
	"list_sessions",
	"get_session",
	"get_session_timeline",
	"get_event_context",
	"get_session_claude_md",
	"search",
	"get_session_intelligence",
	"get_digest",
	"get_ai_status",
];

// F23 (codex r2, post-Phase-5 reconcile): list_projects moved here from
// OBSERVE_TOOL_NAMES — mapProject() returns arbitrary operator-set
// notes/metadata and a githubRepoUrl that can carry userinfo credentials,
// the same DTO-leak class as the C1 launches/templates/inbox exclusion.
const MANAGE_ONLY_TOOL_NAMES = [
	"list_projects",
	"list_templates",
	"get_template",
	"list_launches",
	"get_launch",
	"get_inbox",
];

describe("tools/list — observe vs manage scope split (test-contract 14, C1 + F23)", () => {
	test("observe-scoped server registers exactly the 10 observe read tools, none of the 6 manage-only ones", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["observe"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		const names = new Set(tools.map((t) => t.name));
		expect(names).toEqual(new Set(OBSERVE_TOOL_NAMES));
		for (const manageOnly of MANAGE_ONLY_TOOL_NAMES) {
			expect(names.has(manageOnly)).toBe(false);
		}
	});

	// Phase 4 note: manage now registers 29 tools (16 Phase-3 read tools + 13
	// Phase-4 additions) — the exhaustive "manage registers exactly this set"
	// assertion now lives in tool-invariants.test.ts (assertion 20/21), which
	// owns the full current population. These two tests narrow to "the
	// Phase-3 read tools are still present under manage" — a superset check,
	// not an exhaustiveness claim — so they stay meaningful without
	// duplicating (and having to keep in lockstep with) the Phase-4 count.
	test("manage-scoped server still registers all 16 Phase-3 read tools (10 observe + 6 manage-only, post-F23)", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		const names = new Set(tools.map((t) => t.name));
		for (const name of [...OBSERVE_TOOL_NAMES, ...MANAGE_ONLY_TOOL_NAMES]) {
			expect(names.has(name), `${name} missing from manage scope`).toBe(true);
		}
	});

	test("dual scope (observe+manage) still includes every Phase-3 read tool", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["observe", "manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		const names = new Set(tools.map((t) => t.name));
		for (const name of [...OBSERVE_TOOL_NAMES, ...MANAGE_ONLY_TOOL_NAMES]) {
			expect(names.has(name), `${name} missing from dual scope`).toBe(true);
		}
	});
});

describe("every registered read tool: readOnlyHint + no rUI (test-contract 15) + flat schema (M7)", () => {
	// Phase 4 note: this test now scopes to the 16 Phase-3 read-tool NAMES
	// specifically (not "every tool in tools/list", which post-Phase-4
	// legitimately includes 10 non-RO mutating tools). The full-population
	// mixed RO/mutating invariant (assertion 16) lives in
	// tool-invariants.test.ts.
	test("every Phase-3 read tool still carries readOnlyHint:true and no anthropic/requiresUserInteraction meta", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		const phase3Names = new Set([...OBSERVE_TOOL_NAMES, ...MANAGE_ONLY_TOOL_NAMES]);
		const phase3Tools = tools.filter((t) => phase3Names.has(t.name));
		expect(phase3Tools.length).toBe(16);
		for (const tool of phase3Tools) {
			expect(tool.annotations?.readOnlyHint, `${tool.name} should be readOnlyHint:true`).toBe(true);
			expect(
				(tool._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
				`${tool.name} should carry no rUI meta`,
			).toBeUndefined();
		}
	});

	test("no tool's inputSchema has a root-level anyOf/oneOf/allOf (M7)", async () => {
		const { server } = buildMcpServer({ client: fakeClient(), scopes: ["manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const { tools } = await mcpClient.listTools();
		for (const tool of tools) {
			const schema = tool.inputSchema as Record<string, unknown>;
			expect(schema.anyOf, `${tool.name} schema must not have root anyOf`).toBeUndefined();
			expect(schema.oneOf, `${tool.name} schema must not have root oneOf`).toBeUndefined();
			expect(schema.allOf, `${tool.name} schema must not have root allOf`).toBeUndefined();
		}
	});
});

// Phase 4 note: this Phase-3 check only ever exercised the 16 Phase-3 read
// tools (buildMcpServer's registry now also carries 13 Phase-4 additions,
// 10 of which are legitimately non-read). It's superseded — with REAL
// HTTP-verb instrumentation, per M-3's binding correction — by
// tool-invariants.test.ts's assertion 17. Kept here, scoped to just the
// Phase-3 tool names, as a lower-cost regression guard specific to this
// file's original tools; not read as satisfying M-3's stronger claim.
describe("converse read-only check (M6): every read tool only calls GET-shaped client methods", () => {
	// Minimal valid arguments per tool — required fields only, chosen to
	// route through the handler without throwing on missing input.
	const ARGS_FOR: Record<string, Record<string, unknown>> = {
		get_stats: {},
		list_sessions: {},
		get_session: { session_id: "s1" },
		get_session_timeline: { session_id: "s1" },
		get_event_context: { session_id: "s1", event_id: 1 },
		get_session_claude_md: { session_id: "s1" },
		search: { q: "x" },
		list_projects: {},
		get_session_intelligence: { session_id: "s1" },
		get_digest: {},
		get_ai_status: {},
		list_templates: {},
		get_template: { template_id: "t1" },
		list_launches: {},
		get_launch: { launch_id: "l1" },
		get_inbox: {},
	};

	test("every AgentPulseClient method invoked by a read tool is one of the client's own (GET-only) methods", async () => {
		const calledMethods: string[] = [];
		const track = <T>(name: string, value: T): (() => Promise<T>) => {
			return async () => {
				calledMethods.push(name);
				return value;
			};
		};
		const client = fakeClient({
			getStats: track("getStats", FAKE_STATS),
			getSessions: track("getSessions", { sessions: [], total: 0 }),
			getSession: track("getSession", {
				session: undefined as never,
				events: [],
				controlActions: undefined,
			}),
			getSessionTimeline: track("getSessionTimeline", { events: [] }),
			getEventContext: track("getEventContext", { events: [], target: { id: 1 } }),
			getSessionClaudeMd: track("getSessionClaudeMd", {
				content: "",
				path: "",
				checksum: "",
				updatedAt: null,
			}),
			search: track("search", { hits: [], total: 0, backend: "sqlite-fts5" as const }),
			listProjects: track("listProjects", { projects: [], total: 0 }),
			getSessionIntelligence: track("getSessionIntelligence", {
				intelligence: {
					health: "healthy" as const,
					reasonCode: "working" as const,
					explanation: "",
					confidence: 1,
					evidence: [],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			}),
			getDigest: track("getDigest", {
				generatedAt: "",
				windowStart: "",
				windowEnd: "",
				totals: { repos: 0, sessions: 0, active: 0, blocked: 0, stuck: 0, completedToday: 0 },
				repos: [],
			}),
			getAiStatus: track("getAiStatus", {
				build: true,
				runtime: true,
				killSwitch: false,
				active: true,
				classifierEnabled: true,
				classifierAffectsRunner: false,
				autoEnableWatcherForAsk: false,
			}),
			listTemplates: track("listTemplates", { templates: [], total: 0 }),
			getTemplate: track("getTemplate", { template: undefined as never, resolvedProject: null }),
			listLaunches: track("listLaunches", { launches: [], total: 0 }),
			getLaunch: track("getLaunch", { launchRequest: undefined as never, session: null }),
			getInbox: track("getInbox", { items: [], total: 0, byKind: {} as never }),
		});

		const { server, registry } = buildMcpServer({ client, scopes: ["observe", "manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		// Scoped to this file's 16 Phase-3 tool names (ARGS_FOR's keys) — the
		// full mixed RO/mutating population (Phase 4 adds 13 more entries to
		// `registry`, 10 of them legitimately non-read) is covered with real
		// HTTP-verb instrumentation by tool-invariants.test.ts's assertion 17.
		const phase3Entries = registry.filter((entry) => entry.name in ARGS_FOR);
		expect(phase3Entries.length).toBe(16);
		for (const entry of phase3Entries) {
			expect(entry.readOnly, `${entry.name} must be a read tool in Phase 3`).toBe(true);
			const args = ARGS_FOR[entry.name];
			expect(args, `no ARGS_FOR entry for ${entry.name} — add one`).toBeDefined();
			await mcpClient.callTool({ name: entry.name, arguments: args });
		}

		// Every method invoked is a real AgentPulseClient method — none of
		// them wrap a POST/PUT/DELETE endpoint (Phase 3 ships read tools
		// only; Phase 4's drift guard extends this with a documented
		// GET-only allowlist once mutating client methods exist).
		const knownReadMethods = new Set(Object.keys(client).filter((k) => k !== "baseUrl"));
		for (const method of calledMethods) {
			expect(knownReadMethods.has(method), `${method} is not a known AgentPulseClient method`).toBe(
				true,
			);
		}
		expect(calledMethods.length).toBe(16);
	});
});
