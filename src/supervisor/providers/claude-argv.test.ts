/**
 * AGEN-117 P3 item 3 (T4, T5, T8): the argv builder, held by equality in both modes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_FORK_MODES, type ClaudeForkMode } from "../../shared/session-resume.js";
import {
	CLAUDE_FORK_DISALLOWED_TOOLS,
	CLAUDE_FORK_SETTINGS,
	CLAUDE_FORK_TOOLS,
	ClaudeArgvError,
	forkArgv,
	inPlaceArgv,
	probeArgv,
} from "./claude-argv.js";

const S = "11111111-1111-4111-8111-111111111111";
const N = "22222222-2222-4222-8222-222222222222";
const MODES: readonly ClaudeForkMode[] = ["ask", "restricted"];

const without = (argv: string[], flags: string[]) => {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (flags.includes(argv[i] as string)) {
			i++;
			continue;
		}
		out.push(argv[i] as string);
	}
	return out;
};
const valueAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("claude argv", () => {
	test("both modes are the build's modes", () => {
		expect([...CLAUDE_FORK_MODES]).toEqual([...MODES]);
	});

	for (const mode of MODES) {
		describe(`mode ${mode}`, () => {
			test("forkArgv is the measured argv, flag for flag", () => {
				const expected = [
					"--output-format",
					"stream-json",
					"--verbose",
					"--input-format",
					"stream-json",
					"--permission-prompt-tool=stdio",
					"--permission-mode",
					"default",
					"--setting-sources",
					"user",
					...(mode === "restricted" ? ["--restricted"] : []),
					"--resume",
					S,
					"--fork-session",
					"--session-id",
					N,
					"--tools",
					"Bash,Read,Write,Edit,NotebookEdit,WebFetch",
					"--strict-mcp-config",
					"--disable-slash-commands",
					"--disallowedTools",
					"Agent,Task,SendMessage,ListAgents,CronCreate,CronDelete,CronList,ScheduleWakeup,EnterWorktree,ExitWorktree,Skill,Workflow,Monitor,AskUserQuestion,EnterPlanMode,ExitPlanMode,TaskStop,ReportFindings,ToolSearch,WebSearch",
					"--settings",
					'{"permissions":{"ask":["Write(*)","Edit(*)","NotebookEdit(*)","WebFetch(*)"]}}',
				];
				expect(forkArgv({ source: S, fork: N, mode })).toEqual(expected);
			});

			test("--restricted is present exactly under restricted; bypass and acceptEdits never", () => {
				const argv = forkArgv({ source: S, fork: N, mode });
				expect(argv.includes("--restricted")).toBe(mode === "restricted");
				expect(argv.join(" ")).not.toMatch(/bypass|acceptEdits|dangerously|--allowedTools/i);
				expect(valueAfter(argv, "--permission-mode")).toBe("default");
			});

			test("forkArgv with the fork equal to the source throws, and a non-UUID is refused", () => {
				expect(() => forkArgv({ source: S, fork: S, mode })).toThrow(ClaudeArgvError);
				expect(() => forkArgv({ source: "../x", fork: N, mode })).toThrow(ClaudeArgvError);
				expect(() => forkArgv({ source: S, fork: "not-a-uuid", mode })).toThrow(ClaudeArgvError);
			});

			test("--resume appears only with --fork-session and --session-id, or in place for a recorded fork", () => {
				const fork = forkArgv({ source: S, fork: N, mode });
				expect(fork.includes("--fork-session")).toBe(true);
				expect(valueAfter(fork, "--session-id")).toBe(N);
				expect(valueAfter(fork, "--resume")).toBe(S);

				const inPlace = inPlaceArgv({ fork: N, record: { source: S, mode }, mode });
				expect(valueAfter(inPlace, "--resume")).toBe(N);
				expect(inPlace.includes("--session-id")).toBe(false);
				expect(inPlace.includes("--fork-session")).toBe(false);
			});

			test("inPlaceArgv needs a record that names another session as its source", () => {
				expect(() => inPlaceArgv({ fork: N, record: null, mode })).toThrow(ClaudeArgvError);
				expect(() => inPlaceArgv({ fork: N, record: undefined, mode })).toThrow(ClaudeArgvError);
				expect(() => inPlaceArgv({ fork: N, record: { source: N, mode }, mode })).toThrow(
					ClaudeArgvError,
				);
				expect(() => inPlaceArgv({ fork: N, record: { source: "nope", mode }, mode })).toThrow(
					ClaudeArgvError,
				);
			});

			test("probeArgv is forkArgv minus exactly --resume, --fork-session, --session-id and their values", () => {
				const fork = forkArgv({ source: S, fork: N, mode });
				const probe = probeArgv({ mode });
				const stripped = without(fork, ["--resume", "--session-id"]).filter(
					(a) => a !== "--fork-session",
				);
				expect(probe).toEqual(stripped);
				for (const id of [S, N]) expect(probe.includes(id)).toBe(false);
			});

			test("--settings deep-equals the four ask rules and holds no hooks key", () => {
				const settings = JSON.parse(
					valueAfter(forkArgv({ source: S, fork: N, mode }), "--settings") as string,
				);
				expect(settings).toEqual({
					permissions: { ask: ["Write(*)", "Edit(*)", "NotebookEdit(*)", "WebFetch(*)"] },
				});
				expect(settings).not.toHaveProperty("hooks");
				expect(CLAUDE_FORK_SETTINGS.permissions.ask).toHaveLength(4);
			});

			test("the tools are the six and the disallowed list has none of them", () => {
				const argv = forkArgv({ source: S, fork: N, mode });
				expect((valueAfter(argv, "--tools") as string).split(",")).toEqual([...CLAUDE_FORK_TOOLS]);
				for (const tool of CLAUDE_FORK_TOOLS) {
					expect((CLAUDE_FORK_DISALLOWED_TOOLS as readonly string[]).includes(tool)).toBe(false);
				}
				expect(argv).toContain("--strict-mcp-config");
				expect(argv).toContain("--disable-slash-commands");
				expect(argv).toContain("--setting-sources");
				expect(valueAfter(argv, "--setting-sources")).toBe("user");
			});
		});
	}

	test("an unknown mode is refused by every builder", () => {
		const bad = "yolo" as unknown as ClaudeForkMode;
		expect(() => forkArgv({ source: S, fork: N, mode: bad })).toThrow(ClaudeArgvError);
		expect(() => probeArgv({ mode: bad })).toThrow(ClaudeArgvError);
		expect(() => inPlaceArgv({ fork: N, record: { source: S, mode: "ask" }, mode: bad })).toThrow(
			ClaudeArgvError,
		);
	});

	test("the two modes differ in --restricted and nothing else", () => {
		const ask = forkArgv({ source: S, fork: N, mode: "ask" });
		const restricted = forkArgv({ source: S, fork: N, mode: "restricted" });
		expect(without(restricted, []).filter((a) => a !== "--restricted")).toEqual(ask);
	});
});

describe("drift guard: no other file builds the fork's argv", () => {
	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__fixtures__" || entry.name === "node_modules") continue;
				out.push(...sourceFiles(full));
			} else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
		}
		return out;
	}
	const SRC = join(import.meta.dir, "..", "..");

	test("--settings with an ask rule and --fork-session are emitted only by claude-argv.ts", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			if (file.endsWith("claude-argv.ts")) continue;
			const text = readFileSync(file, "utf8");
			if (/"--fork-session"|"--permission-prompt-tool|"--restricted"/.test(text))
				offenders.push(file);
			if (/--settings\b/.test(text)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("the scan sees the builder it is guarding", () => {
		const text = readFileSync(join(import.meta.dir, "claude-argv.ts"), "utf8");
		expect(text).toContain('"--fork-session"');
		expect(text).toContain('"--settings"');
	});
});
