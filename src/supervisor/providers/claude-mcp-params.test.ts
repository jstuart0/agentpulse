/**
 * AGEN-121: how the host reads an MCP `can_use_tool` request. The split is made against the applied servers,
 * the request must agree with it, the input is shown whole, and anything the host can't vouch for is
 * decline-only (never silently approvable).
 */
import { describe, expect, test } from "bun:test";
import { CLAUDE_FIXTURE_DIR_2_1_319, outLines } from "./__fixtures__/claude-frames.js";
import {
	type ClaudeParseContext,
	buildClaudeReportBody,
	parseClaudeRequest,
} from "./claude-approval-params.js";

const applied = {
	mcpServers: [
		{ name: "probe", digest: "a".repeat(64) },
		{ name: "a-b", digest: "b".repeat(64) },
	],
	subagents: false,
	claudeVersion: "2.1.319",
};
const ctx = (over: Partial<ClaudeParseContext> = {}): ClaudeParseContext => ({
	threadId: "fork-1",
	turnId: "turn-1",
	cwd: "/work/project",
	configDir: null,
	inputStable: true,
	applied,
	...over,
});

/** A request as Claude Code 2.1.319 raises it for `probe`'s `echo_note`. */
const request = (over: Record<string, unknown> = {}) => ({
	subtype: "can_use_tool",
	tool_name: "mcp__probe__echo_note",
	mcp_server: { name: "probe", source: "dynamic" },
	display_name: "Echo Note",
	input: { text: "hello" },
	permission_suggestions: [{ type: "addRules" }],
	server_policy_ask_only: true,
	tool_use_id: "toolu_1",
	...over,
});

describe("an MCP request of an applied server", () => {
	test("the recorded request is understood: claude_tool, the server's split, the input as JSON, nothing decline-only", () => {
		const recorded = outLines("m1-base-key", CLAUDE_FIXTURE_DIR_2_1_319).find(
			(m) => m.type === "control_request" && m.request?.tool_name === "mcp__probe__echo_note",
		)?.request;
		const parsed = parseClaudeRequest(recorded, ctx());
		expect(parsed).toMatchObject({
			kind: "claude_tool",
			declineOnly: [],
			claude: {
				tool: "mcp__probe__echo_note",
				mcp: { server: "probe", tool: "echo_note", rawToolName: "mcp__probe__echo_note" },
				input: { text: "hello-base" },
			},
		});
		expect(JSON.parse(parsed?.claude?.target ?? "")).toEqual({ text: "hello-base" });
	});

	test("an input of any shape is accepted: nested, empty, with numbers, with keys no schema of ours knows", () => {
		for (const input of [{}, { a: { b: [1, 2, { c: null }] } }, { weird_key: true, n: 1.5 }]) {
			const parsed = parseClaudeRequest(request({ input }), ctx());
			expect(parsed?.declineOnly, JSON.stringify(input)).toEqual([]);
			expect(parsed?.claude?.input).toEqual(input);
		}
	});

	test("what is allowed back is the input exactly as Claude sent it, not the text shown", () => {
		const input = { text: "x", n: 1 };
		const parsed = parseClaudeRequest(request({ input }), ctx());
		expect(parsed?.claude?.input).toBe(input as never);
	});

	test("the report carries the wire name as `tool`, the slot, and the input as the target", () => {
		const parsed = parseClaudeRequest(request(), ctx());
		if (!parsed) throw new Error("not parsed");
		const body = buildClaudeReportBody({
			runtimeEpoch: "e",
			rpcId: "r",
			parsed,
			ageMs: 0,
			revision: 1,
		});
		expect(body).toMatchObject({
			requestKind: "claude_tool",
			tool: "mcp__probe__echo_note",
			mcp: { server: "probe", tool: "echo_note", rawToolName: "mcp__probe__echo_note" },
			truncated: false,
			declineOnly: [],
		});
		expect(body.target).toBe('{\n  "text": "hello"\n}');
	});

	test("a server name with a hyphen splits the same way", () => {
		const parsed = parseClaudeRequest(
			request({ tool_name: "mcp__a-b__do_it", mcp_server: { name: "a-b", source: "dynamic" } }),
			ctx(),
		);
		expect(parsed?.declineOnly).toEqual([]);
		expect(parsed?.claude?.mcp).toEqual({
			server: "a-b",
			tool: "do_it",
			rawToolName: "mcp__a-b__do_it",
		});
	});
});

describe("what makes an MCP request decline-only", () => {
	const reasonsOf = (over: Record<string, unknown>, c = ctx()) =>
		parseClaudeRequest(request(over), c)?.declineOnly;

	test("Claude names a different server than the wire name's split (xander M3)", () => {
		expect(reasonsOf({ mcp_server: { name: "a-b", source: "dynamic" } })).toContain(
			"unknown_param",
		);
	});

	test("no server is named, or the shape is not {name, source}", () => {
		expect(reasonsOf({ mcp_server: undefined })).toContain("unknown_param");
		expect(reasonsOf({ mcp_server: "probe" })).toContain("unknown_param");
		expect(reasonsOf({ mcp_server: { name: "probe", source: "dynamic", extra: 1 } })).toContain(
			"unknown_param",
		);
	});

	test("a server that didn't come from our --mcp-config (a plugin, user or project scope) is never approvable", () => {
		for (const source of ["plugin", "user", "project", "claudeai", undefined]) {
			expect(reasonsOf({ mcp_server: { name: "probe", source } }), String(source)).toContain(
				"unknown_param",
			);
		}
	});

	test("a request key outside the allowlist is decline-only, as for any tool", () => {
		expect(reasonsOf({ surprise: 1 })).toContain("unknown_param");
	});

	test("an input past 16 KiB is too_long", () => {
		expect(reasonsOf({ input: { text: "x".repeat(17_000) } })).toContain("too_long");
		expect(reasonsOf({ input: { text: "x".repeat(15_000) } })).toEqual([]);
	});

	test("an input the wire could not prove is echoed unchanged is input_not_stable", () => {
		expect(reasonsOf({}, ctx({ inputStable: false }))).toContain("input_not_stable");
	});

	test("a request that needs interaction is requires_interaction", () => {
		expect(reasonsOf({ requires_user_interaction: true })).toContain("requires_interaction");
	});

	test("a tool of a server that wasn't applied is unknown_tool, not a card for a stranger", () => {
		for (const name of ["mcp__other__echo", "mcp__pro__be__echo", "mcp__probe__"]) {
			const parsed = parseClaudeRequest(request({ tool_name: name }), ctx());
			expect(parsed?.declineOnly, name).toContain("unknown_tool");
			expect(parsed?.claude?.mcp, name).toBeUndefined();
		}
	});

	test("with no applied servers every mcp__ tool is unknown_tool", () => {
		const none = ctx({ applied: { mcpServers: [], subagents: false, claudeVersion: "2.1.319" } });
		expect(reasonsOf({}, none)).toContain("unknown_tool");
		expect(reasonsOf({}, ctx({ applied: undefined }))).toContain("unknown_tool");
	});

	test("a truncated input is reported as cut", () => {
		const parsed = parseClaudeRequest(request({ input: { text: "x".repeat(17_000) } }), ctx());
		if (!parsed) throw new Error("not parsed");
		const body = buildClaudeReportBody({
			runtimeEpoch: "e",
			rpcId: "r",
			parsed,
			ageMs: 0,
			revision: 1,
		});
		expect(body.truncated).toBe(true);
		expect(String(body.target).length).toBe(16 * 1024);
		expect(body.declineOnly).toContain("too_long");
	});

	test("the six built-in tools are read exactly as before", () => {
		const bash = parseClaudeRequest(
			{ subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t" },
			ctx(),
		);
		expect(bash).toMatchObject({ kind: "command", command: "ls", declineOnly: [] });
	});
});
