import { eq } from "drizzle-orm";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { sessions } from "../../db/schema/index.js";
import { SESSION_COLUMNS_SANS_OWNERSHIP } from "../../db/session-columns.js";
import { stampUserPrompt, stampWatcherState } from "../managed-session-state.js";
import { sessionBus } from "../notifier.js";
import { emitAiEvent } from "./ai-events.js";
import {
	evaluateFreeformRules,
	evaluateNoActivityRules,
	evaluateStuckRules,
	purgeExpiredQaCache,
} from "./alert-rule-evaluator.js";
import { buildWatcherContext } from "./context.js";
import { classifyContinuability } from "./continuability.js";
import { routeContinueOrAsk } from "./continue-decision.js";
import { loadWatcherSentPrompts } from "./dispatch-audit-service.js";
import { getEventById, loadRecentEvents } from "./event-queries.js";
import { classifierAffectsRunner, isAiActive, isAiBuildEnabled } from "./feature.js";
import { expireOverdueHitl } from "./hitl-service.js";
import { intelligenceForSession } from "./intelligence-service.js";
import { priceCompletion } from "./llm/pricing.js";
import { getAdapter } from "./llm/registry.js";
import { LlmError } from "./llm/types.js";
import { emitAiMetric } from "./metrics.js";
import { runNotify } from "./notify/watcher-notify.js";
import { parseDecision } from "./parser.js";
import { loadManagedContext } from "./prompt-deliverability.js";
import {
	ProposalAlreadyExistsError,
	cancelOpenHitl,
	completeProposal,
	createPendingProposal,
	failProposal,
	hasProposalForTurn,
	proposalActivity,
} from "./proposals-service.js";
import { getProvider, getProviderApiKey } from "./providers-service.js";
import { RunLeaser } from "./run-leaser.js";
import { addSpendCents, checkSpendBudget } from "./spend-service.js";
import { type Boundary, boundaryOf, computeTurnKey, hasPromptAfter } from "./turn-identity.js";
import { isWatched } from "./watched-sessions.js";
import { getWatcherConfig } from "./watcher-config-service.js";
import { sweepWatcherOnStart } from "./watcher-maintenance.js";
import {
	type WatcherRunRecord,
	type WatcherRunTriggerKind,
	enqueueRun,
	markCancelled,
	markFailed,
	markRunning,
	markSucceeded,
} from "./watcher-runs-service.js";

/** How long a turn boundary waits for a follow-up (a SessionEnd after a Stop, the managed and hook copy of one turn end) before the watcher wakes. */
export const BOUNDARY_DEBOUNCE_MS = 10_000;
/** At most one Continue model call per session in this window, measured from the newest proposal. */
export const CONTINUE_MIN_CALL_INTERVAL_MS = 60_000;
/** At most this many Continue proposals per session per rolling hour. */
export const CONTINUE_PROPOSALS_PER_SESSION_PER_HOUR = 6;
// Enough events to find the trigger and to cover a turn that ran long.
const MAX_EVENTS_LOOKBACK = 200;
// A Continue decision reads the whole current turn, however long ago it began.
const CONTINUE_TIME_BUDGET_MS = 6 * 60 * 60 * 1000;
const CONTINUE_MAX_TOKENS = 600;
const HOUR_MS = 60 * 60 * 1000;
const LEASE_DURATION_MS = 60_000;
const LEASE_POLL_INTERVAL_MS = 500;
const ALERT_RULE_SWEEP_INTERVAL_MS = 60_000;

/** The timers the runner uses, so a test can drive them with a manual clock. */
export interface RunnerClock {
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

const realClock: RunnerClock = {
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface ScheduledWake {
	handle: unknown;
	/** The newest boundary event that asked for this wake: it becomes the run's trigger. */
	event: SessionEvent;
}

/** A wake to schedule once the run that returned it has finished. */
interface Retry {
	afterMs: number;
	event: SessionEvent;
}

type EvalResult =
	| { kind: "ok"; proposalId?: string | null; retry?: Retry }
	| { kind: "cancelled"; reason: string; retry?: Retry }
	| { kind: "err"; errorSubType: string; retry?: Retry };

type ContinueOutcome =
	| { did: "proposal"; proposalId: string }
	| { did: "skip"; retryAfterMs?: number }
	| { did: "err"; errorSubType: string };

/**
 * AI watcher runner. It wakes on turn boundaries only (a turn ended, the
 * session ended, a turn began), waits `BOUNDARY_DEBOUNCE_MS` for a follow-up,
 * and then queues one durable run per session. A run does up to two things, each
 * gated on its own mode: Notify (a status note for the person) and Continue (a
 * suggestion for the next prompt).
 *
 * Wakes are persisted to `ai_watcher_runs` and picked up by a lease-based poller
 * so work survives process restart. The in-process debounce coalesces the
 * boundaries; once it fires we enqueue a durable row and let the leaser drive it.
 */
export class WatcherRunner {
	private readonly scheduled = new Map<string, ScheduledWake>();
	/** The newest boundary that arrived while a run was claimed or running: it is woken for once that run finishes. */
	private readonly rewake = new Map<string, SessionEvent>();
	// NOTE: inFlight is per-process. Multi-instance deployment is unsupported
	// until SQLite → Postgres migration; see thoughts/2026-04-24-postgres-backend-plan.md (A-M2).
	private readonly inFlight = new Set<string>();
	private started = false;
	private listening = false;
	private alertRuleSweepInterval: ReturnType<typeof setInterval> | null = null;
	// Re-entry guard: if a sweep takes >60s the next tick returns immediately
	// rather than running a second concurrent sweep that could double-fire alerts.
	private alertSweepBusy = false;
	private readonly leaseOwner = `watcher-${process.pid}-${Date.now()}`;
	private readonly leaser = new RunLeaser({
		leaseOwner: this.leaseOwner,
		leaseDurationMs: LEASE_DURATION_MS,
		intervalMs: LEASE_POLL_INTERVAL_MS,
		processRun: (run) => this.processRun(run),
	});

	constructor(private readonly clock: RunnerClock = realClock) {}

	private readonly onSessionEvent = ({
		sessionId,
		event,
	}: { sessionId: string; event: SessionEvent }) => {
		// Stamp user prompts immediately so race-control can see them even
		// if the watcher was mid-call when the prompt landed.
		if (event.category === "prompt") {
			void stampUserPrompt(sessionId);
		}
		// Only turn boundaries wake the watcher; the watcher's own events never do.
		const boundary = boundaryOf(event);
		if (boundary === null) return;
		void this.onBoundary(sessionId, event, boundary, false);
	};

	private readonly onWatcherWake = ({
		sessionId,
		event,
		boundary,
	}: { sessionId: string; event: SessionEvent; boundary: Boundary }) => {
		// Ingest already checked that the session is watched.
		void this.onBoundary(sessionId, event, boundary, true);
	};

	/** Hear about turn boundaries. Idempotent. Separate from `start` so a test can drive the wake path alone. */
	attachListeners(): void {
		if (this.listening) return;
		this.listening = true;
		sessionBus.on("session_event", this.onSessionEvent);
		sessionBus.on("watcher_wake", this.onWatcherWake);
		// Intentionally no `session_updated` listener: every hook ingest,
		// every supervisor heartbeat, and the 60-second stale-session tick
		// all emit that. Wiring it up here would schedule a trigger-less run each
		// time and churn the queue.
	}

	detachListeners(): void {
		sessionBus.off("session_event", this.onSessionEvent);
		sessionBus.off("watcher_wake", this.onWatcherWake);
		this.listening = false;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		this.attachListeners();

		// A previous process may have died mid-run: fail what it left claimed,
		// expire overdue HITLs and reconcile half-written audit rows first.
		try {
			const swept = await sweepWatcherOnStart();
			console.log(JSON.stringify({ kind: "watcher_sweep", ...swept }));
		} catch (err) {
			console.error("[ai-watcher] startup sweep failed:", err);
		}

		await this.leaser.start();

		this.alertRuleSweepInterval = setInterval(() => {
			void this.runAlertRuleSweep().catch((err) => {
				console.error("[alert-rule-sweep] sweep threw:", err);
			});
		}, ALERT_RULE_SWEEP_INTERVAL_MS);

		console.log("[ai-watcher] runner started");
	}

	stop(): void {
		this.leaser.stop();
		this.detachListeners();
		if (this.alertRuleSweepInterval !== null) {
			clearInterval(this.alertRuleSweepInterval);
			this.alertRuleSweepInterval = null;
		}
		for (const entry of this.scheduled.values()) this.clock.clearTimer(entry.handle);
		this.scheduled.clear();
		this.rewake.clear();
		this.started = false;
	}

	private async runAlertRuleSweep(): Promise<void> {
		if (this.alertSweepBusy) return;
		this.alertSweepBusy = true;
		try {
			const now = new Date();
			await evaluateStuckRules(now);
			await evaluateNoActivityRules(now);
			await evaluateFreeformRules(now);
			await purgeExpiredQaCache(now);
			// Requests nobody answered in time lapse here, so a stale one can't sit open for days.
			await expireOverdueHitl();
		} finally {
			this.alertSweepBusy = false;
		}
	}

	/**
	 * A turn boundary in a session. `turn_start` means the person (or a sent
	 * prompt) began the next turn: it cancels a pending wake and closes the open
	 * request, which was about the turn that is over. The other boundaries start
	 * the debounce.
	 */
	private async onBoundary(
		sessionId: string,
		event: SessionEvent,
		boundary: Boundary,
		alreadyWatched: boolean,
	): Promise<void> {
		try {
			if (!alreadyWatched && !(await isWatched(sessionId))) return;
			if (boundary === "turn_start") {
				this.cancelWake(sessionId);
				await cancelOpenHitl(sessionId, "superseded");
				return;
			}
			this.scheduleWake(sessionId, event, BOUNDARY_DEBOUNCE_MS);
		} catch (err) {
			console.error(`[ai-watcher] boundary handling failed for ${sessionId}:`, err);
		}
	}

	private cancelWake(sessionId: string): void {
		const existing = this.scheduled.get(sessionId);
		if (!existing) return;
		this.clock.clearTimer(existing.handle);
		this.scheduled.delete(sessionId);
	}

	/**
	 * Schedule or reset the per-session wake. The newest boundary event (by id)
	 * is the one the run is woken for, so a SessionEnd after a Stop wakes once.
	 */
	private scheduleWake(sessionId: string, event: SessionEvent, delayMs: number): void {
		const existing = this.scheduled.get(sessionId);
		if (existing) this.clock.clearTimer(existing.handle);
		const trigger = existing && existing.event.id > event.id ? existing.event : event;
		const handle = this.clock.setTimer(() => {
			this.scheduled.delete(sessionId);
			void this.fire(sessionId, trigger).catch((err) => {
				console.error(`[ai-watcher] wake failed for ${sessionId}:`, err);
			});
		}, delayMs);
		this.scheduled.set(sessionId, { handle, event: trigger });
	}

	/** The debounce is over: queue a run, unless the AI is off, the session is no longer watched, or a new turn began. */
	private async fire(sessionId: string, event: SessionEvent): Promise<void> {
		if (!(await isAiActive()) || !(await isWatched(sessionId))) return;
		if (await hasPromptAfter(getDb(), sessionId, event.id)) return;
		const { run, triggerMoved } = await enqueueRun({
			sessionId,
			triggerEventId: event.id,
			triggerKind: derivedTrigger(event),
		});
		if (!triggerMoved) {
			// The open run was claimed (or is running): it won't see this boundary, so wake once it is done.
			const pending = this.rewake.get(sessionId);
			if (!pending || event.id > pending.id) this.rewake.set(sessionId, event);
			return;
		}
		emitAiMetric({
			name: "watcher_run_queued",
			sessionId,
			runId: run.id,
			attempt: run.attemptCount,
		});
	}

	/** Process a single claimed run. */
	private async processRun(run: WatcherRunRecord): Promise<void> {
		const sessionId = run.sessionId;
		if (this.inFlight.has(sessionId)) {
			// Another evaluate is still running for this session (e.g., from a
			// prior tick). Re-queue the run so it retries after the in-flight
			// one finishes.
			await markCancelled(run.id, "in_flight_collision");
			return;
		}
		this.inFlight.add(sessionId);
		await markRunning(run.id);

		const startedAt = Date.now();
		let retry: Retry | undefined;
		try {
			const result = await this.evaluateInner(sessionId, run);
			retry = result.retry;
			if (result.kind === "ok") {
				await markSucceeded({ id: run.id, proposalId: result.proposalId ?? null });
				emitAiMetric({
					name: "watcher_run_completed",
					sessionId,
					runId: run.id,
					outcome: "succeeded",
					durationMs: Date.now() - startedAt,
				});
			} else if (result.kind === "cancelled") {
				await markCancelled(run.id, result.reason);
			} else {
				await markFailed({ id: run.id, errorSubType: result.errorSubType });
				emitAiMetric({
					name: "watcher_run_completed",
					sessionId,
					runId: run.id,
					outcome: "failed",
					durationMs: Date.now() - startedAt,
					errorSubType: result.errorSubType,
				});
			}
		} catch (err) {
			const sub = err instanceof LlmError ? err.subType : "unknown";
			console.error(`[ai-watcher] ${sessionId} eval threw:`, err);
			await markFailed({ id: run.id, errorSubType: sub });
			emitAiMetric({
				name: "watcher_run_completed",
				sessionId,
				runId: run.id,
				outcome: "failed",
				durationMs: Date.now() - startedAt,
				errorSubType: sub,
			});
		} finally {
			this.inFlight.delete(sessionId);
			// A boundary that arrived during the run is woken for now; otherwise a retry asked for by the run.
			const again = this.rewake.get(sessionId);
			this.rewake.delete(sessionId);
			if (again) this.scheduleWake(sessionId, again, BOUNDARY_DEBOUNCE_MS);
			else if (retry) this.scheduleWake(sessionId, retry.event, retry.afterMs);
		}
	}

	/**
	 * One run, in three steps: is this session watched, then Notify (a status
	 * note) if it is on, then Continue (a suggestion) if it is on and a turn just
	 * ended. Each mode has its own gates; neither depends on the other's cap.
	 */
	private async evaluateInner(sessionId: string, run: WatcherRunRecord): Promise<EvalResult> {
		const watchConfig = await getWatcherConfig(sessionId);
		if (
			!watchConfig ||
			!watchConfig.enabled ||
			(!watchConfig.notifyEnabled && !watchConfig.continueEnabled)
		) {
			return { kind: "cancelled", reason: "not_watched" };
		}

		const [session] = await getDb()
			.select(SESSION_COLUMNS_SANS_OWNERSHIP)
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!session) return { kind: "cancelled", reason: "no_session" };

		// By id, however old: a run's trigger is never searched for in a window.
		const trigger = run.triggerEventId ? await getEventById(run.triggerEventId) : null;
		if (!trigger || trigger.sessionId !== sessionId) {
			return { kind: "cancelled", reason: "no_trigger" };
		}
		const boundary = boundaryOf(trigger);
		if (boundary === null || boundary === "turn_start") {
			return { kind: "cancelled", reason: "not_a_boundary" };
		}

		const provider = await getProvider(watchConfig.providerId);
		if (!provider) {
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_error",
				eventType: "ProviderMissing",
				content: `Configured provider ${watchConfig.providerId} no longer exists`,
				rawPayload: { sub_type: "permanent_validation" },
			});
			return { kind: "err", errorSubType: "permanent_validation" };
		}
		const apiKey = await getProviderApiKey(provider.id);
		if (!apiKey) {
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_error",
				eventType: "CredentialFailure",
				content: "Provider credential could not be decrypted",
				rawPayload: { sub_type: "permanent_validation" },
			});
			await stampWatcherState(sessionId, "disabled_due_to_error");
			return { kind: "err", errorSubType: "permanent_validation" };
		}

		let worked = false;
		let proposalId: string | null = null;
		let failure: string | null = null;
		let retryAfterMs: number | null = null;
		const wantRetry = (ms: number | undefined) => {
			if (ms !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, ms);
		};

		if (watchConfig.notifyEnabled) {
			try {
				const out = await runNotify(
					{
						sessionId,
						agentType: session.agentType,
						displayName: session.displayName,
						cwd: session.cwd,
						gitBranch: session.gitBranch,
						currentTask: session.currentTask,
					},
					watchConfig,
					run,
					trigger,
					provider,
					apiKey,
				);
				if (out.did === "report") worked = true;
				wantRetry(out.retryAfterMs);
			} catch (err) {
				console.error(`[ai-watcher] ${sessionId} notify threw:`, err);
				failure = "notify_failed";
			}
		}

		if (watchConfig.continueEnabled && boundary === "turn_end") {
			const out = await this.runContinue({
				sessionId,
				run,
				watchConfig,
				session,
				trigger,
				provider,
				apiKey,
			});
			if (out.did === "proposal") {
				worked = true;
				proposalId = out.proposalId;
			} else if (out.did === "skip") {
				wantRetry(out.retryAfterMs);
			} else {
				failure = out.errorSubType;
			}
		}

		const retry: Retry | undefined =
			retryAfterMs === null ? undefined : { afterMs: retryAfterMs, event: trigger };
		if (worked) return { kind: "ok", proposalId, retry };
		if (failure) return { kind: "err", errorSubType: failure, retry };
		return { kind: "cancelled", reason: "no_work", retry };
	}

	/**
	 * Continue: ask the model for the next step and route its answer. Gated on
	 * the turn (one proposal per turn), the flood limits, the session's
	 * continuability and spend. `maxContinuations` is not checked here: it limits
	 * automatic sends, inside the send path, and a capped auto config still opens
	 * a request for a person.
	 */
	private async runContinue(input: {
		sessionId: string;
		run: WatcherRunRecord;
		watchConfig: NonNullable<Awaited<ReturnType<typeof getWatcherConfig>>>;
		session: Record<string, unknown> & { agentType: string };
		trigger: SessionEvent;
		provider: NonNullable<Awaited<ReturnType<typeof getProvider>>>;
		apiKey: string;
	}): Promise<ContinueOutcome> {
		const { sessionId, run, watchConfig, session, trigger, provider, apiKey } = input;

		const turnKey = await computeTurnKey(
			getDb(),
			session as { sessionId: string; agentType: string },
			trigger,
		);
		if (await hasProposalForTurn(sessionId, turnKey)) return { did: "skip" };

		// Flood limits, counted from the table so a restart can't reset them.
		const now = Date.now();
		const activity = await proposalActivity(sessionId, new Date(now - HOUR_MS).toISOString());
		if (activity.newestAt !== null && now - activity.newestAt < CONTINUE_MIN_CALL_INTERVAL_MS) {
			return {
				did: "skip",
				retryAfterMs: CONTINUE_MIN_CALL_INTERVAL_MS - (now - activity.newestAt),
			};
		}
		if (activity.inWindow >= CONTINUE_PROPOSALS_PER_SESSION_PER_HOUR) return { did: "skip" };

		const recent = await loadRecentEvents(sessionId, MAX_EVENTS_LOOKBACK);
		// A trigger older than the window the watcher reads is a turn that is long over.
		if (!recent.some((e) => e.id === trigger.id)) return { did: "skip" };

		// Continuability — deliberately generous about "report". Even when
		// we can't dispatch, we often want to summarize for the user.
		const managed = await loadManagedContext(sessionId);
		const elig = classifyContinuability({
			session: session as unknown as Session,
			recentEvents: recent,
			managedSession: managed?.managedSession,
			supervisorConnected: managed?.supervisorConnected ?? true,
		});
		if (!elig.eligibleToContinue && !elig.eligibleToReport) return { did: "skip" };

		// Budget pre-flight (point-query, cheap).
		const spend = await checkSpendBudget("local", watchConfig.maxDailyCents, 0);
		if (!spend.allowed) {
			await stampWatcherState(sessionId, "cooling_down");
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_error",
				eventType: "SpendCapReached",
				content: spend.reason ?? "Daily spend cap reached",
				rawPayload: { sub_type: "spend_cap", cap: spend.cap, spent: spend.spent },
			});
			return { did: "err", errorSubType: "spend_cap" };
		}

		await stampWatcherState(sessionId, "thinking");

		// Phase 1 of two-phase recording: a pending row lands BEFORE the LLM
		// call so a crash mid-request is visible. One per turn, kept by the database.
		let pending: Awaited<ReturnType<typeof createPendingProposal>>;
		try {
			pending = await createPendingProposal({
				sessionId,
				providerId: provider.id,
				triggerEventId: String(trigger.id),
				turnKey,
			});
		} catch (err) {
			if (err instanceof ProposalAlreadyExistsError) return { did: "skip" };
			throw err;
		}
		await emitAiEvent({
			sessionId,
			source: "managed_control",
			category: "ai_proposal_pending",
			eventType: "AiProposalPending",
			content: "Watcher thinking…",
			rawPayload: { proposal_id: pending.id, run_id: run.id },
		});

		// Phase 2 hook: fold the classifier's summary into the prompt only
		// when the operator has enabled `ai.classifierAffectsRunner`. Off by
		// default — badges work without runner integration.
		let intelligenceHint: Parameters<typeof buildWatcherContext>[0]["intelligenceHint"];
		if (await classifierAffectsRunner()) {
			try {
				const intel = await intelligenceForSession(sessionId);
				if (intel) {
					intelligenceHint = {
						health: intel.health,
						reasonCode: intel.reasonCode,
						explanation: intel.explanation,
					};
				}
			} catch (err) {
				console.warn(`[ai-watcher] classifier hint failed for ${sessionId}:`, err);
			}
		}

		// Build prompt, call LLM.
		const ctx = buildWatcherContext({
			session: session as unknown as Session,
			events: recent,
			triggerType: run.triggerKind,
			customSystemPrompt: watchConfig.systemPrompt,
			intelligenceHint,
			transcriptTimeBudgetMs: CONTINUE_TIME_BUDGET_MS,
			watcherSentPrompts: await loadWatcherSentPrompts(sessionId),
		});

		const adapter = getAdapter({
			kind: provider.kind,
			apiKey,
			baseUrl: provider.baseUrl ?? undefined,
		});

		let responseText = "";
		let usageInput = 0;
		let usageOutput = 0;
		let usageEstimated = false;
		let costCents = 0;
		try {
			const res = await adapter.complete({
				systemPrompt: ctx.systemPrompt,
				transcriptPrompt: ctx.transcriptPrompt,
				model: provider.model,
				// The decision is a JSON object; reasoning would take the token budget.
				disableReasoning: true,
				timeoutMs: config.watcherCallTimeoutSeconds * 1000,
				maxTokens: CONTINUE_MAX_TOKENS,
			});
			responseText = res.text;
			usageInput = res.usage.inputTokens;
			usageOutput = res.usage.outputTokens;
			usageEstimated = res.usage.estimated;
			costCents = priceCompletion(provider.kind, provider.model, res.usage);
		} catch (err) {
			const subType = err instanceof LlmError ? err.subType : "unknown";
			const message = err instanceof Error ? err.message : String(err);
			// An empty reply was still billed.
			if (err instanceof LlmError && err.usage) {
				const failedCost = priceCompletion(provider.kind, provider.model, err.usage);
				if (failedCost > 0) await addSpendCents(sessionId, failedCost);
			}
			await failProposal({ id: pending.id, errorSubType: subType, errorMessage: message });
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_error",
				eventType: "ProviderError",
				content: message,
				rawPayload: { sub_type: subType, proposal_id: pending.id },
			});
			await stampWatcherState(sessionId, "cooling_down");
			return { did: "err", errorSubType: subType };
		}

		// Charge the spend cap against the actual usage.
		if (costCents > 0) await addSpendCents(sessionId, costCents);

		// Parse.
		let parsed = parseDecision(responseText);
		if (!parsed.ok) {
			// One retry on schema violation; just downgrade on syntax errors.
			if (parsed.schemaViolation) {
				try {
					const retry = await adapter.complete({
						systemPrompt: ctx.systemPrompt,
						transcriptPrompt: `${ctx.transcriptPrompt}\n\nRESPONSE PARSE ERROR: ${parsed.error}. Respond with exactly one JSON object per the schema. No prose.`,
						model: provider.model,
						disableReasoning: true,
						timeoutMs: config.watcherCallTimeoutSeconds * 1000,
						maxTokens: CONTINUE_MAX_TOKENS,
					});
					responseText = retry.text;
					if (retry.usage && !retry.usage.estimated) {
						usageInput += retry.usage.inputTokens;
						usageOutput += retry.usage.outputTokens;
					}
					const retryCost = priceCompletion(provider.kind, provider.model, retry.usage);
					if (retryCost > 0) await addSpendCents(sessionId, retryCost);
					costCents += retryCost;
					parsed = parseDecision(responseText);
				} catch (err) {
					// Fall through to downgrade below.
					if (err instanceof LlmError && err.usage) {
						const failedCost = priceCompletion(provider.kind, provider.model, err.usage);
						if (failedCost > 0) await addSpendCents(sessionId, failedCost);
					}
					console.warn(`[ai-watcher] ${sessionId} retry failed:`, err);
				}
			}
		}

		if (!parsed.ok) {
			// Final fallback: record the failure and downgrade to no-op "report".
			await completeProposal({
				id: pending.id,
				decision: "report",
				reportSummary: `Watcher output did not parse: ${parsed.error}`,
				rawResponse: { raw: responseText, parse_error: parsed.error },
				tokensIn: usageInput,
				tokensOut: usageOutput,
				costCents,
				usageEstimated,
				state: "failed",
			});
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_error",
				eventType: "ParseFailure",
				content: parsed.error,
				rawPayload: { sub_type: "parse_failure", proposal_id: pending.id },
			});
			await stampWatcherState(sessionId, "cooling_down");
			return { did: "err", errorSubType: "parse_failure" };
		}

		const decision = parsed.decision;

		// Route
		if (decision.decision === "wait") {
			await completeProposal({
				id: pending.id,
				decision: "wait",
				rawResponse: { raw: responseText },
				tokensIn: usageInput,
				tokensOut: usageOutput,
				costCents,
				usageEstimated,
			});
			await stampWatcherState(sessionId, "cooling_down");
			return { did: "proposal", proposalId: pending.id };
		}

		if (decision.decision === "stop") {
			await completeProposal({
				id: pending.id,
				decision: "stop",
				reportSummary: decision.why ?? null,
				rawResponse: { raw: responseText },
				tokensIn: usageInput,
				tokensOut: usageOutput,
				costCents,
				usageEstimated,
			});
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_proposal",
				eventType: "AiStop",
				content: decision.why ?? "Watcher decided to stop.",
				rawPayload: { proposal_id: pending.id, decision: "stop" },
			});
			await stampWatcherState(sessionId, "idle");
			return { did: "proposal", proposalId: pending.id };
		}

		if (decision.decision === "report") {
			await completeProposal({
				id: pending.id,
				decision: "report",
				reportSummary: decision.summary,
				rawResponse: {
					raw: responseText,
					status: decision.status,
					highlights: decision.highlights,
				},
				tokensIn: usageInput,
				tokensOut: usageOutput,
				costCents,
				usageEstimated,
			});
			await emitAiEvent({
				sessionId,
				source: "managed_control",
				category: "ai_report",
				eventType: "AiReport",
				content: decision.summary,
				rawPayload: {
					proposal_id: pending.id,
					status: decision.status,
					highlights: decision.highlights ?? [],
				},
			});
			await stampWatcherState(sessionId, "idle");
			return { did: "proposal", proposalId: pending.id };
		}

		const completion = {
			tokensIn: usageInput,
			tokensOut: usageOutput,
			costCents,
			usageEstimated,
		};
		await routeContinueOrAsk({
			sessionId,
			proposalId: pending.id,
			decision,
			responseText,
			completion,
			watchConfig,
			session: {
				displayName: (session.displayName as string | null) ?? null,
				cwd: (session.cwd as string | null) ?? null,
			},
			trigger,
			turnKey,
			recent,
			eligibility: elig,
		});
		return { did: "proposal", proposalId: pending.id };
	}
}

function derivedTrigger(trigger?: SessionEvent): WatcherRunTriggerKind {
	if (!trigger) return "manual";
	// A turn that ended (a hook Stop, or a managed turn's own end) and a session that ended.
	if (boundaryOf(trigger) === "turn_end" || trigger.eventType === "SessionEnd") return "stop";
	if (trigger.category === "plan_update") return "plan_completed";
	if (trigger.category === "ai_error") return "error";
	return "idle";
}

// Single instance used by server bootstrap.
export const watcherRunner = new WatcherRunner();

/**
 * Boot the watcher runner whenever the feature is compiled in. Runtime
 * toggle + kill-switch + per-session config are checked on every wake, so
 * the runner can stay live and react as soon as a user flips those on
 * without needing a server restart.
 */
export async function maybeStartWatcherRunner(): Promise<void> {
	if (!isAiBuildEnabled()) {
		console.log("[ai-watcher] feature not compiled in; runner idle");
		return;
	}
	await watcherRunner.start();
}

/**
 * Cancel all in-memory debounce timers — used by tests or kill-switch flip.
 *
 * Bracket-access on the private `scheduled` field is intentional: TS would
 * block a direct `.scheduled` here (private), but the bracket form is
 * allowed and leaves in-class encapsulation intact. Biome's
 * `useLiteralKeys` is lowered to warn elsewhere in this file via ignore.
 */
export function clearAllScheduled(): void {
	// biome-ignore lint/complexity/useLiteralKeys: private field escape hatch
	for (const entry of watcherRunner["scheduled"].values()) {
		clearTimeout(entry.handle as ReturnType<typeof setTimeout>);
	}
	// biome-ignore lint/complexity/useLiteralKeys: private field escape hatch
	watcherRunner["scheduled"].clear();
}
