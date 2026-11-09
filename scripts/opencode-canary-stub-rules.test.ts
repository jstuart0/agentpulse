/**
 * AGEN-141 phase 0: the model stub only ever scripts tool calls from its allowlist. Every keyword is driven on
 * both tool sets (V1: bash/task/write/read with `filePath`; V2: shell/subagent/write/read with `path`) and every
 * call it produces is checked; a call outside the list is refused by `assertScriptedCall`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	KEYWORDS,
	type RuleWorld,
	allowedShellCommands,
	assertScriptedCall,
	canaryRules,
} from "./opencode-canary-scenarios/stub-rules.js";

const world: RuleWorld = {
	scratchRoot: "/scratch/run",
	projectDir: "/scratch/run/proj/a",
};
const tools = (names: string[]) => names.map((name) => ({ function: { name } }));
const V1_TOOLS = tools(["bash", "write", "read", "task", "edit"]);
const V2_TOOLS = tools(["shell", "write", "read", "subagent", "execute", "webfetch"]);
const ask = (toolSet: unknown, text: string, last: "user" | "tool" = "user") => {
	const messages: Array<Record<string, unknown>> = [
		{ role: "system", content: "x" },
		{ role: "user", content: text },
	];
	if (last === "tool") messages.push({ role: "tool", content: "ok" });
	return canaryRules(world)({ messages, tools: toolSet, stream: true }, {} as never);
};

describe("the canary stub rules", () => {
	test("every keyword on both tool sets yields a plain answer or a call inside the allowlist", () => {
		let calls = 0;
		for (const toolSet of [V1_TOOLS, V2_TOOLS]) {
			for (const keyword of KEYWORDS) {
				const answer = ask(toolSet, `please ${keyword}`);
				expect(answer).toBeDefined();
				for (const toolCall of answer?.toolCalls ?? []) {
					calls++;
					const args =
						typeof toolCall.arguments === "string"
							? JSON.parse(toolCall.arguments)
							: toolCall.arguments;
					expect(() =>
						assertScriptedCall({ name: toolCall.name, arguments: args }, world),
					).not.toThrow();
				}
			}
		}
		// 11 keywords, minus PLAIN and FAILTURN which script no call, on each of 2 tool sets.
		expect(calls).toBe(2 * (KEYWORDS.length - 2));
	});

	test("a request with no tools is a title, and a tool result ends the turn", () => {
		expect(ask([], "anything")?.text).toBe("Stub title");
		expect(ask(V1_TOOLS, "SHELLOK", "tool")?.text).toBe("STUB-DONE after tool");
	});

	test("a world with a gate factory holds the last answer (a model's latency); one without does not", () => {
		const gate = { arrived: Promise.resolve(), release: () => {} };
		let made = 0;
		const slow: RuleWorld = {
			...world,
			finalDelayMs: 5,
			gateFactory: () => {
				made++;
				return gate;
			},
		};
		const answer = canaryRules(slow)(
			{
				messages: [
					{ role: "user", content: "PLAIN" },
					{ role: "tool", content: "ok" },
				],
				tools: V1_TOOLS,
			},
			{} as never,
		);
		expect(answer?.gate).toBe(gate);
		expect(made).toBe(1);
		expect(ask(V1_TOOLS, "SHELLOK", "tool")?.gate).toBeUndefined();
		// A title request and a tool call are never held.
		expect(
			canaryRules(slow)({ messages: [{ role: "user", content: "x" }], tools: [] }, {} as never)
				?.gate,
		).toBeUndefined();
	});

	test("FAILTURN is an HTTP 400", () => {
		expect(ask(V1_TOOLS, "FAILTURN")?.status).toBe(400);
	});

	test("assertScriptedCall refuses a command, a path or a tool outside the list", () => {
		const call = (name: string, args: Record<string, unknown>) => () =>
			assertScriptedCall({ name, arguments: args }, world);
		expect(call("bash", { command: "rm -rf /" })).toThrow("may not run");
		expect(call("bash", { command: "ls /etc" })).toThrow("may not run");
		expect(call("shell", { command: `ls ${world.projectDir}` })).not.toThrow();
		expect(call("write", { filePath: "/etc/passwd", content: "x" })).toThrow("may not name");
		expect(call("write", { path: "relative.txt" })).toThrow("may not name");
		expect(call("write", { path: join(world.scratchRoot, "..", "x") })).toThrow("may not name");
		expect(call("write", { path: join(world.projectDir, "out.txt") })).not.toThrow();
		expect(call("webfetch", { url: "http://example.com" })).toThrow("may not call");
		expect(call("task", { prompt: "do something else" })).toThrow("fixed");
	});

	test("the shell allowlist names no path outside scratch", () => {
		for (const command of allowedShellCommands(world)) {
			for (const token of command.split(/\s+/)) {
				if (token.startsWith("/") && token !== "/dev/zero") {
					expect(token.startsWith(world.scratchRoot)).toBe(true);
				}
			}
		}
	});
});
