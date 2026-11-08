/**
 * The mutations of the T119 (Stop turn) scenarios. A leaf module (types only), so the runner can import it
 * without a cycle through the helpers. Each breaks one named thing; the scenario's one named expectation must
 * then fail while every precondition holds.
 */
import type { Mutation } from "../claude-canary-runner.js";

export const T119_MUTATIONS: Record<string, Mutation> = {
	"interrupt-as-stop": {
		scenario: "stop-turn",
		layers: [
			"interrupt-as-stop: the runtime's interruptTurn runs the End session ladder instead (the process is stopped and gone)",
		],
		expectation: "the fork's process is the same one and still alive",
	},
	"no-turn-fence": {
		scenario: "stop-turn-pending",
		layers: [
			"no-turn-fence: the interrupt is inserted straight into control_actions (no enqueue, so no fence closes the turn's cards)",
			"no-turn-fence: it names no target prompt, so the issue and answer predicates cannot find it either (and the host never fences or interrupts)",
		],
		expectation: "the accept after the interrupt is refused turn_interrupted",
	},
	"flag-decides": {
		scenario: "stop-turn-race",
		layers: [
			"flag-decides: the runtime lets the interrupt flag alone decide (the result it judges is always shown as an abort)",
			"flag-decides: the result it was really given is recorded as a natural one (a live Claude aborts when interrupted, so the natural-race case is manufactured)",
		],
		expectation: "a result that was not an abort is never reported as a stop",
	},
	"no-before-send-check": {
		scenario: "stop-turn-before-send",
		layers: [
			"no-before-send-check: the pre-send cancel never sets the flag sendPrompt checks, though the interrupt still reports it cancelled",
		],
		expectation: "nothing reached Claude for the cancelled prompt",
	},
};
