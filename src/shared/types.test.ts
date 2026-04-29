import { describe, expect, test } from "bun:test";
import { AGENT_TYPES, SEMANTIC_STATUSES, SESSION_STATUSES } from "./constants.js";
import {
	ACTION_REQUEST_DECISIONS,
	APPROVAL_POLICIES,
	ASK_THREAD_ORIGINS,
	type ActionRequestDecision,
	type AgentType,
	type AlertRuleType,
	type ApprovalPolicy,
	type AskThreadOrigin,
	DECISION_KINDS,
	type DecisionKind,
	HITL_REPLY_KINDS,
	type HitlReplyKind,
	KNOWN_ALERT_RULE_TYPES,
	KNOWN_LABS_FLAGS,
	KNOWN_NOTIFICATION_CHANNEL_KINDS,
	KNOWN_PROVIDER_KINDS,
	type LabsFlag,
	MANAGED_STATES,
	type ManagedState,
	type NotificationChannelKind,
	type ProviderKind,
	SANDBOX_MODES,
	SESSION_MUTATION_KINDS,
	type SandboxMode,
	type SemanticStatus,
	type SessionMutationKind,
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

	test("MANAGED_STATES includes every ManagedState member and rejects impostors", () => {
		// Slice TYPE-2b. The audit identified 9 distinct managedState values
		// stamped across supervisor providers. Lock those down here so a
		// future PR that drops one will fail this assertion.
		const expected: readonly ManagedState[] = [
			"pending",
			"interactive_terminal",
			"headless",
			"managed",
			"linked",
			"degraded",
			"stopped",
			"completed",
			"failed",
		];
		for (const state of expected) {
			expect(MANAGED_STATES.includes(state)).toBe(true);
		}
		expect(MANAGED_STATES.length).toBe(9);
		expect(MANAGED_STATES.includes("running" as ManagedState)).toBe(false);
		expect(MANAGED_STATES.includes("bogus" as ManagedState)).toBe(false);
	});

	test("KNOWN_ALERT_RULE_TYPES includes every AlertRuleType member and rejects impostors", () => {
		// Slice TYPE-2c. Locks the four constrained alert-rule types.
		// Adding a kind here without an executor branch in
		// action-requests-service.ruleTypeLabel triggers the `never`
		// exhaustiveness check at compile time.
		const expected: readonly AlertRuleType[] = [
			"status_failed",
			"status_stuck",
			"status_completed",
			"no_activity_minutes",
		];
		for (const kind of expected) {
			expect(KNOWN_ALERT_RULE_TYPES.includes(kind)).toBe(true);
		}
		expect(KNOWN_ALERT_RULE_TYPES.length).toBe(4);
		expect(KNOWN_ALERT_RULE_TYPES.includes("freeform_match" as AlertRuleType)).toBe(false);
		expect(KNOWN_ALERT_RULE_TYPES.includes("bogus" as AlertRuleType)).toBe(false);
	});

	test("KNOWN_NOTIFICATION_CHANNEL_KINDS includes every NotificationChannelKind member", () => {
		// Slice TYPE-2c. Drives the inbox-service runtime allowlist and
		// the action-requests-service add_channel executor narrow. A new
		// channel transport must be added here AND wired into both
		// runtime gates — otherwise it would silently fall through to
		// the "telegram" default in the inbox composer.
		const expected: readonly NotificationChannelKind[] = ["telegram", "webhook", "email"];
		for (const kind of expected) {
			expect(KNOWN_NOTIFICATION_CHANNEL_KINDS.includes(kind)).toBe(true);
		}
		expect(KNOWN_NOTIFICATION_CHANNEL_KINDS.length).toBe(3);
		expect(KNOWN_NOTIFICATION_CHANNEL_KINDS.includes("slack" as NotificationChannelKind)).toBe(
			false,
		);
		expect(KNOWN_NOTIFICATION_CHANNEL_KINDS.includes("bogus" as NotificationChannelKind)).toBe(
			false,
		);
	});

	test("ASK_THREAD_ORIGINS includes every AskThreadOrigin member", () => {
		// Slice TYPE-2d. Replaces 40+ inline `"web" | "telegram"` literals
		// across handlers, services, and InboxWorkItem arms. Adding a third
		// origin here forces every consumer to handle it.
		const expected: readonly AskThreadOrigin[] = ["web", "telegram"];
		for (const origin of expected) {
			expect(ASK_THREAD_ORIGINS.includes(origin)).toBe(true);
		}
		expect(ASK_THREAD_ORIGINS.length).toBe(2);
		expect(ASK_THREAD_ORIGINS.includes("slack" as AskThreadOrigin)).toBe(false);
	});

	test("ACTION_REQUEST_DECISIONS covers operator-facing decisions only", () => {
		// Slice TYPE-2d. The wider ActionRequestStatus union (awaiting_reply
		// | applying | applied | failed | declined | expired | superseded)
		// lives in action-requests-service.ts; the operator-facing decision
		// from inbox cards is the strict applied/declined pair.
		const expected: readonly ActionRequestDecision[] = ["applied", "declined"];
		for (const d of expected) {
			expect(ACTION_REQUEST_DECISIONS.includes(d)).toBe(true);
		}
		expect(ACTION_REQUEST_DECISIONS.length).toBe(2);
		expect(ACTION_REQUEST_DECISIONS.includes("awaiting_reply" as ActionRequestDecision)).toBe(
			false,
		);
		expect(ACTION_REQUEST_DECISIONS.includes("expired" as ActionRequestDecision)).toBe(false);
	});

	test("KNOWN_LABS_FLAGS includes every LabsFlag member", () => {
		// Slice TYPE-2d. The web client (`web/lib/api.ts`) and the server
		// (`labs-service.ts`) used to maintain parallel hand-rolled unions.
		// Both now derive LabsFlag from this canonical const tuple, and
		// the LABS_REGISTRY in labs-service.ts has a compile-time
		// assertion that it covers every flag.
		const expected: readonly LabsFlag[] = [
			"inbox",
			"digest",
			"aiSessionTab",
			"intelligenceBadges",
			"aiSettingsPanel",
			"templateDistillation",
			"launchRecommendation",
			"riskClasses",
			"telegramChannel",
			"askAssistant",
		];
		for (const flag of expected) {
			expect(KNOWN_LABS_FLAGS.includes(flag)).toBe(true);
		}
		expect(KNOWN_LABS_FLAGS.length).toBe(10);
		expect(KNOWN_LABS_FLAGS.includes("bogusFlag" as LabsFlag)).toBe(false);
	});

	test("SESSION_MUTATION_KINDS includes every SessionMutationKind member", () => {
		// Slice TYPE-2c. The bare-form trio drives BulkActionIntent and
		// the bulk_session_action inbox card. Distinct from the COMPOUND
		// action-request kinds (`session_stop` etc.) — those follow
		// ActionRequestKind.
		const expected: readonly SessionMutationKind[] = ["stop", "archive", "delete"];
		for (const kind of expected) {
			expect(SESSION_MUTATION_KINDS.includes(kind)).toBe(true);
		}
		expect(SESSION_MUTATION_KINDS.length).toBe(3);
		expect(SESSION_MUTATION_KINDS.includes("session_stop" as SessionMutationKind)).toBe(false);
		expect(SESSION_MUTATION_KINDS.includes("bogus" as SessionMutationKind)).toBe(false);
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
