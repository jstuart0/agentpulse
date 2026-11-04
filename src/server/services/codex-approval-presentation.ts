/**
 * What a person is shown for a Codex approval, built from the supervisor's
 * report (pure, no I/O). The server builds, redacts and hashes the text itself;
 * raw text is never persisted.
 *
 * A request is approvable only if nothing had to change: any redaction, any
 * stripped or rewritten character (stripAndRedact can rewrite U+2028, U+2029 and
 * NEL to LF and drops CR), any truncation, or any decline-only reason from the
 * supervisor removes Approve. `presentationHash` is an ETag for the stored
 * presentation, not proof that a person read it or that it matches execution.
 */
import {
	CODEX_APPROVAL_LIMITS,
	type CodexApprovalPathPreview,
	type CodexApprovalPresentation,
	type CodexApprovalPresentationChange,
	type CodexApprovalPreview,
	type CodexApprovalReportRequest,
	NOT_APPROVABLE_REASONS,
	type NotApprovableReason,
} from "../../shared/codex-approvals.js";
import { stripAndRedact } from "./ai/redactor.js";
import { sha256Hex } from "./util/hash.js";

/** Stable JSON: keys sorted at every depth, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeys((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

export function hashPresentation(presentation: CodexApprovalPresentation): string {
	return sha256Hex(canonicalJson(presentation));
}

/** Precedence when more than one reason applies: what the supervisor already knows first, then what the server finds. */
const REASON_PRECEDENCE: readonly NotApprovableReason[] = [
	"write_stdin",
	"network",
	"grant_root",
	"unknown_param",
	"accept_not_offered",
	"no_command",
	"no_cwd",
	"no_diff",
	"too_long",
	"redacted",
	"invisible_chars",
	"padded_text",
	"lookalike_text",
];

interface FieldFindings {
	tooLong: boolean;
	redacted: boolean;
	invisible: boolean;
	padded: boolean;
	lookalike: boolean;
}

function newFindings(): FieldFindings {
	return { tooLong: false, redacted: false, invisible: false, padded: false, lookalike: false };
}

// ── text that hides or imitates other text ──────────────────────────────────

const SPACE_RUN_RE = new RegExp(`[ \\t]{${CODEX_APPROVAL_LIMITS.maxSpaceRun + 1},}`);
/** Any space separator other than U+0020 (no-break, ideographic, en/em and the rest). */
const ODD_SPACE_RE = /(?!\u0020)\p{Zs}/u;
/** Format characters (zero-width, bidi, joiners) and the braille blank, which draws as nothing. */
const INVISIBLE_RE = /[\p{Cf}\u2800]/u;
const LATIN_RE = /\p{Script=Latin}/u;
const SCRIPT_PARTNER_RE = /[\p{Script=Cyrillic}\p{Script=Greek}\uFF00-\uFFEF]/u;

function hasLongBlankRun(text: string): boolean {
	let run = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			run++;
			if (run > CODEX_APPROVAL_LIMITS.maxBlankLineRun) return true;
		} else {
			run = 0;
		}
	}
	return false;
}

function mixesScripts(token: string): boolean {
	return LATIN_RE.test(token) && SCRIPT_PARTNER_RE.test(token);
}

/** How a field is split into the units that may not mix scripts: a command by whitespace, a path by segment. */
type TokenSplit = "whitespace" | "segments";

function hasLookalike(text: string, split: TokenSplit): boolean {
	if (ODD_SPACE_RE.test(text) || INVISIBLE_RE.test(text)) return true;
	const tokens = split === "whitespace" ? text.split(/\s+/) : text.split(/[/\\]/);
	return tokens.some(mixesScripts);
}

interface FieldChecks {
	/** The field is a command or path a person relies on: look for padding and lookalikes. */
	split?: TokenSplit;
	/** Past this many characters the field is shown but not approvable. */
	approvableMax?: number;
}

/**
 * Cleans one text field: cut to `max`, strip, redact. `cutMargin` removes that
 * many more characters from the end afterwards (a secret split by a cut would
 * otherwise leave its tail), and applies only to a field that was truncated.
 */
function cleanField(
	input: unknown,
	max: number,
	findings: FieldFindings,
	options: { truncated?: boolean } & FieldChecks = {},
): string | null {
	if (typeof input !== "string") return null;
	let text = input;
	let cut = options.truncated === true;
	if (text.length > max) {
		text = text.slice(0, max);
		cut = true;
	}
	if (cut) findings.tooLong = true;
	if (options.approvableMax !== undefined && text.length > options.approvableMax) {
		findings.tooLong = true;
	}
	if (options.split) {
		if (SPACE_RUN_RE.test(text) || hasLongBlankRun(text)) findings.padded = true;
		if (hasLookalike(text, options.split)) findings.lookalike = true;
	}
	const { text: cleaned, hits } = stripAndRedact(text);
	if (hits.length > 0) findings.redacted = true;
	else if (cleaned !== text) findings.invisible = true;
	if (!cut) return cleaned;
	return cleaned.slice(0, Math.max(0, cleaned.length - CODEX_APPROVAL_LIMITS.secretCutMargin));
}

function isBlank(value: string | null): boolean {
	return value === null || value.trim() === "";
}

export interface BuiltPresentation {
	presentation: CodexApprovalPresentation;
	/** The canonical JSON text stored and hashed. */
	presentationJson: string;
	hash: string;
	reasonText: string | null;
	approvable: boolean;
	notApprovableReason: NotApprovableReason | null;
}

function validDeclineOnly(input: unknown): NotApprovableReason[] {
	if (!Array.isArray(input)) return [];
	return input.filter((r): r is NotApprovableReason =>
		(NOT_APPROVABLE_REASONS as readonly unknown[]).includes(r),
	);
}

export function buildPresentation(report: CodexApprovalReportRequest): BuiltPresentation {
	const findings = newFindings();
	const reasons = new Set<NotApprovableReason>(validDeclineOnly(report.declineOnly));
	const truncated = report.truncated === true;

	const pathChecks: FieldChecks = { split: "segments" };
	const cwd = cleanField(report.cwd, CODEX_APPROVAL_LIMITS.pathChars, findings, pathChecks);
	const reason = cleanField(report.reason, CODEX_APPROVAL_LIMITS.reasonChars, findings);
	const grantRoot = cleanField(
		report.grantRoot,
		CODEX_APPROVAL_LIMITS.pathChars,
		findings,
		pathChecks,
	);
	if (grantRoot !== null) reasons.add("grant_root");

	let presentation: CodexApprovalPresentation;
	if (report.requestKind === "command") {
		const command = cleanField(report.command, CODEX_APPROVAL_LIMITS.command, findings, {
			truncated,
			split: "whitespace",
			approvableMax: CODEX_APPROVAL_LIMITS.approvableCommandChars,
		});
		if (isBlank(command)) reasons.add("no_command");
		if (isBlank(cwd)) reasons.add("no_cwd");
		presentation = { v: 1, requestKind: "command", command, cwd, reason, grantRoot };
	} else {
		const changes: CodexApprovalPresentationChange[] = [];
		let diffBudget: number = CODEX_APPROVAL_LIMITS.totalDiff;
		const incoming = Array.isArray(report.changes) ? report.changes : [];
		if (incoming.length > CODEX_APPROVAL_LIMITS.files) findings.tooLong = true;
		let anyMissingDiff = false;
		for (const change of incoming.slice(0, CODEX_APPROVAL_LIMITS.files)) {
			const path =
				cleanField(change?.path, CODEX_APPROVAL_LIMITS.pathChars, findings, pathChecks) ?? "";
			const kind = cleanField(change?.kind, 32, findings) ?? "";
			const movePath = cleanField(
				change?.movePath,
				CODEX_APPROVAL_LIMITS.pathChars,
				findings,
				pathChecks,
			);
			if (typeof change?.diff !== "string") anyMissingDiff = true;
			const rawDiff = typeof change?.diff === "string" ? change.diff : "";
			const diffCap = Math.max(0, diffBudget);
			const diff =
				cleanField(
					rawDiff.length > diffCap ? rawDiff.slice(0, diffCap) : rawDiff,
					diffCap,
					findings,
					{
						truncated: truncated || rawDiff.length > diffCap,
					},
				) ?? "";
			diffBudget -= Math.min(rawDiff.length, diffCap);
			changes.push({ path, kind, movePath, diff });
		}
		if (changes.length === 0 || anyMissingDiff) reasons.add("no_diff");
		presentation = { v: 1, requestKind: "file_change", changes, cwd, reason, grantRoot };
	}

	if (findings.tooLong) reasons.add("too_long");
	if (findings.redacted) reasons.add("redacted");
	else if (findings.invisible) reasons.add("invisible_chars");
	if (findings.padded) reasons.add("padded_text");
	if (findings.lookalike) reasons.add("lookalike_text");

	const notApprovableReason = REASON_PRECEDENCE.find((r) => reasons.has(r)) ?? null;
	const presentationJson = canonicalJson(presentation);
	return {
		presentation,
		presentationJson,
		hash: sha256Hex(presentationJson),
		reasonText: reason,
		approvable: notApprovableReason === null,
		notApprovableReason,
	};
}

const NON_ASCII_RE = /\P{ASCII}/u;

function lastLinesOf(text: string, count: number, maxChars: number): string {
	const lines = text.split("\n");
	const tail = lines.slice(Math.max(0, lines.length - count)).join("\n");
	return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}

function isInside(path: string, cwd: string): boolean {
	// A home shortcut and a backslash path don't resolve the way the slash arithmetic below assumes.
	if (/^~|\\/.test(path) || /^~|\\/.test(cwd)) return false;
	const normalize = (value: string) => {
		const parts: string[] = [];
		for (const segment of value.split("/")) {
			if (segment === "" || segment === ".") continue;
			if (segment === "..") parts.pop();
			else parts.push(segment);
		}
		return `/${parts.join("/")}`;
	};
	if (!path.startsWith("/")) return !path.split("/").includes("..");
	const normalizedCwd = normalize(cwd);
	const normalizedPath = normalize(path);
	return normalizedPath === normalizedCwd || normalizedPath.startsWith(`${normalizedCwd}/`);
}

/** The list-sized view of a presentation: bounded to 4 KiB, no full diff. */
export function buildPreview(presentation: CodexApprovalPresentation): CodexApprovalPreview {
	if (presentation.requestKind === "command") {
		const command = presentation.command ?? "";
		const head = command.length > 1200 ? command.slice(0, 1200) : command;
		return {
			cwd: presentation.cwd,
			commandHead: head,
			lastLines: lastLinesOf(command, 3, 1200),
			lineCount: command === "" ? 0 : command.split("\n").length,
			charCount: command.length,
			pathOutsideCwd: false,
			nonAscii: NON_ASCII_RE.test(command) || NON_ASCII_RE.test(presentation.cwd ?? ""),
		};
	}
	const cwd = presentation.cwd;
	const paths: CodexApprovalPathPreview[] = presentation.changes
		.slice(0, 5)
		.map((change) => ({ path: change.path.slice(0, 300), kind: change.kind }));
	const outside = presentation.changes.some(
		(change) =>
			cwd === null ||
			!isInside(change.path, cwd) ||
			(change.movePath !== null && !isInside(change.movePath, cwd)),
	);
	return {
		cwd,
		fileCount: presentation.changes.length,
		paths,
		pathOutsideCwd: outside,
		nonAscii:
			presentation.changes.some(
				(change) => NON_ASCII_RE.test(change.path) || NON_ASCII_RE.test(change.movePath ?? ""),
			) || NON_ASCII_RE.test(cwd ?? ""),
	};
}
