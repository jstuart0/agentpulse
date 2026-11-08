/**
 * The live canary scenarios of one fork follow-up ticket (AGEN-119..123). Empty in Track 0: the ticket's own
 * track adds its ids to `T120_SCENARIO_IDS` and a function for each to `T120_SCENARIOS`, and its mutations to
 * `t120-mutations.ts`. Scenarios import what they need from `./helpers.js` and nothing else from the canary.
 */
import type { ScenarioFn } from "./helpers.js";

export const T120_SCENARIO_IDS = [] as const;
export const T120_SCENARIOS: Record<(typeof T120_SCENARIO_IDS)[number], ScenarioFn> = {};
