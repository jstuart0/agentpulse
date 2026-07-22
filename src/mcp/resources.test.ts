/**
 * Tests for src/mcp/resources.ts (AGEN-12 Phase 3, test-contract assertions
 * 16-18): resources/list shape, resources/read for the static and templated
 * resources, and the missing/invalid session-id boundary case.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "../shared/types.js";
import { ApiError } from "./client.js";
import { registerResources } from "./resources.js";
import { fakeClient } from "./test-support.js";

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

async function connectedServer(client: ReturnType<typeof fakeClient>) {
	const server = new McpServer({ name: "agentpulse-test", version: "0.0.0-test" });
	registerResources(server, client);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
	return mcpClient;
}

describe("resources/list", () => {
	test("returns the 3 D2 resources with correct URIs/templates", async () => {
		const mcpClient = await connectedServer(fakeClient());
		const { resources } = await mcpClient.listResources();
		expect(resources.map((r) => r.uri)).toContain("agentpulse://sessions");
		expect(resources.map((r) => r.uri)).toContain("agentpulse://digest");

		const { resourceTemplates } = await mcpClient.listResourceTemplates();
		expect(resourceTemplates.map((t) => t.uriTemplate)).toContain(
			"agentpulse://sessions/{sessionId}",
		);
	});
});

describe("resources/read", () => {
	test("agentpulse://sessions returns application/json contents", async () => {
		const mcpClient = await connectedServer(
			fakeClient({ getSessions: async () => ({ sessions: [baseSession()], total: 1 }) }),
		);
		const result = await mcpClient.readResource({ uri: "agentpulse://sessions" });
		expect((result.contents[0] as { mimeType?: string }).mimeType).toBe("application/json");
		const parsed = JSON.parse((result.contents[0] as { text: string }).text);
		expect(parsed.sessions[0].sessionId).toBe("s1");
	});

	test("agentpulse://digest returns application/json contents", async () => {
		const mcpClient = await connectedServer(
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
		const result = await mcpClient.readResource({ uri: "agentpulse://digest" });
		expect((result.contents[0] as { mimeType?: string }).mimeType).toBe("application/json");
	});

	test("agentpulse://sessions/{sessionId} matches get_session's payload shape for the same id", async () => {
		const client = fakeClient({
			getSession: async () => ({ session: baseSession(), events: [], controlActions: undefined }),
		});
		const mcpClient = await connectedServer(client);
		const result = await mcpClient.readResource({ uri: "agentpulse://sessions/s1" });
		const parsed = JSON.parse((result.contents[0] as { text: string }).text);
		expect(parsed.session.sessionId).toBe("s1");
		expect(parsed.managed).toBe(false);
		expect(parsed.events).toEqual([]);
	});

	test("a nonexistent session id (client 404s) surfaces as a protocol-level failure, not an unhandled exception", async () => {
		const client = fakeClient({
			getSession: async () => {
				throw new ApiError(404, { error: "Session not found" });
			},
		});
		const mcpClient = await connectedServer(client);
		await expect(
			mcpClient.readResource({ uri: "agentpulse://sessions/does-not-exist" }),
		).rejects.toBeDefined();
	});

	test("an unmatched resource URI is a clean protocol-level error", async () => {
		const mcpClient = await connectedServer(fakeClient());
		await expect(mcpClient.readResource({ uri: "agentpulse://unknown" })).rejects.toBeDefined();
	});
});
