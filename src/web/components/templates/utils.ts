import { format } from "date-fns";
import type {
	AgentType,
	ApprovalPolicy,
	LaunchMode,
	SandboxMode,
	SessionTemplateInput,
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

// WS6 Validation unification: host-compatibility rules (trusted roots,
// executable presence, launch-mode support, interactive-terminal
// readiness) live exclusively in the backend's template-preview service
// and are surfaced via TemplatePreview.hostCompatibility. Do not
// reintroduce rule computation on the browser — render preview results
// only.

