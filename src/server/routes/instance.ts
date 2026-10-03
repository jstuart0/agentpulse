import { Hono } from "hono";
import type { Context } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { OwnerDisabledError, OwnerNotFoundError } from "../auth/owner-state.js";
import {
	getRequestActor,
	getRequestMode,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { logAdminAction } from "../services/audit-log.js";
import {
	HumanAdminRequiredError,
	InvalidServiceKeyDecisionError,
	ModeLockedByEnvError,
	type ServiceKeyDecision,
	ServiceKeysUndecidedError,
	TeamRequiresAuthError,
	getInstanceCounts,
	setMode,
} from "../services/instance-mode.js";
import { claimUnassignedSessions } from "../services/session-owner-admin.js";

const instanceRouter = new Hono();
instanceRouter.use("*", requireAuth());
// GET /instance is observe-readable (counts only); everything else is an
// always-admin, human-only mutation judged by the role policy as well.
instanceRouter.use("*", requireOperatorScope());

// GET /api/v1/instance - the mode, whether the env fixes it, and what still
// needs an admin's attention.
instanceRouter.get("/instance", async (c) => {
	return c.json({
		mode: await getRequestMode(c),
		modeLockedByEnv: config.modeEnv !== null,
		counts: await getInstanceCounts(),
	});
});

const DECISIONS = new Set(["keep", "assign", "revoke"]);

function parseDecisions(raw: unknown): ServiceKeyDecision[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const decisions: ServiceKeyDecision[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") return null;
		const { keyId, decision, userId } = entry as Record<string, unknown>;
		if (typeof keyId !== "string" || typeof decision !== "string" || !DECISIONS.has(decision)) {
			return null;
		}
		if (userId !== undefined && typeof userId !== "string") return null;
		decisions.push({ keyId, decision, userId } as ServiceKeyDecision);
	}
	return decisions;
}

// PUT /api/v1/instance/mode - switch solo <-> team. A human admin, both ways.
instanceRouter.put("/instance/mode", async (c: Context) => {
	const body = (await c.req.json().catch(() => null)) as {
		mode?: unknown;
		serviceKeyDecisions?: unknown;
	} | null;
	const mode = body?.mode;
	const decisions = parseDecisions(body?.serviceKeyDecisions);
	if ((mode !== "solo" && mode !== "team") || decisions === null) {
		return c.json({ error: "invalid_mode_request" }, 400);
	}

	// Under DISABLE_AUTH the operator is an admin but has no user row, so the
	// switch can't record one; solo is all there is to be, and team is refused
	// by setMode (400 team_requires_auth).
	if (config.disableAuth && mode === "solo" && config.modeEnv === null) {
		return c.json({ mode: "solo", changed: false });
	}

	try {
		return c.json(
			await setMode({ mode, serviceKeyDecisions: decisions }, await getRequestActor(c)),
		);
	} catch (err) {
		if (err instanceof ModeLockedByEnvError) return c.json({ error: "mode_locked_by_env" }, 409);
		if (err instanceof TeamRequiresAuthError) return c.json({ error: "team_requires_auth" }, 400);
		if (err instanceof HumanAdminRequiredError) {
			return c.json({ error: "human_admin_required" }, 403);
		}
		if (err instanceof ServiceKeysUndecidedError) {
			return c.json({ error: "service_keys_undecided", keys: err.keys }, 409);
		}
		if (err instanceof InvalidServiceKeyDecisionError) {
			return c.json(
				{ error: "invalid_service_key_decision", code: err.code, keyId: err.keyId },
				400,
			);
		}
		throw err;
	}
});

// POST /api/v1/instance/claim-unassigned - give every session nobody owns to a user.
instanceRouter.post("/instance/claim-unassigned", async (c: Context) => {
	const body = (await c.req.json().catch(() => null)) as { userId?: unknown } | null;
	if (typeof body?.userId !== "string" || body.userId === "") {
		return c.json({ error: "user_id_required" }, 400);
	}
	try {
		const claimed = await claimUnassignedSessions(body.userId);
		logAdminAction("unassigned_sessions_claimed", await getRequestActor(c), {
			userId: body.userId,
			count: claimed,
		});
		return c.json({ claimed });
	} catch (err) {
		if (err instanceof OwnerNotFoundError) return c.json({ error: "user_not_found" }, 404);
		if (err instanceof OwnerDisabledError) return c.json({ error: "user_disabled" }, 409);
		throw err;
	}
});

export { instanceRouter };
