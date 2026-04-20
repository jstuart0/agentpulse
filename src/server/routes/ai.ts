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
import {
	AI_CLASSIFIER_AFFECTS_RUNNER_KEY,
	AI_CLASSIFIER_ENABLED_KEY,
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	classifierAffectsRunner,
	isAiActive,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isClassifierEnabled,
	isKillSwitchActive,
} from "../services/ai/feature.js";
import { resolveHitlRequest, supersedeOpenHitl } from "../services/ai/hitl-service.js";
import { type InboxWorkItem, buildInbox } from "../services/ai/inbox-service.js";
import {
	intelligenceForSession,
	intelligenceForSessions,
} from "../services/ai/intelligence-service.js";
import type { ProviderKind } from "../services/ai/llm/types.js";
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
import { getTodaySpendCents } from "../services/ai/spend-service.js";
import {
	type WatcherPolicy,
	deleteWatcherConfig,
	getWatcherConfig,
	upsertWatcherConfig,
} from "../services/ai/watcher-config-service.js";

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

	// Phase 1: always force ask_always for observed sessions is done inside
	// the runner via continuability; we accept any policy here so the user
	// can toggle. But refuse "auto" unconditionally for Phase 1.
	if (body.policy === "auto") {
		return c.json({ error: "Autonomous policy not available in this build." }, 400);
	}

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

aiRouter.get("/ai/spend", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const cents = await getTodaySpendCents();
	return c.json({ date: new Date().toISOString().slice(0, 10), spendCents: cents });
});

export { aiRouter };
