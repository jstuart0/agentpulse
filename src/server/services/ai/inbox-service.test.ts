import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	type InboxWorkItem,
	KNOWN_NOTIFICATION_CHANNEL_KINDS,
	type NotificationChannelKind,
} from "../../../shared/types.js";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const {
	aiActionRequests,
	aiHitlRequests,
	aiInboxSnoozes,
	aiWatcherReports,
	events,
	sessions,
	watcherProposals,
} = await import("../../db/schema/index.js");
const { buildInbox } = await import("./inbox-service.js");
const { snoozeItem } = await import("./inbox-snooze-service.js");
const { completeProposalAsHitl, createPendingProposal, failProposal } = await import(
	"./proposals-service.js"
);

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(aiInboxSnoozes).execute();
	await getDb().delete(aiActionRequests).execute();
	await getDb().delete(aiHitlRequests).execute();
	await getDb().delete(aiWatcherReports).execute();
	await getDb().delete(watcherProposals).execute();
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
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
			"watcher_report",
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
			await getDb().delete(aiActionRequests).execute();
			await getDb()
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
		await getDb()
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
	describe("watcher reports", () => {
		const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
		async function report(
			sessionId: string,
			turnKey: string,
			over: Partial<typeof aiWatcherReports.$inferInsert> = {},
		) {
			const id = crypto.randomUUID();
			await getDb()
				.insert(aiWatcherReports)
				.values({
					id,
					sessionId,
					turnKey,
					status: "delivered",
					verdict: "finished",
					why: "The agent finished the change.",
					throughEventId: 1,
					createdAt: ago(60_000),
					...over,
				});
			return id;
		}

		test("a delivered report shows, with a severity per verdict", async () => {
			await mkSession("w1");
			await mkSession("w2");
			await mkSession("w3");
			await report("w1", "p:1", { verdict: "finished" });
			await report("w2", "p:1", { verdict: "stuck" });
			await report("w3", "p:1", { verdict: "needs_you" });
			const inbox = await buildInbox();
			const reports = inbox.items.filter((i) => i.kind === "watcher_report");
			expect(reports).toHaveLength(3);
			const by = (id: string) => reports.find((r) => r.sessionId === id)?.severity;
			expect([by("w1"), by("w2"), by("w3")]).toEqual(["info", "normal", "high"]);
			expect(inbox.byKind.watcher_report).toBe(3);
		});

		test("only the newest delivered report of a session shows", async () => {
			await mkSession("w4");
			await report("w4", "p:1", { createdAt: ago(300_000), why: "old" });
			const newest = await report("w4", "p:2", { createdAt: ago(60_000), why: "new" });
			const inbox = await buildInbox();
			const reports = inbox.items.filter((i) => i.kind === "watcher_report");
			expect(reports.map((r) => r.id)).toEqual([newest]);
		});

		test("failed, suppressed and claimed rows never show", async () => {
			await mkSession("w5");
			// Each carries a verdict and a note, so only its status keeps it out.
			await report("w5", "p:1", { status: "failed", failureCode: "parse" });
			await report("w5", "p:2", { status: "suppressed", failureCode: "stale" });
			await report("w5", "p:3", { status: "claimed" });
			const inbox = await buildInbox();
			expect(inbox.items.filter((i) => i.kind === "watcher_report")).toEqual([]);
		});

		test("acknowledging the session clears it, and a later report shows again", async () => {
			await mkSession("w6", { lastUserAcknowledgedAt: ago(30_000) });
			await report("w6", "p:1", { createdAt: ago(60_000) });
			expect((await buildInbox()).items.filter((i) => i.kind === "watcher_report")).toEqual([]);
			const later = await report("w6", "p:2", { createdAt: ago(5_000) });
			const shown = (await buildInbox()).items.filter((i) => i.kind === "watcher_report");
			expect(shown.map((r) => r.id)).toEqual([later]);
		});

		test("a SQLite-format acknowledgement time is compared as a time, not as text", async () => {
			// 'YYYY-MM-DD HH:MM:SS' (UTC) against an ISO report time one hour later.
			const ackAt = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
			await mkSession("w7", { lastUserAcknowledgedAt: ackAt });
			const id = await report("w7", "p:1", { createdAt: ago(60_000) });
			const shown = (await buildInbox()).items.filter((i) => i.kind === "watcher_report");
			expect(shown.map((r) => r.id)).toEqual([id]);
		});

		test("snoozing a report hides it", async () => {
			await mkSession("w8");
			const id = await report("w8", "p:1");
			await snoozeItem({
				kind: "watcher_report",
				targetId: id,
				until: new Date(Date.now() + 60_000),
			});
			expect((await buildInbox()).items.filter((i) => i.kind === "watcher_report")).toEqual([]);
		});
	});
});
