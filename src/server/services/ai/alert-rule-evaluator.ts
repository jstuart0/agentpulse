import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
	events,
	aiQaCache,
	projectAlertRuleFires,
	projectAlertRules,
	sessions,
} from "../../db/schema.js";
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

// ---- Freeform rule types ---------------------------------------------------

interface FreeformRuleParams {
	condition: string;
	dailyTokenBudget: number;
	sampleRate: number;
	eventTypesFilter: string[];
	debounceMinutes: number;
}

type ClassifyResult = { matched: boolean; error?: undefined } | { matched: false; error: string };

/**
 * LLM-based yes/no classifier for a single event against a freeform condition.
 *
 * Returns { matched: false, error } on LLM failure so the caller can skip
 * spend recording — billing only happens on a successful classification.
 * Event content is truncated to 500 chars before sending to the LLM to limit
 * accidental credential or secret exfiltration via the API call.
 */
async function classifyFreeformCondition(
	ruleId: string,
	condition: string,
	eventContent: string,
): Promise<ClassifyResult> {
	const { getDefaultProvider, getProviderApiKey, getProvider } = await import(
		"./providers-service.js"
	);
	const { getAdapter } = await import("./llm/registry.js");

	const provider = await getDefaultProvider();
	if (!provider) {
		return { matched: false, error: "No default LLM provider configured" };
	}
	const full = await getProvider(provider.id);
	if (!full) {
		return { matched: false, error: "Default LLM provider record missing" };
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return { matched: false, error: "LLM provider credentials unreadable" };
	}

	const adapter = getAdapter({ kind: full.kind, apiKey, baseUrl: full.baseUrl ?? undefined });
	const truncatedContent = eventContent.slice(0, 500);

	try {
		const res = await adapter.complete({
			systemPrompt: 'You are a yes/no event classifier. Answer only "yes" or "no".',
			transcriptPrompt: `Condition: ${condition}\nEvent text: ${truncatedContent}\n\nDoes the event text match the condition? Reply with "yes" or "no" only.`,
			model: full.model,
			maxTokens: 10,
			temperature: 0.0,
			timeoutMs: 8_000,
		});
		const answer = res.text.trim().toLowerCase();
		if (answer === "yes") return { matched: true };
		if (answer === "no") return { matched: false };
		// Unexpected response — treat as non-match but log at debug level only.
		console.debug(
			`[freeform-classifier] rule ${ruleId}: unexpected LLM response "${res.text.slice(0, 40)}"`,
		);
		return { matched: false, error: `Unexpected classifier response: ${res.text.slice(0, 40)}` };
	} catch (err) {
		console.info(`[freeform-classifier] rule ${ruleId}: LLM call failed`);
		return { matched: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Convert a Date to YYYY-MM-DD in server local time.
 * Daily reset uses local time — single-user homelab deployment.
 */
function toDateString(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Evaluate all active freeform_match rules. For each rule:
 *  1. Atomically reset the daily spend counter if the date rolled over.
 *  2. Skip the rule if today's budget is already exhausted.
 *  3. Fetch new events since the rule's cursor via a single JOIN query.
 *  4. Advance the cursor BEFORE the per-event sample-rate check so sampled-out
 *     events are never re-evaluated on the next sweep.
 *  5. Classify sampled events; fire on match (debounce-gated); record spend only
 *     on successful classification (not on LLM errors).
 *
 * Cap: at most 100 events per rule per sweep to prevent backlog budget blowout.
 */
export async function evaluateFreeformRules(now: Date): Promise<void> {
	const freeformRules = await db
		.select()
		.from(projectAlertRules)
		.where(
			and(eq(projectAlertRules.ruleType, "freeform_match"), eq(projectAlertRules.isActive, true)),
		);

	if (freeformRules.length === 0) return;

	// Snapshot the sweep-time max event id as the cursor upper bound.
	// This prevents mid-sweep events from being both evaluated AND left in the window.
	const [maxRow] = await db.select({ maxId: sql<number>`MAX(id)` }).from(events);
	const sweepMaxEventId = maxRow?.maxId;
	if (!sweepMaxEventId) return;

	const today = toDateString(now);

	for (const rule of freeformRules) {
		const params = rule.params as FreeformRuleParams | null;
		if (!params?.condition) continue;

		// Atomic daily reset: SQL CASE expression prevents a read-modify-write race
		// if two processes or a restart coincide with midnight.
		await db.run(sql`
			UPDATE project_alert_rules
			SET
				daily_token_spend_cents = CASE WHEN daily_token_spend_date != ${today} THEN 0 ELSE daily_token_spend_cents END,
				daily_token_spend_date = ${today}
			WHERE id = ${rule.id}
		`);

		// Re-read from DB after the atomic reset — do not use the in-memory snapshot.
		const [freshRule] = await db
			.select({
				dailyTokenSpendCents: projectAlertRules.dailyTokenSpendCents,
				lastEvaluatedEventId: projectAlertRules.lastEvaluatedEventId,
			})
			.from(projectAlertRules)
			.where(eq(projectAlertRules.id, rule.id));
		if (!freshRule) continue;

		if (freshRule.dailyTokenSpendCents >= params.dailyTokenBudget) continue;

		const safeEventTypes =
			Array.isArray(params.eventTypesFilter) && params.eventTypesFilter.length > 0
				? params.eventTypesFilter
				: ["ToolUseResult", "UserPromptSubmit", "AssistantMessage", "Stop"];

		// Single JOIN query — not per-session nested loops (prevents N+1).
		// Only active (non-ended, non-archived) sessions; cap at 100 events per sweep.
		const recentEvents = await db
			.select({
				id: events.id,
				sessionId: events.sessionId,
				eventType: events.eventType,
				content: events.content,
			})
			.from(events)
			.innerJoin(sessions, eq(sessions.sessionId, events.sessionId))
			.where(
				and(
					eq(sessions.projectId, rule.projectId),
					isNull(sessions.endedAt),
					eq(sessions.isArchived, false),
					inArray(events.eventType, safeEventTypes),
					gt(events.id, freshRule.lastEvaluatedEventId),
					lte(events.id, sweepMaxEventId),
				),
			)
			.orderBy(asc(events.id))
			.limit(100);

		// Advance cursor BEFORE sample-rate check so sampled-out events don't
		// accumulate as an infinite re-evaluation backlog.
		const newCursor =
			recentEvents.length > 0
				? recentEvents[recentEvents.length - 1].id
				: freshRule.lastEvaluatedEventId;

		if (newCursor !== freshRule.lastEvaluatedEventId) {
			await db
				.update(projectAlertRules)
				.set({ lastEvaluatedEventId: newCursor })
				.where(eq(projectAlertRules.id, rule.id));
		}

		const sampleRate = params.sampleRate ?? 1.0;
		const debounceMinutes = params.debounceMinutes ?? 525_960;

		for (const evt of recentEvents) {
			// Budget gate re-checked per event (spend accumulates within the loop).
			if (freshRule.dailyTokenSpendCents >= params.dailyTokenBudget) break;

			// Sample-rate check after cursor advance.
			if (sampleRate < 1.0 && !(Math.random() < sampleRate)) continue;

			const content = evt.content ?? "";
			if (content.trim().length === 0) continue;

			// Debounce: check time since last fire for this (rule, session) pair.
			const [lastFire] = await db
				.select({ firedAt: projectAlertRuleFires.firedAt })
				.from(projectAlertRuleFires)
				.where(
					and(
						eq(projectAlertRuleFires.ruleId, rule.id),
						eq(projectAlertRuleFires.sessionId, evt.sessionId),
					),
				)
				.orderBy(desc(projectAlertRuleFires.firedAt))
				.limit(1);

			if (lastFire) {
				const minutesSince = (now.getTime() - new Date(lastFire.firedAt).getTime()) / 60_000;
				if (minutesSince < debounceMinutes) continue;
			}

			const result = await classifyFreeformCondition(rule.id, params.condition, content);
			if (result.error) continue; // LLM error — skip spend recording (fail-safe)
			if (!result.matched) continue;

			// Spend recorded only on successful classification.
			// 1 cent per call is a conservative floor constant rather than exact
			// token accounting — keeps v1 simple while preventing runaway charges.
			const spentCents = 1;

			// Atomic increment so concurrent sweep ticks don't double-count.
			await db
				.update(projectAlertRules)
				.set({ dailyTokenSpendCents: sql`daily_token_spend_cents + ${spentCents}` })
				.where(eq(projectAlertRules.id, rule.id));
			freshRule.dailyTokenSpendCents += spentCents;

			// Fire row. No UNIQUE constraint on (rule_id, session_id) for freeform
			// rules — debounceMinutes is the re-fire gate here, not a DB constraint.
			await db.insert(projectAlertRuleFires).values({
				ruleId: rule.id,
				sessionId: evt.sessionId,
				firedAt: now.toISOString(),
			});

			const [sessionRow] = await db
				.select({ displayName: sessions.displayName })
				.from(sessions)
				.where(eq(sessions.sessionId, evt.sessionId))
				.limit(1);

			await dispatchAlertRuleNotification(
				rule,
				evt.sessionId,
				sessionRow?.displayName ?? null,
				"freeform",
			);
		}
	}
}
