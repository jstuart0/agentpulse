import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthUser } from "../auth/middleware.js";
import { getRequestActor, isHumanCaller, refuseBadOrigin } from "../auth/route-scope-policy.js";
import { getDb } from "../db/client.js";
import { llmProviders, sessions, settings } from "../db/schema/index.js";
import {
	getBackfillProgress,
	isBackfillRunning,
	runBackfill,
} from "../services/ai/embeddings/embedding-service.js";
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
import { promptDeliverability } from "../services/ai/prompt-deliverability.js";
import { cancelOpenHitl, listProposalsForSession } from "../services/ai/proposals-service.js";
import {
	type WatcherConfigRecord,
	deleteWatcherConfig,
	getWatcherConfig,
	upsertWatcherConfig,
} from "../services/ai/watcher-config-service.js";
import { listReportsForSession } from "../services/ai/watcher-reports-service.js";
import { logAdminAction } from "../services/audit-log.js";
import { NotOwnerError, assertCanConfigureWatcher } from "../services/authorization.js";
import { getChannel } from "../services/channels/channels-service.js";
import { notifyInboxChanged } from "../services/notifier.js";
import { upsertSetting } from "../services/settings-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";
import { type ParsedWatcherUpdate, parseWatcherUpdate } from "./ai-watcher-validation.js";
import { decisionContextFor, readDecisionBody } from "./decision-context.js";

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
	// One pass at a time, shared with the schedule: a press while one is running
	// starts nothing and says so.
	if (isBackfillRunning()) return c.json({ ok: true, started: false, running: true });
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
	const promptDelivery = await promptDeliverability(sessionId);
	const reports = await listReportsForSession(sessionId, 10);
	return c.json({ config, proposals, promptDelivery, reports });
});

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** A config reduced to what an audit line may carry: the system prompt only as a hash. */
function auditView(config: WatcherConfigRecord | null): Record<string, unknown> | null {
	if (!config) return null;
	const { systemPrompt, createdAt: _created, updatedAt: _updated, ...rest } = config;
	return {
		...rest,
		systemPromptSha256: systemPrompt === null ? null : sha256Hex(systemPrompt),
	};
}

/** Only the keys that differ, so one line per change stays small. */
function changedKeys(
	before: Record<string, unknown> | null,
	after: Record<string, unknown> | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
	if (!before || !after) return { before, after };
	const b: Record<string, unknown> = {};
	const a: Record<string, unknown> = {};
	for (const key of Object.keys(after)) {
		if (before[key] !== after[key]) {
			b[key] = before[key];
			a[key] = after[key];
		}
	}
	return { before: b, after: a };
}

function authUserOf(c: Context): AuthUser | undefined {
	return c.get("authUser") as AuthUser | undefined;
}

/** Who a human confirmation is recorded against: their user id, or "local" when auth is off. */
function confirmerId(authUser: AuthUser | undefined): string {
	return authUser?.userId ?? "local";
}

type ChannelCheck = { ok: true } | { ok: false };

/**
 * A notification channel a watcher may use: it exists, is active and verified,
 * and in team mode belongs to the session's owner. A channel whose user is
 * "local" belongs to nobody in team mode, so it is never selectable there.
 */
async function channelUsable(
	channelId: string,
	mode: "solo" | "team" | undefined,
	sessionOwnerUserId: string | null,
): Promise<ChannelCheck> {
	const channel = await getChannel(channelId);
	if (!channel || !channel.isActive || channel.verifiedAt === null) return { ok: false };
	if (mode === "team") {
		if (sessionOwnerUserId === null || channel.userId !== sessionOwnerUserId) return { ok: false };
	}
	return { ok: true };
}

aiWatcherRouter.put("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;
	const sessionId = c.req.param("sessionId") ?? "";
	const actor = await getRequestActor(c);
	try {
		await assertCanConfigureWatcher(actor, sessionId);
	} catch (err) {
		if (err instanceof NotOwnerError) return c.json({ error: "not_owner" }, 403);
		throw err;
	}

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return c.json({ error: "invalid_body" }, 400);
	}
	const parsed = parseWatcherUpdate(raw);
	if (!parsed.ok) {
		return c.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, 400);
	}
	const update: ParsedWatcherUpdate = parsed.value;

	// Confirming `auto` and zeroing the automatic-send counter are decisions a
	// person makes at the dashboard; an API key never does either.
	const authUser = authUserOf(c);
	if (
		(update.policy === "auto" || update.resetContinuations) &&
		!(authUser && isHumanCaller(authUser))
	) {
		return c.json({ error: "human_required" }, 403);
	}

	const [session] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!session) return c.json({ error: "session_not_found" }, 404);

	if (update.providerId !== undefined) {
		const [provider] = await getDb()
			.select({ id: llmProviders.id })
			.from(llmProviders)
			.where(eq(llmProviders.id, update.providerId))
			.limit(1);
		if (!provider) return c.json({ error: "invalid_provider" }, 400);
	}
	if (update.channelId) {
		const usable = await channelUsable(update.channelId, actor.mode, session.ownerUserId);
		if (!usable.ok) return c.json({ error: "invalid_channel" }, 400);
	}

	const before = await getWatcherConfig(sessionId);
	const config = await upsertWatcherConfig({
		sessionId,
		...update,
		autoConfirmedBy: update.policy === "auto" ? confirmerId(authUser) : undefined,
	});
	logAdminAction("ai_config_changed", actor, {
		sessionId,
		...changedKeys(auditView(before), auditView(config)),
	});
	return c.json({ config });
});

aiWatcherRouter.delete("/ai/sessions/:sessionId/watcher", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const sessionId = c.req.param("sessionId") ?? "";
	const actor = await getRequestActor(c);
	try {
		await assertCanConfigureWatcher(actor, sessionId);
	} catch (err) {
		if (err instanceof NotOwnerError) return c.json({ error: "not_owner" }, 403);
		throw err;
	}
	const before = await getWatcherConfig(sessionId);
	const cancelled = await cancelOpenHitl(sessionId, "watcher_removed");
	if (cancelled > 0) notifyInboxChanged({ sessionId });
	const deleted = await deleteWatcherConfig(sessionId);
	if (!deleted) return c.json({ error: "Watcher not configured" }, 404);
	logAdminAction("ai_config_changed", actor, {
		sessionId,
		before: auditView(before),
		after: null,
	});
	return c.json({ ok: true });
});

// --------------------------------------------------------------------------
// HITL approve / decline / custom (proposals)
// --------------------------------------------------------------------------

aiWatcherRouter.post("/ai/proposals/:id/decision", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;
	const id = c.req.param("id") ?? "";
	const parsed = await readDecisionBody(c);
	if (!parsed.ok) return parsed.response;
	const { body } = parsed;

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
		controlActionId: outcome.controlActionId,
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
