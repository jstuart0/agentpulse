/**
 * The three person routes for managed Codex approvals (AGEN-87). Lives in the
 * card's chunk: nothing else in the app calls them.
 */
import type {
	CodexApprovalDecisionRequest,
	CodexApprovalDecisionResponse,
	CodexApprovalDetail,
	CodexApprovalList,
} from "../../shared/codex-approvals.js";
import { request } from "./api.js";

function base(sessionId: string): string {
	return `/sessions/${encodeURIComponent(sessionId)}/approvals`;
}

export function listCodexApprovals(sessionId: string): Promise<CodexApprovalList> {
	return request<CodexApprovalList>(base(sessionId), undefined, { background: true });
}

export function getCodexApproval(
	sessionId: string,
	approvalId: string,
): Promise<CodexApprovalDetail> {
	return request<CodexApprovalDetail>(`${base(sessionId)}/${encodeURIComponent(approvalId)}`);
}

/** The body is built by `decisionBody`: only an accept carries a hash, and it is the one frozen when the confirm step opened. */
export function answerCodexApproval(
	sessionId: string,
	approvalId: string,
	body: CodexApprovalDecisionRequest,
): Promise<CodexApprovalDecisionResponse> {
	return request<CodexApprovalDecisionResponse>(
		`${base(sessionId)}/${encodeURIComponent(approvalId)}/decision`,
		{ method: "POST", body: JSON.stringify(body) },
	);
}
