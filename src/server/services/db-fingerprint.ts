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

import { getOrCreateInstallationId } from "./telemetry.js";

const FINGERPRINT_SALT = "agentpulse-db-fingerprint:";
const FINGERPRINT_LENGTH = 12;

export async function getDbFingerprint(): Promise<string> {
	const installation = await getOrCreateInstallationId();
	const data = new TextEncoder().encode(`${FINGERPRINT_SALT}${installation.id}`);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, FINGERPRINT_LENGTH);
}
