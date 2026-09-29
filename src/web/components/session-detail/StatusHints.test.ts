/**
 * D35 (F24, Phase 7 window start): AgentObserveOnlyHint renders
 * AGENT_METADATA[agentType].observeOnlyHint when non-null (Copilot's
 * "can't launch or steer" caveat). No DOM-testing infra exists in this
 * codebase (no .test.tsx file, no @testing-library dependency anywhere) —
 * per the plan's own established pattern for this exact tension (round 4's
 * SetupPage-checkbox disposition: "a component/DOM-level ... or, if
 * factored into a pure helper, a pure-function test"), the decision logic
 * is extracted into resolveObserveOnlyHint() so it's directly testable;
 * the JSX wrapper around it stays a thin, untested pass-through.
 *
 * RED until resolveObserveOnlyHint is exported from StatusHints.tsx.
 */
import { describe, expect, test } from "bun:test";
import { resolveObserveOnlyHint } from "./StatusHints.js";

describe("resolveObserveOnlyHint (D35/F24)", () => {
	test("copilot_cli returns its observe-only caveat text", () => {
		const hint = resolveObserveOnlyHint("copilot_cli");
		expect(hint).not.toBeNull();
		expect(hint).toMatch(/observed only/i);
		expect(hint).toMatch(/can't launch or steer/i);
	});

	test("claude_code and codex_cli return null (nothing to show)", () => {
		expect(resolveObserveOnlyHint("claude_code")).toBeNull();
		expect(resolveObserveOnlyHint("codex_cli")).toBeNull();
	});
});
