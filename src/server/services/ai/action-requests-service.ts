import { and, eq, inArray } from "drizzle-orm";
import type { LaunchMode, LaunchSpec, SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import {
	events,
	aiActionRequests,
	aiPendingProjectDrafts,
	managedSessions,
	sessionTemplates,
	sessions,
} from "../../db/schema.js";
import type { ProjectDraftFields } from "../../db/schema.js";
import type {
	DeleteProjectPayload,
	DeleteTemplatePayload,
	EditProjectPayload,
	EditTemplatePayload,
} from "../ask/ask-crud-handler.js";
import { getChannelCredential } from "../channels/channels-service.js";
import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import { queueStopAction } from "../control-actions.js";
import { buildLaunchSpec, pickFirstCapableSupervisor } from "../launch-compatibility.js";
import { createValidatedLaunchRequest } from "../launch-validator.js";
import { createProject, deleteProject, updateProject } from "../projects/projects-service.js";
import { getSearchBackend } from "../search/index.js";
import { listSupervisors } from "../supervisor-registry.js";
import { deleteTemplate, updateTemplate } from "../templates/templates-service.js";

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

export interface SessionActionPayload {
	sessionId: string;
	sessionDisplayName: string | null;
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

// ---- Session mutation executors -----------------------------------------

/**
 * Shared helper for session-mutation executors: verifies the session still
 * exists before running the mutation, marks applied/failed, and notifies.
 * Keeps the three executors free of duplicated pre-check / error-handling code.
 */
async function executeSessionMutation(
	request: ActionRequest,
	resolvedBy: string,
	mutationFn: (sessionId: string) => Promise<void>,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as SessionActionPayload;
	const { origin, channelId, askThreadId } = request;
	const sessionName = payload.sessionDisplayName ?? payload.sessionId;

	// Pre-check: the session may have been deleted between approval creation
	// and execution. If so, mark failed immediately rather than throwing.
	const [existing] = await db
		.select({ sessionId: sessions.sessionId })
		.from(sessions)
		.where(eq(sessions.sessionId, payload.sessionId))
		.limit(1);

	if (!existing) {
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: `Session ${payload.sessionId} no longer exists`,
			resolvedBy,
		});
		await notifyOriginUser(
			origin,
			channelId,
			askThreadId,
			`Could not apply — session **${sessionName}** no longer exists.`,
		);
		return { ok: false, reason: "failed", failureReason: "Session no longer exists" };
	}

	try {
		await mutationFn(payload.sessionId);
		await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
		await notifyOriginUser(origin, channelId, askThreadId, `Action applied to **${sessionName}**.`);
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
			`Action failed for **${sessionName}**: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

async function executeSessionStopAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	return executeSessionMutation(request, resolvedBy, async (sessionId) => {
		// Verify managed_sessions at execute time — the session may have
		// transitioned from managed to hook-only (rare but possible on renames
		// that discard the managed row).
		const [managed] = await db
			.select({ sessionId: managedSessions.sessionId })
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId))
			.limit(1);
		if (!managed) {
			throw new Error("Session is not managed by AgentPulse");
		}
		await queueStopAction(sessionId);
	});
}

async function executeSessionArchiveAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	return executeSessionMutation(request, resolvedBy, async (sessionId) => {
		await db.update(sessions).set({ isArchived: true }).where(eq(sessions.sessionId, sessionId));
	});
}

async function executeSessionDeleteAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	return executeSessionMutation(request, resolvedBy, async (sessionId) => {
		// Remove FTS index entries first, then the events, then the session row.
		const backend = getSearchBackend();
		await backend.removeSession(sessionId);
		await db.delete(events).where(eq(events.sessionId, sessionId));
		await db.delete(sessions).where(eq(sessions.sessionId, sessionId));
	});
}

// ---- Project/template CRUD executors ------------------------------------

async function executeEditProjectAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as EditProjectPayload;
	const { projectId, projectName, fields } = payload;
	const { origin, channelId, askThreadId } = request;

	try {
		const result = await updateProject(projectId, fields as Parameters<typeof updateProject>[1]);
		if (result.notFound) {
			const reason = `Project "${projectName}" no longer exists`;
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(origin, channelId, askThreadId, `Could not apply — ${reason}.`);
			return { ok: false, reason: "failed", failureReason: reason };
		}
		if (result.conflict) {
			const reason = "Project name or directory conflicts with an existing project";
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(origin, channelId, askThreadId, `Could not apply — ${reason}.`);
			return { ok: false, reason: "failed", failureReason: reason };
		}
		await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
		await notifyOriginUser(origin, channelId, askThreadId, `Project **${projectName}** updated.`);
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
			`Update failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

async function executeDeleteProjectAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as DeleteProjectPayload;
	const { projectId, projectName } = payload;
	const { origin, channelId, askThreadId } = request;

	try {
		const deleted = await deleteProject(projectId);
		if (!deleted) {
			const reason = `Project "${projectName}" no longer exists`;
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(origin, channelId, askThreadId, `Could not apply — ${reason}.`);
			return { ok: false, reason: "failed", failureReason: reason };
		}
		await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
		await notifyOriginUser(
			origin,
			channelId,
			askThreadId,
			`Project **${projectName}** deleted. Linked templates and sessions have been disassociated.`,
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
			`Delete failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

async function executeEditTemplateAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as EditTemplatePayload;
	const { templateId, templateName, fields } = payload;
	const { origin, channelId, askThreadId } = request;

	try {
		const [existing] = await db
			.select()
			.from(sessionTemplates)
			.where(eq(sessionTemplates.id, templateId))
			.limit(1);
		if (!existing) {
			const reason = `Template "${templateName}" no longer exists`;
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(origin, channelId, askThreadId, `Could not apply — ${reason}.`);
			return { ok: false, reason: "failed", failureReason: reason };
		}

		// Build a full UpdateTemplateInput from existing row + partial fields overlay.
		// updateTemplate requires a complete SessionTemplateInput; we fill omitted fields
		// from the existing row so only user-specified fields change.
		type AgentType = import("../../../shared/types.js").AgentType;
		type ApprovalPolicy = import("../../../shared/types.js").ApprovalPolicy;
		const merged = {
			name: (fields.name as string | undefined) ?? existing.name,
			description: (fields.description as string | undefined) ?? existing.description ?? "",
			agentType: existing.agentType as AgentType,
			cwd: existing.cwd,
			baseInstructions: existing.baseInstructions ?? "",
			taskPrompt:
				"taskPrompt" in fields
					? ((fields.taskPrompt as string | undefined) ?? "")
					: (existing.taskPrompt ?? ""),
			model:
				"model" in fields
					? ((fields.model as string | null | undefined) ?? null)
					: (existing.model ?? null),
			approvalPolicy: existing.approvalPolicy as ApprovalPolicy | null | undefined,
			sandboxMode: existing.sandboxMode as
				| import("../../../shared/types.js").SandboxMode
				| null
				| undefined,
			env: (existing.env as Record<string, string>) ?? {},
			tags: (existing.tags as string[]) ?? [],
			isFavorite: existing.isFavorite ?? false,
		};

		const result = await updateTemplate(templateId, merged);
		if (!result.ok) {
			const reason = result.error;
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(origin, channelId, askThreadId, `Update failed: ${reason}`);
			return { ok: false, reason: "failed", failureReason: reason };
		}

		await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
		await notifyOriginUser(origin, channelId, askThreadId, `Template **${templateName}** updated.`);
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
			`Update failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

async function executeDeleteTemplateAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as DeleteTemplatePayload;
	const { templateId, templateName } = payload;
	const { origin, channelId, askThreadId } = request;

	try {
		const result = await deleteTemplate(templateId);
		if (!result.ok) {
			const reason = result.error;
			await conditionalUpdate(request.id, "applying", {
				status: "failed",
				failureReason: reason,
				resolvedBy,
			});
			await notifyOriginUser(origin, channelId, askThreadId, `Could not apply — ${reason}.`);
			return { ok: false, reason: "failed", failureReason: reason };
		}
		await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
		await notifyOriginUser(origin, channelId, askThreadId, `Template **${templateName}** deleted.`);
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
			`Delete failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

// ---- Channel setup executor ---------------------------------------------

async function executeAddChannelAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = request.payload as unknown as { kind: string; label: string };
	const { origin, channelId, askThreadId } = request;

	const validKinds = ["telegram", "webhook", "email"] as const;
	type ChannelKind = (typeof validKinds)[number];
	const kind = validKinds.includes(payload.kind as ChannelKind)
		? (payload.kind as ChannelKind)
		: null;
	const label =
		typeof payload.label === "string" && payload.label ? payload.label : "Ask-created channel";

	if (!kind) {
		const reason = `Invalid channel kind: "${payload.kind}"`;
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		return { ok: false, reason: "failed", failureReason: reason };
	}

	try {
		const { createPendingChannel } = await import("../channels/channels-service.js");
		const { channel, enrollmentCode } = await createPendingChannel({ kind, label });
		// isActive = true, verifiedAt = null — intentional: channel is visible but
		// unverified. dispatch.ts checks verifiedAt before sending real messages.

		let notifyText: string;
		if (kind === "telegram") {
			// The bot DMs the user the enrollment code; the user DMs it back as
			// `/start <code>`. This self-DM pattern is required because Telegram's
			// Bot API cannot initiate a conversation with a user who has not
			// first messaged the bot — the enrollment code flow works around this.
			notifyText = `Telegram channel **${label}** created. Your enrollment code is: ${enrollmentCode}\n\nDM this to your AgentPulse Telegram bot:\n  /start ${enrollmentCode}\n\nOnce sent, the bot will confirm and the channel will be active.`;
		} else if (kind === "webhook") {
			const { config } = await import("../../config.js");
			const webhookUrl = `${config.publicUrl}/api/v1/channels/webhook/${channel.id}`;
			notifyText = `Webhook channel **${label}** created. Your webhook URL is:\n  ${webhookUrl}\n\nConfigure your webhook sender to POST JSON events to this URL.`;
		} else {
			// email: channel row is created; email delivery requires further
			// SMTP configuration in Settings → Channels before messages arrive.
			notifyText = `Email channel **${label}** created (id: ${channel.id}). Email delivery requires SMTP configuration in Settings → Channels.`;
		}

		await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
		await notifyOriginUser(origin, channelId, askThreadId, notifyText);
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
			`Channel setup failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

type KindExecutor = (request: ActionRequest, resolvedBy: string) => Promise<ResolveResult>;

const KIND_EXECUTORS: Partial<Record<string, KindExecutor>> = {
	launch_request: executeLaunchAction,
	add_project: executeAddProjectAction,
	session_stop: executeSessionStopAction,
	session_archive: executeSessionArchiveAction,
	session_delete: executeSessionDeleteAction,
	edit_project: executeEditProjectAction,
	delete_project: executeDeleteProjectAction,
	edit_template: executeEditTemplateAction,
	delete_template: executeDeleteTemplateAction,
	add_channel: executeAddChannelAction,
};

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

	const executor = KIND_EXECUTORS[request.kind];
	if (!executor) {
		await conditionalUpdate(id, "applying", {
			status: "failed",
			failureReason: `Unsupported action kind: ${request.kind}`,
		});
		return {
			ok: false,
			reason: "failed",
			failureReason: `Unsupported action kind: ${request.kind}`,
		};
	}
	return executor(request, resolvedBy);
}
