/**
 * Notify: one status note per finished turn, for the person who owns the
 * session. It reads the session's evidence, asks the model for a verdict and a
 * two-line note, checks the note, stores it, and delivers it to the inbox and,
 * within the rate rule, to Telegram.
 *
 * It sends nothing to the agent. It never imports the control queue or the
 * proposal resolver (a guard test checks that), so no code path here can type a
 * prompt into a session.
 */
import { config } from "../../../config.js";
import { getDb } from "../../../db/client.js";
import { OwnTurnBusyError } from "../../../util/own-turn.js";
import { dispatchReportToChannel } from "../../channels/dispatch.js";
import { telegramSendsSince } from "../../channels/telegram-budget.js";
import { emitAiEvent } from "../ai-events.js";
import { priceCompletion } from "../llm/pricing.js";
import { getAdapter } from "../llm/registry.js";
import { LlmError, type LlmUsage } from "../llm/types.js";
import type { ProviderRecord } from "../providers-service.js";
import { type EvidenceBundle, loadEvidence } from "../session-summary/evidence-loader.js";
import { buildLedgerAsync, userPromptTexts } from "../session-summary/ledger.js";
import { checkText, collectUserPromptUrls, contextOf } from "../session-summary/tripwire.js";
import { addSpendCents, checkSpendBudget } from "../spend-service.js";
import { computeTurnKey, isTurnStale } from "../turn-identity.js";
import type { WatcherConfigRecord } from "../watcher-config-service.js";
import {
	type ReportFailureCode,
	type Usage,
	claimReport,
	completeReport,
	escalationsSentSince,
	failReport,
	lastDeliveredThrough,
	lastReportCreatedAt,
	lastRoutineSentAt,
	markTelegram,
	suppressReport,
} from "../watcher-reports-service.js";
import { parseNotifyAnswer } from "./output.js";
import { NOTIFY_MAX_TOKENS, buildNotifyPrompt } from "./prompt.js";
import { telegramDecision } from "./telegram-rate.js";

/** At most one Notify model call per session in this window, measured from the newest report row. */
export const NOTIFY_MIN_CALL_INTERVAL_MS = 60_000;
/** A transient failure is tried once more after this long. */
export const NOTIFY_RETRY_DELAY_MS = 60_000;
/** Characters of evidence the note is written from. */
export const NOTIFY_LEDGER_CHAR_BUDGET = 12_000;
const HOUR_MS = 60 * 60 * 1000;

export interface NotifySession {
	sessionId: string;
	agentType: string;
	displayName: string | null;
	cwd: string | null;
	gitBranch: string | null;
	currentTask: string | null;
}

export interface NotifyRun {
	id: string;
}

export interface NotifyTrigger {
	id: number;
	rawPayload?: Record<string, unknown> | null;
}

export type NotifyOutcome = { did: "report" | "skip"; retryAfterMs?: number };

/** Failures a second attempt can fix; the rest are the model's, or the operator's, to fix. */
const RETRYABLE: ReadonlySet<string> = new Set([
	"provider_timeout",
	"provider_transient",
	"evidence_read",
]);

const SKIPPED: NotifyOutcome = { did: "skip" };

function failureCodeOf(error: unknown): ReportFailureCode {
	if (!(error instanceof LlmError)) return "provider_unknown";
	switch (error.subType) {
		case "transient_timeout":
			return "provider_timeout";
		case "transient_rate_limit":
			return "provider_transient";
		case "empty_output":
			return "empty_output";
		default:
			return `provider_${error.subType}`;
	}
}

function usageOf(
	provider: Pick<ProviderRecord, "id" | "kind" | "model">,
	usage: LlmUsage | undefined,
): Usage {
	return {
		providerId: provider.id,
		tokensIn: usage?.inputTokens ?? 0,
		tokensOut: usage?.outputTokens ?? 0,
		costCents: usage ? priceCompletion(provider.kind, provider.model, usage) : 0,
	};
}

/** The rows after the last delivered report, without the watcher's own events. */
function newEvidence(bundle: EvidenceBundle, after: number) {
	const mine = (row: { category: string | null }) => row.category?.startsWith("ai_") === true;
	const rows = bundle.rows.filter((row) => row.id > after && !mine(row));
	const firstPromptRows = bundle.firstPromptRows.filter((row) => !mine(row));
	return { rows, firstPromptRows };
}

export async function runNotify(
	session: NotifySession,
	watcher: Pick<WatcherConfigRecord, "channelId" | "maxDailyCents">,
	run: NotifyRun,
	triggerEvent: NotifyTrigger,
	provider: Pick<ProviderRecord, "id" | "kind" | "model" | "baseUrl">,
	apiKey: string,
): Promise<NotifyOutcome> {
	const { sessionId } = session;

	// 1. Too soon after the last report: claim nothing, come back when the window is over.
	const lastCreated = await lastReportCreatedAt(sessionId);
	if (lastCreated !== null) {
		const wait = NOTIFY_MIN_CALL_INTERVAL_MS - (Date.now() - lastCreated);
		if (wait > 0) return { did: "skip", retryAfterMs: wait };
	}

	// 2. Is this turn ours to report?
	const turnKey = await computeTurnKey(getDb(), session, triggerEvent);
	const claim = await claimReport({ sessionId, turnKey, triggerEventId: triggerEvent.id });
	if (!claim.claimed) return SKIPPED;

	const fail = async (code: ReportFailureCode, usage?: Partial<Usage>): Promise<NotifyOutcome> => {
		await failReport(claim.id, code, usage);
		await emitAiEvent({
			sessionId,
			source: "managed_control",
			category: "ai_error",
			eventType: "NotifyFailed",
			content: `Status report failed (${code}).`,
			rawPayload: { kind: "notify", code, report_id: claim.id, turn_key: turnKey, run_id: run.id },
		});
		return RETRYABLE.has(code) && claim.attempt < 2
			? { did: "skip", retryAfterMs: NOTIFY_RETRY_DELAY_MS }
			: SKIPPED;
	};

	try {
		// 3. Evidence since the last delivered report.
		let bundle: EvidenceBundle;
		try {
			bundle = await loadEvidence(sessionId);
		} catch (error) {
			if (error instanceof OwnTurnBusyError) throw error;
			return await fail("evidence_read");
		}
		const after = await lastDeliveredThrough(sessionId);
		const evidence = newEvidence(bundle, after);
		if (evidence.rows.length === 0) {
			await suppressReport(claim.id, "no_new_evidence");
			return SKIPPED;
		}

		// 4. The ledger, with a smaller budget than a summary.
		const ledger = await buildLedgerAsync({
			rows: evidence.rows,
			firstPromptRows: evidence.firstPromptRows,
			scan: bundle.scan,
			agentType: bundle.agentType,
			charBudget: NOTIFY_LEDGER_CHAR_BUDGET,
		});

		// 5. Spend.
		const budget = await checkSpendBudget("local", watcher.maxDailyCents);
		if (!budget.allowed) return await fail("spend_cap");

		// 6. The call.
		const built = buildNotifyPrompt(session, ledger);
		const adapter = getAdapter({
			kind: provider.kind,
			apiKey,
			baseUrl: provider.baseUrl ?? undefined,
		});
		let text: string;
		let usage: Usage;
		let stopReason: string | undefined;
		try {
			const res = await adapter.complete({
				systemPrompt: built.systemPrompt,
				transcriptPrompt: built.transcriptPrompt,
				model: provider.model,
				// A short JSON object; reasoning would take the token budget.
				disableReasoning: true,
				timeoutMs: config.watcherCallTimeoutSeconds * 1000,
				maxTokens: NOTIFY_MAX_TOKENS,
			});
			text = res.text;
			stopReason = res.stopReason;
			usage = usageOf(provider, res.usage);
		} catch (error) {
			const billed = error instanceof LlmError ? usageOf(provider, error.usage) : undefined;
			if (billed && billed.costCents > 0) await addSpendCents(sessionId, billed.costCents);
			return await fail(failureCodeOf(error), billed);
		}
		if (usage.costCents > 0) await addSpendCents(sessionId, usage.costCents);

		// 7. The answer, then the note's own text.
		if (stopReason === "length") return await fail("length", usage);
		if (stopReason === "refusal") return await fail("refusal", usage);
		if (text.trim() === "") return await fail("empty_output", usage);
		const parsed = parseNotifyAnswer(text, built.nonce, ledger.ids);
		if (!parsed.ok) return await fail(parsed.code, usage);
		const typedUrls = collectUserPromptUrls(userPromptTexts(evidence));
		const suspect = checkText(
			parsed.why,
			contextOf(typedUrls, {
				recordedPaths: ledger.recorded.paths,
				recordedCommands: ledger.recorded.commands,
			}),
			{ checkCommands: true },
		);
		if (suspect.length > 0) return await fail("suspect_text", usage);

		// 8. Did the turn move on while the model was thinking?
		if (await isTurnStale(getDb(), session, turnKey, triggerEvent)) {
			await suppressReport(claim.id, "stale", usage);
			return SKIPPED;
		}

		// 9. Deliver.
		const completed = await completeReport({
			id: claim.id,
			verdict: parsed.verdict,
			why: parsed.why,
			evidenceIds: parsed.evidence,
			throughEventId: bundle.throughEventId ?? triggerEvent.id,
			...usage,
		});
		if (!completed) return SKIPPED;
		await emitAiEvent({
			sessionId,
			source: "managed_control",
			category: "ai_report",
			eventType: "AiReport",
			content: parsed.why,
			rawPayload: {
				kind: "notify",
				verdict: parsed.verdict,
				report_id: claim.id,
				turn_key: turnKey,
				run_id: run.id,
			},
		});
		await deliverToTelegram({
			reportId: claim.id,
			session,
			channelId: watcher.channelId,
			verdict: parsed.verdict,
			why: parsed.why,
		});
		return { did: "report" };
	} catch (error) {
		// Unexpected: do not leave the row claimed. A restart would fail it anyway, but sooner is clearer.
		await failReport(claim.id, "abandoned").catch(() => undefined);
		throw error;
	}
}

async function deliverToTelegram(input: {
	reportId: string;
	session: NotifySession;
	channelId: string | null;
	verdict: "finished" | "stuck" | "needs_you";
	why: string;
}): Promise<void> {
	const { reportId, session, channelId, verdict } = input;
	if (!channelId) {
		await markTelegram(reportId, "skipped_no_channel");
		return;
	}
	const now = Date.now();
	const since = now - HOUR_MS;
	const decision = telegramDecision({
		verdict,
		lastRoutineSentAt: await lastRoutineSentAt(session.sessionId),
		escalationsLastHour: await escalationsSentSince(session.sessionId, since),
		globalLastHour: await telegramSendsSince(new Date(since).toISOString()),
		now,
	});
	if (decision === "skipped_rate_limit") {
		await markTelegram(reportId, "skipped_rate_limit");
		return;
	}
	const delivery = await dispatchReportToChannel({
		channelId,
		message: {
			sessionId: session.sessionId,
			sessionLabel: session.displayName,
			verdict,
			why: input.why,
			dashboardUrl: config.publicUrlExplicit
				? `${config.publicUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(session.sessionId)}`
				: null,
			sessionCwd: session.cwd,
		},
	});
	if (delivery.ok) {
		await markTelegram(reportId, "sent");
		return;
	}
	await markTelegram(reportId, "failed");
	await emitAiEvent({
		sessionId: session.sessionId,
		source: "managed_control",
		category: "ai_error",
		eventType: "ChannelDeliveryFailed",
		content: "Could not send the status report to the notification channel.",
		rawPayload: { kind: "notify", report_id: reportId, channel_id: channelId },
	});
}
