import { SESSION_RESUMED_CONTENT, SESSION_RESUMED_EVENT_TYPE } from "../../../shared/session-resume.js";
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../shared/types.js";
import {
	APPROVAL_RESOLVED_EVENT,
	eventRowIsPlainText,
	eventRowLabel,
	eventRowTone,
	getVisibleEvents,
} from "./TimelineView.js";

function ackEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		id: 1,
		sessionId: "s1",
		eventType: "UserAcknowledge",
		category: "user_ack",
		source: "observed_hook",
		content: "Acknowledged by user (dashboard)",
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: { source: "dashboard" },
		createdAt: "2026-10-01T09:00:00.000Z",
		...overrides,
	};
}

describe("getVisibleEvents — user_ack visibility (AGEN)", () => {
	test("a user_ack event is hidden in every mode except debug", () => {
		const events = [ackEvent()];
		for (const mode of ["prompts", "conversation", "progress", "terminal"] as const) {
			expect(getVisibleEvents(events, mode, true, true, true)).toHaveLength(0);
		}
	});

	test("a user_ack event is visible in debug mode", () => {
		const events = [ackEvent()];
		expect(getVisibleEvents(events, "debug", false, false, true)).toHaveLength(1);
	});
});

// AGEN: the per-verb user_ack label (previously userAckLabel) moved
// server-side into event-normalizer.ts's stored `content` string -- the
// client no longer re-derives it from rawPayload (see
// event-normalizer.test.ts for the verb/origin matrix). The timeline label
// pill for user_ack is now the plain generic category label (eventLabel),
// same as every other category; this fixes the Debug row repeating itself
// ("Error dismissed (dismiss-error)" as both the pill and the body).

describe("Codex approval events on the timeline (AGEN-87)", () => {
	const asked = ackEvent({
		eventType: "PermissionRequest",
		category: "permission_event",
		content: "Codex asks to run a command",
	});
	const resolved = ackEvent({
		id: 2,
		eventType: APPROVAL_RESOLVED_EVENT,
		category: "permission_event",
		content: "Approval resolved: approved",
	});

	test("the closing event is labelled as an approval; the request keeps the permission label", () => {
		expect(APPROVAL_RESOLVED_EVENT).toBe("ManagedApprovalResolved");
		expect(eventRowLabel(resolved)).toBe("Approval");
		expect(eventRowLabel(asked)).toBe("Permission");
		expect(eventRowLabel(ackEvent())).toBe("Acknowledged");
	});

	test("both are permission events: hidden in Prompts and Conversation, shown in the progress views", () => {
		const events = [asked, resolved];
		for (const mode of ["prompts", "conversation"] as const) {
			expect(getVisibleEvents(events, mode, true, true, true)).toHaveLength(0);
		}
		for (const mode of ["progress", "terminal", "debug"] as const) {
			expect(getVisibleEvents(events, mode, false, false, true)).toHaveLength(2);
		}
	});
});

describe("a failed prompt turn on the timeline (AGEN-91)", () => {
	const failed = ackEvent({
		eventType: "HeadlessPromptFailed",
		category: "system_event",
		content: "The turn didn't finish",
	});
	const otherSystem = ackEvent({
		id: 3,
		eventType: "ManagedWarning",
		category: "system_event",
		content: "warning",
	});

	test("it shows in Conversation, where other system rows stay hidden", () => {
		expect(getVisibleEvents([failed, otherSystem], "conversation", false, false, true)).toEqual([
			failed,
		]);
		expect(getVisibleEvents([failed, otherSystem], "prompts", false, false, true)).toEqual([
			failed,
		]);
	});

	test("the show-system toggle still hides it", () => {
		expect(getVisibleEvents([failed], "conversation", false, false, false)).toHaveLength(0);
		expect(getVisibleEvents([failed], "progress", false, false, false)).toHaveLength(0);
	});

	test("it is shown as plain text, never Markdown (a remote image would leak the viewer's address)", () => {
		expect(eventRowIsPlainText(failed)).toBe(true);
		expect(eventRowIsPlainText(otherSystem)).toBe(false);
	});

	test("the takeover and recovery rows are plain text, and carry the server's fixed words", () => {
		expect(eventRowIsPlainText({ eventType: SESSION_RESUMED_EVENT_TYPE })).toBe(true);
		expect(SESSION_RESUMED_CONTENT.takeover).toBe("AgentPulse took over this session.");
		expect(SESSION_RESUMED_CONTENT.recovery).toBe(
			"AgentPulse resumed this session. Any turn that was running when its process ended didn't finish.",
		);
	});

	test("the row is drawn amber; an ordinary system row is not", () => {
		expect(eventRowTone(failed)).toBe("amber");
		expect(eventRowTone(otherSystem)).toBe("default");
		expect(eventRowTone(ackEvent({ eventType: "x", category: "status_update" }))).toBe("emerald");
	});
});
