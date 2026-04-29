import { and, eq, inArray } from "drizzle-orm";
import type { AskThreadOrigin } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import {
	type NextQuestion,
	type ProjectDraftFields,
	aiPendingProjectDrafts,
} from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import type { LaunchIntent } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

export interface HandleAddProjectArgs {
	origin: AskThreadOrigin;
	threadId: string;
	telegramChatId?: string | null;
}

export interface HandleAddProjectResult {
	replyText: string;
	actionRequestId: string | null;
}

// ---- Question sequence ------------------------------------------------
// Required fields first (name, cwd), then optional. Each entry defines
// the question prompt sent to the user when we need that field.
const QUESTION_SEQUENCE: Array<{
	field: keyof ProjectDraftFields;
	prompt: string;
	required: boolean;
}> = [
	{
		field: "name",
		// "must be unique" intentionally absent — uniqueness validated at execute time only
		prompt: "What should the project be named? (1–80 characters)",
		required: true,
	},
	{
		field: "cwd",
		prompt: "What is the working directory? (absolute path, e.g. /home/me/myapp)",
		required: true,
	},
	{
		field: "defaultAgentType",
		prompt:
			"Which agent type? Reply with a number:\n1. Claude Code\n2. Codex CLI\n3. Skip (no default)",
		required: false,
	},
	{
		field: "defaultLaunchMode",
		prompt: "Which launch mode?\n1. interactive_terminal\n2. headless\n3. managed_codex\n4. Skip",
		required: false,
	},
	{
		field: "defaultModel",
		prompt: "Which model? (e.g. claude-opus-4-5, or skip)",
		required: false,
	},
	{
		field: "githubRepoUrl",
		prompt: "GitHub repo URL? (or skip)",
		required: false,
	},
];

const MAX_RETRIES = 3;

// ---- Reply parsers (pure synchronous) --------------------------------

function parseName(reply: string): { ok: true; value: string } | { ok: false } {
	const v = reply.trim();
	if (v.length === 0 || v.length > 80) return { ok: false };
	return { ok: true, value: v };
}

function parseCwd(reply: string): { ok: true; value: string } | { ok: false } {
	const v = reply.trim();
	if (!v.startsWith("/")) return { ok: false };
	return { ok: true, value: v };
}

function parseDefaultAgentType(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim().toLowerCase();
	if (v === "1" || v === "claude" || v === "claude_code" || v.includes("claude code"))
		return { ok: true, value: "claude_code" };
	if (v === "2" || v === "codex" || v === "codex_cli" || v.includes("codex cli"))
		return { ok: true, value: "codex_cli" };
	if (v === "3" || v === "skip" || v === "none" || v === "no default")
		return { ok: true, value: null };
	return { ok: false };
}

function parseDefaultLaunchMode(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim().toLowerCase();
	if (v === "1" || v === "interactive_terminal" || v.includes("interactive"))
		return { ok: true, value: "interactive_terminal" };
	if (v === "2" || v === "headless") return { ok: true, value: "headless" };
	if (v === "3" || v === "managed_codex" || v.includes("managed"))
		return { ok: true, value: "managed_codex" };
	if (v === "4" || v === "skip" || v === "none") return { ok: true, value: null };
	return { ok: false };
}

function parseDefaultModel(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim();
	if (v.toLowerCase() === "skip" || v === "") return { ok: true, value: null };
	return { ok: true, value: v };
}

function parseGithubRepoUrl(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim();
	if (v.toLowerCase() === "skip" || v === "") return { ok: true, value: null };
	// Only accept https:// URLs per spec
	if (v.startsWith("https://")) return { ok: true, value: v };
	return { ok: false };
}

// Map each field to its parser for clean dispatch
const PARSERS: Record<
	keyof ProjectDraftFields,
	(reply: string) => { ok: true; value: string | null | undefined } | { ok: false }
> = {
	name: parseName,
	cwd: parseCwd,
	defaultAgentType: parseDefaultAgentType,
	defaultLaunchMode: parseDefaultLaunchMode,
	defaultModel: parseDefaultModel,
	githubRepoUrl: parseGithubRepoUrl,
};

// ---- Cancel keyword check (exact match after trim+lower) ---------------
// Checked BEFORE field-parse so the user can always exit regardless of
// which question is currently active.
const CANCEL_WORDS = new Set(["cancel", "abort", "stop drafting", "never mind", "nevermind"]);

export function isCancelKeyword(reply: string): boolean {
	return CANCEL_WORDS.has(reply.trim().toLowerCase());
}

// ---- Open-draft lookup ------------------------------------------------
export async function getOpenDraftForThread(
	threadId: string,
): Promise<typeof aiPendingProjectDrafts.$inferSelect | null> {
	const [row] = await db
		.select()
		.from(aiPendingProjectDrafts)
		.where(
			and(
				eq(aiPendingProjectDrafts.askThreadId, threadId),
				inArray(aiPendingProjectDrafts.status, ["drafting", "pending_approval"]),
			),
		)
		.limit(1);
	return row ?? null;
}

// ---- Determine the next unanswered question ---------------------------
function nextUnansweredQuestion(
	fields: Partial<ProjectDraftFields>,
): (typeof QUESTION_SEQUENCE)[number] | null {
	for (const q of QUESTION_SEQUENCE) {
		if (!(q.field in fields)) return q;
	}
	return null;
}

// ---- Draft summary text for approval ----------------------------------
function buildSummaryText(fields: Partial<ProjectDraftFields>): string {
	const lines = ["Here's the project I'll create:\n"];
	if (fields.name) lines.push(`  Name: ${fields.name}`);
	if (fields.cwd) lines.push(`  Directory: ${fields.cwd}`);
	if (fields.defaultAgentType) lines.push(`  Agent type: ${fields.defaultAgentType}`);
	if (fields.defaultLaunchMode) lines.push(`  Launch mode: ${fields.defaultLaunchMode}`);
	if (fields.defaultModel) lines.push(`  Model: ${fields.defaultModel}`);
	if (fields.githubRepoUrl) lines.push(`  GitHub repo: ${fields.githubRepoUrl}`);
	return lines.join("\n");
}

function sqlNow(): string {
	return new Date().toISOString();
}

// ---- Transition to pending_approval ----------------------------------
async function transitionToPendingApproval(
	draft: typeof aiPendingProjectDrafts.$inferSelect,
	telegramChatId: string | null | undefined,
): Promise<HandleAddProjectResult> {
	const fields = draft.draftFields as ProjectDraftFields;
	const summary = buildSummaryText(fields);

	let channelId: string | null = draft.channelId ?? null;
	if (draft.origin === "telegram" && telegramChatId && !channelId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	const question = summary;
	const actionRequest = await createActionRequest({
		kind: "add_project",
		question,
		origin: draft.origin as AskThreadOrigin,
		channelId,
		askThreadId: draft.askThreadId,
		payload: {
			draftFields: fields,
			draftId: draft.id,
		} as Record<string, unknown>,
	});

	const now = sqlNow();
	await db
		.update(aiPendingProjectDrafts)
		.set({
			status: "pending_approval",
			actionRequestId: actionRequest.id,
			updatedAt: now,
		})
		.where(eq(aiPendingProjectDrafts.id, draft.id));

	if (draft.origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(
			telegramChatId,
			actionRequest.id,
			summary,
			"New project request",
		);
	}

	const inboxRef =
		draft.origin === "telegram" ? "via the Telegram buttons I just sent" : "in the inbox";
	return {
		replyText: `${summary}\n\nApprove ${inboxRef} to create it, or decline to cancel.`,
		actionRequestId: actionRequest.id,
	};
}

// ---- Public API -------------------------------------------------------

/**
 * Called when a new add_project intent fires.
 * Supersedes any open draft for the same thread, then starts a new one.
 */
export async function handleNewAddProjectIntent(
	intent: Extract<LaunchIntent, { kind: "add_project" }>,
	args: HandleAddProjectArgs,
): Promise<HandleAddProjectResult> {
	const { origin, threadId, telegramChatId } = args;
	const now = sqlNow();

	// Supersede any open draft for this thread
	await db
		.update(aiPendingProjectDrafts)
		.set({ status: "superseded", updatedAt: now })
		.where(
			and(
				eq(aiPendingProjectDrafts.askThreadId, threadId),
				inArray(aiPendingProjectDrafts.status, ["drafting", "pending_approval"]),
			),
		);

	const fields: Partial<ProjectDraftFields> = { ...intent.initialFields };

	// Determine channel UUID for telegram origin
	let channelId: string | null = null;
	if (origin === "telegram" && telegramChatId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	const firstQuestion = nextUnansweredQuestion(fields);

	// If the initial fields already satisfy all required fields, go straight to approval
	if (!firstQuestion) {
		const [newDraft] = await db
			.insert(aiPendingProjectDrafts)
			.values({
				askThreadId: threadId,
				channelId,
				origin,
				draftFields: fields,
				nextQuestion: { field: "name", prompt: "", retryCount: 0 },
				status: "drafting",
				createdAt: now,
				updatedAt: now,
			})
			.returning();
		return transitionToPendingApproval(newDraft, telegramChatId);
	}

	const nextQ: NextQuestion = {
		field: firstQuestion.field,
		prompt: firstQuestion.prompt,
		retryCount: 0,
	};

	await db.insert(aiPendingProjectDrafts).values({
		askThreadId: threadId,
		channelId,
		origin,
		draftFields: fields,
		nextQuestion: nextQ,
		status: "drafting",
		createdAt: now,
		updatedAt: now,
	});

	return { replyText: firstQuestion.prompt, actionRequestId: null };
}

/**
 * Called when the user sends a reply while an open draft exists for this thread.
 * Returns null if no open draft in "drafting" status exists (caller falls through).
 */
export async function handleAddProjectContinuation(
	userReply: string,
	args: HandleAddProjectArgs,
): Promise<HandleAddProjectResult | null> {
	const { threadId, telegramChatId } = args;

	const draft = await getOpenDraftForThread(threadId);
	if (!draft || draft.status !== "drafting") return null;
	// A launch_disambiguation draft must not be parsed by the project-field
	// parsers — return null so the caller can route to the disambiguation
	// handler instead.
	if (draft.kind !== "add_project") return null;

	const now = sqlNow();

	// Cancel escape hatch — checked BEFORE parsing the reply
	if (isCancelKeyword(userReply)) {
		await db
			.update(aiPendingProjectDrafts)
			.set({ status: "superseded", updatedAt: now })
			.where(eq(aiPendingProjectDrafts.id, draft.id));
		return { replyText: "Project draft cancelled.", actionRequestId: null };
	}

	const nextQ = draft.nextQuestion as NextQuestion;
	const fields = { ...(draft.draftFields as ProjectDraftFields) };
	const parser = PARSERS[nextQ.field];
	const parsed = parser(userReply);

	if (!parsed.ok) {
		const newRetryCount = nextQ.retryCount + 1;
		if (newRetryCount >= MAX_RETRIES) {
			await db
				.update(aiPendingProjectDrafts)
				.set({ status: "expired", updatedAt: now })
				.where(eq(aiPendingProjectDrafts.id, draft.id));
			return {
				replyText:
					"I wasn't able to understand that field after 3 tries. Start over with 'add a project'.",
				actionRequestId: null,
			};
		}
		const updatedQ: NextQuestion = { ...nextQ, retryCount: newRetryCount };
		await db
			.update(aiPendingProjectDrafts)
			.set({
				nextQuestion: updatedQ,
				updatedAt: now,
			})
			.where(eq(aiPendingProjectDrafts.id, draft.id));
		return {
			replyText: `I didn't understand that. ${nextQ.prompt}`,
			actionRequestId: null,
		};
	}

	// Successful parse — store the value (null means "skipped optional field").
	// Cast through unknown so we can assign to the typed ProjectDraftFields dynamically.
	const mutableFields = fields as unknown as Record<keyof ProjectDraftFields, unknown>;
	if (parsed.value !== null && parsed.value !== undefined) {
		mutableFields[nextQ.field] = parsed.value;
	} else {
		// Explicitly mark optional skipped fields so nextUnansweredQuestion skips them
		mutableFields[nextQ.field] = null;
	}

	const nextQuestion = nextUnansweredQuestion(fields);
	if (!nextQuestion) {
		// All questions answered — update fields then transition to approval
		await db
			.update(aiPendingProjectDrafts)
			.set({
				draftFields: fields,
				updatedAt: now,
			})
			.where(eq(aiPendingProjectDrafts.id, draft.id));
		const refreshedDraft = { ...draft, draftFields: fields };
		return transitionToPendingApproval(refreshedDraft, telegramChatId);
	}

	const updatedQ: NextQuestion = {
		field: nextQuestion.field,
		prompt: nextQuestion.prompt,
		retryCount: 0,
	};

	await db
		.update(aiPendingProjectDrafts)
		.set({
			draftFields: fields,
			nextQuestion: updatedQ,
			updatedAt: now,
		})
		.where(eq(aiPendingProjectDrafts.id, draft.id));

	return { replyText: nextQuestion.prompt, actionRequestId: null };
}
