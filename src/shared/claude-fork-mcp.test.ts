/** AGEN-121: the one place the MCP wire name is split, and the words the option and its card use. */
import { describe, expect, test } from "bun:test";
import {
	FORK_MCP_FRAGMENT,
	FORK_MCP_OFF_REASONS,
	FORK_MCP_SERVER_NAME,
	forkMcpAppliedLine,
	forkMcpCardLine,
	forkMcpControlHelp,
	forkMcpHeading,
	forkMcpHostCannot,
	forkMcpInputText,
	forkMcpOffLine,
	splitForkMcpToolName,
} from "./claude-fork-mcp.js";

describe("splitForkMcpToolName", () => {
	test("splits at the first double underscore after the prefix", () => {
		expect(splitForkMcpToolName("mcp__probe__echo_note")).toEqual({
			server: "probe",
			tool: "echo_note",
			rawToolName: "mcp__probe__echo_note",
		});
		expect(splitForkMcpToolName("mcp__a-b__c__d")).toEqual({
			server: "a-b",
			tool: "c__d",
			rawToolName: "mcp__a-b__c__d",
		});
	});

	test("a server containing an underscore can't exist, so two readings of one wire name can't either", () => {
		// `a__b` + `c` and `a` + `b__c` have the same wire name; only the second is a legal split.
		expect(splitForkMcpToolName("mcp__a__b__c")?.server).toBe("a");
		expect(FORK_MCP_SERVER_NAME.test("a__b")).toBe(false);
		expect(FORK_MCP_SERVER_NAME.test("a_b")).toBe(false);
	});

	test("is bounded: 64 characters, a 32-character server, a legal alphabet", () => {
		expect(splitForkMcpToolName(`mcp__${"s".repeat(32)}__t`)).not.toBeNull();
		expect(splitForkMcpToolName(`mcp__${"s".repeat(33)}__t`)).toBeNull();
		expect(splitForkMcpToolName(`mcp__s__${"t".repeat(56)}`)).not.toBeNull();
		expect(splitForkMcpToolName(`mcp__s__${"t".repeat(57)}`)).toBeNull();
		for (const raw of ["", "mcp__", "mcp__s", "mcp__s__", "mcp____t", "mcp__s__é", "mcp__s__a b"]) {
			expect(splitForkMcpToolName(raw), raw).toBeNull();
		}
	});

	test("with a list of servers, only one of them splits", () => {
		expect(splitForkMcpToolName("mcp__probe__x", ["probe"])).not.toBeNull();
		expect(splitForkMcpToolName("mcp__probe__x", ["prob"])).toBeNull();
		expect(splitForkMcpToolName("mcp__probe__x", [])).toBeNull();
	});
});

describe("the input text", () => {
	test("is the object pretty-printed with two spaces, keys in the order Claude sent them", () => {
		expect(forkMcpInputText({ b: 1, a: [1, { c: null }] })).toBe(
			'{\n  "b": 1,\n  "a": [\n    1,\n    {\n      "c": null\n    }\n  ]\n}',
		);
		expect(forkMcpInputText({})).toBe("{}");
	});
});

describe("the words", () => {
	test("the heading and the card line say who calls what, and that the effect is unknown", () => {
		expect(forkMcpHeading("echo_note", "probe")).toBe('Claude asks to use "echo_note" from probe');
		expect(forkMcpCardLine("probe", "echo_note")).toContain("AgentPulse can't tell what it does");
		expect(forkMcpCardLine("probe", "echo_note")).toContain(
			"Approve only if you know this server and this tool.",
		);
	});

	test("the option's description names the file, the machine, the login exposure and the unknown effect", () => {
		const help = forkMcpControlHelp("studio");
		expect(help).toContain("~/.agentpulse/claude-fork-mcp.json on studio");
		expect(help).toContain("they also see Claude's own login");
		expect(help).toContain("AgentPulse can't tell what a tool does");
		expect(forkMcpControlHelp(null)).toContain("on the chosen machine");
		expect(forkMcpControlHelp("  ")).toContain("on the chosen machine");
	});

	test("the dialog fragment and the status lines", () => {
		expect(FORK_MCP_FRAGMENT).toBe(
			"Your fork MCP servers start in this session. Their tool calls wait for you; what each tool does, AgentPulse can't tell.",
		);
		expect(forkMcpAppliedLine(["a", "b"])).toBe("Fork MCP servers: a, b.");
		expect(forkMcpOffLine(FORK_MCP_OFF_REASONS.no_file)).toMatch(/^Fork MCP servers: off\. /);
		expect(forkMcpHostCannot("studio")).toBe(
			"studio's supervisor can't do this yet. Update it to use this.",
		);
	});
});
