import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { HitlReplyKind } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { settings } from "../db/schema.js";
import { emitAiEvent } from "../services/ai/ai-events.js";
import { checkDispatch } from "../services/ai/dispatch-filter.js";
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
	cancelOpenHitl,
	getProposal,
	listProposalsForSession,
	resolveProposalHitl,
} from "../services/ai/proposals-service.js";
import {
	type WatcherPolicy,
	deleteWatcherConfig,
	getWatcherConfig,
	upsertWatcherConfig,
} from "../services/ai/watcher-config-service.js";
import { upsertSetting } from "../services/settings-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";

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

aiWatcherRouter.delete("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	await cancelOpenHitl(sessionId, "watcher_removed");
	const deleted = await deleteWatcherConfig(sessionId);
	if (!deleted) return c.json({ error: "Watcher not configured" }, 404);
	return c.json({ ok: true });
});

// --------------------------------------------------------------------------
// HITL approve / decline / custom (proposals)
// --------------------------------------------------------------------------

aiWatcherRouter.post("/ai/proposals/:id/decision", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		action: HitlReplyKind;
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
				source: "managed_control",
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
			source: "managed_control",
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
		source: "managed_control",
		category: "ai_hitl_response",
		eventType: "AiHitlResponse",
		content: body.action === "custom" ? `Custom: ${nextPrompt}` : "Approved.",
		rawPayload: { proposal_id: id, action: body.action },
	});
	await emitAiEvent({
		sessionId: proposal.sessionId,
		source: "managed_control",
		category: "ai_continue_sent",
		eventType: "AiContinueSent",
		content: nextPrompt ?? "",
		rawPayload: { proposal_id: id, action: body.action },
	});

	return c.json({ ok: true, dispatched: true, prompt: nextPrompt });
});

export default aiWatcherRouter;
