/**
 * Hand-built inputs for the phase 4 tests. Everything here is structural: the
 * tests do not depend on the ledger's exact types (see the adapter conformance
 * test, TC-4.9c, for the one place that does).
 */
import type {
	EvidenceFactKind,
	EvidenceFactResult,
	SessionSummary,
	SummaryDraft,
} from "../../../../../shared/session-summary.js";
import type {
	LedgerFactForVerify,
	LedgerForVerify,
	SessionStateForVerify,
	VerifyInput,
} from "../verify.js";

export const NONCE = "5f0c1d7e-3a4b-4c8d-9e1f-0a2b3c4d5e6f";

export function fact(
	kind: EvidenceFactKind,
	observed: boolean,
	result?: EvidenceFactResult,
	extra: Partial<LedgerFactForVerify> = {},
): LedgerFactForVerify {
	// A command or validation fact is `shown` unless a test says otherwise: the ledger
	// marks the ones whose text it printed, and only those can back a claim.
	const shown = observed && (kind === "command" || kind === "validation") ? { shown: true } : {};
	return {
		kind,
		at: "2026-10-03T10:00:00.000Z",
		observed,
		...(result ? { result } : {}),
		...shown,
		...extra,
	};
}

/** The standard ledger the verify tests cite from. */
export const IDS: Record<string, LedgerFactForVerify> = {
	E1: fact("prompt", false),
	E2: fact("agent_message", false),
	E3: fact("edit", true),
	E4: fact("command", true, "ok"),
	E5: fact("validation", true, "ok"),
	E6: fact("validation", true, "failed"),
	E7: fact("validation", true, "unknown"),
	E8: fact("validation", true, "completed"),
	E9: fact("command", true, "ok"),
	E10: fact("tool", true, "ok"),
	E11: fact("event", false),
	// The population the real ledger produces beyond the basics (see adapter-conformance.test.ts):
	E12: fact("event", true), // OBSERVED permission / ai_hitl_response: an event the system saw, not a result
	E13: fact("edit", false), // hand-built: an edit flagged CLAIMED (the real ledger never produces one)
	E14: fact("command", true, "completed"),
	E15: fact("command", true, "unknown"),
	E16: fact("edit", true, "failed"),
	E17: fact("command", true, "failed"),
	E18: fact("validation", false, "ok"), // hand-built: a validation flagged CLAIMED
	E19: fact("validation", true, "completed"), // hand-built: the real ledger never gives a validation `completed`
	E20: fact("validation", true, "ok", { count: 3 }),
	E21: fact("validation", true, "ok", { count: 3 }),
	E22: fact("validation", true, "ok", { count: 3 }),
};

export function ledgerOf(
	ids: Record<string, LedgerFactForVerify> = IDS,
	recorded: LedgerForVerify["recorded"] = { paths: [], commands: [] },
): LedgerForVerify {
	return { ids: new Map(Object.entries(ids)), recorded };
}

export const IDLE: SessionStateForVerify = {
	operational: "idle",
	permissionWaitOutstanding: false,
	lifecycleStatus: "active",
};

export function draftOf(over: Partial<SummaryDraft> = {}): SummaryDraft {
	return {
		overview: "Added retry to the uploader.",
		outcome: { status: "unclear", explanation: "Not enough evidence." },
		accomplishments: [],
		changes: [],
		decisions: [],
		validation: [],
		problems: [],
		unfinished: [],
		nextActions: [],
		handoff: "Retry lives in src/retry.ts.",
		...over,
	};
}

export function verifyInput(over: Partial<VerifyInput> = {}): VerifyInput {
	return {
		draft: draftOf(),
		ledger: ledgerOf(),
		session: IDLE,
		userPromptUrls: new Set(),
		nonce: NONCE,
		...over,
	};
}

/** A verified-summary-shaped value for tripwire tests, with every string field settable. */
export function summaryOf(over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		overview: "Added retry to the uploader.",
		outcome: { status: "completed", explanation: "Done." },
		accomplishments: [],
		changes: [],
		decisions: [],
		validation: [],
		problems: [],
		unfinished: [],
		nextActions: [],
		handoff: "Retry lives in src/retry.ts.",
		...over,
	};
}

/** Secrets are assembled at runtime so no scanner-shaped literal sits in the repo. */
export const SECRETS = {
	anthropic: () => `sk-ant-${"Ab3dE6gH9jK2mN5pQ8sT1vX4"}`,
	github: () => `ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`,
	aws: () => `AKIA${"IOSFODNN7EXAMPLE"}`,
	jwt: () =>
		["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkw", "abcdefghijklmnop12345"].join(
			".",
		),
	envAssign: () => `DB_PASSWORD=${"hunter2hunter2"}`,
	urlUserinfo: () => `postgres://svc:${"pa55w0rdXyz"}@db.internal/app`,
	pem: () =>
		[
			`-----BEGIN ${"PRIVATE KEY"}-----`,
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
			`-----END ${"PRIVATE KEY"}-----`,
		].join("\n"),
} as const;

export function apiKeyFragment(text: string): boolean {
	return /sk-ant-[A-Za-z0-9_-]{8,}/.test(text);
}
