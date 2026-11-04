/**
 * Closing a Codex approval row (AGEN-87): the one writer of `closed_reason`.
 *
 * A leaf on purpose: it imports only the schema and the shared types, so the Stop
 * fence (which control-actions.ts calls inside its own transaction) can use it
 * without pulling in the approval service and the event, notifier and session
 * modules that service depends on.
 */
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type {
	ApprovalClosedReason,
	ApprovalDecision,
	ApprovalRequestKind,
	ApprovalStatus,
	TrackerOutcome,
} from "../../shared/codex-approvals.js";
import { codexApprovalAudit, codexApprovals } from "../db/schema/index.js";

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
type Tx = any;

/** What closed, for the side effects that run after the transaction commits. */
export interface ClosedApproval {
	approvalId: string;
	sessionId: string;
	requestKind: ApprovalRequestKind;
	reason: ApprovalClosedReason;
	decision: ApprovalDecision | null;
}

export interface CloseOptions {
	/**
	 * Close only a row still in this state. For a close decided from a read (the
	 * clock says a pending row expired): the row may have been answered since, and a
	 * decision made on the old state must not close the new one.
	 */
	fromStatus?: ApprovalStatus;
	/** The outcome the host reported, stored with the close. */
	hostOutcome?: TrackerOutcome;
	/** Close an answered row only if no accept has been issued to the host. */
	onlyUndelivered?: boolean;
}

/**
 * Closes a row: status closed, the reason, and `presentation` and `reason_text`
 * nulled (retention is off by default, so text must not linger; the hash
 * stays). One guarded statement (`status <> 'closed'`), so the first close wins
 * and `closed_reason` never changes; the row's audit record gets the same
 * reason in the same transaction. Returns what closed, or null when another
 * writer already had.
 *
 * This is the only function that writes `closed_reason`: codex-approvals-callers.guard.test.ts.
 */
export async function closeApproval(
	tx: Tx,
	approvalId: string,
	reason: ApprovalClosedReason,
	nowMs: number,
	options: CloseOptions = {},
): Promise<ClosedApproval | null> {
	const at = new Date(nowMs).toISOString();
	const conditions = [eq(codexApprovals.id, approvalId), ne(codexApprovals.status, "closed")];
	if (options.fromStatus) conditions.push(eq(codexApprovals.status, options.fromStatus));
	if (options.onlyUndelivered) {
		const undelivered = or(
			eq(codexApprovals.status, "pending"),
			isNull(codexApprovals.firstDeliveredAt),
		);
		if (undelivered) conditions.push(undelivered);
	}
	const guard = and(...conditions);
	const changed = await tx
		.update(codexApprovals)
		.set({
			status: "closed",
			closedReason: reason,
			closedAt: at,
			updatedAt: at,
			presentation: null,
			reasonText: null,
			...(options.hostOutcome ? { hostOutcome: options.hostOutcome } : {}),
		})
		.where(guard)
		.returning({
			id: codexApprovals.id,
			sessionId: codexApprovals.sessionId,
			requestKind: codexApprovals.requestKind,
			decision: codexApprovals.decision,
		});
	if (changed.length === 0) return null;
	await tx
		.update(codexApprovalAudit)
		.set({ outcome: reason, completedAt: at })
		.where(
			and(eq(codexApprovalAudit.approvalId, approvalId), eq(codexApprovalAudit.outcome, "pending")),
		);
	const [row] = changed;
	return {
		approvalId: row.id,
		sessionId: row.sessionId,
		requestKind: row.requestKind as ApprovalRequestKind,
		reason,
		decision: (row.decision as ApprovalDecision | null) ?? null,
	};
}
