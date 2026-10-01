/**
 * Pure split-database detector. The dashboard polls GET /api/v1/health on
 * an interval and records the returned `instance.dbFingerprint`; this
 * module decides, from the sequence of observations seen so far in this
 * browser session, whether the dashboard has been talking to more than one
 * backing database — the signature of a load-balanced SQLite deployment
 * with more than one running instance (SQLite is single-instance only; see
 * CLAUDE.md "Single-replica constraint").
 *
 * A single clean transition (fingerprint A, then later fingerprint B, never
 * seen again) is tolerated — that's just a server restart minting a fresh
 * installation_id-backed database, not a split-brain. Detection fires only
 * when either:
 *   - the same earlier fingerprint reappears after a different one was
 *     seen (A -> B -> A alternation), or
 *   - two distinct fingerprints are observed within a 5-minute window of
 *     each other (two instances answering concurrently).
 */

export interface FingerprintObservation {
	fingerprint: string;
	atMs: number;
}

const CLOSE_WINDOW_MS = 5 * 60 * 1000;

export function detectSplitDatabase(observations: FingerprintObservation[]): boolean {
	if (observations.length < 2) return false;

	const sorted = [...observations].sort((a, b) => a.atMs - b.atMs);

	// Two distinct fingerprints within CLOSE_WINDOW_MS of each other.
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			if (sorted[j].atMs - sorted[i].atMs > CLOSE_WINDOW_MS) break;
			if (sorted[i].fingerprint !== sorted[j].fingerprint) return true;
		}
	}

	// Alternation: fingerprint X, then a different one, then X again.
	for (let i = 0; i < sorted.length; i++) {
		let sawDifferent = false;
		for (let j = i + 1; j < sorted.length; j++) {
			if (sorted[j].fingerprint !== sorted[i].fingerprint) {
				sawDifferent = true;
			} else if (sawDifferent) {
				return true;
			}
		}
	}

	return false;
}
