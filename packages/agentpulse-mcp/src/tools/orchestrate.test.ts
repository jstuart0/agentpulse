/**
 * Tests for src/mcp/tools/orchestrate.ts (AGEN-12 Phase 4): recommend_launch,
 * preview_template, launch_agent, list_hosts. Session-control tools
 * (prompt_session/stop_session/retry_launch/update_session) moved to
 * session-actions.test.ts alongside their Phase 4 mid-build split
 * (dexter M).
 *
 * Test-contract note: assertion 1 as originally written ("launch_agent
 * called with {template_id:"t1"} only → posts POST /launches with body
 * {templateId:"t1"} exactly") is SUPERSEDED by the plan's own r2 correction
 * (plan Phase 4 step 4: "the r1 'posts {templateId}' assertion is
 * deleted — that payload cannot launch: launches.ts:41-63,
 * launch-validator.ts:149-177"). The tests below assert the corrected H1
 * contract instead: template_id-only triggers the three-call sequence
 * (GET template -> POST preview -> POST launches with
 * {templateId, template, launchSpec, ...}).
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import type { LaunchRequest, SupervisorRecord } from "../types.js";
import { registerOrchestrateTools } from "./orchestrate.js";

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

const FAKE_TEMPLATE = {
	id: "t1",
	projectId: null,
	overriddenFields: [],
	name: "My Template",
	description: null,
	agentType: "codex_cli" as const,
	cwd: "/repo",
	baseInstructions: "base",
	taskPrompt: "task",
	model: null,
	approvalPolicy: null,
	sandboxMode: null,
	env: {},
	tags: [],
	isFavorite: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_LAUNCH_SPEC = {
	version: 1 as const,
	launchCorrelationId: "corr-1",
	managedMode: "unmanaged_preview" as const,
	agentType: "codex_cli" as const,
	launchMode: "interactive_terminal" as const,
	cwd: "/repo",
	model: null,
	approvalPolicy: null,
	sandboxMode: null,
	baseInstructions: "base",
	taskPrompt: "task",
	env: {},
	providerConfig: { command: "codex", cliArgs: [], instructionsFile: "AGENTS.md" as const },
};

const FAKE_PREVIEW = {
	normalizedTemplate: {
		name: "My Template",
		description: null,
		agentType: "codex_cli" as const,
		cwd: "/repo",
		baseInstructions: "base",
		taskPrompt: "task",
		model: null,
		approvalPolicy: null,
		sandboxMode: null,
		env: {},
		tags: [],
		isFavorite: false,
	},
	launchSpec: FAKE_LAUNCH_SPEC,
	guidance: {
		claudeCode: { label: "Claude Code", command: "claude", recommended: false, notes: [] },
		codexCli: { label: "Codex CLI", command: "codex", recommended: true, notes: [] },
	},
	warnings: [],
	hostCompatibility: [],
	firstCapableHostId: null,
};

const FAKE_SUPERVISOR: SupervisorRecord = {
	id: "sup-1",
	hostName: "dev-box",
	platform: "darwin",
	arch: "arm64",
	version: "1.0.0",
	capabilities: {
		version: 1,
		agentTypes: ["codex_cli"],
		launchModes: ["interactive_terminal"],
		os: "macos",
		terminalSupport: [],
		features: [],
	},
	trustedRoots: [],
	status: "connected",
	capabilitySchemaVersion: 1,
	configSchemaVersion: 1,
	lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
	heartbeatLeaseExpiresAt: "2026-01-01T00:05:00.000Z",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_LAUNCH_REQUEST = { id: "lr-1", status: "validated" } as unknown as LaunchRequest;

describe("launch_agent — template_id mode: three-call sequence (H1, corrects test-contract assertion 1)", () => {
	test("GET template -> POST preview -> POST launches with the full body, never {templateId}-only (tessa M-4: toEqual, not toMatchObject)", async () => {
		const calls: string[] = [];
		let createLaunchBody: unknown;
		const client = fakeClient({
			getTemplate: async (templateId) => {
				calls.push(`getTemplate:${templateId}`);
				return { template: FAKE_TEMPLATE, resolvedProject: null };
			},
			previewTemplate: async (params) => {
				calls.push("previewTemplate");
				expect(params.name).toBe(FAKE_TEMPLATE.name);
				return FAKE_PREVIEW;
			},
			createLaunch: async (body) => {
				calls.push("createLaunch");
				createLaunchBody = body;
				return { launchRequest: FAKE_LAUNCH_REQUEST, supervisor: FAKE_SUPERVISOR };
			},
		});

		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "launch_agent",
			arguments: {
				template_id: "t1",
				requested_supervisor_id: "sup-1",
				requested_launch_mode: "headless",
				routing_policy: "manual_target",
				desired_display_name: "my session",
			},
		});

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["getTemplate:t1", "previewTemplate", "createLaunch"]);
		// toEqual (not toMatchObject, tessa M-4): a silent field swap — e.g.
		// requestedLaunchMode accidentally carrying routing_policy's value —
		// would pass toMatchObject's subset check but must fail here.
		expect(createLaunchBody).toEqual({
			templateId: "t1",
			template: FAKE_PREVIEW.normalizedTemplate,
			launchSpec: FAKE_PREVIEW.launchSpec,
			requestedSupervisorId: "sup-1",
			requestedLaunchMode: "headless",
			routingPolicy: "manual_target",
			desiredDisplayName: "my session",
		});
	});
});

describe("launch_agent — direct mode (template+launch_spec)", () => {
	test("posts the caller-supplied template+launch_spec directly, no getTemplate/previewTemplate calls (toEqual, tessa M-4)", async () => {
		const calls: string[] = [];
		let createLaunchBody: unknown;
		const client = fakeClient({
			getTemplate: async () => {
				calls.push("getTemplate");
				throw new Error("should not be called in direct mode");
			},
			previewTemplate: async () => {
				calls.push("previewTemplate");
				throw new Error("should not be called in direct mode");
			},
			createLaunch: async (body) => {
				calls.push("createLaunch");
				createLaunchBody = body;
				return { launchRequest: FAKE_LAUNCH_REQUEST, supervisor: FAKE_SUPERVISOR };
			},
		});

		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "launch_agent",
			arguments: {
				template: FAKE_PREVIEW.normalizedTemplate,
				launch_spec: FAKE_LAUNCH_SPEC,
				requested_supervisor_id: "sup-1",
				requested_launch_mode: "interactive_terminal",
				routing_policy: "manual_target",
				desired_display_name: "my session",
			},
		});

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["createLaunch"]);
		expect(createLaunchBody).toEqual({
			template: FAKE_PREVIEW.normalizedTemplate,
			launchSpec: FAKE_LAUNCH_SPEC,
			requestedSupervisorId: "sup-1",
			requestedLaunchMode: "interactive_terminal",
			routingPolicy: "manual_target",
			desiredDisplayName: "my session",
		});
		expect((createLaunchBody as { templateId?: unknown }).templateId).toBeUndefined();
	});
});

describe("launch_agent — exactly-one-mode validation (assertions 3-4, dexter High: partial combos)", () => {
	test("neither template_id nor template+launch_spec -> isError, no client calls", async () => {
		let called = false;
		const client = fakeClient({
			getTemplate: async () => {
				called = true;
				throw new Error("unexpected");
			},
			createLaunch: async () => {
				called = true;
				throw new Error("unexpected");
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({ name: "launch_agent", arguments: {} });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("provide exactly one of");
		expect(called).toBe(false);
	});

	test("both template_id AND template+launch_spec supplied -> isError (precedence gap resolved as reject-both, not merge/template_id-wins)", async () => {
		let called = false;
		const client = fakeClient({
			getTemplate: async () => {
				called = true;
				throw new Error("unexpected");
			},
			createLaunch: async () => {
				called = true;
				throw new Error("unexpected");
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "launch_agent",
			arguments: {
				template_id: "t1",
				template: FAKE_PREVIEW.normalizedTemplate,
				launch_spec: FAKE_LAUNCH_SPEC,
			},
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("provide exactly one of");
		expect(called).toBe(false);
	});

	/**
	 * dexter High (real bug, mid-build fix): the original
	 * `hasTemplateId === hasDirect` check let template_id ride ALONG WITH a
	 * partial direct-mode field, silently discarding the caller's override
	 * and taking the template_id path anyway. Both partial combinations
	 * below must now be rejected client-side, with ZERO client calls (not a
	 * silent fall-through into template_id mode).
	 */
	test("template_id + template (no launch_spec) -> isError, no client calls (partial-combo regression guard)", async () => {
		let called = false;
		const client = fakeClient({
			getTemplate: async () => {
				called = true;
				throw new Error("must not be called — this combo must be rejected before any HTTP call");
			},
			previewTemplate: async () => {
				called = true;
				throw new Error("must not be called");
			},
			createLaunch: async () => {
				called = true;
				throw new Error("must not be called");
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "launch_agent",
			arguments: { template_id: "t1", template: FAKE_PREVIEW.normalizedTemplate },
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("provide exactly one of");
		expect(called).toBe(false);
	});

	test("template_id + launch_spec (no template) -> isError, no client calls (partial-combo regression guard)", async () => {
		let called = false;
		const client = fakeClient({
			getTemplate: async () => {
				called = true;
				throw new Error("must not be called — this combo must be rejected before any HTTP call");
			},
			previewTemplate: async () => {
				called = true;
				throw new Error("must not be called");
			},
			createLaunch: async () => {
				called = true;
				throw new Error("must not be called");
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "launch_agent",
			arguments: { template_id: "t1", launch_spec: FAKE_LAUNCH_SPEC },
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("provide exactly one of");
		expect(called).toBe(false);
	});
});

describe("launch_agent — server-side validator rejection surfaces through the client", () => {
	test("a 400 ApiError from createLaunch maps to isError with the server's message", async () => {
		const client = fakeClient({
			createLaunch: async () => {
				throw new ApiError(400, { error: "Selected host is not connected." });
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "launch_agent",
			arguments: { template: FAKE_PREVIEW.normalizedTemplate, launch_spec: FAKE_LAUNCH_SPEC },
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Selected host is not connected.");
	});
});

describe("launch_agent — confirmation-portability caveat (xander H1/e)", () => {
	test("description states this is a state-changing action whose confirmation hint some hosts won't honor", async () => {
		const ctx = newContext(fakeClient());
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		const tool = tools.find((t) => t.name === "launch_agent");
		expect(tool?.description).toContain("state-changing action");
		expect(tool?.description).toContain("other clients");
	});
});

describe("recommend_launch / preview_template — advisory, RO, no rUI (assertion 15)", () => {
	test("recommend_launch posts to the advisory endpoint and returns the recommendation", async () => {
		const recommendation = {
			agentType: "codex_cli" as const,
			model: null,
			launchMode: "interactive_terminal" as const,
			suggestedSupervisorId: "sup-1",
			suggestedSupervisorHost: "dev-box",
			rationale: [],
			warnings: [],
			alternatives: [],
			confidence: 0.5,
		};
		const client = fakeClient({ recommendLaunch: async () => ({ recommendation }) });
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		expect(ctx.registry.find((r) => r.name === "recommend_launch")?.readOnly).toBe(true);
		expect(ctx.registry.find((r) => r.name === "recommend_launch")?.meta).toBeUndefined();

		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "recommend_launch",
			arguments: { template: FAKE_PREVIEW.normalizedTemplate },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result)).recommendation.suggestedSupervisorId).toBe("sup-1");
	});

	test("preview_template posts to the simulate endpoint and returns the preview", async () => {
		const client = fakeClient({ previewTemplate: async () => FAKE_PREVIEW });
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		expect(ctx.registry.find((r) => r.name === "preview_template")?.readOnly).toBe(true);
		expect(ctx.registry.find((r) => r.name === "preview_template")?.meta).toBeUndefined();

		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "preview_template",
			arguments: { template: { cwd: "/repo" } },
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result)).launchSpec.cwd).toBe("/repo");
	});
});

describe("list_hosts — manage-only RO tool (D2, L3)", () => {
	test("not registered under observe-only scope", () => {
		const ctx = newContext(fakeClient());
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: false });
		expect(ctx.registry.map((r) => r.name)).not.toContain("list_hosts");
	});

	test("registered under manage; readOnlyHint explicit; returns supervisors/total", async () => {
		const client = fakeClient({
			listHosts: async () => ({ supervisors: [FAKE_SUPERVISOR], total: 1 }),
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		expect(ctx.registry.find((r) => r.name === "list_hosts")?.readOnly).toBe(true);

		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_hosts", arguments: {} });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.total).toBe(1);
		expect(parsed.supervisors[0].id).toBe("sup-1");
	});
});

/**
 * dexter L (mid-build review): fixture round-trip guarding the
 * toSessionTemplateInput/toPartialSessionTemplateInput/toLaunchSpec
 * cast-throughs — these are `as unknown as X` casts with no runtime
 * transform, so the only thing that can catch a future field-name drift
 * between the zod shapes and SessionTemplateInput/LaunchSpec is a test that
 * actually pushes a fully-populated fixture through the whole tool (schema
 * validate -> handler -> the exact object the client receives), not a
 * type-level check (the cast bypasses type-level checking by construction).
 */
describe("template/launch_spec cast-through fidelity (dexter L, round-trip fixture)", () => {
	test("launch_agent's direct-mode body has every SESSION_TEMPLATE_INPUT_SHAPE/LAUNCH_SPEC_OBJECT field intact, none dropped or renamed", async () => {
		const fullTemplate = {
			name: "n",
			description: "d",
			agentType: "claude_code" as const,
			cwd: "/repo",
			baseInstructions: "base",
			taskPrompt: "task",
			model: "sonnet",
			approvalPolicy: "auto" as const,
			sandboxMode: "workspace-write" as const,
			env: { FOO: "bar" },
			tags: ["a", "b"],
			isFavorite: true,
		};
		const fullLaunchSpec = {
			version: 1 as const,
			launchCorrelationId: "corr-full",
			managedMode: "unmanaged_preview" as const,
			agentType: "claude_code" as const,
			launchMode: "headless" as const,
			cwd: "/repo",
			model: "sonnet",
			approvalPolicy: "auto" as const,
			sandboxMode: "workspace-write" as const,
			baseInstructions: "base",
			taskPrompt: "task",
			env: { FOO: "bar" },
			providerConfig: {
				command: "claude",
				cliArgs: ["--model", "sonnet"],
				instructionsFile: "CLAUDE.md" as const,
			},
		};

		let seenTemplate: unknown;
		let seenLaunchSpec: unknown;
		const client = fakeClient({
			createLaunch: async (body) => {
				seenTemplate = body.template;
				seenLaunchSpec = body.launchSpec;
				return { launchRequest: FAKE_LAUNCH_REQUEST, supervisor: FAKE_SUPERVISOR };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		await mcpClient.callTool({
			name: "launch_agent",
			arguments: { template: fullTemplate, launch_spec: fullLaunchSpec },
		});

		expect(seenTemplate).toEqual(fullTemplate);
		expect(seenLaunchSpec).toEqual(fullLaunchSpec);
	});
});
