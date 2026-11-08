/**
 * What an approval request from Codex says, read through the parameter allowlist (AGEN-87, D5). Pure: no
 * I/O, no clock. A request is never approvable by default; every parameter either has a treatment in the
 * shared tables or, with a non-null value, makes the request decline-only `unknown_param`, so a Codex
 * that starts sending something new is noticed instead of shown as if it were understood.
 *
 * Nothing here decides anything about a person's answer; it only reads the request and builds the report
 * body the server stores, with the bounds the server also enforces.
 */
import {
	type ApprovalParamTreatment,
	type ApprovalRequestKind,
	CODEX_APPROVAL_LIMITS,
	COMMAND_APPROVAL_PARAMS,
	type CodexApprovalChange,
	type CodexApprovalReportRequest,
	FILE_CHANGE_APPROVAL_PARAMS,
	type NotApprovableReason,
} from "../../shared/codex-approvals.js";

export const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
export const FILE_CHANGE_APPROVAL_METHOD = "item/fileChange/requestApproval";

/** The value of `environmentId` for a command run on this machine (measured, S17). */
const LOCAL_ENVIRONMENT_ID = "local";
/** Ids are stored in bounded columns; one longer than this can't be reported at all. */
const ID_MAX = 128;

export interface ParsedApproval {
	kind: ApprovalRequestKind;
	threadId: string;
	turnId: string;
	itemId: string;
	providerApprovalId: string | null;
	command: string | null;
	cwd: string | null;
	reason: string | null;
	grantRoot: string | null;
	/** Why this request can be declined here but never approved, in the order found. */
	declineOnly: NotApprovableReason[];
	/** A takeover fork's request (AGEN-117): absent for Codex. Read only by the Claude dialect. */
	claude?: ClaudeParsedExtras;
}

/** What a Claude `can_use_tool` request carries beyond the Codex-shaped fields. */
export interface ClaudeParsedExtras {
	tool: string;
	/** A `claude_tool` request's URL or path; for an MCP tool call (AGEN-121), the input as JSON text. */
	target: string | null;
	/** An MCP tool call (AGEN-121): the server, the tool and the wire name, split against the applied servers. */
	mcp?: { server: string; tool: string; rawToolName: string };
	/** A Bash request's `blocked_path`, as given. */
	blockedPath: string | null;
	/** The edits a Write, Edit or NotebookEdit makes, built from the input (never from the model's description). */
	changes: BufferedChange[];
	/** The held input, echoed unchanged as `updatedInput` when a person accepts. */
	input: Record<string, unknown>;
	/** Every path the exclude rules must judge: the directory, the named path and where it really points. */
	excludePaths: string[];
	/** The request came from a subagent of the turn (`agent_id` on the request). Absent otherwise. */
	fromSubagent?: boolean;
	/** The Agent call (AGEN-120): the helper it would start. `builtIn` is the host's judgement; the server recomputes it. */
	agent?: { subagentType: string; prompt: string; builtIn: boolean };
}

/** One changed file as Codex's `fileChange` item states it. */
export interface BufferedChange {
	path: string;
	kind: string;
	movePath: string | null;
	diff: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= ID_MAX ? value : null;

function treatmentFor(kind: ApprovalRequestKind, key: string): ApprovalParamTreatment | undefined {
	const table = kind === "command" ? COMMAND_APPROVAL_PARAMS : FILE_CHANGE_APPROVAL_PARAMS;
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** True when a plain `accept` is among the decisions Codex says it offers. */
function offersPlainAccept(available: unknown): boolean {
	return Array.isArray(available) && available.includes("accept");
}

/**
 * Reads a request's parameters. Null when the request can't be reported at all (a missing or oversize
 * thread, turn or item id); the caller then declines it. Otherwise the returned `declineOnly` is empty
 * only for a request that is fully understood.
 */
export function parseApprovalParams(method: string, params: unknown): ParsedApproval | null {
	const kind: ApprovalRequestKind | null =
		method === COMMAND_APPROVAL_METHOD
			? "command"
			: method === FILE_CHANGE_APPROVAL_METHOD
				? "file_change"
				: null;
	if (!kind || !isRecord(params)) return null;
	const threadId = idOf(params.threadId);
	const turnId = idOf(params.turnId);
	const itemId = idOf(params.itemId);
	if (!threadId || !turnId || !itemId) return null;

	const reasons = new Set<NotApprovableReason>();
	let providerApprovalId: string | null = null;
	let command: string | null = null;
	let cwd: string | null = null;
	let reason: string | null = null;
	let grantRoot: string | null = null;

	for (const [key, value] of Object.entries(params)) {
		const treatment = treatmentFor(kind, key);
		if (treatment === undefined) {
			if (value !== null && value !== undefined) reasons.add("unknown_param");
			continue;
		}
		switch (treatment) {
			case "shown":
				if (key === "command") command = typeof value === "string" ? value : null;
				else if (key === "cwd") cwd = typeof value === "string" ? value : null;
				else if (key === "reason") reason = typeof value === "string" ? value : null;
				break;
			case "metadata":
				if (key === "approvalId") {
					if (value === null || value === undefined) providerApprovalId = null;
					else if (idOf(value)) providerApprovalId = value as string;
					else reasons.add("unknown_param");
				}
				break;
			case "available_decisions":
				break;
			case "ignored":
				break;
			case "environment":
				if (value !== null && value !== undefined && value !== LOCAL_ENVIRONMENT_ID) {
					reasons.add("unknown_param");
				}
				break;
			case "kind":
				if (value === "writeStdin") reasons.add("write_stdin");
				else if (value !== undefined && value !== null && value !== "command") {
					reasons.add("unknown_param");
				}
				break;
			case "network":
				if (value !== null && value !== undefined) reasons.add("network");
				break;
			case "grant_root":
				if (value !== null && value !== undefined) {
					reasons.add("grant_root");
					grantRoot = typeof value === "string" ? value : null;
				}
				break;
			case "decline_if_set":
				if (value !== null && value !== undefined) reasons.add("unknown_param");
				break;
		}
	}

	if (kind === "command") {
		if (command === null || command.trim() === "") reasons.add("no_command");
		if (cwd === null || cwd.trim() === "") reasons.add("no_cwd");
		// Fail closed: a command whose offered decisions don't include a plain accept (or say nothing)
		// is never approvable here.
		if (!offersPlainAccept(params.availableDecisions)) reasons.add("accept_not_offered");
	}

	return {
		kind,
		threadId,
		turnId,
		itemId,
		providerApprovalId,
		command,
		cwd,
		reason,
		grantRoot,
		declineOnly: [...reasons],
	};
}

/**
 * The changes of a `fileChange` thread item (or a `patchUpdated` notification), as the person will see
 * them. Null when any entry isn't the documented shape: a diff that can't be read in full is no diff.
 */
export function readFileChanges(changes: unknown): BufferedChange[] | null {
	if (!Array.isArray(changes)) return null;
	const out: BufferedChange[] = [];
	for (const entry of changes) {
		if (!isRecord(entry)) return null;
		if (typeof entry.path !== "string" || typeof entry.diff !== "string") return null;
		const kind = entry.kind;
		if (!isRecord(kind) || typeof kind.type !== "string") return null;
		const movePath = kind.move_path;
		if (movePath !== undefined && movePath !== null && typeof movePath !== "string") return null;
		out.push({
			path: entry.path,
			kind: kind.type,
			movePath: typeof movePath === "string" ? movePath : null,
			diff: entry.diff,
		});
	}
	return out;
}

const sameChanges = (a: readonly BufferedChange[], b: readonly BufferedChange[]) =>
	JSON.stringify(a) === JSON.stringify(b);

export { sameChanges };

const cut = (text: string, max: number): { text: string; cut: boolean } =>
	text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };

export interface ReportInputs {
	runtimeEpoch: string;
	rpcId: string;
	parsed: ParsedApproval;
	/** The thread's own directory for a file change (its request names none); a command names its own. */
	fallbackCwd: string | null;
	changes: readonly BufferedChange[] | null;
	ageMs: number;
	revision: number;
}

/** The report body, within the same bounds the server enforces; a field over its bound is cut and the report says so. */
export function buildReportBody(input: ReportInputs): CodexApprovalReportRequest {
	const { parsed } = input;
	const limits = CODEX_APPROVAL_LIMITS;
	let truncated = false;
	const declineOnly = [...parsed.declineOnly];
	const note = (result: { text: string; cut: boolean }) => {
		if (result.cut) truncated = true;
		return result.text;
	};

	const base = {
		v: 1 as const,
		runtimeEpoch: input.runtimeEpoch,
		rpcId: input.rpcId,
		requestKind: parsed.kind,
		threadId: parsed.threadId,
		turnId: parsed.turnId,
		itemId: parsed.itemId,
		providerApprovalId: parsed.providerApprovalId,
		ageMs: input.ageMs,
		revision: input.revision,
	};
	const reason = parsed.reason === null ? null : note(cut(parsed.reason, limits.reasonChars));
	const grantRoot =
		parsed.grantRoot === null ? null : note(cut(parsed.grantRoot, limits.pathChars));

	if (parsed.kind === "command") {
		return {
			...base,
			command: parsed.command === null ? null : note(cut(parsed.command, limits.command)),
			cwd: parsed.cwd === null ? null : note(cut(parsed.cwd, limits.pathChars)),
			reason,
			grantRoot,
			truncated,
			declineOnly,
		};
	}

	const changes: CodexApprovalChange[] = [];
	let diffBudget = limits.totalDiff;
	const source = input.changes ?? [];
	if (source.length > limits.files) truncated = true;
	for (const change of source.slice(0, limits.files)) {
		const diff = cut(change.diff, Math.max(0, diffBudget));
		diffBudget -= diff.text.length;
		changes.push({
			path: note(cut(change.path, limits.pathChars)),
			kind: change.kind,
			movePath: change.movePath === null ? null : note(cut(change.movePath, limits.pathChars)),
			diff: note(diff),
		});
	}
	if (input.changes === null || source.length === 0) {
		if (!declineOnly.includes("no_diff")) declineOnly.push("no_diff");
	}
	return {
		...base,
		cwd: input.fallbackCwd === null ? null : note(cut(input.fallbackCwd, limits.pathChars)),
		reason,
		grantRoot,
		changes,
		truncated,
		declineOnly,
	};
}
