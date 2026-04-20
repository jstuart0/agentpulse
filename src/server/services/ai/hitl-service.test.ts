import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const {
	expireOverdueHitl,
	getOpenHitlForProposal,
	getOpenHitlForSession,
	listAllOpenHitl,
	openHitlRequest,
	resolveHitlRequest,
	supersedeOpenHitl,
} = await import("./hitl-service.js");
const { aiHitlRequests } = await import("../../db/schema.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(aiHitlRequests).execute();
});

describe("hitl-service", () => {
	test("open creates a new awaiting_reply row", async () => {
		const row = await openHitlRequest({
			proposalId: "p1",
			sessionId: "s1",
		});
		expect(row.status).toBe("awaiting_reply");
		expect(row.proposalId).toBe("p1");
	});

	test("opening a second HITL for the same session supersedes the first", async () => {
		const a = await openHitlRequest({ proposalId: "p1", sessionId: "s1" });
		const b = await openHitlRequest({ proposalId: "p2", sessionId: "s1" });
		expect(b.id).not.toBe(a.id);

		// The older one should now be superseded.
		const open = await getOpenHitlForSession("s1");
		expect(open?.id).toBe(b.id);
	});

	test("resolve applies the operator's reply and closes the row", async () => {
		const row = await openHitlRequest({ proposalId: "p1", sessionId: "s1" });
		const resolved = await resolveHitlRequest({
			id: row.id,
			status: "applied",
			replyKind: "custom",
			replyText: "do the thing",
		});
		expect(resolved?.status).toBe("applied");
		expect(resolved?.replyKind).toBe("custom");
		expect(resolved?.replyText).toBe("do the thing");
	});

	test("listAllOpenHitl returns only awaiting_reply across sessions", async () => {
		await openHitlRequest({ proposalId: "p1", sessionId: "s1" });
		await openHitlRequest({ proposalId: "p2", sessionId: "s2" });
		const first = await openHitlRequest({ proposalId: "p3", sessionId: "s3" });
		await resolveHitlRequest({
			id: first.id,
			status: "declined",
			replyKind: "decline",
		});
		const open = await listAllOpenHitl();
		expect(open.length).toBe(2);
		for (const h of open) expect(h.status).toBe("awaiting_reply");
	});

	test("supersedeOpenHitl closes all open rows for a session", async () => {
		await openHitlRequest({ proposalId: "p1", sessionId: "s1" });
		const n = await supersedeOpenHitl("s1");
		expect(n).toBe(1);
		const open = await getOpenHitlForSession("s1");
		expect(open).toBeNull();
	});

	test("expireOverdueHitl times out past-due rows only", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		await openHitlRequest({
			proposalId: "p1",
			sessionId: "s1",
			expiresAt: past,
		});
		await openHitlRequest({ proposalId: "p2", sessionId: "s2" });

		const n = await expireOverdueHitl();
		expect(n).toBe(1);

		const stillOpen = await listAllOpenHitl();
		expect(stillOpen.length).toBe(1);
		expect(stillOpen[0].sessionId).toBe("s2");
	});

	test("getOpenHitlForProposal filters by proposal id", async () => {
		const a = await openHitlRequest({ proposalId: "pA", sessionId: "s1" });
		await resolveHitlRequest({
			id: a.id,
			status: "applied",
			replyKind: "approve",
		});
		// Second open for a different proposal on the same session
		await openHitlRequest({ proposalId: "pB", sessionId: "s1" });
		expect(await getOpenHitlForProposal("pA")).toBeNull();
		expect(await getOpenHitlForProposal("pB")).not.toBeNull();
	});
});
