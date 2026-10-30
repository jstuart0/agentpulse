/**
 * The one seeding source for supervisor-liveness tests. `connected` and
 * `offline` differ by the lease, never by the stored `status` column (which
 * no server reader consults), so a test can't pass on the column alone.
 */
import { getDb } from "../db/client.js";
import { managedSessions, sessions, supervisors } from "../db/schema/index.js";
import { seedOwnedLaunch } from "./owned-launch.js";

const DEFAULT_LEASE_OFFSET_MS = 60_000;

interface SeedSupervisorBase {
	/** Stored verbatim. `null` omits the column so the DDL default applies. */
	rawLease?: string | null;
	storedStatus?: string;
	enrollmentState?: string;
	hostName?: string;
	/** Stored as given; an ISO string. Default: now. */
	updatedAt?: string;
	capabilities?: Record<string, unknown>;
}

/**
 * An explicit offset must name the instant it is relative to, so the lease
 * and the reader's injected `nowMs` can't come from different clocks.
 */
export type SeedSupervisorOptions = SeedSupervisorBase &
	(
		| { leaseOffsetMs: number; leaseBaseMs: number }
		| { leaseOffsetMs?: undefined; leaseBaseMs?: undefined }
	);

export async function seedSupervisor(id: string, opts: SeedSupervisorOptions = {}) {
	const now = new Date().toISOString();
	const lease =
		opts.rawLease === undefined
			? new Date(
					(opts.leaseBaseMs ?? Date.now()) + (opts.leaseOffsetMs ?? DEFAULT_LEASE_OFFSET_MS),
				).toISOString()
			: opts.rawLease;
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: opts.hostName ?? id,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: opts.capabilities ?? {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless", "interactive_terminal"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
			status: opts.storedStatus ?? "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			...(lease === null ? {} : { heartbeatLeaseExpiresAt: lease }),
			enrollmentState: opts.enrollmentState ?? "active",
			createdAt: now,
			updatedAt: opts.updatedAt ?? now,
		})
		.execute();
}

export interface SeedManagedSessionInput {
	sessionId: string;
	supervisorId: string;
	managedState: string;
	session?: {
		status?: string;
		isWorking?: boolean;
		/** Written as given; use `toISOString()`, the format the event processor writes. */
		lastActivityAt?: string;
		endedAt?: string | null;
	};
}

/** Owned launch + managed row + session row, owned by `supervisorId`. */
export async function seedManagedSession(input: SeedManagedSessionInput) {
	// Destructured: the owner-of-record drift guard counts property reads of the supervisor id.
	const { sessionId, supervisorId, managedState, session } = input;
	const { launchId } = await seedOwnedLaunch(sessionId, supervisorId);
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: session?.status ?? "active",
			isWorking: session?.isWorking ?? false,
			lastActivityAt: session?.lastActivityAt ?? now,
			endedAt: session?.endedAt ?? null,
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launchId,
			supervisorId,
			managedState,
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}
