/**
 * The typed record of one fork tool call (AGEN-119..123 Track 0, S1). The turn's rows and the owner-only
 * detail both read it; the `detail*` fields hold what the call ran and never leave this process in a row, an
 * event, a log line or a report (T123's leak guards scan for these names and nothing sends them in Track 0).
 *
 * `detailVerdict` is decided once, when the `tool_use` block arrives, from the intact structured input: the
 * typed path fields resolved through links and judged by the exclude rules the gate holds at that moment, or
 * for Bash and MCP the intact command or input text. A parse failure, a path that isn't a string, a path that
 * can't be resolved and invalid rules all give `withhold`. Nothing later re-derives it from transported text,
 * so the 64 KiB transport cut of the result can never change it (F56).
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { FORK_AGENT_TOOL, MCP_TOOL_PREFIX } from "../../shared/claude-fork-copy.js";

export type DetailVerdict = "send" | "withhold";

/** The paths a call's typed input names. `null` when a path field is present but is not a string. */
export type DetailPaths = { filePath?: string; notebookPath?: string };

/** What the stream showed about one tool call in a turn. */
export type ToolCallRecord = {
	toolUseId: string;
	/** The name as the model wrote it; only printed when it is one of the six. */
	name: string;
	/** A `can_use_tool` request arrived for this call. */
	requested: boolean;
	/** What was written back to Claude for the request, or null (none yet, or none at all). */
	answer: "allow" | "deny" | null;
	/** The tracker saw something else decide first; the call may have run. */
	decidedElsewhere: boolean;
	/** The host declined it itself because it could not be shown to a person: nobody was asked. */
	declinedLocally: boolean;
	/** The tool_result arrived. */
	resulted: boolean;
	isError: boolean;
	/** `tool_result_meta[].non_execution_kind`, when the harness refused to run the call. */
	nonExecutionKind: string | null;
	/** `tool_result_meta[].permission_decision.source`. */
	decisionSource: string | null;
	/** The parsed `input`, held in memory and never cut. */
	detailInput: unknown;
	detailPaths: DetailPaths | null;
	/** The result text up to `DETAIL_RESULT_CAP_BYTES`, cut at a code point. */
	detailResult: string | null;
	/** The result's size before that cut, so a truncation is known. */
	detailResultBytes: number;
	/** The control action of the turn the call belongs to; null until the stream knows it. */
	turnActionId: string | null;
	/** The subagent that made the call, or null for the fork's own. */
	agentId: string | null;
	parentToolUseId: string | null;
	/** Decided from the intact input when the call was recorded; `withhold` until that finishes. */
	detailVerdict: DetailVerdict;
	/** The result is kept off the report: it names a rule path, or a helper's call was not judged `send` (review M2). */
	detailOutputWithheld: boolean;
};

/** The host transport cap on a result held for detail. */
export const DETAIL_RESULT_CAP_BYTES = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

export function newToolCallRecord(
	base: Pick<ToolCallRecord, "toolUseId" | "name"> & Partial<ToolCallRecord>,
): ToolCallRecord {
	return {
		requested: false,
		answer: null,
		decidedElsewhere: false,
		declinedLocally: false,
		resulted: false,
		isError: false,
		nonExecutionKind: null,
		decisionSource: null,
		detailInput: undefined,
		detailPaths: {},
		detailResult: null,
		detailResultBytes: 0,
		turnActionId: null,
		agentId: null,
		parentToolUseId: null,
		detailVerdict: "withhold",
		detailOutputWithheld: false,
		...base,
	};
}

/** The typed path fields of an input. `null` when one is present and not a string. */
export function detailPathsOf(input: unknown): DetailPaths | null {
	if (!isRecord(input)) return {};
	const out: DetailPaths = {};
	if ("file_path" in input) {
		if (typeof input.file_path !== "string") return null;
		out.filePath = input.file_path;
	}
	if ("notebook_path" in input) {
		if (typeof input.notebook_path !== "string") return null;
		out.notebookPath = input.notebook_path;
	}
	return out;
}

/** A result text cut to the transport cap at a code point, with the size it had. */
export function cutDetailResult(text: string | null): { text: string | null; bytes: number } {
	if (text === null) return { text: null, bytes: 0 };
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= DETAIL_RESULT_CAP_BYTES) return { text, bytes: encoded.length };
	let end = DETAIL_RESULT_CAP_BYTES;
	// Back up off a continuation byte so the cut lands on a code point.
	while (end > 0 && ((encoded[end] as number) & 0xc0) === 0x80) end--;
	return { text: new TextDecoder().decode(encoded.subarray(0, end)), bytes: encoded.length };
}

// ---- the verdict ----

/** What the gate says about the rules at this moment. */
export type ExcludeScope =
	| { state: "none" }
	| { state: "invalid" }
	| { state: "ok"; paths: readonly string[] };

export interface DetailJudgeDeps {
	/** The fork's working directory (proved at takeover). */
	cwd: string;
	excludesPath(path: string): boolean;
	excludeScope(): ExcludeScope;
	/** Test seam; defaults to `fs.promises.realpath`. */
	realpath?: (path: string) => Promise<string>;
}

export type DetailJudge = (name: string, input: unknown) => Promise<DetailVerdict>;

/** Realpath of the deepest existing ancestor, with the not-yet-existing tail appended. */
async function resolveThroughExisting(
	path: string,
	real: (p: string) => Promise<string>,
): Promise<string> {
	let tail = "";
	let current = path;
	for (let i = 0; i < 64; i++) {
		try {
			const resolved = await real(current);
			return tail === "" ? resolved : join(resolved, tail);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			tail =
				tail === ""
					? current.slice(parent.length + 1)
					: join(current.slice(parent.length + 1), tail);
			current = parent;
		}
	}
	throw new Error("path too deep");
}

/**
 * The ways a command or an input can name a rule's path: absolute, relative to the working directory, and
 * under the home directory as `~/` or `$HOME`. A route the text doesn't name (a variable of another name,
 * a glob) is the stated residual.
 */
function namingsOfRule(rulePath: string, dir: string): string[] {
	const forms = [rulePath];
	const rel = relative(dir, rulePath);
	if (rel !== "" && !isAbsolute(rel)) forms.push(rel);
	const home = homedir();
	if (home && rulePath.startsWith(`${home}/`)) {
		const tail = rulePath.slice(home.length);
		forms.push(`~${tail}`, `$HOME${tail}`, `\${HOME}${tail}`);
	}
	return forms;
}

/**
 * The path a tool input names, with a leading `~`, `$HOME` or `${HOME}` expanded the way a shell would, before
 * it is resolved against the working directory (`~/x` is not `<cwd>/~/x`). `~user` can't be resolved here, so
 * it is `null` and the call is withheld.
 */
export function expandHomePath(raw: string, home: string = homedir()): string | null {
	if (raw === "~" || raw.startsWith("~/")) return home === "" ? null : join(home, raw.slice(1));
	if (raw.startsWith("~")) return null;
	const match = /^\$(?:\{HOME\}|HOME)(?=\/|$)/.exec(raw);
	if (match) return home === "" ? null : join(home, raw.slice(match[0].length));
	return raw;
}

/** Whether a result's text names any rule path, in the forms a command can write it (absolute, relative, `~`, `$HOME`). */
export function outputNamesRulePath(text: string, scope: ExcludeScope, dir: string): boolean {
	if (scope.state === "none") return false;
	if (scope.state === "invalid") return true;
	return scope.paths.some((rulePath) =>
		namingsOfRule(rulePath, dir).some((form) => text.includes(form)),
	);
}

export interface OutputGuardDeps {
	cwd: string;
	excludeScope(): ExcludeScope;
}

/**
 * Whether a call's result must stay off the report: a Bash, Agent or MCP result that names a rule path (the
 * command was judged on its text, and what it printed was not), under rules that are invalid, or any result
 * under a working directory the rules cover. Never throws; a failure is `true`.
 */
export function createOutputGuard(deps: OutputGuardDeps): (call: ToolCallRecord) => boolean {
	return (call) => {
		try {
			if (call.detailResult === null) return false;
			if (
				!(
					call.name === "Bash" ||
					call.name === FORK_AGENT_TOOL ||
					call.name.startsWith(MCP_TOOL_PREFIX)
				)
			) {
				return false;
			}
			return outputNamesRulePath(call.detailResult, deps.excludeScope(), deps.cwd);
		} catch {
			return true;
		}
	};
}

const PATH_TOOLS: Record<string, "file_path" | "notebook_path"> = {
	Read: "file_path",
	Write: "file_path",
	Edit: "file_path",
	NotebookEdit: "notebook_path",
};

/**
 * Builds the judge for one fork. Never throws: any failure is `withhold`. Path tools are judged on the
 * resolved file, Bash, Agent and MCP on the intact text against the rule paths, WebFetch carries no path, anything
 * else is withheld.
 */
export function createDetailJudge(deps: DetailJudgeDeps): DetailJudge {
	const real = deps.realpath ?? ((p: string) => realpath(p));
	return async (name, input) => {
		try {
			const scope = deps.excludeScope();
			if (scope.state === "invalid") return "withhold";
			if (!isRecord(input)) return "withhold";
			const pathField = Object.hasOwn(PATH_TOOLS, name) ? PATH_TOOLS[name] : undefined;
			if (pathField !== undefined) {
				const raw = input[pathField];
				if (typeof raw !== "string" || raw === "") return "withhold";
				const expanded = expandHomePath(raw);
				if (expanded === null) return "withhold";
				const absolute = isAbsolute(expanded) ? expanded : resolve(deps.cwd, expanded);
				const resolved = await resolveThroughExisting(absolute, real);
				// The literal spelling (`<cwd>/~/x` when Claude doesn't expand `~`) is judged too.
				const literal = isAbsolute(raw) ? raw : resolve(deps.cwd, raw);
				return deps.excludesPath(absolute) ||
					deps.excludesPath(resolved) ||
					deps.excludesPath(literal)
					? "withhold"
					: "send";
			}
			if (name === "Bash" || name === FORK_AGENT_TOOL || name.startsWith(MCP_TOOL_PREFIX)) {
				if (scope.state === "none") return "send";
				const dir = await resolveThroughExisting(deps.cwd, real);
				const text = name === "Bash" ? input.command : JSON.stringify(input);
				if (typeof text !== "string") return "withhold";
				for (const rulePath of scope.paths) {
					if (rulePath === dir || rulePath.startsWith(`${dir}/`)) return "withhold";
					if (namingsOfRule(rulePath, dir).some((form) => text.includes(form))) return "withhold";
				}
				return "send";
			}
			return name === "WebFetch" ? "send" : "withhold";
		} catch {
			return "withhold";
		}
	};
}
