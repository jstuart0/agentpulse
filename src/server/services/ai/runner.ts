import { eq } from "drizzle-orm";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { managedSessions, sessions, supervisors } from "../../db/schema.js";
import { sessionBus } from "../notifier.js";
import { emitAiEvent, loadRecentEvents, stampUserPrompt, stampWatcherState } from "./ai-events.js";
import { buildWatcherContext } from "./context.js";
import { classifyContinuability } from "./continuability.js";
import { checkDispatch } from "./dispatch-filter.js";
import { classifierAffectsRunner, isAiActive, isAiBuildEnabled } from "./feature.js";
import { intelligenceForSession } from "./intelligence-service.js";
import { priceCompletion } from "./llm/pricing.js";
import { getAdapter } from "./llm/registry.js";
import { LlmError } from "./llm/types.js";
import { emitAiMetric } from "./metrics.js";
import { parseDecision } from "./parser.js";
import { RunLeaser } from "./run-leaser.js";
import {
	cancelOpenHitl,
	completeProposal,
	completeProposalAsHitl,
	createPendingProposal,
	failProposal,
} from "./proposals-service.js";
import { getProvider, getProviderApiKey } from "./providers-service.js";
import { evaluateRisk, getRiskClasses } from "./risk-classes.js";
import { addSpendCents, checkSpendBudget } from "./spend-service.js";
import { getWatcherConfig } from "./watcher-config-service.js";
import {
	type WatcherRunRecord,
	type WatcherRunTriggerKind,
	enqueueRun,
	markCancelled,
	markFailed,
	markRunning,
	markSucceeded,
} from "./watcher-runs-service.js";

const DEBOUNCE_MS = 1_500;
const MAX_EVENTS_LOOKBACK = 80;
const LEASE_DURATION_MS = 60_000;
const LEASE_POLL_INTERVAL_MS = 500;

interface ScheduledRun {
	timer: ReturnType<typeof setTimeout>;
	lastTriggerId?: number;
	lastTriggerKind: WatcherRunTriggerKind;
}

/**
 * AI watcher runner. Subscribes to the in-process session bus, debounces
 * per-session wake-ups, and orchestrates the LLM call → parse → route
 * pipeline per the plan.
 *
 * Phase 1 AI control-plane: wakes are persisted to `ai_watcher_runs` and
 * picked up by a lease-based poller so work survives process restart. The
 * in-process debounce still coalesces rapid-fire events; once the debounce
 * fires we enqueue a durable row and let the leaser drive execution.
 */
export class WatcherRunner {
	private readonly scheduled = new Map<string, ScheduledRun>();
	private readonly inFlight = new Set<string>();
	private started = false;
	private readonly leaseOwner = `watcher-${process.pid}-${Date.now()}`;
	private readonly leaser = new RunLeaser({
		leaseOwner: this.leaseOwner,
		leaseDurationMs: LEASE_DURATION_MS,
		intervalMs: LEASE_POLL_INTERVAL_MS,
		processRun: (run) => this.processRun(run),
	});

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		sessionBus.on("session_event", ({ sessionId, event }) => {
			// Stamp user prompts immediately so race-control can see them even
			// if the watcher was mid-call when the prompt landed.
			if (event.category === "prompt") {
				void stampUserPrompt(sessionId);
			}
			this.scheduleWake(sessionId, event);
		});

		sessionBus.on("session_updated", (session) => {
			this.scheduleWake(session.sessionId);
		});

		await this.leaser.start();
		console.log("[ai-watcher] runner started");
	}

	stop(): void {
		this.leaser.stop();
		for (const entry of this.scheduled.values()) clearTimeout(entry.timer);
		this.scheduled.clear();
		this.started = false;
	}

	/** Schedule or reset the per-session debounce timer. */
	private scheduleWake(sessionId: string, trigger?: SessionEvent): void {
		const existing = this.scheduled.get(sessionId);
		if (existing) clearTimeout(existing.timer);

		const triggerKind = derivedTrigger(trigger);
		const triggerEventId = trigger?.id ?? null;

		const timer = setTimeout(() => {
			this.scheduled.delete(sessionId);
			// Enqueue is fire-and-forget; the leaser will pick it up.
			void enqueueRun({
				sessionId,
				triggerEventId,
				triggerKind,
			})
				.then((run) => {
					emitAiMetric({
						name: "watcher_run_queued",
						sessionId,
						runId: run.id,
						attempt: run.attemptCount,
					});
				})
				.catch((err) => {
					console.error(`[ai-watcher] enqueue failed for ${sessionId}:`, err);
				});
		}, DEBOUNCE_MS);
		this.scheduled.set(sessionId, {
			timer,
			lastTriggerId: trigger?.id,
			lastTriggerKind: triggerKind,
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
		try {
			const result = await this.evaluateInner(sessionId, run);
			if (result.kind === "ok") {
				await markSucceeded({ id: run.id, proposalId: result.proposalId ?? null });
				emitAiMetric({
					name: "watcher_run_completed",
					sessionId,
					runId: run.id,
					outcome: "succeeded",
					durationMs: Date.now() - startedAt,
				});
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
		}
	}

	private async evaluateInner(
		sessionId: string,
		run: WatcherRunRecord,
	): Promise<{ kind: "ok"; proposalId?: string | null } | { kind: "err"; errorSubType: string }> {
		const config = await getWatcherConfig(sessionId);
		if (!config || !config.enabled) return { kind: "ok" };

		// Cap check up front — no point hitting the LLM if we can't act.
		if (config.continuationsUsed >= config.maxContinuations) {
			await stampWatcherState(sessionId, "cooling_down");
			return { kind: "ok" };
		}

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!session) return { kind: "ok" };
		const recent = await loadRecentEvents(sessionId, MAX_EVENTS_LOOKBACK);

		// Continuability — deliberately generous about "report". Even when
		// we can't dispatch, we often want to summarize for the user.
		const managed = await loadManagedContext(sessionId);
		const elig = classifyContinuability({
			session: session as unknown as Session,
			recentEvents: recent,
			managedSession: managed?.managedSession,
			supervisorConnected: managed?.supervisorConnected ?? true,
		});

		if (!elig.eligibleToContinue && !elig.eligibleToReport) {
			return { kind: "ok" };
		}

		// Budget pre-flight (point-query, cheap).
		const spend = await checkSpendBudget("local", config.maxDailyCents, 0);
		if (!spend.allowed) {
			await stampWatcherState(sessionId, "cooling_down");
			await emitAiEvent({
				sessionId,
				category: "ai_error",
				eventType: "SpendCapReached",
				content: spend.reason ?? "Daily spend cap reached",
				rawPayload: { sub_type: "spend_cap", cap: spend.cap, spent: spend.spent },
			});
			return { kind: "err", errorSubType: "spend_cap" };
		}

		const provider = await getProvider(config.providerId);
		if (!provider) {
			await emitAiEvent({
				sessionId,
				category: "ai_error",
				eventType: "ProviderMissing",
				content: `Configured provider ${config.providerId} no longer exists`,
				rawPayload: { sub_type: "permanent_validation" },
			});
			return { kind: "err", errorSubType: "permanent_validation" };
		}

		await stampWatcherState(sessionId, "thinking");

		// Phase 1 of two-phase recording: a pending row lands BEFORE the LLM
		// call so a crash mid-request is visible.
		const triggerForContext = triggerEventFromRun(run, recent);
		const pending = await createPendingProposal({
			sessionId,
			providerId: provider.id,
			triggerEventId: triggerForContext ? String(triggerForContext.id) : null,
		});
		await emitAiEvent({
			sessionId,
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
			customSystemPrompt: config.systemPrompt,
			intelligenceHint,
		});

		const apiKey = await getProviderApiKey(provider.id);
		if (!apiKey) {
			await failProposal({
				id: pending.id,
				errorSubType: "permanent_validation",
				errorMessage: "Provider credential decryption failed",
			});
			await emitAiEvent({
				sessionId,
				category: "ai_error",
				eventType: "CredentialFailure",
				content: "Provider credential could not be decrypted",
				rawPayload: { sub_type: "permanent_validation" },
			});
			await stampWatcherState(sessionId, "disabled_due_to_error");
			return { kind: "err", errorSubType: "permanent_validation" };
		}

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
			});
			responseText = res.text;
			usageInput = res.usage.inputTokens;
			usageOutput = res.usage.outputTokens;
			usageEstimated = res.usage.estimated;
			costCents = priceCompletion(provider.kind, provider.model, res.usage);
		} catch (err) {
			const subType = err instanceof LlmError ? err.subType : "unknown";
			const message = err instanceof Error ? err.message : String(err);
			await failProposal({ id: pending.id, errorSubType: subType, errorMessage: message });
			await emitAiEvent({
				sessionId,
				category: "ai_error",
				eventType: "ProviderError",
				content: message,
				rawPayload: { sub_type: subType, proposal_id: pending.id },
			});
			await stampWatcherState(sessionId, "cooling_down");
			return { kind: "err", errorSubType: subType };
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
				category: "ai_error",
				eventType: "ParseFailure",
				content: parsed.error,
				rawPayload: { sub_type: "parse_failure", proposal_id: pending.id },
			});
			await stampWatcherState(sessionId, "cooling_down");
			return { kind: "err", errorSubType: "parse_failure" };
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
			return { kind: "ok", proposalId: pending.id };
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
				category: "ai_proposal",
				eventType: "AiStop",
				content: decision.why ?? "Watcher decided to stop.",
				rawPayload: { proposal_id: pending.id, decision: "stop" },
			});
			await stampWatcherState(sessionId, "idle");
			return { kind: "ok", proposalId: pending.id };
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
			return { kind: "ok", proposalId: pending.id };
		}

		// continue or ask → filter, downgrade continue to ask if needed or if filter trips
		let nextPrompt: string | null = null;
		let askProposal: string | null = null;
		let askWhy: string | undefined;

		if (decision.decision === "continue") {
			// Observed / policy demands approval / filter tripped → ask
			const filter = checkDispatch(decision.nextPrompt);
			if (!elig.eligibleToContinue) {
				askProposal = decision.nextPrompt;
				askWhy = `Session is ${elig.reason}; proposed prompt shown for manual paste.`;
			} else if (!filter.allowed) {
				await emitAiEvent({
					sessionId,
					category: "ai_continue_blocked",
					eventType: "AiContinueBlocked",
					content: `Dispatch filter tripped: ${filter.reason}`,
					rawPayload: {
						proposal_id: pending.id,
						rule: filter.rule,
						proposed_prompt: decision.nextPrompt,
					},
				});
				askProposal = decision.nextPrompt;
				askWhy = `Auto-dispatch blocked by safety filter (${filter.rule}). Approve explicitly to send.`;
			} else if (config.policy === "ask_on_risk") {
				// Phase 7: evaluate configured risk classes and escalate on any hit.
				const riskConfig = await getRiskClasses();
				const hits = evaluateRisk(riskConfig, {
					proposedPrompt: decision.nextPrompt,
					recentToolEvents: recent.map((e) => ({
						category: e.category,
						toolResponse: e.toolResponse,
						source: e.source,
						eventType: e.eventType,
					})),
				});
				if (hits.length > 0) {
					askProposal = decision.nextPrompt;
					askWhy = `Risk class(es) matched: ${hits.map((h) => h.label).join(", ")}`;
					await emitAiEvent({
						sessionId,
						category: "ai_continue_blocked",
						eventType: "AiRiskBlocked",
						content: askWhy,
						rawPayload: {
							proposal_id: pending.id,
							risk_hits: hits,
						},
					});
				} else {
					nextPrompt = decision.nextPrompt;
				}
			} else if (config.policy === "auto") {
				// Phase 7: auto-dispatch is available only for explicitly-trusted
				// managed sessions where the supervisor is live. We still record
				// the ai_continue_sent event for audit; actual prompt delivery
				// remains the control-actions queue's responsibility.
				if (managed?.supervisorConnected) {
					nextPrompt = decision.nextPrompt;
				} else {
					askProposal = decision.nextPrompt;
					askWhy = "auto policy requires a connected supervisor; routing to HITL";
				}
			} else {
				// ask_always — current default.
				nextPrompt = decision.nextPrompt;
			}
		} else {
			askProposal = decision.proposal;
			askWhy = decision.why;
		}

		// Any prior open HITL is superseded when a newer one opens.
		await cancelOpenHitl(sessionId, "superseded");

		// Phase 7 auto-dispatch path. When the user has explicitly opted
		// into `auto`, the supervisor is live, no risk class tripped, and
		// the dispatch filter accepts the prompt, we skip HITL and record
		// an ai_continue_sent audit event immediately. The actual prompt
		// delivery into the managed session remains the control-actions
		// queue's job — this phase only lifts the HITL gate, not adds
		// new dispatch plumbing.
		const autoDispatch = config.policy === "auto" && nextPrompt !== null;
		if (autoDispatch) {
			await completeProposal({
				id: pending.id,
				decision: decision.decision,
				nextPrompt,
				reportSummary: null,
				rawResponse: { raw: responseText, decision, auto: true },
				tokensIn: usageInput,
				tokensOut: usageOutput,
				costCents,
				usageEstimated,
			});
			await emitAiEvent({
				sessionId,
				category: "ai_continue_sent",
				eventType: "AiContinueSent",
				content: nextPrompt ?? "",
				rawPayload: { proposal_id: pending.id, action: "auto" },
			});
			await stampWatcherState(sessionId, "idle");
			return { kind: "ok", proposalId: pending.id };
		}

		// Persist the proposal and open a durable HITL request. The
		// proposal's physical state is "complete" (the LLM work is done);
		// the HITL workflow lives in ai_hitl_requests and is surfaced as
		// "hitl_waiting" via derivation for UI compatibility.
		await completeProposalAsHitl({
			id: pending.id,
			decision: decision.decision,
			nextPrompt,
			reportSummary: null,
			rawResponse: { raw: responseText, decision },
			tokensIn: usageInput,
			tokensOut: usageOutput,
			costCents,
			usageEstimated,
			channelId: config.channelId ?? null,
		});

		await emitAiEvent({
			sessionId,
			category: "ai_proposal",
			eventType: "AiProposal",
			content: decision.decision === "continue" ? decision.nextPrompt : (askProposal ?? ""),
			rawPayload: {
				proposal_id: pending.id,
				decision: decision.decision,
				why: askWhy ?? null,
			},
		});

		await emitAiEvent({
			sessionId,
			category: "ai_hitl_request",
			eventType: "AiHitlRequest",
			content: nextPrompt ?? askProposal ?? "",
			rawPayload: {
				proposal_id: pending.id,
				why: askWhy ?? null,
				can_dispatch: nextPrompt !== null,
			},
		});

		await stampWatcherState(sessionId, "awaiting_human");
		return { kind: "ok", proposalId: pending.id };
	}
}

function derivedTrigger(trigger?: SessionEvent): WatcherRunTriggerKind {
	if (!trigger) return "manual";
	if (trigger.eventType === "Stop" || trigger.eventType === "SessionEnd") return "stop";
	if (trigger.category === "plan_update") return "plan_completed";
	if (trigger.category === "ai_error") return "error";
	return "idle";
}

function triggerEventFromRun(
	run: WatcherRunRecord,
	recent: SessionEvent[],
): SessionEvent | undefined {
	if (!run.triggerEventId) return undefined;
	return recent.find((e) => e.id === run.triggerEventId);
}

async function loadManagedContext(
	sessionId: string,
): Promise<{ managedSession: { managedState: string }; supervisorConnected: boolean } | null> {
	const [managedRow] = await db
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managedRow) return null;
	const [sup] = await db
		.select({ status: supervisors.status })
		.from(supervisors)
		.where(eq(supervisors.id, managedRow.supervisorId))
		.limit(1);
	return {
		managedSession: { managedState: managedRow.managedState },
		supervisorConnected: sup?.status === "connected",
	};
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

/** Cancel all in-memory debounce timers — used by tests or kill-switch flip. */
export function clearAllScheduled(): void {
	for (const entry of watcherRunner["scheduled"].values()) {
		clearTimeout(entry.timer);
	}
	watcherRunner["scheduled"].clear();
}
