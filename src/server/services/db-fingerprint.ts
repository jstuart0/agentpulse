/**
 * Non-reversible, per-database fingerprint surfaced on GET /api/v1/health
 * (`instance.dbFingerprint`) so an operator can tell, by eye, whether every
 * request their dashboard makes is landing on the same backing database.
 *
 * On SQLite, AgentPulse only supports a single running server instance
 * (CLAUDE.md "Single-replica constraint") — each file-local SQLite database
 * has its own `installation_id`, so two instances fingerprint differently.
 * On Postgres every replica shares one database and therefore one
 * `installation_id`, so all replicas report the same fingerprint — correct
 * by construction, no replica-count logic needed.
 *
 * Derived from telemetry's existing `installation_id` (reusing
 * getOrCreateInstallationId rather than minting a second id), but through a
 * different salted hash than anything telemetry itself sends — the raw
 * installation_id is never exposed, and the fingerprint can't be correlated
 * against a telemetry ping.
 */

import { fingerprintOf } from "../../shared/db-fingerprint.js";
import { getOrCreateInstallationId } from "./telemetry.js";

export async function getDbFingerprint(): Promise<string> {
	const installation = await getOrCreateInstallationId();
	return fingerprintOf(installation.id);
}
