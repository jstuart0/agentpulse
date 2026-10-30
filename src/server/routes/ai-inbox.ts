import { Hono } from "hono";
import type { Context } from "hono";
import type { ActionRequestDecision } from "../../shared/types.js";
import { getRequestActor, refuseBadOrigin } from "../auth/route-scope-policy.js";
import {
	getActionRequest,
	listOpenActionRequests,
	resolveActionRequest,
} from "../services/ai/action-requests-service.js";
import {
	buildDigest,
	getDailyDigest,
	invalidateDigestCache,
} from "../services/ai/digest-service.js";
import { isAiBuildEnabled } from "../services/ai/feature.js";
import { decideHitl, declineAll } from "../services/ai/hitl-decision-service.js";
import { type InboxWorkItem, buildInbox } from "../services/ai/inbox-service.js";
import {
	type InboxKind,
	actorMayTouchSnooze,
	getSnooze,
	listActiveSnoozesFor,
	snoozeItem,
	snoozeTargetSession,
	unsnooze,
	unsnoozeTarget,
} from "../services/ai/inbox-snooze-service.js";
import { NOT_OWNER_MESSAGE } from "../services/authorization.js";
import { notifyInboxChanged } from "../services/notifier.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";
import { decisionContextFor, readDecisionBody } from "./decision-context.js";

const aiInboxRouter = new Hono();

/** Why a key with no owner sees an empty inbox in team mode. */
export const NO_IDENTITY_INBOX_NOTICE =
	"This key has no owner, and in team mode a key with no owner sees no inbox items. Use a key owned by a person, or keep it as an admin service key.";

const INBOX_KINDS: InboxKind[] = ["hitl", "stuck", "risky", "failed_proposal", "watcher_report"];
/** Most ids one batch names, in either list. */
const BATCH_MAX_IDS = 200;

const notOwner = (c: Context) => c.json({ error: "not_owner", message: NOT_OWNER_MESSAGE }, 403);

/** The change an inbox item's snooze makes, announced to whoever could see the item. */
async function announceSnoozeChange(kind: InboxKind, targetId: string): Promise<void> {
	const sessionId = await snoozeTargetSession(kind, targetId);
	notifyInboxChanged(sessionId === null ? { adminOnly: true } : { sessionId });
}

// --------------------------------------------------------------------------
// Operator inbox (Phase 3)
// --------------------------------------------------------------------------

aiInboxRouter.get("/ai/inbox", async (c) => {
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
	const actor = await getRequestActor(c);
	const inbox = await buildInbox(
		{
			kinds,
			sessionId,
			severity,
			limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100,
		},
		actor,
	);
	// A key with no owner is a member with no identity in team mode and sees nothing. Say so, rather than
	// leave an empty inbox that reads as "nothing needs you".
	if (actor.mode !== "solo" && actor.userId === null && actor.role !== "admin") {
		return c.json({ ...inbox, notice: NO_IDENTITY_INBOX_NOTICE });
	}
	return c.json(inbox);
});

aiInboxRouter.post("/ai/inbox/hitl/:id/decide", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;
	const id = c.req.param("id") ?? "";
	const parsed = await readDecisionBody(c);
	if (!parsed.ok) return parsed.response;
	const { body } = parsed;
	const outcome = await decideHitl(
		{ kind: "hitl", hitlId: id },
		body.action,
		{ customPrompt: body.customPrompt, promptHash: body.promptHash },
		await decisionContextFor(c),
	);
	if (!outcome.ok) return c.json(outcome.refusal.body, outcome.refusal.status);
	return c.json({
		hitl: outcome.hitl,
		...(outcome.controlActionId ? { controlActionId: outcome.controlActionId } : {}),
		...(outcome.delivery ? { delivery: outcome.delivery } : {}),
	});
});

aiInboxRouter.get("/ai/inbox/snoozes", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const rows = await listActiveSnoozesFor(await getRequestActor(c));
	return c.json({ snoozes: rows });
});

aiInboxRouter.post("/ai/inbox/snooze", async (c) => {
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
	const actor = await getRequestActor(c);
	if (!(await actorMayTouchSnooze(actor, body.kind, body.targetId))) return notOwner(c);
	// Cap at 30 days so a misclick can't mute an inbox item forever.
	const capped = Math.min(duration, 30 * 24 * 60 * 60 * 1000);
	const until = new Date(Date.now() + capped);
	const snooze = await snoozeItem({
		kind: body.kind,
		targetId: body.targetId,
		until,
		reason: body.reason ?? null,
		createdBy: actor.userId,
	});
	await announceSnoozeChange(body.kind, body.targetId);
	return c.json({ snooze });
});

aiInboxRouter.delete("/ai/inbox/snooze/:id", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const existing = await getSnooze(id);
	if (!existing) return c.json({ error: "snooze not found" }, 404);
	if (!(await actorMayTouchSnooze(await getRequestActor(c), existing.kind, existing.targetId))) {
		return notOwner(c);
	}
	const ok = await unsnooze(id);
	if (!ok) return c.json({ error: "snooze not found" }, 404);
	await announceSnoozeChange(existing.kind, existing.targetId);
	return c.json({ ok: true });
});

aiInboxRouter.delete("/ai/inbox/snooze", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const kind = c.req.query("kind") as InboxKind | undefined;
	const targetId = c.req.query("targetId");
	if (!kind || !INBOX_KINDS.includes(kind) || !targetId) {
		return c.json({ error: "kind + targetId required" }, 400);
	}
	if (!(await actorMayTouchSnooze(await getRequestActor(c), kind, targetId))) return notOwner(c);
	const ok = await unsnoozeTarget(kind, targetId);
	if (ok) await announceSnoozeChange(kind, targetId);
	return c.json({ ok });
});

/**
 * Batch decline / snooze is the only safe batch action per the plan.
 * Approve-all is intentionally not available.
 */
aiInboxRouter.post("/ai/inbox/batch-decline", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{ hitlIds?: string[]; sessionIds?: string[] }>();
	const hitlIds = body.hitlIds ?? [];
	const sessionIds = body.sessionIds ?? [];
	const isIdList = (v: unknown): v is string[] =>
		Array.isArray(v) && v.length <= BATCH_MAX_IDS && v.every((x) => typeof x === "string");
	if (!isIdList(hitlIds) || !isIdList(sessionIds)) {
		return c.json(
			{ error: "invalid_ids", message: `Send at most ${BATCH_MAX_IDS} ids in each list.` },
			400,
		);
	}
	const outcome = await declineAll({ hitlIds, sessionIds, ctx: await decisionContextFor(c) });
	if (!outcome.ok) return c.json(outcome.refusal.body, outcome.refusal.status);
	return c.json({ closed: outcome.closed });
});

// --------------------------------------------------------------------------
// Project digest (Phase 4)
// --------------------------------------------------------------------------

aiInboxRouter.get("/ai/digest", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const fresh = c.req.query("fresh") === "1";
	const digest = fresh ? await buildDigest() : await getDailyDigest();
	return c.json(digest);
});

aiInboxRouter.post("/ai/digest/refresh", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	invalidateDigestCache();
	const digest = await buildDigest();
	return c.json(digest);
});

// --------------------------------------------------------------------------
// Action requests (Phase 3 — AI-initiated launch approvals)
// --------------------------------------------------------------------------

aiInboxRouter.get("/ai/action-requests", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	// Action requests are an admin's in team mode: a member sees none.
	const actor = await getRequestActor(c);
	if (actor.mode !== "solo" && actor.role !== "admin") return c.json({ actionRequests: [] });
	const items = await listOpenActionRequests();
	return c.json({ actionRequests: items });
});

aiInboxRouter.post("/ai/action-requests/:id/decide", async (c: Context) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;
	const id = c.req.param("id") ?? "";
	// The approving human (or key) runs the owner-or-admin rules for whatever
	// the action does; it is not recorded as "the AI".
	const actor = await getRequestActor(c);
	// Action requests are an admin's in team mode (the inbox shows them to nobody else), so a member learns
	// nothing about one here: not that it exists, not its state, not its body.
	if (actor.mode !== "solo" && actor.role !== "admin") {
		return c.json({ error: "admin_required", message: "Only an admin can do that." }, 403);
	}
	const body = await c.req.json<{ decision: ActionRequestDecision }>();
	if (body.decision !== "applied" && body.decision !== "declined") {
		return c.json({ error: "decision must be 'applied' or 'declined'" }, 400);
	}
	const existing = await getActionRequest(id);
	if (!existing) return c.json({ error: "action request not found" }, 404);

	const result = await resolveActionRequest({
		id,
		decision: body.decision,
		resolvedBy: actor.label,
		actor,
	});

	if (result.ok) {
		const updated = await getActionRequest(id);
		return c.json({ actionRequest: updated });
	}

	const updated = await getActionRequest(id);

	if (result.reason === "not_owner") {
		return c.json(
			{
				error: "not_owner",
				message: NOT_OWNER_MESSAGE,
			},
			403,
		);
	}

	if (result.reason === "race_lost") {
		return c.json(
			{
				error: "race_lost",
				currentStatus: result.currentStatus,
				message: "Another approval already claimed this request.",
				actionRequest: updated,
			},
			409,
		);
	}

	const actionLabel = ((kind: string | undefined): string => {
		switch (kind) {
			case "add_project":
				return "Project creation";
			case "session_stop":
				return "Stop";
			case "session_archive":
				return "Archive";
			case "session_delete":
				return "Delete";
			case "edit_project":
				return "Project edit";
			case "delete_project":
				return "Project delete";
			case "edit_template":
				return "Template edit";
			case "delete_template":
				return "Template delete";
			case "add_channel":
				return "Channel setup";
			case "create_alert_rule":
				return "Alert rule";
			case "create_freeform_alert_rule":
				return "Freeform alert rule";
			case "bulk_session_action":
				return "Bulk session action";
			default:
				return "Launch";
		}
	})(updated?.kind);

	if (result.reason === "expired") {
		return c.json(
			{
				error: "expired",
				failureReason: result.failureReason,
				message: `${actionLabel} couldn't proceed: ${result.failureReason}`,
				actionRequest: updated,
			},
			422,
		);
	}

	// reason === "failed"
	return c.json(
		{
			error: "failed",
			failureReason: result.failureReason,
			message: `${actionLabel} failed: ${result.failureReason}`,
			actionRequest: updated,
		},
		422,
	);
});

export default aiInboxRouter;
