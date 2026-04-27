import { relative, resolve } from "node:path";
import type {
	AgentType,
	LaunchMode,
	LaunchSpec,
	PrelaunchAction,
	SessionTemplateInput,
	SupervisorRecord,
	TemplateHostCompatibility,
} from "../../shared/types.js";

function isWithinTrustedRoot(cwd: string, roots: string[]) {
	const resolvedCwd = resolve(cwd);
	for (const root of roots.map((value) => resolve(value))) {
		const rel = relative(root, resolvedCwd);
		if (
			!rel ||
			(!rel.startsWith("..") && !rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`))
		) {
			return true;
		}
	}
	return false;
}

export function validateAgainstSupervisor(
	template: SessionTemplateInput,
	supervisor: SupervisorRecord,
	requestedLaunchMode: LaunchMode,
) {
	const warnings: string[] = [];
	const errors: string[] = [];

	if (!supervisor.capabilities.agentTypes.includes(template.agentType)) {
		errors.push(`${supervisor.hostName} does not advertise support for ${template.agentType}.`);
	}
	if (!supervisor.capabilities.launchModes.includes(requestedLaunchMode)) {
		errors.push(`${supervisor.hostName} does not support ${requestedLaunchMode} launch mode.`);
	}
	if (
		template.agentType === "claude_code" &&
		!supervisor.capabilities.executables?.claude?.available
	) {
		errors.push(
			`${supervisor.hostName} cannot launch Claude Code because the claude executable is not configured or not on PATH.`,
		);
	}
	if (
		template.agentType === "codex_cli" &&
		!supervisor.capabilities.executables?.codex?.available
	) {
		errors.push(
			`${supervisor.hostName} cannot launch Codex because the codex executable is not configured or not on PATH.`,
		);
	}
	if (!isWithinTrustedRoot(template.cwd, supervisor.trustedRoots)) {
		errors.push("Working directory is outside the supervisor's trusted roots.");
	}
	if (!template.model) {
		warnings.push("No explicit model selected. The provider default will be used.");
	}
	if (
		requestedLaunchMode === "interactive_terminal" &&
		supervisor.capabilities.terminalSupport.length === 0
	) {
		errors.push(
			`${supervisor.hostName} does not advertise terminal support for interactive launches.`,
		);
	}
	if (requestedLaunchMode === "headless" && template.agentType !== "claude_code") {
		errors.push("Headless launch mode currently applies to Claude Code only.");
	}
	if (requestedLaunchMode === "managed_codex" && template.agentType !== "codex_cli") {
		errors.push("managed_codex launch mode only applies to Codex CLI templates.");
	}
	if (requestedLaunchMode === "interactive_terminal" && template.agentType === "claude_code") {
		warnings.push(
			"Interactive launches open on the selected host's terminal, not inside AgentPulse.",
		);
		if (!supervisor.capabilities.interactiveTerminalControl?.available) {
			warnings.push(
				supervisor.capabilities.interactiveTerminalControl?.reason ||
					"AgentPulse cannot yet hand prompts back into the live terminal on this host.",
			);
		}
	}
	if (requestedLaunchMode === "headless") {
		warnings.push(
			"Headless launches stream visible Claude output back into AgentPulse and exit when the task completes.",
		);
	}

	return { warnings, errors };
}

/**
 * Determine whether `supervisor` advertises the capability flags required
 * by the supplied prelaunch actions. Returns the list of missing flags so
 * callers can surface a precise error per bob's §10.2.
 */
export function supervisorSupportsPrelaunch(
	supervisor: SupervisorRecord,
	actions: PrelaunchAction[] | undefined,
): { ok: boolean; missing: string[] } {
	if (!actions || actions.length === 0) return { ok: true, missing: [] };
	const features = supervisor.capabilities.features ?? [];
	const missing: string[] = [];
	if (!features.includes("can_run_prelaunch_actions")) {
		missing.push("can_run_prelaunch_actions");
	}
	for (const action of actions) {
		if (action.kind === "scaffold_workarea" && !features.includes("can_scaffold_workarea")) {
			if (!missing.includes("can_scaffold_workarea")) missing.push("can_scaffold_workarea");
		}
	}
	return { ok: missing.length === 0, missing };
}

/**
 * Pure: return the first supervisor from `supervisors` that passes
 * validateAgainstSupervisor with zero errors, or null if none qualify.
 * Extracted so action-requests-service and ask-launch-handler can
 * perform supervisor selection without the async listSupervisors() call.
 *
 * When `prelaunchActions` is provided, supervisors lacking the required
 * capability flags are filtered out *before* the validation pass — a
 * supervisor that can run the agent but can't scaffold isn't capable for
 * this launch (bob's §10.2).
 */
export function pickFirstCapableSupervisor(
	template: SessionTemplateInput,
	mode: LaunchMode,
	supervisors: SupervisorRecord[],
	prelaunchActions?: PrelaunchAction[],
): SupervisorRecord | null {
	const candidates =
		prelaunchActions && prelaunchActions.length > 0
			? supervisors.filter((s) => supervisorSupportsPrelaunch(s, prelaunchActions).ok)
			: supervisors;
	for (const s of candidates) {
		const { errors } = validateAgainstSupervisor(template, s, mode);
		if (errors.length === 0) return s;
	}
	return null;
}

function quoteShellForSpec(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function providerCommandForSpec(agentType: AgentType): string {
	return agentType === "claude_code" ? "claude" : "codex";
}

/**
 * Pure: construct a LaunchSpec from a normalized template + chosen mode +
 * chosen supervisor. Does not call any DB or async function.
 *
 * Required because LaunchRequestInput.launchSpec is mandatory and is
 * dereferenced at launch-validator.ts:140-141. Action requests must persist
 * a real LaunchSpec at creation time so the executor can pass it through
 * without re-deriving it (unless the supervisor changed at execute time,
 * in which case the executor calls this again for the rerouted supervisor).
 */
export function buildLaunchSpec(
	template: SessionTemplateInput,
	mode: LaunchMode,
	_supervisor: SupervisorRecord,
	prelaunchActions?: PrelaunchAction[],
): LaunchSpec {
	const agentType = template.agentType;
	const command = providerCommandForSpec(agentType);
	const instructionsFile: "CLAUDE.md" | "AGENTS.md" =
		agentType === "claude_code" ? "CLAUDE.md" : "AGENTS.md";
	const cliArgs: string[] = [];
	if (template.model) cliArgs.push("--model", quoteShellForSpec(template.model));
	if (agentType === "claude_code" && mode === "headless") {
		cliArgs.push("--print", "--output-format", "stream-json");
	}
	return {
		version: 1,
		launchCorrelationId: crypto.randomUUID(),
		managedMode: "unmanaged_preview",
		agentType,
		launchMode: mode,
		cwd: template.cwd,
		model: template.model ?? null,
		approvalPolicy: template.approvalPolicy ?? null,
		sandboxMode: template.sandboxMode ?? null,
		baseInstructions: template.baseInstructions ?? "",
		taskPrompt: template.taskPrompt ?? "",
		env: template.env ?? {},
		providerConfig: {
			command,
			cliArgs,
			instructionsFile,
		},
		...(prelaunchActions && prelaunchActions.length > 0 ? { prelaunchActions } : {}),
	};
}

export function buildTemplateHostCompatibility(
	template: SessionTemplateInput,
	supervisor: SupervisorRecord,
	requestedLaunchMode: LaunchMode,
): TemplateHostCompatibility {
	const validation = validateAgainstSupervisor(template, supervisor, requestedLaunchMode);
	const executablePath =
		template.agentType === "claude_code"
			? (supervisor.capabilities.executables?.claude?.resolvedPath ?? null)
			: (supervisor.capabilities.executables?.codex?.resolvedPath ?? null);

	return {
		supervisorId: supervisor.id,
		hostName: supervisor.hostName,
		status: supervisor.status,
		platform: supervisor.platform,
		arch: supervisor.arch,
		ok: validation.errors.length === 0,
		errors: validation.errors,
		warnings: validation.warnings,
		executablePath,
	};
}
