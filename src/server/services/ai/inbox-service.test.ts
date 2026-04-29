import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	type InboxWorkItem,
	KNOWN_NOTIFICATION_CHANNEL_KINDS,
	type NotificationChannelKind,
} from "../../../shared/types.js";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiActionRequests, aiHitlRequests, aiInboxSnoozes, events, sessions, watcherProposals } =
	await import("../../db/schema.js");
const { buildInbox } = await import("./inbox-service.js");
const { snoozeItem } = await import("./inbox-snooze-service.js");
const { completeProposalAsHitl, createPendingProposal, failProposal } = await import(
	"./proposals-service.js"
);

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiInboxSnoozes).execute();
	await db.delete(aiActionRequests).execute();
	await db.delete(aiHitlRequests).execute();
	await db.delete(watcherProposals).execute();
	await db.delete(events).execute();
	await db.delete(sessions).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			displayName: `name-${sessionId}`,
			agentType: "claude_code",
			status: "active",
			...overrides,
		})
		.execute();
}

describe("inbox-service", () => {
	test("lists open HITL across sessions with session name and prompt", async () => {
		await mkSession("s1");
		const p = await createPendingProposal({
			sessionId: "s1",
			providerId: "prov",
		});
		await completeProposalAsHitl({
			id: p.id,
			decision: "continue",
			nextPrompt: "do the thing",
			tokensIn: 1,
			tokensOut: 1,
			costCents: 0,
		});

		const inbox = await buildInbox();
		const hitl = inbox.items.filter((i) => i.kind === "hitl");
		expect(hitl.length).toBe(1);
		expect(hitl[0]).toMatchObject({
			kind: "hitl",
			sessionId: "s1",
			sessionName: "name-s1",
			decision: "continue",
			prompt: "do the thing",
		});
	});

	test("surfaces failed proposals", async () => {
		await mkSession("s2");
		const p = await createPendingProposal({
			sessionId: "s2",
			providerId: "prov",
		});
		await failProposal({
			id: p.id,
			errorSubType: "transient_rate_limit",
			errorMessage: "429",
		});

		const inbox = await buildInbox();
		const failed = inbox.items.filter((i) => i.kind === "failed_proposal");
		expect(failed.length).toBe(1);
		expect(failed[0]).toMatchObject({
			kind: "failed_proposal",
			sessionId: "s2",
			errorSubType: "transient_rate_limit",
		});
	});

	test("kind filter limits to a single kind", async () => {
		await mkSession("s3");
		const p = await createPendingProposal({
			sessionId: "s3",
			providerId: "prov",
		});
		await failProposal({ id: p.id, errorSubType: "unknown", errorMessage: "err" });
		const inbox = await buildInbox({ kinds: ["failed_proposal"] });
		expect(inbox.items.every((i) => i.kind === "failed_proposal")).toBe(true);
	});

	test("sessionId filter narrows to a single session", async () => {
		await mkSession("sA");
		await mkSession("sB");
		const p1 = await createPendingProposal({
			sessionId: "sA",
			providerId: "prov",
		});
		await failProposal({ id: p1.id, errorSubType: "x", errorMessage: "a" });
		const p2 = await createPendingProposal({
			sessionId: "sB",
			providerId: "prov",
		});
		await failProposal({ id: p2.id, errorSubType: "y", errorMessage: "b" });
		const inbox = await buildInbox({ sessionId: "sA" });
		expect(inbox.items.every((i) => i.sessionId === "sA")).toBe(true);
	});

	test("byKind enumerates every InboxWorkItem kind (zero counts when empty)", async () => {
		// Guard rail: tuple is typed with `as const` so its element type is
		// the literal union of the strings below. The two `Equals` assertions
		// fail to compile if a new variant is added to `InboxWorkItem` without
		// being added here (the union widens but the tuple does not, or vice
		// versa). This forces every new kind to land with a corresponding
		// `byKind` assertion in this test.
		const expectedKinds = [
			"hitl",
			"stuck",
			"risky",
			"failed_proposal",
			"action_launch",
			"action_add_project",
			"action_session_stop",
			"action_session_archive",
			"action_session_delete",
			"action_edit_project",
			"action_delete_project",
			"action_edit_template",
			"action_delete_template",
			"action_add_channel",
			"action_create_alert_rule",
			"action_create_freeform_alert_rule",
			"action_bulk_session",
		] as const;

		// Bidirectional subset checks → compile-time set equality.
		type _Listed = (typeof expectedKinds)[number];
		type _Actual = InboxWorkItem["kind"];
		// If a new kind is added to InboxWorkItem, the next line errors.
		const _missingFromTest = (k: _Actual): _Listed => k;
		// If a kind is listed here that no longer exists in InboxWorkItem,
		// this line errors.
		const _staleInTest = (k: _Listed): _Actual => k;
		void _missingFromTest;
		void _staleInTest;

		const inbox = await buildInbox();
		for (const kind of expectedKinds) {
			expect(inbox.byKind).toHaveProperty(kind);
			expect(inbox.byKind[kind]).toBe(0);
		}
	});

	test("add_channel inbox composer accepts every KNOWN_NOTIFICATION_CHANNEL_KINDS member", async () => {
		// Slice TYPE-2c. Confirms the inbox `validKinds` allowlist tracks
		// the canonical const. If a new transport is added to
		// KNOWN_NOTIFICATION_CHANNEL_KINDS, the composer must surface it
		// as `channelKind` (not silently fall back to "telegram").
		for (const kind of KNOWN_NOTIFICATION_CHANNEL_KINDS) {
			await db.delete(aiActionRequests).execute();
			await db
				.insert(aiActionRequests)
				.values({
					kind: "add_channel",
					status: "awaiting_reply",
					question: `Set up a ${kind} channel?`,
					payload: { channelKind: kind, label: `t-${kind}` },
					origin: "web",
				})
				.execute();
			const inbox = await buildInbox();
			const card = inbox.items.find((i) => i.kind === "action_add_channel");
			expect(card).toBeDefined();
			if (card && card.kind === "action_add_channel") {
				expect(card.channelKind).toBe(kind);
			}
		}
	});

	test("add_channel inbox composer falls back to telegram for an impostor channelKind", async () => {
		// The composer narrows via `KNOWN_NOTIFICATION_CHANNEL_KINDS.includes`
		// — an unknown value (e.g. a future "slack" before the const is
		// updated) must NOT pass the gate; the card stays renderable by
		// falling through to telegram so the operator can still decline.
		await db
			.insert(aiActionRequests)
			.values({
				kind: "add_channel",
				status: "awaiting_reply",
				question: "Set up a slack channel?",
				payload: { channelKind: "slack" as NotificationChannelKind, label: "imposter" },
				origin: "web",
			})
			.execute();
		const inbox = await buildInbox();
		const card = inbox.items.find((i) => i.kind === "action_add_channel");
		expect(card).toBeDefined();
		if (card && card.kind === "action_add_channel") {
			expect(card.channelKind).toBe("telegram");
		}
	});

	test("snoozed failed proposals are hidden from the inbox", async () => {
		await mkSession("snz");
		const p = await createPendingProposal({
			sessionId: "snz",
			providerId: "prov",
		});
		await failProposal({ id: p.id, errorSubType: "rate", errorMessage: "r" });
		const before = await buildInbox();
		expect(before.items.some((i) => i.kind === "failed_proposal")).toBe(true);

		await snoozeItem({
			kind: "failed_proposal",
			targetId: p.id,
			until: new Date(Date.now() + 60_000),
		});
		const after = await buildInbox();
		expect(after.items.some((i) => i.kind === "failed_proposal" && i.id === p.id)).toBe(false);
	});
});
