import { count, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessionTemplates, sessions } from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { listProjects } from "../projects/projects-service.js";
import { normalizeCwd } from "../projects/resolver.js";
import type { ProjectTemplateCrudIntent } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

export interface EditProjectPayload extends Record<string, unknown> {
	projectId: string;
	projectName: string;
	fields: Record<string, unknown>;
}

export interface DeleteProjectPayload extends Record<string, unknown> {
	projectId: string;
	projectName: string;
	affectedTemplates: number;
	affectedSessions: number;
}

export interface EditTemplatePayload extends Record<string, unknown> {
	templateId: string;
	templateName: string;
	fields: Record<string, unknown>;
}

export interface DeleteTemplatePayload extends Record<string, unknown> {
	templateId: string;
	templateName: string;
}

export async function handleProjectTemplateCrud(
	intent: Exclude<ProjectTemplateCrudIntent, { kind: "none" } | { kind: "classifier_failed" }>,
	args: { origin: "web" | "telegram"; threadId: string; telegramChatId?: string | null },
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const { origin, threadId, telegramChatId } = args;

	if (intent.kind === "edit_project") {
		return handleEditProject(intent, origin, threadId, telegramChatId ?? null);
	}
	if (intent.kind === "delete_project") {
		return handleDeleteProject(intent, origin, threadId, telegramChatId ?? null);
	}
	if (intent.kind === "edit_template") {
		return handleEditTemplate(intent, origin, threadId, telegramChatId ?? null);
	}
	return handleDeleteTemplate(intent, origin, threadId, telegramChatId ?? null);
}

async function handleEditProject(
	intent: Extract<ProjectTemplateCrudIntent, { kind: "edit_project" }>,
	origin: "web" | "telegram",
	threadId: string,
	telegramChatId: string | null,
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const project = await findProjectByName(intent.targetName);
	if (!project) {
		return {
			replyText: `I couldn't find a project named **${intent.targetName}**. Check Projects for the exact name.`,
			actionRequestId: null,
		};
	}

	if (Object.keys(intent.fields).length === 0) {
		return {
			replyText: `I understood you want to edit **${project.name}** but I couldn't determine which fields to change. Try: "rename project ${project.name} to <new name>" or "change default agent for ${project.name} to codex".`,
			actionRequestId: null,
		};
	}

	const validatedFields: Record<string, unknown> = {};

	if (typeof intent.fields.name === "string") {
		if (intent.fields.name.length === 0 || intent.fields.name.length > 80) {
			return {
				replyText: "Project name must be 1-80 characters. The proposed name is invalid.",
				actionRequestId: null,
			};
		}
		validatedFields.name = intent.fields.name;
	}

	if (typeof intent.fields.cwd === "string") {
		if (!intent.fields.cwd.startsWith("/")) {
			return {
				replyText: `The directory path must be absolute (start with /). Got: "${intent.fields.cwd}".`,
				actionRequestId: null,
			};
		}
		// Normalize cwd before storing in the payload so the inbox card shows
		// the same value that will be written to the DB (J-L2).
		validatedFields.cwd = normalizeCwd(intent.fields.cwd);
	}

	if ("defaultAgentType" in intent.fields) {
		validatedFields.defaultAgentType = intent.fields.defaultAgentType ?? null;
	}
	if ("defaultModel" in intent.fields) {
		validatedFields.defaultModel = intent.fields.defaultModel ?? null;
	}
	if ("defaultLaunchMode" in intent.fields) {
		validatedFields.defaultLaunchMode = intent.fields.defaultLaunchMode ?? null;
	}
	if ("githubRepoUrl" in intent.fields) {
		validatedFields.githubRepoUrl = intent.fields.githubRepoUrl ?? null;
	}
	if ("notes" in intent.fields) {
		validatedFields.notes = intent.fields.notes ?? null;
	}

	const fieldsSummary = Object.entries(validatedFields)
		.map(([k, v]) => `${k}: ${v === null ? "cleared" : `"${v}"`}`)
		.join(", ");

	const payload: EditProjectPayload = {
		projectId: project.id,
		projectName: project.name,
		fields: validatedFields,
	};

	const question = `Edit project **${project.name}** — set ${fieldsSummary}. Approve?`;

	const actionRequest = await createActionRequest({
		kind: "edit_project",
		question,
		payload,
		origin,
		askThreadId: threadId,
	});

	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, "Edit project");
	}

	return {
		replyText: `Queued an **edit** for **${project.name}** — approve in inbox.`,
		actionRequestId: actionRequest.id,
	};
}

async function handleDeleteProject(
	intent: Extract<ProjectTemplateCrudIntent, { kind: "delete_project" }>,
	origin: "web" | "telegram",
	threadId: string,
	telegramChatId: string | null,
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const project = await findProjectByName(intent.targetName);
	if (!project) {
		return {
			replyText: `I couldn't find a project named **${intent.targetName}**. Check Projects for the exact name.`,
			actionRequestId: null,
		};
	}

	// Block deletion while there are live sessions — prompt the user to clean up first.
	const activeSessions = await db
		.select({ status: sessions.status })
		.from(sessions)
		.where(eq(sessions.projectId, project.id));
	const liveActive = activeSessions.filter(
		(s) => s.status === "active" || s.status === "idle",
	).length;

	if (liveActive > 0) {
		return {
			replyText: `**${project.name}** has ${liveActive} active or idle session${liveActive === 1 ? "" : "s"} — stop or archive them first before deleting the project.`,
			actionRequestId: null,
		};
	}

	// Count impact at handler-time so the user sees it in the question and inbox card
	// before approving — the count is a snapshot; execute-time impact may differ.
	const [templateCountRow] = await db
		.select({ n: count() })
		.from(sessionTemplates)
		.where(eq(sessionTemplates.projectId, project.id));
	const affectedTemplates = templateCountRow?.n ?? 0;
	const affectedSessions = activeSessions.length;

	const payload: DeleteProjectPayload = {
		projectId: project.id,
		projectName: project.name,
		affectedTemplates,
		affectedSessions,
	};

	const impactParts: string[] = [];
	if (affectedTemplates > 0)
		impactParts.push(`${affectedTemplates} linked template${affectedTemplates === 1 ? "" : "s"}`);
	if (affectedSessions > 0)
		impactParts.push(
			`${affectedSessions} session${affectedSessions === 1 ? "" : "s"} will be disassociated`,
		);
	const impactClause = impactParts.length > 0 ? ` (${impactParts.join("; ")})` : "";

	const question = `Delete project **${project.name}**${impactClause}. Approve?`;

	const actionRequest = await createActionRequest({
		kind: "delete_project",
		question,
		payload,
		origin,
		askThreadId: threadId,
	});

	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, "Delete project");
	}

	return {
		replyText: `Queued a **delete** for **${project.name}** — approve in inbox.`,
		actionRequestId: actionRequest.id,
	};
}

async function handleEditTemplate(
	intent: Extract<ProjectTemplateCrudIntent, { kind: "edit_template" }>,
	origin: "web" | "telegram",
	threadId: string,
	telegramChatId: string | null,
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const template = await findTemplateByName(intent.targetName);
	if (!template) {
		return {
			replyText: `I couldn't find a template named **${intent.targetName}**. Check Templates for the exact name.`,
			actionRequestId: null,
		};
	}

	if (Object.keys(intent.fields).length === 0) {
		return {
			replyText: `I understood you want to edit template **${template.name}** but I couldn't determine which fields to change. Try: "rename template ${template.name} to <new name>".`,
			actionRequestId: null,
		};
	}

	const validatedFields: Record<string, unknown> = {};

	if (typeof intent.fields.name === "string") {
		if (intent.fields.name.length === 0 || intent.fields.name.length > 80) {
			return {
				replyText: "Template name must be 1-80 characters. The proposed name is invalid.",
				actionRequestId: null,
			};
		}
		validatedFields.name = intent.fields.name;
	}
	if (typeof intent.fields.description === "string") {
		validatedFields.description = intent.fields.description;
	}
	if (typeof intent.fields.taskPrompt === "string") {
		validatedFields.taskPrompt = intent.fields.taskPrompt;
	}
	if ("model" in intent.fields) {
		validatedFields.model = intent.fields.model ?? null;
	}

	const fieldsSummary = Object.entries(validatedFields)
		.map(([k, v]) => `${k}: ${v === null ? "cleared" : `"${v}"`}`)
		.join(", ");

	const payload: EditTemplatePayload = {
		templateId: template.id,
		templateName: template.name,
		fields: validatedFields,
	};

	const question = `Edit template **${template.name}** — set ${fieldsSummary}. Approve?`;

	const actionRequest = await createActionRequest({
		kind: "edit_template",
		question,
		payload,
		origin,
		askThreadId: threadId,
	});

	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, "Edit template");
	}

	return {
		replyText: `Queued an **edit** for template **${template.name}** — approve in inbox.`,
		actionRequestId: actionRequest.id,
	};
}

async function handleDeleteTemplate(
	intent: Extract<ProjectTemplateCrudIntent, { kind: "delete_template" }>,
	origin: "web" | "telegram",
	threadId: string,
	telegramChatId: string | null,
): Promise<{ replyText: string; actionRequestId: string | null }> {
	const template = await findTemplateByName(intent.targetName);
	if (!template) {
		return {
			replyText: `I couldn't find a template named **${intent.targetName}**. Check Templates for the exact name.`,
			actionRequestId: null,
		};
	}

	const payload: DeleteTemplatePayload = {
		templateId: template.id,
		templateName: template.name,
	};

	const question = `Delete template **${template.name}**. This action is permanent. Approve?`;

	const actionRequest = await createActionRequest({
		kind: "delete_template",
		question,
		payload,
		origin,
		askThreadId: threadId,
	});

	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, "Delete template");
	}

	return {
		replyText: `Queued a **delete** for template **${template.name}** — approve in inbox.`,
		actionRequestId: actionRequest.id,
	};
}

async function findProjectByName(name: string): Promise<{ id: string; name: string } | null> {
	const rows = await listProjects();
	const lower = name.toLowerCase();
	return rows.find((p) => p.name.toLowerCase() === lower) ?? null;
}

async function findTemplateByName(name: string): Promise<{ id: string; name: string } | null> {
	const rows = await db
		.select({ id: sessionTemplates.id, name: sessionTemplates.name })
		.from(sessionTemplates);
	const lower = name.toLowerCase();
	return rows.find((t) => t.name.toLowerCase() === lower) ?? null;
}
