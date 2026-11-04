import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../shared/types.js";
import { APPROVAL_RESOLVED_EVENT, eventRowLabel, getVisibleEvents } from "./TimelineView.js";

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
