/**
 * Read-only MCP resources (AGEN-12 Phase 3, D2 "resources vs tools" note):
 * `@`-mention ergonomics for Claude Code. Tools remain canonical (Codex
 * resource support unconfirmed) — these three wrap the same client calls
 * as list_sessions/get_session/get_digest and duplicate no mutation.
 *
 * Registered only when the connection holds observe (or manage, which
 * implies observe) — same gate as the equivalent tools. Resource read
 * callbacks are NOT wrapped by registerReadTool/registerMutatingTool (those
 * wrappers are tool-only, per D3 seam 2) — output capping is applied
 * manually here via capToolResult, and a thrown ApiError/NetworkError from
 * the client propagates to the SDK's own request handler, which converts it
 * to a protocol-level JSON-RPC error (not an {isError} tool result) — the
 * correct behavior for a resource read failure (test-contract assertion 18).
 */
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentPulseClient } from "./client.js";
import { capList, capToolResult } from "./output.js";
import { buildSessionDetailPayload, compactSessionRow } from "./tools/sessions.js";

function jsonContents(uri: URL, data: unknown) {
	return {
		contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
	};
}

export function registerResources(server: McpServer, client: AgentPulseClient): void {
	server.registerResource(
		"sessions",
		"agentpulse://sessions",
		{
			title: "AgentPulse sessions",
			description: "Compact list of the most recent AgentPulse sessions across the fleet.",
			mimeType: "application/json",
		},
		async (uri) => {
			// Reuses list_sessions' exact row shape (compactSessionRow) rather
			// than hand-building a third, diverged copy (dexter Low-Med).
			const { sessions, total } = await client.getSessions({ limit: 20 });
			const capped = capList(sessions.map(compactSessionRow));
			return jsonContents(uri, { sessions: capped.items, total });
		},
	);

	server.registerResource(
		"session-detail",
		new ResourceTemplate("agentpulse://sessions/{sessionId}", { list: undefined }),
		{
			title: "AgentPulse session detail",
			description: "Full detail for one AgentPulse session, by session id.",
			mimeType: "application/json",
		},
		async (uri, variables) => {
			const sessionId = Array.isArray(variables.sessionId)
				? variables.sessionId[0]
				: variables.sessionId;
			const payload = await buildSessionDetailPayload(client, sessionId ?? "");
			return jsonContents(uri, capToolResult(payload));
		},
	);

	server.registerResource(
		"digest",
		"agentpulse://digest",
		{
			title: "AgentPulse daily digest",
			description: "Cross-session daily digest grouped by project/cwd.",
			mimeType: "application/json",
		},
		async (uri) => {
			const digest = await client.getDigest();
			return jsonContents(uri, capToolResult(digest));
		},
	);
}
