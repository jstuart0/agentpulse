/**
 * The mutations of the T123 scenarios. A leaf module (types only), so the runner can import it without
 * a cycle through the helpers.
 */
import type { Mutation } from "../claude-canary-runner.js";

export const T123_MUTATIONS: Record<string, Mutation> = {
	"ignore-exclude": {
		scenario: "tool-detail",
		layers: [
			"ignore-exclude: the gate answers 'no rules, nothing excluded' to the fork's detail judge, so a Read through a symlink into an excluded directory and a Bash command are judged send",
		],
		expectation: "no detail is kept for the excluded calls",
	},
	"detail-in-row": {
		scenario: "tool-detail",
		layers: [
			"detail-in-row: the host puts the file's contents (the Read's output) in the text of the turn's 'ran without asking' row. It goes in content because AGEN-122's server whitelist strips any extra rawPayload key (a `leaked` key there survives by design, held by managed-session-state.test.ts); content is a field the whitelist keeps, so only the owner-only detail rule and the leak scan stand in the way",
		],
		expectation: "the file's contents are in no stored row",
	},
};
