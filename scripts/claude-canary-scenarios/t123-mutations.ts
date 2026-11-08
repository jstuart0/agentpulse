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
			"detail-in-row: the host reports one extra ManagedWarning event whose content is the file's contents (the Read's output). Retargeted after AGEN-122's server rebuilds a fork's call and turn rows from fixed words (a leak in those rows' content or rawPayload would survive by design, held by the unit tests); a ManagedWarning keeps the sender's content, so only the leak scan stands in the way",
		],
		expectation: "the file's contents are in no stored row",
	},
};
