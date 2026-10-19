import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const {
	HITL_TTL_MS,
	expireOverdueHitl,
	getOpenHitlForProposal,
	getOpenHitlForSession,
	listAllOpenHitl,
	openHitlRequest,
	supersedeOpenHitl,
} = await import("./hitl-service.js");
const { aiHitlRequests, sessions } = await import("../../db/schema/index.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(aiHitlRequests).execute();
	await getDb().delete(sessions).execute();
	// Slice DB-1 added cascade FKs that require parent sessions to exist
	// before child rows. Seed the IDs these tests reference.
	for (const id of ["s1", "s2", "s3"]) {
		await getDb()
			.insert(sessions)
			.values({ sessionId: id, agentType: "claude_code" })
			.onConflictDoNothing();
	}
});

/** Closes a request the way a decision does (the decision service is what does it for real). */
async function closeRow(id: string, status: "applied" | "declined") {
	await getDb().update(aiHitlRequests).set({ status }).where(eq(aiHitlRequests.id, id));
}

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

	test("a request opens with an expiry a day out unless one is given", async () => {
		const row = await openHitlRequest({ proposalId: "p1", sessionId: "s1" });
		const left = Date.parse(row.expiresAt as string) - Date.now();
		expect(left).toBeGreaterThan(HITL_TTL_MS - 60_000);
		expect(left).toBeLessThanOrEqual(HITL_TTL_MS);
	});

	test("listAllOpenHitl returns only awaiting_reply across sessions", async () => {
		await openHitlRequest({ proposalId: "p1", sessionId: "s1" });
		await openHitlRequest({ proposalId: "p2", sessionId: "s2" });
		const first = await openHitlRequest({ proposalId: "p3", sessionId: "s3" });
		await closeRow(first.id, "declined");
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
		await closeRow(a.id, "applied");
		// Second open for a different proposal on the same session
		await openHitlRequest({ proposalId: "pB", sessionId: "s1" });
		expect(await getOpenHitlForProposal("pA")).toBeNull();
		expect(await getOpenHitlForProposal("pB")).not.toBeNull();
	});

	test("the watcher's periodic sweep closes overdue requests", () => {
		const source = readFileSync(join(import.meta.dir, "runner.ts"), "utf8");
		const sweep = source.slice(source.indexOf("private async runAlertRuleSweep"));
		expect(sweep.slice(0, sweep.indexOf("\n\t}\n"))).toContain("await expireOverdueHitl()");
	});
});
