import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { classifyContinuability } from "./continuability.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "s1",
		sessionId: "sess1",
		displayName: "test",
		agentType: "claude_code",
		status: "active",
		cwd: "/p",
		transcriptPath: null,
		model: null,
		startedAt: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
		endedAt: null,
		semanticStatus: null,
		currentTask: null,
		planSummary: null,
		totalToolUses: 0,
		isWorking: false,
		isPinned: false,
		gitBranch: null,
		claudeMdContent: null,
		claudeMdPath: null,
		claudeMdUpdatedAt: null,
		notes: null,
		metadata: {},
		...overrides,
	};
}

function evt(overrides: Partial<SessionEvent>): SessionEvent {
	return {
		id: 1,
		sessionId: "sess1",
		eventType: "Stop",
		category: "assistant_message",
		source: "observed_hook",
		content: "done",
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("continuability", () => {
	test("isWorking → still_working (no decision)", () => {
		const result = classifyContinuability({
			session: makeSession({ isWorking: true }),
			recentEvents: [evt({})],
		});
		expect(result.eligibleToContinue).toBe(false);
		expect(result.eligibleToReport).toBe(false);
		expect(result.reason).toBe("still_working");
	});

	test("no trigger event → no_trigger", () => {
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [],
		});
		expect(result.reason).toBe("no_trigger");
	});

	test("observed session with trigger → report only", () => {
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [evt({ category: "assistant_message" })],
		});
		expect(result.eligibleToContinue).toBe(false);
		expect(result.eligibleToReport).toBe(true);
		expect(result.reason).toBe("observed_only");
	});

	test("managed + connected + quiet → continue ok", () => {
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [evt({ category: "assistant_message" })],
			managedSession: { managedState: "interactive_terminal" },
			supervisorConnected: true,
		});
		expect(result.eligibleToContinue).toBe(true);
		expect(result.reason).toBe("managed_quiet");
	});

	test("managed but supervisor offline → no action", () => {
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [evt({ category: "assistant_message" })],
			managedSession: { managedState: "headless" },
			supervisorConnected: false,
		});
		expect(result.reason).toBe("supervisor_offline");
	});

	test("managed in non-dispatch state → report only", () => {
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [evt({ category: "assistant_message" })],
			managedSession: { managedState: "linked" },
		});
		expect(result.eligibleToContinue).toBe(false);
		expect(result.eligibleToReport).toBe(true);
	});

	test("recent user prompt blocks continue but not report", () => {
		const recent = new Date().toISOString();
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [
				evt({ category: "assistant_message" }),
				evt({ category: "prompt", createdAt: recent }),
			],
			managedSession: { managedState: "interactive_terminal" },
		});
		expect(result.eligibleToContinue).toBe(false);
		expect(result.eligibleToReport).toBe(true);
		expect(result.reason).toBe("recent_user_prompt_report_ok");
	});

	test("recent ai_continue_sent blocks another continue", () => {
		const recent = new Date().toISOString();
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [
				evt({ category: "assistant_message" }),
				evt({ category: "ai_continue_sent", createdAt: recent }),
			],
			managedSession: { managedState: "interactive_terminal" },
		});
		expect(result.eligibleToContinue).toBe(false);
		expect(result.reason).toBe("recent_ai_continue_report_ok");
	});

	test("old user prompt does not block", () => {
		const old = new Date(Date.now() - 60_000).toISOString();
		const result = classifyContinuability({
			session: makeSession(),
			recentEvents: [
				evt({ category: "assistant_message" }),
				evt({ category: "prompt", createdAt: old }),
			],
			managedSession: { managedState: "interactive_terminal" },
			userPromptLockoutMs: 30_000,
		});
		expect(result.eligibleToContinue).toBe(true);
	});
});
