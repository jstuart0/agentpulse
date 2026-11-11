import { FORK_MCP_INPUT_MAX_CHARS, splitForkMcpToolName } from "../../shared/claude-fork-mcp.js";
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
import { AGENT_PROMPT_MAX_CHARS, isBuiltInAgentType } from "../../shared/claude-fork-subagents.js";
import {
	CODEX_APPROVAL_LIMITS,
	type CodexApprovalClaudeToolPresentation,
	type CodexApprovalFileChangePresentation,
	type CodexApprovalPathPreview,
	type CodexApprovalPresentation,
	type CodexApprovalPresentationChange,
	type CodexApprovalPreview,
	type CodexApprovalReportRequest,
	NOT_APPROVABLE_REASONS,
	type NotApprovableReason,
} from "../../shared/codex-approvals.js";
import { stripAndRedact } from "./ai/redactor.js";
import { cutText, cutTextTail, wellFormedText } from "./storage-text.js";
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
	"unknown_tool",
	"nested_agent",
	"custom_agent",
	"requires_interaction",
	"agent_memory",
	"agentpulse_files",
	"path_not_absolute",
	"symlink_target",
	"input_not_stable",
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
		text = cutText(text, max);
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
	const { text: stripped, hits } = stripAndRedact(text);
	if (hits.length > 0) findings.redacted = true;
	else if (stripped !== text) findings.invisible = true;
	// A lone surrogate can't be shown or stored as it came: it is replaced, and the field is no longer
	// approvable, like any other change (NUL is stripped above, as before).
	const cleaned = wellFormedText(stripped);
	if (cleaned !== stripped) findings.invisible = true;
	if (!cut) return cleaned;
	return cutText(cleaned, Math.max(0, cleaned.length - CODEX_APPROVAL_LIMITS.secretCutMargin));
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

/**
 * Who asked. A takeover fork's Bash request carries the path Claude says it would touch (`blockedPath`) in its
 * presentation; a Codex request has no such key, so a Codex row's stored text and hash don't change.
 */
export type PresentationAgent = "codex" | "claude";

/**
 * True when the URL's host isn't one a person can read off it: the authority can't be found (`https:\\host`,
 * `https:/host`, which a fetcher may still read as a host), it carries credentials (`user@host`, where what
 * follows the `@` is the real host), it has a non-ASCII character or it has a punycode label. ASCII lookalikes
 * (`rn` for `m`) are not caught: a residual.
 */
export function urlHostLooksLikeAnother(url: string): boolean {
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url.trim())?.[1];
	if (authority === undefined) return true;
	return authority.includes("@") || /\P{ASCII}/u.test(authority) || /(^|\.)xn--/i.test(authority);
}

/** What the server knows about the session that the report can't be trusted to say. */
export interface PresentationContext {
	/** The MCP servers the fork was started with; an MCP report is split against them again here. */
	mcpServers?: readonly string[];
}

export function buildPresentation(
	report: CodexApprovalReportRequest,
	agent: PresentationAgent = "codex",
	context: PresentationContext = {},
): BuiltPresentation {
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
	let mcpSlot = report.mcp;
	if (report.requestKind === "claude_tool" && report.mcp) {
		// An MCP tool call (AGEN-121). `tool` says only "mcp"; the names are in the slot, which the server
		// derives again from the wire name against the servers this session was started with. A host value that
		// differs makes the request decline-only, and the card shows the server's own split.
		const recomputed = splitForkMcpToolName(report.mcp.rawToolName, context.mcpServers ?? []);
		if (
			recomputed === null ||
			recomputed.server !== report.mcp.server ||
			recomputed.tool !== report.mcp.tool
		) {
			reasons.add("unknown_param");
		}
		if (recomputed !== null) mcpSlot = recomputed;
		const input = cleanField(report.target, FORK_MCP_INPUT_MAX_CHARS, findings, {
			truncated,
			split: "whitespace",
		});
		if (isBlank(input)) reasons.add("no_command");
		presentation = {
			v: 1,
			requestKind: "claude_tool",
			tool: "mcp",
			target: input,
			cwd,
			reason: null,
			grantRoot: null,
		};
	} else if (report.requestKind === "claude_tool") {
		const tool = cleanField(report.tool, 32, findings) ?? "";
		const isUrl = tool === "WebFetch";
		const target = cleanField(report.target, CODEX_APPROVAL_LIMITS.pathChars, findings, {
			truncated,
			// A URL's lookalike check is its own (below); a path is split on its slashes like any other.
			...(isUrl ? {} : pathChecks),
		});
		if (isBlank(target)) reasons.add("no_command");
		if (isUrl && target !== null && urlHostLooksLikeAnother(target)) findings.lookalike = true;
		const toolPresentation: CodexApprovalClaudeToolPresentation = {
			v: 1,
			requestKind: "claude_tool",
			tool,
			target,
			cwd,
			reason,
			grantRoot: null,
		};
		presentation = toolPresentation;
	} else if (report.requestKind === "command") {
		const command = cleanField(report.command, CODEX_APPROVAL_LIMITS.command, findings, {
			truncated,
			split: "whitespace",
			approvableMax: CODEX_APPROVAL_LIMITS.approvableCommandChars,
		});
		if (isBlank(command)) reasons.add("no_command");
		if (isBlank(cwd)) reasons.add("no_cwd");
		presentation =
			agent === "claude"
				? {
						v: 1,
						requestKind: "command",
						command,
						cwd,
						reason,
						grantRoot,
						blockedPath: cleanField(
							report.blockedPath,
							CODEX_APPROVAL_LIMITS.pathChars,
							findings,
							pathChecks,
						),
					}
				: { v: 1, requestKind: "command", command, cwd, reason, grantRoot };
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
				cleanField(cutText(rawDiff, diffCap), diffCap, findings, {
					truncated: truncated || rawDiff.length > diffCap,
				}) ?? "";
			diffBudget -= Math.min(rawDiff.length, diffCap);
			changes.push({ path, kind, movePath, diff });
		}
		if (changes.length === 0 || anyMissingDiff) reasons.add("no_diff");
		presentation = { v: 1, requestKind: "file_change", changes, cwd, reason, grantRoot };
	}

	// Slots reserved for the MCP and subagent tracks: part of the presentation, and so of its hash, only when
	// the report has them. A report without them builds the presentation it always built.
	if (report.fromSubagent === true) presentation = { ...presentation, fromSubagent: true };
	if (presentation.requestKind === "claude_tool") {
		if (mcpSlot) {
			// Lookalike text in either name is not approvable: the names are what a person reads the call by.
			const checks = { split: "segments" } as const;
			presentation = {
				...presentation,
				mcp: {
					server: cleanField(mcpSlot.server, 128, findings, checks) ?? "",
					tool: cleanField(mcpSlot.tool, 256, findings, checks) ?? "",
					rawToolName: cleanField(mcpSlot.rawToolName, 512, findings, checks) ?? "",
				},
			};
		}
		if (report.agent) {
			const subagentType = cleanField(report.agent.subagentType, 64, findings) ?? "";
			// The prompt is what the helper is told: shown whole and checked like a command, so nothing hides in it.
			const prompt =
				cleanField(report.agent.prompt, AGENT_PROMPT_MAX_CHARS, findings, {
					truncated,
					split: "whitespace",
					approvableMax: CODEX_APPROVAL_LIMITS.approvableCommandChars,
				}) ?? "";
			if (isBlank(prompt)) reasons.add("no_command");
			// The server decides what ships with Claude Code; the host's word is not taken for it.
			if (report.agent.builtIn !== true || !isBuiltInAgentType(subagentType)) {
				reasons.add("custom_agent");
			}
			// A helper's own Agent call is a nested spawn, whatever the host called it.
			if (report.fromSubagent === true) reasons.add("nested_agent");
			presentation = {
				...presentation,
				agent: {
					subagentType,
					prompt,
					builtIn: report.agent.builtIn === true && isBuiltInAgentType(subagentType),
				},
			};
		}
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
	return cutTextTail(tail, maxChars);
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

/**
 * For each changed file, in order: whether it (or the place it moves to) is outside the working
 * directory. Not part of the presentation, so not part of its hash: the detail carries it beside it.
 */
export function changesOutsideCwd(presentation: CodexApprovalFileChangePresentation): boolean[] {
	const cwd = presentation.cwd;
	return presentation.changes.map(
		(change) =>
			cwd === null ||
			!isInside(change.path, cwd) ||
			(change.movePath !== null && !isInside(change.movePath, cwd)),
	);
}

// ── files Claude sessions load later with no card ───────────────────────────

/**
 * Instruction and configuration files a later Claude session reads or runs: its project and user instructions,
 * `.claude/` settings, hooks and skills, the MCP config, git hooks and the shell's startup files. Matched on the
 * path as written (the host has already refused one that is a link elsewhere), case-insensitively, at the end of
 * the name: `CLAUDE.md.bak` is not one.
 */
const AGENT_CONFIG_PATH_RES: readonly RegExp[] = [
	/(^|\/)(claude|agents)\.md$/i,
	/(^|\/)\.claude(\/|$)/i,
	/(^|\/)\.mcp\.json$/i,
	/(^|\/)\.git\/hooks(\/|$)/i,
	/(^|\/)\.git\/config$/i,
	/(^|\/)\.(gitmodules|gitconfig|npmrc|envrc)$/i,
	/(^|\/)\.husky(\/|$)/i,
	/(^|\/)\.ssh(\/|$)/i,
	/(^|\/)\.(bash_profile|bashrc|profile|zprofile|zshenv|zshrc|zlogin|zlogout)$/i,
];

export function pathIsAgentConfig(path: string): boolean {
	return AGENT_CONFIG_PATH_RES.some((re) => re.test(path.trim()));
}

/** A Bash command whose text names one of those files. The text isn't parsed: a variable or a `cd` gets past this. */
export function commandNamesAgentConfig(command: string): boolean {
	return command
		.split(/[\s'"`;|&<>()=]+/)
		.some(
			(token) => token !== "" && (pathIsAgentConfig(token) || /^~\/\.claude(\/|$)/i.test(token)),
		);
}

/** Whether this request writes, or a command names, an agent-config file. Beside the presentation, not in its hash. */
export function touchesAgentConfig(presentation: CodexApprovalPresentation): boolean {
	switch (presentation.requestKind) {
		case "file_change":
			return presentation.changes.some(
				(change) => pathIsAgentConfig(change.path) || pathIsAgentConfig(change.movePath ?? ""),
			);
		case "command":
			return commandNamesAgentConfig(presentation.command ?? "");
		default:
			return false;
	}
}

/** The list-sized view of a presentation: bounded to 4 KiB, no full diff. */
export function buildPreview(presentation: CodexApprovalPresentation): CodexApprovalPreview {
	const preview = buildPreviewBody(presentation);
	// A subagent's request says so in the list too, where the card's heading and the announcement are built.
	return presentation.fromSubagent === true ? { ...preview, fromSubagent: true } : preview;
}

function buildPreviewBody(presentation: CodexApprovalPresentation): CodexApprovalPreview {
	if (presentation.requestKind === "claude_tool" && presentation.mcp) {
		// The list names the call as `server/tool` (the server's own split; neither part holds a slash), never
		// the input, which is only in the detail a person opens before answering.
		const { server, tool } = presentation.mcp;
		return {
			cwd: presentation.cwd,
			tool: "mcp",
			target: `${server}/${tool}`,
			pathOutsideCwd: false,
			nonAscii: NON_ASCII_RE.test(server) || NON_ASCII_RE.test(tool),
		};
	}
	if (presentation.requestKind === "claude_tool") {
		const target = presentation.target ?? "";
		return {
			cwd: presentation.cwd,
			tool: presentation.tool,
			target: cutText(target, 300),
			pathOutsideCwd: presentation.tool === "Read",
			nonAscii: NON_ASCII_RE.test(target) || NON_ASCII_RE.test(presentation.cwd ?? ""),
		};
	}
	if (presentation.requestKind === "command") {
		const command = presentation.command ?? "";
		const head = cutText(command, 1200);
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
		.map((change) => ({ path: cutText(change.path, 300), kind: change.kind }));
	const outside = changesOutsideCwd(presentation).some(Boolean);
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
