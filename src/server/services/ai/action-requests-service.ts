import { and, eq, inArray } from "drizzle-orm";
import type { LaunchMode, LaunchSpec, SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { aiActionRequests, aiPendingProjectDrafts } from "../../db/schema.js";
import type { ProjectDraftFields } from "../../db/schema.js";
import { getChannelCredential } from "../channels/channels-service.js";
import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import { buildLaunchSpec, pickFirstCapableSupervisor } from "../launch-compatibility.js";
import { createValidatedLaunchRequest } from "../launch-validator.js";
import { createProject } from "../projects/projects-service.js";
import { listSupervisors } from "../supervisor-registry.js";

export type ActionRequestStatus =
	| "awaiting_reply"
	| "applying"
	| "applied"
	| "failed"
	| "declined"
	| "expired"
	| "superseded";

export interface ActionRequestPayload {
	template: SessionTemplateInput;
	launchSpec: LaunchSpec;
	requestedLaunchMode: LaunchMode;
	validatedSupervisorId: string;
	projectId: string;
	projectName?: string;
}

export interface ActionRequest {
	id: string;
	kind: string;
	status: ActionRequestStatus;
	failureReason: string | null;
	question: string;
	payload: ActionRequestPayload;
	origin: "web" | "telegram";
	channelId: string | null;
	askThreadId: string | null;
	resolvedAt: string | null;
	resolvedBy: string | null;
	resultEventId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AddProjectActionPayload {
	draftFields: ProjectDraftFields;
	draftId: string;
}

export interface CreateActionRequestInput {
	kind:
		| "launch_request"
		| "add_project"
		| "session_stop"
		| "session_archive"
		| "session_delete"
		| "edit_project"
		| "delete_project"
		| "edit_template"
		| "delete_template"
		| "add_channel"
		| "create_alert_rule";
	question: string;
	payload: ActionRequestPayload | AddProjectActionPayload | Record<string, unknown>;
	origin: "web" | "telegram";
	channelId?: string | null;
	askThreadId?: string | null;
}

function sqlNow(): string {
	return new Date().toISOString();
}

function toRecord(row: typeof aiActionRequests.$inferSelect): ActionRequest {
	return {
		id: row.id,
		kind: row.kind,
		status: row.status as ActionRequestStatus,
		failureReason: row.failureReason ?? null,
		question: row.question,
		payload: row.payload as unknown as ActionRequestPayload,
		origin: row.origin as "web" | "telegram",
		channelId: row.channelId ?? null,
		askThreadId: row.askThreadId ?? null,
		resolvedAt: row.resolvedAt ?? null,
		resolvedBy: row.resolvedBy ?? null,
		resultEventId: row.resultEventId ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function createActionRequest(input: CreateActionRequestInput): Promise<ActionRequest> {
	const now = sqlNow();
	const [row] = await db
		.insert(aiActionRequests)
		.values({
			kind: input.kind,
			status: "awaiting_reply",
			question: input.question,
			payload: input.payload as unknown as Record<string, unknown>,
			origin: input.origin,
			channelId: input.channelId ?? null,
			askThreadId: input.askThreadId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

export async function getActionRequest(id: string): Promise<ActionRequest | null> {
	const [row] = await db
		.select()
		.from(aiActionRequests)
		.where(eq(aiActionRequests.id, id))
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function listOpenActionRequests(): Promise<ActionRequest[]> {
	const rows = await db
		.select()
		.from(aiActionRequests)
		.where(inArray(aiActionRequests.status, ["awaiting_reply"]));
	return rows.map(toRecord);
}

type ResolveResult =
	| { ok: true; status: "applied" | "declined" }
	| { ok: false; reason: "race_lost"; currentStatus: string }
	| { ok: false; reason: "expired"; failureReason: string }
	| { ok: false; reason: "failed"; failureReason: string };

/**
 * Atomic conditional UPDATE helper. Returns the count of rows changed.
 * A count of 0 means either the row is gone or the status didn't match
 * the expected value — both indicate a race was lost.
 */
async function conditionalUpdate(
	id: string,
	expectedStatus: ActionRequestStatus,
	patch: {
		status: ActionRequestStatus;
		failureReason?: string;
		resolvedBy?: string;
		resultEventId?: string;
	},
): Promise<{ rowsAffected: number }> {
	const now = sqlNow();
	const rows = await db
		.update(aiActionRequests)
		.set({
			status: patch.status,
			...(patch.failureReason !== undefined && { failureReason: patch.failureReason }),
			...(patch.resolvedBy !== undefined && { resolvedBy: patch.resolvedBy }),
			...(patch.resultEventId !== undefined && { resultEventId: patch.resultEventId }),
			...(["applied", "failed", "expired", "declined"].includes(patch.status) && {
				resolvedAt: now,
			}),
			updatedAt: now,
		})
		.where(and(eq(aiActionRequests.id, id), eq(aiActionRequests.status, expectedStatus)))
		.returning();
	return { rowsAffected: rows.length };
}

async function notifyOriginUser(
	origin: "web" | "telegram",
	channelId: string | null,
	askThreadId: string | null,
	text: string,
): Promise<void> {
	if (origin !== "telegram" || !channelId) return;
	const token = getTelegramBotToken();
	if (!token) return;
	const cred = await getChannelCredential(channelId);
	if (!cred?.chatId) return;
	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: cred.chatId, text }),
	}).catch(() => {
		// best-effort; don't block the main executor path
	});
	void askThreadId; // reserved for web reply path; future use
}

async function executeLaunchAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const { template, launchSpec, requestedLaunchMode, validatedSupervisorId } = request.payload;
	const { origin, channelId, askThreadId } = request;

	try {
		// === STEP 1: Re-validate at execute time ===
		// The originally validated supervisor may have gone offline between
		// approval creation and approval execution. Check live supervisors.
		const allSupervisors = await listSupervisors();
		const connectedSupervisors = allSupervisors.filter((s) => s.status === "connected");

		let executingSupervisor = connectedSupervisors.find((s) => s.id === validatedSupervisorId);
		let routedAway = false;

		if (!executingSupervisor) {
			executingSupervisor =
				pickFirstCapableSupervisor(template, requestedLaunchMode, connectedSupervisors) ??
				undefined;
			if (!executingSupervisor) {
				await conditionalUpdate(request.id, "applying", {
					status: "expired",
					failureReason: "No capable supervisor at execute time",
					resolvedBy,
				});
				await notifyOriginUser(
					origin,
					channelId,
					askThreadId,
					"Couldn't launch: no host machine is currently available.",
				);
				return {
					ok: false,
					reason: "expired",
					failureReason: "No capable supervisor at execute time",
				};
			}
			routedAway = true;
		}

		// === STEP 2: Rebuild launchSpec only if rerouted ===
		// If we rerouted to a different supervisor, the persisted launchSpec
		// (built for the originally chosen supervisor) may carry supervisor-specific
		// fields. Rebuild deterministically with the pure helper.
		const finalLaunchSpec = routedAway
			? buildLaunchSpec(template, requestedLaunchMode, executingSupervisor)
			: launchSpec;

		if (routedAway) {
			await notifyOriginUser(
				origin,
				channelId,
				askThreadId,
				`Original host gone; rerouted to ${executingSupervisor.hostName}. Launching now.`,
			);
		}

		// === STEP 3: Dispatch via the existing managed-launch pipeline ===
		const { launchRequest } = await createValidatedLaunchRequest({
			template,
			launchSpec: finalLaunchSpec,
			requestedSupervisorId: executingSupervisor.id,
			requestedLaunchMode,
		});

		// === STEP 4: Mark applied ===
		await conditionalUpdate(request.id, "applying", {
			status: "applied",
			resolvedBy,
			resultEventId: launchRequest.id,
		});
		await notifyOriginUser(
			origin,
			channelId,
			askThreadId,
			`Launch queued (${launchRequest.id}). The session will appear on the dashboard shortly.`,
		);
		return { ok: true, status: "applied" };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		await notifyOriginUser(
			origin,
			channelId,
			askThreadId,
			`Launch failed: ${reason.slice(0, 400)}.`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

async function executeAddProjectAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as AddProjectActionPayload;
	const { draftFields, draftId } = payload;
	const { origin, channelId, askThreadId } = request;

	try {
		if (!draftFields?.name || !draftFields?.cwd) {
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: "Required fields missing at execute time",
				resolvedBy,
			});
			return { ok: false, reason: "failed", failureReason: "Required fields missing" };
		}

		const result = await createProject({
			name: draftFields.name,
			cwd: draftFields.cwd,
			defaultAgentType: draftFields.defaultAgentType,
			defaultModel: draftFields.defaultModel,
			defaultLaunchMode: draftFields.defaultLaunchMode,
			githubRepoUrl: draftFields.githubRepoUrl,
		});

		if (result.conflict) {
			const reason = `Name or directory already in use (conflict: ${result.conflict})`;
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(
				origin,
				channelId,
				askThreadId,
				"Couldn't create project: name or directory is already in use.",
			);
			return { ok: false, reason: "failed", failureReason: reason };
		}

		// Mark draft applied
		const now = sqlNow();
		await db
			.update(aiPendingProjectDrafts)
			.set({ status: "applied", updatedAt: now })
			.where(eq(aiPendingProjectDrafts.id, draftId));

		await conditionalUpdate(request.id, "applying", {
			status: "applied",
			resolvedBy,
			resultEventId: result.project?.id,
		});
		await notifyOriginUser(
			origin,
			channelId,
			askThreadId,
			`Project "${draftFields.name}" created. It will appear in Projects.`,
		);
		return { ok: true, status: "applied" };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		await notifyOriginUser(
			origin,
			channelId,
			askThreadId,
			`Project creation failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

export async function resolveActionRequest(args: {
	id: string;
	decision: "applied" | "declined";
	resolvedBy: string;
}): Promise<ResolveResult> {
	const { id, decision, resolvedBy } = args;

	if (decision === "declined") {
		// Atomic conditional UPDATE — same pattern as "applied" path below.
		const claimed = await conditionalUpdate(id, "awaiting_reply", {
			status: "declined",
			resolvedBy,
		});
		if (claimed.rowsAffected === 0) {
			const current = await getActionRequest(id);
			return { ok: false, reason: "race_lost", currentStatus: current?.status ?? "missing" };
		}

		// Best-effort post-step: update the draft row to declined status.
		// The action_request is already declined — this is informational only.
		const declined = await getActionRequest(id);
		if (declined?.kind === "add_project") {
			try {
				const payload = declined.payload as unknown as AddProjectActionPayload;
				if (payload?.draftId) {
					await db
						.update(aiPendingProjectDrafts)
						.set({ status: "declined", updatedAt: sqlNow() })
						.where(eq(aiPendingProjectDrafts.id, payload.draftId));
				}
			} catch (err) {
				console.error("[decline-path] Failed to update draft status to declined:", err);
				// Non-fatal — action_request is already declined.
			}
		}

		return { ok: true, status: "declined" };
	}

	// decision === "applied"
	//
	// Atomic claim: single UPDATE WHERE status = 'awaiting_reply'. If two
	// concurrent approvals race (e.g. web UI + Telegram), exactly one will
	// see rowsAffected = 1 and proceed; the other gets 0 and returns race-lost.
	// This is the only correct pattern — a "read then write" approach would
	// allow both to pass the read check before either writes.
	const claimed = await conditionalUpdate(id, "awaiting_reply", { status: "applying" });
	if (claimed.rowsAffected === 0) {
		const current = await getActionRequest(id);
		return { ok: false, reason: "race_lost", currentStatus: current?.status ?? "missing" };
	}

	const request = await getActionRequest(id);
	if (!request) {
		await conditionalUpdate(id, "applying", {
			status: "failed",
			failureReason: "Unsupported action kind",
		});
		return { ok: false, reason: "failed", failureReason: "Unsupported action kind" };
	}

	if (request.kind === "add_project") {
		return executeAddProjectAction(request, resolvedBy);
	}

	if (request.kind === "launch_request") {
		return executeLaunchAction(request, resolvedBy);
	}

	await conditionalUpdate(id, "applying", {
		status: "failed",
		failureReason: `Unsupported action kind: ${request.kind}`,
	});
	return { ok: false, reason: "failed", failureReason: `Unsupported action kind: ${request.kind}` };
}
