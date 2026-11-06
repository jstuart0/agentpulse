/**
 * The sentence for each way an answer to a Codex approval can be refused (AGEN-87, 6.7). An
 * exhaustive `Record` over the server's refusal codes, so a code added to the contract can't
 * silently render nothing. Deliberately NOT registered with `registerApiErrorMessages`: that is one
 * global table where `expired`, `already_resolved` and `not_approvable` already carry the watcher's
 * wording. Follows `describeHitlError`.
 */
import type { ApprovalAnswerRefusal, NotApprovableReason } from "../../shared/codex-approvals.js";
import {
	type ApprovalAgent,
	agentName,
	hostLabel,
	notApprovableReasonCopy,
	ownerLabelOr,
} from "../components/session-detail/codex-approval-view.js";
import { describeApiError } from "./api-errors.js";
import { ApiError } from "./api.js";

export interface ErrorCtx {
	host: string | null | undefined;
	owner: string | null | undefined;
	/** The clock time the row declines at, or null. */
	declinesAt: string | null;
	reason: NotApprovableReason | null;
	grantRoot?: string | null;
	/** Whose request this was; absent means Codex. */
	agent?: ApprovalAgent;
}

type ApprovalErrorCode = ApprovalAnswerRefusal | "bad_origin";

const ERROR_COPY: Record<ApprovalErrorCode, (ctx: ErrorCtx) => string> = {
	bad_origin: () =>
		"AgentPulse refused this because the page's address doesn't match its own. Nothing was sent. Open AgentPulse at its usual address (PUBLIC_URL) and try again.",
	invalid_decision: () =>
		"That isn't an answer AgentPulse can send. Nothing was sent. Reload and try again.",
	not_owner: ({ owner }) =>
		`Only ${ownerLabelOr(owner)} or an admin can answer this. Nothing was sent.`,
	human_required: () => "Approving needs a signed-in person. Nothing was sent.",
	approval_not_found: () =>
		"This request no longer exists. The session may have been deleted. Nothing was sent.",
	already_resolved: () => "This was already answered. The outcome is shown here.",
	expired: () =>
		"Time ran out before your answer arrived. It was declined automatically, and nothing ran.",
	presentation_hash_required: () =>
		"AgentPulse couldn't tell which version you reviewed. Nothing was sent. Reload and review it again.",
	not_approvable: ({ reason, grantRoot, agent, host }) =>
		`${notApprovableReasonCopy(reason, grantRoot, agent, host)} You can only decline it here.`,
	host_offline: ({ host, declinesAt }) =>
		`${hostLabel(host)} is offline, so your answer can't reach it. Nothing was sent.${
			declinesAt ? ` You can answer if it's back before ${declinesAt}.` : ""
		}`,
	host_gone: () =>
		"This session's host was removed from AgentPulse, so it can't be answered here. Nothing was sent.",
	presentation_changed: ({ agent }) =>
		`${agentName(agent)} changed what it's asking after you opened it. Nothing was sent. Review the new version.`,
	session_stopped: () => "This session was stopped, so nothing was sent.",
};

export const UNCONFIRMED_COPY =
	"AgentPulse couldn't confirm your answer went through. Checking now.";

export function isApprovalErrorCode(code: string | null): code is ApprovalErrorCode {
	return code !== null && Object.hasOwn(ERROR_COPY, code);
}

/** The sentence for a known refusal code; null for anything else (the caller says `UNCONFIRMED_COPY` and checks). */
export function approvalErrorCopy(code: string | null, ctx: ErrorCtx): string | null {
	return isApprovalErrorCode(code) ? ERROR_COPY[code](ctx) : null;
}

/** Codes after which the row on screen is out of date, so the list is fetched again. */
export function refusalMeansStale(code: string | null): boolean {
	return (
		code === "already_resolved" ||
		code === "expired" ||
		code === "presentation_changed" ||
		code === "session_stopped" ||
		code === "approval_not_found" ||
		code === "host_offline" ||
		code === "host_gone"
	);
}

export interface ApprovalErrorView {
	text: string;
	/** True when the server never said no: the answer may have landed, so the row must be read again and "nothing was sent" must not be said. */
	unconfirmed: boolean;
	/** The row on screen is out of date: fetch the list again. */
	stale: boolean;
}

/**
 * One failed answer, in words. A code in the table is the server's refusal. `busy` and
 * `password_change_required` keep their shared sentences. Anything else (an unknown code, a 5xx, no
 * answer) is unconfirmed, because an accept may have landed.
 */
export function describeApprovalError(error: unknown, ctx: ErrorCtx): ApprovalErrorView {
	const code = error instanceof ApiError ? error.code : null;
	const known = approvalErrorCopy(code, ctx);
	if (known !== null) return { text: known, unconfirmed: false, stale: refusalMeansStale(code) };
	if (code === "busy" || code === "password_change_required") {
		return { text: describeApiError(error, UNCONFIRMED_COPY), unconfirmed: false, stale: false };
	}
	return { text: UNCONFIRMED_COPY, unconfirmed: true, stale: true };
}
