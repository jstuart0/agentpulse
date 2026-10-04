/**
 * AGEN-69: what the server checks before it stores a summary (plan "What the
 * server verifies"). Pure. The model's answer is a draft; this turns it into
 * what is stored and shown: citations that exist, "Agent's claim only" where
 * nothing observed backs a claim, validation results computed from the cited
 * command lines, the outcome clamp, scrubbed text, the instruction tripwire,
 * and evidence facts for the cited ids (no text).
 *
 * It depends on the ledger only through `LedgerForVerify`: the id map and, for
 * each id, its kind, time, result, count and whether it was OBSERVED.
 */
import type { OperationalStatus } from "../../../../shared/session-state.js";
import type {
	DraftItem,
	SessionSummary,
	StoredEvidenceFact,
	StoredSessionSummary,
	SummaryAdjustment,
	SummaryClaimItem,
	SummaryDraft,
	SummaryOutcomeStatus,
	SummarySuspectReason,
	SummaryValidation,
	ValidationAdjustReason,
} from "../../../../shared/session-summary.js";
import { type RedactionRule, redact } from "../redactor.js";
import { stripInvisibleKeepNewlines } from "../untrusted-text.js";
import { removeNonce } from "./output-schema.js";
import { runTripwire } from "./tripwire.js";

export interface LedgerFactForVerify {
	kind: string;
	at: string | null;
	result?: string;
	count?: number;
	/**
	 * OBSERVED (the system recorded it) vs CLAIMED. Optional only until the
	 * ledger carries it on every fact; absent, it is derived from `kind`.
	 */
	observed?: boolean;
}

export interface LedgerForVerify {
	ids: ReadonlyMap<string, LedgerFactForVerify>;
}

export interface SessionStateForVerify {
	/** `getOperationalStatus` of the session row. */
	operational: OperationalStatus;
	/** `hasOutstandingPermissionWait` of the session row. */
	permissionWaitOutstanding: boolean;
	/** The lifecycle `status` column. */
	lifecycleStatus: string;
}

export interface VerifyInput {
	draft: SummaryDraft;
	ledger: LedgerForVerify;
	session: SessionStateForVerify;
	/** Normalised URLs the user typed, from `collectUserPromptUrls` over the uncapped prompt text. */
	userPromptUrls: ReadonlySet<string>;
	/** The fence nonce of the prompt that produced the draft. */
	nonce: string;
	/** An operator's own redaction rules, as the ledger and the watcher pass them. */
	redactionRules?: RedactionRule[];
}

export interface VerifyResult {
	summary: SessionSummary;
	adjustments: SummaryAdjustment[];
	suspect: boolean;
	suspectReasons: SummarySuspectReason[];
	evidence: Record<string, StoredEvidenceFact>;
}

// ── scrub ────────────────────────────────────────────────────────────────────

/** Invisible characters, the nonce, then redaction; one line unless `keepNewlines`. */
function scrubber(nonce: string, rules: RedactionRule[] | undefined) {
	return (text: string, keepNewlines = false): string => {
		const cleaned = redact(removeNonce(stripInvisibleKeepNewlines(text), nonce), rules).text.trim();
		return keepNewlines ? cleaned : cleaned.replace(/\s*\n+\s*/g, " ");
	};
}

// ── facts ────────────────────────────────────────────────────────────────────

/** Kinds that record something the system itself saw happen. */
const OBSERVED_KINDS = new Set(["edit", "command", "validation", "tool"]);

const isObserved = (fact: LedgerFactForVerify): boolean =>
	fact.observed ?? OBSERVED_KINDS.has(fact.kind);

const STORED_RESULTS = new Set(["ok", "failed", "unknown", "completed"]);

function storedFact(fact: LedgerFactForVerify): StoredEvidenceFact {
	const out: StoredEvidenceFact = { kind: fact.kind, at: fact.at };
	if (fact.result && STORED_RESULTS.has(fact.result)) {
		out.result = fact.result as StoredEvidenceFact["result"];
	}
	if (typeof fact.count === "number") out.count = fact.count;
	return out;
}

// ── validation ───────────────────────────────────────────────────────────────

const VALIDATION_DETAIL: Record<ValidationAdjustReason, string> = {
	no_validation_cited: "Unknown: no test or build command found for this",
	cited_unknown: "Unknown: the recorded command output does not show whether it passed",
	cited_failed: "Unknown: the cited command failed, so this was not shown to pass",
	mixed: "Unknown: the cited commands had different results",
	not_failed: "Unknown: the cited commands do not show a failure",
};

interface ValidationJudgement {
	result: SummaryValidation["result"];
	reason?: ValidationAdjustReason;
}

function judgeValidation(
	claimed: SummaryValidation["result"],
	cited: LedgerFactForVerify[],
): ValidationJudgement {
	if (claimed !== "passed" && claimed !== "failed") return { result: claimed };
	const validations = cited.filter((f) => f.kind === "validation" && isObserved(f));
	const anyFailed = validations.some((f) => f.result === "failed");
	if (claimed === "failed") {
		if (anyFailed) return { result: "failed" };
		return {
			result: "unknown",
			reason: validations.length === 0 ? "no_validation_cited" : "not_failed",
		};
	}
	if (validations.length === 0) return { result: "unknown", reason: "no_validation_cited" };
	if (validations.every((f) => f.result === "ok")) return { result: "passed" };
	if (anyFailed) {
		const allFailed = validations.every((f) => f.result === "failed");
		return { result: "unknown", reason: allFailed ? "cited_failed" : "mixed" };
	}
	return { result: "unknown", reason: "cited_unknown" };
}

// ── outcome ──────────────────────────────────────────────────────────────────

const CLAMPED_STATUSES = new Set<SummaryOutcomeStatus>([
	"completed",
	"mostly_completed",
	"failed",
	"abandoned",
]);

/** Working, or blocked on an outstanding permission prompt. A finished-turn wait is neither. */
function stillRunning(session: SessionStateForVerify): "working" | "permission_wait" | null {
	if (session.operational === "working") return "working";
	if (session.operational === "waiting" && session.permissionWaitOutstanding)
		return "permission_wait";
	return null;
}

// ── verify ───────────────────────────────────────────────────────────────────

export function verifySummary(input: VerifyInput): VerifyResult {
	const { draft, ledger, session } = input;
	const scrub = scrubber(input.nonce, input.redactionRules);
	const cited = new Map<string, LedgerFactForVerify>();

	const survivors = (ids: string[]): string[] => {
		const kept: string[] = [];
		for (const id of ids) {
			const fact = ledger.ids.get(id);
			if (!fact || kept.includes(id)) continue;
			kept.push(id);
			cited.set(id, fact);
		}
		return kept;
	};
	const factsOf = (ids: string[]) => ids.map((id) => ledger.ids.get(id) as LedgerFactForVerify);

	const plain = (item: DraftItem): DraftItem => ({
		text: scrub(item.text),
		evidence: survivors(item.evidence),
	});
	const claim = (item: DraftItem): SummaryClaimItem => {
		const evidence = survivors(item.evidence);
		return {
			text: scrub(item.text),
			evidence,
			unverified: !factsOf(evidence).some(isObserved),
		};
	};

	const adjustments: SummaryAdjustment[] = [];
	const validation: SummaryValidation[] = draft.validation.map((v, index) => {
		const evidence = survivors(v.evidence);
		const judged = judgeValidation(v.result, factsOf(evidence));
		const adjusted = judged.reason !== undefined;
		if (judged.reason) {
			adjustments.push({
				code: "validation_adjusted",
				index,
				from: v.result,
				reason: judged.reason,
			});
		}
		return {
			what: scrub(v.what),
			result: judged.result,
			detail: judged.reason ? VALIDATION_DETAIL[judged.reason] : scrub(v.detail),
			evidence,
			adjusted,
		};
	});

	let status = draft.outcome.status;
	const running = stillRunning(session);
	if (running && CLAMPED_STATUSES.has(status)) {
		adjustments.push({ code: "outcome_clamped", from: status, to: "in_progress", reason: running });
		status = "in_progress";
	}
	if (status === "completed" && session.lifecycleStatus === "failed") {
		adjustments.push({ code: "note_lifecycle_failed" });
	}
	if (status === "completed" && validation.some((v) => v.result === "failed")) {
		adjustments.push({ code: "note_completed_with_failed_validation" });
	}

	const summary: SessionSummary = {
		overview: scrub(draft.overview),
		outcome: { status, explanation: scrub(draft.outcome.explanation) },
		accomplishments: draft.accomplishments.map(claim),
		changes: draft.changes.map((c) => ({ ...claim(c), kind: c.kind })),
		decisions: draft.decisions.map((d) => ({ ...plain(d), why: scrub(d.why) })),
		validation,
		problems: draft.problems.map(plain),
		unfinished: draft.unfinished.map(plain),
		nextActions: draft.nextActions.map(plain),
		handoff: scrub(draft.handoff, true),
	};

	const suspectReasons = runTripwire(summary, input.userPromptUrls);
	const evidence: Record<string, StoredEvidenceFact> = {};
	const ordered = [...cited.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
	for (const id of ordered) evidence[id] = storedFact(cited.get(id) as LedgerFactForVerify);

	return {
		summary,
		adjustments,
		suspect: suspectReasons.length > 0,
		suspectReasons,
		evidence,
	};
}

// ── what is stored ───────────────────────────────────────────────────────────

export interface StoredSummaryInput {
	verified: VerifyResult;
	promptVersion: string;
	/** Only `kind` and `model` are read: never an id, a name or an endpoint. */
	provider: { kind: string; model: string };
	usage: { inputTokens: number; outputTokens: number; estimated: boolean };
	costCents: number;
	calls: number;
	redactionHits: number;
	coverage: {
		status: "full" | "partial";
		eventsTotal: number;
		eventsRead: number;
		eventsRepresented: number;
		droppedByCap: number;
		droppedByBudget: number;
		cutoffAt: string | null;
	};
	firstEventId: number | null;
}

/** The summary and its provenance, by named fields only (nothing is spread in). */
export function buildStoredSummary(input: StoredSummaryInput): StoredSessionSummary {
	const { verified, coverage } = input;
	return {
		summary: verified.summary,
		provenance: {
			promptVersion: input.promptVersion,
			provider: { kind: input.provider.kind, model: input.provider.model },
			inputTokens: input.usage.inputTokens,
			outputTokens: input.usage.outputTokens,
			usageEstimated: input.usage.estimated,
			costCents: input.costCents,
			calls: input.calls,
			redactionHits: input.redactionHits,
			eventsTotal: coverage.eventsTotal,
			eventsRead: coverage.eventsRead,
			eventsRepresented: coverage.eventsRepresented,
			coverage: {
				status: coverage.status,
				droppedByCap: coverage.droppedByCap,
				droppedByBudget: coverage.droppedByBudget,
				cutoffAt: coverage.cutoffAt,
			},
			firstEventId: input.firstEventId,
			adjustments: verified.adjustments,
			suspect: verified.suspect,
			evidence: verified.evidence,
		},
	};
}
