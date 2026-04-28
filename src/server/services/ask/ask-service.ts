import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { askMessages, askThreads, sessionTemplates } from "../../db/schema.js";
import { getAdapter } from "../ai/llm/registry.js";
import type { LlmAdapter } from "../ai/llm/types.js";
import {
	type ProviderRecord,
	getDefaultProvider,
	getProvider,
	getProviderApiKey,
} from "../ai/providers-service.js";
import { getSemanticEnricher } from "../ai/semantic-enricher.js";
import { getCachedProjects } from "../projects/cache.js";
import {
	getOpenDraftForThread,
	handleAddProjectContinuation,
	handleNewAddProjectIntent,
} from "./ask-add-project-handler.js";
import {
	handleAlertRuleRequest,
	handleFreeformAlertRuleRequest,
} from "./ask-alert-rule-handler.js";
import { handleBulkAction } from "./ask-bulk-action-handler.js";
import { handleChannelSetupRequest } from "./ask-channel-handler.js";
import { handleProjectTemplateCrud } from "./ask-crud-handler.js";
import { handleDigestQuery } from "./ask-digest-handler.js";
import { handleAskLaunchIntent } from "./ask-launch-handler.js";
import { handleSessionQa } from "./ask-qa-handler.js";
import { handleResumeIntent } from "./ask-resume-handler.js";
import { handleNlSearch } from "./ask-search-handler.js";
import { handleSessionAction } from "./ask-session-action-handler.js";
import { ASK_SYSTEM_PROMPT, buildAskContext } from "./context-builder.js";
import {
	createLaunchCloneDraft,
	createLaunchDisambiguationDraft,
	resolveLaunchDisambiguation,
} from "./launch-disambiguation-handler.js";
import {
	addProjectGatePasses,
	alertRuleGatePasses,
	bulkActionGatePasses,
	channelSetupGatePasses,
	detectAddProjectIntent,
	detectAlertRuleIntent,
	detectBulkActionIntent,
	detectLaunchIntent,
	detectProjectTemplateCrudIntent,
	detectQaIntent,
	detectResumeIntent,
	detectSessionActionIntent,
	digestGatePasses,
	projectTemplateCrudGatePasses,
	qaGatePasses,
	resumeGatePasses,
	searchGatePasses,
	sessionActionGatePasses,
} from "./launch-intent-detector.js";
import { fetchSessionsById, resolveCandidateSessions } from "./resolver.js";

/**
 * End-to-end orchestration for an Ask turn:
 *   1. Find-or-create the thread.
 *   2. Insert the user message.
 *   3. Resolve candidate sessions from the message (or use the explicit
 *      list the UI passed in).
 *   4. Build the LLM context block.
 *   5. Call the default provider with system prompt + context + short
 *      conversation history.
 *   6. Persist the assistant reply with provenance.
 *
 * Everything is best-effort persisted: if the LLM call fails we still
 * save the user message and a placeholder assistant message with
 * `errorMessage` set, so the UI can render the failure in-thread.
 */

export type AskThreadOrigin = "web" | "telegram";

export interface AskThreadRecord {
	id: string;
	title: string | null;
	origin: AskThreadOrigin;
	telegramChatId: string | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

export interface AskMessageRecord {
	id: string;
	threadId: string;
	role: "user" | "assistant" | "system";
	content: string;
	contextSessionIds: string[] | null;
	tokensIn: number | null;
	tokensOut: number | null;
	errorMessage: string | null;
	createdAt: string;
}

function toThread(row: typeof askThreads.$inferSelect): AskThreadRecord {
	return {
		id: row.id,
		title: row.title,
		origin: (row.origin as AskThreadOrigin) ?? "web",
		telegramChatId: row.telegramChatId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt,
	};
}

function toMessage(row: typeof askMessages.$inferSelect): AskMessageRecord {
	return {
		id: row.id,
		threadId: row.threadId,
		role: row.role as AskMessageRecord["role"],
		content: row.content,
		contextSessionIds: (row.contextSessionIds as string[] | null) ?? null,
		tokensIn: row.tokensIn,
		tokensOut: row.tokensOut,
		errorMessage: row.errorMessage,
		createdAt: row.createdAt,
	};
}

export async function listThreads(limit = 50): Promise<AskThreadRecord[]> {
	const rows = await db
		.select()
		.from(askThreads)
		.where(isNull(askThreads.archivedAt))
		.orderBy(desc(askThreads.updatedAt))
		.limit(limit);
	return rows.map(toThread);
}

export async function getThread(id: string): Promise<AskThreadRecord | null> {
	const [row] = await db.select().from(askThreads).where(eq(askThreads.id, id)).limit(1);
	return row ? toThread(row) : null;
}

export async function listMessages(threadId: string): Promise<AskMessageRecord[]> {
	const rows = await db
		.select()
		.from(askMessages)
		.where(eq(askMessages.threadId, threadId))
		.orderBy(askMessages.createdAt);
	return rows.map(toMessage);
}

export async function archiveThread(id: string): Promise<boolean> {
	const now = new Date().toISOString();
	const res = await db
		.update(askThreads)
		.set({ archivedAt: now, updatedAt: now })
		.where(and(eq(askThreads.id, id), isNull(askThreads.archivedAt)))
		.returning();
	return res.length > 0;
}

async function ensureThread(input: {
	threadId?: string | null;
	firstMessage: string;
	origin?: AskThreadOrigin;
	telegramChatId?: string | null;
}): Promise<AskThreadRecord> {
	if (input.threadId) {
		const existing = await getThread(input.threadId);
		if (existing) return existing;
	}
	const title = input.firstMessage.trim().replace(/\s+/g, " ").slice(0, 80);
	const [row] = await db
		.insert(askThreads)
		.values({
			title,
			origin: input.origin ?? "web",
			telegramChatId: input.telegramChatId ?? null,
		})
		.returning();
	return toThread(row);
}

/**
 * Telegram maps each chat to a single persistent thread so context
 * carries across DMs. If the chat already has an active thread we
 * reuse it; otherwise a new telegram-origin thread is created with
 * `chat_id` pinned via the unique index.
 */
export async function findOrCreateTelegramThread(input: {
	telegramChatId: string;
	seedTitle: string;
}): Promise<AskThreadRecord> {
	const [existing] = await db
		.select()
		.from(askThreads)
		.where(and(eq(askThreads.telegramChatId, input.telegramChatId), isNull(askThreads.archivedAt)))
		.limit(1);
	if (existing) return toThread(existing);
	return ensureThread({
		threadId: null,
		firstMessage: input.seedTitle,
		origin: "telegram",
		telegramChatId: input.telegramChatId,
	});
}

async function appendMessage(input: {
	threadId: string;
	role: AskMessageRecord["role"];
	content: string;
	contextSessionIds?: string[] | null;
	tokensIn?: number | null;
	tokensOut?: number | null;
	errorMessage?: string | null;
}): Promise<AskMessageRecord> {
	const [row] = await db
		.insert(askMessages)
		.values({
			threadId: input.threadId,
			role: input.role,
			content: input.content,
			contextSessionIds: input.contextSessionIds ?? null,
			tokensIn: input.tokensIn ?? null,
			tokensOut: input.tokensOut ?? null,
			errorMessage: input.errorMessage ?? null,
		})
		.returning();
	// Touch the thread so it bubbles up in the sidebar.
	await db
		.update(askThreads)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(askThreads.id, input.threadId));
	return toMessage(row);
}

// Keep the history block small — the resolver already loaded a lot of
// session context, and local models (Qwen 8B) can choke on giant prompts.
const MAX_HISTORY_TURNS = 6;

function renderHistory(history: AskMessageRecord[]): string {
	const tail = history.slice(-MAX_HISTORY_TURNS * 2);
	if (tail.length === 0) return "";
	const lines = ["<history>"];
	for (const msg of tail) {
		const tag = msg.role === "user" ? "USER" : "ASSISTANT";
		lines.push(`${tag}: ${msg.content}`);
	}
	lines.push("</history>");
	return lines.join("\n");
}

export interface AskTurnInput {
	threadId?: string | null;
	message: string;
	/** Optional explicit session pins — UI @-mention flow. */
	sessionIds?: string[];
	/**
	 * Surface the message came in through. Set once at thread creation
	 * and used to pick the right delivery channel for the reply.
	 */
	origin?: AskThreadOrigin;
	/**
	 * Only meaningful when origin = telegram. The webhook handler passes
	 * the chat id so we bind the created thread to that chat.
	 */
	telegramChatId?: string | null;
}

export interface AskTurnResult {
	thread: AskThreadRecord;
	userMessage: AskMessageRecord;
	assistantMessage: AskMessageRecord;
	/** Sessions the context builder actually included. */
	includedSessionIds: string[];
}

async function resolveTelegramChannelId(
	origin: "web" | "telegram",
	chatId: string | null | undefined,
): Promise<string | null> {
	if (origin !== "telegram" || !chatId) return null;
	const { findActiveChannelByChatId } = await import("../channels/channels-service.js");
	const channel = await findActiveChannelByChatId(chatId);
	return channel?.id ?? null;
}

async function getDefaultLlm(): Promise<
	{ adapter: LlmAdapter; provider: ProviderRecord } | { error: string }
> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			error: "No default LLM provider configured. Open Settings → AI and pick a provider.",
		};
	}
	const full = await getProvider(provider.id);
	if (!full) return { error: "Default provider row disappeared — refresh Settings." };
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) return { error: "Default provider credentials are unreadable." };
	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});
	return { adapter, provider: full };
}

/**
 * Shared setup path: validates origin, creates/looks-up the thread,
 * persists the user message, runs the resolver + context builder, and
 * preps the transcript the LLM will see. Both the sync and streaming
 * turn implementations hand-off to the LLM from here.
 */
async function prepareTurn(input: AskTurnInput): Promise<{
	thread: AskThreadRecord;
	userMessage: AskMessageRecord;
	context: Awaited<ReturnType<typeof buildAskContext>>;
	transcript: string;
	text: string;
}> {
	const text = input.message.trim();
	if (!text) throw new Error("Empty message.");

	const callerOrigin: AskThreadOrigin = input.origin ?? "web";
	if (input.threadId) {
		const existing = await getThread(input.threadId);
		if (existing && existing.origin !== callerOrigin) {
			throw new Error(
				`This thread is ${existing.origin}-only. Start a new thread to reply from ${callerOrigin}.`,
			);
		}
	}

	const thread = await ensureThread({
		threadId: input.threadId,
		firstMessage: text,
		origin: callerOrigin,
		telegramChatId: input.telegramChatId,
	});
	const userMessage = await appendMessage({
		threadId: thread.id,
		role: "user",
		content: text,
	});

	const breadthHints = /\b(all|every|everything|across|overall|each)\b/i;
	const wantsBreadth = breadthHints.test(text);
	// Build the semantic enricher once per turn. Returns null when AI
	// isn't active or no default provider — the resolver then falls back
	// to lexical-only search automatically.
	const enricher = await getSemanticEnricher();
	const resolved =
		input.sessionIds && input.sessionIds.length > 0
			? await fetchSessionsById(input.sessionIds)
			: await resolveCandidateSessions({
					message: text,
					limit: wantsBreadth ? 20 : 5,
					fallbackToActive: true,
					enricher,
				});
	// Hand the FTS query to the context builder so per-session snapshots
	// include the events that *matched* — not just the most-recent 12.
	// Skip when the caller passed explicit sessionIds (no resolver query
	// to hand over).
	const ftsQuery = input.sessionIds && input.sessionIds.length > 0 ? undefined : text;
	const context = await buildAskContext({ resolved, ftsQuery });

	const history = await listMessages(thread.id);
	const transcript = [renderHistory(history), context.block, `USER: ${text}`]
		.filter(Boolean)
		.join("\n\n");
	return { thread, userMessage, context, transcript, text };
}

export async function runAskTurn(input: AskTurnInput): Promise<AskTurnResult> {
	const { thread, userMessage, context, transcript, text } = await prepareTurn(input);

	const origin = input.origin ?? "web";
	const askArgs = { origin, threadId: thread.id, telegramChatId: input.telegramChatId };

	// 1. Open-draft continuation check — runs BEFORE any intent gate so that
	//    mid-draft replies (including "skip") are parsed by the draft handler.
	const openDraft = await getOpenDraftForThread(thread.id);
	if (openDraft?.status === "drafting") {
		if (openDraft.kind === "launch_disambiguation") {
			const result = await resolveLaunchDisambiguation({
				draft: openDraft,
				reply: text,
				origin,
				threadId: thread.id,
				telegramChatId: input.telegramChatId,
			});
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: result.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		const contResult = await handleAddProjectContinuation(text, askArgs);
		if (contResult !== null) {
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: contResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
	}

	// 1b. Per-session Q&A gate — before add-project so session names are not
	//     misinterpreted as project names. Read-only; no action_request created.
	if (qaGatePasses(text)) {
		const qaIntent = await detectQaIntent(text);
		if (qaIntent.kind === "qa") {
			const qaResult = await handleSessionQa(qaIntent, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: qaResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		// classifier_failed falls through to LLM fallback — don't surface errors
	}

	// 2. Add-project gate + classifier
	let preamble = "";
	if (addProjectGatePasses(text)) {
		const addIntent = await detectAddProjectIntent(text);
		if (addIntent.kind === "add_project") {
			const addResult = await handleNewAddProjectIntent(addIntent, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: addResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (addIntent.kind === "classifier_failed") {
			preamble = `_(Heads up: I tried to detect a project-creation request but the classifier failed: ${addIntent.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2b. Digest gate — read-only, no action_request, no LLM call.
	if (digestGatePasses(text)) {
		const digestReply = await handleDigestQuery(text);
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: digestReply,
			contextSessionIds: [],
		});
		return { thread, userMessage, assistantMessage, includedSessionIds: [] };
	}

	// 2c. NL search gate — read-only, no action_request, no LLM call.
	//     Returns null on zero results so the LLM can answer conversationally.
	if (searchGatePasses(text)) {
		const searchReply = await handleNlSearch(text, getCachedProjects());
		if (searchReply !== null) {
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: searchReply,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
	}

	// 2d. Bulk session action gate — must run BEFORE single-session gate so that
	//     "archive all completed sessions" doesn't fall through to the single-session
	//     classifier (which would misfire or return intent:none).
	if (bulkActionGatePasses(text)) {
		const projects = getCachedProjects();
		const bulkResult = await detectBulkActionIntent(
			text,
			projects.map((p) => p.name),
		);
		if (bulkResult.kind === "bulk_action") {
			const bulkHandlerResult = await handleBulkAction(bulkResult, projects, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: bulkHandlerResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (bulkResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a bulk session-action request but the classifier failed: ${bulkResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2e. Session action gate — pin/unpin/add_note/rename execute immediately;
	//     stop/archive/delete create action_request for approval.
	if (sessionActionGatePasses(text)) {
		const sessionActionResult = await detectSessionActionIntent(text);
		if (sessionActionResult.kind === "session_action" && sessionActionResult.intent) {
			const actionResult = await handleSessionAction(sessionActionResult.intent, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: actionResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (sessionActionResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a session-action request but the classifier failed: ${sessionActionResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2f. Resume gate — checked before launch so "continue <name> with: …" resolves
	//     as a session resume, not a project launch. The classifier rejects project
	//     names and generic "continue" phrases that aren't session references.
	if (resumeGatePasses(text)) {
		const projects = getCachedProjects();
		const resumeResult = await detectResumeIntent(
			text,
			projects.map((p) => p.name),
		);
		if (resumeResult.kind === "resume") {
			const resumeHandlerResult = await handleResumeIntent({
				intent: resumeResult,
				origin,
				threadId: thread.id,
				telegramChatId: input.telegramChatId,
			});
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: resumeHandlerResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (resumeResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a resume request but the classifier failed: ${resumeResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2f. Project/template CRUD gate — edit/delete project or template.
	//     Runs after resume so "rename project" doesn't confuse the resume gate.
	if (projectTemplateCrudGatePasses(text)) {
		const projects = getCachedProjects();
		const templateRows = await db.select({ name: sessionTemplates.name }).from(sessionTemplates);
		const crudResult = await detectProjectTemplateCrudIntent(
			text,
			projects.map((p) => p.name),
			templateRows.map((t) => t.name),
		);
		if (
			crudResult.kind === "edit_project" ||
			crudResult.kind === "delete_project" ||
			crudResult.kind === "edit_template" ||
			crudResult.kind === "delete_template"
		) {
			const crudHandlerResult = await handleProjectTemplateCrud(crudResult, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: crudHandlerResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (crudResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a project/template edit request but the classifier failed: ${crudResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2g. Channel-setup gate — heuristic kind detection, no LLM needed.
	//     Runs after CRUD gate so "add channel" doesn't trip CRUD verbs.
	if (channelSetupGatePasses(text)) {
		const channelResult = await handleChannelSetupRequest(text, askArgs);
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: channelResult.replyText,
			contextSessionIds: [],
		});
		return { thread, userMessage, assistantMessage, includedSessionIds: [] };
	}

	// 2h. Alert-rule gate — runs after channel-setup; constrained rule types only.
	if (alertRuleGatePasses(text)) {
		const projects = getCachedProjects();
		const alertRuleResult = await detectAlertRuleIntent(
			text,
			projects.map((p) => p.name),
		);
		if (alertRuleResult.kind === "create_alert_rule") {
			const alertResult = await handleAlertRuleRequest(alertRuleResult, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: alertResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (alertRuleResult.kind === "create_freeform_alert_rule") {
			const alertResult = await handleFreeformAlertRuleRequest(alertRuleResult, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: alertResult.replyText,
				contextSessionIds: [],
			});
			return { thread, userMessage, assistantMessage, includedSessionIds: [] };
		}
		if (alertRuleResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect an alert-rule request but the classifier failed: ${alertRuleResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 3. Launch-intent intercept: runs after the user message is persisted so the
	//    thread exists. Short-circuits the normal Ask LLM call when a launch is queued.
	const intent = await detectLaunchIntent(text, getCachedProjects());

	// Slice 6d: when the classifier emitted a cloneSpec, route to the
	// cloner flow regardless of whether a project was named. The cloner
	// doesn't need a project — the URL is the path target. Empty-state
	// users (no projects) reach the cloner via this branch (ruby §13.8).
	if ((intent.kind === "launch" || intent.kind === "launch_needs_project") && intent.cloneSpec) {
		const channelId = await resolveTelegramChannelId(origin, input.telegramChatId);
		const cloneResult = await createLaunchCloneDraft({
			threadId: thread.id,
			origin,
			channelId,
			telegramChatId: input.telegramChatId,
			intent: { ...intent, cloneSpec: intent.cloneSpec },
			originalMessage: text,
		});
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: cloneResult.replyText,
			contextSessionIds: [],
		});
		return { thread, userMessage, assistantMessage, includedSessionIds: [] };
	}

	if (intent.kind === "launch") {
		const launchResult = await handleAskLaunchIntent({
			intent,
			origin,
			threadId: thread.id,
			telegramChatId: input.telegramChatId,
		});
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: launchResult.replyText,
			contextSessionIds: [],
		});
		return { thread, userMessage, assistantMessage, includedSessionIds: [] };
	}

	if (intent.kind === "launch_needs_project") {
		const channelId = await resolveTelegramChannelId(origin, input.telegramChatId);
		const disambResult = await createLaunchDisambiguationDraft({
			threadId: thread.id,
			origin,
			channelId,
			telegramChatId: input.telegramChatId,
			intent,
			originalMessage: text,
			projects: getCachedProjects(),
		});
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: disambResult.replyText,
			contextSessionIds: [],
		});
		return { thread, userMessage, assistantMessage, includedSessionIds: [] };
	}

	if (intent.kind === "classifier_failed" && !preamble) {
		preamble =
			"_(Heads up: I tried to check whether this was a session-launch request but the AI provider didn't respond — answering as a normal question.)_\n\n";
	}

	const llm = await getDefaultLlm();
	if ("error" in llm) {
		const errMsg = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: preamble + llm.error,
			contextSessionIds: context.includedSessionIds,
			errorMessage: llm.error,
		});
		return {
			thread,
			userMessage,
			assistantMessage: errMsg,
			includedSessionIds: context.includedSessionIds,
		};
	}

	try {
		const res = await llm.adapter.complete({
			systemPrompt: ASK_SYSTEM_PROMPT,
			transcriptPrompt: transcript,
			model: llm.provider.model,
			maxTokens: 800,
			temperature: 0.3,
			timeoutMs: 60_000,
		});
		const reply = preamble + (res.text.trim() || "(no response)");
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: reply,
			contextSessionIds: context.includedSessionIds,
			tokensIn: res.usage.inputTokens,
			tokensOut: res.usage.outputTokens,
		});
		return {
			thread,
			userMessage,
			assistantMessage,
			includedSessionIds: context.includedSessionIds,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: `${preamble}I couldn't reach the LLM provider just now. See the inline error and check Settings → AI.`,
			contextSessionIds: context.includedSessionIds,
			errorMessage: message,
		});
		return {
			thread,
			userMessage,
			assistantMessage,
			includedSessionIds: context.includedSessionIds,
		};
	}
}

export type AskStreamEvent =
	| {
			kind: "start";
			thread: AskThreadRecord;
			userMessage: AskMessageRecord;
			includedSessionIds: string[];
	  }
	| { kind: "delta"; delta: string }
	| { kind: "done"; assistantMessage: AskMessageRecord }
	| { kind: "error"; message: string; assistantMessage: AskMessageRecord };

/**
 * Streaming counterpart to runAskTurn. Persists the same rows the sync
 * path does, but yields intermediate `delta` events so an SSE caller
 * can render tokens as they arrive. The final `done` event carries the
 * complete persisted assistant message (so the client can stop caring
 * about the deltas once it lands).
 */
export async function* runAskTurnStream(input: AskTurnInput): AsyncIterable<AskStreamEvent> {
	const { thread, userMessage, context, transcript, text } = await prepareTurn(input);

	const origin = input.origin ?? "web";
	const askArgs = { origin, threadId: thread.id, telegramChatId: input.telegramChatId };

	// 1. Open-draft continuation check — runs BEFORE any intent gate.
	const openDraft = await getOpenDraftForThread(thread.id);
	if (openDraft?.status === "drafting") {
		if (openDraft.kind === "launch_disambiguation") {
			const result = await resolveLaunchDisambiguation({
				draft: openDraft,
				reply: text,
				origin,
				threadId: thread.id,
				telegramChatId: input.telegramChatId,
			});
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: result.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: result.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		const contResult = await handleAddProjectContinuation(text, askArgs);
		if (contResult !== null) {
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: contResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: contResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
	}

	// 1b. Per-session Q&A gate — streaming path short-circuit.
	if (qaGatePasses(text)) {
		const qaIntent = await detectQaIntent(text);
		if (qaIntent.kind === "qa") {
			const qaResult = await handleSessionQa(qaIntent, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: qaResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: qaResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		// classifier_failed falls through to LLM fallback
	}

	// 2. Add-project gate + classifier
	let preamble = "";
	if (addProjectGatePasses(text)) {
		const addIntent = await detectAddProjectIntent(text);
		if (addIntent.kind === "add_project") {
			const addResult = await handleNewAddProjectIntent(addIntent, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: addResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: addResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (addIntent.kind === "classifier_failed") {
			preamble = `_(Heads up: I tried to detect a project-creation request but the classifier failed: ${addIntent.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2b. Digest gate — streaming path short-circuit.
	if (digestGatePasses(text)) {
		const digestReply = await handleDigestQuery(text);
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: digestReply,
			contextSessionIds: [],
		});
		yield { kind: "start", thread, userMessage, includedSessionIds: [] };
		yield { kind: "delta", delta: digestReply };
		yield { kind: "done", assistantMessage };
		return;
	}

	// 2c. NL search gate — streaming path short-circuit.
	if (searchGatePasses(text)) {
		const searchReply = await handleNlSearch(text, getCachedProjects());
		if (searchReply !== null) {
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: searchReply,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: searchReply };
			yield { kind: "done", assistantMessage };
			return;
		}
	}

	// 2d. Bulk session action gate — streaming path short-circuit.
	//     Must run before single-session gate (same reason as sync path above).
	if (bulkActionGatePasses(text)) {
		const projects = getCachedProjects();
		const bulkResult = await detectBulkActionIntent(
			text,
			projects.map((p) => p.name),
		);
		if (bulkResult.kind === "bulk_action") {
			const bulkHandlerResult = await handleBulkAction(bulkResult, projects, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: bulkHandlerResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: bulkHandlerResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (bulkResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a bulk session-action request but the classifier failed: ${bulkResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2e. Session action gate — streaming path short-circuit.
	if (sessionActionGatePasses(text)) {
		const sessionActionResult = await detectSessionActionIntent(text);
		if (sessionActionResult.kind === "session_action" && sessionActionResult.intent) {
			const actionResult = await handleSessionAction(sessionActionResult.intent, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: actionResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: actionResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (sessionActionResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a session-action request but the classifier failed: ${sessionActionResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2f. Resume gate — streaming path short-circuit.
	if (resumeGatePasses(text)) {
		const projects = getCachedProjects();
		const resumeResult = await detectResumeIntent(
			text,
			projects.map((p) => p.name),
		);
		if (resumeResult.kind === "resume") {
			const resumeHandlerResult = await handleResumeIntent({
				intent: resumeResult,
				origin,
				threadId: thread.id,
				telegramChatId: input.telegramChatId,
			});
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: resumeHandlerResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: resumeHandlerResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (resumeResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a resume request but the classifier failed: ${resumeResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2f. Project/template CRUD gate — streaming path short-circuit.
	if (projectTemplateCrudGatePasses(text)) {
		const projects = getCachedProjects();
		const templateRows = await db.select({ name: sessionTemplates.name }).from(sessionTemplates);
		const crudResult = await detectProjectTemplateCrudIntent(
			text,
			projects.map((p) => p.name),
			templateRows.map((t) => t.name),
		);
		if (
			crudResult.kind === "edit_project" ||
			crudResult.kind === "delete_project" ||
			crudResult.kind === "edit_template" ||
			crudResult.kind === "delete_template"
		) {
			const crudHandlerResult = await handleProjectTemplateCrud(crudResult, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: crudHandlerResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: crudHandlerResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (crudResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect a project/template edit request but the classifier failed: ${crudResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 2g. Channel-setup gate — streaming path short-circuit.
	if (channelSetupGatePasses(text)) {
		const channelResult = await handleChannelSetupRequest(text, askArgs);
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: channelResult.replyText,
			contextSessionIds: [],
		});
		yield { kind: "start", thread, userMessage, includedSessionIds: [] };
		yield { kind: "delta", delta: channelResult.replyText };
		yield { kind: "done", assistantMessage };
		return;
	}

	// 2h. Alert-rule gate — streaming path short-circuit.
	if (alertRuleGatePasses(text)) {
		const projects = getCachedProjects();
		const alertRuleResult = await detectAlertRuleIntent(
			text,
			projects.map((p) => p.name),
		);
		if (alertRuleResult.kind === "create_alert_rule") {
			const alertResult = await handleAlertRuleRequest(alertRuleResult, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: alertResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: alertResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (alertRuleResult.kind === "create_freeform_alert_rule") {
			const alertResult = await handleFreeformAlertRuleRequest(alertRuleResult, askArgs);
			const assistantMessage = await appendMessage({
				threadId: thread.id,
				role: "assistant",
				content: alertResult.replyText,
				contextSessionIds: [],
			});
			yield { kind: "start", thread, userMessage, includedSessionIds: [] };
			yield { kind: "delta", delta: alertResult.replyText };
			yield { kind: "done", assistantMessage };
			return;
		}
		if (alertRuleResult.kind === "classifier_failed" && !preamble) {
			preamble = `_(Heads up: I tried to detect an alert-rule request but the classifier failed: ${alertRuleResult.error}. Answering as a general question.)_\n\n`;
		}
	}

	// 3. Launch-intent intercept for streaming path.
	const intent = await detectLaunchIntent(text, getCachedProjects());

	// Slice 6d: cloneSpec branch fires before the regular launch /
	// launch_needs_project paths (ruby §13.8 / bob §12.10).
	if ((intent.kind === "launch" || intent.kind === "launch_needs_project") && intent.cloneSpec) {
		const channelId = await resolveTelegramChannelId(origin, input.telegramChatId);
		const cloneResult = await createLaunchCloneDraft({
			threadId: thread.id,
			origin,
			channelId,
			telegramChatId: input.telegramChatId,
			intent: { ...intent, cloneSpec: intent.cloneSpec },
			originalMessage: text,
		});
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: cloneResult.replyText,
			contextSessionIds: [],
		});
		yield { kind: "start", thread, userMessage, includedSessionIds: [] };
		yield { kind: "delta", delta: cloneResult.replyText };
		yield { kind: "done", assistantMessage };
		return;
	}

	if (intent.kind === "launch") {
		const launchResult = await handleAskLaunchIntent({
			intent,
			origin,
			threadId: thread.id,
			telegramChatId: input.telegramChatId,
		});
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: launchResult.replyText,
			contextSessionIds: [],
		});
		yield { kind: "start", thread, userMessage, includedSessionIds: [] };
		yield { kind: "delta", delta: launchResult.replyText };
		yield { kind: "done", assistantMessage };
		return;
	}

	if (intent.kind === "launch_needs_project") {
		const channelId = await resolveTelegramChannelId(origin, input.telegramChatId);
		const disambResult = await createLaunchDisambiguationDraft({
			threadId: thread.id,
			origin,
			channelId,
			telegramChatId: input.telegramChatId,
			intent,
			originalMessage: text,
			projects: getCachedProjects(),
		});
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: disambResult.replyText,
			contextSessionIds: [],
		});
		yield { kind: "start", thread, userMessage, includedSessionIds: [] };
		yield { kind: "delta", delta: disambResult.replyText };
		yield { kind: "done", assistantMessage };
		return;
	}

	yield {
		kind: "start",
		thread,
		userMessage,
		includedSessionIds: context.includedSessionIds,
	};

	// For classifier_failed: emit preamble as first delta, then continue normally.
	if (!preamble && intent.kind === "classifier_failed") {
		preamble =
			"_(Heads up: I tried to check whether this was a session-launch request but the AI provider didn't respond — answering as a normal question.)_\n\n";
	}
	if (preamble) {
		yield { kind: "delta", delta: preamble };
	}

	const llm = await getDefaultLlm();
	if ("error" in llm) {
		const errMsg = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: llm.error,
			contextSessionIds: context.includedSessionIds,
			errorMessage: llm.error,
		});
		yield { kind: "error", message: llm.error, assistantMessage: errMsg };
		return;
	}

	// Lazy import to avoid making every caller of ask-service pull in
	// the LLM streaming helpers when they don't use streaming.
	const { streamWithFallback } = await import("../ai/llm/types.js");
	let collected = "";
	let tokensIn: number | undefined;
	let tokensOut: number | undefined;

	try {
		for await (const evt of streamWithFallback(llm.adapter, {
			systemPrompt: ASK_SYSTEM_PROMPT,
			transcriptPrompt: transcript,
			model: llm.provider.model,
			maxTokens: 800,
			temperature: 0.3,
			timeoutMs: 60_000,
		})) {
			if (evt.kind === "delta") {
				collected += evt.text;
				yield { kind: "delta", delta: evt.text };
			} else {
				tokensIn = evt.response.usage.inputTokens;
				tokensOut = evt.response.usage.outputTokens;
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const errMsg = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content:
				preamble +
				(collected.trim() || "I couldn't reach the LLM provider just now. Check Settings → AI."),
			contextSessionIds: context.includedSessionIds,
			errorMessage: message,
		});
		yield { kind: "error", message, assistantMessage: errMsg };
		return;
	}

	const reply = preamble + (collected.trim() || "(no response)");
	const assistantMessage = await appendMessage({
		threadId: thread.id,
		role: "assistant",
		content: reply,
		contextSessionIds: context.includedSessionIds,
		tokensIn: tokensIn ?? null,
		tokensOut: tokensOut ?? null,
	});
	yield { kind: "done", assistantMessage };
}
