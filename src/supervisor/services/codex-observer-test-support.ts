import type { ObserverRules } from "./codex-observer.js";

/**
 * "There are no exclude rules", spelled out for a test that is not about them.
 * The observer treats a missing rules argument as "cannot judge: post nothing",
 * so a test that wants events posted says so with this.
 */
export const NO_EXCLUDE_RULES: ObserverRules = {
	current: () => ({ state: "none", rules: [] }),
};
