import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { HitlReplyKind } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { sessions, settings } from "../db/schema/index.js";
import { getBackfillProgress, runBackfill } from "../services/ai/embeddings/embedding-service.js";
import {
	DEFAULT_EMBEDDING_MODEL,
	VECTOR_SEARCH_ENABLED_KEY,
	VECTOR_SEARCH_MODEL_KEY,
	VECTOR_SEARCH_PROVIDER_ID_KEY,
	isVectorSearchActive,
	isVectorSearchBuildEnabled,
} from "../services/ai/feature.js";
import {
	decideHitl,
	getDeliveryState,
	retryDelivery,
} from "../services/ai/hitl-decision-service.js";
import { cancelOpenHitl, listProposalsForSession } from "../services/ai/proposals-service.js";
import {
	type WatcherPolicy,
	deleteWatcherConfig,
	getWatcherConfig,
	upsertWatcherConfig,
} from "../services/ai/watcher-config-service.js";
import { notifyInboxChanged } from "../services/notifier.js";
import { upsertSetting } from "../services/settings-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";
import { decisionContextFor, refuseUnlessMayChange } from "./decision-context.js";

const aiWatcherRouter = new Hono();

// Shared helper: write a protected setting (AI control-plane keys) without
// requiring callers to repeat the options bag at every call site.
const upsert = (key: string, value: unknown) => upsertSetting(key, value, { allowProtected: true });

// --------------------------------------------------------------------------
// Vector search (semantic similarity over event embeddings)
// Per S-15: vector-search status lives here because vector search is a
// pipeline concern used by the watcher to enrich session context.
// --------------------------------------------------------------------------

aiWatcherRouter.get("/ai/vector-search/status", async (c) => {
	const build = isVectorSearchBuildEnabled();
	const active = await isVectorSearchActive();
	const rows = await getDb()
		.select()
		.from(settings)
		.where(
			inArray(settings.key, [
				VECTOR_SEARCH_ENABLED_KEY,
				VECTOR_SEARCH_MODEL_KEY,
				VECTOR_SEARCH_PROVIDER_ID_KEY,
			]),
		);
	const vsMap = new Map<string, unknown>();
	for (const row of rows) vsMap.set(row.key, row.value);
	const progress = build ? await getBackfillProgress() : null;
	return c.json({
		build,
		active,
		enabled: vsMap.get(VECTOR_SEARCH_ENABLED_KEY) === true,
		model: (vsMap.get(VECTOR_SEARCH_MODEL_KEY) as string | undefined) ?? DEFAULT_EMBEDDING_MODEL,
		providerId: (vsMap.get(VECTOR_SEARCH_PROVIDER_ID_KEY) as string | undefined) ?? null,
		progress,
	});
});

aiWatcherRouter.put("/ai/vector-search/status", async (c) => {
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

aiWatcherRouter.post("/ai/vector-search/rebuild", async (c) => {
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
// Watcher configs (per session)
// --------------------------------------------------------------------------

aiWatcherRouter.get("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	const config = await getWatcherConfig(sessionId);
	const proposals = await listProposalsForSession(sessionId, 20);
	return c.json({ config, proposals });
});

aiWatcherRouter.put("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	const refusal = await refuseUnlessMayChange(c, sessionId);
	if (refusal) return refusal;
	const [known] = await getDb()
		.select({ sessionId: sessions.sessionId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!known) return c.json({ error: "not_found", message: "Session not found" }, 404);
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

	if (!(await getWatcherConfig(sessionId)) && !body.providerId) {
		return c.json(
			{ error: "provider_required", message: "providerId is required to set up a watcher" },
			400,
		);
	}
	const config = await upsertWatcherConfig({ sessionId, ...body });
	return c.json({ config });
});

aiWatcherRouter.delete("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	const refusal = await refuseUnlessMayChange(c, sessionId);
	if (refusal) return refusal;
	const cancelled = await cancelOpenHitl(sessionId, "watcher_removed");
	if (cancelled > 0) notifyInboxChanged({ sessionId });
	const deleted = await deleteWatcherConfig(sessionId);
	if (!deleted) return c.json({ error: "Watcher not configured" }, 404);
	return c.json({ ok: true });
});

// --------------------------------------------------------------------------
// HITL approve / decline / custom (proposals)
// --------------------------------------------------------------------------

const PROMPT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const HITL_ACTIONS: readonly HitlReplyKind[] = ["approve", "decline", "custom"];

aiWatcherRouter.post("/ai/proposals/:id/decision", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		action: HitlReplyKind;
		customPrompt?: string;
		promptHash?: string;
	}>();
	if (!HITL_ACTIONS.includes(body?.action)) {
		return c.json(
			{ error: "invalid_action", message: "action must be approve, decline or custom" },
			400,
		);
	}
	if (body.promptHash !== undefined && !PROMPT_HASH_PATTERN.test(body.promptHash)) {
		return c.json(
			{ error: "invalid_prompt_hash", message: "promptHash must be 64 lowercase hex characters" },
			400,
		);
	}

	const outcome = await decideHitl(
		{ kind: "proposal", proposalId: id },
		body.action,
		{ customPrompt: body.customPrompt, promptHash: body.promptHash },
		await decisionContextFor(c),
	);
	if (!outcome.ok) return c.json(outcome.refusal.body, outcome.refusal.status);
	if (body.action === "decline") return c.json({ ok: true, dispatched: false });
	return c.json({
		ok: true,
		dispatched: true,
		prompt: outcome.prompt,
		delivery: outcome.delivery,
	});
});

// --------------------------------------------------------------------------
// Where an approved prompt went (derived from the control action carrying it)
// --------------------------------------------------------------------------

aiWatcherRouter.get("/ai/proposals/:id/delivery", async (c) => {
	// Reading where a prompt went must keep working while the watcher is paused.
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const outcome = await getDeliveryState(c.req.param("id") ?? "", await decisionContextFor(c));
	if (!outcome.ok) return c.json(outcome.refusal.body, outcome.refusal.status);
	return c.json(outcome.delivery);
});

aiWatcherRouter.post("/ai/proposals/:id/delivery/retry", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown } | null;
	const outcome = await retryDelivery(c.req.param("id") ?? "", await decisionContextFor(c), {
		confirm: body?.confirm === true,
	});
	if (!outcome.ok) return c.json(outcome.refusal.body, outcome.refusal.status);
	return c.json({ state: outcome.state, deliveryId: outcome.deliveryId });
});

export default aiWatcherRouter;
