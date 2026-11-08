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
			"detail-in-row: the host puts the file's contents (the Read's output) in the payload of the turn's 'ran without asking' row. Until AGEN-122's per-kind payload whitelist is in the server this must be caught by the leak scan; with the whitelist the server strips the key and this mutation then survives, which is the whitelist working (the plan's second variant disables it)",
		],
		expectation: "the file's contents are in no stored row",
	},
};
