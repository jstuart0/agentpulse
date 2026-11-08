/**
 * The server's check of what a Claude fork's approval report says about its tool (AGEN-119..123 Track 0, S9).
 * The `claude_tool` check that lived inline in `parseApprovalReport` is here unchanged, so the MCP tracks
 * (AGEN-121 MCP tools, then AGEN-120 the Agent call) add their branches to this file alone and never edit the
 * shared parser.
 *
 * The optional report fields `mcp`, `agent` and `fromSubagent` are read here; any other shape is malformed.
 */
import {
	FORK_MCP_INPUT_MAX_CHARS,
	isPlainObject,
	splitForkMcpToolName,
} from "../../shared/claude-fork-mcp.js";
import { AGENT_PROMPT_MAX_CHARS, AGENT_TYPE_PATTERN } from "../../shared/claude-fork-subagents.js";
import type { CodexApprovalAgentSlot, CodexApprovalMcpSlot } from "../../shared/codex-approvals.js";
import type { AppliedForkOptions } from "../../shared/session-resume.js";

/** The slots a valid report adds to the presentation. */
export interface ClaudeToolReportSlots {
	mcp?: CodexApprovalMcpSlot;
	agent?: CodexApprovalAgentSlot;
	fromSubagent?: boolean;
}

const AGENT_KEYS = ["subagentType", "prompt", "builtIn"] as const;
const AGENT_TOOL = "Agent";

/** The `agent` field (AGEN-120), exactly its three members, or null when it is not that. */
function parseAgentSlot(value: unknown): CodexApprovalAgentSlot | null {
	if (!isPlainObject(value)) return null;
	const keys = Object.keys(value);
	if (keys.length !== AGENT_KEYS.length || !AGENT_KEYS.every((k) => keys.includes(k))) return null;
	const { subagentType, prompt, builtIn } = value;
	if (typeof subagentType !== "string" || !AGENT_TYPE_PATTERN.test(subagentType)) return null;
	if (typeof prompt !== "string" || prompt.length > AGENT_PROMPT_MAX_CHARS) return null;
	if (typeof builtIn !== "boolean") return null;
	return { subagentType, prompt, builtIn };
}

/**
 * An MCP tool call's report (AGEN-121): the wire name must be a well-formed `mcp__<server>__<tool>` within
 * Claude's 64-character limit, `mcp` must equal this file's own split of it (the host's word is never taken for
 * the split), and `target` is the call's input: a JSON object of at most 16 KiB. A report the host had to cut
 * (and so marked decline-only `too_long`) may carry text that isn't whole JSON; it can't be approved anyway.
 */
function parseMcpReport(body: Record<string, unknown>): CodexApprovalMcpSlot | null {
	if (body.requestKind !== "claude_tool") return null;
	const claimed = body.mcp;
	if (!isPlainObject(claimed)) return null;
	const keys = Object.keys(claimed);
	if (keys.length !== 3 || !["server", "tool", "rawToolName"].every((k) => keys.includes(k))) {
		return null;
	}
	const { server, tool, rawToolName } = claimed;
	if (typeof server !== "string" || typeof tool !== "string" || typeof rawToolName !== "string") {
		return null;
	}
	const split = splitForkMcpToolName(rawToolName);
	if (split === null || split.server !== server || split.tool !== tool) return null;
	if (body.tool !== rawToolName) return null;
	const target = body.target;
	if (typeof target !== "string" || target.length > FORK_MCP_INPUT_MAX_CHARS) return null;
	if (body.truncated === true) {
		if (!Array.isArray(body.declineOnly) || !body.declineOnly.includes("too_long")) return null;
	} else {
		try {
			if (!isPlainObject(JSON.parse(target))) return null;
		} catch {
			return null;
		}
	}
	return { server, tool, rawToolName };
}

/** The slots of a report, or null when the report is not acceptable for a Claude tool request. */
export function parseClaudeToolReport(body: Record<string, unknown>): ClaudeToolReportSlots | null {
	const slots: ClaudeToolReportSlots = {};
	// A subagent's request (AGEN-120): the literal true, or absent.
	if (body.fromSubagent !== undefined) {
		if (body.fromSubagent !== true) return null;
		slots.fromSubagent = true;
	}
	if (body.mcp !== undefined) {
		if (body.agent !== undefined) return null;
		const mcp = parseMcpReport(body);
		return mcp === null ? null : { ...slots, mcp };
	}
	const isClaudeTool = body.requestKind === "claude_tool";
	const isAgentCall = isClaudeTool && body.tool === AGENT_TOOL;
	if (body.agent !== undefined) {
		// The slot belongs to the Agent call alone.
		if (!isAgentCall) return null;
		const agent = parseAgentSlot(body.agent);
		if (agent === null) return null;
		// The card's target is the type it names: one source of truth for what the person is asked about.
		if (body.target !== agent.subagentType) return null;
		slots.agent = agent;
	} else if (isAgentCall) {
		return null;
	}
	if (isClaudeTool && !isAgentCall && body.tool !== "WebFetch" && body.tool !== "Read") {
		return null;
	}
	return slots;
}

/**
 * Whether an MCP report names a server this session was started with. The session's stored applied servers are
 * the only authority: a report for any other server (or from a session with none) is refused, so a host that is
 * lying or out of step can't put a card up for a server the person never listed.
 */
export function mcpReportServerApplied(
	slots: ClaudeToolReportSlots,
	applied: AppliedForkOptions | null,
): boolean {
	if (!slots.mcp) return true;
	return (applied?.mcpServers ?? []).some((s) => s.name === slots.mcp?.server);
}
