import { Hono } from "hono";
import type { ActionRequestDecision, HitlReplyKind } from "../../shared/types.js";
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
import { resolveHitlRequest, supersedeOpenHitl } from "../services/ai/hitl-service.js";
import { type InboxWorkItem, buildInbox } from "../services/ai/inbox-service.js";
import {
	type InboxKind,
	listActiveSnoozes,
	snoozeItem,
	unsnooze,
	unsnoozeTarget,
} from "../services/ai/inbox-snooze-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";

const aiInboxRouter = new Hono();

const INBOX_KINDS: InboxKind[] = ["hitl", "stuck", "risky", "failed_proposal"];

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
	const inbox = await buildInbox({
		kinds,
		sessionId,
		severity,
		limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100,
	});
	return c.json(inbox);
});

aiInboxRouter.post("/ai/inbox/hitl/:id/decide", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		action: HitlReplyKind;
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

aiInboxRouter.get("/ai/inbox/snoozes", async (c) => {
	if (!isAiBuildEnabled()) return c.json({ error: "ai_disabled" }, 404);
	const rows = await listActiveSnoozes();
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
	// Cap at 30 days so a misclick can't mute an inbox item forever.
	const capped = Math.min(duration, 30 * 24 * 60 * 60 * 1000);
	const until = new Date(Date.now() + capped);
	const snooze = await snoozeItem({
		kind: body.kind,
		targetId: body.targetId,
		until,
		reason: body.reason ?? null,
	});
	return c.json({ snooze });
});

aiInboxRouter.delete("/ai/inbox/snooze/:id", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const ok = await unsnooze(id);
	if (!ok) return c.json({ error: "snooze not found" }, 404);
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
	const ok = await unsnoozeTarget(kind, targetId);
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
	const items = await listOpenActionRequests();
	return c.json({ actionRequests: items });
});

aiInboxRouter.post("/ai/action-requests/:id/decide", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{ decision: ActionRequestDecision }>();
	if (body.decision !== "applied" && body.decision !== "declined") {
		return c.json({ error: "decision must be 'applied' or 'declined'" }, 400);
	}
	const existing = await getActionRequest(id);
	if (!existing) return c.json({ error: "action request not found" }, 404);

	const result = await resolveActionRequest({
		id,
		decision: body.decision,
		resolvedBy: "local-user",
	});

	if (result.ok) {
		const updated = await getActionRequest(id);
		return c.json({ actionRequest: updated });
	}

	const updated = await getActionRequest(id);

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
