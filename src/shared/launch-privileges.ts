/**
 * The one mapping from a launch's `approvalPolicy` / `sandboxMode` to what each
 * agent CLI is actually told. The server uses it to validate and preview a launch;
 * the supervisor uses it to build the real argv (Claude Code) or thread/start
 * parameters (managed Codex). Both sides call the same function, so what the app
 * confirms is what the machine runs.
 *
 * Rules:
 * - null / undefined / "default" means the agent's own default: no flag is added,
 *   and the result lists the setting in `agentDefaults` so it can be shown.
 * - A value this module doesn't know, or one a provider has no faithful equivalent
 *   for, is an error. Nothing is approximated and nothing falls back to a default.
 * - No setting here can produce Claude's `bypassPermissions` or
 *   `--dangerously-skip-permissions`, or Codex's `never` approval or
 *   `--dangerously-bypass-approvals-and-sandbox`. The only broad grant that can
 *   appear is Codex `--sandbox danger-full-access`, and only when the launch's
 *   `sandboxMode` is exactly "danger-full-access".
 *
 * Sources (flags checked against the installed CLIs, 2026-10-18):
 * - Claude Code 2.1.303 `claude --help`: `--permission-mode <mode>`; "default" is
 *   accepted (the mode the help lists as "manual"). Claude Code has no
 *   sandbox-mode launch flag.
 * - Codex 0.163.0 `codex exec --help`: `-s/--sandbox read-only|workspace-write|
 *   danger-full-access`, `-a/--ask-for-approval`. The managed path talks to
 *   `codex app-server`, whose `thread/start` takes `approvalPolicy` and `sandbox`
 *   and rejects `on-failure` and `auto` ("expected one of untrusted, on-request,
 *   granular, never"; probed against the real app-server).
 */
import { isLaunchable } from "./constants.js";
import {
	APPROVAL_POLICIES,
	type ApprovalPolicy,
	type LaunchableAgentType,
	SANDBOX_MODES,
	type SandboxMode,
} from "./types.js";

export type PrivilegeSetting = "approvalPolicy" | "sandboxMode";

type Mapping =
	| { kind: "agent_default" }
	| { kind: "flag"; value: string; permissive?: true }
	| { kind: "unsupported"; reason: string };

const AGENT_DEFAULT: Mapping = { kind: "agent_default" };
const flag = (value: string, permissive?: true): Mapping => ({ kind: "flag", value, permissive });
const unsupported = (reason: string): Mapping => ({ kind: "unsupported", reason });

// 'manual', 'suggest' and 'untrusted' all mean "a person approves anything that changes
// state". Claude Code's default permission mode and Codex's `untrusted` policy do exactly
// that (reads run, edits and commands ask), and neither is broader than any reading of
// those three names, so they share one flag. 'auto' and 'on-failure' stay refused.
// Claude Code: `--permission-mode <value>`.
const CLAUDE_APPROVAL: Record<ApprovalPolicy, Mapping> = {
	default: AGENT_DEFAULT,
	manual: flag("default"),
	suggest: flag("default"),
	untrusted: flag("default"),
	auto: unsupported(
		"'auto' doesn't say whether file edits or every command run unattended, so there's no faithful Claude Code permission mode for it",
	),
	"on-failure": unsupported(
		"'on-failure' is a Codex approval mode and Claude Code has no equivalent",
	),
};

// Claude Code has no flag that sets a sandbox mode. `danger-full-access` is a true
// description of Claude (nothing confines it), so it is accepted and enforces nothing;
// the narrower modes would promise a confinement Claude can't provide, so they are refused.
const CLAUDE_SANDBOX_NONE =
	"Claude Code has no sandbox-mode launch flag, so this can't be enforced; leave the sandbox mode unset (or 'danger-full-access', which is how Claude Code already runs)";
const CLAUDE_SANDBOX: Record<SandboxMode, Mapping> = {
	default: AGENT_DEFAULT,
	"read-only": unsupported(CLAUDE_SANDBOX_NONE),
	"workspace-write": unsupported(CLAUDE_SANDBOX_NONE),
	"danger-full-access": AGENT_DEFAULT,
};

// Codex: `--ask-for-approval <value>` (thread/start `approvalPolicy`).
const CODEX_APPROVAL: Record<ApprovalPolicy, Mapping> = {
	default: AGENT_DEFAULT,
	untrusted: flag("untrusted"),
	manual: flag("untrusted"),
	suggest: flag("untrusted"),
	auto: unsupported(
		"'auto' doesn't say whether file edits or every command run unattended, so there's no faithful Codex approval policy for it",
	),
	"on-failure": unsupported(
		"Codex no longer accepts the 'on-failure' approval policy (its app-server rejects it)",
	),
};

// Codex: `--sandbox <value>` (thread/start `sandbox`).
const CODEX_SANDBOX: Record<SandboxMode, Mapping> = {
	default: AGENT_DEFAULT,
	"read-only": flag("read-only"),
	"workspace-write": flag("workspace-write"),
	"danger-full-access": flag("danger-full-access", true),
};

const TABLES = {
	claude_code: { approvalPolicy: CLAUDE_APPROVAL, sandboxMode: CLAUDE_SANDBOX },
	codex_cli: { approvalPolicy: CODEX_APPROVAL, sandboxMode: CODEX_SANDBOX },
} as const satisfies Record<
	LaunchableAgentType,
	{ approvalPolicy: Record<ApprovalPolicy, Mapping>; sandboxMode: Record<SandboxMode, Mapping> }
>;

const KNOWN: Record<PrivilegeSetting, readonly string[]> = {
	approvalPolicy: APPROVAL_POLICIES,
	sandboxMode: SANDBOX_MODES,
};

const LABEL: Record<PrivilegeSetting, string> = {
	approvalPolicy: "Approval policy",
	sandboxMode: "Sandbox mode",
};

/** What a managed Codex thread/start is given. A field is absent when the agent's default applies. */
export interface CodexThreadPrivileges {
	approvalPolicy?: string;
	sandbox?: string;
}

export interface ResolvedLaunchPrivileges {
	ok: true;
	agentType: LaunchableAgentType;
	/** The flags, in the order they appear in the argv / preview. Empty when both settings are agent defaults. */
	cliArgs: string[];
	/** Settings left to the agent's own default (nothing was added for them). */
	agentDefaults: PrivilegeSetting[];
	/** Managed Codex only: the same values as thread/start parameters. */
	codexThread: CodexThreadPrivileges | null;
}

export interface RejectedLaunchPrivileges {
	ok: false;
	errors: string[];
}

export type LaunchPrivileges = ResolvedLaunchPrivileges | RejectedLaunchPrivileges;

function lookup(
	agentType: LaunchableAgentType,
	setting: PrivilegeSetting,
	value: unknown,
): { mapping: Mapping } | { error: string } {
	if (value === null || value === undefined) return { mapping: AGENT_DEFAULT };
	if (typeof value !== "string" || !Object.hasOwn(TABLES[agentType][setting], value)) {
		const shown = typeof value === "string" ? `'${value}'` : "a non-text value";
		return {
			error: `${LABEL[setting]} ${shown} isn't recognised. Use one of: ${KNOWN[setting].join(", ")}.`,
		};
	}
	const mapping = (TABLES[agentType][setting] as Record<string, Mapping>)[value];
	if (mapping.kind === "unsupported") {
		return {
			error: `${LABEL[setting]} '${value}' can't be applied to ${agentType}: ${mapping.reason}.`,
		};
	}
	return { mapping };
}

export function resolveLaunchPrivileges(
	agentType: string,
	approvalPolicy: unknown,
	sandboxMode: unknown,
): LaunchPrivileges {
	if (!isLaunchable(agentType)) {
		return { ok: false, errors: [`${agentType} has no launch privilege mapping.`] };
	}
	const approval = lookup(agentType, "approvalPolicy", approvalPolicy);
	const sandbox = lookup(agentType, "sandboxMode", sandboxMode);
	if ("error" in approval || "error" in sandbox) {
		return {
			ok: false,
			errors: [approval, sandbox].flatMap((r) => ("error" in r ? [r.error] : [])),
		};
	}

	const agentDefaults: PrivilegeSetting[] = [];
	const approvalValue = approval.mapping.kind === "flag" ? approval.mapping.value : null;
	const sandboxValue = sandbox.mapping.kind === "flag" ? sandbox.mapping.value : null;
	if (approvalValue === null) agentDefaults.push("approvalPolicy");
	if (sandboxValue === null) agentDefaults.push("sandboxMode");

	if (agentType === "claude_code") {
		return {
			ok: true,
			agentType,
			cliArgs: approvalValue === null ? [] : ["--permission-mode", approvalValue],
			agentDefaults,
			codexThread: null,
		};
	}
	return {
		ok: true,
		agentType,
		cliArgs: [
			...(sandboxValue === null ? [] : ["--sandbox", sandboxValue]),
			...(approvalValue === null ? [] : ["--ask-for-approval", approvalValue]),
		],
		agentDefaults,
		codexThread: {
			...(approvalValue === null ? {} : { approvalPolicy: approvalValue }),
			...(sandboxValue === null ? {} : { sandbox: sandboxValue }),
		},
	};
}

/** Thrown by the supervisor when a launch's privileges can't be applied. The message is safe to report. */
export class LaunchPrivilegeError extends Error {
	constructor(readonly errors: string[]) {
		super(errors.join(" "));
		this.name = "LaunchPrivilegeError";
	}
}

export function requireLaunchPrivileges(
	agentType: string,
	approvalPolicy: unknown,
	sandboxMode: unknown,
): ResolvedLaunchPrivileges {
	const resolved = resolveLaunchPrivileges(agentType, approvalPolicy, sandboxMode);
	if (!resolved.ok) throw new LaunchPrivilegeError(resolved.errors);
	return resolved;
}

/** The "visible in the launch record" line for settings left to the agent. Empty when nothing is defaulted. */
export function agentDefaultsWarning(resolved: ResolvedLaunchPrivileges): string | null {
	if (resolved.agentDefaults.length === 0) return null;
	const names = resolved.agentDefaults.map((s) => LABEL[s].toLowerCase()).join(" and ");
	return `No explicit ${names}: ${resolved.agentType === "claude_code" ? "Claude Code" : "Codex"} will use its own default (no flag is added).`;
}

/** Expected `sandbox.type` in a Codex thread/start response for each requested sandbox value. */
export const CODEX_SANDBOX_RESPONSE_TYPE: Record<string, string> = {
	"read-only": "readOnly",
	"workspace-write": "workspaceWrite",
	"danger-full-access": "dangerFullAccess",
};

/**
 * One setting as it will actually apply. `requested` is what the launch recorded;
 * `effective` is what the agent runs with after the mapping. When `source` is
 * "agent_default" nothing was enforced and `effective` describes the agent's own
 * default, which a host's settings can change (`hostDependent`).
 */
export interface EffectivePrivilege {
	requested: string | null;
	source: "explicit" | "agent_default";
	effective: string;
	/** True when the setting grants broad access (no sandbox, full filesystem access). */
	permissive: boolean;
	/** True when the value comes from the agent's own configuration on the host, which the server can't see. */
	hostDependent: boolean;
}

export interface ReportedByAgent {
	approvalPolicy: unknown;
	sandbox: unknown;
	networkAccess?: boolean | null;
	writableRoots?: string[];
	permissive?: boolean;
}

export interface EffectivePrivileges {
	agentType: LaunchableAgentType;
	approvalPolicy: EffectivePrivilege;
	sandboxMode: EffectivePrivilege;
	/** Exactly the flags added to the agent (managed Codex passes the same values as thread/start parameters). */
	enforcedArgs: string[];
	/** What `default` / unset means for this agent, in words. */
	defaultMeaning: string;
	/** What the agent itself reported at start (managed Codex), when known. */
	reportedByAgent?: ReportedByAgent;
	/** What "enforced" covers. Always the same sentence, so a client can show it next to the flags. */
	enforcementScope: string;
}

export const ENFORCEMENT_SCOPE =
	"Enforced means the launch command line (and, for managed Codex, the thread parameters). Project and user settings files (Claude .claude/settings.json, Codex config.toml), hooks and managed settings can still widen what the agent may do.";

// What each agent does when no flag is added. Claude Code: 2.1.303 `--permission-mode`
// default is "default" and it has no sandbox. Codex 0.163.0: probed against a bare
// CODEX_HOME, thread/start answered approvalPolicy "on-request" and a read-only sandbox;
// a trusted project or the user's config.toml commonly widens that to workspace-write.
const AGENT_DEFAULTS = {
	claude_code: {
		approvalPolicy: {
			effective:
				"the host's own permission mode: 'default' (asks before file edits and shell commands) unless the user or project settings.json sets defaultMode or permissions.allow, which can widen it",
			permissive: true,
			hostDependent: true,
		},
		sandboxMode: {
			effective:
				"none: Claude Code has no sandbox, so commands run with the user's own permissions",
			permissive: true,
			hostDependent: false,
		},
		meaning:
			"Claude Code's own default: no flag is added, so the user's and the project's .claude/settings.json (defaultMode, permissions.allow, hooks) and any managed settings apply and can widen permissions; there is no sandbox.",
	},
	codex_cli: {
		approvalPolicy: {
			effective:
				"on-request: the model decides when to ask (the host's Codex config can change it)",
			permissive: false,
			hostDependent: true,
		},
		sandboxMode: {
			effective:
				"read-only with no Codex config, workspace-write for a trusted project or when the host's config sets it",
			permissive: false,
			hostDependent: true,
		},
		meaning:
			"Codex's own default: no flag is added, so the host's config.toml, the project's trust level and any profile apply and can widen permissions; with no config it is on-request approval and a read-only sandbox. The launch record shows what Codex reported.",
	},
} as const satisfies Record<
	LaunchableAgentType,
	{
		approvalPolicy: Omit<EffectivePrivilege, "requested" | "source">;
		sandboxMode: Omit<EffectivePrivilege, "requested" | "source">;
		meaning: string;
	}
>;

function effectiveOf(
	agentType: LaunchableAgentType,
	setting: PrivilegeSetting,
	requested: string | null,
	mapping: Mapping,
): EffectivePrivilege {
	if (mapping.kind === "flag") {
		return {
			requested,
			source: "explicit",
			effective: mapping.value,
			permissive: mapping.permissive === true,
			hostDependent: false,
		};
	}
	return { requested, source: "agent_default", ...AGENT_DEFAULTS[agentType][setting] };
}

/** Null when the mapping rejects these values (such a launch never runs). */
export function describeEffectivePrivileges(
	agentType: string,
	approvalPolicy: unknown,
	sandboxMode: unknown,
	reported?: ReportedByAgent | null,
): EffectivePrivileges | null {
	const resolved = resolveLaunchPrivileges(agentType, approvalPolicy, sandboxMode);
	if (!resolved.ok) return null;
	const type = resolved.agentType;
	const approval = lookup(type, "approvalPolicy", approvalPolicy);
	const sandbox = lookup(type, "sandboxMode", sandboxMode);
	if ("error" in approval || "error" in sandbox) return null;
	const approvalOut = effectiveOf(
		type,
		"approvalPolicy",
		typeof approvalPolicy === "string" ? approvalPolicy : null,
		approval.mapping,
	);
	const sandboxOut = effectiveOf(
		type,
		"sandboxMode",
		typeof sandboxMode === "string" ? sandboxMode : null,
		sandbox.mapping,
	);
	if (reported) {
		if (approvalOut.source === "agent_default" && typeof reported.approvalPolicy === "string") {
			approvalOut.effective = `${reported.approvalPolicy} (as reported by the agent at start)`;
			approvalOut.hostDependent = false;
			approvalOut.permissive = reported.approvalPolicy === "never";
		}
		if (sandboxOut.source === "agent_default" && typeof reported.sandbox === "string") {
			sandboxOut.effective = `${reported.sandbox} (as reported by the agent at start)`;
			sandboxOut.hostDependent = false;
			sandboxOut.permissive =
				reported.permissive === true || reported.sandbox === "dangerFullAccess";
		}
	}
	return {
		agentType: type,
		approvalPolicy: approvalOut,
		sandboxMode: sandboxOut,
		...(reported ? { reportedByAgent: reported } : {}),
		enforcedArgs: resolved.cliArgs,
		defaultMeaning: AGENT_DEFAULTS[type].meaning,
		enforcementScope: ENFORCEMENT_SCOPE,
	};
}

/** The flags to show for a template/launch; empty when the mapping rejects it (validation reports that). */
export function privilegeCliArgs(
	agentType: string,
	approvalPolicy: unknown,
	sandboxMode: unknown,
): string[] {
	const resolved = resolveLaunchPrivileges(agentType, approvalPolicy, sandboxMode);
	return resolved.ok ? resolved.cliArgs : [];
}

/** The record of what was enforced, for a launch's provider metadata. */
export function privilegeMetadata(privileges: ResolvedLaunchPrivileges) {
	return { enforcedArgs: privileges.cliArgs, agentDefaults: privileges.agentDefaults };
}

export interface UnsupportedPrivilege {
	setting: PrivilegeSetting;
	value: string;
	reason: string;
	/** What an explicit one-click change would set. `null` clears the setting to the agent's default. */
	suggested: string | null;
}

/**
 * Set on a template (or launch) whose recorded values the mapping now refuses, with the
 * replacement to offer. Never applied automatically: a person confirms the change.
 */
export interface PrivilegesUnsupported {
	issues: UnsupportedPrivilege[];
}

const SUGGESTED_REPLACEMENT: Record<PrivilegeSetting, string | null> = {
	approvalPolicy: "manual",
	sandboxMode: null,
};

export function describeUnsupportedPrivileges(
	agentType: string,
	approvalPolicy: unknown,
	sandboxMode: unknown,
): PrivilegesUnsupported | null {
	if (!isLaunchable(agentType)) return null;
	const issues: UnsupportedPrivilege[] = [];
	for (const [setting, value] of [
		["approvalPolicy", approvalPolicy],
		["sandboxMode", sandboxMode],
	] as const) {
		const found = lookup(agentType, setting, value);
		if ("error" in found) {
			issues.push({
				setting,
				value: typeof value === "string" ? value : String(value),
				reason: found.error,
				suggested: SUGGESTED_REPLACEMENT[setting],
			});
		}
	}
	return issues.length > 0 ? { issues } : null;
}

const REPORTED_STRING_MAX = 64;
const REPORTED_PATH_MAX = 256;
const REPORTED_PATHS_MAX = 20;

function cappedText(value: unknown, max: number): string | null {
	if (value === null || value === undefined) return null;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * What the agent said it applied is untrusted text that is stored and shown, so it is cut to
 * a size that can't swamp a record or a screen, wherever it is read or written.
 */
export function sanitizeReportedByAgent(raw: unknown): ReportedByAgent | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const roots = Array.isArray(r.writableRoots) ? r.writableRoots : [];
	return {
		approvalPolicy: cappedText(r.approvalPolicy, REPORTED_STRING_MAX),
		sandbox: cappedText(r.sandbox, REPORTED_STRING_MAX),
		networkAccess: typeof r.networkAccess === "boolean" ? r.networkAccess : null,
		writableRoots: roots
			.slice(0, REPORTED_PATHS_MAX)
			.map((root) => cappedText(root, REPORTED_PATH_MAX))
			.filter((root): root is string => root !== null),
		permissive: r.permissive === true,
	};
}
