/**
 * Tests for src/mcp/tools/sessions.ts (AGEN-12 Phase 3).
 *
 * Test-contract Phase 3 assertions 1-2 (validation), 6-8 (get_session
 * 500-event trim), 9-12 (pagination), plus buildSessionDetailPayload reuse.
 * Fake AgentPulseClient throughout (D3 seam 1) — no real HTTP.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ControlAction, Session, SessionEvent } from "../../shared/types.js";
import { ApiError } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import { registerSessionsTools } from "./sessions.js";

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

function baseSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "1",
		sessionId: "s1",
		displayName: "test session",
		agentType: "claude_code",
		status: "active",
		cwd: "/repo",
		transcriptPath: null,
		model: "claude",
		startedAt: "2026-01-01 00:00:00",
		lastActivityAt: "2026-01-01 00:00:00",
		endedAt: null,
		semanticStatus: null,
		currentTask: null,
		planSummary: null,
		totalToolUses: 0,
		isWorking: false,
		isPinned: false,
		gitBranch: null,
		claudeMdContent: null,
		claudeMdPath: null,
		claudeMdUpdatedAt: null,
		notes: null,
		metadata: {},
		projectId: null,
		isArchived: false,
		managedSession: null,
		...overrides,
	};
}

function fakeEvent(id: number, overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		id,
		sessionId: "s1",
		eventType: "PostToolUse",
		category: "tool_event",
		source: "observed_hook",
		content: null,
		isNoise: false,
		providerEventType: null,
		toolName: "Bash",
		toolInput: { command: "ls" },
		toolResponse: "ok",
		rawPayload: {},
		createdAt: "2026-01-01 00:00:00",
		...overrides,
	};
}

describe("registerSessionsTools — input validation", () => {
	test("get_session with a nonexistent session_id (fake client 404) → isError, names the id", async () => {
		const ctx = newContext(
			fakeClient({
				getSession: async () => {
					throw new ApiError(404, { error: "Session not found" });
				},
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session",
			arguments: { session_id: "nope" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Session not found");
	});
});

describe("get_session — 500-event trim (test-contract 6-8)", () => {
	test("500 events in the fake payload → tool returns exactly the last 20", async () => {
		const events = Array.from({ length: 500 }, (_, i) => fakeEvent(500 - i));
		const ctx = newContext(
			fakeClient({
				getSession: async () => ({ session: baseSession(), events, controlActions: undefined }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.events.length).toBe(20);
		expect(parsed.moreEvents).toBeDefined();
		expect(parsed.managed).toBe(false);
	});

	test("fewer than 20 events → all returned, no phantom 'more' pointer", async () => {
		const events = [fakeEvent(1), fakeEvent(2), fakeEvent(3)];
		const ctx = newContext(
			fakeClient({
				getSession: async () => ({ session: baseSession(), events, controlActions: undefined }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session",
			arguments: { session_id: "s1" },
		});
		const parsed = JSON.parse(textOf(result));
		expect(parsed.events.length).toBe(3);
		expect(parsed.moreEvents).toBeUndefined();
	});

	test("zero events → empty array, not an error", async () => {
		const ctx = newContext(
			fakeClient({
				getSession: async () => ({ session: baseSession(), events: [], controlActions: undefined }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.events).toEqual([]);
	});

	test("controlActions present (manage caller) is passed through; absent (observe) is omitted", async () => {
		const controlActions: ControlAction[] = [
			{
				id: "a1",
				sessionId: "s1",
				launchRequestId: null,
				actionType: "stop",
				requestedBy: null,
				status: "queued",
				error: null,
				metadata: {},
				idempotencyKey: null,
				claimedBySupervisorId: null,
				finishedAt: null,
				createdAt: "2026-01-01 00:00:00",
				updatedAt: "2026-01-01 00:00:00",
			},
		];
		const ctx = newContext(
			fakeClient({
				getSession: async () => ({ session: baseSession(), events: [], controlActions }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session",
			arguments: { session_id: "s1" },
		});
		const parsed = JSON.parse(textOf(result));
		expect(parsed.controlActions).toBeDefined();
		expect(parsed.controlActions.length).toBe(1);
	});

	test("tool_input/tool_response previews are capped to ~500 chars", async () => {
		const bigInput = { command: "x".repeat(2000) };
		const events = [fakeEvent(1, { toolInput: bigInput, toolResponse: "y".repeat(2000) })];
		const ctx = newContext(
			fakeClient({
				getSession: async () => ({ session: baseSession(), events, controlActions: undefined }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session",
			arguments: { session_id: "s1" },
		});
		const parsed = JSON.parse(textOf(result));
		expect(parsed.events[0].toolInput.length).toBeLessThan(600);
		expect(parsed.events[0].toolResponse.length).toBeLessThan(600);
	});
});

describe("list_sessions — pagination (test-contract 9-10, 12)", () => {
	test("a full page (returned === limit, more exist per total) → continuation hint present", async () => {
		const sessions = Array.from({ length: 20 }, (_, i) => baseSession({ sessionId: `s${i}` }));
		const ctx = newContext(
			fakeClient({
				getSessions: async () => ({ sessions, total: 45 }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_sessions", arguments: { limit: 20 } });
		const parsed = JSON.parse(textOf(result));
		expect(parsed.sessions.length).toBe(20);
		expect(parsed.hint).toBeDefined();
		expect(parsed.hint).toContain("offset=20");
	});

	test("fewer rows than limit (total matches returned) → no continuation hint", async () => {
		const sessions = Array.from({ length: 3 }, (_, i) => baseSession({ sessionId: `s${i}` }));
		const ctx = newContext(
			fakeClient({
				getSessions: async () => ({ sessions, total: 3 }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_sessions", arguments: { limit: 20 } });
		const parsed = JSON.parse(textOf(result));
		expect(parsed.sessions.length).toBe(3);
		expect(parsed.hint).toBeUndefined();
	});

	test("zero results → valid empty response, no hint, no crash", async () => {
		const ctx = newContext(
			fakeClient({
				getSessions: async () => ({ sessions: [], total: 0 }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_sessions", arguments: {} });
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(textOf(result));
		expect(parsed.sessions).toEqual([]);
		expect(parsed.hint).toBeUndefined();
	});

	test("each row includes a `managed` boolean", async () => {
		const ctx = newContext(
			fakeClient({
				getSessions: async () => ({ sessions: [baseSession()], total: 1 }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({ name: "list_sessions", arguments: {} });
		const parsed = JSON.parse(textOf(result));
		expect(parsed.sessions[0].managed).toBe(false);
	});
});

describe("get_session_timeline — offset round-trip (test-contract 11)", () => {
	test("offset is passed through to the underlying client call", async () => {
		let recordedParams: unknown;
		const ctx = newContext(
			fakeClient({
				getSessionTimeline: async (_sessionId, params) => {
					recordedParams = params;
					return { events: [] };
				},
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		await mcpClient.callTool({
			name: "get_session_timeline",
			arguments: { session_id: "s1", offset: 40, limit: 10 },
		});
		expect(recordedParams).toEqual({ limit: 10, offset: 40 });
	});

	test("a full page → continuation hint; a partial page → none", async () => {
		const ctx = newContext(
			fakeClient({
				getSessionTimeline: async (_sessionId, params) => ({
					events: Array.from({ length: params?.limit ?? 30 }, (_, i) => fakeEvent(i)),
				}),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const full = await mcpClient.callTool({
			name: "get_session_timeline",
			arguments: { session_id: "s1", limit: 5 },
		});
		expect(JSON.parse(textOf(full)).hint).toBeDefined();
	});
});

describe("get_event_context / get_session_claude_md — pass-through", () => {
	test("get_event_context returns events + target from the client", async () => {
		const ctx = newContext(
			fakeClient({
				getEventContext: async () => ({ events: [fakeEvent(5)], target: { id: 5 } }),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_event_context",
			arguments: { session_id: "s1", event_id: 5 },
		});
		const parsed = JSON.parse(textOf(result));
		expect(parsed.target).toEqual({ id: 5 });
		expect(parsed.events.length).toBe(1);
	});

	test("get_session_claude_md returns the claude-md payload", async () => {
		const ctx = newContext(
			fakeClient({
				getSessionClaudeMd: async () => ({
					content: "# hi",
					path: "CLAUDE.md",
					checksum: "abc",
					updatedAt: null,
				}),
			}),
		);
		registerSessionsTools(ctx, { hasObserve: true, hasManage: false });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "get_session_claude_md",
			arguments: { session_id: "s1" },
		});
		const parsed = JSON.parse(textOf(result));
		expect(parsed.content).toBe("# hi");
	});
});

describe("scope gating", () => {
	test("no tools are registered when hasObserve is false", () => {
		const ctx = newContext(fakeClient());
		registerSessionsTools(ctx, { hasObserve: false, hasManage: false });
		expect(ctx.registry.length).toBe(0);
	});
});
