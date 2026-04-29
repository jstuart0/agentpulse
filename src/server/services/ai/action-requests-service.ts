import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";
import {
	type ActionRequestDecision,
	type AlertRuleType,
	type AskThreadOrigin,
	KNOWN_ALERT_RULE_TYPES,
	KNOWN_NOTIFICATION_CHANNEL_KINDS,
	type NotificationChannelKind,
} from "../../../shared/types.js";
import { db } from "../../db/client.js";
import {
	events,
	aiActionRequests,
	aiPendingProjectDrafts,
	managedSessions,
	projectAlertRuleFires,
	projectAlertRules,
	projects,
	sessionTemplates,
	sessions,
} from "../../db/schema.js";
import { getChannelCredential } from "../channels/channels-service.js";
import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import { sendTelegramMessage } from "../channels/telegram.js";
import { queueStopAction } from "../control-actions.js";
import { buildLaunchSpec, pickFirstCapableSupervisor } from "../launch-compatibility.js";
import { createValidatedLaunchRequest } from "../launch-validator.js";
import { createProject, deleteProject, updateProject } from "../projects/projects-service.js";
import { getSearchBackend } from "../search/index.js";
import { listSupervisors } from "../supervisor-registry.js";
import { deleteTemplate, updateTemplate } from "../templates/templates-service.js";
import {
	type ActionRequestKind,
	type ActionRequestPayload,
	type AddProjectPayload,
	KNOWN_ACTION_REQUEST_KINDS,
	type SessionArchivePayload,
	type SessionDeletePayload,
	type SessionStopPayload,
} from "./action-requests-types.js";
import { intelligenceForSession } from "./intelligence-service.js";

// Re-export so other server modules can import the union and helpers
// from a single canonical service entry point.
export type {
	ActionRequestKind,
	ActionRequestPayload,
	AddProjectPayload,
} from "./action-requests-types.js";

export type ActionRequestStatus =
	| "awaiting_reply"
	| "applying"
	| "applied"
	| "failed"
	| "declined"
	| "expired"
	| "superseded";

/**
 * Backwards-compat alias preserved for external consumers that imported
 * `AddProjectActionPayload` directly. New code should reach for the
 * canonical `AddProjectPayload` from `./action-requests-types.js`.
 */
export type AddProjectActionPayload = AddProjectPayload;

export interface ActionRequest {
	id: string;
	kind: ActionRequestKind | string;
	status: ActionRequestStatus;
	failureReason: string | null;
	question: string;
	payload: ActionRequestPayload;
	origin: AskThreadOrigin;
	channelId: string | null;
	askThreadId: string | null;
	resolvedAt: string | null;
	resolvedBy: string | null;
	resultEventId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateActionRequestInput {
	kind: ActionRequestKind;
	question: string;
	payload: Omit<ActionRequestPayload, "kind"> | ActionRequestPayload | Record<string, unknown>;
	origin: AskThreadOrigin;
	channelId?: string | null;
	askThreadId?: string | null;
}

/**
 * Type-safe accessor for a typed `ActionRequest.payload`. Returns the
 * narrowed payload when `req.kind === expected`, otherwise throws.
 *
 * Callers previously used `as unknown as <T>` casts at every read site,
 * which silently produced `undefined` for renamed fields. This guard
 * fails loudly at the read site instead, and the narrowed return is
 * exhaustively typed by the discriminant.
 *
 * The discriminant lives on the row, not the payload — `add_channel`'s
 * payload already uses `kind` for the channel sub-kind, so we never
 * stamp the request kind onto the payload object. The Extract pulls the
 * matching union member based on the type-level discriminant; at runtime
 * we trust the row-level `kind` column.
 */
export function narrowPayload<K extends ActionRequestKind>(
	req: ActionRequest,
	expected: K,
): Extract<ActionRequestPayload, { kind: K }> {
	if (req.kind !== expected) {
		throw new Error(
			`narrowPayload: expected kind "${expected}" but action request ${req.id} has kind "${req.kind}"`,
		);
	}
	return req.payload as Extract<ActionRequestPayload, { kind: K }>;
}

function sqlNow(): string {
	return new Date().toISOString();
}

function toRecord(row: typeof aiActionRequests.$inferSelect): ActionRequest {
	// The DB column is `text(..., { mode: "json" })` typed as `Record<string, unknown>`.
	// We do NOT stamp `kind` onto the payload — the row-level `kind` is the
	// source of truth for narrowing, and some payload shapes use `kind` for
	// an unrelated field (e.g. add_channel.kind = "telegram"|"webhook"|"email").
	// `narrowPayload` reads `req.kind`, not `payload.kind`, so the union members
	// are correctly discriminated without clobbering payload data.
	const rawPayload = (row.payload ?? {}) as Record<string, unknown>;
	return {
		id: row.id,
		kind: row.kind,
		status: row.status as ActionRequestStatus,
		failureReason: row.failureReason ?? null,
		question: row.question,
		payload: rawPayload as unknown as ActionRequestPayload,
		origin: row.origin as AskThreadOrigin,
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
	// Runtime kind gate: the table's `kind` column has no CHECK constraint
	// (legacy v1 left it open), so we reject typoed kinds here. A test uses
	// `as ActionRequestKind` to bypass this gate at compile time and asserts
	// we still throw at runtime.
	if (!KNOWN_ACTION_REQUEST_KINDS.includes(input.kind as ActionRequestKind)) {
		throw new Error(
			`createActionRequest: unknown action request kind "${input.kind}". ` +
				`Allowed: ${KNOWN_ACTION_REQUEST_KINDS.join(", ")}`,
		);
	}
	const now = sqlNow();
	// The row-level `kind` column is the source of truth for narrowing —
	// `narrowPayload` reads it, not a payload-level discriminant. We do
	// NOT stamp `kind` onto the payload object because some payload shapes
	// already use `kind` for an unrelated field (e.g. add_channel's
	// `kind: "telegram" | "webhook" | "email"`); doing so would clobber it.
	const [row] = await db
		.insert(aiActionRequests)
		.values({
			kind: input.kind,
			status: "awaiting_reply",
			question: input.question,
			payload: input.payload as Record<string, unknown>,
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
	| { ok: true; status: ActionRequestDecision }
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
	origin: AskThreadOrigin,
	channelId: string | null,
	askThreadId: string | null,
	text: string,
): Promise<void> {
	if (origin !== "telegram" || !channelId) return;
	const token = getTelegramBotToken();
	if (!token) return;
	const cred = await getChannelCredential(channelId);
	if (!cred?.chatId) return;
	await sendTelegramMessage(token, cred.chatId, text);
	void askThreadId; // reserved for web reply path; future use
}

async function executeLaunchAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = narrowPayload(request, "launch_request");
	const { template, launchSpec, requestedLaunchMode, validatedSupervisorId } = payload;
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
		const { aiInitiated, askThreadId: payloadAskThreadId, desiredDisplayName } = payload;
		const launchMetadata =
			aiInitiated || payloadAskThreadId
				? {
						...(aiInitiated ? { aiInitiated: true } : {}),
						...(payloadAskThreadId ? { askThreadId: payloadAskThreadId } : {}),
					}
				: null;
		const { launchRequest } = await createValidatedLaunchRequest({
			template,
			launchSpec: finalLaunchSpec,
			requestedSupervisorId: executingSupervisor.id,
			requestedLaunchMode,
			metadata: launchMetadata,
			desiredDisplayName: desiredDisplayName ?? null,
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
	const payload = narrowPayload(request, "add_project");
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
 *
 * The three session-mutation kinds (stop / archive / delete) share the
 * same `{ sessionId, sessionDisplayName }` payload shape; we narrow on
 * the row-level kind so a future divergent payload would surface as a
 * compile error here rather than at the mutation site.
 *
 * Note: this is the COMPOUND action-request form (`session_stop`...).
 * The bare-form `SessionMutationKind` (`stop` | `archive` | `delete`)
 * lives in shared/types.ts and drives the bulk-action surfaces.
 * `mutationKindToInboxKind()` in shared/types.ts maps bare → compound.
 */
type ActionRequestSessionMutationKind = "session_stop" | "session_archive" | "session_delete";

async function executeSessionMutation(
	request: ActionRequest,
	resolvedBy: string,
	mutationFn: (sessionId: string) => Promise<void>,
): Promise<ResolveResult> {
	const payload = narrowPayload(request, request.kind as ActionRequestSessionMutationKind) as
		| SessionStopPayload
		| SessionArchivePayload
		| SessionDeletePayload;
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
	const payload = narrowPayload(request, "edit_project");
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
	const payload = narrowPayload(request, "delete_project");
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
	const payload = narrowPayload(request, "edit_template");
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
	const payload = narrowPayload(request, "delete_template");
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
	const payload = narrowPayload(request, "add_channel");
	const { origin, channelId, askThreadId } = request;

	// payload.channelKind is named so it doesn't clash with the row-level
	// discriminant `kind`; see action-requests-types.ts AddChannelPayload.
	const kind = KNOWN_NOTIFICATION_CHANNEL_KINDS.includes(
		payload.channelKind as NotificationChannelKind,
	)
		? (payload.channelKind as NotificationChannelKind)
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

// ---- Alert rule executor ------------------------------------------------

async function executeCreateAlertRuleAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = narrowPayload(request, "create_alert_rule");
	const { projectId, projectName, ruleType, thresholdMinutes, channelId } = payload;
	const { origin, channelId: reqChannelId, askThreadId } = request;

	// Constrained rule types only — reject unsupported types rather than
	// silently no-op. All four rule types are evaluated by the periodic
	// alert-rule sweep in WatcherRunner. On rule creation, existing matching
	// sessions are pre-seeded into project_alert_rule_fires to prevent
	// first-sweep notification storms.
	if (!KNOWN_ALERT_RULE_TYPES.includes(ruleType as AlertRuleType)) {
		const reason = `Rule type "${ruleType}" is not supported`;
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		return { ok: false, reason: "failed", failureReason: reason };
	}

	// Pre-check: project must still exist.
	const [existingProject] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (!existingProject) {
		const reason = `Project "${projectName}" no longer exists`;
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		await notifyOriginUser(origin, reqChannelId, askThreadId, `Could not apply — ${reason}.`);
		return { ok: false, reason: "failed", failureReason: reason };
	}

	try {
		const nowDate = new Date();
		const nowStr = sqlNow();
		const params =
			ruleType === "no_activity_minutes" && thresholdMinutes != null
				? ({ thresholdMinutes } as Record<string, unknown>)
				: null;

		const [newRule] = await db
			.insert(projectAlertRules)
			.values({
				projectId,
				ruleType,
				params,
				channelId: channelId ?? null,
				isActive: true,
				createdAt: nowStr,
				updatedAt: nowStr,
			})
			.returning({ id: projectAlertRules.id });

		// Backfill: pre-seed fire rows for sessions that already match the rule
		// condition at creation time. This prevents the first sweep from sending
		// a storm of notifications for the existing backlog. No notifications are
		// sent for backfilled rows — they are silent de-bounce markers only.
		if (newRule) {
			try {
				if (ruleType === "status_stuck") {
					const candidates = await db
						.select({ sessionId: sessions.sessionId })
						.from(sessions)
						.where(
							and(
								eq(sessions.projectId, projectId),
								inArray(sessions.status, ["active", "idle"]),
								isNull(sessions.endedAt),
								eq(sessions.isArchived, false),
							),
						);
					for (const { sessionId: sid } of candidates) {
						const intel = await intelligenceForSession(sid, nowDate).catch(() => null);
						if (!intel || intel.health !== "stuck") continue;
						await db
							.insert(projectAlertRuleFires)
							.values({ ruleId: newRule.id, sessionId: sid, firedAt: nowDate.toISOString() })
							.onConflictDoNothing();
					}
				} else if (ruleType === "no_activity_minutes" && thresholdMinutes != null) {
					const cutoff = new Date(nowDate.getTime() - thresholdMinutes * 60_000).toISOString();
					const candidates = await db
						.select({ sessionId: sessions.sessionId })
						.from(sessions)
						.where(
							and(
								eq(sessions.projectId, projectId),
								isNull(sessions.endedAt),
								eq(sessions.isArchived, false),
								sql`${sessions.lastActivityAt} < ${cutoff}`,
							),
						);
					for (const { sessionId: sid } of candidates) {
						await db
							.insert(projectAlertRuleFires)
							.values({ ruleId: newRule.id, sessionId: sid, firedAt: nowDate.toISOString() })
							.onConflictDoNothing();
					}
				} else if (ruleType === "status_failed" || ruleType === "status_completed") {
					const targetStatus = ruleType === "status_failed" ? "failed" : "completed";
					const candidates = await db
						.select({ sessionId: sessions.sessionId })
						.from(sessions)
						.where(and(eq(sessions.projectId, projectId), eq(sessions.status, targetStatus)));
					for (const { sessionId: sid } of candidates) {
						await db
							.insert(projectAlertRuleFires)
							.values({ ruleId: newRule.id, sessionId: sid, firedAt: nowDate.toISOString() })
							.onConflictDoNothing();
					}
				}
			} catch (backfillErr) {
				// Backfill failure must not abort rule creation — the rule is live;
				// the first sweep may fire for existing sessions but that is preferable
				// to losing the rule entirely.
				console.error("[alert-rule] backfill failed for rule", newRule.id, backfillErr);
			}
		}

		await conditionalUpdate(request.id, "applying", {
			status: "applied",
			resolvedBy,
		});
		await notifyOriginUser(
			origin,
			reqChannelId,
			askThreadId,
			`Alert rule created for **${projectName}**: will notify when a session ${ruleTypeLabel(ruleType, thresholdMinutes)}.`,
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
			reqChannelId,
			askThreadId,
			`Alert rule creation failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

// ---- Freeform alert rule executor ----------------------------------------

async function executeCreateFreeformAlertRuleAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = narrowPayload(request, "create_freeform_alert_rule");
	const { projectId, projectName, condition, dailyTokenBudget, sampleRate, eventTypesFilter } =
		payload;
	const { origin, channelId: reqChannelId, askThreadId } = request;

	// Validate required fields.
	if (!condition || condition.trim().length === 0) {
		const reason = "Freeform alert rule requires a non-empty condition";
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		return { ok: false, reason: "failed", failureReason: reason };
	}
	if (!dailyTokenBudget || dailyTokenBudget < 1000) {
		const reason = "Daily token budget must be at least 1000";
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		return { ok: false, reason: "failed", failureReason: reason };
	}

	// Pre-check: project must still exist.
	const [existingProject] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);

	if (!existingProject) {
		const reason = `Project "${projectName}" no longer exists`;
		await conditionalUpdate(request.id, "applying", {
			status: "failed",
			failureReason: reason,
			resolvedBy,
		});
		await notifyOriginUser(origin, reqChannelId, askThreadId, `Could not apply — ${reason}.`);
		return { ok: false, reason: "failed", failureReason: reason };
	}

	try {
		const nowStr = sqlNow();

		// Capture MAX(events.id) at creation time so first sweep only evaluates
		// events arriving AFTER the rule was created (avoids backlog flood).
		const [maxEventRow] = await db.select({ maxId: max(events.id) }).from(events);
		const initialCursor = maxEventRow?.maxId ?? 0;

		await db.insert(projectAlertRules).values({
			projectId,
			ruleType: "freeform_match",
			params: {
				condition: condition.slice(0, 500),
				dailyTokenBudgetCents: dailyTokenBudget,
				sampleRate: sampleRate ?? 1.0,
				eventTypesFilter: eventTypesFilter ?? [],
			} as Record<string, unknown>,
			channelId: null,
			isActive: true,
			lastEvaluatedEventId: initialCursor,
			createdAt: nowStr,
			updatedAt: nowStr,
		});

		await conditionalUpdate(request.id, "applying", {
			status: "applied",
			resolvedBy,
		});
		await notifyOriginUser(
			origin,
			reqChannelId,
			askThreadId,
			`Freeform alert rule created for **${projectName}**: will notify when "${condition.slice(0, 200)}". Budget: ${dailyTokenBudget} tokens/day.`,
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
			reqChannelId,
			askThreadId,
			`Freeform alert rule creation failed: ${reason.slice(0, 400)}`,
		);
		return { ok: false, reason: "failed", failureReason: reason };
	}
}

// ---- Bulk session action executor ----------------------------------------

async function stopOne(
	sessionId: string,
	name: string,
): Promise<{ sessionId: string; name: string; ok: boolean; error?: string }> {
	const [managed] = await db
		.select({ sessionId: managedSessions.sessionId })
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId))
		.limit(1);
	if (!managed) {
		// Handler-time pre-flight should have excluded hook-only sessions, but
		// guard here in case the executor receives a bypassed payload.
		return { sessionId, name, ok: false, error: "hook-only session" };
	}
	await queueStopAction(sessionId);
	return { sessionId, name, ok: true };
}

async function archiveOne(
	sessionId: string,
	name: string,
	session: { isArchived: boolean },
): Promise<{ sessionId: string; name: string; ok: boolean; error?: string }> {
	if (session.isArchived) {
		return { sessionId, name, ok: true, error: "already archived" };
	}
	await db.update(sessions).set({ isArchived: true }).where(eq(sessions.sessionId, sessionId));
	return { sessionId, name, ok: true };
}

async function deleteOne(
	sessionId: string,
	name: string,
	session: { endedAt: string | null; status: string },
): Promise<{ sessionId: string; name: string; ok: boolean; error?: string }> {
	const activeStatuses = ["active", "idle"];
	if (!session.endedAt && activeStatuses.includes(session.status)) {
		// Handler-time pre-flight should have excluded these, but guard in case of bypass.
		return {
			sessionId,
			name,
			ok: false,
			error: "cannot delete active session — stop or archive first",
		};
	}
	const backend = getSearchBackend();
	await backend.removeSession(sessionId);
	await db.delete(events).where(eq(events.sessionId, sessionId));
	await db.delete(sessions).where(eq(sessions.sessionId, sessionId));
	return { sessionId, name, ok: true };
}

function formatBulkOutcomes(
	action: string,
	outcomes: { sessionId: string; name: string; ok: boolean; error?: string }[],
): string {
	const succeeded = outcomes.filter((o) => o.ok && !o.error);
	const noops = outcomes.filter((o) => o.ok && o.error);
	const failed = outcomes.filter((o) => !o.ok);

	const parts: string[] = [];
	if (succeeded.length > 0) {
		const verb = action === "stop" ? "Stopped" : action === "archive" ? "Archived" : "Deleted";
		parts.push(`${verb} ${succeeded.length} session${succeeded.length !== 1 ? "s" : ""}.`);
	}
	if (noops.length > 0) {
		const detail = noops.map((o) => `${o.name}: ${o.error}`).join("; ");
		parts.push(`${noops.length} no-op (${detail}).`);
	}
	if (failed.length > 0) {
		const detail = failed.map((o) => `${o.name}: ${o.error ?? "unknown error"}`).join("; ");
		parts.push(`${failed.length} failed (${detail}).`);
	}
	return parts.join(" ") || "No sessions processed.";
}

async function executeBulkSessionAction(
	request: ActionRequest,
	resolvedBy: string,
): Promise<ResolveResult> {
	const payload = narrowPayload(request, "bulk_session_action");
	const { action, sessionIds, sessionNames } = payload;
	const { origin, channelId, askThreadId } = request;

	function nameFor(id: string): string {
		const idx = sessionIds.indexOf(id);
		return idx >= 0 && sessionNames[idx] ? sessionNames[idx] : id.slice(0, 8);
	}

	// Batch-fetch all targeted sessions in one query rather than N point-queries.
	const existingRows = await db
		.select({
			sessionId: sessions.sessionId,
			status: sessions.status,
			endedAt: sessions.endedAt,
			isArchived: sessions.isArchived,
		})
		.from(sessions)
		.where(inArray(sessions.sessionId, sessionIds));
	const sessionMap = new Map(existingRows.map((s) => [s.sessionId, s]));

	const outcomes: { sessionId: string; name: string; ok: boolean; error?: string }[] = [];

	for (const sessionId of sessionIds) {
		const name = nameFor(sessionId);
		const session = sessionMap.get(sessionId);

		if (!session) {
			outcomes.push({ sessionId, name, ok: false, error: "no longer exists" });
			continue;
		}

		// Per-combination behavior — each runs in its own try/catch so one
		// failing target does not abort the rest of the loop.
		try {
			if (action === "stop") {
				if (session.endedAt) {
					outcomes.push({ sessionId, name, ok: true, error: "already stopped" });
				} else {
					outcomes.push(await stopOne(sessionId, name));
				}
			} else if (action === "archive") {
				outcomes.push(await archiveOne(sessionId, name, session));
			} else if (action === "delete") {
				outcomes.push(await deleteOne(sessionId, name, session));
			}
		} catch (err) {
			outcomes.push({
				sessionId,
				name,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	await conditionalUpdate(request.id, "applying", { status: "applied", resolvedBy });
	const summary = formatBulkOutcomes(action, outcomes);
	await notifyOriginUser(origin, channelId, askThreadId, summary);
	return { ok: true, status: "applied" };
}

// Exhaustive over AlertRuleType — adding a new rule type to
// KNOWN_ALERT_RULE_TYPES without a matching branch here fails to compile
// via the `never` assignment in the default arm.
//
// Exported so tests can confirm every KNOWN_ALERT_RULE_TYPES member is
// handled without introspecting private state.
export function ruleTypeLabel(ruleType: AlertRuleType, thresholdMinutes?: number | null): string {
	switch (ruleType) {
		case "status_failed":
			return "fails";
		case "status_stuck":
			return "gets stuck";
		case "status_completed":
			return "completes";
		case "no_activity_minutes":
			return `has no activity for ${thresholdMinutes ?? "N"} minutes`;
		default: {
			const _exhaustive: never = ruleType;
			return _exhaustive;
		}
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
	create_alert_rule: executeCreateAlertRuleAction,
	create_freeform_alert_rule: executeCreateFreeformAlertRuleAction,
	bulk_session_action: executeBulkSessionAction,
};

export async function resolveActionRequest(args: {
	id: string;
	decision: ActionRequestDecision;
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
				const payload = narrowPayload(declined, "add_project");
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
