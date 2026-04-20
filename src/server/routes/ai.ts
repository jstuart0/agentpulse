import { Hono } from "hono";
import type { Context } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { emitAiEvent } from "../services/ai/ai-events.js";
import { checkDispatch } from "../services/ai/dispatch-filter.js";
import {
	AI_KILL_SWITCH_KEY,
	AI_RUNTIME_ENABLED_KEY,
	isAiActive,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isKillSwitchActive,
} from "../services/ai/feature.js";
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
	return c.json({ build, runtime, killSwitch, active });
});

aiRouter.put("/ai/status", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const body = await c.req.json<{ enabled?: boolean; killSwitch?: boolean }>();
	const now = new Date().toISOString();

	if (body.enabled !== undefined) {
		await db
			.insert(settings)
			.values({ key: AI_RUNTIME_ENABLED_KEY, value: body.enabled, updatedAt: now })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: body.enabled, updatedAt: now },
			});
	}
	if (body.killSwitch !== undefined) {
		await db
			.insert(settings)
			.values({ key: AI_KILL_SWITCH_KEY, value: body.killSwitch, updatedAt: now })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: body.killSwitch, updatedAt: now },
			});
	}

	return c.json({
		build: isAiBuildEnabled(),
		runtime: await isAiRuntimeEnabled(),
		killSwitch: await isKillSwitchActive(),
		active: await isAiActive(),
	});
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
