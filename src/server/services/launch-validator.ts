import { relative, resolve } from "path";
import { db } from "../db/client.js";
import { launchRequests } from "../db/schema.js";
import { getConnectedSupervisor } from "./supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";
import type {
	LaunchRequest,
	LaunchRequestInput,
	LaunchRequestStatus,
	LaunchSpec,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../shared/types.js";

function mapLaunchRequest(row: typeof launchRequests.$inferSelect): LaunchRequest {
	return {
		id: row.id,
		templateId: row.templateId,
		launchCorrelationId: row.launchCorrelationId,
		agentType: row.agentType as LaunchRequest["agentType"],
		cwd: row.cwd,
		baseInstructions: row.baseInstructions,
		taskPrompt: row.taskPrompt,
		model: row.model,
		approvalPolicy: row.approvalPolicy as LaunchRequest["approvalPolicy"],
		sandboxMode: row.sandboxMode as LaunchRequest["sandboxMode"],
		requestedLaunchMode: row.requestedLaunchMode as LaunchRequest["requestedLaunchMode"],
		env: row.env ?? {},
		launchSpec: row.launchSpec as unknown as LaunchSpec,
		requestedBy: row.requestedBy,
		requestedSupervisorId: row.requestedSupervisorId,
		claimedBySupervisorId: row.claimedBySupervisorId,
		claimToken: row.claimToken,
		status: row.status as LaunchRequestStatus,
		error: row.error,
		validationWarnings: row.validationWarnings ?? [],
		validationSummary: row.validationSummary,
		dispatchStartedAt: row.dispatchStartedAt,
		dispatchFinishedAt: row.dispatchFinishedAt,
		awaitingSessionDeadlineAt: row.awaitingSessionDeadlineAt,
		pid: row.pid ?? null,
		providerLaunchMetadata: (row.providerLaunchMetadata as Record<string, unknown> | null) ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function isWithinTrustedRoot(cwd: string, roots: string[]) {
	const resolvedCwd = resolve(cwd);
	for (const root of roots.map((value) => resolve(value))) {
		const rel = relative(root, resolvedCwd);
		if (!rel || (!rel.startsWith("..") && !rel.includes(`..${process.platform === "win32" ? "\\" : "/"}`))) {
			return true;
		}
	}
	return false;
}

function validateAgainstSupervisor(
	template: SessionTemplateInput,
	supervisor: SupervisorRecord,
	requestedLaunchMode: LaunchRequest["requestedLaunchMode"],
) {
	const warnings: string[] = [];
	const errors: string[] = [];

	if (!supervisor.capabilities.agentTypes.includes(template.agentType)) {
		errors.push(`${supervisor.hostName} does not advertise support for ${template.agentType}.`);
	}
	if (!supervisor.capabilities.launchModes.includes(requestedLaunchMode)) {
		errors.push(`${supervisor.hostName} does not support ${requestedLaunchMode} launch mode.`);
	}
	if (!isWithinTrustedRoot(template.cwd, supervisor.trustedRoots)) {
		errors.push("Working directory is outside the supervisor's trusted roots.");
	}
	if (!template.model) {
		warnings.push("No explicit model selected. The provider default will be used.");
	}
	if (requestedLaunchMode === "managed_codex" && template.agentType !== "codex_cli") {
		errors.push("managed_codex launch mode only applies to Codex CLI templates.");
	}

	return { warnings, errors };
}

export async function createValidatedLaunchRequest(input: LaunchRequestInput) {
	const normalizedTemplate = normalizeTemplateInput(input.template);
	const templateValidation = validateTemplateInput(normalizedTemplate);
	if (templateValidation.errors.length > 0) {
		throw new Error(templateValidation.errors.join(" "));
	}

	const supervisor = await getConnectedSupervisor(input.requestedSupervisorId ?? null);
	if (!supervisor) {
		throw new Error("No connected supervisor is available for validation.");
	}

	const requestedLaunchMode = input.requestedLaunchMode ?? input.launchSpec.launchMode ?? "interactive_terminal";
	const supervisorValidation = validateAgainstSupervisor(
		normalizedTemplate,
		supervisor,
		requestedLaunchMode,
	);

	const warnings = [...templateValidation.warnings, ...supervisorValidation.warnings];
	const status: LaunchRequestStatus = supervisorValidation.errors.length > 0 ? "rejected" : "validated";
	const summary =
		status === "validated"
			? `Validated for ${supervisor.hostName}`
			: `Rejected by ${supervisor.hostName}: ${supervisorValidation.errors.join(" ")}`;

	const now = new Date().toISOString();
	const [row] = await db
		.insert(launchRequests)
		.values({
			templateId: input.templateId ?? null,
			launchCorrelationId: input.launchSpec.launchCorrelationId,
			agentType: normalizedTemplate.agentType,
			cwd: normalizedTemplate.cwd,
			baseInstructions: normalizedTemplate.baseInstructions ?? "",
			taskPrompt: normalizedTemplate.taskPrompt ?? "",
			model: normalizedTemplate.model ?? null,
			approvalPolicy: normalizedTemplate.approvalPolicy ?? null,
			sandboxMode: normalizedTemplate.sandboxMode ?? null,
			requestedLaunchMode,
			env: normalizedTemplate.env ?? {},
			launchSpec: input.launchSpec as unknown as Record<string, unknown>,
			requestedBy: "local-user",
			requestedSupervisorId: supervisor.id,
			status,
			error: supervisorValidation.errors.join(" ") || null,
			validationWarnings: warnings,
			validationSummary: summary,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return {
		launchRequest: mapLaunchRequest(row),
		supervisor,
	};
}

export { mapLaunchRequest };
