import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { aiHitlRequests, aiInboxSnoozes, events, sessions, watcherProposals } = await import(
	"../../db/schema.js"
);
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
