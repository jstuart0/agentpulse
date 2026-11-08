/**
 * The live canary scenarios of one fork follow-up ticket (AGEN-119..123). Empty in Track 0: the ticket's own
 * track adds its ids to `T122_SCENARIO_IDS` and a function for each to `T122_SCENARIOS`, and its mutations to
 * `t122-mutations.ts`. Scenarios import what they need from `./helpers.js` and nothing else from the canary.
 */
import type { ScenarioFn } from "./helpers.js";

export const T122_SCENARIO_IDS = [] as const;
export const T122_SCENARIOS: Record<(typeof T122_SCENARIO_IDS)[number], ScenarioFn> = {};
