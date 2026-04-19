import { format } from "date-fns";
import type {
	AgentType,
	ApprovalPolicy,
	LaunchMode,
	SandboxMode,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../../shared/types.js";

export type AgentFilter = "all" | AgentType;

export const approvalPolicies: Array<ApprovalPolicy | ""> = [
	"",
	"default",
	"suggest",
	"auto",
	"manual",
	"untrusted",
	"on-failure",
];

export const sandboxModes: Array<SandboxMode | ""> = [
	"",
	"default",
	"workspace-write",
	"read-only",
	"danger-full-access",
];

export function createBlankTemplate(agentType: AgentType = "codex_cli"): SessionTemplateInput {
	return {
		name: "New template",
		description: "",
		agentType,
		cwd: "",
		baseInstructions: "",
		taskPrompt: "",
		model: "",
		approvalPolicy: null,
		sandboxMode: null,
		env: {},
		tags: [],
		isFavorite: false,
	};
}

export const launchModeLabels: Record<LaunchMode, string> = {
	headless: "Headless task",
	interactive_terminal: "Interactive terminal",
	managed_codex: "Managed Codex",
};

export function getLaunchModeOptions(agentType: AgentType) {
	if (agentType === "claude_code") {
		return [
			{
				value: "headless" as const,
				label: launchModeLabels.headless,
				description: "Dispatch a task from AgentPulse, capture visible output, and finish in the dashboard.",
			},
			{
				value: "interactive_terminal" as const,
				label: launchModeLabels.interactive_terminal,
				description: "Open a real Claude session on the host so you can keep driving it there while AgentPulse observes.",
			},
		];
	}

	return [
		{
			value: "managed_codex" as const,
			label: launchModeLabels.managed_codex,
			description: "Launch Codex through the managed app-server path with thread-title sync and lifecycle control.",
		},
	];
}

export function defaultLaunchModeForAgent(agentType: AgentType): LaunchMode {
	return agentType === "claude_code" ? "headless" : "managed_codex";
}

export function parseEnvLines(raw: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex <= 0) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed.slice(eqIndex + 1).trim();
		if (key) env[key] = value;
	}
	return env;
}

export function envToLines(env: Record<string, string>) {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

export function tagsToString(tags: string[]) {
	return tags.join(", ");
}

export function parseTags(raw: string) {
	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

export function formatLaunchTime(value: string | null | undefined) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return format(date, "MMM d, yyyy h:mm:ss a");
}

function isWithinTrustedRoot(cwd: string, roots: string[]) {
	const normalizedCwd = cwd.trim().replace(/\\/g, "/");
	if (!normalizedCwd) return true;
	return roots.some((root) => {
		const normalizedRoot = root.replace(/\\/g, "/");
		return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
	});
}

export function getHostCompatibility(
	template: SessionTemplateInput,
	supervisor: SupervisorRecord,
	requestedLaunchMode: LaunchMode,
) {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!supervisor.capabilities.agentTypes.includes(template.agentType)) {
		errors.push(`Does not support ${template.agentType === "claude_code" ? "Claude Code" : "Codex CLI"}.`);
	}
	if (!supervisor.capabilities.launchModes.includes(requestedLaunchMode)) {
		errors.push(`Does not support ${requestedLaunchMode}.`);
	}
	if (template.agentType === "claude_code" && !supervisor.capabilities.executables?.claude?.available) {
		errors.push("Claude executable is not configured or not on PATH.");
	}
	if (template.agentType === "codex_cli" && !supervisor.capabilities.executables?.codex?.available) {
		errors.push("Codex executable is not configured or not on PATH.");
	}
	if (template.cwd.trim() && !isWithinTrustedRoot(template.cwd, supervisor.trustedRoots)) {
		errors.push("Working directory is outside trusted roots.");
	}
	if (!template.model?.trim()) {
		warnings.push("Will use the provider default model.");
	}
	if (
		requestedLaunchMode === "interactive_terminal" &&
		template.agentType === "claude_code" &&
		!supervisor.capabilities.interactiveTerminalControl?.available
	) {
		warnings.push(
			supervisor.capabilities.interactiveTerminalControl?.reason ||
				"Interactive prompt handoff from AgentPulse is not ready on this host.",
		);
	}
	const executablePath =
		template.agentType === "claude_code"
			? supervisor.capabilities.executables?.claude?.resolvedPath
			: supervisor.capabilities.executables?.codex?.resolvedPath;
	if (executablePath) {
		warnings.push(`Using ${executablePath}.`);
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
	};
}

