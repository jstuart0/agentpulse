/**
 * The mutations of the T121 scenarios. A leaf module (types only), so the runner can import it without
 * a cycle through the helpers. Each breaks one thing and must fail the one named expectation of `mcp-approve`
 * with every precondition holding; the implementations are in `t121.ts` (`mcpMutatedArgs`, the wire patches).
 */
import type { Mutation } from "../claude-canary-runner.js";

export const T121_MUTATIONS: Record<string, Mutation> = {
	"mcp-allow-rule": {
		scenario: "mcp-approve",
		layers: [
			"mcp-allow-rule: the host adds an allow rule for the tool to the fork's inline settings, so Claude runs the call with no card",
		],
		expectation: "a card appeared for the MCP call",
	},
	"mcp-rewrite-input": {
		scenario: "mcp-approve",
		layers: [
			"mcp-rewrite-input: the wire wrapper changes the text in the allow answer's updatedInput, so the server receives something other than the card showed",
		],
		expectation: "the server's log holds exactly the shown input",
	},
	"mcp-no-strict": {
		scenario: "mcp-approve",
		layers: [
			"mcp-no-strict: the host drops --strict-mcp-config from the argv while a user-scope server sits in the throwaway .claude.json",
			"mcp-no-strict: the first-init set-equality check is removed too, so the extra server loads instead of killing the fork",
		],
		expectation: "the init names exactly the applied server",
		login: "helper",
	},
};
