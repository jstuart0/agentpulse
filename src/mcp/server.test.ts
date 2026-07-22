import { describe, expect, test } from "bun:test";
/**
 * Tests for src/mcp/server.ts — buildMcpServer, registerReadTool,
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
import type { DashboardStats } from "../shared/types.js";
import type { AgentPulseClient } from "./client.js";
import { ApiError } from "./client.js";
import {
	REQUIRES_USER_INTERACTION_META,
	type ToolContext,
	buildMcpServer,
	registerMutatingTool,
	registerReadTool,
} from "./server.js";

const FAKE_STATS: DashboardStats = {
	activeSessions: 3,
	totalSessionsToday: 7,
	totalToolUsesToday: 42,
	byAgentType: { claude_code: 2, codex_cli: 1 },
};

function fakeClient(overrides: Partial<AgentPulseClient> = {}): AgentPulseClient {
	return {
		baseUrl: "http://localhost:3000/api/v1",
		getStats: async () => FAKE_STATS,
		getAuthMe: async () => ({
			authenticated: true,
			user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["*"] },
			signOutUrl: null,
			disableAuth: false,
			allowSignup: false,
		}),
		...overrides,
	};
}

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
