/**
 * The Stop fence for Codex approvals (AGEN-87, D16).
 *
 * Stop only queues: a host claims it about two seconds later, and the host's 1 s
 * approval sync takes no control lock. So Stop must close the door on the server,
 * atomically with queuing, or an accept answered a moment earlier could be issued
 * after Stop. The rule, stated plainly (docs and the card say the same):
 *
 *   No accept is issued after Stop commits. An accept issued before Stop
 *   committed may still run.
 *
 * This leaf imports only the schema and `closeApproval`, so control-actions.ts can
 * call it from inside its own transaction without an import cycle.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { codexApprovals } from "../db/schema/index.js";
import { type ClosedApproval, closeApproval } from "./codex-approvals.js";

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
type Tx = any;

export interface StopFenceResult {
	/** Rows this fence closed, for the side effects the caller runs after its commit. */
	closed: ClosedApproval[];
	/** Rows already issued an accept, now marked so they are never issued again. */
	fenced: number;
}

/**
 * Called from `enqueueStopInTx`, on its transaction, AFTER `takeControlLock`
 * succeeded (so a Stop refused `control_busy` fences nothing) and before commit,
 * so the fence and the lock commit or roll back together:
 *  1. pending rows close `session_stopped`;
 *  2. answered rows no accept was issued for close `session_stopped` (`decision`
 *     stays as the record);
 *  3. answered rows already issued get `fenced_at` and are not issued again.
 *
 * Every statement is guarded, so it composes with a host's concurrent sync: the
 * sync's issuing UPDATE and this fence each win or lose on the row, never both.
 * A row created after this ran is covered by the issue predicate (a Stop is
 * queued) and closed by the sweep.
 */
export async function fenceApprovalsForStop(
	tx: Tx,
	sessionId: string,
	_controlActionId: string,
	nowMs: number,
): Promise<StopFenceResult> {
	const open = await tx
		.select({
			id: codexApprovals.id,
			status: codexApprovals.status,
			firstDeliveredAt: codexApprovals.firstDeliveredAt,
		})
		.from(codexApprovals)
		.where(
			and(
				eq(codexApprovals.sessionId, sessionId),
				inArray(codexApprovals.status, ["pending", "answered"]),
			),
		);
	const result: StopFenceResult = { closed: [], fenced: 0 };
	if (open.length === 0) return result;

	const at = new Date(nowMs).toISOString();
	for (const row of open as Array<{
		id: string;
		status: string;
		firstDeliveredAt: string | null;
	}>) {
		const closed = await closeApproval(tx, row.id, "session_stopped", nowMs, {
			onlyUndelivered: true,
		});
		if (closed) {
			result.closed.push(closed);
			continue;
		}
		// Not closed: it was issued (or closed meanwhile). Mark an issued, still-answered one.
		const fenced = await tx
			.update(codexApprovals)
			.set({ fencedAt: at, updatedAt: at })
			.where(
				and(
					eq(codexApprovals.id, row.id),
					eq(codexApprovals.status, "answered"),
					isNull(codexApprovals.fencedAt),
				),
			)
			.returning({ id: codexApprovals.id });
		result.fenced += fenced.length;
	}
	return result;
}
