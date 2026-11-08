/**
 * AGEN-120: subagents on a continued Claude session. The policy (argv, init, line classes, request filter, row
 * words), the host's reading of the Agent call and of a subagent's own requests, and the stream carrying them,
 * against the recorded Claude Code 2.1.319 runs (s1, s2, s5, int-sub, g5, g6, g7).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR } from "../../shared/managed-messages.js";
import { type AppliedForkOptions, FORK_OPTIONS_OFF } from "../../shared/session-resume.js";
import { replayFixture, turnsOf } from "../test-utils/claude-fixture-replay.js";
import {
	AWAIT,
	FORK_ID,
	type Harness,
	INIT,
	SOURCE_ID,
	assistantText,
	assistantToolUse,
	canUseTool,
	createHarness,
	recordingPort,
	resultOk,
	toolResult,
	until,
} from "../test-utils/claude-stream-harness.js";
import {
	CLAUDE_FIXTURE_DIR_2_1_319 as DIR,
	outLines,
	readClaudeFixture,
} from "./__fixtures__/claude-frames.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import { buildClaudeReportBody, parseClaudeRequest } from "./claude-approval-params.js";
import { forkArgv, probeArgv } from "./claude-argv.js";
import {
	CLAUDE_FORK_DISALLOWED_TOOLS,
	claudeToolKind,
	forkToolPolicy,
	prepareForkOptions,
} from "./claude-fork-tools.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";
import { allowResponse, denyResponse } from "./claude-wire.js";

const ON: AppliedForkOptions = { mcpServers: [], subagents: true, claudeVersion: "2.1.319" };
const onPolicy = () => forkToolPolicy(ON);

const harnesses: Harness[] = [];
const harness = (config?: FakeConfig) => {
	const h = createHarness(config);
	harnesses.push(h);
	return h;
};
afterEach(async () => {
	await disposeAllClaudeStreamRuntimes({
		interruptMs: 0,
		stdinCloseMs: 300,
		termMs: 300,
		killMs: 300,
	});
	_resetClaudeStreamForTest();
	for (const h of harnesses.splice(0)) h.cleanup();
});

/** The init a 2.1.319 fork with the Agent call prints: the call is listed as `Task`. */
const INIT_TOOLS = { tools: ["Task", "Bash", "Edit", "NotebookEdit", "Read", "WebFetch", "Write"] };

describe("the policy with subagents applied", () => {
	test("Agent joins --tools and leaves --disallowedTools with Task; the ask rule and the env stay", () => {
		const policy = onPolicy();
		expect(policy.tools).toEqual([
			"Bash",
			"Read",
			"Write",
			"Edit",
			"NotebookEdit",
			"WebFetch",
			"Agent",
		]);
		expect(policy.disallowedTools).not.toContain("Agent");
		expect(policy.disallowedTools).not.toContain("Task");
		// Everything else T8 removed stays removed (population floor: all but the two).
		expect(policy.disallowedTools.length).toBe(CLAUDE_FORK_DISALLOWED_TOOLS.length - 2);
		for (const name of [
			"SendMessage",
			"Skill",
			"EnterWorktree",
			"CronCreate",
			"WebSearch",
			"ScheduleWakeup",
		]) {
			expect(policy.disallowedTools, name).toContain(name);
		}
		expect(policy.askRules).toEqual([
			"Write(*)",
			"Edit(*)",
			"NotebookEdit(*)",
			"WebFetch(*)",
			"Agent",
		]);
		expect(policy.settingsEnv).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
	});

	test("the argv is the measured one: --tools ...,Agent, the settings object with the rule and the env, strict MCP", () => {
		const argv = forkArgv({ source: SOURCE_ID, fork: FORK_ID, mode: "ask", policy: onPolicy() });
		expect(argv[argv.indexOf("--tools") + 1]).toBe(
			"Bash,Read,Write,Edit,NotebookEdit,WebFetch,Agent",
		);
		expect(argv[argv.indexOf("--disallowedTools") + 1].split(",")).not.toContain("Agent");
		expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toEqual({
			permissions: { ask: ["Write(*)", "Edit(*)", "NotebookEdit(*)", "WebFetch(*)", "Agent"] },
			env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
		});
		expect(argv).toContain("--strict-mcp-config");
		expect(argv).not.toContain("--mcp-config");
	});

	test("with no option the policy is exactly the one shipped (Agent stays disallowed, no rule)", () => {
		const off = forkToolPolicy(FORK_OPTIONS_OFF);
		expect(off.tools).not.toContain("Agent");
		expect(off.disallowedTools).toContain("Agent");
		expect(off.disallowedTools).toContain("Task");
		expect(off.askRules).not.toContain("Agent");
		expect(forkArgv({ source: SOURCE_ID, fork: FORK_ID, mode: "ask", policy: off })).toEqual(
			forkArgv({ source: SOURCE_ID, fork: FORK_ID, mode: "ask" }),
		);
	});

	test("the login probe's argv is the same with the option on: it names Agent as a tool and starts nothing", () => {
		const probe = probeArgv({ mode: "ask", policy: onPolicy() });
		expect(probe).toContain("--strict-mcp-config");
		expect(probe).not.toContain("--mcp-config");
	});

	test('rows say whose call it was: "A subagent\'s Bash: ran, you approved it" via the naming', () => {
		expect(onPolicy().naming.subagentPrefix).toBe("A subagent's ");
		expect(onPolicy().naming.printableTool("Agent")).toBe("Agent");
		expect(forkToolPolicy(FORK_OPTIONS_OFF).naming.printableTool("Agent")).toBe("A tool");
	});

	test("claudeToolKind knows the Agent call only when subagents are applied, and never `Task`", () => {
		expect(claudeToolKind("Agent", ON)).toBe("agent");
		expect(claudeToolKind("Agent", FORK_OPTIONS_OFF)).toBeNull();
		expect(claudeToolKind("Agent")).toBeNull();
		expect(claudeToolKind("Task", ON)).toBeNull();
		expect(claudeToolKind("Bash", ON)).toBe("Bash");
	});
});

describe("prepareForkOptions for subagents", () => {
	test("on a measured version the option is applied and recorded with the version", async () => {
		const prepared = await prepareForkOptions({ subagents: true }, { claudeVersion: "2.1.319" });
		expect(prepared.applied).toEqual({
			...FORK_OPTIONS_OFF,
			subagents: true,
			claudeVersion: "2.1.319",
		});
		expect(prepared.policy.tools).toContain("Agent");
		await prepared.cleanup();
	});

	test("an unmeasured version applies nothing (positive control: the measured one applies it)", async () => {
		const prepared = await prepareForkOptions({ subagents: true }, { claudeVersion: "2.1.320" });
		expect(prepared.applied.subagents).toBe(false);
		expect(prepared.policy.tools).not.toContain("Agent");
	});

	test("a request that does not ask applies nothing; a recovery from a stored value applies it again", async () => {
		const none = await prepareForkOptions({}, { claudeVersion: "2.1.319" });
		expect(none.applied.subagents).toBe(false);
		const again = await prepareForkOptions(
			{ subagents: true },
			{ claudeVersion: "2.1.319", stored: ON },
		);
		expect(again.applied.subagents).toBe(true);
	});
});

describe("the first-prompt tool check", () => {
	const recordedInit = (name: string) =>
		outLines(name, DIR).find((m) => m.type === "system" && m.subtype === "init") as Record<
			string,
			unknown
		>;

	test("a recorded 2.1.319 init (the call listed as Task) passes with subagents and fails without (control)", () => {
		const init = recordedInit("s5-general-key");
		expect(init.tools).toContain("Task");
		expect(onPolicy().initToolsProblem(init)).toBeNull();
		expect(forkToolPolicy(FORK_OPTIONS_OFF).initToolsProblem(init)).toBe("tools");
	});

	test("an init from the same login with the option on, and an init listing Agent itself, are both judged", () => {
		const init = recordedInit("s1-key");
		expect(onPolicy().initToolsProblem(init)).toBeNull();
		// Listing both names, or the name twice, is not the measured shape.
		expect(
			onPolicy().initToolsProblem({ ...init, tools: [...(init.tools as string[]), "Agent"] }),
		).toBe("tools");
		expect(
			onPolicy().initToolsProblem({ ...init, tools: [...(init.tools as string[]), "Task"] }),
		).toBe("tools");
	});

	test("an extra tool, a missing tool and a non-list are still a problem, Task or no Task", () => {
		const init = recordedInit("s5-general-key");
		const tools = init.tools as string[];
		expect(onPolicy().initToolsProblem({ ...init, tools: [...tools, "WebSearch"] })).toBe("tools");
		expect(onPolicy().initToolsProblem({ ...init, tools: tools.filter((t) => t !== "Bash") })).toBe(
			"tools",
		);
		expect(onPolicy().initToolsProblem({ ...init, tools: "Task,Bash" })).toBe("tools");
		expect(
			onPolicy().initToolsProblem({ ...init, tools: tools.map((t) => (t === "Task" ? 5 : t)) }),
		).toBe("tools");
	});

	test("a server the option did not apply is still killed (MCP set-equality is not weakened)", () => {
		const init = recordedInit("s5-general-key");
		expect(
			onPolicy().initToolsProblem({
				...init,
				mcp_servers: [{ name: "extra", status: "connected" }],
			}),
		).toBe("mcp_servers");
	});
});

describe("line classes", () => {
	const lines = (name: string) =>
		outLines(name, DIR).filter((m) => m.type === "assistant" || m.type === "user");

	test("in s1-key every line a subagent wrote is a subagent line and the fork's own are own (population floor, named member)", () => {
		const policy = onPolicy();
		const all = lines("s1-key");
		const sub = all.filter(
			(m) => m.agent_id !== undefined || (m.parent_tool_use_id ?? null) !== null,
		);
		expect(all.length).toBeGreaterThan(4);
		expect(sub.length).toBeGreaterThanOrEqual(3);
		for (const m of sub)
			expect(policy.classifyLine(m), JSON.stringify(m).slice(0, 80)).toBe("subagent");
		const own = all.filter((m) => !sub.includes(m));
		expect(own.length).toBeGreaterThanOrEqual(2);
		for (const m of own) expect(policy.classifyLine(m)).toBe("own");
		// Without the option the same subagent lines are a stranger's turn (control).
		for (const m of sub) {
			expect(forkToolPolicy(FORK_OPTIONS_OFF).classifyLine(m)).toEqual({ reject: "peer_turn" });
		}
	});

	test("an agent_id or a parent that is not a string id stays a stranger's: null-ish values, numbers, empty strings", () => {
		const policy = onPolicy();
		for (const odd of [
			{ agent_id: 5 },
			{ agent_id: "" },
			{ agent_id: null },
			{ parent_tool_use_id: 5 },
			{ parent_tool_use_id: "" },
			{ agent_id: "a1", parent_tool_use_id: 5 },
			{ agent_id: 5, parent_tool_use_id: "toolu_1" },
			{ agent_id: "x".repeat(129) },
		]) {
			expect(policy.classifyLine({ type: "assistant", ...odd }), JSON.stringify(odd)).toEqual({
				reject: "peer_turn",
			});
		}
		expect(policy.classifyLine({ type: "assistant", agent_id: "a1" })).toBe("subagent");
		expect(policy.classifyLine({ type: "assistant", parent_tool_use_id: "toolu_1" })).toBe(
			"subagent",
		);
	});

	test("requestAllowed admits a request carrying a helper id only", () => {
		const policy = onPolicy();
		expect(policy.requestAllowed({ tool_name: "Bash", agent_id: "a1" })).toBe("allow");
		for (const agent_id of [undefined, null, "", 5, "x".repeat(129)]) {
			expect(policy.requestAllowed({ tool_name: "Bash", agent_id })).toBe("decline");
		}
		expect(forkToolPolicy(FORK_OPTIONS_OFF).requestAllowed({ agent_id: "a1" })).toBe("decline");
	});
});

// ---- reading the requests ----

const requestsOf = (name: string) =>
	outLines(name, DIR)
		.filter((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool")
		.map((m) => m.request as Record<string, unknown>);

const ctx = (applied = ON) => ({
	threadId: FORK_ID,
	turnId: "action-1",
	cwd: "/scratch/measure/g5-rule-allow-key/repo",
	configDir: "/scratch/cfg",
	inputStable: true,
	applied,
	fs: {
		realpath: (p: string) => p,
		exists: () => "no" as const,
		isSymlink: () => false,
	},
});

describe("the Agent call's card", () => {
	const agentRequest = (name: string) =>
		requestsOf(name).find((r) => r.tool_name === "Agent" && r.agent_id === undefined) as Record<
			string,
			unknown
		>;

	test("the recorded G5 request (both logins) is approvable for general-purpose, with the helper in the report", () => {
		for (const name of ["g5-rule-allow-key", "g5-rule-allow-helper"]) {
			const request = agentRequest(name);
			expect(request, name).toBeDefined();
			const parsed = parseClaudeRequest(request, ctx());
			expect(parsed?.declineOnly, name).toEqual([]);
			expect(parsed?.kind).toBe("claude_tool");
			expect(parsed?.claude?.tool).toBe("Agent");
			expect(parsed?.claude?.agent).toMatchObject({
				subagentType: "general-purpose",
				builtIn: true,
			});
			expect(parsed?.claude?.fromSubagent).toBeUndefined();
			const body = buildClaudeReportBody({
				runtimeEpoch: "e",
				rpcId: "1",
				parsed: parsed as NonNullable<typeof parsed>,
				ageMs: 0,
				revision: 1,
			});
			expect(body).toMatchObject({
				requestKind: "claude_tool",
				tool: "Agent",
				target: "general-purpose",
				agent: { subagentType: "general-purpose", builtIn: true },
				truncated: false,
			});
			expect(body).not.toHaveProperty("fromSubagent");
		}
	});

	test("without the option the same request is an unknown tool (stays declined)", () => {
		const parsed = parseClaudeRequest(agentRequest("g5-rule-allow-key"), ctx(FORK_OPTIONS_OFF));
		expect(parsed?.declineOnly).toContain("unknown_tool");
		expect(parsed?.claude?.agent).toBeUndefined();
	});

	test("a custom type (the G7 user agent) is decline-only custom_agent", () => {
		const request = agentRequest("g7-with-helper");
		expect(request.input).toMatchObject({ subagent_type: "probeagent" });
		const parsed = parseClaudeRequest(request, ctx());
		expect(parsed?.declineOnly).toEqual(["custom_agent"]);
		expect(parsed?.claude?.agent?.builtIn).toBe(false);
	});

	test("the built-in types other than general-purpose are not offered either (only the measured one)", () => {
		for (const subagent_type of ["Explore", "Plan", "claude", "statusline-setup"]) {
			const parsed = parseClaudeRequest(
				{
					tool_name: "Agent",
					tool_use_id: "toolu_1",
					input: { subagent_type, prompt: "p", description: "d" },
				},
				ctx(),
			);
			expect(parsed?.declineOnly, subagent_type).toEqual(["custom_agent"]);
		}
	});

	test("a nested Agent request (agent_id present, G6) is decline-only nested_agent", () => {
		const nested = requestsOf("g6-rule-denynested-key").find(
			(r) => r.tool_name === "Agent" && typeof r.agent_id === "string",
		) as Record<string, unknown>;
		expect(nested).toBeDefined();
		const parsed = parseClaudeRequest(nested, ctx());
		expect(parsed?.declineOnly).toEqual(["nested_agent"]);
		expect(parsed?.claude?.fromSubagent).toBe(true);
		const body = buildClaudeReportBody({
			runtimeEpoch: "e",
			rpcId: "2",
			parsed: parsed as NonNullable<typeof parsed>,
			ageMs: 0,
			revision: 1,
		});
		expect(body).toMatchObject({ fromSubagent: true, declineOnly: ["nested_agent"] });
	});

	test("run_in_background, a model, an isolation and any other key are unknown_param", () => {
		const base = { subagent_type: "general-purpose", prompt: "p", description: "d" };
		for (const extra of [
			{ run_in_background: true },
			{ model: "opus" },
			{ isolation: "worktree" },
			{ name: "x" },
			{ __proto__x: 1 },
		]) {
			const parsed = parseClaudeRequest(
				{ tool_name: "Agent", tool_use_id: "toolu_1", input: { ...base, ...extra } },
				ctx(),
			);
			expect(parsed?.declineOnly, JSON.stringify(extra)).toContain("unknown_param");
		}
		// run_in_background:false is no background run (positive control).
		const fine = parseClaudeRequest(
			{
				tool_name: "Agent",
				tool_use_id: "toolu_1",
				input: { ...base, run_in_background: false },
			},
			ctx(),
		);
		expect(fine?.declineOnly).toEqual([]);
	});

	test("a request that cannot be reported is declined locally: no type, a type no card can name, no prompt", () => {
		for (const input of [
			{ prompt: "p" },
			{ subagent_type: "my.agent", prompt: "p" },
			{ subagent_type: "plugin:agent", prompt: "p" },
			{ subagent_type: "general-purpose" },
			{ subagent_type: "a".repeat(65), prompt: "p" },
		]) {
			expect(
				parseClaudeRequest({ tool_name: "Agent", tool_use_id: "toolu_1", input }, ctx()),
				JSON.stringify(input),
			).toBeNull();
		}
	});

	test("a prompt past 16 KiB is cut in the report and the card can only be declined", () => {
		const parsed = parseClaudeRequest(
			{
				tool_name: "Agent",
				tool_use_id: "toolu_1",
				input: {
					subagent_type: "general-purpose",
					prompt: "x".repeat(16 * 1024 + 1),
					description: "d",
				},
			},
			ctx(),
		);
		expect(parsed?.declineOnly).toContain("too_long");
		const body = buildClaudeReportBody({
			runtimeEpoch: "e",
			rpcId: "3",
			parsed: parsed as NonNullable<typeof parsed>,
			ageMs: 0,
			revision: 1,
		});
		expect(body.truncated).toBe(true);
		expect((body as { agent?: { prompt: string } }).agent?.prompt.length).toBe(16 * 1024);
	});
});

describe("a subagent's own requests", () => {
	test("the recorded Bash and Write requests carry fromSubagent in the parse and the report; the fork's own do not", () => {
		const fromHelper = requestsOf("s5-general-key").find((r) => r.tool_name === "Write");
		expect(typeof fromHelper?.agent_id).toBe("string");
		const parsed = parseClaudeRequest(fromHelper, ctx());
		expect(parsed?.kind).toBe("file_change");
		expect(parsed?.claude?.fromSubagent).toBe(true);
		const body = buildClaudeReportBody({
			runtimeEpoch: "e",
			rpcId: "4",
			parsed: parsed as NonNullable<typeof parsed>,
			ageMs: 0,
			revision: 1,
		});
		expect(body).toMatchObject({ requestKind: "file_change", fromSubagent: true });

		const own = parseClaudeRequest(
			{ tool_name: "Bash", tool_use_id: "toolu_2", input: { command: "ls" } },
			ctx(),
		);
		expect(own?.claude?.fromSubagent).toBeUndefined();
		const ownBody = buildClaudeReportBody({
			runtimeEpoch: "e",
			rpcId: "5",
			parsed: own as NonNullable<typeof own>,
			ageMs: 0,
			revision: 1,
		});
		expect(ownBody).not.toHaveProperty("fromSubagent");
	});

	test("a Bash request from a helper is a command with fromSubagent; its shown fields are unchanged", () => {
		const bash = requestsOf("g7-with-helper").find((r) => r.tool_name === "Bash");
		const parsed = parseClaudeRequest(bash, ctx());
		expect(parsed?.kind).toBe("command");
		expect(parsed?.claude?.fromSubagent).toBe(true);
		expect(parsed?.command).toContain("pwd >");
	});
});

// ---- the stream ----

const agentInput = { description: "d", prompt: "do the thing", subagent_type: "general-purpose" };
const sub = (extra: Record<string, unknown>) => ({
	say: {
		session_id: "$SESSION",
		parent_tool_use_id: "tuA",
		agent_id: "helper-1",
		...extra,
	},
});
const subText = (text: string) =>
	sub({
		type: "assistant",
		message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }] },
	});
const subToolUse = (id: string, name: string, input: Record<string, unknown>) =>
	sub({
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-haiku-5-5",
			content: [{ type: "tool_use", id, name, input }],
		},
	});
const subResult = (toolUseId: string) =>
	sub({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolUseId, content: "x", is_error: false }],
		},
	});

describe("the stream with subagents applied", () => {
	const start = async (h: Harness, port = recordingPort()) => {
		const rt = await h.start({ policy: onPolicy(), approvals: port });
		rt.beginSettle();
		rt.settled();
		return { rt, port };
	};

	test("the Agent call and a helper's Bash each reach the approval port; the helper's words are never the fork's", async () => {
		const SECRET_WORDS = "HELPER-WORDS-NOT-CLAUDES";
		const h = harness({
			init: INIT_TOOLS,
			defaultTurn: [
				INIT,
				assistantToolUse("tuA", "Agent", agentInput),
				canUseTool("r1", "Agent", "tuA", agentInput),
				AWAIT,
				subText(SECRET_WORDS),
				subToolUse("tuB", "Bash", { command: "touch made.txt" }),
				canUseTool("r2", "Bash", "tuB", { command: "touch made.txt" }, { agent_id: "helper-1" }),
				AWAIT,
				subResult("tuB"),
				toolResult("tuA"),
				assistantText("the fork's own closing words"),
				resultOk,
			],
		});
		const { rt, port } = await start(h);
		const sent = await rt.sendPrompt("go", "a1");
		await until(() => port.requests.length === 1, "the Agent request");
		expect(port.requests[0]?.params).toMatchObject({ tool_name: "Agent" });
		port.ctx?.answer("r1", allowResponse(agentInput));
		await until(() => port.requests.length === 2, "the helper's Bash request");
		expect(port.requests[1]?.params).toMatchObject({ tool_name: "Bash", agent_id: "helper-1" });
		port.ctx?.answer("r2", allowResponse({ command: "touch made.txt" }));
		expect(await sent.done).toEqual({ ok: true });

		// The helper's text never became one of Claude's messages; the fork's own closing words did.
		const messages = h.events.filter((e) => e.eventType === "HeadlessAssistantMessage");
		expect(messages.map((e) => e.content)).toEqual(["the fork's own closing words"]);
		expect(h.reported()).not.toContain(SECRET_WORDS);
		// Both calls have a row, the helper's carrying the prefix.
		const rows = h.events.map((e) => String(e.content));
		expect(rows.some((r) => r.startsWith("A subagent's Bash: "))).toBe(true);
		expect(rows.some((r) => r.startsWith("Agent: "))).toBe(true);
		h.assertCleanWire();
	});

	test("a helper's request for a tool outside the set is declined locally and never reaches the port", async () => {
		const h = harness({
			init: INIT_TOOLS,
			defaultTurn: [
				INIT,
				assistantToolUse("tuA", "Agent", agentInput),
				subToolUse("tuB", "WebSearch", { query: "x" }),
				canUseTool("r2", "WebSearch", "tuB", { query: "x" }, { agent_id: "helper-1" }),
				AWAIT,
				toolResult("tuA"),
				resultOk,
			],
		});
		const { rt, port } = await start(h);
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		expect(port.requests).toEqual([]);
		const answer = h.fake.log().find((e) => e.ev === "control_response" && e.requestId === "r2");
		expect(answer?.response?.response?.behavior).toBe("deny");
	});

	test("a request carrying agent_id is declined when subagents are off, even for a listed tool (control)", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				canUseTool("r2", "Bash", "tuB", { command: "ls" }, { agent_id: "helper-1" }),
				AWAIT,
				resultOk,
			],
		});
		const port = recordingPort();
		const rt = await h.start({ approvals: port });
		rt.beginSettle();
		rt.settled();
		await (await rt.sendPrompt("go", "a1")).done;
		expect(port.requests).toEqual([]);
	});

	test("a nested Agent request (a helper's) reaches the port, where the host reports it decline-only", async () => {
		const h = harness({
			init: INIT_TOOLS,
			defaultTurn: [
				INIT,
				assistantToolUse("tuA", "Agent", agentInput),
				subToolUse("tuN", "Agent", agentInput),
				canUseTool("r3", "Agent", "tuN", agentInput, { agent_id: "helper-1" }),
				AWAIT,
				toolResult("tuA"),
				resultOk,
			],
		});
		const { rt, port } = await start(h);
		const sent = await rt.sendPrompt("go", "a1");
		await until(() => port.requests.length === 1, "the nested request");
		const parsed = parseClaudeRequest(port.requests[0]?.params, ctx());
		expect(parsed?.declineOnly).toEqual(["nested_agent"]);
		port.ctx?.answer("r3", denyResponse("no"));
		await sent.done;
	});

	test("a helper's line after the turn's result ends the fork with its own words, not a stranger's", async () => {
		const h = harness({
			init: INIT_TOOLS,
			defaultTurn: [
				INIT,
				assistantToolUse("tuA", "Agent", agentInput),
				toolResult("tuA"),
				resultOk,
				{ delay: 300 },
				subText("still going after the turn"),
				AWAIT,
			],
		});
		const { rt } = await start(h);
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		await until(() => h.states.some((s) => s.managedState === "degraded"), "the fatal ending");
		expect(h.states.at(-1)?.providerSyncError).toBe(CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR);
		expect(
			h.logs.some((l) => l.includes("protocol violation") && l.includes("subagent_after_turn")),
		).toBe(true);
		// The words do not blame a stranger.
		expect(String(h.states.at(-1)?.providerSyncError)).not.toMatch(
			/something else|sent this session/i,
		);
	});
});

/** The fake prints the 2.1.318 init; 2.1.319 lists the Agent call as `Task`. */
const withTaskInit = (config: FakeConfig) => harness({ ...config, init: INIT_TOOLS });

describe("recorded runs through the real policy", () => {
	test("s2-key-bgon (background on): the helper's lines after the result end the fork subagent_after_turn", async () => {
		const prepared = await prepareForkOptions({ subagents: true }, { claudeVersion: "2.1.319" });
		const h = harness({ turns: turnsOf(readClaudeFixture("s2-key-bgon", DIR)), init: INIT_TOOLS });
		const rt = await h.start({ policy: prepared.policy });
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a0")).done).toEqual({ ok: true });
		await until(() => h.states.some((s) => s.managedState === "degraded"), "the fatal ending");
		expect(h.states.at(-1)?.providerSyncError).toBe(CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR);
		// Positive control: with the option off, the same lines are a stranger's turn.
		const d = harness({ turns: turnsOf(readClaudeFixture("s2-key-bgon", DIR)) });
		const off = await d.start();
		off.beginSettle();
		off.settled();
		await (await off.sendPrompt("go", "a0")).done;
		await until(() => d.states.some((s) => s.managedState === "degraded"), "the fatal ending");
		expect(d.states.at(-1)?.providerSyncError).not.toBe(CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR);
	}, 60_000);

	test("s1-key completes under the policy: the helper's lines are no longer a stranger's turn", async () => {
		const prepared = await prepareForkOptions({ subagents: true }, { claudeVersion: "2.1.319" });
		const replay = await replayFixture("s1-key", withTaskInit, {
			dir: DIR,
			extra: { policy: prepared.policy },
		});
		expect(replay?.outcomes.at(-1)).toMatchObject({ ok: true });
	}, 60_000);

	test("int-sub-key (an interrupt during a helper) ends with the interrupted result, helper lines accepted", async () => {
		const prepared = await prepareForkOptions({ subagents: true }, { claudeVersion: "2.1.319" });
		const replay = await replayFixture("int-sub-key", withTaskInit, {
			dir: DIR,
			extra: { policy: prepared.policy },
		});
		expect(replay).not.toBeNull();
		// Not a fatal ending: the lines were a helper's, and the result is the turn's own.
		expect(replay?.states.some((s) => s.managedState === "degraded")).toBe(false);
	}, 60_000);
});

describe("the fixtures this file leans on exist and say what is leaned on", () => {
	test("G5: no rule gives no request, the rule gives one with subagent_type and no agent_id (positive control inside)", () => {
		const noRule = requestsOf("g5-norule-allow-key").filter((r) => r.tool_name === "Agent");
		expect(noRule).toEqual([]);
		const withRule = requestsOf("g5-rule-allow-key").filter((r) => r.tool_name === "Agent");
		expect(withRule.length).toBeGreaterThanOrEqual(1);
		expect((withRule[0]?.input as Record<string, unknown>).subagent_type).toBe("general-purpose");
		expect(withRule[0]?.agent_id).toBeUndefined();
		// The deny run starts no helper.
		const deny = outLines("g5-rule-deny-key", DIR);
		expect(deny.some((m) => m.type === "system" && m.subtype === "task_started")).toBe(false);
		expect(outLines("g5-rule-allow-key", DIR).some((m) => m.subtype === "task_started")).toBe(true);
	});

	test("the manifest says which logins G5 and G7 ran under", () => {
		const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
		expect(manifest["g5-rule-allow-key.jsonl"].restricted).toBe(true);
		expect(manifest["g5-rule-allow-helper.jsonl"].restricted).toBe(false);
		expect(manifest["g7-with-helper.jsonl"].restricted).toBe(false);
	});
});
