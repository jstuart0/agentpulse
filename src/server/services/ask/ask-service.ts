import { and, desc, eq, isNull } from "drizzle-orm";
import type { AskMessageRole, AskThreadOrigin } from "../../../shared/types.js";
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
	type AlertRuleIntent,
	type BulkActionIntent,
	type LaunchIntent,
	type ProjectTemplateCrudIntent,
	type QaIntent,
	type ResumeIntent,
	type SessionActionIntent,
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

// Re-export so existing call sites that imported AskThreadOrigin from
// this service entry point keep working. Canonical definition is in
// `src/shared/types.ts` (Slice TYPE-2d).
export type { AskThreadOrigin };

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
	role: AskMessageRole;
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
	origin: AskThreadOrigin,
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

// === Slice F: gate table + runner ===
//
// Each gate is a {predicate, optional classifier, handler, optional preamble-label}
// record. The runner walks the table in order and short-circuits on the first
// gate whose handler returns non-null. Both runAskTurn (sync) and
// runAskTurnStream (streaming) consume this runner — they only differ in how
// they build the assistant message after the runner returns.
//
// Adding a new gate is one row in ASK_GATES. Both transports pick it up
// automatically.

/**
 * Per-turn context bundle passed into every gate's classify and handle lambda.
 * `origin`/`threadId`/`telegramChatId` and `askArgs.*` carry the same values
 * redundantly — `askArgs` matches the existing handler-call shape for direct
 * passthrough; the loose fields exist for gates (e.g. resume) whose handlers
 * take individual arguments rather than an askArgs struct. Both are always
 * constructed from the same source variables in both transport shells.
 */
interface AskGateCtx {
	origin: AskThreadOrigin;
	threadId: string;
	telegramChatId: string | null | undefined;
	// askArgs intentionally mirrors origin/threadId/telegramChatId — see comment above.
	askArgs: { origin: AskThreadOrigin; threadId: string; telegramChatId: string | null | undefined };
}

// Returned by a gate's classify function. `kind: "matched"` carries the typed
// intent; everything else is a control signal for the runner.
type ClassifierOutcome<I> =
	| { kind: "matched"; intent: I }
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string };

// One gate's specification, fully typed over its intent payload type `I`.
// The runner erases `I` via the `defineGate` helper so the array is uniform.
interface GateSpec<I> {
	/** Used in classifier-failed preamble: "I tried to detect a ${label} request…". Null = silent (no preamble even on failure). */
	label: string | null;
	/** Cheap predicate — returning false skips the classifier and handler entirely. */
	passes: (text: string, ctx: AskGateCtx) => boolean;
	/** Optional classifier. Heuristic gates (digest, search, channel-setup) omit this. */
	classify?: (text: string, ctx: AskGateCtx) => Promise<ClassifierOutcome<I>>;
	/** Handler. Returns `null` to fall through (e.g. search with no results); returns `{ replyText }` to short-circuit. */
	handle: (
		intent: I | null,
		text: string,
		ctx: AskGateCtx,
	) => Promise<{ replyText: string } | null>;
}

// Type-erased wrapper. `Gate[]` is the array type; each defineGate call closes
// over its own `I` at construction site, preserving internal type safety.
interface Gate {
	label: string | null;
	passes: (text: string, ctx: AskGateCtx) => boolean;
	classify?: (text: string, ctx: AskGateCtx) => Promise<ClassifierOutcome<unknown>>;
	handle: (intent: unknown, text: string, ctx: AskGateCtx) => Promise<{ replyText: string } | null>;
}

function defineGate<I>(spec: GateSpec<I>): Gate {
	return spec as unknown as Gate;
}

type GateRunResult =
	| { kind: "handled"; replyText: string }
	| { kind: "fallthrough"; preamble: string };

/**
 * Walk `ASK_GATES` in order. Short-circuits on the first gate whose handler
 * returns non-null. Accumulates a preamble string from classifier_failed
 * outcomes (silenced when `gate.label === null`). Returns either a handled
 * reply or a fallthrough with any accumulated preamble for the LLM shell.
 *
 * NOTE: `outcome` from one gate's `classify` call is never reused in another
 * gate's `handle` call — each iteration uses only its own gate's outcome.
 */
function article(label: string): string {
	return /^[aeiou]/i.test(label) ? "an" : "a";
}

async function runAskGates(text: string, ctx: AskGateCtx): Promise<GateRunResult> {
	let preamble = "";
	for (const gate of ASK_GATES) {
		if (!gate.passes(text, ctx)) continue;

		if (gate.classify) {
			const outcome = await gate.classify(text, ctx);
			if (outcome.kind === "matched") {
				const handled = await gate.handle(outcome.intent, text, ctx);
				if (handled) return { kind: "handled", replyText: handled.replyText };
				// Handler returned null — gate didn't actually match (e.g. search
				// with no results). Fall through to the next gate.
				continue;
			}
			if (outcome.kind === "classifier_failed" && !preamble && gate.label !== null) {
				preamble = `_(Heads up: I tried to detect ${article(gate.label)} ${gate.label} request but the classifier failed: ${outcome.error}. Answering as a general question.)_\n\n`;
			}
			// kind: "none" — fall through silently.
			continue;
		}

		// Heuristic gate (no classifier). Call handle directly with null intent.
		const handled = await gate.handle(null, text, ctx);
		if (handled) return { kind: "handled", replyText: handled.replyText };
		// null = fall through (e.g. handleNlSearch with no results).
	}
	return { kind: "fallthrough", preamble };
}

/**
 * ASK_GATES — ordered table of intent gates.
 *
 * Each gate's `classify` and `handle` are async functions called per-turn.
 * Only the array structure is static. `getCachedProjects()` and `db.select()`
 * inside lambdas run on each gate invocation.
 *
 * Gate order matches the original ladder exactly. Do not reorder without
 * reading the comments — several gates have explicit ordering constraints.
 */
const ASK_GATES: Gate[] = [
	// Gate 1: Per-session Q&A — read-only, no action_request. Runs before add-project so
	// session names aren't misinterpreted as project names. label=null: classifier_failed
	// is intentionally silent (no preamble) — pre-existing behavior, do not change.
	defineGate<QaIntent>({
		label: null,
		passes: (t) => qaGatePasses(t),
		classify: async (t) => {
			const r = await detectQaIntent(t);
			if (r.kind === "qa") return { kind: "matched", intent: r };
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			const r = await handleSessionQa(intent, ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 2: Add-project — kicks off draft via classifier; classifier_failed surfaces
	// a "project-creation" preamble.
	defineGate<Extract<LaunchIntent, { kind: "add_project" }>>({
		label: "project-creation",
		passes: (t) => addProjectGatePasses(t),
		classify: async (t) => {
			const r = await detectAddProjectIntent(t);
			if (r.kind === "add_project") return { kind: "matched", intent: r };
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			const r = await handleNewAddProjectIntent(intent, ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 3: Digest — heuristic gate, no classifier, never falls through when gate passes.
	defineGate<null>({
		label: null,
		passes: (t) => digestGatePasses(t),
		handle: async (_i, t) => ({ replyText: await handleDigestQuery(t) }),
	}),

	// Gate 4: NL search — heuristic; null result = no hits, fall through.
	defineGate<null>({
		label: null,
		passes: (t) => searchGatePasses(t),
		handle: async (_i, t) => {
			const reply = await handleNlSearch(t, getCachedProjects());
			return reply !== null ? { replyText: reply } : null;
		},
	}),

	// Gate 5: Bulk session action — must run BEFORE single-session gate (gate 6) so
	// "archive all completed sessions" doesn't fall through to the single-session
	// classifier (which would misfire or return intent:none).
	defineGate<BulkActionIntent>({
		label: "bulk session-action",
		passes: (t) => bulkActionGatePasses(t),
		classify: async (t) => {
			const projects = getCachedProjects();
			const r = await detectBulkActionIntent(
				t,
				projects.map((p) => p.name),
			);
			if (r.kind === "bulk_action") return { kind: "matched", intent: r };
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			const r = await handleBulkAction(intent, getCachedProjects(), ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 6: Single-session action — pin/unpin/add_note/rename execute immediately;
	// stop/archive/delete create action_request for approval.
	// NOTE: `kind === 'session_action'` with a falsy `intent` falls through silently
	// (no preamble). The `r.intent` guard in `classify` is intentional — see original
	// ladder comment at the sessionActionResult.intent check.
	defineGate<SessionActionIntent>({
		label: "session-action",
		passes: (t) => sessionActionGatePasses(t),
		classify: async (t) => {
			const r = await detectSessionActionIntent(t);
			if (r.kind === "session_action" && r.intent) return { kind: "matched", intent: r.intent };
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			const r = await handleSessionAction(intent, ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 7: Resume — checked before launch so "continue <name> with: …" resolves as
	// a session resume, not a project launch.
	defineGate<ResumeIntent>({
		label: "resume",
		passes: (t) => resumeGatePasses(t),
		classify: async (t) => {
			const projects = getCachedProjects();
			const r = await detectResumeIntent(
				t,
				projects.map((p) => p.name),
			);
			if (r.kind === "resume") return { kind: "matched", intent: r };
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			const r = await handleResumeIntent({
				intent,
				origin: ctx.origin,
				threadId: ctx.threadId,
				telegramChatId: ctx.telegramChatId,
			});
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 8: Project/template CRUD — edit/delete project or template. Runs after
	// resume so "rename project" doesn't confuse the resume gate.
	// Matches 4 kinds (edit_project, delete_project, edit_template, delete_template);
	// the classify lambda normalises all to a single matched intent.
	defineGate<
		Extract<
			ProjectTemplateCrudIntent,
			{ kind: "edit_project" | "delete_project" | "edit_template" | "delete_template" }
		>
	>({
		label: "project/template edit",
		passes: (t) => projectTemplateCrudGatePasses(t),
		classify: async (t) => {
			const projects = getCachedProjects();
			// DB select for template names runs only when the predicate passes.
			const templateRows = await db.select({ name: sessionTemplates.name }).from(sessionTemplates);
			const r = await detectProjectTemplateCrudIntent(
				t,
				projects.map((p) => p.name),
				templateRows.map((row) => row.name),
			);
			if (
				r.kind === "edit_project" ||
				r.kind === "delete_project" ||
				r.kind === "edit_template" ||
				r.kind === "delete_template"
			) {
				return { kind: "matched", intent: r };
			}
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			const r = await handleProjectTemplateCrud(intent, ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 9: Channel-setup — heuristic kind detection, no LLM needed. Runs after CRUD
	// so "add channel" doesn't trip CRUD verbs. Never falls through when gate passes.
	defineGate<null>({
		label: null,
		passes: (t) => channelSetupGatePasses(t),
		handle: async (_i, t, ctx) => {
			const r = await handleChannelSetupRequest(t, ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),

	// Gate 10: Alert-rule — runs after channel-setup; constrained rule types only.
	// Two matched arms (create_alert_rule + create_freeform_alert_rule); the
	// handle lambda dispatches internally.
	defineGate<
		Extract<AlertRuleIntent, { kind: "create_alert_rule" | "create_freeform_alert_rule" }>
	>({
		label: "alert-rule",
		passes: (t) => alertRuleGatePasses(t),
		classify: async (t) => {
			const projects = getCachedProjects();
			const r = await detectAlertRuleIntent(
				t,
				projects.map((p) => p.name),
			);
			if (r.kind === "create_alert_rule" || r.kind === "create_freeform_alert_rule") {
				return { kind: "matched", intent: r };
			}
			if (r.kind === "classifier_failed") return r;
			return { kind: "none" };
		},
		handle: async (intent, _t, ctx) => {
			if (!intent) return null;
			if (intent.kind === "create_alert_rule") {
				const r = await handleAlertRuleRequest(intent, ctx.askArgs);
				// actionRequestId intentionally discarded — not part of AskTurnResult contract.
				return { replyText: r.replyText };
			}
			const r = await handleFreeformAlertRuleRequest(intent, ctx.askArgs);
			// actionRequestId intentionally discarded — not part of AskTurnResult contract.
			return { replyText: r.replyText };
		},
	}),
];

export async function runAskTurn(input: AskTurnInput): Promise<AskTurnResult> {
	const { thread, userMessage, context, transcript, text } = await prepareTurn(input);

	const origin = input.origin ?? "web";
	const askArgs = { origin, threadId: thread.id, telegramChatId: input.telegramChatId };
	const ctx: AskGateCtx = {
		origin,
		threadId: thread.id,
		telegramChatId: input.telegramChatId,
		askArgs,
	};

	// 1. Open-draft continuation check — runs BEFORE any intent gate so that
	//    mid-draft replies (including "skip") are parsed by the draft handler.
	//    Stays outside ASK_GATES because its dispatch is on a precomputed DB row,
	//    not a text predicate.
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

	// 2. Run the 10-gate ladder via the shared runner.
	const gateResult = await runAskGates(text, ctx);
	if (gateResult.kind === "handled") {
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: gateResult.replyText,
			contextSessionIds: [],
		});
		return { thread, userMessage, assistantMessage, includedSessionIds: [] };
	}
	let preamble = gateResult.preamble;

	// 3. Launch-intent intercept — stays outside ASK_GATES because the cloneSpec
	//    branch fires on either matched arm, and the three-arm dispatch is structural.
	//    Runs after the user message is persisted so the thread exists.
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
			// 180s accommodates cold-load on local 20B+ models served via
			// Ollama/vLLM where the first request after model eviction can
			// take 60-90s before any tokens flow.
			timeoutMs: 180_000,
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
		const isTimeout = /timed out|timeout/i.test(message);
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: `${preamble}${
				isTimeout
					? "The LLM provider didn't respond in time — usually a cold model load. Try the same question again in a few seconds."
					: "I couldn't reach the LLM provider just now. See the inline error and check Settings → AI."
			}`,
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
	const ctx: AskGateCtx = {
		origin,
		threadId: thread.id,
		telegramChatId: input.telegramChatId,
		askArgs,
	};

	// 1. Open-draft continuation check — runs BEFORE any intent gate so that
	//    mid-draft replies (including "skip") are parsed by the draft handler.
	//    Stays outside ASK_GATES because its dispatch is on a precomputed DB row,
	//    not a text predicate.
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

	// 2. Run the 10-gate ladder via the shared runner.
	const gateResult = await runAskGates(text, ctx);
	if (gateResult.kind === "handled") {
		const assistantMessage = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: gateResult.replyText,
			contextSessionIds: [],
		});
		// Short-circuit: persist → start (includedSessionIds: []) → delta → done → return.
		// includedSessionIds is [] for all gate short-circuits — only the LLM fall-through
		// uses context.includedSessionIds, which the SSE client uses for context badges.
		yield { kind: "start", thread, userMessage, includedSessionIds: [] };
		yield { kind: "delta", delta: gateResult.replyText };
		yield { kind: "done", assistantMessage };
		return;
	}
	let preamble = gateResult.preamble;

	// 3. Launch-intent intercept — stays outside ASK_GATES because the cloneSpec
	//    branch fires on either matched arm, and the three-arm dispatch is structural.
	//    Runs after the user message is persisted so the thread exists.
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
			// ASYMMETRY 1: streaming writes llm.error without preamble — DO NOT add preamble here (sync prepends it).
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
			// Mirrors runAskTurn's 180s — a cold 20B+ model can take 60-90s
			// to emit its first streamed token.
			timeoutMs: 180_000,
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
		const isTimeout = /timed out|timeout/i.test(message);
		const errMsg = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content:
				preamble +
				// ASYMMETRY 2: streaming catch uses (collected.trim() || fallback) — DO NOT use sync's fixed string.
				(collected.trim() ||
					(isTimeout
						? "The LLM provider didn't respond in time — usually a cold model load. Try again in a few seconds."
						: "I couldn't reach the LLM provider just now. Check Settings → AI.")),
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
