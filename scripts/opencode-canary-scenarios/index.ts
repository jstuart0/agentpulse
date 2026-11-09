import type { MeasureScenario } from "./measure-kit.js";
import { LIVE_SCENARIOS } from "./measure-live.js";
import { LAYOUT_RUNS_SCENARIOS } from "./measure.js";

/** Every measurement scenario, by the id `--only` takes. */
export const MEASURE_SCENARIOS: Record<string, MeasureScenario> = {
	...LAYOUT_RUNS_SCENARIOS,
	...LIVE_SCENARIOS,
};
