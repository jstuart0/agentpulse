/**
 * The mutations of the T120 scenarios. A leaf module (types only), so the runner can import it without
 * a cycle through the helpers. Empty in Track 0.
 */
import type { Mutation } from "../claude-canary-runner.js";

export const T120_MUTATIONS: Record<string, Mutation> = {};
