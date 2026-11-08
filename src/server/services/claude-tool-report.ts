/**
 * The server's check of what a Claude fork's approval report says about its tool (AGEN-119..123 Track 0, S9).
 * The `claude_tool` check that lived inline in `parseApprovalReport` is here unchanged, so the MCP tracks
 * (AGEN-121 MCP tools, then AGEN-120 the Agent call) add their branches to this file alone and never edit the
 * shared parser.
 *
 * The reserved optional report fields `mcp`, `agent` and `fromSubagent` are read here. Until a track accepts
 * them a report that carries one is refused as malformed: nothing a host sends today has them.
 */
import type { CodexApprovalAgentSlot, CodexApprovalMcpSlot } from "../../shared/codex-approvals.js";

/** The slots a valid report adds to the presentation. Empty in Track 0. */
export interface ClaudeToolReportSlots {
	mcp?: CodexApprovalMcpSlot;
	agent?: CodexApprovalAgentSlot;
	fromSubagent?: boolean;
}

const RESERVED_FIELDS = ["mcp", "agent", "fromSubagent"] as const;

/** The slots of a report, or null when the report is not acceptable for a Claude tool request. */
export function parseClaudeToolReport(body: Record<string, unknown>): ClaudeToolReportSlots | null {
	if (RESERVED_FIELDS.some((field) => body[field] !== undefined)) return null;
	if (body.requestKind === "claude_tool" && body.tool !== "WebFetch" && body.tool !== "Read") {
		return null;
	}
	return {};
}
