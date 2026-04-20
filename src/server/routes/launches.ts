import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { LaunchRequestInput, SessionTemplateInput } from "../../shared/types.js";
import { requireAuth } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { launchRequests } from "../db/schema.js";
import { isAiBuildEnabled } from "../services/ai/feature.js";
import { recommendLaunch } from "../services/ai/launch-recommender.js";
import { createValidatedLaunchRequest, mapLaunchRequest } from "../services/launch-validator.js";
import { getSession } from "../services/session-tracker.js";

const launchesRouter = new Hono();
launchesRouter.use("*", requireAuth());

launchesRouter.get("/launches", async (c) => {
	const rows = await db.select().from(launchRequests).orderBy(desc(launchRequests.createdAt));
	return c.json({
		launches: rows.map(mapLaunchRequest),
		total: rows.length,
	});
});

launchesRouter.get("/launches/:id", async (c) => {
	const [row] = await db
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, c.req.param("id")))
		.limit(1);
	if (!row) return c.json({ error: "Launch request not found" }, 404);
	const launchRequest = mapLaunchRequest(row);
	const session = await getSession(launchRequest.launchCorrelationId);
	return c.json({ launchRequest, session });
});

launchesRouter.post("/launches", async (c) => {
	try {
		const body = await c.req.json<LaunchRequestInput>();
		const result = await createValidatedLaunchRequest(body);
		return c.json(result, result.launchRequest.status === "validated" ? 201 : 200);
	} catch (error) {
		if (error instanceof HTTPException) {
			return c.json({ error: error.message }, error.status);
		}
		return c.json(
			{ error: error instanceof Error ? error.message : "Launch validation failed" },
			400,
		);
	}
});

/**
 * Phase 6 recommendation endpoint. Advisory only: launch preview and
 * the existing validator still resolve the authoritative launch spec.
 * This endpoint returns a RecommendedLaunch object operators accept or
 * override from the preview UI.
 */
launchesRouter.post("/launches/recommendation", async (c) => {
	if (!isAiBuildEnabled()) {
		// Recommendation logic is deterministic and safe to expose even
		// without the AI provider feature; but the plan gates this behind
		// the AI build flag so non-AI installs keep the same surface.
		return c.json({ error: "ai_disabled" }, 404);
	}
	const body = await c.req.json<{
		template: SessionTemplateInput;
		preferredSupervisorId?: string | null;
	}>();
	if (!body.template) return c.json({ error: "template required" }, 400);
	const recommendation = await recommendLaunch({
		template: body.template,
		preferredSupervisorId: body.preferredSupervisorId ?? null,
	});
	return c.json({ recommendation });
});

export { launchesRouter };
