import { Hono } from "hono";
import {
	classifierAffectsRunner,
	isAiBuildEnabled,
	isAiRuntimeEnabled,
	isClassifierEnabled,
	isKillSwitchActive,
} from "../services/ai/feature.js";
import {
	intelligenceForSession,
	intelligenceForSessions,
} from "../services/ai/intelligence-service.js";
import { emitAiMetric } from "../services/ai/metrics.js";
import { parseUserRules, redactDryRun } from "../services/ai/redactor.js";
import { getRiskClasses, setRiskClasses } from "../services/ai/risk-classes.js";
import { getTodaySpendCents } from "../services/ai/spend-service.js";
import { distillTemplate, provenanceMetadata } from "../services/ai/template-distillation.js";
import { queueSnapshot } from "../services/ai/watcher-runs-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";

const aiIntelligenceRouter = new Hono();

// --------------------------------------------------------------------------
// Session intelligence (Phase 2 classifier)
// --------------------------------------------------------------------------

aiIntelligenceRouter.get("/ai/sessions/:sessionId/intelligence", async (c) => {
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

aiIntelligenceRouter.post("/ai/intelligence/batch", async (c) => {
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
// Risk classes (Phase 7)
// --------------------------------------------------------------------------

aiIntelligenceRouter.get("/ai/risk-classes", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const config = await getRiskClasses();
	return c.json(config);
});

aiIntelligenceRouter.put("/ai/risk-classes", async (c) => {
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

aiIntelligenceRouter.post("/ai/templates/distill", async (c) => {
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

// --------------------------------------------------------------------------
// Redactor dry-run (for the "preview before enabling" UX)
// --------------------------------------------------------------------------

aiIntelligenceRouter.post("/ai/redactor/dry-run", async (c) => {
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

aiIntelligenceRouter.get("/ai/spend", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const cents = await getTodaySpendCents();
	return c.json({ date: new Date().toISOString().slice(0, 10), spendCents: cents });
});

// --------------------------------------------------------------------------
// Diagnostics (Phase 8)
// --------------------------------------------------------------------------

aiIntelligenceRouter.get("/ai/diagnostics", async (c) => {
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

export default aiIntelligenceRouter;
