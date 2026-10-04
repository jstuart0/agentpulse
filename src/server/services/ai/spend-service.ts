import { and, eq, sql } from "drizzle-orm";
import { type Db, getDb } from "../../db/client.js";
import { aiDailySpend, sessions } from "../../db/schema/index.js";

function today(): string {
	// YYYY-MM-DD in local server timezone (matches what UI shows).
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Get today's total spend for a user (cents). */
export async function getTodaySpendCents(userId = "local"): Promise<number> {
	const date = today();
	const [row] = await getDb()
		.select()
		.from(aiDailySpend)
		.where(and(eq(aiDailySpend.userId, userId), eq(aiDailySpend.date, date)))
		.limit(1);
	return row?.spendCents ?? 0;
}

/**
 * Atomically add spend to the (user, date) row. Upserts on conflict.
 */
export async function addSpendCents(
	sessionId: string,
	cents: number,
	userId = "local",
): Promise<void> {
	if (cents <= 0) return;
	const date = today();
	const now = new Date().toISOString();

	await getDb()
		.insert(aiDailySpend)
		.values({ userId, date, spendCents: cents, updatedAt: now })
		.onConflictDoUpdate({
			target: [aiDailySpend.userId, aiDailySpend.date],
			set: {
				spendCents: sql`${aiDailySpend.spendCents} + ${cents}`,
				updatedAt: now,
			},
		});

	// Track per-session running spend for UI.
	await getDb()
		.update(sessions)
		.set({ aiSpendCents: sql`${sessions.aiSpendCents} + ${cents}` })
		.where(eq(sessions.sessionId, sessionId));
}

/**
 * Record spend that isn't attributable to a specific session (e.g. the
 * launch-intent classifier runs before a session exists). Only updates the
 * daily spend table; does NOT touch sessions.ai_spend_cents.
 */
export async function addGlobalSpendCents(cents: number, userId = "local"): Promise<void> {
	if (cents <= 0) return;
	const date = today();
	const now = new Date().toISOString();
	await getDb()
		.insert(aiDailySpend)
		.values({ userId, date, spendCents: cents, updatedAt: now })
		.onConflictDoUpdate({
			target: [aiDailySpend.userId, aiDailySpend.date],
			set: {
				spendCents: sql`${aiDailySpend.spendCents} + ${cents}`,
				updatedAt: now,
			},
		});
}

export const DEFAULT_DAILY_CAP_CENTS = 500; // $5/day per plan

export interface SpendCheck {
	allowed: boolean;
	spent: number;
	cap: number;
	reason?: string;
}

/**
 * Pre-flight: does the user have budget left today? The caller passes their
 * own per-session override via `perSessionCapCents` (from watcher_configs).
 * The effective cap is the smaller of the two.
 */
export async function checkSpendBudget(
	userId = "local",
	perSessionCapCents?: number | null,
	// Passing a non-zero value lets us also reject if the *next* call would
	// push us over (caller estimates expected max cost).
	expectedCostCents = 0,
): Promise<SpendCheck> {
	const spent = await getTodaySpendCents(userId);
	const globalCap = DEFAULT_DAILY_CAP_CENTS;
	const cap =
		perSessionCapCents && perSessionCapCents > 0
			? Math.min(globalCap, perSessionCapCents)
			: globalCap;
	if (spent + expectedCostCents >= cap) {
		return {
			allowed: false,
			spent,
			cap,
			reason: `Daily AI spend cap reached ($${(cap / 100).toFixed(2)}). Resumes tomorrow.`,
		};
	}
	return { allowed: true, spent, cap };
}

/**
 * Spend reservation (AGEN-69, D-8, D-26, D-27).
 *
 * A generation sets its worst-case cost aside before it runs, so concurrent
 * generations can never push the day past the cap together, then settles at
 * the real cost or returns everything. A reservation remembers the date it was
 * made on: settle, release and top-up act on that date's row, never on a fresh
 * "today", so a run that straddles midnight cannot touch the new day. A day
 * row is never taken below zero. Each reservation is single-use.
 */
export interface SpendReservation {
	date: string;
	cents: number;
}

const LOCAL_USER = "local";

/** Reservations already settled or released; consumed synchronously, once. */
const consumedReservations = new WeakSet<SpendReservation>();

/** Adds `cents` to the date's row only if the total stays strictly under the cap. */
async function addUnderCap(date: string, cents: number, db: Db): Promise<boolean> {
	const rows = await db
		.update(aiDailySpend)
		.set({
			spendCents: sql`${aiDailySpend.spendCents} + ${cents}`,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(aiDailySpend.userId, LOCAL_USER),
				eq(aiDailySpend.date, date),
				sql`${aiDailySpend.spendCents} + ${cents} < ${DEFAULT_DAILY_CAP_CENTS}`,
			),
		)
		.returning({ spendCents: aiDailySpend.spendCents });
	return rows.length > 0;
}

/** Moves the date's row by `delta` (never below zero); never creates a row. */
async function adjustDay(date: string, delta: number): Promise<void> {
	if (delta === 0) return;
	await getDb()
		.update(aiDailySpend)
		.set({
			spendCents: sql`CASE WHEN ${aiDailySpend.spendCents} + ${delta} < 0 THEN 0 ELSE ${aiDailySpend.spendCents} + ${delta} END`,
			updatedAt: new Date().toISOString(),
		})
		.where(and(eq(aiDailySpend.userId, LOCAL_USER), eq(aiDailySpend.date, date)));
}

/**
 * Sets `cents` aside against today's cap in one conditional statement, or
 * returns null when it would not fit (a total of cap - 1 fits, cap does not).
 * Zero cents (a free provider) is a reservation that writes nothing, even when
 * the day is at the cap. `db` is for tests that need a second connection.
 */
export async function reserveSpendCents(
	cents: number,
	db: Db = getDb(),
): Promise<SpendReservation | null> {
	const date = today();
	if (cents <= 0) return { date, cents: 0 };
	await db
		.insert(aiDailySpend)
		.values({
			userId: LOCAL_USER,
			date,
			spendCents: 0,
			updatedAt: new Date().toISOString(),
		})
		.onConflictDoNothing();
	return (await addUnderCap(date, cents, db)) ? { date, cents } : null;
}

/**
 * Grows an open reservation by `extraCents` against the reserved date's cap,
 * atomically. A refused top-up (or one on a spent reservation) leaves the
 * reservation and the row unchanged.
 */
export async function topUpReservation(
	reservation: SpendReservation,
	extraCents: number,
): Promise<boolean> {
	if (consumedReservations.has(reservation)) return false;
	if (extraCents <= 0) return true;
	if (!(await addUnderCap(reservation.date, extraCents, getDb()))) return false;
	reservation.cents += extraCents;
	return true;
}

/**
 * Settles a reservation at the real cost: the reserved date's row moves by
 * `actual - reserved` and the real cost is added to the session's running
 * spend. A session deleted in the meantime is not an error.
 */
export async function settleReservedSpend(
	reservation: SpendReservation,
	{ sessionId, actualCents }: { sessionId: string; actualCents: number },
): Promise<void> {
	if (consumedReservations.has(reservation)) return;
	consumedReservations.add(reservation);
	await adjustDay(reservation.date, actualCents - reservation.cents);
	if (actualCents > 0) {
		await getDb()
			.update(sessions)
			.set({ aiSpendCents: sql`${sessions.aiSpendCents} + ${actualCents}` })
			.where(eq(sessions.sessionId, sessionId));
	}
}

/** Returns a whole reservation to the reserved date's row. */
export async function releaseReservedSpend(reservation: SpendReservation): Promise<void> {
	if (consumedReservations.has(reservation)) return;
	consumedReservations.add(reservation);
	await adjustDay(reservation.date, -reservation.cents);
}
