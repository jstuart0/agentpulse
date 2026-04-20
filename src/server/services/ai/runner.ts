import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions, managedSessions, supervisors } from "../../db/schema.js";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { sessionBus } from "../notifier.js";
import { isAiActive, isAiBuildEnabled } from "./feature.js";
import { buildWatcherContext } from "./context.js";
import { classifyContinuability } from "./continuability.js";
import { parseDecision } from "./parser.js";
import { checkDispatch } from "./dispatch-filter.js";
import {
	emitAiEvent,
	loadRecentEvents,
	stampUserPrompt,
	stampWatcherState,
} from "./ai-events.js";
import {
	getWatcherConfig,
	incrementContinuations,
} from "./watcher-config-service.js";
import {
	getProvider,
	getProviderApiKey,
} from "./providers-service.js";
import {
	cancelOpenHitl,
	completeProposal,
	createPendingProposal,
	failProposal,
	setProposalState,
} from "./proposals-service.js";
import { addSpendCents, checkSpendBudget } from "./spend-service.js";
import { getAdapter } from "./llm/registry.js";
import { priceCompletion } from "./llm/pricing.js";
import { LlmError } from "./llm/types.js";

const DEBOUNCE_MS = 1_500;
const MAX_EVENTS_LOOKBACK = 80;

interface ScheduledRun {
	timer: ReturnType<typeof setTimeout>;
	lastTriggerId?: number;
}

/**
 * AI watcher runner. Subscribes to the in-process session bus, debounces
 * per-session wake-ups, and orchestrates the LLM call → parse → route
 * pipeline per the plan.
 *
 * Phase 1 scope: in-app HITL only. Even when the LLM says "continue" and
 * the session is eligible, the runner opens a HITL request; the server's
 * approve/decline endpoints handle the actual dispatch.
 */
export class WatcherRunner {
	private readonly scheduled = new Map<string, ScheduledRun>();
	private readonly inFlight = new Set<string>();
	private started = false;

	start(): void {
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

		console.log("[ai-watcher] runner started");
	}

	/** Schedule or reset the per-session debounce timer. */
	private scheduleWake(sessionId: string, trigger?: SessionEvent): void {
		const existing = this.scheduled.get(sessionId);
		if (existing) clearTimeout(existing.timer);

		const timer = setTimeout(() => {
			this.scheduled.delete(sessionId);
			void this.evaluate(sessionId, trigger).catch((err) => {
				console.error(`[ai-watcher] ${sessionId} eval failed:`, err);
			});
		}, DEBOUNCE_MS);
		this.scheduled.set(sessionId, { timer, lastTriggerId: trigger?.id });
	}

	/** Main pipeline: preconditions → LLM → parse → route. */
	private async evaluate(sessionId: string, trigger?: SessionEvent): Promise<void> {
		if (!(await isAiActive())) return;

		// Skip if another evaluate is already running for this session — we
		// don't want two concurrent LLM calls stepping on each other's
		// pending proposals.
		if (this.inFlight.has(sessionId)) return;
		this.inFlight.add(sessionId);
		try {
			await this.evaluateInner(sessionId, trigger);
		} finally {
			this.inFlight.delete(sessionId);
		}
	}

	private async evaluateInner(sessionId: string, trigger?: SessionEvent): Promise<void> {
		const config = await getWatcherConfig(sessionId);
		if (!config || !config.enabled) return;

		// Cap check up front — no point hitting the LLM if we can't act.
		if (config.continuationsUsed >= config.maxContinuations) {
			await stampWatcherState(sessionId, "cooling_down");
			return;
		}

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!session) return;
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
			// No-op: session still working or no trigger.
			return;
		}

		// Budget pre-flight (point-query, cheap).
		const spend = await checkSpendBudget(
			"local",
			config.maxDailyCents,
			0,
		);
		if (!spend.allowed) {
			await stampWatcherState(sessionId, "cooling_down");
			await emitAiEvent({
				sessionId,
				category: "ai_error",
				eventType: "SpendCapReached",
				content: spend.reason ?? "Daily spend cap reached",
				rawPayload: { sub_type: "spend_cap", cap: spend.cap, spent: spend.spent },
			});
			return;
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
			return;
		}

		await stampWatcherState(sessionId, "thinking");

		// Phase 1 of two-phase recording: a pending row lands BEFORE the LLM
		// call so a crash mid-request is visible.
		const pending = await createPendingProposal({
			sessionId,
			providerId: provider.id,
			triggerEventId: trigger ? String(trigger.id) : null,
		});
		await emitAiEvent({
			sessionId,
			category: "ai_proposal_pending",
			eventType: "AiProposalPending",
			content: "Watcher thinking…",
			rawPayload: { proposal_id: pending.id },
		});

		// Build prompt, call LLM.
		const ctx = buildWatcherContext({
			session: session as unknown as Session,
			events: recent,
			triggerType: derivedTrigger(trigger),
			customSystemPrompt: config.systemPrompt,
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
			return;
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
			return;
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
						transcriptPrompt:
							`${ctx.transcriptPrompt}\n\nRESPONSE PARSE ERROR: ${parsed.error}. Respond with exactly one JSON object per the schema. No prose.`,
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
			return;
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
			return;
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
			return;
		}

		if (decision.decision === "report") {
			await completeProposal({
				id: pending.id,
				decision: "report",
				reportSummary: decision.summary,
				rawResponse: { raw: responseText, status: decision.status, highlights: decision.highlights },
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
			return;
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
			} else if (config.policy === "auto") {
				// Phase 1 never auto-dispatches — flag in rawResponse and route to HITL.
				nextPrompt = decision.nextPrompt;
			} else {
				nextPrompt = decision.nextPrompt;
			}
		} else {
			askProposal = decision.proposal;
			askWhy = decision.why;
		}

		// Any prior open HITL is superseded when a newer one opens.
		await cancelOpenHitl(sessionId, "superseded");

		await completeProposal({
			id: pending.id,
			decision: decision.decision,
			nextPrompt,
			reportSummary: null,
			rawResponse: { raw: responseText, decision },
			tokensIn: usageInput,
			tokensOut: usageOutput,
			costCents,
			usageEstimated,
			// Phase 1: everything parks as hitl_waiting. Phase 3 will auto-dispatch.
			state: "hitl_waiting",
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
	}
}

function derivedTrigger(trigger?: SessionEvent): "idle" | "stop" | "error" | "plan_completed" | "manual" {
	if (!trigger) return "manual";
	if (trigger.eventType === "Stop" || trigger.eventType === "SessionEnd") return "stop";
	if (trigger.category === "plan_update") return "plan_completed";
	if (trigger.category === "ai_error") return "error";
	return "idle";
}

async function loadManagedContext(sessionId: string): Promise<
	| { managedSession: { managedState: string }; supervisorConnected: boolean }
	| null
> {
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
	watcherRunner.start();
}

/** Cancel all in-memory debounce timers — used by tests or kill-switch flip. */
export function clearAllScheduled(): void {
	for (const entry of watcherRunner["scheduled"].values()) {
		clearTimeout(entry.timer);
	}
	watcherRunner["scheduled"].clear();
}
