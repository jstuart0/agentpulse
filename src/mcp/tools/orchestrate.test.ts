/**
 * Tests for src/mcp/tools/orchestrate.ts (AGEN-12 Phase 4).
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
import type { ControlAction, LaunchRequest, SupervisorRecord } from "../../shared/types.js";
import { ApiError } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
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
const FAKE_ACTION = { id: "ca-1", actionType: "stop" } as unknown as ControlAction;

describe("launch_agent — template_id mode: three-call sequence (H1, corrects test-contract assertion 1)", () => {
	test("GET template -> POST preview -> POST launches with {templateId, template, launchSpec}, never {templateId}-only", async () => {
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
			arguments: { template_id: "t1" },
		});

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["getTemplate:t1", "previewTemplate", "createLaunch"]);
		expect(createLaunchBody).toMatchObject({
			templateId: "t1",
			template: FAKE_PREVIEW.normalizedTemplate,
			launchSpec: FAKE_PREVIEW.launchSpec,
		});
		// The exact regression this test guards: a bare {templateId} body
		// cannot launch (launch-validator.ts:150 dereferences launchSpec
		// unconditionally) — assert the full shape landed, not a subset.
		expect((createLaunchBody as { template?: unknown }).template).toBeDefined();
		expect((createLaunchBody as { launchSpec?: unknown }).launchSpec).toBeDefined();
	});
});

describe("launch_agent — direct mode (template+launch_spec)", () => {
	test("posts the caller-supplied template+launch_spec directly, no getTemplate/previewTemplate calls", async () => {
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
				desired_display_name: "my session",
			},
		});

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["createLaunch"]);
		expect(createLaunchBody).toMatchObject({
			template: FAKE_PREVIEW.normalizedTemplate,
			launchSpec: FAKE_LAUNCH_SPEC,
			desiredDisplayName: "my session",
		});
		expect((createLaunchBody as { templateId?: unknown }).templateId).toBeUndefined();
	});
});

describe("launch_agent — exactly-one-mode validation (assertions 3-4)", () => {
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

describe("stop_session / retry_launch / prompt_session (assertions 9-10, L2 managed-only)", () => {
	test("stop_session -> client.stopSession(sessionId)", async () => {
		let seen: string | undefined;
		const client = fakeClient({
			stopSession: async (sessionId) => {
				seen = sessionId;
				return { action: FAKE_ACTION };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "stop_session",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBeFalsy();
		expect(seen).toBe("s1");
	});

	test("retry_launch -> client.retryLaunch(sessionId)", async () => {
		let seen: string | undefined;
		const client = fakeClient({
			retryLaunch: async (sessionId) => {
				seen = sessionId;
				return { action: FAKE_ACTION, launchRequest: FAKE_LAUNCH_REQUEST };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "retry_launch",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBeFalsy();
		expect(seen).toBe("s1");
	});

	test("prompt_session posts {prompt} matching sessions.ts:162's shape", async () => {
		let seenPrompt: string | undefined;
		const client = fakeClient({
			promptSession: async (_sessionId, prompt) => {
				seenPrompt = prompt;
				return { action: FAKE_ACTION };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "prompt_session",
			arguments: { session_id: "s1", prompt: "keep going" },
		});
		expect(result.isError).toBeFalsy();
		expect(seenPrompt).toBe("keep going");
	});

	test("prompt_session with an empty-string prompt passes through unchanged (server itself treats it as a legal no-op, sessions.ts:174)", async () => {
		let seenPrompt: string | undefined;
		const client = fakeClient({
			promptSession: async (_sessionId, prompt) => {
				seenPrompt = prompt;
				return { action: FAKE_ACTION };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "prompt_session",
			arguments: { session_id: "s1", prompt: "" },
		});
		expect(result.isError).toBeFalsy();
		expect(seenPrompt).toBe("");
	});

	test("stop_session on a non-managed session surfaces the server's exact rejection text", async () => {
		const client = fakeClient({
			stopSession: async () => {
				throw new ApiError(400, { error: "Session is not managed." });
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "stop_session",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Session is not managed.");
	});

	test("prompt_session/stop_session/retry_launch descriptions state managed-sessions-only (L2)", async () => {
		const ctx = newContext(fakeClient());
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		for (const name of ["prompt_session", "stop_session", "retry_launch"]) {
			const tool = tools.find((t) => t.name === name);
			expect(tool?.description?.toLowerCase(), `${name} description`).toContain(
				"managed sessions only",
			);
		}
	});
});

describe("update_session — per-field fan-out + partial-failure semantics (assertions 5-8, L4)", () => {
	test("only notes provided -> exactly one PUT-equivalent call (notes), none of rename/pin/archive", async () => {
		const calls: string[] = [];
		const client = fakeClient({
			updateSessionNotes: async (sessionId, notes) => {
				calls.push(`notes:${sessionId}:${notes}`);
				return { ok: true };
			},
			renameSession: async () => {
				calls.push("rename");
				return { ok: true };
			},
			pinSession: async () => {
				calls.push("pin");
				return { ok: true };
			},
			archiveSession: async () => {
				calls.push("archive");
				return { ok: true };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1", notes: "x" },
		});

		expect(result.isError).toBeFalsy();
		expect(calls).toEqual(["notes:s1:x"]);
		const parsed = JSON.parse(textOf(result));
		expect(parsed.applied).toEqual(["notes"]);
		expect(parsed.failed).toEqual([]);
	});

	test("notes + pinned -> exactly two calls, correct args each", async () => {
		const calls: string[] = [];
		const client = fakeClient({
			updateSessionNotes: async (sessionId, notes) => {
				calls.push(`notes:${sessionId}:${notes}`);
				return { ok: true };
			},
			pinSession: async (sessionId, pinned) => {
				calls.push(`pin:${sessionId}:${pinned}`);
				return { ok: true };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1", notes: "x", pinned: true },
		});

		expect(result.isError).toBeFalsy();
		expect(calls.sort()).toEqual(["notes:s1:x", "pin:s1:true"]);
		const parsed = JSON.parse(textOf(result));
		expect(parsed.applied.sort()).toEqual(["notes", "pinned"]);
	});

	test("display_name provided -> renameSession called with source:'user' (matches repo's documented rename-precedence contract)", async () => {
		let seenArgs: [string, string, string | undefined] | undefined;
		const client = fakeClient({
			renameSession: async (sessionId, name, source) => {
				seenArgs = [sessionId, name, source];
				return { ok: true };
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1", display_name: "New Name" },
		});

		expect(seenArgs).toEqual(["s1", "New Name", "user"]);
	});

	test("no optional fields provided -> zero calls, not an error, empty applied/failed", async () => {
		const called = false;
		const client = fakeClient();
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1" },
		});

		expect(result.isError).toBeFalsy();
		expect(called).toBe(false);
		const parsed = JSON.parse(textOf(result));
		expect(parsed).toEqual({ applied: [], failed: [] });
	});

	test("partial failure: one field fails, one succeeds -> not isError, failed[] names the failing field", async () => {
		const client = fakeClient({
			updateSessionNotes: async () => ({ ok: true }),
			pinSession: async () => {
				throw new ApiError(500, { error: "db unavailable" });
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1", notes: "x", pinned: true },
		});

		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.applied).toEqual(["notes"]);
		expect(parsed.failed).toHaveLength(1);
		expect(parsed.failed[0].field).toBe("pinned");
		expect(parsed.failed[0].error).toContain("db unavailable");
	});

	test("all requested fields fail -> isError:true", async () => {
		const client = fakeClient({
			updateSessionNotes: async () => {
				throw new ApiError(500, { error: "db unavailable" });
			},
		});
		const ctx = newContext(client);
		registerOrchestrateTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1", notes: "x" },
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("all 1 requested field(s) failed");
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
