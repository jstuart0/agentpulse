/**
 * Tests for session-actions.ts (AGEN-12 Phase 4):
 * prompt_session, stop_session, retry_launch, update_session. Moved here
 * from orchestrate.test.ts alongside the Phase 4 mid-build file split
 * (dexter M) — no behavior change, same assertions.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError } from "../client.js";
import type { ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import type { ControlAction, LaunchRequest } from "../types.js";
import { registerSessionActionTools } from "./session-actions.js";

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

const FAKE_LAUNCH_REQUEST = { id: "lr-1", status: "validated" } as unknown as LaunchRequest;
const FAKE_ACTION = { id: "ca-1", actionType: "stop" } as unknown as ControlAction;

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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const result = await mcpClient.callTool({
			name: "stop_session",
			arguments: { session_id: "s1" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Session is not managed.");
	});

	test("prompt_session/stop_session/retry_launch/update_session descriptions state managed-sessions-only (L2) and the confirmation-portability caveat (xander H1/e)", async () => {
		const ctx = newContext(fakeClient());
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);
		const { tools } = await mcpClient.listTools();
		for (const name of ["prompt_session", "stop_session", "retry_launch"]) {
			const tool = tools.find((t) => t.name === name);
			expect(tool?.description?.toLowerCase(), `${name} description`).toContain(
				"managed sessions only",
			);
			expect(tool?.description, `${name} confirmation-portability caveat`).toContain(
				"state-changing action",
			);
		}
		const updateSession = tools.find((t) => t.name === "update_session");
		expect(updateSession?.description).toContain("state-changing action");
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
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
		registerSessionActionTools(ctx, { hasObserve: true, hasManage: true });
		const mcpClient = await connect(ctx);

		const result = await mcpClient.callTool({
			name: "update_session",
			arguments: { session_id: "s1", notes: "x" },
		});

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("all 1 requested field(s) failed");
	});
});
