/**
 * AGEN-69 phase 2a: the spend reservation API (TC-2.13 to TC-2.22).
 *
 * Real database on both dialects, nothing stubbed. A reservation is
 * `{ date, cents }`: settle, release and top-up act on that date's row, a day
 * row never goes below zero, and a reservation is single-use (D-8, D-26, D-27).
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";
import { itPostgresOnly } from "../../test-utils/backend.js";
import "./__test_db.js";

const { config } = await import("../../config.js");
const { getDb, initializeDatabase, PG_CONNECTION_OPTIONS } = await import("../../db/client.js");
const { aiDailySpend, sessions } = await import("../../db/schema/index.js");
const { countDbCalls } = await import("../../test-utils/db-call-counter.js");
const spend = await import("./spend-service.js");
const {
	DEFAULT_DAILY_CAP_CENTS: CAP,
	addSpendCents,
	checkSpendBudget,
	getTodaySpendCents,
	releaseReservedSpend,
	reserveSpendCents,
	settleReservedSpend,
	topUpReservation,
} = spend;

await initializeDatabase();

const SESSION = "spend-res-session";
const SENTINEL_UPDATED_AT = "2000-01-01T00:00:00.000Z";

function localDate(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayLocal = () => localDate(new Date());

async function dayRow(date: string): Promise<number | undefined> {
	const [row] = await getDb().select().from(aiDailySpend).where(eq(aiDailySpend.date, date));
	return row?.spendCents;
}
async function dayRowUpdatedAt(date: string): Promise<string | undefined> {
	const [row] = await getDb().select().from(aiDailySpend).where(eq(aiDailySpend.date, date));
	return row ? String(row.updatedAt) : undefined;
}
async function setDay(date: string, cents: number): Promise<void> {
	await getDb().delete(aiDailySpend).where(eq(aiDailySpend.date, date));
	await getDb()
		.insert(aiDailySpend)
		.values({ userId: "local", date, spendCents: cents, updatedAt: SENTINEL_UPDATED_AT });
}
async function sessionSpend(): Promise<number | undefined> {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, SESSION));
	return row?.aiSpendCents;
}
async function allDayRows(): Promise<Array<{ date: string; cents: number }>> {
	const rows = await getDb().select().from(aiDailySpend);
	return rows
		.map((r) => ({ date: r.date, cents: r.spendCents }))
		.sort((a, b) => a.date.localeCompare(b.date));
}

beforeEach(async () => {
	setSystemTime();
	await getDb().delete(aiDailySpend).execute();
	await getDb().delete(sessions).where(eq(sessions.sessionId, SESSION)).execute();
	await getDb().insert(sessions).values({ sessionId: SESSION, agentType: "claude_code" });
});
afterEach(async () => {
	setSystemTime();
	await getDb().delete(aiDailySpend).execute();
	await getDb().delete(sessions).where(eq(sessions.sessionId, SESSION)).execute();
});

/** A whole-second local time, as the day-rollover tests need (contract C-4). */
const AT_END_OF_DAY = new Date(2031, 2, 14, 23, 59, 59, 0);
const AFTER_MIDNIGHT = new Date(2031, 2, 15, 0, 0, 2, 0);
const DAY_D = "2031-03-14";
const DAY_NEXT = "2031-03-15";

describe("TC-2.13 reserveSpendCents and topUpReservation at the edge", () => {
	test("TC-2.13 returns { date, cents } for today and writes the row", async () => {
		const r = await reserveSpendCents(50);
		expect(r).toEqual({ date: todayLocal(), cents: 50 });
		expect(await dayRow(todayLocal())).toBe(50);
	});

	test("TC-2.13 spent cap - c - 1 succeeds (the day total is cap - 1)", async () => {
		const c = 50;
		await setDay(todayLocal(), CAP - c - 1);
		const r = await reserveSpendCents(c);
		expect(r).not.toBeNull();
		expect(await dayRow(todayLocal())).toBe(CAP - 1);
	});

	test("TC-2.13 spent cap - c and spent cap refuse and write nothing", async () => {
		const c = 50;
		for (const spent of [CAP - c, CAP]) {
			await setDay(todayLocal(), spent);
			expect(await reserveSpendCents(c)).toBeNull();
			expect(await dayRow(todayLocal())).toBe(spent);
			expect(await dayRowUpdatedAt(todayLocal())).toBe(SENTINEL_UPDATED_AT);
		}
	});

	test("TC-2.13 a refused reservation on a day with no row leaves a zero row at most, never spend", async () => {
		expect(await reserveSpendCents(CAP)).toBeNull();
		expect((await dayRow(todayLocal())) ?? 0).toBe(0);
	});

	test("TC-2.13 topUpReservation is the same conditional statement against the reserved date and grows cents", async () => {
		await setDay(todayLocal(), 400);
		const r = await reserveSpendCents(50);
		expect(r).not.toBeNull();
		if (!r) return;
		expect(await dayRow(todayLocal())).toBe(450);
		expect(await topUpReservation(r, 49)).toBe(true);
		expect(r.cents).toBe(99);
		expect(await dayRow(todayLocal())).toBe(499);
	});

	test("TC-2.13 a refused top-up leaves the reservation and the row unchanged", async () => {
		await setDay(todayLocal(), 400);
		const r = await reserveSpendCents(50);
		if (!r) throw new Error("expected a reservation");
		expect(await topUpReservation(r, 50)).toBe(false);
		expect(r.cents).toBe(50);
		expect(await dayRow(todayLocal())).toBe(450);
	});

	test("TC-2.13 concurrent top-ups are atomic: room for exactly 3 of 8", async () => {
		await setDay(todayLocal(), 100);
		const r = await reserveSpendCents(50); // day 150, room for 3 more of 100 below 500? 150 + 3*100 = 450
		if (!r) throw new Error("expected a reservation");
		const results = await Promise.all(Array.from({ length: 8 }, () => topUpReservation(r, 100)));
		expect(results.filter(Boolean)).toHaveLength(3);
		expect(await dayRow(todayLocal())).toBe(450);
	});
});

describe("TC-2.14 concurrent reservations", () => {
	test("TC-2.14 8 concurrent with room for exactly 3: exactly 3 succeed, 20 rounds, the total never exceeds cap - 1", async () => {
		for (let round = 0; round < 20; round++) {
			await setDay(todayLocal(), 150); // 150 + 3 * 100 = 450 < 500, a fourth makes 550
			const results = await Promise.all(Array.from({ length: 8 }, () => reserveSpendCents(100)));
			expect(results.filter((r) => r !== null)).toHaveLength(3);
			const total = (await dayRow(todayLocal())) as number;
			expect(total).toBe(450);
			expect(total).toBeLessThanOrEqual(CAP - 1);
		}
	});

	test("TC-2.14 the same with no row for today yet (first-of-day insert race), 20 rounds", async () => {
		for (let round = 0; round < 20; round++) {
			await getDb().delete(aiDailySpend).execute();
			const results = await Promise.all(Array.from({ length: 8 }, () => reserveSpendCents(125)));
			expect(results.filter((r) => r !== null)).toHaveLength(3); // 375 < 500, a fourth makes 500
			expect(await dayRow(todayLocal())).toBe(375);
			expect(await allDayRows()).toHaveLength(1);
		}
	});
});

describe("TC-2.15 two independent connections (Postgres)", () => {
	itPostgresOnly(
		"TC-2.15 two max:1 clients with a barrier, 20 rounds: the cap holds across connections",
		async () => {
			const { default: postgres } = await import("postgres");
			const { drizzle } = await import("drizzle-orm/postgres-js");
			const url = config.databaseUrl;
			const clientA = postgres(url, { max: 1, idle_timeout: 10, ...PG_CONNECTION_OPTIONS });
			const clientB = postgres(url, { max: 1, idle_timeout: 10, ...PG_CONNECTION_OPTIONS });
			const dbA = drizzle(clientA) as unknown as ReturnType<typeof getDb>;
			const dbB = drizzle(clientB) as unknown as ReturnType<typeof getDb>;
			try {
				for (let round = 0; round < 20; round++) {
					const seeded = round % 2 === 0;
					if (seeded) await setDay(todayLocal(), 100);
					else await getDb().delete(aiDailySpend).execute();
					let go!: () => void;
					const barrier = new Promise<void>((resolve) => {
						go = resolve;
					});
					const attempt = async (db: ReturnType<typeof getDb>) => {
						await barrier;
						return reserveSpendCents(150, db);
					};
					const all = [attempt(dbA), attempt(dbB), attempt(dbA), attempt(dbB)];
					go();
					const results = await Promise.all(all);
					const wins = results.filter((r) => r !== null).length;
					expect(wins).toBe(seeded ? 2 : 3); // 100+150+150=400 | 150*3=450; one more would be >= 500
					expect(await dayRow(todayLocal())).toBe(seeded ? 400 : 450);
				}
			} finally {
				await clientA.end({ timeout: 2 });
				await clientB.end({ timeout: 2 });
			}
		},
	);
});

describe("TC-2.16 settle", () => {
	async function reserved(base: number, cents: number) {
		await setDay(todayLocal(), base);
		const r = await reserveSpendCents(cents);
		if (!r) throw new Error("expected a reservation");
		return r;
	}

	test("TC-2.16 actual below reserved lowers the reserved day by the difference", async () => {
		const r = await reserved(100, 100);
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 60 });
		expect(await dayRow(todayLocal())).toBe(160);
		expect(await sessionSpend()).toBe(60);
	});

	test("TC-2.16 actual above reserved raises it", async () => {
		const r = await reserved(100, 100);
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 130 });
		expect(await dayRow(todayLocal())).toBe(230);
		expect(await sessionSpend()).toBe(130);
	});

	test("TC-2.16 actual equal to reserved changes nothing", async () => {
		const r = await reserved(100, 100);
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 100 });
		expect(await dayRow(todayLocal())).toBe(200);
		expect(await sessionSpend()).toBe(100);
	});

	test("TC-2.16 settle at 0 returns the whole reservation", async () => {
		const r = await reserved(100, 100);
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 0 });
		expect(await dayRow(todayLocal())).toBe(100);
		expect(await sessionSpend()).toBe(0);
	});

	test("TC-2.16 a deleted session adjusts the daily row and does not throw", async () => {
		const r = await reserved(100, 100);
		await getDb().delete(sessions).where(eq(sessions.sessionId, SESSION));
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 40 });
		expect(await dayRow(todayLocal())).toBe(140);
	});

	test("TC-2.16 the day row is floored at 0, never negative", async () => {
		const r = await reserved(0, 100);
		await setDay(todayLocal(), 10); // the row was cleaned out from under the reservation
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 0 });
		expect(await dayRow(todayLocal())).toBe(0);
	});

	test("TC-2.16 settle never creates a row", async () => {
		const r = await reserved(0, 100);
		await getDb().delete(aiDailySpend).execute();
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 30 });
		expect(await allDayRows()).toEqual([]);
	});
});

describe("TC-2.17 release and single use", () => {
	async function reserved(base: number, cents: number) {
		await setDay(todayLocal(), base);
		const r = await reserveSpendCents(cents);
		if (!r) throw new Error("expected a reservation");
		return r;
	}

	test("TC-2.17 release subtracts the reservation from the reserved date's row", async () => {
		const r = await reserved(100, 70);
		expect(await dayRow(todayLocal())).toBe(170);
		await releaseReservedSpend(r);
		expect(await dayRow(todayLocal())).toBe(100);
		expect(await sessionSpend()).toBe(0);
	});

	test("TC-2.17 release floors the row at 0", async () => {
		const r = await reserved(0, 70);
		await setDay(todayLocal(), 10);
		await releaseReservedSpend(r);
		expect(await dayRow(todayLocal())).toBe(0);
	});

	test("TC-2.17 a second release is a no-op", async () => {
		const r = await reserved(100, 70);
		await releaseReservedSpend(r);
		await releaseReservedSpend(r);
		expect(await dayRow(todayLocal())).toBe(100);
	});

	test("TC-2.17 a second settle is a no-op", async () => {
		const r = await reserved(100, 70);
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 20 });
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 20 });
		expect(await dayRow(todayLocal())).toBe(120);
		expect(await sessionSpend()).toBe(20);
	});

	test("TC-2.17 a settle after a release is a no-op, and so is a release after a settle", async () => {
		const a = await reserved(100, 70);
		await releaseReservedSpend(a);
		await settleReservedSpend(a, { sessionId: SESSION, actualCents: 50 });
		expect(await dayRow(todayLocal())).toBe(100);
		expect(await sessionSpend()).toBe(0);

		const b = await reserved(100, 70);
		await settleReservedSpend(b, { sessionId: SESSION, actualCents: 50 });
		await releaseReservedSpend(b);
		expect(await dayRow(todayLocal())).toBe(150);
	});

	test("TC-2.17 a top-up after settle or release is refused", async () => {
		const r = await reserved(100, 70);
		await releaseReservedSpend(r);
		expect(await topUpReservation(r, 10)).toBe(false);
		expect(await dayRow(todayLocal())).toBe(100);
	});

	test("TC-2.17 concurrent settle and release act once", async () => {
		const r = await reserved(100, 70);
		await Promise.all([
			settleReservedSpend(r, { sessionId: SESSION, actualCents: 20 }),
			releaseReservedSpend(r),
			settleReservedSpend(r, { sessionId: SESSION, actualCents: 20 }),
		]);
		const day = (await dayRow(todayLocal())) as number;
		expect([100, 120]).toContain(day); // whichever won, exactly one acted
	});
});

describe("TC-2.18 day rollover acts on the reserved date", () => {
	async function reserveBeforeMidnight(base = 0, cents = 100) {
		setSystemTime(AT_END_OF_DAY);
		await setDay(DAY_D, base);
		const r = await reserveSpendCents(cents);
		if (!r) throw new Error("expected a reservation");
		expect(r.date).toBe(DAY_D);
		setSystemTime(AFTER_MIDNIGHT);
		expect(todayLocal()).toBe(DAY_NEXT);
		return r;
	}

	test("TC-2.18 settle after midnight acts on day D and creates no row for D+1", async () => {
		const r = await reserveBeforeMidnight();
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 40 });
		expect(await dayRow(DAY_D)).toBe(40);
		expect(await dayRow(DAY_NEXT)).toBeUndefined();
	});

	test("TC-2.18 release after midnight acts on day D and creates no row for D+1", async () => {
		const r = await reserveBeforeMidnight(30, 100);
		await releaseReservedSpend(r);
		expect(await dayRow(DAY_D)).toBe(30);
		expect(await dayRow(DAY_NEXT)).toBeUndefined();
	});

	test("TC-2.18 top-up after midnight acts on day D and creates no row for D+1", async () => {
		const r = await reserveBeforeMidnight(0, 100);
		expect(await topUpReservation(r, 25)).toBe(true);
		expect(r.cents).toBe(125);
		expect(await dayRow(DAY_D)).toBe(125);
		expect(await dayRow(DAY_NEXT)).toBeUndefined();
	});

	test("TC-2.18 a top-up refused on day D is judged against day D's total, not D+1's", async () => {
		const r = await reserveBeforeMidnight(350, 100); // day D is 450; D+1 is empty
		expect(await topUpReservation(r, 60)).toBe(false);
		expect(await dayRow(DAY_D)).toBe(450);
		expect(await dayRow(DAY_NEXT)).toBeUndefined();
	});

	test("TC-2.18 the day row stays floored at 0 after rollover", async () => {
		const r = await reserveBeforeMidnight(0, 100);
		await setDay(DAY_D, 10);
		await settleReservedSpend(r, { sessionId: SESSION, actualCents: 0 });
		expect(await dayRow(DAY_D)).toBe(0);
	});
});

describe("TC-2.19 a reservation after rollover starts from a zero day", () => {
	test("TC-2.19 day D+1 is seen at 0 spent", async () => {
		setSystemTime(AT_END_OF_DAY);
		await setDay(DAY_D, CAP - 1);
		expect(await reserveSpendCents(10)).toBeNull();
		setSystemTime(AFTER_MIDNIGHT);
		expect(await getTodaySpendCents()).toBe(0);
		const r = await reserveSpendCents(CAP - 1);
		expect(r).toEqual({ date: DAY_NEXT, cents: CAP - 1 });
		expect(await dayRow(DAY_NEXT)).toBe(CAP - 1);
		expect(await dayRow(DAY_D)).toBe(CAP - 1);
	});
});

describe("TC-2.20 a free provider writes nothing", () => {
	test("TC-2.20 reserving 0 issues no statement, with or without a row, including at the cap", async () => {
		for (const setup of ["no-row", "at-cap"] as const) {
			await getDb().delete(aiDailySpend).execute();
			if (setup === "at-cap") await setDay(todayLocal(), CAP);
			const got: { r: Awaited<ReturnType<typeof reserveSpendCents>> } = { r: null };
			const statements = await countDbCalls(async () => {
				got.r = await reserveSpendCents(0);
			});
			expect(statements).toBe(0);
			expect(got.r).toEqual({ date: todayLocal(), cents: 0 });
			if (setup === "no-row") expect(await allDayRows()).toEqual([]);
			else {
				expect(await dayRow(todayLocal())).toBe(CAP);
				expect(await dayRowUpdatedAt(todayLocal())).toBe(SENTINEL_UPDATED_AT);
			}
		}
	});

	test("TC-2.20 settling and releasing a zero reservation write nothing either", async () => {
		await setDay(todayLocal(), CAP);
		const r = await reserveSpendCents(0);
		if (!r) throw new Error("a free provider is never refused");
		const statements = await countDbCalls(async () => {
			await settleReservedSpend(r, { sessionId: SESSION, actualCents: 0 });
			await releaseReservedSpend(r);
		});
		expect(statements).toBe(0);
		expect(await dayRow(todayLocal())).toBe(CAP);
		expect(await sessionSpend()).toBe(0);
	});
});

describe("TC-2.21 one number", () => {
	test("TC-2.21 a reservation is visible to getTodaySpendCents and checkSpendBudget", async () => {
		await reserveSpendCents(100);
		expect(await getTodaySpendCents()).toBe(100);
		expect((await checkSpendBudget()).spent).toBe(100);
		await setDay(todayLocal(), 400);
		await reserveSpendCents(100); // 400 + 100 = 500 is refused, so still 400
		expect((await checkSpendBudget()).spent).toBe(400);
		await reserveSpendCents(99);
		const check = await checkSpendBudget();
		expect(check.spent).toBe(499);
		expect(check.allowed).toBe(true);
		expect((await checkSpendBudget("local", null, 1)).allowed).toBe(false);
	});

	test("TC-2.21 addSpendCents spend is visible to the next reservation", async () => {
		await addSpendCents(SESSION, 450);
		expect(await reserveSpendCents(50)).toBeNull();
		expect(await reserveSpendCents(49)).not.toBeNull();
		expect(await getTodaySpendCents()).toBe(499);
	});
});

describe("TC-2.22 ledger property", () => {
	function mulberry32(seed: number): () => number {
		let a = seed;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	test("TC-2.22 50 seeded random sequences across 2 days: each day row equals settled actuals plus open reservations", async () => {
		for (let seed = 1; seed <= 50; seed++) {
			await getDb().delete(aiDailySpend).execute();
			const rand = mulberry32(seed);
			const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
			setSystemTime(AT_END_OF_DAY);
			const expected = new Map<string, number>();
			const open: Array<{ date: string; cents: number }> = [];
			const rollAt = int(5, 25);
			for (let step = 0; step < 40; step++) {
				if (step === rollAt) setSystemTime(AFTER_MIDNIGHT);
				const op = int(0, 3);
				if (op === 0 || open.length === 0) {
					const r = await reserveSpendCents(int(0, 90));
					if (r) {
						open.push(r);
						expected.set(r.date, (expected.get(r.date) ?? 0) + r.cents);
					}
				} else {
					const i = int(0, open.length - 1);
					const r = open[i];
					if (op === 1) {
						const actual = int(0, 130);
						expected.set(r.date, (expected.get(r.date) ?? 0) + actual - r.cents);
						await settleReservedSpend(r, { sessionId: SESSION, actualCents: actual });
						open.splice(i, 1);
					} else if (op === 2) {
						expected.set(r.date, (expected.get(r.date) ?? 0) - r.cents);
						await releaseReservedSpend(r);
						open.splice(i, 1);
					} else {
						const extra = int(1, 60);
						if (await topUpReservation(r, extra)) {
							expected.set(r.date, (expected.get(r.date) ?? 0) + extra);
						}
					}
				}
				for (const [date, cents] of expected) {
					const actualRow = (await dayRow(date)) ?? 0;
					expect({ seed, step, date, cents: actualRow }).toEqual({ seed, step, date, cents });
				}
			}
			for (const r of open) await releaseReservedSpend(r);
		}
	}, 60_000);
});
