/**
 * The person routes for managed Codex approvals (AGEN-87, D17):
 *
 *   GET  /sessions/:sessionId/approvals
 *   GET  /sessions/:sessionId/approvals/:approvalId
 *   POST /sessions/:sessionId/approvals/:approvalId/decision
 *
 * Mounted with the operator bundle. Both reads are manage-only for API keys and
 * the POST is owner-checked (route-scope-policy.ts); nothing is granted to a
 * `respond` key. Not AI-gated: an approval is a Codex request, not an AI feature.
 *
 * Every response is rebuilt here from the D17 DTOs, key by key, so a column the
 * service later gains can't ride out by accident.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type {
	CodexApprovalDecisionResponse,
	CodexApprovalDetail,
	CodexApprovalList,
	CodexApprovalPresentation,
	CodexApprovalPreview,
	CodexApprovalSummary,
} from "../../shared/codex-approvals.js";
import type { AuthUser } from "../auth/middleware.js";
import { requireAuth } from "../auth/middleware.js";
import { isJsonContentType } from "../auth/request-origin.js";
import {
	getRequestActor,
	isHumanCaller,
	requireBrowserOriginGate,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { changesOutsideCwd } from "../services/codex-approval-presentation.js";
import {
	type ApprovalCaller,
	ApprovalRefusal,
	type ApprovalRefusalCode,
	answerApproval,
	getApprovalDetail,
	listApprovalsForSession,
} from "../services/codex-approvals.js";
import { notifySessionUpdated } from "../services/notifier.js";
import { getSession } from "../services/session-tracker.js";

/** A decision is a short word and an optional 64-character hash. */
const MAX_BODY_BYTES = 16 * 1024;

/** The HTTP status of each refusal. The body is only ever `{ error: <code> }`. */
const REFUSAL_STATUS: Readonly<Record<ApprovalRefusalCode, 400 | 403 | 404 | 409>> = {
	invalid_decision: 400,
	presentation_hash_required: 400,
	invalid_body: 400,
	not_owner: 403,
	human_required: 403,
	approval_not_found: 404,
	session_stopped: 409,
	already_resolved: 409,
	expired: 409,
	not_approvable: 409,
	host_offline: 409,
	host_gone: 409,
	presentation_changed: 409,
	session_unknown: 409,
	too_many_pending: 409,
	session_stopping: 409,
	identity_conflict: 409,
	session_not_owned: 403,
};

function refuse(c: Context, code: ApprovalRefusalCode): Response {
	return c.json({ error: code }, REFUSAL_STATUS[code]);
}

const codexApprovalsRouter = new Hono();
// The detail carries command text and paths: nothing here is cached by a browser or a proxy.
codexApprovalsRouter.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});
codexApprovalsRouter.use("*", requireAuth());
// Observe, ingest and respond keys are turned away here: no approval route is in any grant.
codexApprovalsRouter.use("*", requireOperatorScope());

async function approvalCaller(c: Context): Promise<ApprovalCaller> {
	const authUser = c.get("authUser") as AuthUser;
	return {
		actor: await getRequestActor(c),
		keyId: authUser.source === "api_key" ? authUser.keyId : null,
		isHuman: isHumanCaller(authUser),
	};
}

// ── serializers: the D17 DTOs, key by key ───────────────────────────────────

function serializePreview(preview: CodexApprovalPreview | null): CodexApprovalPreview | null {
	if (!preview) return null;
	return {
		cwd: preview.cwd,
		...(preview.commandHead !== undefined ? { commandHead: preview.commandHead } : {}),
		...(preview.lastLines !== undefined ? { lastLines: preview.lastLines } : {}),
		...(preview.lineCount !== undefined ? { lineCount: preview.lineCount } : {}),
		...(preview.charCount !== undefined ? { charCount: preview.charCount } : {}),
		...(preview.fileCount !== undefined ? { fileCount: preview.fileCount } : {}),
		...(preview.paths !== undefined
			? { paths: preview.paths.map((p) => ({ path: p.path, kind: p.kind })) }
			: {}),
		pathOutsideCwd: preview.pathOutsideCwd,
		nonAscii: preview.nonAscii,
	};
}

function serializeSummary(a: CodexApprovalSummary): CodexApprovalSummary {
	return {
		id: a.id,
		requestKind: a.requestKind,
		state: a.state,
		outcome: a.outcome,
		decision: a.decision,
		answeredAt: a.answeredAt,
		revision: a.revision,
		presentationHash: a.presentationHash,
		approvable: a.approvable,
		notApprovableReason: a.notApprovableReason,
		canCancel: a.canCancel,
		createdAt: a.createdAt,
		expiresAt: a.expiresAt,
		expiresInSeconds: a.expiresInSeconds,
		preview: serializePreview(a.preview),
	};
}

function serializePresentation(
	p: CodexApprovalPresentation | null,
): CodexApprovalPresentation | null {
	if (!p) return null;
	if (p.requestKind === "command") {
		return {
			v: 1,
			requestKind: "command",
			command: p.command,
			cwd: p.cwd,
			reason: p.reason,
			grantRoot: p.grantRoot,
		};
	}
	return {
		v: 1,
		requestKind: "file_change",
		changes: p.changes.map((change) => ({
			path: change.path,
			kind: change.kind,
			movePath: change.movePath,
			diff: change.diff,
		})),
		cwd: p.cwd,
		reason: p.reason,
		grantRoot: p.grantRoot,
	};
}

export function serializeApprovalList(list: CodexApprovalList): CodexApprovalList {
	return {
		v: 1,
		approvals: list.approvals.map(serializeSummary),
		host: { state: list.host.state, name: list.host.name },
		viewer: { canAccept: list.viewer.canAccept },
	};
}

export function serializeApprovalDetail(detail: CodexApprovalDetail): CodexApprovalDetail {
	const presentation = serializePresentation(detail.presentation);
	return {
		v: 1,
		approval: serializeSummary(detail.approval),
		presentation,
		// Beside the presentation, never in it: the hash covers the presentation as the person read it.
		...(presentation?.requestKind === "file_change"
			? { outsideCwd: changesOutsideCwd(presentation) }
			: {}),
		reasonText: detail.reasonText,
	};
}

export function serializeApprovalDecision(
	response: CodexApprovalDecisionResponse,
): CodexApprovalDecisionResponse {
	return { v: 1, approval: serializeSummary(response.approval) };
}

// ── reads ───────────────────────────────────────────────────────────────────

codexApprovalsRouter.get("/sessions/:sessionId/approvals", async (c) => {
	try {
		const list = await listApprovalsForSession(c.req.param("sessionId"), await approvalCaller(c));
		return c.json(serializeApprovalList(list));
	} catch (error) {
		if (error instanceof ApprovalRefusal) return refuse(c, error.code);
		throw error;
	}
});

codexApprovalsRouter.get("/sessions/:sessionId/approvals/:approvalId", async (c) => {
	try {
		const detail = await getApprovalDetail(
			c.req.param("sessionId"),
			c.req.param("approvalId"),
			await approvalCaller(c),
		);
		return c.json(serializeApprovalDetail(detail));
	} catch (error) {
		if (error instanceof ApprovalRefusal) return refuse(c, error.code);
		throw error;
	}
});

// ── the decision ────────────────────────────────────────────────────────────

const limitBody = bodyLimit({
	maxSize: MAX_BODY_BYTES,
	onError: (c) => c.json({ error: "invalid_decision" }, 400),
});

codexApprovalsRouter.post(
	"/sessions/:sessionId/approvals/:approvalId/decision",
	requireBrowserOriginGate,
	limitBody,
	async (c) => {
		// Step 2: the body. A wrong content type, bad JSON or a non-object is the same fixed code as a bad decision.
		if (!isJsonContentType(c.req.header("Content-Type"))) return refuse(c, "invalid_decision");
		const body: unknown = await c.req.json().catch(() => null);
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return refuse(c, "invalid_decision");
		}
		const { decision, presentationHash } = body as Record<string, unknown>;
		const sessionId = c.req.param("sessionId");
		try {
			// Steps 2 (the decision's value) to 8 are answerApproval's, in the order the plan lists.
			const answered = await answerApproval(
				sessionId,
				c.req.param("approvalId"),
				{ decision, presentationHash },
				await approvalCaller(c),
			);
			const session = await getSession(sessionId);
			if (session) notifySessionUpdated(session);
			return c.json(serializeApprovalDecision(answered));
		} catch (error) {
			if (error instanceof ApprovalRefusal) return refuse(c, error.code);
			throw error;
		}
	},
);

export { codexApprovalsRouter };
