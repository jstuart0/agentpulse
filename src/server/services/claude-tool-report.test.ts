/**
 * AGEN-119..123 Track 0, S9: the `claude_tool` check moved out of the shared parser unchanged, and the reserved
 * report fields (`mcp`, `agent`, `fromSubagent`) are refused until the track that accepts them lands.
 */
import { describe, expect, test } from "bun:test";
import { commandReport, fileChangeReport } from "../test-utils/codex-approvals-harness.js";
import { parseClaudeToolReport } from "./claude-tool-report.js";

const { parseApprovalReport } = await import("./codex-approvals.js");

const toolReport = (tool: string, extra: Record<string, unknown> = {}) => ({
	...commandReport(),
	requestKind: "claude_tool",
	tool,
	target: tool === "Read" ? "/etc/hosts" : "https://example.com/x",
	...extra,
});

describe("every report that passes today still passes", () => {
	test("a Codex command, a Codex file change, a Claude WebFetch and a Claude Read", () => {
		for (const [label, body] of [
			["command", commandReport()],
			["file change", fileChangeReport()],
			["WebFetch", toolReport("WebFetch")],
			["Read", toolReport("Read")],
		] as const) {
			const parsed = parseApprovalReport(body);
			expect(parsed, label).not.toBeNull();
			expect(parsed, label).not.toHaveProperty("mcp");
			expect(parsed, label).not.toHaveProperty("agent");
			expect(parsed, label).not.toHaveProperty("fromSubagent");
		}
	});

	test("a claude_tool for any other tool is refused, as before (named member: Bash, an MCP name, Agent)", () => {
		for (const tool of ["Bash", "Write", "mcp__probe__echo", "Agent", ""]) {
			expect(parseApprovalReport(toolReport(tool)), tool).toBeNull();
		}
	});
});

describe("a report carrying a reserved field is refused", () => {
	const reserved: Array<[string, unknown]> = [
		["mcp", { server: "probe", tool: "echo", rawToolName: "mcp__probe__echo" }],
		["agent", { subagentType: "general-purpose", prompt: "p", builtIn: true }],
		["fromSubagent", true],
	];
	for (const [field, value] of reserved) {
		test(`${field}, on a Claude tool report and on a command and a file change`, () => {
			expect(parseApprovalReport(toolReport("WebFetch", { [field]: value }))).toBeNull();
			expect(parseApprovalReport({ ...commandReport(), [field]: value })).toBeNull();
			expect(parseApprovalReport({ ...fileChangeReport(), [field]: value })).toBeNull();
			// Positive control: the same bodies without the field parse.
			expect(parseApprovalReport(toolReport("WebFetch"))).not.toBeNull();
		});
	}

	test("the parser itself: no slots for a good report, null for a reserved or a wrong-tool one", () => {
		expect(parseClaudeToolReport({ requestKind: "claude_tool", tool: "Read" })).toEqual({});
		expect(parseClaudeToolReport({ requestKind: "command" })).toEqual({});
		expect(parseClaudeToolReport({ requestKind: "command", fromSubagent: false })).toBeNull();
		expect(parseClaudeToolReport({ requestKind: "claude_tool", tool: "Bash" })).toBeNull();
	});
});
