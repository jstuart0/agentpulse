import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
	describeEffectivePrivileges,
	sanitizeReportedByAgent,
} from "../../shared/launch-privileges.js";
import type {
	LaunchRequest,
	LaunchRequestInput,
	LaunchRequestStatus,
	LaunchSpec,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../shared/types.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { launchRequests } from "../db/schema/index.js";
import { isUniqueViolationError } from "../db/sql-helpers.js";
import {
	buildStoredCliArgs,
	pickFirstCapableSupervisor,
	validateAgainstSupervisor,
} from "./launch-compatibility.js";
import { getConnectedSupervisor, getSupervisor, listSupervisors } from "./supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "./template-preview.js";

const FINGERPRINT_KEY = "requestFingerprint";

/** The idempotency fingerprint is server bookkeeping and never part of a DTO. */
function withoutFingerprint(
	metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!metadata || !(FINGERPRINT_KEY in metadata)) return metadata ?? null;
	const { [FINGERPRINT_KEY]: _fingerprint, ...rest } = metadata;
	return Object.keys(rest).length > 0 ? rest : null;
}

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
		metadata: withoutFingerprint(row.metadata as Record<string, unknown> | null),
		desiredDisplayName: row.desiredDisplayName ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		requestedByUserId: row.requestedByUserId ?? null,
		effectivePrivileges: describeEffectivePrivileges(
			row.agentType,
			row.approvalPolicy,
			row.sandboxMode,
			sanitizeReportedByAgent(
				(row.providerLaunchMetadata as { privileges?: { reportedByAgent?: unknown } } | null)
					?.privileges?.reportedByAgent,
			),
		),
	};
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

	const supervisors = (await listSupervisors()).filter(
		(supervisor) => supervisor.status === "connected",
	);
	if (supervisors.length === 0) {
		throw new HTTPException(400, {
			message: "No connected supervisor is available for routing.",
		});
	}

	const evaluated = supervisors.map((supervisor) => ({
		supervisor,
		validation: validateAgainstSupervisor(normalizedTemplate, supervisor, requestedLaunchMode),
	}));
	const capableSupervisor = pickFirstCapableSupervisor(
		normalizedTemplate,
		requestedLaunchMode,
		supervisors,
	);
	const match = capableSupervisor
		? (evaluated.find((c) => c.supervisor.id === capableSupervisor.id) ?? null)
		: null;
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

/** How long a client's `metadata.clientRequestId` keeps naming the launch it first created. */
export const CLIENT_REQUEST_ID_WINDOW_MS = 48 * 60 * 60 * 1000;
const CLIENT_REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

function readClientRequestId(metadata: LaunchRequestInput["metadata"]): string | null {
	const raw = metadata?.clientRequestId;
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string" || !CLIENT_REQUEST_ID_PATTERN.test(raw)) {
		throw new HTTPException(400, {
			message: "metadata.clientRequestId must be 1 to 128 printable characters with no spaces.",
		});
	}
	return raw;
}

/**
 * One requester's nonce, hashed over a length-unambiguous encoding so no choice of ids
 * can make two different (requester, nonce) pairs collide. A caller with no user id is
 * scoped by its actor label.
 */
function idempotencyKeyFor(actor: Actor, clientRequestId: string): string {
	const scope = actor.userId ? ["user", actor.userId] : ["actor", actor.label];
	return createHash("sha256")
		.update(JSON.stringify([...scope, clientRequestId]))
		.digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/**
 * What a repeated create must agree on to count as the same request: the template, the
 * mode, the routing, the env, and the whole submitted launch spec (so a changed
 * prelaunch action is a different request). The correlation id is minted by the server
 * every time and is left out.
 */
/**
 * Keyed with the server secret (AGENTPULSE_SECRETS_KEY) when one is configured, so the stored
 * fingerprint can't be used to test guesses about a request's content; a plain SHA-256 when
 * the instance has no secret. Changing the secret only means an old key stops matching its
 * request, which is then treated as a new one.
 */
function fingerprintDigest() {
	return config.secretsKey ? createHmac("sha256", config.secretsKey) : createHash("sha256");
}

function requestFingerprint(input: LaunchRequestInput, t: SessionTemplateInput, mode: string) {
	const { launchCorrelationId: _ignored, ...spec } = input.launchSpec ?? ({} as LaunchSpec);
	return fingerprintDigest()
		.update(
			stableJson({
				templateId: input.templateId ?? null,
				requestedSupervisorId: input.requestedSupervisorId ?? null,
				routingPolicy: input.routingPolicy ?? null,
				mode,
				desiredDisplayName: input.desiredDisplayName ?? null,
				template: {
					agentType: t.agentType,
					cwd: t.cwd,
					baseInstructions: t.baseInstructions ?? "",
					taskPrompt: t.taskPrompt ?? "",
					model: t.model ?? null,
					approvalPolicy: t.approvalPolicy ?? null,
					sandboxMode: t.sandboxMode ?? null,
					env: t.env ?? {},
				},
				spec,
			}),
		)
		.digest("hex");
}

async function replayExistingLaunch(
	key: string,
	fingerprint: string,
): Promise<{ launchRequest: LaunchRequest; supervisor: SupervisorRecord | null } | null> {
	const [row] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.idempotencyKey, key))
		.limit(1);
	if (!row) return null;
	if (Date.now() - new Date(row.createdAt).getTime() > CLIENT_REQUEST_ID_WINDOW_MS) {
		await getDb()
			.update(launchRequests)
			.set({ idempotencyKey: null })
			.where(eq(launchRequests.id, row.id));
		return null;
	}
	if ((row.metadata as Record<string, unknown> | null)?.[FINGERPRINT_KEY] !== fingerprint) {
		throw new HTTPException(409, {
			message: "That clientRequestId was already used for a different launch.",
		});
	}
	return {
		launchRequest: mapLaunchRequest(row),
		supervisor: row.resolvedSupervisorId ? await getSupervisor(row.resolvedSupervisorId) : null,
	};
}

export async function createValidatedLaunchRequest(input: LaunchRequestInput, actor: Actor) {
	const normalizedTemplate = normalizeTemplateInput(input.template);
	const templateValidation = validateTemplateInput(normalizedTemplate);
	if (templateValidation.errors.length > 0) {
		throw new HTTPException(400, { message: templateValidation.errors.join(" ") });
	}

	const clientRequestId = readClientRequestId(input.metadata);
	const idempotencyKey = clientRequestId ? idempotencyKeyFor(actor, clientRequestId) : null;
	const earlyMode =
		input.requestedLaunchMode ?? input.launchSpec.launchMode ?? "interactive_terminal";
	const fingerprint = idempotencyKey
		? requestFingerprint(input, normalizedTemplate, earlyMode)
		: null;
	if (idempotencyKey && fingerprint) {
		const replay = await replayExistingLaunch(idempotencyKey, fingerprint);
		if (replay) return { ...replay, idempotentReplay: true as const };
	}

	const requestedLaunchMode =
		input.requestedLaunchMode ?? input.launchSpec.launchMode ?? "interactive_terminal";
	const routingPolicy =
		input.routingPolicy ?? (input.requestedSupervisorId ? "manual_target" : null);
	const resolved = await resolveSupervisorForLaunch(
		normalizedTemplate,
		input.requestedSupervisorId ?? null,
		routingPolicy,
		requestedLaunchMode,
	);
	const supervisor = resolved.supervisor;
	const supervisorValidation = resolved.validation;

	const warnings = [...templateValidation.warnings, ...supervisorValidation.warnings];
	const status: LaunchRequestStatus =
		supervisorValidation.errors.length > 0 ? "rejected" : "validated";
	const summary =
		status === "validated"
			? `Validated for ${supervisor.hostName}`
			: `Rejected by ${supervisor.hostName}: ${supervisorValidation.errors.join(" ")}`;

	// Security (launch-correlation squatting): the server ALWAYS mints the
	// correlation id here and never honors a caller-supplied value. Every
	// legitimate producer of a launchSpec (buildLaunchSpec, template-preview's
	// previewTemplate, retryLaunchForSession) already generates its own fresh
	// crypto.randomUUID() and never reuses an existing session id, so nothing
	// legitimate depends on this field surviving the round trip through a REST
	// body or an MCP launch_spec argument. A caller (REST `POST /api/v1/launches`
	// or MCP `launch_agent`'s direct mode) that sets launchCorrelationId to an
	// existing or guessed-future session id could otherwise have that session
	// attached to its launch on the session's next SessionStart event,
	// hijacking ownership of someone else's session (see
	// resolveObservedSessionCorrelation's companion guards in
	// launch-dispatch.ts). Silently overwriting rather than rejecting keeps the
	// documented "pass preview_template's output straight through" MCP flow
	// working unchanged — no caller has ever needed this value honored.
	const launchCorrelationId = crypto.randomUUID();
	// The row, not the spec, is what the supervisor enforces, so the stored spec is made to
	// say the same: the template's privileges and the flags the mapping adds for them.
	const normalizedLaunchSpec: LaunchSpec = {
		...input.launchSpec,
		launchCorrelationId,
		approvalPolicy: normalizedTemplate.approvalPolicy ?? null,
		sandboxMode: normalizedTemplate.sandboxMode ?? null,
		providerConfig: {
			...input.launchSpec.providerConfig,
			cliArgs: buildStoredCliArgs(normalizedTemplate, requestedLaunchMode),
		},
	};

	const now = new Date().toISOString();
	let row: typeof launchRequests.$inferSelect;
	try {
		[row] = await getDb()
			.insert(launchRequests)
			.values({
				templateId: input.templateId ?? null,
				launchCorrelationId,
				agentType: normalizedTemplate.agentType,
				cwd: normalizedTemplate.cwd,
				baseInstructions: normalizedTemplate.baseInstructions ?? "",
				taskPrompt: normalizedTemplate.taskPrompt ?? "",
				model: normalizedTemplate.model ?? null,
				approvalPolicy: normalizedTemplate.approvalPolicy ?? null,
				sandboxMode: normalizedTemplate.sandboxMode ?? null,
				requestedLaunchMode,
				env: normalizedTemplate.env ?? {},
				launchSpec: normalizedLaunchSpec as unknown as Record<string, unknown>,
				requestedBy: actor.label,
				requestedByUserId: actor.userId,
				requestedSupervisorId: input.requestedSupervisorId ?? null,
				routingPolicy,
				resolvedSupervisorId: supervisor.id,
				routingDecision: resolved.routingDecision,
				status,
				error: supervisorValidation.errors.join(" ") || null,
				validationWarnings: warnings,
				validationSummary: summary,
				metadata: fingerprint
					? { ...(input.metadata ?? {}), [FINGERPRINT_KEY]: fingerprint }
					: (input.metadata ?? null),
				desiredDisplayName: input.desiredDisplayName ?? null,
				idempotencyKey,
				createdAt: now,
				updatedAt: now,
			})
			.returning();
	} catch (error) {
		// Two creates with one clientRequestId raced past the lookup; the unique key let one in.
		if (idempotencyKey && fingerprint && isUniqueViolationError(error)) {
			const replay = await replayExistingLaunch(idempotencyKey, fingerprint);
			if (replay) return { ...replay, idempotentReplay: true as const };
		}
		throw error;
	}

	return {
		launchRequest: mapLaunchRequest(row),
		supervisor,
	};
}

export { mapLaunchRequest };
