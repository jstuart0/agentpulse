/**
 * Tests for decide.ts (AGEN-12 Phase 4): decide_hitl,
 * decide_action_request. Body assertions (test-contract 13-14); single-item
 * schema (no array/batch field).
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import { registerDecideTools } from "./decide.js";

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

describe("decide_hitl (assertion 13)", () => {
	test("calls client.decideHitl(hitlId, action, customPrompt) with the given args", async () => {
		let seen: unknown;
		const client = fakeClient({
			decideHitl: async (hitlId, action, customPrompt) => {
				seen = { hitlId, action, customPrompt };
				return { hitl: { id: hitlId, status: "applied" } as never };
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "decide_hitl",
			arguments: { hitl_id: "h1", action: "approve" },
		});

		expect(result.isError).toBeFalsy();
		expect(seen).toEqual({ hitlId: "h1", action: "approve", customPrompt: null });
	});

	test("action:custom with custom_prompt passes the prompt through", async () => {
		let seen: unknown;
		const client = fakeClient({
			decideHitl: async (hitlId, action, customPrompt) => {
				seen = { hitlId, action, customPrompt };
				return { hitl: null };
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		await mcpClient.callTool({
			name: "decide_hitl",
			arguments: { hitl_id: "h1", action: "custom", custom_prompt: "do X instead" },
		});

		expect(seen).toEqual({ hitlId: "h1", action: "custom", customPrompt: "do X instead" });
	});

	test("input schema has no array/batch field (single-item only, D2 excludes batch-decline)", async () => {
		const ctx = newContext(fakeClient());
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		const tool = tools.find((t) => t.name === "decide_hitl");
		const props = (tool?.inputSchema as { properties?: Record<string, { type?: string }> })
			?.properties;
		expect(props).toBeDefined();
		for (const [key, schema] of Object.entries(props ?? {})) {
			expect(schema.type, `${key} must not be an array (batch field)`).not.toBe("array");
		}
	});
});

describe("decide_action_request (assertion 14)", () => {
	test("calls client.decideActionRequest(actionRequestId, decision) with the given args", async () => {
		let seen: unknown;
		const client = fakeClient({
			decideActionRequest: async (actionRequestId, decision) => {
				seen = { actionRequestId, decision };
				return { actionRequest: { id: actionRequestId, status: decision } as never };
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "decide_action_request",
			arguments: { action_request_id: "ar1", decision: "applied" },
		});

		expect(result.isError).toBeFalsy();
		expect(seen).toEqual({ actionRequestId: "ar1", decision: "applied" });
	});

	test("input schema has no array/batch field", async () => {
		const ctx = newContext(fakeClient());
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		const tool = tools.find((t) => t.name === "decide_action_request");
		const props = (tool?.inputSchema as { properties?: Record<string, { type?: string }> })
			?.properties;
		for (const [key, schema] of Object.entries(props ?? {})) {
			expect(schema.type, `${key} must not be an array (batch field)`).not.toBe("array");
		}
	});

	/**
	 * tessa H-5: ai-inbox.ts's decide-endpoint 409/422 failure branches
	 * (:206-270) carry a human `message` alongside the machine `error` code
	 * ("race_lost"/"expired"/"failed") — errors.ts's generic-4xx fallback
	 * must surface the message, not the opaque code.
	 */
	test("409 race_lost surfaces the human message, not the bare 'race_lost' code", async () => {
		const client = fakeClient({
			decideActionRequest: async () => {
				throw new ApiError(409, {
					error: "race_lost",
					currentStatus: "applied",
					message: "Another approval already claimed this request.",
					actionRequest: null,
				});
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "decide_action_request",
			arguments: { action_request_id: "ar1", decision: "applied" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toContain("Another approval already claimed this request.");
		expect(text).not.toBe("race_lost");
	});

	test("422 expired surfaces the human message naming the failure reason", async () => {
		const client = fakeClient({
			decideActionRequest: async () => {
				throw new ApiError(422, {
					error: "expired",
					failureReason: "the action request expired before it could be applied",
					message: "Launch couldn't proceed: the action request expired before it could be applied",
					actionRequest: null,
				});
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "decide_action_request",
			arguments: { action_request_id: "ar1", decision: "applied" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toContain("Launch couldn't proceed");
		expect(text).toContain("expired before it could be applied");
	});

	test("422 failed surfaces the human message", async () => {
		const client = fakeClient({
			decideActionRequest: async () => {
				throw new ApiError(422, {
					error: "failed",
					failureReason: "supervisor unreachable",
					message: "Launch failed: supervisor unreachable",
					actionRequest: null,
				});
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "decide_action_request",
			arguments: { action_request_id: "ar1", decision: "applied" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toContain("Launch failed: supervisor unreachable");
	});
});

describe("decide_hitl — no regression from the H-5 fallback change (its route is 404-only, no message field)", () => {
	test("404 hitl-not-found still surfaces the bare error code (no message field on that body)", async () => {
		const client = fakeClient({
			decideHitl: async () => {
				throw new ApiError(404, { error: "hitl not found" });
			},
		});
		const ctx = newContext(client);
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "decide_hitl",
			arguments: { hitl_id: "h1", action: "approve" },
		});

		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
		expect(text).toContain("hitl not found");
	});
});

describe("not registered under observe-only scope", () => {
	test("decide_hitl/decide_action_request absent under observe", () => {
		const ctx = newContext(fakeClient());
		registerDecideTools(ctx, { hasObserve: true, hasManage: false });
		expect(ctx.registry.length).toBe(0);
	});
});

describe("HITL-bypass + confirmation-portability caveats (xander H1/e)", () => {
	test("both tools' descriptions warn that deciding here is NOT a human approval, and state the confirmation-portability caveat", async () => {
		const ctx = newContext(fakeClient());
		registerDecideTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		for (const name of ["decide_hitl", "decide_action_request"]) {
			const tool = tools.find((t) => t.name === name);
			expect(tool?.description, `${name} HITL-bypass caveat`).toContain("NOT a human approval");
			expect(tool?.description, `${name} confirmation-portability caveat`).toContain(
				"state-changing action",
			);
		}
	});
});
