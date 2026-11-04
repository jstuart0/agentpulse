/**
 * Shared fixtures for the Codex approval suites (AGEN-87): a managed Codex session
 * on a live host, report builders, callers, and a clean-up that can empty the
 * append-only audit (only a test may, and only by taking its guard off for the
 * duration of the delete).
 *
 * Not a test file. Import after `../db/__test_db.js` / `../services/ai/__test_db.js`.
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { CodexApprovalReportRequest } from "../../shared/codex-approvals.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { CODEX_APPROVAL_TRIGGERS_SQLITE } from "../db/codex-approvals-ddl.js";
import {
	events,
	codexApprovalAudit,
	codexApprovals,
	controlActions,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
	users,
} from "../db/schema/index.js";
import { executeRows } from "../db/sql-helpers.js";
import type { ApprovalCaller } from "../services/codex-approvals.js";
import { createFakeClock } from "./fake-clock.js";
import { seedOwnedLaunch } from "./owned-launch.js";

/** A clock that starts at the real now (leases are real-time) and moves only when the test says. */
export function createApprovalClock(): {
	now: () => number;
	advance: (ms: number) => void;
	set: (ms: number) => void;
	start: number;
} {
	const start = Date.now();
	const clock = createFakeClock();
	let offset = 0;
	return {
		start,
		now: () => start + offset + clock.now(),
		advance: (ms) => {
			offset += ms;
		},
		set: (ms) => {
			offset = ms - start;
		},
	};
}

export interface SeededApprovalSession {
	sessionId: string;
	supervisorId: string;
}

/**
 * A managed Codex session owned by a live host: the session row, the claimed
 * launch (which makes the host the owner of record), the managed row and the
 * host. `ownerUserId` is the session's owner (null for an unowned session).
 */
export async function seedApprovalSession(input: {
	sessionId: string;
	supervisorId?: string;
	ownerUserId?: string | null;
	hostName?: string;
	host?: "live" | "none";
}): Promise<SeededApprovalSession> {
	// Destructured, not read as a property: the ownership drift guard counts property reads of the host id.
	const { supervisorId = "approval-host" } = input;
	await getDb()
		.insert(sessions)
		.values({
			sessionId: input.sessionId,
			agentType: "codex_cli",
			ownerUserId: input.ownerUserId ?? null,
			cwd: "/work/project",
		})
		.onConflictDoNothing();
	const { launchId } = await seedOwnedLaunch(input.sessionId, supervisorId, {
		host: input.host ?? "live",
	});
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId: input.sessionId,
			launchRequestId: launchId,
			supervisorId,
			managedState: "managed",
			hostName: input.hostName ?? "build-host",
		})
		.onConflictDoNothing();
	return { sessionId: input.sessionId, supervisorId };
}

/** A command approval report, with everything a normal one carries. Override what a test varies. */
export function commandReport(
	overrides: Partial<CodexApprovalReportRequest> = {},
): CodexApprovalReportRequest {
	return {
		v: 1,
		runtimeEpoch: "epoch-1",
		rpcId: "1",
		requestKind: "command",
		threadId: "thread-1",
		turnId: "turn-1",
		itemId: "item-1",
		providerApprovalId: null,
		ageMs: 0,
		revision: 1,
		command: "npm test",
		cwd: "/work/project",
		reason: null,
		grantRoot: null,
		truncated: false,
		declineOnly: [],
		...overrides,
	};
}

export function fileChangeReport(
	overrides: Partial<CodexApprovalReportRequest> = {},
): CodexApprovalReportRequest {
	return commandReport({
		requestKind: "file_change",
		command: undefined,
		cwd: "/work/project",
		changes: [{ path: "/work/project/a.txt", kind: "add", movePath: null, diff: "+hello\n" }],
		...overrides,
	});
}

/** A signed-in admin in solo mode (the default instance). */
export const SOLO_PERSON: ApprovalCaller = {
	actor: { userId: null, label: "user", role: "admin", mode: "solo" },
	keyId: null,
	isHuman: true,
};

export function teamCaller(
	userId: string | null,
	role: "admin" | "member" | "none",
	options: { human?: boolean; keyId?: string | null; label?: Actor["label"] } = {},
): ApprovalCaller {
	return {
		actor: { userId, label: options.label ?? "user", role, mode: "team" },
		keyId: options.keyId ?? null,
		isHuman: options.human ?? true,
	};
}

export async function seedUser(
	id: string,
	options: { role?: "admin" | "user"; disabled?: boolean } = {},
): Promise<void> {
	await getDb()
		.insert(users)
		.values({
			id,
			username: id,
			passwordHash: "not-a-real-hash",
			role: options.role ?? "user",
			disabledAt: options.disabled ? new Date().toISOString() : null,
		})
		.onConflictDoUpdate({
			target: users.id,
			set: {
				role: options.role ?? "user",
				disabledAt: options.disabled ? new Date().toISOString() : null,
			},
		});
}

const STOP_ACTION_TYPE = "stop";

/** Queue a Stop on the session the way the control path leaves one: the action row and the lock pointing at it. */
export async function seedActiveStop(sessionId: string, status = "queued"): Promise<string> {
	const id = crypto.randomUUID();
	// Not the literal the production writer set is counted by (P11).
	await getDb()
		.insert(controlActions)
		.values({ id, sessionId, actionType: STOP_ACTION_TYPE, status });
	await getDb()
		.update(managedSessions)
		.set({
			activeControlActionId: id,
			controlLockExpiresAt: new Date(Date.now() + 90_000).toISOString(),
		})
		.where(eq(managedSessions.sessionId, sessionId));
	return id;
}

export async function clearActiveStop(sessionId: string): Promise<void> {
	await getDb()
		.update(managedSessions)
		.set({ activeControlActionId: null, controlLockExpiresAt: null })
		.where(eq(managedSessions.sessionId, sessionId));
}

/** Rows of the approvals table for a session, oldest first. */
export async function approvalRows(sessionId: string) {
	return getDb()
		.select()
		.from(codexApprovals)
		.where(eq(codexApprovals.sessionId, sessionId))
		.orderBy(codexApprovals.createdAt, codexApprovals.id);
}

export async function auditRows(sessionId: string) {
	return getDb()
		.select()
		.from(codexApprovalAudit)
		.where(eq(codexApprovalAudit.sessionId, sessionId));
}

/**
 * Empties the audit for these sessions. The audit is append-only, so this takes
 * its delete guard off for the duration (SQLite: drop and recreate the trigger;
 * Postgres: disable user triggers on the table), which only a test may do.
 */
export async function wipeAuditForTest(sessionIds: readonly string[]): Promise<void> {
	if (sessionIds.length === 0) return;
	const db = getDb();
	if (config.dialect === "postgres") {
		await executeRows(db, sql`ALTER TABLE codex_approval_audit DISABLE TRIGGER USER`);
		try {
			await db
				.delete(codexApprovalAudit)
				.where(inArray(codexApprovalAudit.sessionId, [...sessionIds]));
		} finally {
			await executeRows(db, sql`ALTER TABLE codex_approval_audit ENABLE TRIGGER USER`);
		}
		return;
	}
	await executeRows(db, sql`DROP TRIGGER IF EXISTS trg_codex_approval_audit_delete`);
	try {
		await db
			.delete(codexApprovalAudit)
			.where(inArray(codexApprovalAudit.sessionId, [...sessionIds]));
	} finally {
		const trigger = CODEX_APPROVAL_TRIGGERS_SQLITE.find((s) =>
			s.includes("trg_codex_approval_audit_delete"),
		);
		if (trigger) await executeRows(db, sql.raw(trigger));
	}
}

/** Remove every row these suites create, for the given sessions and hosts. */
export async function cleanApprovalFixtures(
	sessionIds: readonly string[],
	supervisorIds: readonly string[] = [],
): Promise<void> {
	const db = getDb();
	if (sessionIds.length > 0) {
		await wipeAuditForTest(sessionIds);
		await db.delete(codexApprovals).where(inArray(codexApprovals.sessionId, [...sessionIds]));
		await db.delete(controlActions).where(inArray(controlActions.sessionId, [...sessionIds]));
		await db.delete(events).where(inArray(events.sessionId, [...sessionIds]));
		await db.delete(managedSessions).where(inArray(managedSessions.sessionId, [...sessionIds]));
		await db
			.delete(launchRequests)
			.where(inArray(launchRequests.launchCorrelationId, [...sessionIds]));
		await db.delete(sessions).where(inArray(sessions.sessionId, [...sessionIds]));
	}
	if (supervisorIds.length > 0) {
		await db.delete(supervisors).where(inArray(supervisors.id, [...supervisorIds]));
	}
}
