import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AGENT_TYPES } from "../../shared/constants.js";
import type {
	AgentType,
	ApprovalPolicy,
	LaunchMode,
	LaunchRoutingPolicy,
	LaunchSpec,
	ProviderLaunchGuidance,
	SandboxMode,
	SessionTemplateInput,
	TemplatePreview,
} from "../../shared/types.js";
import { buildTemplateHostCompatibility } from "./launch-compatibility.js";
import { listSupervisors } from "./supervisor-registry.js";
const SUSPICIOUS_ENV_NAMES = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"AWS_SECRET_ACCESS_KEY",
	"GITHUB_TOKEN",
	"SSH_AUTH_SOCK",
]);

function sanitizeString(value: unknown, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	return value.replace(/\0/g, "").trim();
}

function sanitizeNullableString(value: unknown): string | null {
	const sanitized = sanitizeString(value);
	return sanitized.length > 0 ? sanitized : null;
}

function sanitizeEnv(env: unknown): Record<string, string> {
	if (!env || typeof env !== "object" || Array.isArray(env)) return {};
	const result: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(env)) {
		const cleanKey = sanitizeString(key);
		if (!cleanKey) continue;
		if (typeof rawValue !== "string") continue;
		result[cleanKey] = rawValue.replace(/\0/g, "").trim();
	}
	return result;
}

function sanitizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];
	return tags
		.map((tag) => sanitizeString(tag))
		.filter(Boolean)
		.slice(0, 20);
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function normalizeTemplateInput(input: Partial<SessionTemplateInput>): SessionTemplateInput {
	const agentType = AGENT_TYPES.includes(input.agentType as AgentType)
		? (input.agentType as AgentType)
		: "codex_cli";
	const cwdInput = sanitizeString(input.cwd);
	const cwd = cwdInput ? (isAbsolute(cwdInput) ? cwdInput : resolve(process.cwd(), cwdInput)) : "";
	return {
		name: sanitizeString(input.name),
		description: sanitizeNullableString(input.description),
		agentType,
		cwd,
		baseInstructions: sanitizeString(input.baseInstructions),
		taskPrompt: sanitizeString(input.taskPrompt),
		model: sanitizeNullableString(input.model),
		approvalPolicy: (sanitizeNullableString(input.approvalPolicy) as ApprovalPolicy | null) ?? null,
		sandboxMode: (sanitizeNullableString(input.sandboxMode) as SandboxMode | null) ?? null,
		env: sanitizeEnv(input.env),
		tags: sanitizeTags(input.tags),
		isFavorite: Boolean(input.isFavorite),
	};
}

export function validateTemplateInput(input: SessionTemplateInput) {
	const errors: string[] = [];
	const warnings: string[] = [];
	const baseInstructions = input.baseInstructions ?? "";
	const taskPrompt = input.taskPrompt ?? "";
	const env = input.env ?? {};

	if (!input.name) errors.push("Name is required.");
	if (!AGENT_TYPES.includes(input.agentType))
		errors.push("Agent type must be claude_code or codex_cli.");
	if (!input.cwd) errors.push("Working directory is required.");

	if (input.name.length > 120) errors.push("Name must be 120 characters or fewer.");
	if (baseInstructions.length > 20000)
		errors.push("Base instructions must be 20,000 characters or fewer.");
	if (taskPrompt.length > 12000) errors.push("Task prompt must be 12,000 characters or fewer.");

	if (input.cwd && !existsSync(input.cwd))
		warnings.push("Working directory does not exist on this machine.");
	if (!baseInstructions) warnings.push("Base instructions are empty.");
	if (!taskPrompt) warnings.push("Task prompt is empty.");
	if (baseInstructions.length > 8000) warnings.push("Base instructions are unusually large.");

	for (const envName of Object.keys(env)) {
		if (SUSPICIOUS_ENV_NAMES.has(envName)) {
			warnings.push(
				`Environment variable ${envName} looks like a secret and should probably stay outside a saved template.`,
			);
		}
	}

	return { errors, warnings };
}

function buildProviderGuidance(
	agentType: AgentType,
	template: SessionTemplateInput,
	correlationId: string,
	requestedLaunchMode: LaunchMode,
): ProviderLaunchGuidance {
	const base = [`cd ${quoteShell(template.cwd)}`];
	const provider = agentType === "claude_code" ? "claude" : "codex";
	const args: string[] = [];

	if (template.model) args.push(`--model ${quoteShell(template.model)}`);
	if (agentType === "claude_code" && requestedLaunchMode === "headless") {
		args.push("--print", "--output-format", "stream-json");
	}

	const command = [provider, ...args].join(" ");
	const notes =
		agentType === "claude_code"
			? requestedLaunchMode === "headless"
				? [
						"Headless mode runs Claude in non-interactive print mode and captures visible output back into AgentPulse.",
						"Use this when you want to dispatch a task from the dashboard and inspect progress/output without owning a terminal.",
						`Launch correlation id: ${correlationId}`,
					]
				: [
						"Interactive terminal mode opens a real terminal-backed Claude session on the selected host.",
						"Use this when you want to keep driving the session in Claude itself while AgentPulse observes it.",
						`Launch correlation id: ${correlationId}`,
					]
			: [
					requestedLaunchMode === "managed_codex"
						? "Managed Codex mode launches through the app-server control channel and keeps thread-title sync active."
						: "Preview only. Codex interactive/headless launch paths are not implemented yet.",
					"Enable thread-title in /statusline later if you want the managed session name visible in the TUI.",
					`Launch correlation id: ${correlationId}`,
				];

	return {
		label: agentType === "claude_code" ? "Claude Code" : "Codex CLI",
		command: [...base, command].join(" && "),
		recommended: agentType === template.agentType,
		notes,
	};
}

export async function buildTemplatePreview(
	input: Partial<SessionTemplateInput>,
	options?: {
		requestedLaunchMode?: LaunchMode;
		requestedSupervisorId?: string | null;
		routingPolicy?: LaunchRoutingPolicy | null;
	},
): Promise<TemplatePreview> {
	const normalizedTemplate = normalizeTemplateInput(input);
	const requestedLaunchMode = options?.requestedLaunchMode ?? "interactive_terminal";
	const launchCorrelationId = crypto.randomUUID();
	const providerCommand = normalizedTemplate.agentType === "claude_code" ? "claude" : "codex";
	const instructionsFile =
		normalizedTemplate.agentType === "claude_code" ? "CLAUDE.md" : "AGENTS.md";

	const launchSpec: LaunchSpec = {
		version: 1,
		launchCorrelationId,
		managedMode: "unmanaged_preview",
		agentType: normalizedTemplate.agentType,
		launchMode: requestedLaunchMode,
		cwd: normalizedTemplate.cwd,
		model: normalizedTemplate.model ?? null,
		approvalPolicy: normalizedTemplate.approvalPolicy ?? null,
		sandboxMode: normalizedTemplate.sandboxMode ?? null,
		baseInstructions: normalizedTemplate.baseInstructions ?? "",
		taskPrompt: normalizedTemplate.taskPrompt ?? "",
		env: normalizedTemplate.env ?? {},
		providerConfig: {
			command: providerCommand,
			cliArgs: normalizedTemplate.model ? ["--model", normalizedTemplate.model] : [],
			instructionsFile,
		},
	};

	const validation = validateTemplateInput(normalizedTemplate);
	const supervisors = await listSupervisors();
	const hostCompatibility = supervisors.map((supervisor) =>
		buildTemplateHostCompatibility(normalizedTemplate, supervisor, requestedLaunchMode),
	);
	const firstCapableHostId =
		hostCompatibility.find((candidate) => candidate.status === "connected" && candidate.ok)
			?.supervisorId ?? null;

	return {
		normalizedTemplate,
		launchSpec,
		guidance: {
			claudeCode: buildProviderGuidance(
				"claude_code",
				normalizedTemplate,
				launchCorrelationId,
				requestedLaunchMode,
			),
			codexCli: buildProviderGuidance(
				"codex_cli",
				normalizedTemplate,
				launchCorrelationId,
				requestedLaunchMode,
			),
		},
		warnings: validation.warnings,
		hostCompatibility,
		firstCapableHostId,
	};
}
