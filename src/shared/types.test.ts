import { describe, expect, test } from "bun:test";
import { AGENT_TYPES, SEMANTIC_STATUSES, SESSION_STATUSES } from "./constants.js";
import {
	APPROVAL_POLICIES,
	type AgentType,
	type ApprovalPolicy,
	DECISION_KINDS,
	type DecisionKind,
	HITL_REPLY_KINDS,
	type HitlReplyKind,
	KNOWN_PROVIDER_KINDS,
	type ProviderKind,
	SANDBOX_MODES,
	type SandboxMode,
	type SemanticStatus,
	type SessionStatus,
	WATCHER_POLICIES,
	type WatcherPolicy,
} from "./types.js";

// Slice TYPE-2a: every kind/union shipped from `shared/types.ts` has a
// canonical `as const` tuple that drives runtime allowlists. These tests
// confirm the allowlists accept every member of the typed union and
// reject impostor strings — the parallel-source-of-truth bug that
// triggered this slice.
describe("shared kind allowlists", () => {
	test("KNOWN_PROVIDER_KINDS includes every ProviderKind member", () => {
		const cast: ProviderKind[] = [...KNOWN_PROVIDER_KINDS];
		for (const kind of cast) {
			expect(KNOWN_PROVIDER_KINDS.includes(kind)).toBe(true);
		}
		expect(KNOWN_PROVIDER_KINDS.includes("bogus" as ProviderKind)).toBe(false);
	});

	test("WATCHER_POLICIES includes every WatcherPolicy member", () => {
		const cast: WatcherPolicy[] = [...WATCHER_POLICIES];
		for (const policy of cast) {
			expect(WATCHER_POLICIES.includes(policy)).toBe(true);
		}
		expect(WATCHER_POLICIES.includes("bogus" as WatcherPolicy)).toBe(false);
	});

	test("DECISION_KINDS includes every DecisionKind member", () => {
		const cast: DecisionKind[] = [...DECISION_KINDS];
		for (const kind of cast) {
			expect(DECISION_KINDS.includes(kind)).toBe(true);
		}
		expect(DECISION_KINDS.includes("bogus" as DecisionKind)).toBe(false);
	});

	test("HITL_REPLY_KINDS includes every HitlReplyKind member", () => {
		const cast: HitlReplyKind[] = [...HITL_REPLY_KINDS];
		for (const kind of cast) {
			expect(HITL_REPLY_KINDS.includes(kind)).toBe(true);
		}
		expect(HITL_REPLY_KINDS.includes("bogus" as HitlReplyKind)).toBe(false);
	});

	test("APPROVAL_POLICIES includes every ApprovalPolicy member", () => {
		const cast: ApprovalPolicy[] = [...APPROVAL_POLICIES];
		for (const policy of cast) {
			expect(APPROVAL_POLICIES.includes(policy)).toBe(true);
		}
		expect(APPROVAL_POLICIES.includes("bogus" as ApprovalPolicy)).toBe(false);
	});

	test("SANDBOX_MODES includes every SandboxMode member", () => {
		const cast: SandboxMode[] = [...SANDBOX_MODES];
		for (const mode of cast) {
			expect(SANDBOX_MODES.includes(mode)).toBe(true);
		}
		expect(SANDBOX_MODES.includes("bogus" as SandboxMode)).toBe(false);
	});

	test("AGENT_TYPES, SESSION_STATUSES, SEMANTIC_STATUSES round-trip via type", () => {
		// These three already lived in shared/constants. The slice
		// retypes their parallel Record<…, V> maps to fail at compile
		// time on missing keys; runtime behavior is unchanged.
		const agents: AgentType[] = [...AGENT_TYPES];
		const statuses: SessionStatus[] = [...SESSION_STATUSES];
		const semantic: SemanticStatus[] = [...SEMANTIC_STATUSES];
		expect(agents.length).toBeGreaterThan(0);
		expect(statuses.length).toBeGreaterThan(0);
		expect(semantic.length).toBeGreaterThan(0);
		expect(AGENT_TYPES.includes("bogus" as AgentType)).toBe(false);
		expect(SESSION_STATUSES.includes("bogus" as SessionStatus)).toBe(false);
		expect(SEMANTIC_STATUSES.includes("bogus" as SemanticStatus)).toBe(false);
	});
});
