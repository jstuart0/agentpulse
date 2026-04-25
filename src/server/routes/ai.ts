import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { emitAiEvent } from "../services/ai/ai-events.js";
import {
	buildDigest,
	getDailyDigest,
	invalidateDigestCache,
} from "../services/ai/digest-service.js";
import { checkDispatch } from "../services/ai/dispatch-filter.js";
import { getBackfillProgress, runBackfill } from "../services/ai/embeddings/embedding-service.js";
import {
	AI_CLASSIFIER_AFFECTS_RUNNER_KEY,
	AI_CLASSIFIER_ENABLED_KEY,
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	DEFAULT_EMBEDDING_MODEL,
	VECTOR_SEARCH_ENABLED_KEY,
	VECTOR_SEARCH_MODEL_KEY,
	VECTOR_SEARCH_PROVIDER_ID_KEY,
	classifierAffectsRunner,
	isAiActive,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isClassifierEnabled,
	isKillSwitchActive,
	isVectorSearchActive,
	isVectorSearchBuildEnabled,
} from "../services/ai/feature.js";
import { resolveHitlRequest, supersedeOpenHitl } from "../services/ai/hitl-service.js";
import { type InboxWorkItem, buildInbox } from "../services/ai/inbox-service.js";
import {
	type InboxKind,
	listActiveSnoozes,
	snoozeItem,
	unsnooze,
	unsnoozeTarget,
} from "../services/ai/inbox-snooze-service.js";
import {
	intelligenceForSession,
	intelligenceForSessions,
} from "../services/ai/intelligence-service.js";
import { listAvailableModels } from "../services/ai/llm/list-models.js";
import type { ProviderKind } from "../services/ai/llm/types.js";
import { emitAiMetric } from "../services/ai/metrics.js";
import {
	cancelOpenHitl,
	getProposal,
	listProposalsForSession,
	resolveProposalHitl,
} from "../services/ai/proposals-service.js";
import {
	createProvider,
	deleteProvider,
	getDefaultProvider,
	listProviders,
	updateProvider,
} from "../services/ai/providers-service.js";
import { parseUserRules, redactDryRun } from "../services/ai/redactor.js";
import { getRiskClasses, setRiskClasses } from "../services/ai/risk-classes.js";
import { getTodaySpendCents } from "../services/ai/spend-service.js";
import { distillTemplate, provenanceMetadata } from "../services/ai/template-distillation.js";
import {
	type WatcherPolicy,
	deleteWatcherConfig,
	getWatcherConfig,
	upsertWatcherConfig,
} from "../services/ai/watcher-config-service.js";
import { queueSnapshot } from "../services/ai/watcher-runs-service.js";

const aiRouter = new Hono();
aiRouter.use("*", requireAuth());

// A lightweight gate used on every mutation endpoint. Feature-state checks
// run on each request rather than at mount time so the runtime toggle flips
// without needing a restart.
async function requireAiBuild(c: Context) {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "ai_disabled", message: "AI feature not compiled in" }, 404);
	}
	return null;
}

async function requireAiActive(c: Context) {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "ai_disabled", message: "AI feature not compiled in" }, 404);
	}
	if (!(await isAiRuntimeEnabled())) {
		return c.json(
			{ error: "ai_disabled", message: "AI feature disabled. Enable in Settings." },
			409,
		);
	}
	if (await isKillSwitchActive()) {
		return c.json(
			{ error: "ai_paused", message: "All watchers are paused via the kill switch." },
			409,
		);
	}
	return null;
}

// --------------------------------------------------------------------------
// Feature status (always available, so UI can decide whether to show AI)
// --------------------------------------------------------------------------

aiRouter.get("/ai/status", async (c) => {
	const build = isAiBuildEnabled();
	const runtime = await isAiRuntimeEnabled();
	const killSwitch = await isKillSwitchActive();
	const active = await isAiActive();
	const classifierEnabled = await isClassifierEnabled();
	const classifierRunnerInput = await classifierAffectsRunner();
	return c.json({
		build,
		runtime,
		killSwitch,
		active,
		classifierEnabled,
		classifierAffectsRunner: classifierRunnerInput,
	});
});

aiRouter.put("/ai/status", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const body = await c.req.json<{
		enabled?: boolean;
		killSwitch?: boolean;
		classifierEnabled?: boolean;
		classifierAffectsRunner?: boolean;
	}>();
	const now = new Date().toISOString();

	const upsert = async (key: string, value: unknown) => {
		await db
			.insert(settings)
			.values({ key, value, updatedAt: now })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value, updatedAt: now },
			});
	};

	if (body.enabled !== undefined) await upsert(AI_RUNTIME_ENABLED_KEY, body.enabled);
	if (body.killSwitch !== undefined) await upsert(AI_KILL_SWITCH_KEY, body.killSwitch);
	if (body.classifierEnabled !== undefined) {
		await upsert(AI_CLASSIFIER_ENABLED_KEY, body.classifierEnabled);
	}
	if (body.classifierAffectsRunner !== undefined) {
		await upsert(AI_CLASSIFIER_AFFECTS_RUNNER_KEY, body.classifierAffectsRunner);
	}

	return c.json({
		build: isAiBuildEnabled(),
		runtime: await isAiRuntimeEnabled(),
		killSwitch: await isKillSwitchActive(),
		active: await isAiActive(),
		classifierEnabled: await isClassifierEnabled(),
		classifierAffectsRunner: await classifierAffectsRunner(),
	});
});

// --------------------------------------------------------------------------
// Vector search (semantic similarity over event embeddings)
// --------------------------------------------------------------------------

aiRouter.get("/ai/vector-search/status", async (c) => {
	const build = isVectorSearchBuildEnabled();
	const active = await isVectorSearchActive();
	const [enabledRow] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, VECTOR_SEARCH_ENABLED_KEY))
		.limit(1);
	const [modelRow] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, VECTOR_SEARCH_MODEL_KEY))
		.limit(1);
	const [providerRow] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, VECTOR_SEARCH_PROVIDER_ID_KEY))
		.limit(1);
	const progress = build ? await getBackfillProgress() : null;
	return c.json({
		build,
		active,
		enabled: enabledRow?.value === true,
		model: (modelRow?.value as string | undefined) ?? DEFAULT_EMBEDDING_MODEL,
		providerId: (providerRow?.value as string | undefined) ?? null,
		progress,
	});
});

aiRouter.put("/ai/vector-search/status", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	if (!isVectorSearchBuildEnabled()) {
		return c.json({ error: "Vector search build flag is off." }, 400);
	}
	const body = await c.req.json<{
		enabled?: boolean;
		model?: string | null;
		providerId?: string | null;
	}>();
	const now = new Date().toISOString();
	const upsert = async (key: string, value: unknown) => {
		await db
			.insert(settings)
			.values({ key, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
	};
	if (body.enabled !== undefined) await upsert(VECTOR_SEARCH_ENABLED_KEY, body.enabled);
	if (body.model !== undefined) {
		await upsert(VECTOR_SEARCH_MODEL_KEY, body.model || DEFAULT_EMBEDDING_MODEL);
	}
	if (body.providerId !== undefined) {
		await upsert(VECTOR_SEARCH_PROVIDER_ID_KEY, body.providerId ?? "");
	}
	const progress = await getBackfillProgress();
	return c.json({
		build: isVectorSearchBuildEnabled(),
		active: await isVectorSearchActive(),
		progress,
	});
});

aiRouter.post("/ai/vector-search/rebuild", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	if (!isVectorSearchBuildEnabled()) {
		return c.json({ error: "Vector search build flag is off." }, 400);
	}
	// Fire-and-forget so the request returns fast; clients poll
	// /ai/vector-search/status for progress.
	void runBackfill();
	return c.json({ ok: true, started: true });
});

// --------------------------------------------------------------------------
// Session intelligence (Phase 2 classifier)
// --------------------------------------------------------------------------

aiRouter.get("/ai/sessions/:sessionId/intelligence", async (c) => {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "ai_disabled" }, 404);
	}
	if (!(await isClassifierEnabled())) {
		return c.json({ error: "classifier_disabled" }, 409);
	}
	const sessionId = c.req.param("sessionId") ?? "";
	const intel = await intelligenceForSession(sessionId);
	if (!intel) return c.json({ error: "Session not found" }, 404);
	return c.json({ intelligence: intel });
});

aiRouter.post("/ai/intelligence/batch", async (c) => {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "ai_disabled" }, 404);
	}
	if (!(await isClassifierEnabled())) {
		return c.json({ intelligence: {} });
	}
	const body = await c.req.json<{ sessionIds: string[] }>();
	const ids = Array.isArray(body.sessionIds) ? body.sessionIds.slice(0, 200) : [];
	const map = await intelligenceForSessions(ids);
	const out: Record<string, unknown> = {};
	for (const [id, intel] of map) out[id] = intel;
	return c.json({ intelligence: out });
});

// --------------------------------------------------------------------------
// Operator inbox (Phase 3)
// --------------------------------------------------------------------------

aiRouter.get("/ai/inbox", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const kindsParam = c.req.query("kinds");
	const sessionId = c.req.query("sessionId") ?? undefined;
	const severityParam = c.req.query("severity");
	const limit = Number(c.req.query("limit") ?? "100");
	const kinds: InboxWorkItem["kind"][] | undefined = kindsParam
		? (kindsParam.split(",").filter(Boolean) as InboxWorkItem["kind"][])
		: undefined;
	const severity =
		severityParam === "high" || severityParam === "normal" ? severityParam : undefined;
	const inbox = await buildInbox({
		kinds,
		sessionId,
		severity,
		limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100,
	});
	return c.json(inbox);
});

aiRouter.post("/ai/inbox/hitl/:id/decide", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		action: "approve" | "decline" | "custom";
		customPrompt?: string;
	}>();
	const resolved = await resolveHitlRequest({
		id,
		status: body.action === "decline" ? "declined" : "applied",
		replyKind: body.action,
		replyText: body.action === "custom" ? (body.customPrompt ?? null) : null,
	});
	if (!resolved) return c.json({ error: "hitl not found" }, 404);
	return c.json({ hitl: resolved });
});

// --------------------------------------------------------------------------
// Project digest (Phase 4)
// --------------------------------------------------------------------------

aiRouter.get("/ai/digest", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const fresh = c.req.query("fresh") === "1";
	const digest = fresh ? await buildDigest() : await getDailyDigest();
	return c.json(digest);
});

aiRouter.post("/ai/digest/refresh", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	invalidateDigestCache();
	const digest = await buildDigest();
	return c.json(digest);
});

// --------------------------------------------------------------------------
// Risk classes (Phase 7)
// --------------------------------------------------------------------------

aiRouter.get("/ai/risk-classes", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const config = await getRiskClasses();
	return c.json(config);
});

aiRouter.put("/ai/risk-classes", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{
		version: number;
		classes: Array<{
			id: string;
			label: string;
			match: Record<string, unknown>;
			policyOverride: "ask" | "stop";
		}>;
	}>();
	if (!body || !Array.isArray(body.classes)) {
		return c.json({ error: "Invalid risk class config" }, 400);
	}
	await setRiskClasses(body as Parameters<typeof setRiskClasses>[0]);
	return c.json(await getRiskClasses());
});

// --------------------------------------------------------------------------
// Template distillation (Phase 5)
// --------------------------------------------------------------------------

aiRouter.post("/ai/templates/distill", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const body = await c.req.json<{
		sessionId: string;
		baseTemplateId?: string | null;
		providerId?: string | null;
		model?: string | null;
	}>();
	if (!body.sessionId) return c.json({ error: "sessionId required" }, 400);
	const draft = await distillTemplate({
		sessionId: body.sessionId,
		baseTemplateId: body.baseTemplateId ?? null,
		providerId: body.providerId ?? null,
		model: body.model ?? null,
	});
	if (!draft) return c.json({ error: "session not found" }, 404);
	return c.json({
		draft,
		provenance: provenanceMetadata(draft, body.baseTemplateId ?? null),
	});
});

const INBOX_KINDS: InboxKind[] = ["hitl", "stuck", "risky", "failed_proposal"];

aiRouter.get("/ai/inbox/snoozes", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const rows = await listActiveSnoozes();
	return c.json({ snoozes: rows });
});

aiRouter.post("/ai/inbox/snooze", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const body = await c.req.json<{
		kind: InboxKind;
		targetId: string;
		durationMs: number;
		reason?: string | null;
	}>();
	if (!INBOX_KINDS.includes(body.kind)) {
		return c.json({ error: "invalid kind" }, 400);
	}
	if (!body.targetId) {
		return c.json({ error: "targetId required" }, 400);
	}
	const duration = Number(body.durationMs);
	if (!Number.isFinite(duration) || duration <= 0) {
		return c.json({ error: "durationMs must be a positive number" }, 400);
	}
	// Cap at 30 days so a misclick can't mute an inbox item forever.
	const capped = Math.min(duration, 30 * 24 * 60 * 60 * 1000);
	const until = new Date(Date.now() + capped);
	const snooze = await snoozeItem({
		kind: body.kind,
		targetId: body.targetId,
		until,
		reason: body.reason ?? null,
	});
	return c.json({ snooze });
});

aiRouter.delete("/ai/inbox/snooze/:id", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const ok = await unsnooze(id);
	if (!ok) return c.json({ error: "snooze not found" }, 404);
	return c.json({ ok: true });
});

aiRouter.delete("/ai/inbox/snooze", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const kind = c.req.query("kind") as InboxKind | undefined;
	const targetId = c.req.query("targetId");
	if (!kind || !INBOX_KINDS.includes(kind) || !targetId) {
		return c.json({ error: "kind + targetId required" }, 400);
	}
	const ok = await unsnoozeTarget(kind, targetId);
	return c.json({ ok });
});

/**
 * Batch decline / snooze is the only safe batch action per the plan.
 * Approve-all is intentionally not available.
 */
aiRouter.post("/ai/inbox/batch-decline", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{ hitlIds?: string[]; sessionIds?: string[] }>();
	let closed = 0;
	for (const hid of body.hitlIds ?? []) {
		const r = await resolveHitlRequest({
			id: hid,
			status: "declined",
			replyKind: "decline",
		});
		if (r) closed++;
	}
	for (const sid of body.sessionIds ?? []) {
		closed += await supersedeOpenHitl(sid);
	}
	return c.json({ closed });
});

// --------------------------------------------------------------------------
// Providers
// --------------------------------------------------------------------------

aiRouter.get("/ai/providers", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const providers = await listProviders();
	const defaultProvider = await getDefaultProvider();
	return c.json({ providers, defaultProviderId: defaultProvider?.id ?? null });
});

const PROVIDER_KINDS: ProviderKind[] = [
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"openai_compatible",
];

aiRouter.post("/ai/providers", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{
		name: string;
		kind: ProviderKind;
		model: string;
		baseUrl?: string;
		apiKey: string;
		isDefault?: boolean;
	}>();

	if (!body.name || !body.kind || !body.model || !body.apiKey) {
		return c.json({ error: "Missing required fields" }, 400);
	}
	if (!PROVIDER_KINDS.includes(body.kind)) {
		return c.json({ error: `Unknown provider kind: ${body.kind}` }, 400);
	}

	const provider = await createProvider(body);
	return c.json({ provider }, 201);
});

/**
 * Pre-save model discovery. Takes the same connection details the
 * create/update forms use and asks the target server what models it
 * has loaded — so the user picks from a real list instead of guessing
 * the exact id their Ollama / LM Studio / OpenRouter install exposes.
 * Nothing is persisted here; the caller still needs to POST back to
 * /ai/providers with the chosen model.
 */
aiRouter.post("/ai/providers/probe-models", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{
		kind: ProviderKind;
		baseUrl?: string;
		apiKey?: string;
	}>();
	if (!body.kind || !PROVIDER_KINDS.includes(body.kind)) {
		return c.json({ error: `Unknown provider kind: ${body.kind}` }, 400);
	}
	const result = await listAvailableModels({
		kind: body.kind,
		baseUrl: body.baseUrl,
		apiKey: body.apiKey ?? "",
	});
	if (!result.ok) {
		// Preserve the upstream status when it's a 4xx so the UI can tell
		// auth failures apart from network failures; everything else is a
		// 502 because the problem is downstream of AgentPulse.
		const status: 400 | 401 | 403 | 404 | 502 =
			result.status === 401
				? 401
				: result.status === 403
					? 403
					: result.status === 404
						? 404
						: result.status && result.status >= 400 && result.status < 500
							? 400
							: 502;
		return c.json({ error: result.error }, status);
	}
	return c.json({ models: result.models });
});

aiRouter.put("/ai/providers/:id", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		name?: string;
		model?: string;
		baseUrl?: string;
		apiKey?: string;
		isDefault?: boolean;
	}>();
	const provider = await updateProvider(id, body);
	if (!provider) return c.json({ error: "Provider not found" }, 404);
	return c.json({ provider });
});

aiRouter.delete("/ai/providers/:id", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const deleted = await deleteProvider(id);
	if (!deleted) return c.json({ error: "Provider not found" }, 404);
	return c.json({ ok: true });
});

// --------------------------------------------------------------------------
// Watcher configs (per session)
// --------------------------------------------------------------------------

aiRouter.get("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	const config = await getWatcherConfig(sessionId);
	const proposals = await listProposalsForSession(sessionId, 20);
	return c.json({ config, proposals });
});

aiRouter.put("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	const body = await c.req.json<{
		enabled?: boolean;
		providerId?: string;
		policy?: WatcherPolicy;
		channelId?: string | null;
		maxContinuations?: number;
		maxDailyCents?: number | null;
		systemPrompt?: string | null;
	}>();

	// Phase 7: auto policy is allowed but gated. The runner itself enforces
	// that auto-dispatch only happens when the session is managed and the
	// supervisor is live; all other cases fall back to HITL. We accept the
	// policy here without forcing additional checks — the runner is the
	// authoritative gate.

	const config = await upsertWatcherConfig({ sessionId, ...body });
	return c.json({ config });
});

aiRouter.delete("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	await cancelOpenHitl(sessionId, "watcher_removed");
	const deleted = await deleteWatcherConfig(sessionId);
	if (!deleted) return c.json({ error: "Watcher not configured" }, 404);
	return c.json({ ok: true });
});

// --------------------------------------------------------------------------
// HITL approve / decline / custom
// --------------------------------------------------------------------------

aiRouter.post("/ai/proposals/:id/decision", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		action: "approve" | "decline" | "custom";
		customPrompt?: string;
	}>();

	const proposal = await getProposal(id);
	if (!proposal) return c.json({ error: "Proposal not found" }, 404);
	if (proposal.state !== "hitl_waiting") {
		return c.json({ error: `Proposal state is ${proposal.state}, not awaiting a response` }, 409);
	}

	const nextPrompt =
		body.action === "custom"
			? (body.customPrompt ?? "").trim()
			: body.action === "approve"
				? (proposal.nextPrompt ?? "")
				: null;

	if (body.action !== "decline") {
		if (!nextPrompt) {
			return c.json({ error: "Empty prompt" }, 400);
		}
		const filter = checkDispatch(nextPrompt);
		if (!filter.allowed) {
			await emitAiEvent({
				sessionId: proposal.sessionId,
				category: "ai_continue_blocked",
				eventType: "AiContinueBlocked",
				content: `Dispatch filter tripped on human-approved prompt: ${filter.reason}`,
				rawPayload: { proposal_id: id, rule: filter.rule },
			});
			return c.json({ error: `Prompt rejected by safety filter: ${filter.rule}` }, 400);
		}
	}

	if (body.action === "decline") {
		await resolveProposalHitl({ proposalId: id, action: "decline" });
		await emitAiEvent({
			sessionId: proposal.sessionId,
			category: "ai_hitl_response",
			eventType: "AiHitlResponse",
			content: "Declined by user.",
			rawPayload: { proposal_id: id, action: "decline" },
		});
		return c.json({ ok: true, dispatched: false });
	}

	// approve / custom — emit ai_continue_sent audit event.
	// NB: Actual dispatch into a managed session via the control-actions
	// queue is Phase 3+ scope. Phase 1 surfaces the approved prompt as an
	// event so the user can see what would have been sent and, for
	// managed sessions, copy/paste or kick off manually.
	await resolveProposalHitl({ proposalId: id, action: body.action, replyText: nextPrompt });
	await emitAiEvent({
		sessionId: proposal.sessionId,
		category: "ai_hitl_response",
		eventType: "AiHitlResponse",
		content: body.action === "custom" ? `Custom: ${nextPrompt}` : "Approved.",
		rawPayload: { proposal_id: id, action: body.action },
	});
	await emitAiEvent({
		sessionId: proposal.sessionId,
		category: "ai_continue_sent",
		eventType: "AiContinueSent",
		content: nextPrompt ?? "",
		rawPayload: { proposal_id: id, action: body.action },
	});

	return c.json({ ok: true, dispatched: true, prompt: nextPrompt });
});

// --------------------------------------------------------------------------
// Redactor dry-run (for the "preview before enabling" UX)
// --------------------------------------------------------------------------

aiRouter.post("/ai/redactor/dry-run", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const body = await c.req.json<{ sample: string; userRules?: unknown }>();
	if (typeof body.sample !== "string") {
		return c.json({ error: "sample must be a string" }, 400);
	}
	const userRules = parseUserRules(body.userRules);
	const result = redactDryRun(body.sample, userRules);
	return c.json(result);
});

// --------------------------------------------------------------------------
// Spend summary
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Diagnostics (Phase 8)
// --------------------------------------------------------------------------

aiRouter.get("/ai/diagnostics", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const snap = await queueSnapshot();
	emitAiMetric({
		name: "watcher_run_queued",
		sessionId: "__diagnostics__",
		runId: "snapshot",
		attempt: 0,
	});
	const todayISO = new Date().toISOString().slice(0, 10);
	return c.json({
		generatedAt: new Date().toISOString(),
		queue: snap,
		today: todayISO,
		flags: {
			build: isAiBuildEnabled(),
			runtime: await isAiRuntimeEnabled(),
			killSwitch: await isKillSwitchActive(),
			classifierEnabled: await isClassifierEnabled(),
			classifierAffectsRunner: await classifierAffectsRunner(),
		},
		otel: {
			endpoint: process.env.AGENTPULSE_OTEL_ENDPOINT ? "configured" : "none",
		},
	});
});

aiRouter.get("/ai/spend", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const cents = await getTodaySpendCents();
	return c.json({ date: new Date().toISOString().slice(0, 10), spendCents: cents });
});

export { aiRouter };
