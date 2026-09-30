import { describe, expect, test } from "bun:test";
/**
 * enums.test.ts — D5 observed/launchable enum split (2026-09-28-deliver-agent-cli-parity).
 *
 * Phase 1 keeps OBSERVED_AGENT_TYPE_ENUM and LAUNCHABLE_AGENT_TYPE_ENUM
 * value-identical (D5's honest note); the four call-site assertions below
 * are therefore a non-discriminating scaffold — today both "claude_code"
 * accepts on every site. Phase 6 flips this in place: OBSERVED_AGENT_TYPE_ENUM
 * additionally accepts "copilot_cli"; LAUNCHABLE_AGENT_TYPE_ENUM still
 * rejects it. Each test below names which enum it exercises so Phase 6 can
 * extend the same test, not write a parallel one.
 *
 * tessa's mid-build correction (Medium-High): the original version of this
 * file grepped source text for the enum constant name, which proves an
 * import exists but never proves the schema actually parses/rejects a
 * value. Rewritten on the InMemoryTransport + McpServer + mcpClient.callTool
 * harness (tools/sessions.test.ts's pattern) so each site is exercised with
 * a live zod schema through the real MCP protocol.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./server.js";
import { fakeClient } from "./test-support.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerOrchestrateTools } from "./tools/orchestrate.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerTemplateMutationTools } from "./tools/templates.js";

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

// create_template's own fields are snake_case (its file-header convention);
// recommend_launch's nested `template` object mirrors SessionTemplateInput
// and is camelCase — see each test's arguments below.
const baseTemplateSnakeCase = {
	name: "t",
	agent_type: "claude_code",
	cwd: "/tmp",
};

const baseTemplateCamelCase = {
	name: "t",
	agentType: "claude_code",
	cwd: "/tmp",
};

describe("tools/sessions.ts list_sessions — observed enum (OBSERVED_AGENT_TYPE_ENUM)", () => {
	test("agent_type:claude_code is legal today; Phase 6 adds a copilot_cli-accepts case here", async () => {
		const ctx = newContext(fakeClient({ getSessions: async () => ({ sessions: [], total: 0 }) }));
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "list_sessions",
			arguments: { agent_type: "claude_code" },
		});
		expect(result.isError).toBeFalsy();
	});

	// Phase 6 (F12 fully closed): the discriminating run — OBSERVED_AGENT_TYPE_ENUM
	// must accept the real "copilot_cli" literal, not a placeholder. RED until
	// Phase 6 adds it to the enum.
	test("agent_type:copilot_cli is accepted (OBSERVED_AGENT_TYPE_ENUM gains copilot_cli in Phase 6)", async () => {
		const ctx = newContext(fakeClient({ getSessions: async () => ({ sessions: [], total: 0 }) }));
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "list_sessions",
			arguments: { agent_type: "copilot_cli" },
		});
		expect(result.isError).toBeFalsy();
	});
});

describe("tools/templates.ts create_template — launchable enum (LAUNCHABLE_AGENT_TYPE_ENUM)", () => {
	test("agent_type:claude_code is legal today; Phase 6 keeps rejecting copilot_cli here", async () => {
		const ctx = newContext(
			fakeClient({
				createTemplate: async () => ({
					template: {
						id: "tpl1",
						projectId: null,
						overriddenFields: [],
						name: "t",
						description: null,
						agentType: "claude_code",
						cwd: "/tmp",
						baseInstructions: "",
						taskPrompt: "",
						model: null,
						approvalPolicy: null,
						sandboxMode: null,
						env: {},
						tags: [],
						isFavorite: false,
						createdAt: "2026-01-01 00:00:00",
						updatedAt: "2026-01-01 00:00:00",
					},
				}),
			}),
		);
		registerTemplateMutationTools(ctx, { hasObserve: false, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "create_template",
			arguments: baseTemplateSnakeCase,
		});
		expect(result.isError).toBeFalsy();
	});

	// Phase 6 (F12 fully closed): the discriminating rejection — copilot_cli
	// is now a real AgentType elsewhere in the system, and LAUNCHABLE_AGENT_TYPE_ENUM
	// must still reject it here. This already passes today (the enum has
	// always been 2-valued); it becomes a meaningful, discriminating
	// assertion once Phase 6 makes "copilot_cli" a real observed value.
	test("agent_type:copilot_cli is rejected — LAUNCHABLE_AGENT_TYPE_ENUM never gains it", async () => {
		const ctx = newContext(fakeClient({}));
		registerTemplateMutationTools(ctx, { hasObserve: false, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "create_template",
			arguments: { ...baseTemplateSnakeCase, agent_type: "copilot_cli" },
		});
		expect(result.isError).toBeTruthy();
	});
});

describe("tools/orchestrate.ts recommend_launch — launchable enum (LAUNCHABLE_AGENT_TYPE_ENUM)", () => {
	test("template.agentType:claude_code is legal today; Phase 6 keeps rejecting copilot_cli here", async () => {
		const ctx = newContext(
			fakeClient({
				recommendLaunch: async () => ({
					recommendation: {
						agentType: "claude_code",
						model: null,
						launchMode: "interactive_terminal",
						suggestedSupervisorId: null,
						suggestedSupervisorHost: null,
						rationale: [],
						warnings: [],
						alternatives: [],
						confidence: 0.3,
					},
				}),
			}),
		);
		registerOrchestrateTools(ctx, { hasObserve: false, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "recommend_launch",
			arguments: { template: baseTemplateCamelCase },
		});
		expect(result.isError).toBeFalsy();
	});

	// Phase 6 (F12 fully closed): the discriminating rejection — see the
	// create_template case above for why this is meaningful post-Phase-6
	// even though it already passes.
	test("template.agentType:copilot_cli is rejected — LAUNCHABLE_AGENT_TYPE_ENUM never gains it", async () => {
		const ctx = newContext(fakeClient({}));
		registerOrchestrateTools(ctx, { hasObserve: false, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "recommend_launch",
			arguments: { template: { ...baseTemplateCamelCase, agentType: "copilot_cli" } },
		});
		expect(result.isError).toBeTruthy();
	});
});

describe("tools/catalog.ts list_templates — launchable enum (LAUNCHABLE_AGENT_TYPE_ENUM)", () => {
	test("agent_type:claude_code is legal today; Phase 6 keeps rejecting copilot_cli here", async () => {
		const ctx = newContext(
			fakeClient({ listTemplates: async () => ({ templates: [], total: 0 }) }),
		);
		registerCatalogTools(ctx, { hasObserve: false, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "list_templates",
			arguments: { agent_type: "claude_code" },
		});
		expect(result.isError).toBeFalsy();
	});

	// Phase 6 (F12 fully closed): the discriminating rejection — see the
	// create_template case above for why this is meaningful post-Phase-6
	// even though it already passes.
	test("agent_type:copilot_cli is rejected — LAUNCHABLE_AGENT_TYPE_ENUM never gains it", async () => {
		const ctx = newContext(
			fakeClient({ listTemplates: async () => ({ templates: [], total: 0 }) }),
		);
		registerCatalogTools(ctx, { hasObserve: false, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "list_templates",
			arguments: { agent_type: "copilot_cli" },
		});
		expect(result.isError).toBeTruthy();
	});
});
