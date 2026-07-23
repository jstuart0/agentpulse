/**
 * Tests for catalog.ts (AGEN-12 Phase 3): search, list_projects,
 * list_templates/get_template, list_launches/get_launch. get_stats already
 * covered by server.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import type { LaunchRequest, SessionTemplate } from "../types.js";
import { registerCatalogTools } from "./catalog.js";

/** Minimal fixtures — LaunchRequest/SessionTemplate carry ~15-30 fields irrelevant to these pass-through happy-path tests; cast rather than enumerate every one. */
const fakeLaunchRequest = (overrides: Partial<LaunchRequest>): LaunchRequest =>
	overrides as LaunchRequest;
const fakeTemplate = (overrides: Partial<SessionTemplate>): SessionTemplate =>
	overrides as SessionTemplate;

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

describe("search — cap behavior (test-contract 13)", () => {
	test("an oversized aggregate of hit snippets is capped via output.ts, not passed through raw", async () => {
		const hits = Array.from({ length: 500 }, (_, i) => ({
			kind: "event" as const,
			sessionId: `s${i}`,
			eventId: i,
			eventType: "PostToolUse",
			snippet: "x".repeat(200),
			score: 1,
			timestamp: "2026-01-01 00:00:00",
			sessionDisplayName: null,
			sessionCwd: null,
		}));
		const ctx = newContext(
			fakeClient({
				search: async () => ({ hits, total: hits.length, backend: "sqlite-fts5" }),
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "search", arguments: { q: "test" } });
		expect(result.isError).toBeFalsy();
		const text = textOf(result);
		expect(text.length).toBeLessThan(JSON.stringify({ hits, total: hits.length }).length);
		const parsed = JSON.parse(text);
		expect(parsed.truncated).toBeDefined();
	});

	test("a single oversized snippet is capped, not truncated to an empty preview", async () => {
		const hits = [
			{
				kind: "event" as const,
				sessionId: "s1",
				eventId: 1,
				eventType: "PostToolUse",
				snippet: "y".repeat(5000),
				score: 1,
				timestamp: "2026-01-01 00:00:00",
				sessionDisplayName: null,
				sessionCwd: null,
			},
		];
		const ctx = newContext(
			fakeClient({ search: async () => ({ hits, total: 1, backend: "sqlite-fts5" }) }),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "search", arguments: { q: "test" } });
		const parsed = JSON.parse(textOf(result));
		expect(parsed.hits[0].snippet.length).toBeLessThan(600);
	});
});

describe("list_projects (F23: manage-scoped — mapProject() carries arbitrary notes/metadata + githubRepoUrl userinfo)", () => {
	test("returns projects + total from the client", async () => {
		const ctx = newContext(
			fakeClient({
				listProjects: async () => ({
					projects: [
						{
							id: "p1",
							name: "proj",
							cwd: "/repo",
							githubRepoUrl: null,
							defaultAgentType: null,
							defaultModel: null,
							defaultLaunchMode: null,
							notes: null,
							tags: [],
							isFavorite: false,
							metadata: {},
							createdAt: "2026-01-01 00:00:00",
							updatedAt: "2026-01-01 00:00:00",
						},
					],
					total: 1,
				}),
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_projects", arguments: {} });
		const parsed = JSON.parse(textOf(result));
		expect(parsed.total).toBe(1);
		expect(parsed.projects[0].id).toBe("p1");
	});

	test("is NOT registered under observe-only (F23)", () => {
		const ctx = newContext(fakeClient());
		registerCatalogTools(ctx, { hasObserve: true, hasManage: false });
		expect(ctx.registry.map((r) => r.name)).not.toContain("list_projects");
	});
});

describe("list_projects_summary (AIMR-214 Phase A: observe-scoped, redacted DTO)", () => {
	test("returns the reduced projects list from the client", async () => {
		const ctx = newContext(
			fakeClient({
				listProjectsSummary: async () => ({
					projects: [
						{
							id: "p1",
							name: "proj",
							defaultAgentType: "claude_code",
							defaultModel: null,
							defaultLaunchMode: null,
							githubRepoUrl: "https://github.com/acme/repo",
						},
					],
				}),
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_projects_summary", arguments: {} });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.total).toBe(1);
		expect(parsed.projects[0]).toEqual({
			id: "p1",
			name: "proj",
			defaultAgentType: "claude_code",
			defaultModel: null,
			defaultLaunchMode: null,
			githubRepoUrl: "https://github.com/acme/repo",
		});
	});

	test("IS registered under observe-only (unlike list_projects, F23)", () => {
		const ctx = newContext(fakeClient());
		registerCatalogTools(ctx, { hasObserve: true, hasManage: false });
		expect(ctx.registry.map((r) => r.name)).toContain("list_projects_summary");
	});

	test("is also registered when hasManage is true (observe tools stay visible under manage)", () => {
		const ctx = newContext(fakeClient());
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		expect(ctx.registry.map((r) => r.name)).toContain("list_projects_summary");
	});
});

describe("manage-only tools require manage scope to register", () => {
	test("list_projects/list_templates/get_template/list_launches/get_launch are not registered under observe-only", () => {
		const ctx = newContext(fakeClient());
		registerCatalogTools(ctx, { hasObserve: true, hasManage: false });
		const names = ctx.registry.map((r) => r.name);
		expect(names).not.toContain("list_projects");
		expect(names).not.toContain("list_templates");
		expect(names).not.toContain("get_template");
		expect(names).not.toContain("list_launches");
		expect(names).not.toContain("get_launch");
	});

	test("they ARE registered when hasManage is true", () => {
		const ctx = newContext(fakeClient());
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		const names = ctx.registry.map((r) => r.name);
		expect(names).toContain("list_projects");
		expect(names).toContain("list_templates");
		expect(names).toContain("get_template");
		expect(names).toContain("list_launches");
		expect(names).toContain("get_launch");
	});
});

describe("list_templates / list_launches / get_launch — happy path (tessa H-3)", () => {
	test("list_templates returns real template rows", async () => {
		const ctx = newContext(
			fakeClient({
				listTemplates: async () => ({
					templates: [
						fakeTemplate({
							id: "t1",
							name: "default",
							agentType: "claude_code",
							cwd: "/repo",
							env: { SOME_KEY: "value" },
						}),
					],
					total: 1,
				}),
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_templates", arguments: {} });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.total).toBe(1);
		expect(parsed.templates[0].id).toBe("t1");
		expect(parsed.templates[0].env).toEqual({ SOME_KEY: "value" });
	});

	test("list_launches returns real launch rows", async () => {
		const ctx = newContext(
			fakeClient({
				listLaunches: async () => ({
					launches: [fakeLaunchRequest({ id: "l1", status: "queued" })],
					total: 1,
				}),
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_launches", arguments: {} });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.total).toBe(1);
		expect(parsed.launches[0].id).toBe("l1");
	});

	test("get_launch returns launchRequest + session from the client", async () => {
		const ctx = newContext(
			fakeClient({
				getLaunch: async () => ({
					launchRequest: fakeLaunchRequest({ id: "l1", status: "running" }),
					session: null,
				}),
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "get_launch", arguments: { launch_id: "l1" } });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.launchRequest.id).toBe("l1");
		expect(parsed.session).toBeNull();
	});
});

describe("get_template / get_launch — pass-through with nonexistent id → isError", () => {
	test("get_template with an id the fake client 404s on", async () => {
		const { ApiError } = await import("../client.js");
		const ctx = newContext(
			fakeClient({
				getTemplate: async () => {
					throw new ApiError(404, { error: "Template not found" });
				},
			}),
		);
		registerCatalogTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_template",
			arguments: { template_id: "nope" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Template not found");
	});
});
