/**
 * AGEN-119..123 Track 0, S9: the `claude_tool` check moved out of the shared parser unchanged, and the reserved
 * report fields (`agent`, `fromSubagent`) are refused until the track that accepts them lands. AGEN-121 accepts
 * `mcp`, for an MCP tool call only, under the rules the second half of this file holds.
 */
import { describe, expect, test } from "bun:test";
import { commandReport, fileChangeReport } from "../test-utils/codex-approvals-harness.js";
import { mcpReportServerApplied, parseClaudeToolReport } from "./claude-tool-report.js";

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

describe("an MCP tool call's report (AGEN-121)", () => {
	const RAW = "mcp__probe__echo_note";
	const mcpReport = (extra: Record<string, unknown> = {}) => ({
		...commandReport(),
		requestKind: "claude_tool",
		tool: RAW,
		target: '{\n  "text": "hi"\n}',
		mcp: { server: "probe", tool: "echo_note", rawToolName: RAW },
		...extra,
	});

	test("a well-formed report parses and carries the slot", () => {
		const parsed = parseApprovalReport(mcpReport());
		expect(parsed).toMatchObject({
			tool: RAW,
			mcp: { server: "probe", tool: "echo_note", rawToolName: RAW },
		});
	});

	test("the wire name must be mcp__<server>__<tool>, within Claude's 64 characters", () => {
		const long = `mcp__probe__${"t".repeat(52)}`;
		expect(long.length).toBe(64);
		const ok = parseApprovalReport(
			mcpReport({ tool: long, mcp: { server: "probe", tool: "t".repeat(52), rawToolName: long } }),
		);
		expect(ok).not.toBeNull();
		const tooLong = `${long}t`;
		expect(
			parseApprovalReport(
				mcpReport({
					tool: tooLong,
					mcp: { server: "probe", tool: `${"t".repeat(52)}t`, rawToolName: tooLong },
				}),
			),
		).toBeNull();
		for (const raw of [
			"mcp__probe",
			"mcp__probe__",
			"mcp__a_b__c",
			"mcp____c",
			"Bash",
			"mcp__é__c",
			"mcp__probe__a b",
		]) {
			const split = raw.split("__");
			expect(
				parseApprovalReport(
					mcpReport({
						tool: raw,
						mcp: { server: split[1] ?? "", tool: split[2] ?? "", rawToolName: raw },
					}),
				),
				raw,
			).toBeNull();
		}
	});

	test("the mcp field must equal the server's own split of the wire name", () => {
		for (const mcp of [
			{ server: "prob", tool: "e_echo_note", rawToolName: RAW },
			{ server: "probe", tool: "echo", rawToolName: RAW },
			{ server: "other", tool: "echo_note", rawToolName: RAW },
			{ server: "probe", tool: "echo_note", rawToolName: "mcp__probe__other" },
		]) {
			expect(parseApprovalReport(mcpReport({ mcp })), JSON.stringify(mcp)).toBeNull();
		}
	});

	test("the mcp field has exactly its three string members", () => {
		for (const mcp of [
			{ server: "probe", tool: "echo_note" },
			{ server: "probe", tool: "echo_note", rawToolName: RAW, extra: 1 },
			{ server: 1, tool: "echo_note", rawToolName: RAW },
			"probe",
			null,
			[],
		]) {
			expect(parseApprovalReport(mcpReport({ mcp })), JSON.stringify(mcp)).toBeNull();
		}
	});

	test("`tool` must be the wire name, and only on a Claude tool report", () => {
		expect(parseApprovalReport(mcpReport({ tool: "WebFetch" }))).toBeNull();
		expect(parseApprovalReport({ ...commandReport(), mcp: mcpReport().mcp })).toBeNull();
		expect(parseApprovalReport({ ...fileChangeReport(), mcp: mcpReport().mcp })).toBeNull();
	});

	test("the input is a JSON object of at most 16 KiB", () => {
		for (const target of ["[1]", "null", "7", '"s"', "not json", "", undefined]) {
			expect(parseApprovalReport(mcpReport({ target })), String(target)).toBeNull();
		}
		const edge = JSON.stringify({ a: "x".repeat(16 * 1024 - 8) });
		expect(edge.length).toBe(16 * 1024);
		expect(parseApprovalReport(mcpReport({ target: edge }))).not.toBeNull();
		expect(parseApprovalReport(mcpReport({ target: `${edge} ` }))).toBeNull();
	});

	test("a cut input is accepted only when the host marked it truncated and too_long", () => {
		const cut = '{"a":"xxxxxxxx';
		expect(parseApprovalReport(mcpReport({ target: cut }))).toBeNull();
		expect(
			parseApprovalReport(mcpReport({ target: cut, truncated: true, declineOnly: [] })),
		).toBeNull();
		expect(
			parseApprovalReport(mcpReport({ target: cut, truncated: true, declineOnly: ["too_long"] })),
		).not.toBeNull();
	});

	test("agent and fromSubagent stay refused beside it", () => {
		expect(parseApprovalReport(mcpReport({ fromSubagent: true }))).toBeNull();
		expect(
			parseApprovalReport(mcpReport({ agent: { subagentType: "x", prompt: "p", builtIn: true } })),
		).toBeNull();
	});

	describe("the server must be one this session was started with", () => {
		const slots = { mcp: { server: "probe", tool: "echo_note", rawToolName: RAW } };
		const applied = (...names: string[]) => ({
			mcpServers: names.map((name) => ({ name, digest: "a".repeat(64) })),
			subagents: false,
			claudeVersion: "2.1.319",
		});

		test("an applied server passes; any other, or none stored, does not", () => {
			expect(mcpReportServerApplied(slots, applied("probe"))).toBe(true);
			expect(mcpReportServerApplied(slots, applied("a", "probe"))).toBe(true);
			expect(mcpReportServerApplied(slots, applied("other"))).toBe(false);
			expect(mcpReportServerApplied(slots, applied())).toBe(false);
			expect(mcpReportServerApplied(slots, null)).toBe(false);
		});

		test("a report with no mcp slot is not judged against the servers", () => {
			expect(mcpReportServerApplied({}, null)).toBe(true);
		});

		test("a prefix is not a match", () => {
			expect(mcpReportServerApplied(slots, applied("prob"))).toBe(false);
			expect(mcpReportServerApplied(slots, applied("probe2"))).toBe(false);
		});
	});
});
