/**
 * The Notify report store: at most one row per (session, turn), kept by the
 * database; takeover of a transient failure; the delivered-only evidence
 * watermark; the Telegram counts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { seedSession } from "../../test-utils/watcher-fixtures.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { aiWatcherReports, sessions } = await import("../../db/schema/index.js");
const reports = await import("./watcher-reports-service.js");

beforeAll(() => initializeDatabase());

async function reset() {
	await getDb().delete(aiWatcherReports);
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

let n = 0;
async function freshSession() {
	const sessionId = `rs-${++n}-${crypto.randomUUID().slice(0, 6)}`;
	await seedSession(sessionId);
	return sessionId;
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const rowOf = async (id: string) =>
	(await getDb().select().from(aiWatcherReports).where(eq(aiWatcherReports.id, id)))[0];

async function plant(
	sessionId: string,
	turnKey: string,
	over: Partial<typeof aiWatcherReports.$inferInsert> = {},
) {
	const id = crypto.randomUUID();
	await getDb()
		.insert(aiWatcherReports)
		.values({ id, sessionId, turnKey, createdAt: ago(10 * 60_000), ...over });
	return id;
}

describe("claimReport", () => {
	test("the first claim wins and a second for the same turn does not", async () => {
		const sessionId = await freshSession();
		const first = await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 5 });
		expect(first).toMatchObject({ claimed: true, attempt: 1 });
		expect(await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 6 })).toEqual({
			claimed: false,
		});
		expect(
			await reports.claimReport({ sessionId, turnKey: "p:2", triggerEventId: 9 }),
		).toMatchObject({
			claimed: true,
		});
	});

	test("five claims at once: exactly one gets the turn", async () => {
		const sessionId = await freshSession();
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				reports.claimReport({ sessionId, turnKey: "p:7", triggerEventId: 1 }),
			),
		);
		expect(results.filter((r) => r.claimed)).toHaveLength(1);
		expect(await getDb().select().from(aiWatcherReports)).toHaveLength(1);
	});

	test("a transient failure with attempts left is taken over; attempts count up and the code clears", async () => {
		for (const code of ["provider_timeout", "provider_transient", "evidence_read", "abandoned"]) {
			const sessionId = await freshSession();
			const id = await plant(sessionId, "p:1", {
				status: "failed",
				failureCode: code,
				attemptCount: 1,
			});
			const claim = await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 8 });
			expect(claim, code).toEqual({ claimed: true, id, attempt: 2 });
			const row = await rowOf(id);
			expect(row).toMatchObject({
				status: "claimed",
				failureCode: null,
				attemptCount: 2,
				triggerEventId: 8,
			});
		}
	});

	test("never taken over: a claimed row, a model failure, a third attempt, a delivered or suppressed row", async () => {
		const cases: Array<Partial<typeof aiWatcherReports.$inferInsert>> = [
			{ status: "claimed" },
			// Impossible states, pinned because the status check is the rule, not a side effect of the codes.
			{ status: "claimed", failureCode: "provider_timeout", attemptCount: 1 },
			{
				status: "delivered",
				verdict: "finished",
				why: "done",
				failureCode: "provider_timeout",
				attemptCount: 1,
			},
			{ status: "suppressed", failureCode: "provider_timeout", attemptCount: 1 },
			{ status: "failed", failureCode: "parse", attemptCount: 1 },
			{ status: "failed", failureCode: "citation", attemptCount: 1 },
			{ status: "failed", failureCode: "suspect_text", attemptCount: 1 },
			{ status: "failed", failureCode: "length", attemptCount: 1 },
			{ status: "failed", failureCode: "refusal", attemptCount: 1 },
			{ status: "failed", failureCode: "empty_output", attemptCount: 1 },
			{ status: "failed", failureCode: "spend_cap", attemptCount: 1 },
			{ status: "failed", failureCode: "provider_timeout", attemptCount: 2 },
			{ status: "delivered", verdict: "finished", why: "done" },
			{ status: "suppressed", failureCode: "stale" },
		];
		for (const over of cases) {
			const sessionId = await freshSession();
			const id = await plant(sessionId, "p:1", over);
			const before = await rowOf(id);
			expect(
				await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 3 }),
				JSON.stringify(over),
			).toEqual({
				claimed: false,
			});
			expect(await rowOf(id)).toEqual(before);
		}
	});

	test("a session's reports are removed with the session (cascade)", async () => {
		const sessionId = await freshSession();
		await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 1 });
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
		expect(await getDb().select().from(aiWatcherReports)).toEqual([]);
	});
});

describe("settling a claim", () => {
	const usage = { providerId: "prov", tokensIn: 100, tokensOut: 20, costCents: 3 };

	test("completeReport makes the claimed row the delivered report, once", async () => {
		const sessionId = await freshSession();
		const claim = await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 1 });
		if (!claim.claimed) throw new Error("not claimed");
		const input = {
			id: claim.id,
			verdict: "stuck" as const,
			why: "It loops.",
			evidenceIds: ["E4"],
			throughEventId: 40,
			...usage,
		};
		expect(await reports.completeReport(input)).toBe(true);
		expect(await rowOf(claim.id)).toMatchObject({
			status: "delivered",
			verdict: "stuck",
			why: "It loops.",
			evidenceIds: ["E4"],
			throughEventId: 40,
			tokensIn: 100,
			tokensOut: 20,
			costCents: 3,
		});
		expect(await reports.completeReport(input)).toBe(false);
	});

	test("fail and suppress act on a claimed row only, and keep the usage", async () => {
		const sessionId = await freshSession();
		const a = await reports.claimReport({ sessionId, turnKey: "p:1", triggerEventId: 1 });
		const b = await reports.claimReport({ sessionId, turnKey: "p:2", triggerEventId: 2 });
		if (!a.claimed || !b.claimed) throw new Error("not claimed");
		await reports.failReport(a.id, "parse", usage);
		await reports.suppressReport(b.id, "stale", usage);
		expect(await rowOf(a.id)).toMatchObject({
			status: "failed",
			failureCode: "parse",
			costCents: 3,
		});
		expect(await rowOf(b.id)).toMatchObject({
			status: "suppressed",
			failureCode: "stale",
			costCents: 3,
		});
		// A late write can't turn a settled row into something else.
		await reports.failReport(b.id, "length");
		await reports.suppressReport(a.id, "no_new_evidence");
		expect(await rowOf(a.id)).toMatchObject({ status: "failed", failureCode: "parse" });
		expect(await rowOf(b.id)).toMatchObject({ status: "suppressed", failureCode: "stale" });
	});
});

describe("the evidence watermark moves only with a delivered report", () => {
	test("L6: delivered through 10, then a suppressed report through nothing: the next run starts after 10", async () => {
		const sessionId = await freshSession();
		expect(await reports.lastDeliveredThrough(sessionId)).toBe(0);
		await plant(sessionId, "p:1", {
			status: "delivered",
			verdict: "finished",
			why: "x",
			throughEventId: 10,
		});
		await plant(sessionId, "p:2", {
			status: "suppressed",
			failureCode: "stale",
			triggerEventId: 25,
			createdAt: ago(60_000),
		});
		await plant(sessionId, "p:3", {
			status: "failed",
			failureCode: "parse",
			triggerEventId: 30,
			throughEventId: 30,
		});
		expect(await reports.lastDeliveredThrough(sessionId)).toBe(10);
		await plant(sessionId, "p:4", {
			status: "delivered",
			verdict: "stuck",
			why: "y",
			throughEventId: 44,
		});
		expect(await reports.lastDeliveredThrough(sessionId)).toBe(44);
	});

	test("it is per session", async () => {
		const a = await freshSession();
		const b = await freshSession();
		await plant(a, "p:1", {
			status: "delivered",
			verdict: "finished",
			why: "x",
			throughEventId: 99,
		});
		expect(await reports.lastDeliveredThrough(b)).toBe(0);
	});
});

describe("timing and counts", () => {
	test("lastReportCreatedAt is the newest row of any status, or null", async () => {
		const sessionId = await freshSession();
		expect(await reports.lastReportCreatedAt(sessionId)).toBeNull();
		await plant(sessionId, "p:1", { status: "delivered", createdAt: ago(600_000) });
		const newest = Date.now() - 20_000;
		await plant(sessionId, "p:2", {
			status: "failed",
			failureCode: "parse",
			createdAt: new Date(newest).toISOString(),
		});
		expect(await reports.lastReportCreatedAt(sessionId)).toBe(newest);
	});

	test("markTelegram stamps the time for sent only", async () => {
		const sessionId = await freshSession();
		const id = await plant(sessionId, "p:1", { status: "delivered" });
		const at = new Date("2026-10-01T10:00:00.000Z");
		await reports.markTelegram(id, "sent", at);
		expect(await rowOf(id)).toMatchObject({
			telegramStatus: "sent",
			telegramSentAt: at.toISOString(),
		});
		await reports.markTelegram(id, "skipped_rate_limit");
		expect(await rowOf(id)).toMatchObject({
			telegramStatus: "skipped_rate_limit",
			telegramSentAt: null,
		});
	});

	test("lastRoutineSentAt is the newest report actually sent to Telegram", async () => {
		const sessionId = await freshSession();
		expect(await reports.lastRoutineSentAt(sessionId)).toBeNull();
		const older = Date.now() - 30 * 60_000;
		const newer = Date.now() - 4 * 60_000;
		await plant(sessionId, "p:1", {
			status: "delivered",
			telegramStatus: "sent",
			telegramSentAt: new Date(older).toISOString(),
		});
		await plant(sessionId, "p:2", {
			status: "delivered",
			telegramStatus: "sent",
			telegramSentAt: new Date(newer).toISOString(),
		});
		await plant(sessionId, "p:3", {
			status: "delivered",
			telegramStatus: "skipped_rate_limit",
			telegramSentAt: null,
		});
		expect(await reports.lastRoutineSentAt(sessionId)).toBe(newer);
	});

	test("escalationsSentSince counts sent stuck and needs_you reports of this session in the window", async () => {
		const sessionId = await freshSession();
		const other = await freshSession();
		const sent = (minutesAgo: number) => ({
			status: "delivered",
			telegramStatus: "sent",
			telegramSentAt: ago(minutesAgo * 60_000),
		});
		await plant(sessionId, "p:1", { ...sent(10), verdict: "stuck" });
		await plant(sessionId, "p:2", { ...sent(20), verdict: "needs_you" });
		await plant(sessionId, "p:3", { ...sent(30), verdict: "finished" });
		await plant(sessionId, "p:4", { ...sent(90), verdict: "needs_you" });
		await plant(sessionId, "p:5", {
			status: "delivered",
			telegramStatus: "skipped_rate_limit",
			verdict: "stuck",
		});
		await plant(other, "p:1", { ...sent(5), verdict: "stuck" });
		expect(await reports.escalationsSentSince(sessionId, Date.now() - 60 * 60_000)).toBe(2);
		expect(await reports.escalationsSentSince(sessionId, Date.now() - 120 * 60_000)).toBe(3);
	});
});

describe("listings", () => {
	test("listReportsForSession is newest first, limited, and per session", async () => {
		const sessionId = await freshSession();
		const other = await freshSession();
		for (let i = 0; i < 12; i += 1) {
			await plant(sessionId, `p:${i}`, {
				status: "delivered",
				verdict: "finished",
				why: `n${i}`,
				createdAt: ago((20 - i) * 60_000),
			});
		}
		await plant(other, "p:1", { status: "delivered" });
		const list = await reports.listReportsForSession(sessionId, 10);
		expect(list).toHaveLength(10);
		expect(list[0]?.turnKey).toBe("p:11");
		expect(list.every((r) => r.sessionId === sessionId)).toBe(true);
		expect(list[0]).toEqual(
			expect.objectContaining({
				verdict: "finished",
				status: "delivered",
				failureCode: null,
				telegramStatus: null,
			}),
		);
	});
});
