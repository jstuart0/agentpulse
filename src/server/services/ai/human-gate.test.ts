import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../shared/types.js";
import { ASKS_HUMAN_RE, eventsOfTurn, needsHuman, pendingAction } from "./human-gate.js";
import type { RiskClassesConfig } from "./risk-classes.js";

let nextId = 1;
function ev(over: Partial<SessionEvent>): SessionEvent {
	return {
		id: nextId++,
		sessionId: "s",
		eventType: "AssistantMessage",
		category: "assistant_message",
		source: "observed_hook",
		content: null,
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: new Date().toISOString(),
		...over,
	};
}
const message = (content: string) => ev({ content });
const NO_RISK: RiskClassesConfig = { version: 1, classes: [] };
const RM_RF: RiskClassesConfig = {
	version: 1,
	classes: [
		{
			id: "rm_rf",
			label: "rm -rf",
			match: { type: "regex", pattern: "rm\\s+-rf" },
			policyOverride: "ask",
		},
	],
};

describe("the agent's last message", () => {
	test("a question mark at the end holds the turn, even after trailing whitespace of any kind", () => {
		for (const text of [
			"I've finished the refactor. Should I also update the docs?",
			"Done. Want me to push?  ",
			`Done. Want me to push?${String.fromCodePoint(0x00a0)}`,
			`Done?${String.fromCodePoint(0x2003)}\n`,
		]) {
			expect(needsHuman([message(text)], NO_RISK), text).toMatchObject({
				hold: true,
				why: "The agent is asking you something.",
			});
		}
	});

	test("waiting phrases hold it without a question mark", () => {
		for (const text of [
			"Let me know if you want me to push",
			"I am waiting for your approval.",
			"Please confirm the migration target.",
			"That needs permission from you",
			"Shall I go ahead",
			"Do you want the long version",
		]) {
			expect(needsHuman([message(text)], NO_RISK).hold, text).toBe(true);
		}
	});

	test("a plain statement of completion does not", () => {
		expect(needsHuman([message("I fixed the build and the tests pass.")], NO_RISK)).toEqual({
			hold: false,
		});
	});

	test("only the last message counts: an earlier question that was answered does not hold the turn", () => {
		const turn = [message("Should I use tabs?"), message("Used tabs. All done.")];
		expect(needsHuman(turn, NO_RISK).hold).toBe(false);
	});

	test("a question far from the end of a long message is not read, but one at the end is", () => {
		const filler = "x".repeat(2_000);
		expect(needsHuman([message(`should i stop? ${filler}`)], NO_RISK).hold).toBe(false);
		expect(needsHuman([message(`${filler} should i stop`)], NO_RISK).hold).toBe(true);
	});

	test("the phrase test is linear on a pathological input", () => {
		const started = performance.now();
		ASKS_HUMAN_RE.test(`${"should ".repeat(15_000)}x`);
		needsHuman([message(" ".repeat(100_000))], NO_RISK);
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe("open prompts", () => {
	test("a permission event, a PermissionRequest or a Notification holds the turn", () => {
		for (const open of [
			ev({ eventType: "PermissionRequest", category: "permission_event" }),
			ev({ eventType: "PermissionRequest", category: null }),
			ev({ eventType: "Notification", category: "status_update" }),
		]) {
			expect(needsHuman([open, message("done")], NO_RISK)).toMatchObject({
				hold: true,
				why: "A permission prompt is open.",
			});
		}
		expect(needsHuman([message("done")], NO_RISK).hold).toBe(false);
	});
});

describe("risk on the message or the pending action", () => {
	test("a risk class matching the last message holds the turn, naming the class", () => {
		expect(needsHuman([message("Next I will rm -rf build")], RM_RF)).toEqual({
			hold: true,
			why: "Risk class(es) matched: rm -rf",
		});
	});

	test("a PreToolUse with no PostToolUse is the pending action, and risk is read from its input", () => {
		const pending = ev({
			eventType: "PreToolUse",
			category: "tool_event",
			toolName: "Bash",
			toolInput: { command: "rm -rf build" },
			rawPayload: { tool_use_id: "t1" },
		});
		expect(pendingAction([pending])).toContain("rm -rf build");
		expect(needsHuman([message("done"), pending], RM_RF).hold).toBe(true);
	});

	test("a PreToolUse that its PostToolUse answered is not pending", () => {
		const pre = ev({
			eventType: "PreToolUse",
			category: "tool_event",
			toolName: "Bash",
			toolInput: { command: "rm -rf build" },
			rawPayload: { tool_use_id: "t1" },
		});
		const post = ev({
			eventType: "PostToolUse",
			category: "tool_event",
			toolName: "Bash",
			rawPayload: { tool_use_id: "t1" },
		});
		expect(pendingAction([pre, post])).toBeNull();
		expect(needsHuman([pre, post, message("done")], RM_RF).hold).toBe(false);
	});

	test("a PostToolUse for a different call does not answer it", () => {
		const pre = ev({
			eventType: "PreToolUse",
			toolName: "Bash",
			toolInput: { command: "ls" },
			rawPayload: { tool_use_id: "t1" },
		});
		const other = ev({
			eventType: "PostToolUse",
			toolName: "Bash",
			rawPayload: { tool_use_id: "t2" },
		});
		expect(pendingAction([pre, other])).toContain("ls");
	});

	test("without ids, a later PostToolUse of the same tool answers it", () => {
		const pre = ev({ eventType: "PreToolUse", toolName: "Bash", toolInput: { command: "ls" } });
		const post = ev({ eventType: "PostToolUse", toolName: "Bash" });
		expect(pendingAction([pre, post])).toBeNull();
	});
});

describe("eventsOfTurn", () => {
	test("is everything after the newest prompt up to the trigger", () => {
		const p1 = ev({ category: "prompt", eventType: "UserPromptSubmit" });
		const a1 = message("first");
		const p2 = ev({ category: "prompt", eventType: "UserPromptSubmit" });
		const a2 = message("second");
		const stop = ev({ eventType: "Stop", category: "system_event" });
		const later = message("after the stop");
		const turn = eventsOfTurn([p1, a1, p2, a2, stop, later], stop.id);
		expect(turn.map((e) => e.id)).toEqual([a2.id, stop.id]);
	});

	test("a turn with no prompt before it is everything up to the trigger", () => {
		const a = message("x");
		const stop = ev({ eventType: "Stop", category: "system_event" });
		expect(eventsOfTurn([a, stop], stop.id).map((e) => e.id)).toEqual([a.id, stop.id]);
	});
});
