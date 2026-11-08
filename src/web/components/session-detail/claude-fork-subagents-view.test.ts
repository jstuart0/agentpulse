/**
 * AGEN-120: the subagents option in the continue dialog and the status line. Pure functions, so each rule is a
 * test: when the control can be chosen, what is sent, the words, and the line a continued session shows.
 */
import { describe, expect, test } from "bun:test";
import {
	CLAUDE_FORK_SUBAGENTS,
	SUBAGENTS_OPTION_HELP,
	SUBAGENTS_OPTION_LABEL,
} from "../../../shared/claude-fork-subagents.js";
import {
	FORK_OPTION_CONTROLS,
	claudeDialogLines,
	forkOptionControlState,
	notInSessionLine,
} from "./claude-takeover-copy.js";
import { forkOptionsLine, forkStatusView } from "./fork-status-view.js";

const control = FORK_OPTION_CONTROLS.find((c) => c.key === "subagents");
const ADVERTISED = new Set(["claudeForkSubagents"]);

describe("the subagents control", () => {
	test("it sits beside the MCP one, with the plan's words", () => {
		expect(control).toBeDefined();
		expect(control?.label).toBe(SUBAGENTS_OPTION_LABEL);
		expect(control?.help("m")).toBe(SUBAGENTS_OPTION_HELP);
		expect(SUBAGENTS_OPTION_HELP).toBe(
			"Claude can hand parts of a turn to built-in helpers. Their file changes and commands wait for you the same way Claude's do, and they stop when the turn ends. They use more of your Claude usage.",
		);
	});

	test("drawn only when the server advertises it; usable on a machine that advertises the feature", () => {
		const state = (server: Set<string> | null, host: string[] | null) =>
			forkOptionControlState(control as never, server, "build-box", host);
		expect(state(ADVERTISED, [CLAUDE_FORK_SUBAGENTS])).toMatchObject({
			shown: true,
			disabled: false,
		});
		expect(state(new Set(), [CLAUDE_FORK_SUBAGENTS]).shown).toBe(false);
		expect(state(null, [CLAUDE_FORK_SUBAGENTS]).shown).toBe(false);
	});

	test("a machine without the feature disables it and says so in place of the description", () => {
		const state = forkOptionControlState(control as never, ADVERTISED, "build-box", []);
		expect(state.disabled).toBe(true);
		expect(state.help).toContain("build-box needs a newer AgentPulse supervisor");
		expect(state.help).not.toBe(SUBAGENTS_OPTION_HELP);
	});

	test("no machine chosen yet: usable", () => {
		expect(forkOptionControlState(control as never, ADVERTISED, null, null).disabled).toBe(false);
	});
});

describe("the dialog's 'Not in this session' line", () => {
	test("subagents is listed as absent by default and drops out when the option is on", () => {
		expect(notInSessionLine()).toContain("subagents");
		expect(notInSessionLine({ subagents: true })).not.toContain("subagents");
		const base = {
			sessionName: "s",
			machine: "m",
			cwd: "/w",
			ownerName: null,
			endedFork: null,
		};
		const on = claudeDialogLines({ ...base, requested: { subagents: true } });
		const off = claudeDialogLines(base);
		const notIn = (lines: typeof on) =>
			lines.paragraphs.find((p) => p.label === "Not in this session:");
		expect(notIn(on)?.text).not.toContain("subagents");
		expect(notIn(off)?.text).toContain("subagents");
	});
});

describe("the status line", () => {
	const applied = { mcpServers: [], subagents: true, claudeVersion: "2.1.319" };

	test("on: 'Subagents: on.'", () => {
		expect(forkOptionsLine(null, applied, "m")).toBe("Subagents: on.");
		expect(forkOptionsLine({ subagents: true }, applied, "m")).toBe("Subagents: on.");
	});

	test("nothing asked and nothing applied: no line (a session without options reads as it did)", () => {
		expect(forkOptionsLine(null, null, "m")).toBeNull();
		expect(forkOptionsLine({}, { ...applied, subagents: false }, "m")).toBeNull();
		expect(forkOptionsLine(undefined, undefined, undefined)).toBeNull();
	});

	test("asked and not applied says off, with the reason for each way it can happen", () => {
		const off = { ...applied, subagents: false };
		expect(forkOptionsLine({ subagents: true }, { ...off, claudeVersion: "2.1.320" }, "m")).toBe(
			"Subagents: off. AgentPulse hasn't checked subagents with Claude Code 2.1.320.",
		);
		expect(forkOptionsLine({ subagents: true }, { ...off, claudeVersion: "" }, "box")).toContain(
			"didn't say which options it applied",
		);
		expect(forkOptionsLine({ subagents: true }, off, "box")).toContain("didn't apply it");
		expect(forkOptionsLine({ subagents: true }, null, "box")).toContain("didn't say which options");
	});

	test("the status view carries the line, and null when the session has no options", () => {
		const input = {
			fork: { sourceId: "src", mode: "ask" as const },
			source: { state: "named" as const, name: "Original" },
			machine: "m",
			managedState: "managed",
		};
		expect(
			forkStatusView({ ...input, fork: { ...input.fork, options: applied } }).optionsLine,
		).toBe("Subagents: on.");
		expect(forkStatusView(input).optionsLine).toBeNull();
	});
});
