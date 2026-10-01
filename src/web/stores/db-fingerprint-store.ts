import { create } from "zustand";
import { type FingerprintObservation, detectSplitDatabase } from "../lib/db-fingerprint-watch.js";

// Capped so a long-lived tab doesn't grow this unboundedly; far more than
// enough history to catch an alternation or a close-window pair at the
// ~60s poll cadence this is fed from.
const MAX_OBSERVATIONS = 50;

interface DbFingerprintStore {
	observations: FingerprintObservation[];
	splitDetected: boolean;
	record: (fingerprint: string, atMs?: number) => void;
}

/**
 * In-memory (not localStorage-backed, by design — "this browser session")
 * record of every `instance.dbFingerprint` this dashboard has observed from
 * GET /api/v1/health, and the derived split-database verdict. Fed by
 * App.tsx's periodic health poll and HostsPage's own load.
 */
export const useDbFingerprintStore = create<DbFingerprintStore>((set, get) => ({
	observations: [],
	splitDetected: false,

	record: (fingerprint, atMs = Date.now()) => {
		const observations = [...get().observations, { fingerprint, atMs }].slice(-MAX_OBSERVATIONS);
		set({ observations, splitDetected: detectSplitDatabase(observations) });
	},
}));
