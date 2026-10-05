/**
 * AGEN-69: what the server checks before it stores a summary (plan "What the
 * server verifies"). Pure. The model's answer is a draft; this turns it into
 * what is stored and shown: citations that exist, "Agent's claim only" where
 * nothing observed backs a claim, validation results computed from the cited
 * command lines, the outcome clamp, scrubbed text, the instruction tripwire,
 * and evidence facts for the cited ids (no text).
 *
 * It depends on the ledger only through `LedgerForVerify`: the id map (each
 * id's kind, time, result, count, validation class and whether it was OBSERVED)
 * and what the ledger shows of file paths and commands. Phase 5 passes the
 * ledger's own `ids` map as is; a fact that went through `storedFact()` has no
 * `observed` and is a type error here.
 */
import {
	type OperationalStatus,
	type OperationalStatusInput,
	getOperationalStatus,
	hasOutstandingPermissionWait,
} from "../../../../shared/session-state.js";
import {
	type DraftItem,
	type EvidenceFactKind,
	type EvidenceFactResult,
	SUMMARY_SCHEMA_VERSION,
	type SessionSummary,
	type StoredEvidenceFact,
	type StoredSessionSummary,
	type SummaryAdjustment,
	type SummaryChangeKind,
	type SummaryClaimItem,
	type SummaryDraft,
	type SummaryOutcomeStatus,
	type SummarySuspectReason,
	type SummaryValidation,
	type ValidationAdjustReason,
} from "../../../../shared/session-summary.js";
import { parseDbTimestamp } from "../../util/db-time.js";
import { type RedactionRule, redact } from "../redactor.js";
import { stripInvisibleKeepNewlines } from "../untrusted-text.js";
import { removeNonce } from "./output-schema.js";
import { type TripwireContext, runTripwire } from "./tripwire.js";

/**
 * A ledger fact as verification reads it. `observed` is required: it is what
 * separates a recorded call from a claim, and the ledger's id map carries it.
 */
export interface LedgerFactForVerify {
	kind: EvidenceFactKind;
	at: string | null;
	result?: EvidenceFactResult;
	count?: number;
	validationClass?: string;
	/**
	 * For a command or validation: the ledger printed its text. Absent means not shown,
	 * and a command that was not shown (withheld, over the SQL cap, a patch) backs nothing.
	 */
	shown?: boolean;
	/** For a shown command that is exactly one segment: its verb. Absent for a chain, a pipe, `|| true`, a newline. */
	verb?: string;
	/** OBSERVED (the system recorded it) versus CLAIMED (a person or a model said it). */
	observed: boolean;
}

export interface LedgerForVerify {
	ids: ReadonlyMap<string, LedgerFactForVerify>;
	/** What the ledger shows, as shown; the tripwire's evidence for "the session ran this" and "this file exists". */
	recorded: { paths: readonly string[]; commands: readonly string[] };
}

/**
 * The session as it is AFTER the model call: read the row again once the answer
 * is in, so a session that started or stopped working meanwhile is judged as it
 * stands. Build it with `sessionStateForVerify`.
 */
export interface SessionStateForVerify {
	/** `getOperationalStatus` of the session row. */
	operational: OperationalStatus;
	/** `hasOutstandingPermissionWait` of the session row. */
	permissionWaitOutstanding: boolean;
	/** The lifecycle `status` column. */
	lifecycleStatus: string;
}

/** The columns `sessionStateForVerify` reads; a wider row (a whole `sessions` row) is fine. */
export type SessionRowForVerify = OperationalStatusInput;

export function sessionStateForVerify(row: SessionRowForVerify): SessionStateForVerify {
	return {
		operational: getOperationalStatus(row),
		permissionWaitOutstanding: hasOutstandingPermissionWait(row),
		lifecycleStatus: row.status,
	};
}

export interface VerifyInput {
	draft: SummaryDraft;
	ledger: LedgerForVerify;
	session: SessionStateForVerify;
	/**
	 * Normalised URLs the user typed, from `collectUserPromptUrls` over `userPromptTexts(bundle)`.
	 * That text is the loader's SQL-cut prompt text (1,756 / 4,256 code points) and only prompts
	 * inside the scanned window exist, so a URL past the cut or in an unread prompt raises
	 * `unexpected_url`, a note (inside a risky command it also raises `risky_command`, a warning).
	 */
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

/**
 * What backs a claim (ruling R-E): an OBSERVED fact that is a recorded edit that
 * did not fail, or a command or validation whose text the ledger SHOWED and that
 * finished `ok`. A withheld or not-shown command has hidden text, so it supports
 * nothing specific ("not shown" is reachable by padding a command past the SQL
 * cap). A `completed` or `unknown` command, a `tool` entry, a failed entry, and
 * anything CLAIMED back nothing on their own: "the command ran" is not "the
 * claim is true".
 */
function backsClaim(fact: LedgerFactForVerify): boolean {
	if (!fact.observed) return false;
	switch (fact.kind) {
		case "edit":
			return fact.result !== "failed";
		case "command":
		case "validation":
			return fact.result === "ok" && fact.shown === true;
		default:
			return false;
	}
}

/** The fact kind each change kind needs: edits for file changes, commands for git and infrastructure. */
const CHANGE_NEEDS: Record<SummaryChangeKind, EvidenceFactKind[] | null> = {
	created: ["edit"],
	modified: ["edit"],
	deleted: ["edit"],
	config: ["edit"],
	dependency: ["edit"],
	schema: ["edit"],
	git: ["command"],
	infrastructure: ["command"],
	other: null,
};

/**
 * A git change is backed by a cited command that is ONE segment whose verb is
 * `git`: `git push || true` and `cd x && git push` end `ok` through their last
 * segment and prove nothing about the push. An infrastructure change is backed by
 * one segment whose verb is an infrastructure tool, not any command: "Deployed"
 * citing `ls` is not backed. Chosen narrow so that the label errs toward "Agent's
 * claim only"; a `make deploy` or a script is therefore not backing.
 */
const INFRASTRUCTURE_VERBS: ReadonlySet<string> = new Set([
	"kubectl",
	"helm",
	"terraform",
	"tofu",
	"docker",
	"docker-compose",
	"podman",
	"ansible",
	"ansible-playbook",
	"aws",
	"gcloud",
	"az",
	"systemctl",
	"pulumi",
]);
const CHANGE_VERBS: Partial<Record<SummaryChangeKind, ReadonlySet<string>>> = {
	git: new Set(["git"]),
	infrastructure: INFRASTRUCTURE_VERBS,
};

function backsChange(kind: SummaryChangeKind, fact: LedgerFactForVerify): boolean {
	if (!backsClaim(fact)) return false;
	const needs = CHANGE_NEEDS[kind];
	if (!needs) return true;
	if (!needs.includes(fact.kind)) return false;
	const verbs = CHANGE_VERBS[kind];
	return verbs === undefined || (fact.verb !== undefined && verbs.has(fact.verb));
}

function storedFact(fact: LedgerFactForVerify): StoredEvidenceFact {
	const out: StoredEvidenceFact = { kind: fact.kind, at: fact.at };
	if (fact.result) out.result = fact.result;
	if (typeof fact.count === "number") out.count = fact.count;
	if (fact.validationClass) out.validationClass = fact.validationClass;
	return out;
}

const idNumber = (id: string): number => Number(id.slice(1));

const timeOf = (at: string | null): number => (at ? Date.parse(at) : Number.NaN);

// ── validation ───────────────────────────────────────────────────────────────

const VALIDATION_DETAIL: Record<ValidationAdjustReason, string> = {
	no_validation_cited: "Unknown: no test or build command found for this",
	cited_unknown: "Unknown: the recorded command output does not show whether it passed",
	cited_failed: "Unknown: the cited command failed, so this was not shown to pass",
	mixed: "Unknown: the cited commands had different results",
	not_failed: "Unknown: the cited commands do not show a failure",
	edited_after_validation: "Unknown: files were edited after the cited command ran",
};

interface ValidationJudgement {
	result: SummaryValidation["result"];
	reason?: ValidationAdjustReason;
}

/** Every observed `edit` that did not fail and is newer than `than`. */
function editedAfter(ledger: LedgerForVerify, than: number): boolean {
	if (Number.isNaN(than)) return false;
	for (const fact of ledger.ids.values()) {
		if (fact.kind !== "edit" || !fact.observed || fact.result === "failed") continue;
		if (timeOf(fact.at) > than) return true;
	}
	return false;
}

function judgeValidation(
	claimed: SummaryValidation["result"],
	cited: LedgerFactForVerify[],
	ledger: LedgerForVerify,
): ValidationJudgement {
	if (claimed !== "passed" && claimed !== "failed") return { result: claimed };
	const validations = cited.filter((f) => f.kind === "validation" && f.observed);
	const anyFailed = validations.some((f) => f.result === "failed");
	if (claimed === "failed") {
		if (anyFailed) return { result: "failed" };
		return {
			result: "unknown",
			reason: validations.length === 0 ? "no_validation_cited" : "not_failed",
		};
	}
	if (validations.length === 0) return { result: "unknown", reason: "no_validation_cited" };
	if (validations.every((f) => f.result === "ok")) {
		const newest = Math.max(...validations.map((f) => timeOf(f.at)));
		if (editedAfter(ledger, newest))
			return { result: "unknown", reason: "edited_after_validation" };
		return { result: "passed" };
	}
	if (anyFailed) {
		const allFailed = validations.every((f) => f.result === "failed");
		return { result: "unknown", reason: allFailed ? "cited_failed" : "mixed" };
	}
	return { result: "unknown", reason: "cited_unknown" };
}

/** The newest validation fact in the ledger (ids rise with event ids), if its result is `failed`. */
function lastValidationFailedId(ledger: LedgerForVerify): string | null {
	let lastId: string | null = null;
	for (const [id, fact] of ledger.ids) {
		if (fact.kind !== "validation" || !fact.observed) continue;
		if (lastId === null || idNumber(id) > idNumber(lastId)) lastId = id;
	}
	return lastId !== null && ledger.ids.get(lastId)?.result === "failed" ? lastId : null;
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

function tripwireContext(input: VerifyInput): TripwireContext {
	return {
		userPromptUrls: input.userPromptUrls,
		recordedPaths: input.ledger.recorded.paths,
		recordedCommands: input.ledger.recorded.commands,
	};
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
	const claim = (item: DraftItem, backs = backsClaim): SummaryClaimItem => {
		const evidence = survivors(item.evidence);
		return {
			text: scrub(item.text),
			evidence,
			unverified: !factsOf(evidence).some(backs),
		};
	};

	const adjustments: SummaryAdjustment[] = [];
	const validation: SummaryValidation[] = draft.validation.map((v, index) => {
		const evidence = survivors(v.evidence);
		const judged = judgeValidation(v.result, factsOf(evidence), ledger);
		const classes = [
			...new Set(
				factsOf(evidence)
					.filter((f) => f.kind === "validation" && f.validationClass)
					.map((f) => f.validationClass as string),
			),
		];
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
			...(classes.length > 0 ? { classes } : {}),
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

	const summary: SessionSummary = {
		overview: scrub(draft.overview),
		outcome: { status, explanation: scrub(draft.outcome.explanation) },
		accomplishments: draft.accomplishments.map((item) => claim(item)),
		changes: draft.changes.map((c) => ({
			...claim(c, (fact) => backsChange(c.kind, fact)),
			kind: c.kind,
		})),
		decisions: draft.decisions.map((d) => ({ ...plain(d), why: scrub(d.why) })),
		validation,
		problems: draft.problems.map(plain),
		unfinished: draft.unfinished.map(plain),
		nextActions: draft.nextActions.map(plain),
		handoff: scrub(draft.handoff, true),
	};

	// The last validation the ledger shows failed and nothing the summary cites mentions it.
	const lastFailed = lastValidationFailedId(ledger);
	const claimsDone = status === "completed" || status === "mostly_completed";
	if (
		(status === "completed" && validation.some((v) => v.result === "failed")) ||
		(claimsDone && lastFailed !== null && !cited.has(lastFailed))
	) {
		adjustments.push({ code: "note_completed_with_failed_validation" });
	}

	const suspectReasons = runTripwire(summary, tripwireContext(input));
	const evidence: Record<string, StoredEvidenceFact> = {};
	const ordered = [...cited.keys()].sort((a, b) => idNumber(a) - idNumber(b));
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
		/** The ledger's `overBudget`: the protected entries alone exceeded the budget. */
		overBudget: boolean;
	};
	firstEventId: number | null;
	/** `newestEventAt(bundle.rows)`. */
	throughAt: string | null;
}

/** ISO time of the newest event among the loader's rows; null when none carried a readable time. */
export function newestEventAt(rows: ReadonlyArray<{ createdAt: string }>): string | null {
	let newest = Number.NaN;
	for (const row of rows) {
		const ms = parseDbTimestamp(row.createdAt);
		if (ms !== null && !(ms <= newest)) newest = ms;
	}
	return Number.isNaN(newest) ? null : new Date(newest).toISOString();
}

/** The summary and its provenance, by named fields only (nothing is spread in). */
export function buildStoredSummary(input: StoredSummaryInput): StoredSessionSummary {
	const { verified, coverage } = input;
	return {
		summary: verified.summary,
		provenance: {
			schemaVersion: SUMMARY_SCHEMA_VERSION,
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
				overBudget: coverage.overBudget,
			},
			firstEventId: input.firstEventId,
			throughAt: input.throughAt,
			adjustments: verified.adjustments,
			suspectReasons: verified.suspectReasons,
			suspect: verified.suspectReasons.length > 0,
			evidence: verified.evidence,
		},
	};
}
