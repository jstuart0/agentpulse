/**
 * The mutations of the T120 scenarios (AGEN-120). A leaf module (types only), so the runner can import it
 * without a cycle through the helpers. Each breaks one named thing and the scenario's one named expectation
 * must then fail with every precondition holding.
 */
import type { Mutation } from "../claude-canary-runner.js";

export const T120_MUTATIONS: Record<string, Mutation> = {
	"subagent-unlabelled": {
		scenario: "subagent-approve",
		layers: [
			"subagent-unlabelled: the host's approval report loses fromSubagent before it leaves the gate, so the helper's card reads as the fork's own (the presentation-hash unit test fails too)",
		],
		expectation: "the helper's command card is marked as a subagent's",
	},
	"background-allowed": {
		scenario: "subagent-background",
		layers: [
			"background-allowed: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is left out of the inline --settings env and unset in the child's environment (a wrapper in front of the same binary), and unknown_param is stripped from the Agent report so run_in_background is approvable, and the host's own local decline of it is turned into an allow with the original input on the wire (found live: the tracker holds the decline-only verdict a second time), so a background helper can outlive the turn: its line after the result must end the fork subagent_after_turn",
		],
		expectation: "the fork stays managed through a request for a background helper",
	},
	"agent-unasked": {
		scenario: "subagent-approve",
		layers: [
			"agent-unasked: the Agent ask rule is removed from the inline --settings object, so a helper starts with no card for the Agent call itself",
		],
		expectation: "the first card is the Agent call, approvable for a built-in type",
	},
};
