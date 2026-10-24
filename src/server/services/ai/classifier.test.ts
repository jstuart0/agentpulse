import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { classifySession } from "./classifier.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "s",
		sessionId: "sid",
		displayName: null,
		agentType: "claude_code",
		status: "active",
		cwd: null,
		transcriptPath: null,
		model: null,
		startedAt: "2026-04-20T00:00:00Z",
		lastActivityAt: "2026-04-20T00:00:00Z",
		endedAt: null,
		semanticStatus: null,
		currentTask: null,
		planSummary: null,
		totalToolUses: 0,
		isWorking: false,
		isPinned: false,
		nameSource: "generated",
		nativeName: null,
		gitBranch: null,
		claudeMdContent: null,
		claudeMdPath: null,
		claudeMdUpdatedAt: null,
		notes: null,
		metadata: {},
		projectId: null,
		isArchived: false,
		lastAgentTurnCompletedAt: null,
		lastUserAcknowledgedAt: null,
		...overrides,
	};
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		id: Math.floor(Math.random() * 1_000_000),
		sessionId: "sid",
		eventType: "Evt",
		category: null,
		source: "observed_hook",
		content: null,
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: "2026-04-20T00:00:00Z",
		...overrides,
	};
}

const NOW = new Date("2026-04-20T00:30:00Z");

describe("classifier", () => {
	test("blocked when open HITL is older than threshold", () => {
		const intel = classifySession({
			session: makeSession({ lastActivityAt: "2026-04-20T00:29:00Z" }),
			recentEvents: [],
			openHitl: {
				id: "h",
				proposalId: "p",
				sessionId: "sid",
				channelId: null,
				status: "awaiting_reply",
				replyKind: null,
				replyText: null,
				expiresAt: null,
				createdAt: "2026-04-20T00:15:00Z",
				updatedAt: "2026-04-20T00:15:00Z",
			},
			now: NOW,
		});
		expect(intel.health).toBe("blocked");
		expect(intel.reasonCode).toBe("hitl_pending_long");
	});

	test("blocked when managed session's supervisor is offline", () => {
		const intel = classifySession({
			session: makeSession(),
			recentEvents: [],
			supervisorConnected: false,
			now: NOW,
		});
		expect(intel.health).toBe("blocked");
		expect(intel.reasonCode).toBe("supervisor_offline");
	});

	test("stuck on repeated tool failures", () => {
		const events = Array.from({ length: 3 }, () =>
			makeEvent({
				category: "tool_event",
				eventType: "PostToolUseFailure",
				toolName: "Bash",
			}),
		);
		const intel = classifySession({
			session: makeSession(),
			recentEvents: events,
			now: NOW,
		});
		expect(intel.health).toBe("stuck");
		expect(intel.reasonCode).toBe("repeated_tool_failure");
	});

	describe("the stuck rule reads the tool's own failure signal, not words in its output (AGEN-79)", () => {
		const verdict = (events: SessionEvent[]) =>
			classifySession({ session: makeSession(), recentEvents: events, now: NOW }).reasonCode;
		const three = (overrides: Partial<SessionEvent>) =>
			Array.from({ length: 3 }, () =>
				makeEvent({
					category: "tool_event",
					eventType: "PostToolUse",
					toolName: "Bash",
					...overrides,
				}),
			);

		test("a successful call whose output says error, failed or exception is not a failure", () => {
			for (const toolResponse of [
				"Error handling lives in src/errors.ts",
				'{"stdout":"12 passed, 0 failed","stderr":"","interrupted":false}',
				"throw new Exception('x') is documented here",
				"exit with non-zero exit status is described in the README",
			]) {
				expect(verdict(three({ toolResponse }))).not.toBe("repeated_tool_failure");
			}
		});

		test("PostToolUseFailure counts, and so does a non-zero exit code in the response", () => {
			expect(verdict(three({ eventType: "PostToolUseFailure" }))).toBe("repeated_tool_failure");
			expect(verdict(three({ toolResponse: '{"stdout":"","exit_code":1}' }))).toBe(
				"repeated_tool_failure",
			);
			expect(verdict(three({ toolResponse: '{"metadata":{"exit_code":127}}' }))).toBe(
				"repeated_tool_failure",
			);
		});

		test("an exit code of zero is a success whatever the output says", () => {
			expect(
				verdict(three({ toolResponse: '{"stdout":"error: none. failed: 0","exit_code":0}' })),
			).not.toBe("repeated_tool_failure");
		});

		test("a call the user interrupted is not the session being stuck", () => {
			expect(
				verdict(three({ eventType: "PostToolUseFailure", rawPayload: { is_interrupt: true } })),
			).not.toBe("repeated_tool_failure");
		});

		test("two failures are not enough, three on more than two tools are not stuck", () => {
			const failure = (toolName: string) =>
				makeEvent({ category: "tool_event", eventType: "PostToolUseFailure", toolName });
			expect(verdict([failure("Bash"), failure("Bash")])).not.toBe("repeated_tool_failure");
			expect(verdict([failure("Bash"), failure("Edit"), failure("Read")])).not.toBe(
				"repeated_tool_failure",
			);
		});
	});

	test("risky on consecutive ai errors", () => {
		const events = Array.from({ length: 3 }, () =>
			makeEvent({
				category: "ai_error",
				content: "Provider timeout",
			}),
		);
		const intel = classifySession({
			session: makeSession(),
			recentEvents: events,
			now: NOW,
		});
		expect(intel.health).toBe("risky");
		expect(intel.reasonCode).toBe("consecutive_ai_errors");
	});

	test("complete_candidate when assistant signals done and session idle", () => {
		const events = [
			makeEvent({
				category: "assistant_message",
				content: "All tests pass and implementation complete.",
				createdAt: "2026-04-20T00:00:00Z",
			}),
		];
		const intel = classifySession({
			session: makeSession({
				lastActivityAt: "2026-04-20T00:10:00Z",
				isWorking: false,
			}),
			recentEvents: events,
			now: NOW,
		});
		expect(intel.health).toBe("complete_candidate");
	});

	test("healthy when actively working", () => {
		const intel = classifySession({
			session: makeSession({ isWorking: true }),
			recentEvents: [],
			now: NOW,
		});
		expect(intel.health).toBe("healthy");
		expect(intel.reasonCode).toBe("working");
	});

	test("healthy no-signal fallback on idle session with no evidence", () => {
		const intel = classifySession({
			session: makeSession({
				lastActivityAt: "2026-04-19T23:00:00Z",
				isWorking: false,
			}),
			recentEvents: [],
			now: NOW,
		});
		expect(intel.health).toBe("healthy");
		expect(intel.reasonCode).toBe("no_signal");
	});

	test("hitl short-age does not mark as blocked", () => {
		const intel = classifySession({
			session: makeSession({ lastActivityAt: "2026-04-20T00:28:00Z" }),
			recentEvents: [],
			openHitl: {
				id: "h",
				proposalId: "p",
				sessionId: "sid",
				channelId: null,
				status: "awaiting_reply",
				replyKind: null,
				replyText: null,
				expiresAt: null,
				createdAt: "2026-04-20T00:29:00Z",
				updatedAt: "2026-04-20T00:29:00Z",
			},
			now: NOW,
		});
		expect(intel.health).not.toBe("blocked");
	});
});
