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
import type { Session } from "../../../shared/types.js";
import { resolveObserveOnlyHint, selectStatusHint } from "./StatusHints.js";

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

/**
 * F239 (tessa, Phase 7 panel): the full agentType x managed/unmanaged
 * matrix (3 agents x 2 = 6 cells). Each cell asserts a distinct `component`
 * discriminant, so a mutant that hardcodes selectStatusHint's agentType
 * check (e.g. always taking the codex_cli branch, or always falling
 * through to AgentObserveOnlyHint) fails at least one cell — verified by
 * hand: temporarily hardcoding `session.agentType === "codex_cli"` to
 * `true` fails the claude_code-managed and claude_code-unmanaged cells
 * (they'd wrongly select ManagedCodexStatus/CodexStatusHint); hardcoding it
 * to `false` fails both codex_cli cells.
 */
describe("selectStatusHint (F239)", () => {
	const managedSession = {
		managedState: "headless",
		hostName: "dev-host",
	} as unknown as NonNullable<Session["managedSession"]>;

	test("codex_cli + managed -> ManagedCodexStatus", () => {
		const sel = selectStatusHint({ agentType: "codex_cli", managedSession }, "bold-falcon");
		expect(sel).toEqual({ component: "ManagedCodexStatus", managedSession });
	});

	test("codex_cli + unmanaged -> CodexStatusHint", () => {
		const sel = selectStatusHint({ agentType: "codex_cli", managedSession: null }, "bold-falcon");
		expect(sel).toEqual({ component: "CodexStatusHint", displayName: "bold-falcon" });
	});

	test("claude_code + managed -> ManagedClaudeStatus", () => {
		const sel = selectStatusHint({ agentType: "claude_code", managedSession }, "zen-owl");
		expect(sel).toEqual({ component: "ManagedClaudeStatus", managedSession });
	});

	test("claude_code + unmanaged -> AgentObserveOnlyHint (renders null downstream)", () => {
		const sel = selectStatusHint({ agentType: "claude_code", managedSession: null }, "zen-owl");
		expect(sel).toEqual({ component: "AgentObserveOnlyHint", agentType: "claude_code" });
	});

	test("copilot_cli + managed -> AgentObserveOnlyHint (copilot is never launchable, but the selector doesn't special-case a managedSession that shouldn't exist)", () => {
		const sel = selectStatusHint({ agentType: "copilot_cli", managedSession }, "quiet-otter");
		expect(sel).toEqual({ component: "AgentObserveOnlyHint", agentType: "copilot_cli" });
	});

	test("copilot_cli + unmanaged -> AgentObserveOnlyHint", () => {
		const sel = selectStatusHint({ agentType: "copilot_cli", managedSession: null }, "quiet-otter");
		expect(sel).toEqual({ component: "AgentObserveOnlyHint", agentType: "copilot_cli" });
	});
});
