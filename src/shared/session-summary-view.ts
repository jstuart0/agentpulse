/**
 * AGEN-69: the wire contract between the summary routes (server, phases 5-6) and the
 * web (phase 7). The single place these shapes are defined: the server imports this
 * file instead of redefining it, and the web consumes it as-is.
 *
 * Plain TypeScript types and constants only: no zod, no import from `src/server`.
 * Comments name the plan section each field comes from (plan = the campaign plan
 * `2026-10-03-deliver-session-summary.md`).
 *
 * Conventions chosen where the plan was silent (phase 5 builds to these):
 * - Every instant in a view is an ISO 8601 UTC string with a `Z` (the server converts its
 *   `toDbTimestamp` columns on the way out). Durations are whole seconds, money is whole cents.
 * - A view never carries AI on/off/paused state (D-32); the web reads that from `/ai/status`.
 * - No owner id, key id, provider id, provider name or base URL appears anywhere (TC-5.10).
 */
import type { StoredSessionSummary } from "./session-summary.js";

/** Model contract, "Data" → "Error codes": why the last attempt did not finish. */
export const SUMMARY_ERROR_CODES = [
	"provider_auth",
	"provider_key_unreadable",
	"provider_rate_limit",
	"provider_timeout",
	"provider_error",
	"provider_refused",
	"parse_failed",
	"output_truncated",
	"spend_cap",
	"ai_inactive",
	"busy",
	"internal_error",
	"interrupted",
] as const;
export type SummaryErrorCode = (typeof SUMMARY_ERROR_CODES)[number];

/** Data → "Table": the `attempt_status` column. `generating` only while the lease holds. */
export const SUMMARY_ATTEMPT_STATUSES = ["idle", "generating", "failed"] as const;
export type SummaryAttemptStatus = (typeof SUMMARY_ATTEMPT_STATUSES)[number];

/**
 * Why a generation cannot start right now, for reasons the server can see
 * (authorization → "One order": steps 5, 6, 8, 10). They are the same strings as the
 * refusal codes of the matching `POST` refusal, so the web needs one table.
 */
export const SUMMARY_BLOCK_REASONS = [
	"too_little_activity",
	"no_provider",
	"summary_cooldown",
	"spend_cap_reached",
] as const;
export type SummaryBlockReason = (typeof SUMMARY_BLOCK_REASONS)[number];

/** D-21: stale is counted to this many material events; a count at the cap reads "100+". */
export const STALE_EVENT_COUNT_CAP = 100;

/**
 * `GET /api/v1/ai/sessions/:sessionId/summary` → `200` (authorization → "One order" last line).
 * Built without writing, decrypting or calling a model.
 */
export interface SessionSummaryView {
	/** The stored verified summary and its provenance (Model contract → "What is stored"); null when none exists. */
	stored: StoredSessionSummary | null;
	/** `generated_at` (Data, column 3); null with no stored summary. */
	generatedAt: string | null;
	/** Time of the newest event the summary covers (the event `through_event_id` names). Phase 5 keeps it in provenance at generation time. Null with no stored summary. UX → "Outcome row": "through 06:41". */
	throughAt: string | null;
	/** `through_event_id` (Data, column 5). */
	throughEventId: number | null;
	/** The attempt row (Data, columns 4, 6, 8). A lapsed lease is already reported here as `failed` / `interrupted` (TC-5.22). */
	attempt: {
		status: SummaryAttemptStatus;
		/** `attempt_started_at`; when the last attempt began (also the "Last attempt, 3 min ago" time). */
		startedAt: string | null;
		/** Non-null only with status `failed`. */
		errorCode: SummaryErrorCode | null;
	};
	/** D-21: material events (everything but `user_ack`) after `throughEventId`, counted up to STALE_EVENT_COUNT_CAP. 0 = current or nothing stored. */
	staleEvents: number;
	/** Data → "Lifecycle": the session's `min(id)` is above `provenance.firstEventId`, or it has no events left (D-N). */
	evidenceShrunk: boolean;
	/**
	 * First applicable reason a new generation would be refused, in the order
	 * too_little_activity, no_provider, summary_cooldown, spend_cap_reached (the POST's step order).
	 * Always null while `attempt.status` is `generating` (a joiner needs no budget, D-L).
	 */
	blocked: SummaryBlockReason | null;
	/** Whole seconds until the cooldown ends (at least 1); non-null exactly when `blocked` is `summary_cooldown`. */
	cooldownSeconds: number | null;
	/** Default provider kind and model only (D-13, TC-5.10); null exactly when there is no default provider. */
	provider: { kind: string; model: string } | null;
	/** UX → budget line (D-33). `maxCostCents` 0 means a free provider: "No cost is recorded for this provider" (D-27). */
	spend: {
		spentCents: number;
		capCents: number;
		/** Worst case for one call: `maxCostCents` in the spend API. */
		maxCostCents: number;
		/** Worst case when the repair call is needed too (two calls, D-26). */
		maxCostWithRetryCents: number;
		/** The next midnight of the server's local date, as an instant (TC-5.1); the web never computes its own. */
		resetsAt: string;
	};
	/** Present only when a summary exists and retention is on (D-14, Data → "Lifecycle"). */
	retentionDays?: number;
}

/** `POST` → `202` (started or joined; D-1). */
export interface SessionSummaryStartBody {
	attempt: {
		status: "generating";
		startedAt: string;
		/** True when a generation was already running and this request joined it. */
		joined: boolean;
	};
}

/**
 * The `error` string of every refusal body of the summary routes (authorization → "One order",
 * UX → "Click-time refusals"). `session_not_found` is the body code chosen for the unknown-session `404`.
 */
export const SUMMARY_REFUSAL_CODES = [
	"ai_disabled",
	"ai_paused",
	"session_summary_disabled",
	"summary_rate_limited",
	"shutting_down",
	"session_not_found",
	"too_little_activity",
	"busy",
	"no_provider",
	"provider_key_unreadable",
	"summary_cooldown",
	"caller_generation_running",
	"spend_cap_reached",
] as const;
export type SummaryRefusalCode = (typeof SUMMARY_REFUSAL_CODES)[number];

/**
 * Body of a refusal. `retryAfterSeconds` mirrors the `Retry-After` header where the
 * route sends one (summary_rate_limited, summary_cooldown, shutting_down, busy). The
 * `spend_cap_reached` body also carries the three numbers.
 */
export interface SessionSummaryRefusalBody {
	error: SummaryRefusalCode;
	retryAfterSeconds?: number;
	spentCents?: number;
	capCents?: number;
	maxCostCents?: number;
}
