/**
 * Tests for src/mcp/tools/ai.ts (AGEN-12 Phase 3): get_session_intelligence
 * (AI-gate pair mapping, test-contract assertions 3-5), get_digest,
 * get_ai_status (include_diagnostics default-off, M10), get_inbox.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import type { Inbox } from "../types.js";
import { registerAiTools } from "./ai.js";

/** Partial byKind maps are common in these fixtures — cast rather than enumerate all 17 InboxWorkItem kinds per test. */
const byKind = (partial: Partial<Inbox["byKind"]>) => partial as Inbox["byKind"];

function newContext(client: ReturnType<typeof fakeClient>): ToolContext {
	const server = new McpServer({ name: "agentpulse-test", version: "0.0.0-test" });
	return { server, client, registry: [] };
}

async function connect(ctx: ToolContext) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([mcpClient.connect(clientTransport), ctx.server.connect(serverTransport)]);
	return mcpClient;
}

function textOf(result: unknown): string {
	const content = (result as { content?: unknown }).content;
	return (content as Array<{ type: string; text: string }>)[0]?.text ?? "";
}

describe("get_session_intelligence — AI-gate pair mapping (test-contract 3-5)", () => {
	test("404 ai_disabled (not compiled in) → isError, distinct message", async () => {
		const ctx = newContext(
			fakeClient({
				getSessionIntelligence: async () => {
					throw new ApiError(404, { error: "ai_disabled", message: "AI feature not compiled in" });
				},
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session_intelligence",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("not compiled in");
	});

	test("409 ai_disabled (runtime-disabled) → isError, distinct from the 404 case", async () => {
		const ctx = newContext(
			fakeClient({
				getSessionIntelligence: async () => {
					throw new ApiError(409, {
						error: "ai_disabled",
						message: "AI feature disabled. Enable in Settings.",
					});
				},
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session_intelligence",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("disabled in Settings");
		expect(textOf(result)).not.toContain("not compiled in");
	});

	test("409 ai_paused (kill switch) → isError, distinct from both ai_disabled cases", async () => {
		const ctx = newContext(
			fakeClient({
				getSessionIntelligence: async () => {
					throw new ApiError(409, {
						error: "ai_paused",
						message: "All watchers are paused via the kill switch.",
					});
				},
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session_intelligence",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("paused");
		expect(textOf(result)).not.toContain("not compiled in");
		expect(textOf(result)).not.toContain("disabled in Settings");
	});

	test("success path returns the intelligence payload unmodified", async () => {
		const intelligence = {
			health: "healthy" as const,
			reasonCode: "working" as const,
			explanation: "actively working",
			confidence: 0.9,
			evidence: [],
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const ctx = newContext(fakeClient({ getSessionIntelligence: async () => ({ intelligence }) }));
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session_intelligence",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result)).intelligence.health).toBe("healthy");
	});
});

describe("get_ai_status — diagnostics default-off (M10)", () => {
	test("without include_diagnostics, only /ai/status is called", async () => {
		let diagnosticsCalled = false;
		const ctx = newContext(
			fakeClient({
				getAiStatus: async () => ({
					build: true,
					runtime: true,
					killSwitch: false,
					active: true,
					classifierEnabled: true,
					classifierAffectsRunner: false,
					autoEnableWatcherForAsk: false,
				}),
				getAiDiagnostics: async () => {
					diagnosticsCalled = true;
					throw new Error("should not be called");
				},
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "get_ai_status", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(diagnosticsCalled).toBe(false);
		expect(JSON.parse(textOf(result)).diagnostics).toBeUndefined();
	});

	test("include_diagnostics:true calls diagnostics and merges the result", async () => {
		const ctx = newContext(
			fakeClient({
				getAiStatus: async () => ({
					build: true,
					runtime: true,
					killSwitch: false,
					active: true,
					classifierEnabled: true,
					classifierAffectsRunner: false,
					autoEnableWatcherForAsk: false,
				}),
				getAiDiagnostics: async () => ({
					generatedAt: "2026-01-01T00:00:00.000Z",
					queue: { queued: 0 },
					today: "2026-01-01",
					flags: {
						build: true,
						runtime: true,
						killSwitch: false,
						classifierEnabled: true,
						classifierAffectsRunner: false,
					},
					otel: { endpoint: "none" },
				}),
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_ai_status",
			arguments: { include_diagnostics: true },
		});
		const parsed = JSON.parse(textOf(result));
		expect(parsed.diagnostics).toBeDefined();
		expect(parsed.diagnostics.today).toBe("2026-01-01");
	});
});

describe("get_digest", () => {
	test("returns the digest payload from the client", async () => {
		const ctx = newContext(
			fakeClient({
				getDigest: async () => ({
					generatedAt: "2026-01-01T00:00:00.000Z",
					windowStart: "2026-01-01T00:00:00.000Z",
					windowEnd: "2026-01-01T00:00:00.000Z",
					totals: { repos: 0, sessions: 0, active: 0, blocked: 0, stuck: 0, completedToday: 0 },
					repos: [],
				}),
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "get_digest", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result)).totals.repos).toBe(0);
	});
});

describe("get_inbox — manage-only, cap behavior", () => {
	test("is not registered under observe-only scope", () => {
		const ctx = newContext(fakeClient());
		registerAiTools(ctx, { hasObserve: true, hasManage: false });
		expect(ctx.registry.map((r) => r.name)).not.toContain("get_inbox");
	});

	test("is registered under manage, returns items/total/byKind", async () => {
		const ctx = newContext(
			fakeClient({
				getInbox: async () => ({
					items: [],
					total: 0,
					byKind: byKind({ hitl: 0, stuck: 0, risky: 0, failed_proposal: 0 }),
				}),
			}),
		);
		registerAiTools(ctx, { hasObserve: true, hasManage: true });
		expect(ctx.registry.map((r) => r.name)).toContain("get_inbox");
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "get_inbox", arguments: {} });
		const parsed = JSON.parse(textOf(result));
		expect(parsed.total).toBe(0);
		expect(parsed.byKind).toBeDefined();
	});
});
