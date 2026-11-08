/**
 * The live canary scenarios of one fork follow-up ticket (AGEN-119..123). Empty in Track 0: the ticket's own
 * track adds its ids to `T123_SCENARIO_IDS` and a function for each to `T123_SCENARIOS`, and its mutations to
 * `t123-mutations.ts`. Scenarios import what they need from `./helpers.js` and nothing else from the canary.
 */
import type { ScenarioFn } from "./helpers.js";

export const T123_SCENARIO_IDS = [] as const;
export const T123_SCENARIOS: Record<(typeof T123_SCENARIO_IDS)[number], ScenarioFn> = {};
