/**
 * Tests for approvals.ts (AGEN-87): list_pending_approvals, decline_approval.
 * Scope gating, the decline-only body, closed rows filtered out, the one
 * "unsupported" message for a server without the routes, and mapped refusals.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, createHttpClient } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import type { CodexApprovalSummary } from "../types.js";
import { APPROVALS_UNSUPPORTED_MESSAGE, registerApprovalTools } from "./approvals.js";

function summary(id: string, state: CodexApprovalSummary["state"]): CodexApprovalSummary {
	return {
		id,
		requestKind: "command",
		state,
		outcome: null,
		decision: null,
		answeredAt: null,
		revision: 1,
		presentationHash: "a".repeat(64),
		approvable: true,
		notApprovableReason: null,
		canCancel: true,
		createdAt: "2026-11-04T10:00:00.000Z",
		expiresAt: "2026-11-04T10:20:00.000Z",
		expiresInSeconds: 600,
		preview: null,
	};
}

async function connect(client: ReturnType<typeof fakeClient>, hasManage = true) {
	const server = new McpServer({ name: "agentpulse-test", version: "0.0.0-test" });
	const ctx: ToolContext = { server, client, registry: [] };
	registerApprovalTools(ctx, { hasObserve: true, hasManage });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
	return { mcpClient, ctx };
}

function text(result: unknown): string {
	return (result as { content: Array<{ text: string }> }).content[0].text;
}

describe("registration", () => {
	test("manage registers exactly the read and the decline, with the right hints", async () => {
		const { mcpClient, ctx } = await connect(fakeClient());
		const { tools } = await mcpClient.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["decline_approval", "list_pending_approvals"]);
		const byName = Object.fromEntries(ctx.registry.map((e) => [e.name, e]));
		expect(byName.list_pending_approvals.readOnly).toBe(true);
		expect(byName.decline_approval.readOnly).toBe(false);
	});

	test("an observe-only key gets neither", async () => {
		const { ctx } = await connect(fakeClient(), false);
		expect(ctx.registry).toEqual([]);
	});
});

describe("list_pending_approvals", () => {
	test("drops closed rows and keeps the host", async () => {
		const client = fakeClient({
			listApprovals: async () => ({
				v: 1,
				approvals: [summary("p", "pending"), summary("a", "answered"), summary("c", "closed")],
				host: { state: "live", name: "build-box" },
				viewer: { canAccept: false },
			}),
		});
		const { mcpClient } = await connect(client);
		const result = await mcpClient.callTool({
			name: "list_pending_approvals",
			arguments: { session_id: "s1" },
		});
		const body = JSON.parse(text(result));
		expect(body.approvals.map((a: { id: string }) => a.id)).toEqual(["p", "a"]);
		expect(body.host).toEqual({ state: "live", name: "build-box" });
	});

	test("a bare 404 (a server without the routes) is the one fixed message", async () => {
		const client = fakeClient({
			listApprovals: async () => {
				throw new ApiError(404, { parseError: true, raw: "404 Not Found" });
			},
		});
		const { mcpClient } = await connect(client);
		const result = await mcpClient.callTool({
			name: "list_pending_approvals",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toBe(APPROVALS_UNSUPPORTED_MESSAGE);
	});

	test("a coded 404 is an unknown approval, not an unsupported server", async () => {
		const client = fakeClient({
			listApprovals: async () => {
				throw new ApiError(404, { error: "approval_not_found" });
			},
		});
		const { mcpClient } = await connect(client);
		const result = await mcpClient.callTool({
			name: "list_pending_approvals",
			arguments: { session_id: "s1" },
		});
		expect(text(result)).not.toBe(APPROVALS_UNSUPPORTED_MESSAGE);
		expect(text(result)).toContain("no such approval");
	});
});

describe("decline_approval", () => {
	test("sends the session and approval ids through the client", async () => {
		const seen: unknown[] = [];
		const client = fakeClient({
			declineApproval: async (sessionId, approvalId) => {
				seen.push([sessionId, approvalId]);
				return { v: 1, approval: summary(approvalId, "answered") };
			},
		});
		const { mcpClient } = await connect(client);
		const result = await mcpClient.callTool({
			name: "decline_approval",
			arguments: { session_id: "s1", approval_id: "ap1" },
		});
		expect(result.isError).toBeFalsy();
		expect(seen).toEqual([["s1", "ap1"]]);
		expect(JSON.parse(text(result)).approval.id).toBe("ap1");
	});

	test("the schema has no decision, hash or accept field", async () => {
		const { mcpClient } = await connect(fakeClient());
		const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "decline_approval");
		expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
			"approval_id",
			"session_id",
		]);
	});

	test.each([
		["host_offline", "isn't connected"],
		["host_gone", "was removed"],
		["session_stopped", "was stopped"],
		["session_stopping", "being stopped"],
	])("%s is a plain sentence", async (code, fragment) => {
		const client = fakeClient({
			declineApproval: async () => {
				throw new ApiError(409, { error: code });
			},
		});
		const { mcpClient } = await connect(client);
		const result = await mcpClient.callTool({
			name: "decline_approval",
			arguments: { session_id: "s1", approval_id: "ap1" },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain(fragment);
	});

	test("the real client posts a decline and nothing else", async () => {
		const requests: Array<{ url: string; method: string; body: unknown }> = [];
		const http = createHttpClient({
			baseUrl: "http://localhost:3000",
			apiKey: "ap_x",
			fetchImpl: (async (url: string, init: RequestInit) => {
				requests.push({
					url: String(url),
					method: init.method ?? "GET",
					body: init.body ? JSON.parse(String(init.body)) : undefined,
				});
				return new Response(JSON.stringify({ v: 1, approval: summary("ap 1", "answered") }), {
					status: 200,
				});
			}) as unknown as typeof fetch,
		});
		await http.declineApproval("s/1", "ap 1");
		expect(requests).toEqual([
			{
				url: "http://localhost:3000/api/v1/sessions/s%2F1/approvals/ap%201/decision",
				method: "POST",
				body: { decision: "decline" },
			},
		]);
	});
});

describe("forward compatibility", () => {
	test("an outcome or reason this version doesn't know is passed through, not thrown on", async () => {
		const odd = {
			...summary("x", "closed"),
			outcome: "a_future_outcome",
			notApprovableReason: "a_future_reason",
		} as unknown as CodexApprovalSummary;
		const open = { ...odd, state: "pending" } as CodexApprovalSummary;
		const client = fakeClient({
			listApprovals: async () => ({
				v: 1,
				approvals: [odd, open],
				host: { state: "live", name: null },
				viewer: { canAccept: true },
			}),
		});
		const { mcpClient } = await connect(client);
		const result = await mcpClient.callTool({
			name: "list_pending_approvals",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBeFalsy();
		const body = JSON.parse(text(result));
		expect(body.approvals).toHaveLength(1);
		expect(body.approvals[0].outcome).toBe("a_future_outcome");
		expect(body.approvals[0].notApprovableReason).toBe("a_future_reason");
	});
});
