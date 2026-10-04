import type { SessionSummaryView } from "../../session-summary-view.js";
/**
 * AGEN-69: example `GET /ai/sessions/:id/summary` bodies, one per state, typed against the
 * wire contract. Phase 7's web test runs every one through `deriveSummaryView`; phase 6's
 * server test asserts the routes produce these same shapes (volatile fields normalised).
 * `load_failed` and `loading` are web-only states and have no body.
 */
import type {
	SessionSummary,
	StoredEvidenceFact,
	StoredSessionSummary,
	SummaryProvenance,
} from "../../session-summary.js";

export const FIXTURE_NOW = "2026-10-04T12:00:00.000Z";

const SUMMARY: SessionSummary = {
	overview: "Added the summary tab and fixed the flaky poll test.",
	outcome: { status: "mostly_completed", explanation: "Everything but the docs landed." },
	accomplishments: [
		{ text: "Built the summary tab", evidence: ["E12", "E13"], unverified: false },
		{ text: "Fixed the poll test", evidence: [], unverified: true },
	],
	changes: [
		{
			kind: "created",
			text: "src/web/lib/session-summary-view.ts",
			evidence: ["E12"],
			unverified: false,
		},
		{ kind: "modified", text: "src/web/lib/api.ts", evidence: [], unverified: true },
	],
	decisions: [{ text: "Poll every 2s", why: "Cheap and responsive", evidence: [] }],
	validation: [
		{ what: "bun test", result: "passed", detail: "212 pass", evidence: ["E14"], adjusted: false },
		{ what: "typecheck", result: "unknown", detail: "", evidence: [], adjusted: true },
	],
	problems: [{ text: "The docs are not written", evidence: [] }],
	unfinished: [{ text: "Write the docs", evidence: [] }],
	nextActions: [
		{ text: "Write the docs", evidence: [] },
		{ text: "Run the live check", evidence: [] },
	],
	handoff: "The tab is built and tested. Docs remain.",
};

const EVIDENCE: Record<string, StoredEvidenceFact> = {
	E12: { kind: "edit", at: "2026-10-04T10:04:00.000Z", count: 3 },
	E13: { kind: "prompt", at: "2026-10-04T10:02:00.000Z" },
	E14: { kind: "command", at: "2026-10-04T10:07:00.000Z", result: "ok" },
};

const PROVENANCE: SummaryProvenance = {
	schemaVersion: 1,
	promptVersion: "1",
	provider: { kind: "anthropic", model: "claude-sonnet-4-6" },
	inputTokens: 9000,
	outputTokens: 900,
	usageEstimated: false,
	costCents: 3,
	calls: 1,
	redactionHits: 0,
	eventsTotal: 140,
	eventsRead: 140,
	eventsRepresented: 120,
	coverage: {
		status: "full",
		droppedByCap: 0,
		droppedByBudget: 0,
		cutoffAt: null,
		overBudget: false,
	},
	firstEventId: 1,
	adjustments: [],
	throughAt: "2026-10-04T10:07:00.000Z",
	suspectReasons: [],
	suspect: false,
	evidence: EVIDENCE,
};

export const STORED: StoredSessionSummary = { summary: SUMMARY, provenance: PROVENANCE };

const SPEND: SessionSummaryView["spend"] = {
	spentCents: 120,
	capCents: 500,
	maxCostCents: 4,
	maxCostWithRetryCents: 8,
	resetsAt: "2026-10-05T00:00:00.000Z",
};

const EMPTY: SessionSummaryView = {
	stored: null,
	generatedAt: null,
	throughAt: null,
	throughEventId: null,
	attempt: { status: "idle", startedAt: null, errorCode: null },
	staleEvents: 0,
	evidenceShrunk: false,
	blocked: null,
	cooldownSeconds: null,
	provider: { kind: "anthropic", model: "claude-sonnet-4-6" },
	spend: SPEND,
};

const READY: SessionSummaryView = {
	...EMPTY,
	stored: STORED,
	generatedAt: "2026-10-04T09:00:00.000Z",
	throughAt: "2026-10-04T06:41:00.000Z",
	throughEventId: 140,
};

export const SUMMARY_VIEW_FIXTURES = {
	empty: EMPTY,
	generating: {
		...EMPTY,
		attempt: { status: "generating", startedAt: "2026-10-04T11:58:00.000Z", errorCode: null },
	},
	ready: READY,
	stale: { ...READY, staleEvents: 12 },
	stale_capped: { ...READY, staleEvents: 100 },
	failed: {
		...EMPTY,
		attempt: { status: "failed", startedAt: "2026-10-04T11:57:00.000Z", errorCode: "parse_failed" },
	},
	failed_ai_inactive: {
		...READY,
		attempt: { status: "failed", startedAt: "2026-10-04T11:57:00.000Z", errorCode: "ai_inactive" },
	},
	interrupted: {
		...EMPTY,
		attempt: { status: "failed", startedAt: "2026-10-04T11:55:00.000Z", errorCode: "interrupted" },
	},
	no_provider: { ...EMPTY, provider: null, blocked: "no_provider" },
	spend_cap: {
		...EMPTY,
		spend: {
			...SPEND,
			spentCents: 420,
			capCents: 500,
			maxCostCents: 45,
			maxCostWithRetryCents: 90,
		},
		blocked: "spend_cap_reached",
	},
	too_little_activity: { ...EMPTY, blocked: "too_little_activity" },
	cooldown: { ...READY, blocked: "summary_cooldown", cooldownSeconds: 17 },
	evidence_shrunk: { ...READY, evidenceShrunk: true },
	suspect: {
		...READY,
		stored: { summary: SUMMARY, provenance: { ...PROVENANCE, suspect: true } },
	},
	retention: { ...READY, retentionDays: 30 },
} satisfies Record<string, SessionSummaryView>;

export type SummaryViewFixtureName = keyof typeof SUMMARY_VIEW_FIXTURES;
