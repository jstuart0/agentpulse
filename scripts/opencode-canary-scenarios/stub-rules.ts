/**
 * The model stub's rules for the OpenCode canary (AGEN-141, phase 0). OpenCode makes an unpredictable number of
 * model calls per turn (a title, a retry), so the stub answers by keyword in the last user message instead of
 * from a queue. **It only ever emits a tool call that `assertScriptedCall` accepts**: a shell command from a fixed
 * list of literals and file paths that sit inside the scratch directory. No scripted argument can name a command
 * or path of the person's; `stub-rules.test.ts` pins that for every keyword on both lines.
 */
import { isAbsolute, join } from "node:path";
import type { ScriptedAnswer, StubRule } from "../../src/server/test-utils/llm-stub-server.js";
import { inside } from "../lib/throwaway-home.js";

export interface RuleWorld {
	scratchRoot: string;
	/** The project directory the session runs in (inside scratch). */
	projectDir: string;
}

export const KEYWORDS = [
	"PLAIN",
	"SHELLOK",
	"SHELLFAIL",
	"LSDIR",
	"WRITEFILE",
	"READMISSING",
	"SUBTASK",
	"FAILTURN",
	"BIGOUT",
	"PERMASK",
	"SLOWCALL",
] as const;
export type Keyword = (typeof KEYWORDS)[number];

const BIG_OUTPUT = "head -c 300000 /dev/zero | tr '\\0' x; echo";
const SLOW = "sleep 4; echo slow-done";

/** The only shell commands the stub may script. */
export function allowedShellCommands(world: RuleWorld): readonly string[] {
	return ["printf ok", "exit 3", BIG_OUTPUT, SLOW, `ls ${world.projectDir}`];
}

const TOOL_NAMES = new Set(["shell", "bash", "write", "read", "task", "subagent"]);
const PATH_KEYS = ["path", "filePath"];

export interface ScriptedCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** Throws unless a scripted tool call is inside the allowlist. */
export function assertScriptedCall(call: ScriptedCall, world: RuleWorld): void {
	if (!TOOL_NAMES.has(call.name)) throw new Error(`the stub may not call ${call.name}`);
	const args = call.arguments;
	if (call.name === "shell" || call.name === "bash") {
		if (typeof args.command !== "string" || !allowedShellCommands(world).includes(args.command)) {
			throw new Error(`the stub may not run ${String(args.command)}`);
		}
	}
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !isAbsolute(value) || !inside(world.scratchRoot, value)) {
			throw new Error(`the stub may not name ${String(value)} (${key})`);
		}
	}
	if (call.name === "task" || call.name === "subagent") {
		if (args.prompt !== "CHILDWORK SHELLOK") throw new Error("the stub's subagent prompt is fixed");
	}
}

const lastUserText = (messages: Array<Record<string, unknown>>): string => {
	const users = messages.filter((m) => m.role === "user");
	const last = users.at(-1);
	if (!last) return "";
	return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
};

const toolNamesOf = (body: Record<string, unknown>): string[] =>
	((body.tools as Array<{ function?: { name?: string } }> | undefined) ?? [])
		.map((t) => t.function?.name)
		.filter((n): n is string => typeof n === "string");

function call(
	world: RuleWorld,
	name: string,
	args: Record<string, unknown>,
	id: string,
): ScriptedAnswer {
	assertScriptedCall({ name, arguments: args }, world);
	return { text: "", toolCalls: [{ id, name, arguments: args }], usage: { input: 10, output: 5 } };
}

/** The rules for one world. `STUB-DONE` follows any tool result; a request with no tools is a title request. */
export function canaryRules(world: RuleWorld): StubRule {
	const outFile = join(world.projectDir, "out.txt");
	const missing = join(world.projectDir, "missing.txt");
	const permFile = join(world.projectDir, "perm.txt");
	return (body) => {
		const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? [];
		const names = toolNamesOf(body);
		const text = lastUserText(messages);
		if (messages.at(-1)?.role === "tool") {
			return { text: "STUB-DONE after tool", stop: "stop", usage: { input: 10, output: 5 } };
		}
		if (names.length === 0) return { text: "Stub title", stop: "stop" };
		if (text.includes("FAILTURN")) {
			return {
				text: "",
				status: 400,
				errorBody: JSON.stringify({
					error: { message: "stub forced failure", type: "invalid_request_error" },
				}),
			};
		}
		const shell = names.includes("shell") ? "shell" : names.includes("bash") ? "bash" : null;
		const shellArgs = (command: string) =>
			shell === "bash" ? { command, description: "canary" } : { command };
		if (shell && text.includes("SHELLFAIL"))
			return call(world, shell, shellArgs("exit 3"), "call_stub_fail_1");
		if (shell && text.includes("SHELLOK"))
			return call(world, shell, shellArgs("printf ok"), "call_stub_ok_1");
		if (shell && text.includes("LSDIR")) {
			return call(world, shell, shellArgs(`ls ${world.projectDir}`), "call_stub_ls_1");
		}
		if (shell && text.includes("BIGOUT"))
			return call(world, shell, shellArgs(BIG_OUTPUT), "call_stub_big_1");
		if (shell && text.includes("SLOWCALL"))
			return call(world, shell, shellArgs(SLOW), "call_stub_slow_1");
		if (names.includes("write") && text.includes("PERMASK")) {
			return call(
				world,
				"write",
				{ filePath: permFile, path: permFile, content: "perm\n" },
				"call_stub_perm_1",
			);
		}
		if (names.includes("write") && text.includes("WRITEFILE")) {
			return call(
				world,
				"write",
				{ filePath: outFile, path: outFile, content: "hello from stub\n" },
				"call_stub_write_1",
			);
		}
		if (names.includes("read") && text.includes("READMISSING")) {
			return call(world, "read", { filePath: missing, path: missing }, "call_stub_read_1");
		}
		if (text.includes("SUBTASK")) {
			const sub = names.includes("subagent") ? "subagent" : names.includes("task") ? "task" : null;
			if (sub === "subagent") {
				return call(
					world,
					sub,
					{ agent: "general", description: "child job", prompt: "CHILDWORK SHELLOK" },
					"call_stub_sub_1",
				);
			}
			if (sub === "task") {
				return call(
					world,
					sub,
					{ description: "child job", prompt: "CHILDWORK SHELLOK", subagent_type: "general" },
					"call_stub_task_1",
				);
			}
		}
		return { text: "STUB-PLAIN reply", stop: "stop", usage: { input: 10, output: 5 } };
	};
}
