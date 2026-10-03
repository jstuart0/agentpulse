// Phase 4 audit: supervisor-registry.ts is clean — no raw getSqlite() calls,
// no json_extract, no datetime('now') literals. The heartbeat-lease timestamp
// (Date.now() + ms).toISOString() is pure JS — fully portable to Postgres.
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type {
	SupervisorRecord,
	SupervisorRegistrationInput,
	SupervisorStatus,
} from "../../shared/types.js";
import { assertOwnerActive, assertOwnerAssignable } from "../auth/owner-state.js";
import {
	prepareSupervisorCredential,
	revokeSupervisorCredential,
	storeSupervisorCredential,
} from "../auth/supervisor-auth.js";
import { awaitSeamInsideAdminLock, withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { supervisors } from "../db/schema/index.js";
import { cleanMachineName } from "./machine-name.js";
import { readTrustedRoots, withCapabilityDefaults } from "./supervisor-capabilities.js";
import { excludeRulesStateOf } from "./supervisor-exclude-state.js";

const HEARTBEAT_LEASE_MS = 90_000;

function nowIso() {
	return new Date().toISOString();
}

function leaseExpiryIso(base = Date.now()) {
	return new Date(base + HEARTBEAT_LEASE_MS).toISOString();
}

function deriveStatus(leaseExpiry: string, enrollmentState?: string | null): SupervisorStatus {
	if (enrollmentState === "revoked") return "offline";
	const expiry = Date.parse(leaseExpiry);
	const now = Date.now();
	if (Number.isNaN(expiry)) return "offline";
	if (expiry > now) return "connected";
	if (expiry > now - HEARTBEAT_LEASE_MS) return "stale";
	return "offline";
}

function mapSupervisor(row: typeof supervisors.$inferSelect): SupervisorRecord {
	return {
		id: row.id,
		hostName: row.hostName,
		platform: row.platform,
		arch: row.arch,
		version: row.version,
		capabilities: withCapabilityDefaults(row.capabilities),
		trustedRoots: readTrustedRoots(row.trustedRoots),
		status: deriveStatus(row.heartbeatLeaseExpiresAt, row.enrollmentState),
		capabilitySchemaVersion: row.capabilitySchemaVersion,
		configSchemaVersion: row.configSchemaVersion,
		lastHeartbeatAt: row.lastHeartbeatAt,
		heartbeatLeaseExpiresAt: row.heartbeatLeaseExpiresAt,
		excludeRulesState: excludeRulesStateOf(row),
		enrollmentState: (row.enrollmentState as SupervisorRecord["enrollmentState"]) ?? "active",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		ownerUserId: row.ownerUserId ?? null,
	};
}

export /**
 * @param createdByUserId The enrollment token's creator. Only ever used on a
 *   brand-new supervisor (the insert path below), where it becomes the
 *   host's owner at first enrollment. Re-registration of an existing
 *   supervisor — including rotation, which also carries an enrollment
 *   token's creator — never changes or fills the owner: a manage-scoped
 *   caller who rotates someone else's (or nobody's) host credential must
 *   not become its owner just by rotating it.
 * @throws OwnerDisabledError when createdByUserId names a disabled user.
 */
async function registerSupervisor(
	input: SupervisorRegistrationInput,
	createdByUserId: string | null = null,
) {
	// A host enrolled for a user is written under the admin lock, in the same
	// transaction as the owner check, so it can't land after (and escape) a
	// disable that revoked that user's hosts. An unowned host has nothing to check.
	if (createdByUserId) {
		return withAdminLock(async (tx) => {
			await assertOwnerActive(tx, createdByUserId);
			return writeSupervisor(tx, input, createdByUserId);
		});
	}
	return writeSupervisor(getDb(), input, null);
}

/**
 * First enrollment: registers the host and issues its credential, replacing any
 * earlier one. For an owned host both happen in the one locked transaction as the
 * owner check — a credential issued after the registration committed could
 * outlive a disable that revoked the host in between.
 */
export async function enrollSupervisor(
	input: SupervisorRegistrationInput,
	createdByUserId: string | null,
) {
	// The credential's hash is made before the admin lock is taken: a locked body
	// on SQLite must not wait on anything but the database.
	const prepared = await prepareSupervisorCredential();
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	const enrollOn = async (handle: any) => {
		const result = await writeSupervisor(handle, input, createdByUserId);
		await revokeSupervisorCredential(result.supervisor.id, handle);
		const issued = await storeSupervisorCredential(
			result.supervisor.id,
			`supervisor:${result.supervisor.hostName}`,
			prepared,
			handle,
		);
		return { ...result, supervisorCredential: issued.token };
	};
	if (!createdByUserId) return enrollOn(getDb());
	return withAdminLock(async (tx) => {
		await assertOwnerActive(tx, createdByUserId);
		return enrollOn(tx);
	});
}

async function writeSupervisor(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	handle: any,
	input: SupervisorRegistrationInput,
	createdByUserId: string | null,
) {
	const id = input.id ?? crypto.randomUUID();
	const hostName = cleanMachineName(input.hostName) ?? "unnamed host";
	const timestamp = nowIso();
	const leaseExpiry = leaseExpiryIso();

	await handle
		.insert(supervisors)
		.values({
			id,
			hostName,
			platform: input.platform,
			arch: input.arch,
			version: input.version,
			capabilities: input.capabilities as unknown as Record<string, unknown>,
			trustedRoots: input.trustedRoots,
			status: "connected",
			capabilitySchemaVersion: input.capabilitySchemaVersion ?? 1,
			configSchemaVersion: input.configSchemaVersion ?? 1,
			lastHeartbeatAt: timestamp,
			heartbeatLeaseExpiresAt: leaseExpiry,
			enrollmentState: "active",
			createdAt: timestamp,
			updatedAt: timestamp,
			ownerUserId: createdByUserId,
		})
		.onConflictDoUpdate({
			target: supervisors.id,
			set: {
				hostName,
				platform: input.platform,
				arch: input.arch,
				version: input.version,
				capabilities: input.capabilities as unknown as Record<string, unknown>,
				trustedRoots: input.trustedRoots,
				status: "connected",
				capabilitySchemaVersion: input.capabilitySchemaVersion ?? 1,
				configSchemaVersion: input.configSchemaVersion ?? 1,
				lastHeartbeatAt: timestamp,
				heartbeatLeaseExpiresAt: leaseExpiry,
				enrollmentState: "active",
				updatedAt: timestamp,
				// Re-registration (including rotation) never touches the owner,
				// set or not — only first enrollment (the insert branch above)
				// does. A no-op write, not a conditional one: createdByUserId is
				// ignored here on purpose.
				ownerUserId: sql`${supervisors.ownerUserId}`,
				// A registration starts from nothing to act on: what the previous run
				// said about its exclude file is not about this one. Written in the same
				// statement (not a second connection) so it holds inside the admin-lock
				// transaction too.
				excludeRulesState: null,
			},
		});

	const [row] = await handle.select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	if (!row) throw new Error("Supervisor registration failed");

	return {
		supervisor: mapSupervisor(row),
		heartbeatIntervalMs: HEARTBEAT_LEASE_MS / 3,
	};
}

export async function heartbeatSupervisor(id: string) {
	const timestamp = nowIso();
	const leaseExpiry = leaseExpiryIso();
	const [existing] = await getDb()
		.select()
		.from(supervisors)
		.where(eq(supervisors.id, id))
		.limit(1);
	if (!existing) return null;

	await getDb()
		.update(supervisors)
		.set({
			status: "connected",
			lastHeartbeatAt: timestamp,
			heartbeatLeaseExpiresAt: leaseExpiry,
			updatedAt: timestamp,
		})
		.where(eq(supervisors.id, id));

	const [row] = await getDb().select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	return row ? mapSupervisor(row) : null;
}

export async function listSupervisors() {
	const rows = await getDb().select().from(supervisors).orderBy(desc(supervisors.updatedAt));
	return rows.map(mapSupervisor);
}

export async function getSupervisor(id: string) {
	const [row] = await getDb().select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	return row ? mapSupervisor(row) : null;
}

export async function getConnectedSupervisor(id?: string | null) {
	if (id) {
		const [row] = await getDb()
			.select()
			.from(supervisors)
			.where(and(eq(supervisors.id, id), gt(supervisors.heartbeatLeaseExpiresAt, nowIso())))
			.limit(1);
		return row ? mapSupervisor(row) : null;
	}

	const [row] = await getDb()
		.select()
		.from(supervisors)
		.where(gt(supervisors.heartbeatLeaseExpiresAt, nowIso()))
		.orderBy(desc(supervisors.updatedAt))
		.limit(1);

	return row ? mapSupervisor(row) : null;
}

/**
 * Accepts an optional transaction handle so a caller running inside
 * withAdminLock (e.g. user disable, which revokes every host the user
 * owns) issues this on the same tx as the rest of the sequence.
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function revokeSupervisor(id: string, tx?: any) {
	await (tx ?? getDb())
		.update(supervisors)
		.set({
			status: "offline",
			enrollmentState: "revoked",
			heartbeatLeaseExpiresAt: nowIso(),
			updatedAt: nowIso(),
		})
		.where(eq(supervisors.id, id));
}

/**
 * Revokes a host and its credential in one transaction: either both change or
 * neither does (a revoke that fails in the middle must not leave a host that
 * is marked revoked with a credential that still works).
 */
export async function revokeHost(id: string): Promise<void> {
	await withAdminLock(async (tx) => {
		await revokeSupervisor(id, tx);
		await awaitSeamInsideAdminLock(revokeHostStepHook, "host-revoked");
		await revokeSupervisorCredential(id, tx);
	});
}

export type SetSupervisorOwnerResult =
	| { found: false }
	| { found: true; from: string | null; to: string | null };

/**
 * Sets (or, with null, clears) a host's owner. The target is checked in the
 * same locked transaction, so a user disabled a moment earlier can't be handed
 * a host. The owner gates rotate and revoke only, never launching on the host.
 */
export async function setSupervisorOwner(
	id: string,
	ownerUserId: string | null,
): Promise<SetSupervisorOwnerResult> {
	return withAdminLock(async (tx) => {
		const [row] = await tx
			.select({ ownerUserId: supervisors.ownerUserId })
			.from(supervisors)
			.where(eq(supervisors.id, id))
			.limit(1);
		if (!row) return { found: false as const };
		if (ownerUserId !== null) await assertOwnerAssignable(tx, ownerUserId);
		await tx
			.update(supervisors)
			.set({ ownerUserId, updatedAt: nowIso() })
			.where(eq(supervisors.id, id));
		return { found: true as const, from: row.ownerUserId, to: ownerUserId };
	});
}

/**
 * Every supervisor a user owns, active or not. Used by disableUser to
 * enumerate hosts to revoke; it passes the admin lock's transaction handle,
 * because a statement on the pool would wait for a second connection while the
 * lock holds the first (a deadlock when the pool has one).
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function listSupervisorIdsOwnedByUser(userId: string, tx?: any): Promise<string[]> {
	const rows = await (tx ?? getDb())
		.select({ id: supervisors.id })
		.from(supervisors)
		.where(eq(supervisors.ownerUserId, userId));
	return rows.map((r: { id: string }) => r.id);
}

// ── Test-only seam ────────────────────────────────────────────────────────
// Lets a test fail revokeHost after the host row is marked revoked and before
// its credential is, to prove the two change together or not at all.
// Enforced by check-no-test-seam-leaks.ts: this export may only be
// referenced from a *.test.ts file or test-utils/.
export type RevokeHostStep = "host-revoked";

let revokeHostStepHook: ((step: RevokeHostStep) => Promise<void>) | null = null;
export function _setRevokeHostStepHookForTest(
	hook: ((step: RevokeHostStep) => Promise<void>) | null,
): void {
	revokeHostStepHook = hook;
}
