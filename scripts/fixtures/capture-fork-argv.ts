/**
 * Writes the golden fork argv the argv identity test holds the builders to (AGEN-119..123, Track 0 S0).
 *
 * Generated at base commit 198eda63 (before Track 0 touched `claude-argv.ts`) with:
 *
 *   bun scripts/fixtures/capture-fork-argv.ts > src/supervisor/providers/__fixtures__/fork-argv-golden.json
 *
 * It calls the builders with no options, so it stays runnable after the seams land and must print the
 * same bytes: a diff against the committed file is a behaviour change.
 */
import { forkArgv, inPlaceArgv, probeArgv } from "../../src/supervisor/providers/claude-argv.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const MODES = ["ask", "restricted"] as const;

const golden: Record<string, string[]> = {};
for (const mode of MODES) {
	golden[`fork:${mode}`] = forkArgv({ source: SOURCE, fork: FORK, mode });
	golden[`inPlace:${mode}`] = inPlaceArgv({
		fork: FORK,
		record: { source: SOURCE, mode },
		mode,
	});
	golden[`probe:${mode}`] = probeArgv({ mode });
}

console.log(
	JSON.stringify(
		{
			generatedAt: "198eda63",
			command:
				"bun scripts/fixtures/capture-fork-argv.ts > src/supervisor/providers/__fixtures__/fork-argv-golden.json",
			sourceId: SOURCE,
			forkId: FORK,
			argv: golden,
		},
		null,
		"\t",
	),
);
