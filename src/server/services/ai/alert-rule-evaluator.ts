import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { aiQaCache, projectAlertRuleFires, projectAlertRules, sessions } from "../../db/schema.js";
import { intelligenceForSession } from "./intelligence-service.js";

// ---- Shared notification dispatch ------------------------------------------

/**
 * Send a Telegram alert for a fired rule. Called only after a fire row has
 * been successfully inserted — the insert is the de-bounce gate.
 *
 * Logs only rule.id and trigger at info level to avoid leaking session content
 * or rule condition text into production logs.
 */
export async function dispatchAlertRuleNotification(
	rule: typeof projectAlertRules.$inferSelect,
	sessionId: string,
	sessionName: string | null,
	trigger: "stuck" | "no_activity" | "failed" | "completed" | "freeform",
): Promise<void> {
	const label = sessionName ?? sessionId;
	console.log(`[alert-rule] rule ${rule.id} fired: session "${label}" trigger=${trigger}`);

	if (!rule.channelId) return;

	const { getTelegramBotToken } = await import("../channels/telegram-credentials.js");
	const { getChannelCredential } = await import("../channels/channels-service.js");
	const token = getTelegramBotToken();
	if (!token) return;

	const cred = await getChannelCredential(rule.channelId).catch(() => null);
	if (!cred?.chatId) return;

	const triggerText: Record<typeof trigger, string> = {
		stuck: "appears stuck",
		no_activity: "has had no activity",
		failed: "failed",
		completed: "completed",
		freeform: "matched a freeform condition",
	};

	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: cred.chatId,
			text: `Alert: Session "${label}" ${triggerText[trigger]}. (Project alert rule fired.)`,
		}),
	}).catch(() => {
		// best-effort; delivery failure must not block the sweep
	});
}

// ---- Event-transition evaluator (moved from event-processor.ts) -------------

/**
 * Evaluate project-level alert rules after a session status transition.
 *
 * Matches active rules where rule.projectId === session.projectId and
 * rule.ruleType === "status_<newStatus>". Sessions without a projectId
 * never match (no cwd-prefix fallback needed; Phase 1 stamps projectId).
 *
 * De-bounce: a (rule_id, session_id) pair fires at most once. The UNIQUE
 * constraint on project_alert_rule_fires serialises concurrent writes so
 * a duplicate INSERT simply throws and is silently ignored. This means
 * a rule fires exactly once per session lifetime for status transitions
 * (status_failed/completed are terminal; status_stuck may repeat but the
 * constraint prevents back-to-back fires for the same session).
 */
export async function evaluateAlertRules(
	sessionId: string,
	newStatus: "failed" | "completed",
): Promise<void> {
	const [session] = await db
		.select({ projectId: sessions.projectId, displayName: sessions.displayName })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);

	if (!session?.projectId) return;

	const matchingRules = await db
		.select()
		.from(projectAlertRules)
		.where(
			and(
				eq(projectAlertRules.projectId, session.projectId),
				eq(projectAlertRules.ruleType, `status_${newStatus}`),
				eq(projectAlertRules.isActive, true),
			),
		);

	for (const rule of matchingRules) {
		try {
			await db.insert(projectAlertRuleFires).values({
				ruleId: rule.id,
				sessionId,
				firedAt: new Date().toISOString(),
			});
		} catch {
			// Unique constraint violation = already fired for this session; skip.
			continue;
		}

		await dispatchAlertRuleNotification(rule, sessionId, session.displayName, newStatus);
	}
}

// ---- Q&A cache purge -------------------------------------------------------

/**
 * Delete expired ai_qa_cache rows. Runs on the 60-second alert-rule sweep
 * tick so no separate interval is needed. A 15-minute TTL means rows linger
 * at most 60 seconds beyond expiry before this cleans them up.
 */
export async function purgeExpiredQaCache(now: Date): Promise<void> {
	const cutoff = now.toISOString();
	await db.delete(aiQaCache).where(sql`${aiQaCache.expiresAt} < ${cutoff}`);
}

// ---- Periodic sweep evaluators ---------------------------------------------

/**
 * For each active status_stuck rule, classify sessions in the rule's project.
 * A fire row is inserted when intelligence returns health === "stuck". The
 * UNIQUE constraint on (rule_id, session_id) deduplicates across sweep ticks
 * so a session fires at most once per rule lifetime.
 *
 * Per-session try/catch: a classifier failure or transient DB error must not
 * abort the rest of the sweep.
 */
export async function evaluateStuckRules(now: Date): Promise<void> {
	const stuckRules = await db
		.select()
		.from(projectAlertRules)
		.where(
			and(eq(projectAlertRules.ruleType, "status_stuck"), eq(projectAlertRules.isActive, true)),
		);

	if (stuckRules.length === 0) return;

	for (const rule of stuckRules) {
		const candidates = await db
			.select({
				sessionId: sessions.sessionId,
				displayName: sessions.displayName,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.projectId, rule.projectId),
					inArray(sessions.status, ["active", "idle"]),
					isNull(sessions.endedAt),
					eq(sessions.isArchived, false),
				),
			);

		for (const candidate of candidates) {
			let intel: Awaited<ReturnType<typeof intelligenceForSession>>;
			try {
				intel = await intelligenceForSession(candidate.sessionId, now);
			} catch {
				// Transient error — skip this session this tick, try again next sweep.
				continue;
			}

			if (!intel || intel.health !== "stuck") continue;

			try {
				await db.insert(projectAlertRuleFires).values({
					ruleId: rule.id,
					sessionId: candidate.sessionId,
					firedAt: now.toISOString(),
				});
			} catch {
				// UNIQUE violation — already fired for this (rule, session); skip.
				continue;
			}

			await dispatchAlertRuleNotification(
				rule,
				candidate.sessionId,
				candidate.displayName,
				"stuck",
			);
		}
	}
}

/**
 * For each active no_activity_minutes rule, find sessions that have had no
 * new events since the threshold duration.
 *
 * Filter: endedAt IS NULL (not isWorking = false) — sessions where the agent
 * emitted Stop but hasn't started a new task are idle-but-not-ended and must
 * still be caught by this rule.
 */
export async function evaluateNoActivityRules(now: Date): Promise<void> {
	const rules = await db
		.select()
		.from(projectAlertRules)
		.where(
			and(
				eq(projectAlertRules.ruleType, "no_activity_minutes"),
				eq(projectAlertRules.isActive, true),
			),
		);

	if (rules.length === 0) return;

	for (const rule of rules) {
		const threshold = (rule.params as { thresholdMinutes?: number } | null)?.thresholdMinutes;
		if (!threshold || threshold <= 0) continue;

		const cutoff = new Date(now.getTime() - threshold * 60_000).toISOString();

		const candidates = await db
			.select({
				sessionId: sessions.sessionId,
				displayName: sessions.displayName,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.projectId, rule.projectId),
					isNull(sessions.endedAt),
					eq(sessions.isArchived, false),
					sql`${sessions.lastActivityAt} < ${cutoff}`,
				),
			);

		for (const candidate of candidates) {
			try {
				await db.insert(projectAlertRuleFires).values({
					ruleId: rule.id,
					sessionId: candidate.sessionId,
					firedAt: now.toISOString(),
				});
			} catch {
				// UNIQUE violation — already fired for this (rule, session); skip.
				continue;
			}

			await dispatchAlertRuleNotification(
				rule,
				candidate.sessionId,
				candidate.displayName,
				"no_activity",
			);
		}
	}
}
