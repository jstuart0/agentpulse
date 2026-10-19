import { and, asc, eq, isNull } from "drizzle-orm";
import { privilegeCliArgs } from "../../shared/launch-privileges.js";
import type { LaunchRequest, LaunchRequestStatus } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { launchRequests, sessions } from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { requestWsRevalidation } from "../ws/revalidation.js";
import { applyAskInitiatedWatcher } from "./ai/auto-watcher.js";
import { resolveObservedSessionCorrelation } from "./correlation-resolver.js";
import { markSessionFailed } from "./event-processor.js";
import { ENFORCES_LAUNCH_PRIVILEGES } from "./launch-compatibility.js";
import { mapLaunchRequest } from "./launch-validator.js";
import { attachManagedSessionToLaunch } from "./managed-session-state.js";
import { dispatchEvent } from "./push/dispatch.js";
import { findLaunchRowByCorrelationId } from "./session-ownership.js";
import { getSupervisor } from "./supervisor-registry.js";

const PENDING_LAUNCH_STATUSES: readonly LaunchRequestStatus[] = [
	"validated",
	"queued",
	"launching",
	"awaiting_session",
];

const PROVENANCE_KEYS = ["aiInitiated", "askThreadId"] as const;

// Auto-generated adjective-noun shape from name-generator.ts. We only
// rewrite the displayName when it still matches this pattern — once a
// user (or a custom rename) has changed it, we leave it alone.
const AUTO_NAME_PATTERN = /^[a-z]+-[a-z]+$/;

/**
 * If the just-correlated launch_request carries a slice-3 desired display
 * name, rewrite sessions.displayName — but only when the existing name is
 * still in adjective-noun shape. Idempotent: a second call after the rename
 * sees the new name (which no longer matches the pattern) and is a no-op.
 */
export async function applyDesiredDisplayName(
	sessionId: string,
	launchRequest: LaunchRequest,
): Promise<void> {
	const desired = launchRequest.desiredDisplayName;
	if (!desired) return;

	const [row] = await getDb()
		.select({ displayName: sessions.displayName })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return;
	if (!row.displayName || !AUTO_NAME_PATTERN.test(row.displayName)) return;
	if (row.displayName === desired) return;

	await getDb()
		.update(sessions)
		.set({ displayName: desired })
		.where(eq(sessions.sessionId, sessionId));
}

/**
 * Copy any provenance hints stamped on launch_requests.metadata onto the
 * just-correlated session row. Idempotent: a re-correlation never clobbers
 * existing keys with stale values, so manually edited session metadata stays
 * intact. Returns silently when there is nothing to merge.
 */
async function applyLaunchProvenanceToSession(
	sessionId: string,
	launchMetadata: Record<string, unknown> | null,
) {
	if (!launchMetadata) return;
	const provenance: Record<string, unknown> = {};
	for (const key of PROVENANCE_KEYS) {
		const value = launchMetadata[key];
		if (value !== undefined && value !== null) provenance[key] = value;
	}
	if (Object.keys(provenance).length === 0) return;

	// Late read-modify-write inside a transaction: re-read metadata
	// immediately before writing so a concurrent writer's keys (e.g.
	// applyPermissionWaitTransition's permissionWait) aren't clobbered by a
	// stale early snapshot. Same pattern and honesty level as Decision 10.
	await withTransaction(async (tx) => {
		const [row] = await tx
			.select({ metadata: sessions.metadata })
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId))
			.limit(1);
		if (!row) return;

		const existing = (row.metadata as Record<string, unknown> | null) ?? {};
		let changed = false;
		const merged: Record<string, unknown> = { ...existing };
		for (const [k, v] of Object.entries(provenance)) {
			if (existing[k] === undefined) {
				merged[k] = v;
				changed = true;
			}
		}
		if (!changed) return;

		await tx.update(sessions).set({ metadata: merged }).where(eq(sessions.sessionId, sessionId));
	});
}

function nowIso() {
	return new Date().toISOString();
}

function awaitingDeadlineIso() {
	return new Date(Date.now() + 60_000).toISOString();
}

/** The statuses a person wants to hear about; the ones before them are plumbing. */
const ANNOUNCED_LAUNCH_STATUSES: ReadonlySet<string> = new Set([
	"running",
	"completed",
	"failed",
	"cancelled",
]);

type LaunchRow = typeof launchRequests.$inferSelect;

/**
 * The one writer of `launch_requests.status` after a request exists (the inserts
 * in launch-validator and control-actions create rows; they don't transition
 * them). It reads the prior status when the caller doesn't have it, writes, and
 * tells the phones once per real change into a status worth announcing, after
 * the write has landed.
 */
async function transitionLaunchStatus(
	launchId: string,
	updates: Partial<LaunchRow> & { status: LaunchRequestStatus },
	priorStatus?: string,
): Promise<LaunchRow | undefined> {
	const prior =
		priorStatus ??
		(
			await getDb()
				.select({ status: launchRequests.status })
				.from(launchRequests)
				.where(eq(launchRequests.id, launchId))
				.limit(1)
		)[0]?.status;
	const [updated] = await getDb()
		.update(launchRequests)
		.set(updates)
		.where(eq(launchRequests.id, launchId))
		.returning();
	if (updated && prior !== updates.status && ANNOUNCED_LAUNCH_STATUSES.has(updates.status)) {
		void dispatchEvent({
			type: "launch_status",
			launchId,
			failed: updates.status === "failed",
			requesterUserId: updated.requestedByUserId ?? null,
			...(updated.launchCorrelationId ? { sessionId: updated.launchCorrelationId } : {}),
		});
	}
	return updated;
}

const OLD_SUPERVISOR_ERROR =
	"This host's supervisor is older than the launch's approval policy and sandbox mode settings and would run without them. Update the supervisor, or clear both settings.";

function hasPrivilegeSettings(row: LaunchRow): boolean {
	return row.approvalPolicy != null || row.sandboxMode != null;
}

/**
 * Hands the supervisor its next validated launch. A launch with an approval policy or
 * sandbox mode is only ever handed to a supervisor that advertises it applies them (the
 * check at request time can be stale: the host may have been downgraded or replaced since).
 * One that isn't is failed here, never claimed.
 */
export async function claimNextLaunchRequest(supervisorId: string) {
	const rows = await getDb()
		.select()
		.from(launchRequests)
		.where(
			and(
				eq(launchRequests.requestedSupervisorId, supervisorId),
				eq(launchRequests.status, "validated"),
			),
		)
		.orderBy(asc(launchRequests.createdAt))
		.limit(25);

	let enforces: boolean | undefined;
	for (const row of rows) {
		if (hasPrivilegeSettings(row)) {
			enforces ??= ((await getSupervisor(supervisorId))?.capabilities.features ?? []).includes(
				ENFORCES_LAUNCH_PRIVILEGES,
			);
			if (!enforces) {
				const now = nowIso();
				await transitionLaunchStatus(
					row.id,
					{
						status: "failed",
						error: OLD_SUPERVISOR_ERROR,
						dispatchFinishedAt: now,
						updatedAt: now,
					},
					row.status,
				);
				continue;
			}
		}
		const claimToken = crypto.randomUUID();
		const now = nowIso();
		const claimed = await transitionLaunchStatus(
			row.id,
			{ status: "queued", claimedBySupervisorId: supervisorId, claimToken, updatedAt: now },
			row.status,
		);
		return claimed ? mapLaunchRequest(claimed) : null;
	}
	return null;
}

/**
 * The backstop for version skew and bugs: when a supervisor reports a launch up, the
 * privilege flags it says it applied must be exactly the ones the mapping gives for the
 * row. Missing or different means the launch isn't what was confirmed, so it is failed.
 * Returns the reason, or null when it matches.
 */
export function privilegeMismatch(
	row: LaunchRow,
	reported: Record<string, unknown> | null | undefined,
): string | null {
	const expected = privilegeCliArgs(row.agentType, row.approvalPolicy, row.sandboxMode);
	const privileges = reported?.privileges as { enforcedArgs?: unknown } | undefined;
	const actual = privileges?.enforcedArgs;
	if (actual === undefined) {
		return expected.length === 0
			? null
			: `The supervisor didn't report the privilege flags it applied (expected ${expected.join(" ")}).`;
	}
	if (
		!Array.isArray(actual) ||
		actual.length !== expected.length ||
		actual.some((arg, i) => arg !== expected[i])
	) {
		return `The supervisor reported privilege flags [${Array.isArray(actual) ? actual.join(" ") : "?"}] instead of [${expected.join(" ")}].`;
	}
	return null;
}

export async function updateLaunchDispatchStatus(reported: {
	supervisorId: string;
	launchId: string;
	status: LaunchRequestStatus;
	error?: string | null;
	pid?: number | null;
	providerLaunchMetadata?: Record<string, unknown> | null;
}) {
	const now = nowIso();
	const [row] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, reported.launchId))
		.limit(1);
	if (!row || row.claimedBySupervisorId !== reported.supervisorId) return null;

	const mismatch =
		reported.status === "running" || reported.status === "awaiting_session"
			? privilegeMismatch(
					row,
					reported.providerLaunchMetadata ??
						(row.providerLaunchMetadata as Record<string, unknown> | null),
				)
			: null;
	const input = mismatch
		? { ...reported, status: "failed" as const, error: `Launch failed: ${mismatch}` }
		: reported;

	const updates: Partial<LaunchRow> & { status: LaunchRequestStatus } = {
		status: input.status,
		error: input.error ?? null,
		updatedAt: now,
	};

	if (input.status === "launching") {
		updates.dispatchStartedAt = now;
	}
	if (input.status === "awaiting_session") {
		updates.awaitingSessionDeadlineAt = awaitingDeadlineIso();
		updates.pid = input.pid ?? null;
		updates.providerLaunchMetadata = input.providerLaunchMetadata ?? {};
	}
	if (input.status === "running") {
		updates.dispatchFinishedAt = now;
		updates.pid = input.pid ?? row.pid ?? null;
		if (input.providerLaunchMetadata) {
			updates.providerLaunchMetadata = input.providerLaunchMetadata;
		}
	}
	if (input.status === "completed") {
		updates.dispatchFinishedAt = now;
		updates.pid = input.pid ?? row.pid ?? null;
		if (input.providerLaunchMetadata) {
			updates.providerLaunchMetadata = input.providerLaunchMetadata;
		}
	}
	if (input.status === "failed" || input.status === "cancelled") {
		updates.dispatchFinishedAt = now;
		if (input.providerLaunchMetadata) {
			updates.providerLaunchMetadata = input.providerLaunchMetadata;
		}
	}

	const updated = await transitionLaunchStatus(input.launchId, updates, row.status);

	// P3: propagate launch failure to the correlated session so
	// sessions.status = "failed" is written via event-processor.ts,
	// the integration point Slice 6 alert-rule evaluation hooks into.
	if (input.status === "failed" && updated?.launchCorrelationId) {
		await markSessionFailed(updated.launchCorrelationId).catch((err) => {
			console.warn("[launch-dispatch] markSessionFailed skipped:", err);
		});
	}

	return updated ? mapLaunchRequest(updated) : null;
}

export async function findPendingLaunchForObservedSession(sessionId: string) {
	const row = await findLaunchRowByCorrelationId(sessionId);
	if (!row) return null;
	if (!PENDING_LAUNCH_STATUSES.includes(row.status as LaunchRequestStatus)) return null;
	return mapLaunchRequest(row);
}

export async function markLaunchRunning(launchId: string, priorStatus?: string) {
	const timestamp = nowIso();
	const updated = await transitionLaunchStatus(
		launchId,
		{ status: "running", dispatchFinishedAt: timestamp, updatedAt: timestamp },
		priorStatus,
	);

	return updated ? mapLaunchRequest(updated) : null;
}

/**
 * WS1 ownership contract. Given an observed session id, resolve the
 * pending launch it matches (pure), attach the managed-session row (via
 * the managed-session-state writer), and transition the launch to
 * `running` (this file's own writer). All launch-status transitions for
 * observed correlation live here — routes and hook processors don't
 * compose these writes directly.
 */
export async function associateObservedSession(input: {
	sessionId: string;
	supervisorId?: string | null;
}): Promise<LaunchRequest | null> {
	const resolution = await resolveObservedSessionCorrelation(
		input.sessionId,
		input.supervisorId ?? null,
	);
	if (!resolution) return null;

	await attachManagedSessionToLaunch({
		sessionId: input.sessionId,
		launchRequestId: resolution.launchRequest.id,
		supervisorId: resolution.resolvedSupervisorId,
		correlationSource: "session_id",
	});

	// This is the one place a launch can set a session's owner AFTER
	// creation (the row was created by the supervisor-report path
	// with no launch context yet). Guarded in SQL — it can never take a
	// session that already has an owner.
	if (resolution.launchRequest.requestedByUserId !== null) {
		const filled = await getDb()
			.update(sessions)
			.set({ ownerUserId: resolution.launchRequest.requestedByUserId })
			.where(and(eq(sessions.sessionId, input.sessionId), isNull(sessions.ownerUserId)))
			.returning({ id: sessions.id });
		// An unowned session just gained an owner: sockets that followed it as
		// "open to members" are re-judged. Only when the guarded write took.
		if (filled.length > 0) await requestWsRevalidation();
	}

	await applyLaunchProvenanceToSession(input.sessionId, resolution.launchRequest.metadata);
	await applyDesiredDisplayName(input.sessionId, resolution.launchRequest);
	await applyAskInitiatedWatcher(input.sessionId, resolution.launchRequest.metadata);

	return markLaunchRunning(resolution.launchRequest.id, resolution.launchRequest.status);
}
