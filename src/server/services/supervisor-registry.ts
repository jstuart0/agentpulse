import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { supervisors } from "../db/schema.js";
import type {
	SupervisorCapabilities,
	SupervisorRecord,
	SupervisorRegistrationInput,
	SupervisorStatus,
} from "../../shared/types.js";

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
		capabilities: (row.capabilities ?? {
			version: 1,
			agentTypes: [],
			launchModes: [],
			os: "unknown",
			terminalSupport: [],
			features: [],
		}) as unknown as SupervisorCapabilities,
		trustedRoots: row.trustedRoots ?? [],
		status: deriveStatus(row.heartbeatLeaseExpiresAt, row.enrollmentState),
		capabilitySchemaVersion: row.capabilitySchemaVersion,
		configSchemaVersion: row.configSchemaVersion,
		lastHeartbeatAt: row.lastHeartbeatAt,
		heartbeatLeaseExpiresAt: row.heartbeatLeaseExpiresAt,
		enrollmentState: (row.enrollmentState as SupervisorRecord["enrollmentState"]) ?? "active",
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function registerSupervisor(input: SupervisorRegistrationInput) {
	const id = input.id ?? crypto.randomUUID();
	const timestamp = nowIso();
	const leaseExpiry = leaseExpiryIso();

	await db
		.insert(supervisors)
		.values({
			id,
			hostName: input.hostName,
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
		})
		.onConflictDoUpdate({
			target: supervisors.id,
			set: {
				hostName: input.hostName,
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
			},
		});

	const [row] = await db.select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	if (!row) throw new Error("Supervisor registration failed");

	return {
		supervisor: mapSupervisor(row),
		heartbeatIntervalMs: HEARTBEAT_LEASE_MS / 3,
	};
}

export async function heartbeatSupervisor(id: string) {
	const timestamp = nowIso();
	const leaseExpiry = leaseExpiryIso();
	const [existing] = await db.select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	if (!existing) return null;

	await db
		.update(supervisors)
		.set({
			status: "connected",
			lastHeartbeatAt: timestamp,
			heartbeatLeaseExpiresAt: leaseExpiry,
			updatedAt: timestamp,
		})
		.where(eq(supervisors.id, id));

	const [row] = await db.select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	return row ? mapSupervisor(row) : null;
}

export async function listSupervisors() {
	const rows = await db.select().from(supervisors).orderBy(desc(supervisors.updatedAt));
	return rows.map(mapSupervisor);
}

export async function getSupervisor(id: string) {
	const [row] = await db.select().from(supervisors).where(eq(supervisors.id, id)).limit(1);
	return row ? mapSupervisor(row) : null;
}

export async function getConnectedSupervisor(id?: string | null) {
	if (id) {
		const [row] = await db
			.select()
			.from(supervisors)
			.where(and(eq(supervisors.id, id), gt(supervisors.heartbeatLeaseExpiresAt, nowIso())))
			.limit(1);
		return row ? mapSupervisor(row) : null;
	}

	const [row] = await db
		.select()
		.from(supervisors)
		.where(gt(supervisors.heartbeatLeaseExpiresAt, nowIso()))
		.orderBy(desc(supervisors.updatedAt))
		.limit(1);

	return row ? mapSupervisor(row) : null;
}

export async function revokeSupervisor(id: string) {
	await db
		.update(supervisors)
		.set({
			status: "offline",
			enrollmentState: "revoked",
			heartbeatLeaseExpiresAt: nowIso(),
			updatedAt: nowIso(),
		})
		.where(eq(supervisors.id, id));
}
