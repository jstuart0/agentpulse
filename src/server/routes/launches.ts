import { count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { isLaunchable } from "../../shared/constants.js";
import type {
	LaunchRequest,
	LaunchRequestInput,
	SessionTemplateInput,
} from "../../shared/types.js";
import { actorFromAuthUser } from "../auth/actor.js";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import { getRequestActor, requireOperatorScope } from "../auth/route-scope-policy.js";
import { getDb } from "../db/client.js";
import { launchRequests, sessionTemplates } from "../db/schema/index.js";
import { isAiBuildEnabled } from "../services/ai/feature.js";
import { recommendLaunch } from "../services/ai/launch-recommender.js";
import { canReadLaunch, launchReadScope } from "../services/authorization.js";
import { createValidatedLaunchRequest, mapLaunchRequest } from "../services/launch-validator.js";
import { getProject } from "../services/projects/projects-service.js";
import { getSession } from "../services/session-tracker.js";
import { resolveTemplateWithProject } from "../services/templates/template-project-resolver.js";

const launchesRouter = new Hono();
launchesRouter.use("*", requireAuth());
// Manage-only (C1): launch DTOs carry env/launchSpec/claimToken (launch-validator.ts:28-36).
launchesRouter.use("*", requireOperatorScope());

const REDACTED = "[redacted]";

function redactEnv(env: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.keys(env ?? {}).map((key) => [key, REDACTED]));
}

/** A client never needs the claim token, so no launch DTO leaves this router with one. */
function withoutClaimToken(launch: LaunchRequest): LaunchRequest {
	return { ...launch, claimToken: null };
}

/** List rows also drop env values (keys stay, so a row still shows what was set), in the row and its spec. */
function listRow(launch: LaunchRequest): LaunchRequest {
	return {
		...withoutClaimToken(launch),
		env: redactEnv(launch.env),
		launchSpec: { ...launch.launchSpec, env: redactEnv(launch.launchSpec?.env) },
	};
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function pageParam(raw: string | undefined, fallback: number, max: number): number | null {
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d{1,9}$/.test(raw)) return null;
	return Math.min(Number(raw), max);
}

launchesRouter.get("/launches", async (c) => {
	const actor = await getRequestActor(c);
	const limit = pageParam(c.req.query("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
	const offset = pageParam(c.req.query("offset"), 0, Number.MAX_SAFE_INTEGER);
	if (limit === null || limit < 1 || offset === null) {
		return c.json({ error: "limit must be 1 to 200 and offset 0 or more." }, 400);
	}
	const scope = launchReadScope(actor);
	if (scope.kind === "none") {
		return c.json({ launches: [], total: 0, limit, offset, hasMore: false });
	}
	const where =
		scope.kind === "user" ? eq(launchRequests.requestedByUserId, scope.userId) : undefined;
	const [rows, [{ total }]] = await Promise.all([
		getDb()
			.select()
			.from(launchRequests)
			.where(where)
			.orderBy(desc(launchRequests.createdAt), desc(launchRequests.id))
			.limit(limit)
			.offset(offset),
		getDb().select({ total: count() }).from(launchRequests).where(where),
	]);
	return c.json({
		launches: rows.map((row) => listRow(mapLaunchRequest(row))),
		total,
		limit,
		offset,
		hasMore: offset + rows.length < total,
	});
});

launchesRouter.get("/launches/:id", async (c) => {
	const actor = await getRequestActor(c);
	const [row] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, c.req.param("id")))
		.limit(1);
	// Someone else's launch answers exactly like a missing one.
	if (!row || !canReadLaunch(actor, row)) return c.json({ error: "Launch request not found" }, 404);
	const launchRequest = withoutClaimToken(mapLaunchRequest(row));
	const session = await getSession(launchRequest.launchCorrelationId);
	return c.json({ launchRequest, session });
});

function createdResponse(
	c: Context,
	result: Awaited<ReturnType<typeof createValidatedLaunchRequest>>,
) {
	const body = { ...result, launchRequest: withoutClaimToken(result.launchRequest) };
	const replayed = "idempotentReplay" in result;
	return c.json(body, !replayed && result.launchRequest.status === "validated" ? 201 : 200);
}

launchesRouter.post("/launches", async (c: Context) => {
	try {
		const body = await c.req.json<LaunchRequestInput & { templateId?: string | null }>();
		// Prelaunch actions run commands on the host (clone, scaffold), so only AgentPulse's own
		// flows (ask handlers, approved action requests) may attach them; a client never can.
		if ((body.launchSpec?.prelaunchActions?.length ?? 0) > 0) {
			return c.json({ error: "launchSpec.prelaunchActions can't be supplied by a client." }, 400);
		}
		const authUser = c.get("authUser") as AuthUser | undefined;
		const actor = actorFromAuthUser(authUser);

		// When a templateId is provided, load the template and resolve project
		// defaults before passing to the validator. The validator sees a plain
		// SessionTemplateInput — no special-casing needed downstream.
		if (body.templateId) {
			const [templateRow] = await getDb()
				.select()
				.from(sessionTemplates)
				.where(eq(sessionTemplates.id, body.templateId))
				.limit(1);
			if (!templateRow) {
				return c.json({ error: "Template not found" }, 404);
			}
			const project = templateRow.projectId ? await getProject(templateRow.projectId) : null;
			const resolvedTemplate = resolveTemplateWithProject(templateRow, project);

			const resolvedBody: LaunchRequestInput = {
				...body,
				template: resolvedTemplate,
			};
			return createdResponse(c, await createValidatedLaunchRequest(resolvedBody, actor));
		}

		return createdResponse(c, await createValidatedLaunchRequest(body, actor));
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
	if (!isLaunchable(body.template.agentType as string)) {
		return c.json({ error: "agentType must be claude_code or codex_cli" }, 400);
	}
	const recommendation = await recommendLaunch({
		template: body.template,
		preferredSupervisorId: body.preferredSupervisorId ?? null,
	});
	return c.json({ recommendation });
});

export { launchesRouter };
