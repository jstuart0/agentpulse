import { create } from "zustand";
import { setNetworkHandler } from "../lib/api.js";

interface ReachabilityState {
	/** A request failed before any answer came back, and none has succeeded since. */
	unreachable: boolean;
	/** Probes that failed since the last answer; drives the retry backoff. Requests that failed together are one outage, not several attempts. */
	attempt: number;
	/** Bumps each time the server answers again after an outage, so views can refetch. */
	recoveries: number;
	reportFailure: () => void;
	/** The notice's own retry probe went unanswered: the next wait is longer. */
	reportProbeFailure: () => void;
	reportSuccess: () => void;
}

export const useReachabilityStore = create<ReachabilityState>((set, get) => ({
	unreachable: false,
	attempt: 0,
	recoveries: 0,
	reportFailure: () => set({ unreachable: true }),
	reportProbeFailure: () => set((s) => ({ attempt: s.attempt + 1 })),
	reportSuccess: () => {
		if (!get().unreachable) return;
		set((s) => ({ unreachable: false, attempt: 0, recoveries: s.recoveries + 1 }));
	},
}));

setNetworkHandler({
	failed: () => useReachabilityStore.getState().reportFailure(),
	ok: () => useReachabilityStore.getState().reportSuccess(),
});
