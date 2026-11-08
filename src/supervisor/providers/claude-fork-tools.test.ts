/**
 * AGEN-119..123 Track 0, S4: the fork tool policy decides the argv, the first-prompt assertion, the line
 * classifier, the request filter and the row words, and with no option applied it is exactly the policy
 * shipped before. Argv identity is held to the golden generated at base commit 198eda63.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CLAUDE_FORK_MCP_CHANGED_SYNC_ERROR,
	CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR,
} from "../../shared/managed-messages.js";
import { type AppliedForkOptions, FORK_OPTIONS_OFF } from "../../shared/session-resume.js";
import { replayFixture } from "../test-utils/claude-fixture-replay.js";
import {
	AWAIT,
	type Harness,
	INIT,
	assistantText,
	assistantToolUse,
	canUseTool,
	createHarness,
	resultOk,
	toolResult,
	until,
} from "../test-utils/claude-stream-harness.js";
import {
	CLAUDE_FIXTURE_DIR,
	CLAUDE_FIXTURE_DIR_2_1_319,
	outLines,
} from "./__fixtures__/claude-frames.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import { forkArgv, inPlaceArgv, probeArgv } from "./claude-argv.js";
import {
	type ForkToolPolicy,
	claudeToolKind,
	forkToolPolicy,
	isAppliedMcpTool,
	prepareForkOptions,
} from "./claude-fork-tools.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";
import type { ToolCallRecord } from "./fork-tool-record.js";

const GOLDEN = JSON.parse(
	readFileSync(join(import.meta.dir, "__fixtures__", "fork-argv-golden.json"), "utf8"),
) as { sourceId: string; forkId: string; argv: Record<string, string[]> };

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

describe("argv identity with no option applied", () => {
	for (const mode of ["ask", "restricted"] as const) {
		test(`forkArgv, inPlaceArgv and probeArgv equal the base commit's, ${mode}, element for element`, () => {
			const { sourceId, forkId, argv } = GOLDEN;
			expect(forkArgv({ source: sourceId, fork: forkId, mode })).toEqual(
				argv[`fork:${mode}`] ?? [],
			);
			expect(
				forkArgv({
					source: sourceId,
					fork: forkId,
					mode,
					policy: forkToolPolicy(FORK_OPTIONS_OFF),
				}),
			).toEqual(argv[`fork:${mode}`] ?? []);
			expect(inPlaceArgv({ fork: forkId, record: { source: sourceId, mode }, mode })).toEqual(
				argv[`inPlace:${mode}`] ?? [],
			);
			expect(probeArgv({ mode })).toEqual(argv[`probe:${mode}`] ?? []);
		});
	}

	test("the golden has all six argvs and says where it came from (population floor)", () => {
		expect(Object.keys(GOLDEN.argv).sort()).toEqual([
			"fork:ask",
			"fork:restricted",
			"inPlace:ask",
			"inPlace:restricted",
			"probe:ask",
			"probe:restricted",
		]);
		expect(
			readFileSync(join(import.meta.dir, "__fixtures__", "fork-argv-golden.json"), "utf8"),
		).toContain("198eda63");
	});

	test("--strict-mcp-config is always on and --mcp-config only comes with an applied path", () => {
		const base = forkToolPolicy();
		expect(base.mcpConfigPath).toBeNull();
		expect(base.extraArgs).toEqual([]);
		expect(forkArgv({ source: GOLDEN.sourceId, fork: GOLDEN.forkId, mode: "ask" })).not.toContain(
			"--mcp-config",
		);
		const withMcp: ForkToolPolicy = {
			...base,
			mcpConfigPath: "/private/x.json",
			extraArgs: ["--mcp-config", "/private/x.json"],
		};
		const fork = forkArgv({
			source: GOLDEN.sourceId,
			fork: GOLDEN.forkId,
			mode: "ask",
			policy: withMcp,
		});
		expect(fork).toContain("--strict-mcp-config");
		expect(fork.slice(fork.indexOf("--mcp-config"), fork.indexOf("--mcp-config") + 2)).toEqual([
			"--mcp-config",
			"/private/x.json",
		]);
		// The login probe never starts an MCP server, whatever the policy says (F41).
		const probe = probeArgv({ mode: "ask", policy: withMcp });
		expect(probe).toContain("--strict-mcp-config");
		expect(probe).not.toContain("--mcp-config");
	});

	test("the 2.1.318 fixture directory has the floor of files the identity gate was built over", () => {
		expect(readdirSync(CLAUDE_FIXTURE_DIR).length).toBeGreaterThanOrEqual(27);
	});
});

describe("the first-prompt assertion reads the policy", () => {
	const policy = forkToolPolicy();
	const initOf = (name: string) =>
		outLines(name).find((m) => m.type === "system" && m.subtype === "init") as Record<
			string,
			unknown
		>;

	test("accepts t8-fork-init's init", () => {
		expect(policy.initToolsProblem(initOf("t8-fork-init"))).toBeNull();
	});

	test("rejects it with Task added, with an MCP server, and with a tool missing", () => {
		const init = initOf("t8-fork-init");
		expect(policy.initToolsProblem({ ...init, tools: [...(init.tools as string[]), "Task"] })).toBe(
			"tools",
		);
		expect(policy.initToolsProblem({ ...init, tools: (init.tools as string[]).slice(1) })).toBe(
			"tools",
		);
		expect(
			policy.initToolsProblem({ ...init, mcp_servers: [{ name: "x", status: "connected" }] }),
		).toBe("mcp_servers");
		expect(policy.initToolsProblem({ ...init, mcp_servers: undefined })).toBe("mcp_servers");
	});

	test("the plain fork's 27-tool init (no T8 flags) is a problem", () => {
		expect(policy.initToolsProblem(initOf("plain-fork-init"))).toBe("tools");
	});
});

describe("the tool table and the line classifier", () => {
	test("the six are known; MCP and Agent names stay unknown without an applied option", () => {
		for (const tool of ["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch"]) {
			expect(claudeToolKind(tool)).toBe(tool as never);
		}
		expect(claudeToolKind("mcp__probe__echo")).toBeNull();
		expect(claudeToolKind("Agent")).toBeNull();
		expect(claudeToolKind("Task")).toBeNull();
		const applied: AppliedForkOptions = {
			mcpServers: [{ name: "probe", digest: "a".repeat(64) }],
			subagents: false,
			claudeVersion: "2.1.319",
		};
		// The stub halves apply nothing, but the stream's own test of an applied server's tool is real.
		expect(isAppliedMcpTool("mcp__probe__echo", applied)).toBe(true);
		expect(isAppliedMcpTool("mcp__probe2__echo", applied)).toBe(false);
		expect(isAppliedMcpTool("mcp__probe", applied)).toBe(false);
		expect(isAppliedMcpTool("Bash", applied)).toBe(false);
	});

	test("the default classification: own for a fork's line, a rejected peer turn for any other", () => {
		const policy = forkToolPolicy();
		expect(policy.classifyLine({ type: "assistant", parent_tool_use_id: null })).toBe("own");
		expect(policy.classifyLine({ type: "assistant" })).toBe("own");
		expect(policy.classifyLine({ type: "assistant", agent_id: "a1" })).toEqual({
			reject: "peer_turn",
		});
		expect(policy.classifyLine({ type: "user", parent_tool_use_id: "toolu_1" })).toEqual({
			reject: "peer_turn",
		});
		expect(policy.requestAllowed({ agent_id: "a1" })).toBe("decline");
	});

	test("naming: the six print by name, anything else is neutral, a subagent's call has a prefix", () => {
		const { naming } = forkToolPolicy();
		expect(naming.printableTool("Bash")).toBe("Bash");
		expect(naming.printableTool("mcp__x__y")).toBe("A tool");
		expect(naming.countedName("Agent")).toBeNull();
		expect(naming.subagentPrefix).toBe("Subagent ");
	});
});

describe("prepareForkOptions", () => {
	test("applies nothing in Track 0: the default policy, the version recorded, a no-op idempotent cleanup", async () => {
		const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion: "2.1.319" });
		expect(prepared.applied).toEqual({ ...FORK_OPTIONS_OFF, claudeVersion: "2.1.319" });
		expect(prepared.policy.probeArgs).toEqual(forkToolPolicy().probeArgs);
		await prepared.cleanup();
		await prepared.cleanup();
	});

	test("an unmeasured version applies nothing either, and a missing request is none", async () => {
		const a = await prepareForkOptions({ mcp: true }, { claudeVersion: "2.1.318" });
		expect(a.applied.mcpServers).toEqual([]);
		const b = await prepareForkOptions(undefined, { claudeVersion: null });
		expect(b.applied).toEqual({ ...FORK_OPTIONS_OFF, claudeVersion: "" });
	});
});

describe("the stream reads the policy", () => {
	const subagentPolicy = (): ForkToolPolicy => ({
		...forkToolPolicy(),
		classifyLine: (m) =>
			m.agent_id !== undefined || (m.parent_tool_use_id ?? null) !== null ? "subagent" : "own",
	});

	test("s1-key (2.1.319, a subagent's lines) with the default policy raises peer_turn", async () => {
		const result = await replayFixture("s1-key", harness, { dir: CLAUDE_FIXTURE_DIR_2_1_319 });
		expect(result?.outcomes).toEqual([expect.objectContaining({ ok: false, code: "fatal" })]);
		expect(result?.events.map((e) => (e.rawPayload as { status?: string })?.status)).toContain(
			"peer_turn",
		);
	});

	test("s1-key with a policy that returns subagent records the subagent's Bash and reports none of its words", async () => {
		const calls: ToolCallRecord[] = [];
		const result = await replayFixture("s1-key", harness, {
			dir: CLAUDE_FIXTURE_DIR_2_1_319,
			extra: { policy: subagentPolicy(), onCallResulted: (c) => calls.push(c) },
		});
		expect(result?.outcomes).toEqual([{ ok: true }]);
		const sub = calls.find((c) => c.agentId !== null);
		expect(sub).toBeDefined();
		expect(sub?.name).toBe("Bash");
		expect(sub?.parentToolUseId).toMatch(/^toolu_/);
		expect((sub?.detailInput as { command?: string })?.command).toContain("touch");
		const rows = result?.events.filter((e) => e.rawPayload?.kind === "call") ?? [];
		expect(rows.some((r) => String(r.content).startsWith("Subagent Bash"))).toBe(true);
	});

	test("a subagent's text is never a HeadlessAssistantMessage", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "assistant",
							session_id: "$SESSION",
							agent_id: "agent-1",
							parent_tool_use_id: "toolu_parent",
							message: {
								role: "assistant",
								content: [
									{ type: "text", text: "SUBAGENT-WORDS-NOT-CLAUDES" },
									{ type: "tool_use", id: "tu-sub", name: "Bash", input: { command: "ls" } },
								],
							},
						},
					},
					assistantText("the fork's own words"),
					resultOk,
				],
			],
		});
		const calls: ToolCallRecord[] = [];
		const rt = await h.start({
			policy: subagentPolicy(),
			onTurnFinished: (t) => calls.push(...t.calls),
		});
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		await until(() => calls.length === 1, "the observer");
		expect(calls[0]).toMatchObject({ toolUseId: "tu-sub", agentId: "agent-1" });
		const messages = h.events.filter((e) => e.eventType === "HeadlessAssistantMessage");
		expect(messages.map((m) => m.content)).toEqual(["the fork's own words"]);
		expect(h.reported()).not.toContain("SUBAGENT-WORDS-NOT-CLAUDES");
	});

	test("a request after the turn's result stays fatal with a policy that allows everything", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					resultOk,
					{ delay: 300 },
					canUseTool("late-1", "Bash", "tu-late", { command: "ls" }),
					AWAIT,
				],
			],
		});
		const rt = await h.start({
			policy: { ...subagentPolicy(), requestAllowed: () => "allow" },
		});
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		await until(() => h.states.some((s) => s.managedState === "degraded"), "the fatal ending");
		expect(h.logs.some((l) => l.includes("protocol violation") && l.includes("peer_turn"))).toBe(
			true,
		);
		// The request was answered with nothing: the wire stayed clean (afterEach holds it).
	});

	test("a request carrying agent_id is declined by default and a tool outside the policy always is", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					assistantToolUse("tu1", "Bash", { command: "ls" }),
					canUseTool("r1", "Bash", "tu1", { command: "ls" }, { agent_id: "a1" }),
					AWAIT,
					assistantToolUse("tu2", "mcp__x__y", {}),
					canUseTool("r2", "mcp__x__y", "tu2", {}),
					AWAIT,
					toolResult("tu1"),
					resultOk,
				],
			],
		});
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		const answers = h.fake
			.log()
			.filter((entry) => entry.ev === "control_response" && entry.requestId !== undefined);
		const byId = (id: string) => answers.find((a) => a.requestId === id);
		// Both were answered with a deny (the fixed words), and neither raised a card (there is no port).
		expect(byId("r1")?.response?.response?.behavior).toBe("deny");
		expect(byId("r2")?.response?.response?.behavior).toBe("deny");
		expect(h.events.some((e) => e.eventType === "ManagedWarning")).toBe(true);
	});

	test("a policy's reject code raises with that code and its own words", async () => {
		const h = harness({ turns: [[INIT, assistantText("hi"), AWAIT]] });
		const rt = await h.start({
			policy: { ...forkToolPolicy(), classifyLine: () => ({ reject: "mcp_servers_changed" }) },
		});
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a1")).done).toMatchObject({
			ok: false,
			code: "fatal",
			error: CLAUDE_FORK_MCP_CHANGED_SYNC_ERROR,
		});
		expect(
			h.events.some((e) => (e.rawPayload as { status?: string })?.status === "mcp_servers_changed"),
		).toBe(true);
	});

	test("a subagent's line after the turn ended raises subagent_after_turn, not a stranger's turn", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					resultOk,
					{ delay: 300 },
					{
						say: {
							type: "assistant",
							session_id: "$SESSION",
							agent_id: "agent-1",
							parent_tool_use_id: "toolu_parent",
							message: { role: "assistant", content: [{ type: "text", text: "still going" }] },
						},
					},
					AWAIT,
				],
			],
		});
		const rt = await h.start({ policy: subagentPolicy() });
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		await until(() => h.states.some((s) => s.managedState === "degraded"), "the fatal ending");
		expect(h.states.at(-1)?.providerSyncError).toBe(CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR);
		// With the default policy the same line is, as it always was, a stranger's turn.
		const d = harness({
			turns: [
				[
					INIT,
					resultOk,
					{ delay: 300 },
					{
						say: {
							type: "assistant",
							session_id: "$SESSION",
							agent_id: "agent-1",
							parent_tool_use_id: "toolu_parent",
							message: { role: "assistant", content: [{ type: "text", text: "still going" }] },
						},
					},
					AWAIT,
				],
			],
		});
		const rt2 = await d.start();
		rt2.beginSettle();
		rt2.settled();
		await (await rt2.sendPrompt("go", "a1")).done;
		await until(() => d.states.some((s) => s.managedState === "degraded"), "the fatal ending");
		expect(d.states.at(-1)?.providerSyncError).not.toBe(CLAUDE_FORK_SUBAGENT_AFTER_TURN_SYNC_ERROR);
	});

	test("an unsupported control-request subtype is answered at once and logged by name only", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "control_request",
							request_id: "elic-1",
							request: { subtype: "elicitation", secret: "FIELD-VALUE-NOT-LOGGED" },
						},
					},
					{ delay: 100 },
					resultOk,
				],
			],
		});
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		expect(await (await rt.sendPrompt("go", "a1")).done).toEqual({ ok: true });
		const line = h.logs.find((l) => l.includes("unsupported subtype"));
		expect(line).toContain("subtype=elicitation");
		expect(h.logs.join("\n")).not.toContain("FIELD-VALUE-NOT-LOGGED");
	});
});
