/**
 * AGEN-69: example `GET /ai/sessions/:id/summary` bodies, one per state, typed against the
 * wire contract. Phase 7's web test runs every one through `deriveSummaryView`; phase 6's
 * server test asserts the routes produce these same shapes (volatile fields normalised,
 * compared with `shapeOf`). `load_failed` and `loading` are web-only states and have no body.
 */
import type {
	SessionSummaryRefusalBody,
	SessionSummaryView,
	SummaryErrorCode,
	SummaryRefusalCode,
} from "../../session-summary-view.js";
import { SUMMARY_ERROR_CODES } from "../../session-summary-view.js";
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
	throughAt: "2026-10-04T06:41:00.000Z",
	adjustments: [],
	suspectReasons: [],
	suspect: false,
	evidence: EVIDENCE,
};

export const STORED: StoredSessionSummary = { summary: SUMMARY, provenance: PROVENANCE };

const storedWith = (provenance: Partial<SummaryProvenance>): StoredSessionSummary => ({
	summary: SUMMARY,
	provenance: { ...PROVENANCE, ...provenance },
});

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
	throughEventId: 140,
};

/**
 * A view whose last attempt failed with `code`; with `base` READY it also carries the older stored
 * summary. It is a view the server can really produce at `FIXTURE_NOW`: a run that failed 20 seconds
 * ago is inside the 30-second cooldown (`blocked: "summary_cooldown"`, the seconds left), except
 * `interrupted` (a lapsed lease starts no cooldown, and its start is older) and
 * `provider_key_unreadable` (written after the claim with the start cleared, so no cooldown and no
 * start time).
 */
export function failedWith(
	code: SummaryErrorCode,
	base: SessionSummaryView = EMPTY,
): SessionSummaryView {
	if (code === "provider_key_unreadable") {
		return {
			...base,
			attempt: { status: "failed", startedAt: null, errorCode: code },
		};
	}
	if (code === "interrupted") {
		return {
			...base,
			attempt: { status: "failed", startedAt: "2026-10-04T11:50:00.000Z", errorCode: code },
		};
	}
	return {
		...base,
		attempt: { status: "failed", startedAt: "2026-10-04T11:59:40.000Z", errorCode: code },
		blocked: "summary_cooldown",
		cooldownSeconds: 10,
	};
}

/** One failed-attempt view per error code, so no code is covered by luck. */
export const FAILED_VIEW_FIXTURES = Object.fromEntries(
	SUMMARY_ERROR_CODES.map((code) => [code, failedWith(code)]),
) as Record<SummaryErrorCode, SessionSummaryView>;

export const SUMMARY_VIEW_FIXTURES = {
	empty: EMPTY,
	generating: {
		...EMPTY,
		attempt: { status: "generating", startedAt: "2026-10-04T11:58:00.000Z", errorCode: null },
	},
	ready: READY,
	stale: { ...READY, staleEvents: 12 },
	stale_one: { ...READY, staleEvents: 1 },
	stale_capped: { ...READY, staleEvents: 100 },
	failed: FAILED_VIEW_FIXTURES.parse_failed,
	failed_ai_inactive: failedWith("ai_inactive", READY),
	interrupted: FAILED_VIEW_FIXTURES.interrupted,
	// With no default provider `spend.maxCostCents` is 0 and means nothing.
	no_provider: {
		...EMPTY,
		provider: null,
		spend: { ...SPEND, maxCostCents: 0, maxCostWithRetryCents: 0 },
		blocked: "no_provider",
	},
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
	// A cooldown view always has the attempt's start: 13 s before FIXTURE_NOW leaves 17 s of 30.
	cooldown: {
		...READY,
		attempt: { status: "idle", startedAt: "2026-10-04T11:59:47.000Z", errorCode: null },
		blocked: "summary_cooldown",
		cooldownSeconds: 17,
	},
	evidence_shrunk: { ...READY, evidenceShrunk: true },
	suspect: {
		...READY,
		stored: storedWith({ suspect: true, suspectReasons: ["role_marker"] }),
	},
	suspect_warning: {
		...READY,
		stored: storedWith({
			suspect: true,
			suspectReasons: ["role_marker", "pipe_to_shell", "unexpected_url"],
		}),
	},
	// `risky_command` is a warning-tier code the server adds in a parallel pass; until it joins
	// `SUMMARY_SUSPECT_REASONS` it is typed in through `unknown`. Drop the cast once merged.
	suspect_risky: {
		...READY,
		stored: storedWith({
			suspect: true,
			suspectReasons: ["risky_command"] as unknown as SummaryProvenance["suspectReasons"],
		}),
	},
	suspect_note: {
		...READY,
		stored: storedWith({
			suspect: true,
			suspectReasons: ["unexpected_url", "unrecorded_command"],
		}),
	},
	partial: {
		...READY,
		stored: storedWith({
			eventsRepresented: 80,
			coverage: {
				status: "partial",
				droppedByCap: 12,
				droppedByBudget: 3,
				cutoffAt: "2026-10-03T22:10:00.000Z",
				overBudget: false,
			},
		}),
	},
	adjusted: {
		...READY,
		stored: {
			summary: {
				...SUMMARY,
				outcome: { status: "in_progress", explanation: "The session is still running." },
			},
			provenance: {
				...PROVENANCE,
				adjustments: [
					{ code: "outcome_clamped", from: "completed", to: "in_progress", reason: "working" },
					{
						code: "validation_adjusted",
						index: 1,
						from: "passed",
						reason: "edited_after_validation",
					},
					{ code: "note_completed_with_failed_validation" },
				],
			},
		},
	},
	free_cost: {
		...READY,
		spend: { ...SPEND, maxCostCents: 0, maxCostWithRetryCents: 0 },
		stored: storedWith({ costCents: 0 }),
	},
	retention: { ...READY, retentionDays: 30 },
} satisfies Record<string, SessionSummaryView>;

export type SummaryViewFixtureName = keyof typeof SUMMARY_VIEW_FIXTURES;

/**
 * A refused `POST` as the route answers it: the HTTP status and the JSON body. Every code of the
 * contract has one. `ai_disabled` is also answered `404` when AI is not built in; the body is the same.
 */
export const REFUSAL_BODY_FIXTURES: Record<
	SummaryRefusalCode,
	{ status: number; body: SessionSummaryRefusalBody }
> = {
	ai_disabled: { status: 409, body: { error: "ai_disabled" } },
	ai_paused: { status: 409, body: { error: "ai_paused" } },
	session_summary_disabled: { status: 409, body: { error: "session_summary_disabled" } },
	summary_rate_limited: {
		status: 429,
		body: { error: "summary_rate_limited", retryAfterSeconds: 12 },
	},
	shutting_down: { status: 503, body: { error: "shutting_down", retryAfterSeconds: 5 } },
	session_not_found: { status: 404, body: { error: "session_not_found" } },
	too_little_activity: { status: 409, body: { error: "too_little_activity" } },
	busy: { status: 503, body: { error: "busy", retryAfterSeconds: 5 } },
	no_provider: { status: 409, body: { error: "no_provider" } },
	provider_key_unreadable: { status: 409, body: { error: "provider_key_unreadable" } },
	summary_cooldown: { status: 429, body: { error: "summary_cooldown", retryAfterSeconds: 9 } },
	caller_generation_running: { status: 409, body: { error: "caller_generation_running" } },
	spend_cap_reached: {
		status: 409,
		body: { error: "spend_cap_reached", spentCents: 420, capCents: 500, maxCostCents: 45 },
	},
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type Shape = "null" | "int" | "number" | "iso" | "string" | "bool" | Shape[] | ShapeMap;
export interface ShapeMap {
	[key: string]: Shape;
}

/**
 * A value reduced to its shape: each leaf becomes a tag (`null`, `int`, `number`, `iso` for an
 * ISO instant, `string`, `bool`), arrays keep their element shapes in order, and object keys are
 * sorted. A key holding `undefined` is absent, as it is after a JSON round trip. The route test
 * asserts `shapeOf(routeBody)` equals `shapeOf(fixture)` per scenario: that catches `null` where
 * a key should be absent (and the reverse) and any extra key (an owner id, say), which a plain
 * `toEqual` against normalised values would only catch if the values happened to differ.
 */
export function shapeOf(value: unknown): Shape {
	if (value === null) return "null";
	if (Array.isArray(value)) return value.map(shapeOf);
	switch (typeof value) {
		case "boolean":
			return "bool";
		case "number":
			return Number.isInteger(value) ? "int" : "number";
		case "string":
			return ISO_INSTANT.test(value) ? "iso" : "string";
		case "object": {
			const out: ShapeMap = {};
			for (const key of Object.keys(value as object).sort()) {
				const inner = (value as Record<string, unknown>)[key];
				if (inner !== undefined) out[key] = shapeOf(inner);
			}
			return out;
		}
		default:
			throw new Error(`shapeOf: a ${typeof value} is not JSON`);
	}
}
