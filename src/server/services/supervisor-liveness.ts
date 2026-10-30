import type { SupervisorStatus } from "../../shared/types.js";
import { parseDbTimestamp } from "./util/db-time.js";

/** A supervisor heartbeats every third of this; the lease outlives two missed beats. */
export const HEARTBEAT_LEASE_MS = 90_000;

/**
 * The one decision about whether a supervisor is connected. Every server
 * reader goes through this (or `isSupervisorLive`), never the stored status
 * column (written, never read) and never a hand-written lease compare.
 *
 * Pure: the caller supplies `nowMs`. The lease may be any stored form (ISO
 * `Z`, bare SQLite, Postgres `+00`; zone-less reads as UTC). Null/undefined
 * covers a left-joined owner with no supervisors row. Anything unparseable
 * or revoked is offline; `connected` needs a strictly unexpired lease.
 */
export function deriveSupervisorStatus(
	leaseExpiresAt: string | null | undefined,
	enrollmentState: string | null | undefined,
	nowMs: number,
): SupervisorStatus {
	if (enrollmentState === "revoked") return "offline";
	const expiry = parseDbTimestamp(leaseExpiresAt);
	if (expiry === null) return "offline";
	if (expiry > nowMs) return "connected";
	if (expiry > nowMs - HEARTBEAT_LEASE_MS) return "stale";
	return "offline";
}

export function isSupervisorLive(
	leaseExpiresAt: string | null | undefined,
	enrollmentState: string | null | undefined,
	nowMs: number,
): boolean {
	return deriveSupervisorStatus(leaseExpiresAt, enrollmentState, nowMs) === "connected";
}
