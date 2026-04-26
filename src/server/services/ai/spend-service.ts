import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { aiDailySpend, sessions } from "../../db/schema.js";

function today(): string {
	// YYYY-MM-DD in local server timezone (matches what UI shows).
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Get today's total spend for a user (cents). */
export async function getTodaySpendCents(userId = "local"): Promise<number> {
	const date = today();
	const [row] = await db
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

	await db
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
	await db
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
	await db
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

const DEFAULT_DAILY_CAP_CENTS = 500; // $5/day per plan

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
