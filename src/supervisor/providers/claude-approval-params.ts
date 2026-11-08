/**
 * What a takeover fork's `can_use_tool` request says, read through the allowlists in
 * `shared/claude-approvals.ts` (AGEN-117 T9). The shape matches what the Codex parser returns, so one
 * tracker holds both. The file system is read through a small port so a test can drive "the file exists",
 * "it doesn't" and "the check failed" without a disk.
 *
 * Nothing here decides approvability for a person: it finds the reasons a request can only be declined that
 * only the host can know (a link, the memory directory, a tool nobody listed, an input that can't be echoed
 * unchanged) and builds the report the server turns into the text a person is shown. The server judges the
 * text itself (redaction, lookalikes, length) and is the authority on whether Approve is offered.
 *
 * No text from a request is put into a log line or a warning.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
	CLAUDE_APPROVAL_TOOLS,
	CLAUDE_REQUEST_META_KEYS,
	CLAUDE_TOOL_INPUT_TREATMENTS,
	type ClaudeApprovalTool,
	commandNamesAgentMemory,
	isAgentMemoryPath,
} from "../../shared/claude-approvals.js";
import {
	FORK_MCP_INPUT_MAX_CHARS,
	forkMcpInputText,
	splitForkMcpToolName,
} from "../../shared/claude-fork-mcp.js";
import {
	CODEX_APPROVAL_LIMITS,
	type CodexApprovalChange,
	type CodexApprovalReportRequest,
	type NotApprovableReason,
} from "../../shared/codex-approvals.js";
import type { AppliedForkOptions } from "../../shared/session-resume.js";
import { claudeToolKind } from "./claude-fork-tools.js";
import type { BufferedChange, ParsedApproval } from "./codex-approval-params.js";

const ID_MAX = 128;

export type ClaudeFsPort = {
	/** The path with every link resolved; throws when it doesn't exist. */
	realpath(path: string): string;
	/** `"yes"`, `"no"`, or `"error"` when the check itself failed (anything but "not found"). */
	exists(path: string): "yes" | "no" | "error";
	/** The path itself (not what it points at) is a symbolic link, whether or not the target can be found. */
	isSymlink(path: string): boolean;
};

export const REAL_FS: ClaudeFsPort = {
	realpath: (path) => realpathSync(path),
	exists: (path) => {
		try {
			lstatSync(path);
			return "yes";
		} catch (error) {
			return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "no" : "error";
		}
	},
	isSymlink: (path) => {
		try {
			return lstatSync(path).isSymbolicLink();
		} catch {
			return false;
		}
	},
};

export type ClaudeParseContext = {
	/** The fork's session id (the row's thread). */
	threadId: string;
	/** The running prompt's action id (the row's turn). */
	turnId: string;
	/** The directory the fork was started in: supervisor-proved, not anything the request says. */
	cwd: string;
	/** Where Claude keeps its projects; null when it can't be found (then memory writes can't be recognised). */
	configDir: string | null;
	/** The input's JSON text occurs in the raw line unchanged (the wire checks it). */
	inputStable: boolean;
	/** What the fork was started with; decides which tool names are known. Absent: no options. */
	applied?: AppliedForkOptions;
	fs?: ClaudeFsPort;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= ID_MAX ? value : null;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * `path` with links resolved as far as it exists: the deepest existing ancestor is resolved and the rest is
 * appended. A path that doesn't exist yet (a new file) therefore still shows where it would land. `broken` is
 * true when something on the way is a link whose target can't be resolved (dangling, or a loop): where the
 * path really lands is then unknown, which the caller treats as a link to somewhere else.
 */
export function resolveThroughLinksChecked(
	path: string,
	port: ClaudeFsPort,
): { real: string; broken: boolean } {
	let current = resolvePath(path);
	const rest: string[] = [];
	let broken = false;
	for (let depth = 0; depth < 4096; depth++) {
		try {
			const real = port.realpath(current);
			return { real: rest.length === 0 ? real : join(real, ...rest.reverse()), broken };
		} catch {
			if (port.isSymlink(current)) broken = true;
			const parent = dirname(current);
			if (parent === current) return { real: resolvePath(path), broken };
			rest.push(current.slice(parent.length === 1 ? 1 : parent.length + 1));
			current = parent;
		}
	}
	return { real: resolvePath(path), broken: true };
}

export function resolveThroughLinks(path: string, port: ClaudeFsPort): string {
	return resolveThroughLinksChecked(path, port).real;
}

/** The lines of an Edit shown as removed and added, under a header that says where it applies. */
export function editDiff(oldText: string, newText: string, replaceAll: boolean): string {
	const header = replaceAll
		? "@@ replaces every match in the file @@"
		: "@@ replaces this text where it matches; positions aren't known @@";
	const removed = oldText.split("\n").map((line) => `-${line}`);
	const added = newText.split("\n").map((line) => `+${line}`);
	return [header, ...removed, ...added].join("\n");
}

export function notebookDiff(
	cellId: string | null,
	cellType: string | null,
	editMode: string | null,
	newSource: string,
): string {
	const mode = editMode ?? "replace";
	const where = cellId === null ? "" : ` cell ${cellId}`;
	const type = cellType === null ? "" : ` (${cellType})`;
	const header = `@@ ${mode}${where}${type} @@`;
	return mode === "delete"
		? header
		: [header, ...newSource.split("\n").map((line) => `+${line}`)].join("\n");
}

/**
 * Reads one request. Null when it can't be reported at all (no tool name, tool-use id or object input, or an
 * id past the bound the server stores); the caller then declines it. Otherwise `declineOnly` is empty only
 * for a request that is fully understood.
 */
export function parseClaudeRequest(
	params: unknown,
	ctx: ClaudeParseContext,
): ParsedApproval | null {
	if (!isRecord(params)) return null;
	const toolName = text(params.tool_name);
	const itemId = idOf(params.tool_use_id);
	const threadId = idOf(ctx.threadId);
	const turnId = idOf(ctx.turnId);
	if (!toolName || !itemId || !threadId || !turnId || !isRecord(params.input)) return null;
	const input = params.input;
	const port = ctx.fs ?? REAL_FS;
	const reasons = new Set<NotApprovableReason>();

	if (!ctx.inputStable) reasons.add("input_not_stable");
	if (params.requires_user_interaction === true) reasons.add("requires_interaction");
	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined) continue;
		if (!CLAUDE_REQUEST_META_KEYS.includes(key)) reasons.add("unknown_param");
	}

	const kind = claudeToolKind(toolName, ctx.applied);
	const isMcp = kind === "mcp";
	const known = kind !== null && (CLAUDE_APPROVAL_TOOLS as readonly string[]).includes(kind);
	const treatments = known
		? CLAUDE_TOOL_INPUT_TREATMENTS[toolName as ClaudeApprovalTool]
		: undefined;
	if (!isMcp && (!known || !treatments)) reasons.add("unknown_tool");
	// An MCP tool's input is the server's own schema: any object is shown whole, and nothing in it is interpreted.
	for (const [key, value] of Object.entries(isMcp ? {} : input)) {
		if (value === null || value === undefined) continue;
		const treatment = treatments && Object.hasOwn(treatments, key) ? treatments[key] : undefined;
		if (treatment === undefined) reasons.add("unknown_param");
		else if (treatment === "decline_if_set" && value !== false) reasons.add("unknown_param");
	}

	const blockedPath = text(params.blocked_path);
	const base = {
		threadId,
		turnId,
		itemId,
		providerApprovalId: null,
		grantRoot: null,
	};
	const extras = (
		tool: string,
		target: string | null,
		changes: BufferedChange[],
		excludePaths: string[],
	) => ({
		tool,
		target,
		blockedPath,
		changes,
		input,
		excludePaths: [ctx.cwd, ...(blockedPath ? [blockedPath] : []), ...excludePaths],
	});

	/** Where a file path in the input really points; a link to somewhere else is decline-only. */
	const judgePath = (rawPath: string): { abs: string; real: string; paths: string[] } => {
		// Which file a relative or `~` path means depends on the directory Claude is in, which can have moved from
		// the one the fork started in (a `cd`): never approvable. It is still judged against the start directory.
		if (!isAbsolute(rawPath) || rawPath.startsWith("~")) reasons.add("path_not_absolute");
		const abs = resolvePath(ctx.cwd, rawPath);
		const { real, broken } = resolveThroughLinksChecked(abs, port);
		if (real !== abs || broken || port.isSymlink(abs)) reasons.add("symlink_target");
		return { abs, real, paths: real === abs ? [abs] : [abs, real] };
	};
	const guardMemory = (real: string) => {
		// With no config directory known, a path that looks like Claude's memory or home counts as memory.
		const named =
			ctx.configDir !== null
				? isAgentMemoryPath(real, ctx.configDir)
				: /\/projects\/[^/]+\/memory(\/|$)/i.test(real) || /\/\.claude(\/|$)/i.test(real);
		if (named) reasons.add("agent_memory");
	};

	if (isMcp) {
		// The split is made against the applied servers' names, which hold no underscore, so it is unique.
		const split = splitForkMcpToolName(
			toolName,
			(ctx.applied?.mcpServers ?? []).map((s) => s.name),
		);
		if (split === null) {
			reasons.add("unknown_param");
		}
		// Claude names the server it is calling; a name that disagrees with the split, or a server that isn't
		// one of ours (a plugin, an account connector), is never approvable (xander M3).
		const named = isRecord(params.mcp_server) ? params.mcp_server : null;
		if (
			!split ||
			named === null ||
			named.name !== split.server ||
			named.source !== "dynamic" ||
			Object.keys(named).some((k) => k !== "name" && k !== "source")
		) {
			reasons.add("unknown_param");
		}
		const inputText = forkMcpInputText(input);
		if (inputText.length > FORK_MCP_INPUT_MAX_CHARS) reasons.add("too_long");
		return {
			kind: "claude_tool",
			...base,
			command: null,
			cwd: ctx.cwd,
			reason: null,
			declineOnly: [...reasons],
			claude: {
				...extras(toolName, inputText, [], []),
				...(split ? { mcp: split } : {}),
			},
		};
	}

	switch (toolName) {
		case "Bash": {
			const command = text(input.command);
			if (command !== null && commandNamesAgentMemory(command, ctx.configDir ?? "")) {
				reasons.add("agent_memory");
			}
			return {
				kind: "command",
				...base,
				command,
				cwd: ctx.cwd,
				reason: text(input.description),
				declineOnly: [...reasons],
				claude: extras("Bash", null, [], []),
			};
		}
		case "Write": {
			const path = text(input.file_path);
			const content = text(input.content);
			if (path === null || path === "" || content === null) return null;
			const { abs, real, paths } = judgePath(path);
			guardMemory(real);
			const existence = port.exists(abs);
			const kind = existence === "yes" ? "write" : existence === "no" ? "add" : "write_unchecked";
			return {
				kind: "file_change",
				...base,
				command: null,
				cwd: ctx.cwd,
				reason: null,
				declineOnly: [...reasons],
				claude: extras("Write", null, [{ path: abs, kind, movePath: null, diff: content }], paths),
			};
		}
		case "Edit": {
			const path = text(input.file_path);
			const oldText = text(input.old_string);
			const newText = text(input.new_string);
			if (path === null || path === "" || oldText === null || newText === null) return null;
			const { abs, real, paths } = judgePath(path);
			guardMemory(real);
			const diff = editDiff(oldText, newText, input.replace_all === true);
			return {
				kind: "file_change",
				...base,
				command: null,
				cwd: ctx.cwd,
				reason: null,
				declineOnly: [...reasons],
				claude: extras("Edit", null, [{ path: abs, kind: "update", movePath: null, diff }], paths),
			};
		}
		case "NotebookEdit": {
			const path = text(input.notebook_path);
			const editMode = text(input.edit_mode);
			// A deleted cell has no new source, and none is shown as added lines.
			const source = editMode === "delete" ? "" : text(input.new_source);
			if (path === null || path === "" || source === null) return null;
			const { abs, real, paths } = judgePath(path);
			guardMemory(real);
			const diff = notebookDiff(text(input.cell_id), text(input.cell_type), editMode, source);
			return {
				kind: "file_change",
				...base,
				command: null,
				cwd: ctx.cwd,
				reason: null,
				declineOnly: [...reasons],
				claude: extras(
					"NotebookEdit",
					null,
					[{ path: abs, kind: "update", movePath: null, diff }],
					paths,
				),
			};
		}
		case "WebFetch": {
			const url = text(input.url);
			if (url === null || url === "") return null;
			return {
				kind: "claude_tool",
				...base,
				command: null,
				cwd: ctx.cwd,
				reason: text(input.prompt),
				declineOnly: [...reasons],
				claude: extras("WebFetch", url, [], []),
			};
		}
		case "Read": {
			const path = text(input.file_path);
			if (path === null || path === "") return null;
			const { abs, paths } = judgePath(path);
			return {
				kind: "claude_tool",
				...base,
				command: null,
				cwd: ctx.cwd,
				reason: null,
				declineOnly: [...reasons],
				claude: extras("Read", abs, [], paths),
			};
		}
		default:
			// A tool outside the six: reported decline-only so a person sees that it was asked for and why it can't be approved.
			return {
				kind: "command",
				...base,
				command: null,
				cwd: ctx.cwd,
				reason: null,
				declineOnly: [...reasons],
				claude: extras("unknown", null, [], []),
			};
	}
}

const cut = (value: string, max: number): { text: string; cut: boolean } =>
	value.length > max ? { text: value.slice(0, max), cut: true } : { text: value, cut: false };

export type ClaudeReportInputs = {
	runtimeEpoch: string;
	rpcId: string;
	parsed: ParsedApproval;
	ageMs: number;
	revision: number;
};

/** The report body, within the bounds the server enforces; a field past its bound is cut and the report says so. */
export function buildClaudeReportBody(input: ClaudeReportInputs): CodexApprovalReportRequest {
	const { parsed } = input;
	const claude = parsed.claude;
	const limits = CODEX_APPROVAL_LIMITS;
	let truncated = false;
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
		providerApprovalId: null,
		ageMs: input.ageMs,
		revision: input.revision,
	};
	const reason = parsed.reason === null ? null : note(cut(parsed.reason, limits.reasonChars));
	const cwd = parsed.cwd === null ? null : note(cut(parsed.cwd, limits.pathChars));
	const declineOnly = [...parsed.declineOnly];

	if (parsed.kind === "command") {
		return {
			...base,
			command: parsed.command === null ? null : note(cut(parsed.command, limits.command)),
			cwd,
			reason,
			grantRoot: null,
			blockedPath: claude?.blockedPath ? note(cut(claude.blockedPath, limits.pathChars)) : null,
			truncated,
			declineOnly,
		};
	}
	if (parsed.kind === "claude_tool") {
		return {
			...base,
			tool: claude?.tool ?? null,
			// An MCP call's target is its input as JSON, which has the command's bound, not a path's.
			target: claude?.target
				? note(cut(claude.target, claude.mcp ? limits.command : limits.pathChars))
				: null,
			cwd,
			reason,
			grantRoot: null,
			truncated,
			declineOnly,
			...(claude?.mcp ? { mcp: claude.mcp } : {}),
		};
	}
	const changes: CodexApprovalChange[] = [];
	let diffBudget: number = limits.totalDiff;
	for (const change of (claude?.changes ?? []).slice(0, limits.files)) {
		const diff = cut(change.diff, Math.max(0, diffBudget));
		diffBudget -= diff.text.length;
		changes.push({
			path: note(cut(change.path, limits.pathChars)),
			kind: change.kind,
			movePath: null,
			diff: note(diff),
		});
	}
	return { ...base, cwd, reason, grantRoot: null, changes, truncated, declineOnly };
}
