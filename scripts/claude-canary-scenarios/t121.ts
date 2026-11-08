/**
 * The live canary scenarios of one fork follow-up ticket (AGEN-119..123). Empty in Track 0: the ticket's own
 * track adds its ids to `T121_SCENARIO_IDS` and a function for each to `T121_SCENARIOS`, and its mutations to
 * `t121-mutations.ts`. Scenarios import what they need from `./helpers.js` and nothing else from the canary.
 */
import type { ScenarioFn } from "./helpers.js";

export const T121_SCENARIO_IDS = [] as const;
export const T121_SCENARIOS: Record<(typeof T121_SCENARIO_IDS)[number], ScenarioFn> = {};
