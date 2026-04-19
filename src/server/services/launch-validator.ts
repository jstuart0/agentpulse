import { relative, resolve } from "path";
import { HTTPException } from "hono/http-exception";
import { db } from "../db/client.js";
import { launchRequests } from "../db/schema.js";
import { getConnectedSupervisor, listSupervisors } from "./supervisor-registry.js";
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
		routingPolicy: (row.routingPolicy as LaunchRequest["routingPolicy"]) ?? null,
		resolvedSupervisorId: row.resolvedSupervisorId ?? null,
		routingDecision: (row.routingDecision as Record<string, unknown> | null) ?? null,
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
		retryOfLaunchRequestId: row.retryOfLaunchRequestId ?? null,
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

export function validateAgainstSupervisor(
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
	if (template.agentType === "claude_code" && !supervisor.capabilities.executables?.claude?.available) {
		errors.push(`${supervisor.hostName} cannot launch Claude Code because the claude executable is not configured or not on PATH.`);
	}
	if (template.agentType === "codex_cli" && !supervisor.capabilities.executables?.codex?.available) {
		errors.push(`${supervisor.hostName} cannot launch Codex because the codex executable is not configured or not on PATH.`);
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

async function resolveSupervisorForLaunch(
	normalizedTemplate: SessionTemplateInput,
	requestedSupervisorId: string | null | undefined,
	routingPolicy: LaunchRequest["routingPolicy"],
	requestedLaunchMode: LaunchRequest["requestedLaunchMode"],
) {
	if (requestedSupervisorId) {
		const supervisor = await getConnectedSupervisor(requestedSupervisorId);
		if (!supervisor) {
			throw new HTTPException(400, { message: "Selected host is not connected." });
		}
		const validation = validateAgainstSupervisor(
			normalizedTemplate,
			supervisor,
			requestedLaunchMode,
		);
		return {
			supervisor,
			validation,
			routingDecision: {
				type: routingPolicy ?? "manual_target",
				targetSupervisorId: supervisor.id,
			},
		};
	}

	if (routingPolicy !== "first_capable_host") {
		throw new HTTPException(400, {
			message: "Select a target host or choose a routing policy.",
		});
	}

	const supervisors = (await listSupervisors()).filter((supervisor) => supervisor.status === "connected");
	if (supervisors.length === 0) {
		throw new HTTPException(400, {
			message: "No connected supervisor is available for routing.",
		});
	}

	const evaluated = supervisors.map((supervisor) => ({
		supervisor,
		validation: validateAgainstSupervisor(normalizedTemplate, supervisor, requestedLaunchMode),
	}));
	const match = evaluated.find((candidate) => candidate.validation.errors.length === 0);
	if (!match) {
		return {
			supervisor: supervisors[0],
			validation: {
				warnings: [],
				errors: evaluated.flatMap((candidate) =>
					candidate.validation.errors.map((error) => `${candidate.supervisor.hostName}: ${error}`),
				),
			},
			routingDecision: {
				type: "first_capable_host",
				evaluatedHosts: evaluated.map((candidate) => ({
					supervisorId: candidate.supervisor.id,
					hostName: candidate.supervisor.hostName,
					errors: candidate.validation.errors,
				})),
			},
		};
	}

	return {
		supervisor: match.supervisor,
		validation: match.validation,
		routingDecision: {
			type: "first_capable_host",
			targetSupervisorId: match.supervisor.id,
			evaluatedHosts: evaluated.map((candidate) => ({
				supervisorId: candidate.supervisor.id,
				hostName: candidate.supervisor.hostName,
				errors: candidate.validation.errors,
			})),
		},
	};
}

export async function createValidatedLaunchRequest(input: LaunchRequestInput) {
	const normalizedTemplate = normalizeTemplateInput(input.template);
	const templateValidation = validateTemplateInput(normalizedTemplate);
	if (templateValidation.errors.length > 0) {
		throw new HTTPException(400, { message: templateValidation.errors.join(" ") });
	}

	const requestedLaunchMode = input.requestedLaunchMode ?? input.launchSpec.launchMode ?? "interactive_terminal";
	const routingPolicy = input.routingPolicy ?? (input.requestedSupervisorId ? "manual_target" : null);
	const resolved = await resolveSupervisorForLaunch(
		normalizedTemplate,
		input.requestedSupervisorId ?? null,
		routingPolicy,
		requestedLaunchMode,
	);
	const supervisor = resolved.supervisor;
	const supervisorValidation = resolved.validation;

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
			requestedSupervisorId: input.requestedSupervisorId ?? null,
			routingPolicy,
			resolvedSupervisorId: supervisor.id,
			routingDecision: resolved.routingDecision,
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
