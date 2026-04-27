import { and, eq, inArray } from "drizzle-orm";
import type { AgentType, LaunchMode } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import {
	type LaunchDisambiguationDraftFields,
	type NextQuestion,
	type ProjectChoiceSnapshot,
	aiPendingProjectDrafts,
} from "../../db/schema.js";
import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import type { CachedProject } from "../projects/cache.js";
import { handleAskLaunchIntent } from "./ask-launch-handler.js";
import type { LaunchIntent, TaskBrief } from "./launch-intent-detector.js";

// Sentinel marker embedded in the assistant's content so the web UI can
// render the picker as a structured component while Telegram + the SQL
// transcript both remain fully readable as plain text.
const PICKER_SENTINEL_FENCE = "ask-message-meta";

export interface ProjectPickerMeta {
	kind: "project_picker";
	draftId: string;
	choices: ProjectChoiceSnapshot[];
	taskHint?: string;
	taskBriefSummary?: string;
	telegramOrigin: boolean;
}

export function encodePickerMeta(meta: ProjectPickerMeta): string {
	return `\n\n\`\`\`${PICKER_SENTINEL_FENCE}\n${JSON.stringify(meta)}\n\`\`\``;
}

const PICKER_FENCE_RE = new RegExp(`\\n*\`\`\`${PICKER_SENTINEL_FENCE}\\n([\\s\\S]*?)\\n\`\`\``);

export function extractPickerMeta(
	content: string,
): { meta: ProjectPickerMeta; visibleText: string } | null {
	const match = content.match(PICKER_FENCE_RE);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]);
		if (parsed && parsed.kind === "project_picker" && Array.isArray(parsed.choices)) {
			return {
				meta: parsed as ProjectPickerMeta,
				visibleText: content.replace(PICKER_FENCE_RE, "").trim(),
			};
		}
	} catch {
		return null;
	}
	return null;
}

function renderPickerReplyText(choices: ProjectChoiceSnapshot[], telegramOrigin: boolean): string {
	if (choices.length === 0) {
		return [
			"You don't have any projects yet. Add your first project from **Settings → Projects**, or paste an absolute path here and I'll launch in that directory.",
		].join("\n");
	}
	const lines: string[] = [];
	lines.push(
		"Which project should I work in? Reply with a number, paste an absolute path, or say `new` to scaffold a fresh workspace.",
	);
	lines.push("");
	choices.forEach((c, i) => {
		lines.push(`${i + 1}. ${c.name}  (${c.cwd})`);
	});
	if (telegramOrigin) {
		lines.push("");
		lines.push("(Reply here in Telegram — answers are delivered through the same channel.)");
	}
	return lines.join("\n");
}

export interface CreateLaunchDisambiguationDraftArgs {
	threadId: string;
	origin: "web" | "telegram";
	channelId?: string | null;
	telegramChatId?: string | null;
	intent: Extract<LaunchIntent, { kind: "launch_needs_project" }>;
	originalMessage: string;
	projects: CachedProject[];
}

export interface DisambiguationResult {
	replyText: string;
	actionRequestId: string | null;
}

function sqlNow(): string {
	return new Date().toISOString();
}

/**
 * Persist a launch-disambiguation pending draft and return the assistant
 * reply text. Supersedes any open draft on the same thread (mirrors
 * handleNewAddProjectIntent).
 */
export async function createLaunchDisambiguationDraft(
	args: CreateLaunchDisambiguationDraftArgs,
): Promise<DisambiguationResult> {
	const { threadId, origin, channelId, intent, originalMessage, projects } = args;
	const now = sqlNow();

	await db
		.update(aiPendingProjectDrafts)
		.set({ status: "superseded", updatedAt: now })
		.where(
			and(
				eq(aiPendingProjectDrafts.askThreadId, threadId),
				inArray(aiPendingProjectDrafts.status, ["drafting", "pending_approval"]),
			),
		);

	const choices: ProjectChoiceSnapshot[] = projects.map((p) => ({
		id: p.id,
		name: p.name,
		cwd: p.cwd,
	}));

	const draftFields: LaunchDisambiguationDraftFields = {
		originalMessage,
		taskHint: intent.taskHint,
		taskBrief: intent.taskBrief,
		displayName: intent.displayName,
		agentType: intent.agentType,
		mode: intent.mode,
		proposedProjectChoices: choices,
	};

	// nextQuestion shape exists for the add-project flow's contract; we
	// re-use the slot to store a minimal placeholder so the row still has
	// a typed value. retryCount is bumped by the parser when the user
	// replies with garbage.
	const nextQuestion: NextQuestion = {
		field: "name",
		prompt: "project_choice",
		retryCount: 0,
	};

	const [row] = await db
		.insert(aiPendingProjectDrafts)
		.values({
			askThreadId: threadId,
			channelId: channelId ?? null,
			origin,
			kind: "launch_disambiguation",
			draftFields,
			nextQuestion,
			status: "drafting",
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	const telegramOrigin = origin === "telegram";
	const baseText = renderPickerReplyText(choices, telegramOrigin);

	// On Telegram we don't render structured UI, so just send the plain
	// numbered list. The bot's existing routing already passes user
	// replies through; the disambiguation parser handles them.
	if (origin === "telegram") {
		void sendTelegramPlainMessage(args.telegramChatId ?? null, baseText);
		return { replyText: baseText, actionRequestId: null };
	}

	const meta: ProjectPickerMeta = {
		kind: "project_picker",
		draftId: row.id,
		choices,
		taskHint: intent.taskHint,
		taskBriefSummary: intent.taskBrief?.summary,
		telegramOrigin,
	};
	return {
		replyText: `${baseText}${encodePickerMeta(meta)}`,
		actionRequestId: null,
	};
}

async function sendTelegramPlainMessage(chatId: string | null, text: string): Promise<void> {
	if (!chatId) return;
	const token = getTelegramBotToken();
	if (!token) return;
	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text }),
	}).catch((err) => {
		console.warn("[launch-disambiguation] telegram send failed:", err);
	});
}

const NEW_KEYWORDS = new Set(["new", "scratch", "scaffold"]);
const MAX_DISAMBIGUATION_RETRIES = 3;

export type ParsedReply =
	| { tag: "numeric_choice"; choice: ProjectChoiceSnapshot }
	| { tag: "absolute_path"; path: string }
	| { tag: "new_keyword" }
	| { tag: "fuzzy_match"; choice: ProjectChoiceSnapshot }
	| { tag: "ambiguous"; matches: ProjectChoiceSnapshot[] }
	| { tag: "unparsed" };

function expandHomePath(path: string): string {
	if (path.startsWith("~")) {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
		if (home) return home + path.slice(1);
	}
	return path;
}

/**
 * Pure parser for a launch-disambiguation reply. Exported for unit tests.
 * Returns the resolution kind so the handler can branch on it without
 * re-parsing.
 */
export function parseDisambiguationReply(
	reply: string,
	choices: ProjectChoiceSnapshot[],
): ParsedReply {
	const trimmed = reply.trim();
	const lower = trimmed.toLowerCase();
	if (NEW_KEYWORDS.has(lower)) return { tag: "new_keyword" };

	// Numeric pick — accepts "1", "1.", "01", "  2  ".
	const numericMatch = trimmed.match(/^0*(\d+)\.?$/);
	if (numericMatch) {
		const idx = Number.parseInt(numericMatch[1], 10) - 1;
		if (idx >= 0 && idx < choices.length) {
			return { tag: "numeric_choice", choice: choices[idx] };
		}
		return { tag: "unparsed" };
	}

	// Absolute path — / or ~/. Reject relative paths.
	if (trimmed.startsWith("/") || trimmed.startsWith("~/")) {
		return { tag: "absolute_path", path: expandHomePath(trimmed) };
	}

	// Fuzzy match against project names. Case-insensitive substring.
	const matches = choices.filter(
		(c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase()),
	);
	if (matches.length === 1) return { tag: "fuzzy_match", choice: matches[0] };
	if (matches.length > 1) return { tag: "ambiguous", matches };

	return { tag: "unparsed" };
}

export interface ResolveLaunchDisambiguationArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	reply: string;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
}

/**
 * Process a user reply against an open launch_disambiguation draft.
 * Possible outcomes:
 *   - numeric / fuzzy match  → reconstruct LaunchIntent.launch and hand
 *                              off to handleAskLaunchIntent. Draft is
 *                              marked superseded.
 *   - absolute path          → treat as ad-hoc cwd. Reconstruct as a
 *                              launch with the path's basename as the
 *                              project name; if no project matches, the
 *                              launch handler surfaces its existing
 *                              "unknown project" reply.
 *   - "new"                  → reply with a "not yet supported" message
 *                              and KEEP the draft open so the user can
 *                              still pick a number on their next reply.
 *   - garbage                → bump retry count; expire after 3.
 */
export async function resolveLaunchDisambiguation(
	args: ResolveLaunchDisambiguationArgs,
): Promise<DisambiguationResult> {
	const { draft, reply, origin, threadId, telegramChatId } = args;
	const fields = draft.draftFields as LaunchDisambiguationDraftFields;
	const choices = fields.proposedProjectChoices ?? [];
	const parsed = parseDisambiguationReply(reply, choices);
	const now = sqlNow();

	switch (parsed.tag) {
		case "numeric_choice":
		case "fuzzy_match": {
			const choice = parsed.choice;
			await markDraftResolved(draft.id);
			const reconstructed: Extract<LaunchIntent, { kind: "launch" }> = {
				kind: "launch",
				projectName: choice.name,
				mode: fields.mode as LaunchMode | undefined,
				agentType: fields.agentType as AgentType | undefined,
				taskHint: fields.taskHint,
				displayName: fields.displayName,
				taskBrief: fields.taskBrief as TaskBrief | undefined,
			};
			const result = await handleAskLaunchIntent({
				intent: reconstructed,
				origin,
				threadId,
				telegramChatId,
			});
			return result;
		}
		case "absolute_path": {
			// Ad-hoc cwd: try to find a project whose cwd matches; otherwise
			// fall through with a hint message — we need a registered project
			// for the launch flow's validation.
			await markDraftResolved(draft.id);
			const projectByCwd = choices.find((c) => c.cwd === parsed.path);
			if (projectByCwd) {
				const reconstructed: Extract<LaunchIntent, { kind: "launch" }> = {
					kind: "launch",
					projectName: projectByCwd.name,
					mode: fields.mode as LaunchMode | undefined,
					agentType: fields.agentType as AgentType | undefined,
					taskHint: fields.taskHint,
					displayName: fields.displayName,
					taskBrief: fields.taskBrief as TaskBrief | undefined,
				};
				return handleAskLaunchIntent({
					intent: reconstructed,
					origin,
					threadId,
					telegramChatId,
				});
			}
			return {
				replyText: `I don't have a project registered at \`${parsed.path}\`. Add one in Settings → Projects, or pick a number from the list above.`,
				actionRequestId: null,
			};
		}
		case "new_keyword": {
			// Keep the draft open — Slice 5 (work-area scaffolding) is gated
			// on the supervisor-side prelaunchActions handler. Tell the user
			// and let them pick a number on their next reply instead.
			return {
				replyText:
					"Scratch workspace scaffolding isn't available yet. Paste an absolute path instead, or pick a project from the list above.",
				actionRequestId: null,
			};
		}
		case "ambiguous": {
			const names = parsed.matches.map((m) => m.name).join(", ");
			await bumpRetryCount(draft, now);
			return {
				replyText: `That matches more than one project (${names}). Reply with a number from the list, or paste a different name.`,
				actionRequestId: null,
			};
		}
		default: {
			const newDraftAfter = await bumpRetryCount(draft, now);
			if (!newDraftAfter) {
				return {
					replyText:
						"I wasn't able to figure out which project to launch in after 3 tries. Start over by asking again.",
					actionRequestId: null,
				};
			}
			const baseText = renderPickerReplyText(choices, origin === "telegram");
			if (origin === "telegram") {
				return { replyText: `I didn't understand that. ${baseText}`, actionRequestId: null };
			}
			const meta: ProjectPickerMeta = {
				kind: "project_picker",
				draftId: draft.id,
				choices,
				taskHint: fields.taskHint,
				taskBriefSummary: fields.taskBrief?.summary,
				telegramOrigin: false,
			};
			return {
				replyText: `I didn't understand that. ${baseText}${encodePickerMeta(meta)}`,
				actionRequestId: null,
			};
		}
	}
}

async function markDraftResolved(draftId: string): Promise<void> {
	await db
		.update(aiPendingProjectDrafts)
		.set({ status: "superseded", updatedAt: sqlNow() })
		.where(eq(aiPendingProjectDrafts.id, draftId));
}

async function bumpRetryCount(
	draft: typeof aiPendingProjectDrafts.$inferSelect,
	now: string,
): Promise<typeof aiPendingProjectDrafts.$inferSelect | null> {
	const nq = draft.nextQuestion as NextQuestion;
	const newRetry = nq.retryCount + 1;
	if (newRetry >= MAX_DISAMBIGUATION_RETRIES) {
		await db
			.update(aiPendingProjectDrafts)
			.set({ status: "expired", updatedAt: now })
			.where(eq(aiPendingProjectDrafts.id, draft.id));
		return null;
	}
	const updated: NextQuestion = { ...nq, retryCount: newRetry };
	await db
		.update(aiPendingProjectDrafts)
		.set({ nextQuestion: updated, updatedAt: now })
		.where(eq(aiPendingProjectDrafts.id, draft.id));
	return { ...draft, nextQuestion: updated };
}
