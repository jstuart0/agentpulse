/**
 * The one function that turns a database's installation id into the non-reversible fingerprint /health
 * reports (`instance.dbFingerprint`). The server and the updater (which reads the id from a SQLite file
 * it is about to snapshot) both call it, so the two can never disagree about which database is which.
 * No imports: the web, the updater and the server can all take it.
 */
export const INSTALLATION_ID_KEY = "installation_id";

const FINGERPRINT_SALT = "agentpulse-db-fingerprint:";
export const FINGERPRINT_LENGTH = 12;

export async function fingerprintOf(installationId: string): Promise<string> {
	const data = new TextEncoder().encode(`${FINGERPRINT_SALT}${installationId}`);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, FINGERPRINT_LENGTH);
}
