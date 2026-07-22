/**
 * Tests for src/mcp/tools/templates.ts (AGEN-12 Phase 4): create_template,
 * update_template, delete_template. Body-shape assertions per
 * SessionTemplateInput (test-contract assertion 11); delete_template's
 * destructiveHint (assertion 12).
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import { registerTemplateMutationTools } from "./templates.js";

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

const FAKE_TEMPLATE_ROW = {
	id: "t1",
	projectId: null,
	overriddenFields: [],
	name: "My Template",
	description: null,
	agentType: "codex_cli" as const,
	cwd: "/repo",
	baseInstructions: "",
	taskPrompt: "",
	model: null,
	approvalPolicy: null,
	sandboxMode: null,
	env: {},
	tags: [],
	isFavorite: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("create_template — body shape (SessionTemplateInput)", () => {
	test("snake_case args translate to the camelCase REST body", async () => {
		let seenBody: unknown;
		const client = fakeClient({
			createTemplate: async (body) => {
				seenBody = body;
				return { template: FAKE_TEMPLATE_ROW };
			},
		});
		const ctx = newContext(client);
		registerTemplateMutationTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "create_template",
			arguments: {
				name: "My Template",
				agent_type: "codex_cli",
				cwd: "/repo",
				base_instructions: "base",
				task_prompt: "task",
				is_favorite: true,
				project_id: "proj-1",
			},
		});

		expect(result.isError).toBeFalsy();
		expect(seenBody).toMatchObject({
			name: "My Template",
			agentType: "codex_cli",
			cwd: "/repo",
			baseInstructions: "base",
			taskPrompt: "task",
			isFavorite: true,
			projectId: "proj-1",
		});
	});
});

describe("update_template", () => {
	test("PUTs against template_id with the translated body", async () => {
		let seenId: string | undefined;
		let seenBody: unknown;
		const client = fakeClient({
			updateTemplate: async (templateId, body) => {
				seenId = templateId;
				seenBody = body;
				return { template: FAKE_TEMPLATE_ROW };
			},
		});
		const ctx = newContext(client);
		registerTemplateMutationTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		await mcpClient.callTool({
			name: "update_template",
			arguments: { template_id: "t1", name: "Renamed", agent_type: "claude_code", cwd: "/repo2" },
		});

		expect(seenId).toBe("t1");
		expect(seenBody).toMatchObject({ name: "Renamed", agentType: "claude_code", cwd: "/repo2" });
	});
});

describe("delete_template — destructiveHint (assertion 12)", () => {
	test("calls DELETE via client.deleteTemplate and carries destructiveHint:true", async () => {
		let seenId: string | undefined;
		const client = fakeClient({
			deleteTemplate: async (templateId) => {
				seenId = templateId;
				return { ok: true };
			},
		});
		const ctx = newContext(client);
		registerTemplateMutationTools(ctx, { hasObserve: true, hasManage: true });
		expect(
			ctx.registry.find((r) => r.name === "delete_template")?.annotations?.destructiveHint,
		).toBe(true);

		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		expect(tools.find((t) => t.name === "delete_template")?.annotations?.destructiveHint).toBe(
			true,
		);

		const result = await mcpClient.callTool({
			name: "delete_template",
			arguments: { template_id: "t1" },
		});
		expect(result.isError).toBeFalsy();
		expect(seenId).toBe("t1");
	});
});

describe("not registered under observe-only scope", () => {
	test("create_template/update_template/delete_template absent under observe", () => {
		const ctx = newContext(fakeClient());
		registerTemplateMutationTools(ctx, { hasObserve: true, hasManage: false });
		expect(ctx.registry.length).toBe(0);
	});
});
