import { and, eq, inArray } from "drizzle-orm";
import type { AgentType, LaunchMode, PrelaunchAction } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import {
	type LaunchDisambiguationDraftFields,
	type NextQuestion,
	type PendingWorkspaceClone,
	type PendingWorkspaceScaffold,
	type ProjectChoiceSnapshot,
	aiPendingProjectDrafts,
} from "../../db/schema.js";
import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import { supervisorSupportsPrelaunch } from "../launch-compatibility.js";
import { slugifyTaskName } from "../name-generator.js";
import { type CachedProject, bumpVersionAndReload } from "../projects/cache.js";
import { createProject, listProjects } from "../projects/projects-service.js";
import { listSupervisors } from "../supervisor-registry.js";
import { type CloneRepoPrelaunchAction, cloneRepo } from "../workspace/clone.js";
import { getWorkspaceSettings } from "../workspace/feature.js";
import {
	type ScaffoldPrelaunchAction,
	WorkspacePathValidationError,
	scaffoldWorkArea,
} from "../workspace/scaffold.js";
import { handleAskLaunchIntent } from "./ask-launch-handler.js";
import type { CloneSpec, LaunchIntent, TaskBrief } from "./launch-intent-detector.js";

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
	// Slice 5d: server-computed flag — true iff at least one connected
	// supervisor advertises `can_scaffold_workarea`. Client uses this to
	// hide the "Scaffold a fresh workspace" CTA when no host can honor it
	// (ruby §11.5).
	canScaffold: boolean;
}

// Slice 5d: workspace_scaffold sentinel — the assistant turn after the
// user types `new`. Same fenced-block grammar as the picker, different
// `kind` discriminator (ruby §11.6).
export interface WorkspaceScaffoldMeta {
	kind: "workspace_scaffold";
	draftId: string;
	resolvedPath: string;
	taskSlug: string;
	actions: Array<{
		kind: string;
		path: string;
		gitInit?: boolean;
		seedClaudeMdPath?: string;
		seedClaudeMdBytes?: number;
	}>;
	canScaffold: boolean;
	suggestedHost?: string;
	telegramOrigin: boolean;
	error?: { code: string; message: string; path?: string };
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

// Workspace scaffold sentinel sharing the same fenced block as the picker —
// `extractWorkspaceScaffoldMeta` discriminates on `kind` (ruby §11.6).
export function encodeWorkspaceScaffoldMeta(meta: WorkspaceScaffoldMeta): string {
	return `\n\n\`\`\`${PICKER_SENTINEL_FENCE}\n${JSON.stringify(meta)}\n\`\`\``;
}

export function extractWorkspaceScaffoldMeta(
	content: string,
): { meta: WorkspaceScaffoldMeta; visibleText: string } | null {
	const match = content.match(PICKER_FENCE_RE);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]);
		if (parsed && parsed.kind === "workspace_scaffold" && Array.isArray(parsed.actions)) {
			return {
				meta: parsed as WorkspaceScaffoldMeta,
				visibleText: content.replace(PICKER_FENCE_RE, "").trim(),
			};
		}
	} catch {
		return null;
	}
	return null;
}

// Slice 6d: workspace_clone sentinel — fired when the classifier emits a
// `cloneSpec` and the cloner turn awaits user confirmation. Sibling to
// the scaffold sentinel; same fenced-block grammar, different `kind`
// discriminator (ruby §13.2 / bob §12.10).
export interface WorkspaceCloneMeta {
	kind: "workspace_clone";
	draftId: string;
	url: string;
	resolvedPath: string;
	branch?: string;
	depth?: number;
	timeoutSeconds: number;
	canClone: boolean;
	suggestedHost?: string;
	telegramOrigin: boolean;
	error?: { code: string; message: string; path?: string };
}

export function encodeWorkspaceCloneMeta(meta: WorkspaceCloneMeta): string {
	return `\n\n\`\`\`${PICKER_SENTINEL_FENCE}\n${JSON.stringify(meta)}\n\`\`\``;
}

export function extractWorkspaceCloneMeta(
	content: string,
): { meta: WorkspaceCloneMeta; visibleText: string } | null {
	const match = content.match(PICKER_FENCE_RE);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]);
		if (
			parsed &&
			parsed.kind === "workspace_clone" &&
			typeof parsed.url === "string" &&
			typeof parsed.resolvedPath === "string"
		) {
			return {
				meta: parsed as WorkspaceCloneMeta,
				visibleText: content.replace(PICKER_FENCE_RE, "").trim(),
			};
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Server-side capability decision for the picker / scaffolder UI: returns
 * true iff at least one currently-connected supervisor advertises the
 * `can_scaffold_workarea` feature. Used by the picker meta (`canScaffold`)
 * so the client doesn't surface a CTA the server can't honor (ruby §11.5).
 */
async function computeCanScaffold(): Promise<{ canScaffold: boolean; suggestedHost?: string }> {
	const all = await listSupervisors();
	const connected = all.filter((s) => s.status === "connected");
	for (const s of connected) {
		const features = s.capabilities?.features ?? [];
		if (features.includes("can_scaffold_workarea")) {
			return { canScaffold: true, suggestedHost: s.hostName };
		}
	}
	return { canScaffold: false };
}

/**
 * Slice 6d capability gate: returns true iff at least one currently-
 * connected supervisor advertises BOTH `can_run_prelaunch_actions` AND
 * `can_clone_repo`. Used by the cloner meta (`canClone`) so the client
 * doesn't surface a CTA the server can't honor (ruby §13.8 / bob §12.10).
 */
async function computeCanClone(): Promise<{ canClone: boolean; suggestedHost?: string }> {
	const all = await listSupervisors();
	const connected = all.filter((s) => s.status === "connected");
	for (const s of connected) {
		// Reuse the canonical capability check so the gate logic stays in
		// one place — same probe `pickFirstCapableSupervisor` will use at
		// dispatch time (bob §10.2 / §12.3).
		const probe: PrelaunchAction = {
			kind: "clone_repo",
			url: "https://example.com/x/y.git",
			intoPath: "/tmp",
		};
		if (supervisorSupportsPrelaunch(s, [probe]).ok) {
			return { canClone: true, suggestedHost: s.hostName };
		}
	}
	return { canClone: false };
}

function renderPickerReplyText(
	choices: ProjectChoiceSnapshot[],
	telegramOrigin: boolean,
	canScaffold: boolean,
): string {
	if (choices.length === 0) {
		const newClause = canScaffold
			? "Reply `new` to scaffold a fresh workspace, paste an absolute path to launch in an existing directory, or add a project from **Settings → Projects**."
			: "Paste an absolute path here and I'll launch in that directory, or add a project from **Settings → Projects**.";
		return `You don't have any projects yet. ${newClause}`;
	}
	const lines: string[] = [];
	const lead = canScaffold
		? "Which project should I work in? Reply with a number, paste an absolute path, or say `new` to scaffold a fresh workspace."
		: "Which project should I work in? Reply with a number or paste an absolute path.";
	lines.push(lead);
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
	const { canScaffold } = await computeCanScaffold();
	const baseText = renderPickerReplyText(choices, telegramOrigin, canScaffold);

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
		canScaffold,
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
	const { sendTelegramMessage } = await import("../channels/telegram.js");
	await sendTelegramMessage(token, chatId, text);
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

	// Slice 6d: when a workspace clone is awaiting confirmation, route the
	// reply to the clone-confirm parser. Mutually exclusive with
	// pendingScaffold — a draft has at most one of either (bob §12.10).
	if (fields.pendingClone) {
		return resolveCloneConfirm({
			draft,
			reply,
			origin,
			threadId,
			telegramChatId,
			fields,
		});
	}

	// Slice 5d: when a workspace scaffold is awaiting confirmation, route
	// the reply to the scaffold-confirm parser instead of the general
	// project-picker parser. The user is in a different state machine —
	// confirm / cancel / typed-path — and the reply grammar is disjoint
	// from the picker's numeric / fuzzy / absolute_path grammar.
	if (fields.pendingScaffold) {
		return resolveScaffoldConfirm({
			draft,
			reply,
			origin,
			threadId,
			telegramChatId,
			fields,
		});
	}

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
			return handleNewKeyword({
				draft,
				origin,
				threadId,
				fields,
				explicitPath: undefined,
			});
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
			const { canScaffold } = await computeCanScaffold();
			const baseText = renderPickerReplyText(choices, origin === "telegram", canScaffold);
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
				canScaffold,
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

// ─────────────────────────────────────────────────────────────────────
// Slice 5d: workspace_scaffold flow
// ─────────────────────────────────────────────────────────────────────

const CONFIRM_KEYWORDS = new Set(["yes", "y", "ok", "okay", "confirm"]);
const CANCEL_KEYWORDS = new Set(["no", "n", "cancel", "abort"]);

export type ParsedScaffoldReply =
	| { tag: "confirm" }
	| { tag: "cancel" }
	| { tag: "custom_path"; path: string }
	| { tag: "unparsed" };

export function parseScaffoldConfirmReply(reply: string): ParsedScaffoldReply {
	const trimmed = reply.trim();
	if (trimmed.length === 0) return { tag: "unparsed" };
	const lower = trimmed.toLowerCase();
	if (CONFIRM_KEYWORDS.has(lower)) return { tag: "confirm" };
	if (CANCEL_KEYWORDS.has(lower)) return { tag: "cancel" };
	if (trimmed.startsWith("/") || trimmed.startsWith("~/")) {
		return { tag: "custom_path", path: trimmed };
	}
	return { tag: "unparsed" };
}

interface HandleNewKeywordArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	origin: "web" | "telegram";
	threadId: string;
	fields: LaunchDisambiguationDraftFields;
	explicitPath: string | undefined;
}

/**
 * Compute (or recompute) the workspace scaffold for the open draft and
 * persist the result onto draftFields.pendingScaffold so the next reply
 * can route through the scaffold-confirm parser. Returns the assistant
 * reply with the workspace_scaffold sentinel embedded.
 */
async function handleNewKeyword(args: HandleNewKeywordArgs): Promise<DisambiguationResult> {
	const { draft, origin, fields, explicitPath } = args;
	const telegramOrigin = origin === "telegram";

	const { canScaffold, suggestedHost } = await computeCanScaffold();
	if (!canScaffold) {
		// No connected supervisor advertises can_scaffold_workarea — keep
		// the draft open and steer the user back to the picker (ruby §11.5).
		return {
			replyText:
				"None of your connected supervisors support scaffolding new workspaces yet. Pick a project from the list above, paste an absolute path, or update your supervisor binary on the host where you want this to land.",
			actionRequestId: null,
		};
	}

	const settings = (await getWorkspaceSettings()).workspace;

	// Slug: prefer displayName (already kebab in classifier output), fall
	// back to taskBrief/summary, then taskHint, then originalMessage. The
	// slugifier runs on each candidate; the first non-empty wins.
	const taskSummary = fields.taskBrief?.summary;
	const slugCandidates = [
		fields.displayName ?? "",
		taskSummary ?? "",
		fields.taskHint ?? "",
		fields.originalMessage ?? "",
	];
	let taskSlug = "";
	for (const candidate of slugCandidates) {
		const s = slugifyTaskName(candidate);
		if (s.length > 0) {
			taskSlug = s;
			break;
		}
	}
	if (taskSlug.length === 0) {
		taskSlug = `scratch-${Math.random().toString(36).slice(2, 10)}`;
	}

	// Collision snapshot from the projects table. The supervisor's own
	// path_not_empty check is the safety net; this is the advisory pass
	// (bob §10.4).
	const allProjects = await listProjects();
	const colliding = new Set<string>(allProjects.map((p) => p.cwd));

	let resolvedPath: string;
	let prelaunchActions: ScaffoldPrelaunchAction[];
	try {
		const result = await scaffoldWorkArea({
			taskSlug,
			taskSummary,
			workspaceSettings: settings,
			collidingPaths: colliding,
			explicitPath,
		});
		resolvedPath = result.resolvedPath;
		prelaunchActions = result.prelaunchActions;
	} catch (err) {
		if (err instanceof WorkspacePathValidationError) {
			// User-supplied custom path failed validation. Render the
			// error inline on a fresh scaffolder so the user can retry.
			const errorMeta: WorkspaceScaffoldMeta = {
				kind: "workspace_scaffold",
				draftId: draft.id,
				resolvedPath: explicitPath ?? "",
				taskSlug,
				actions: [],
				canScaffold,
				suggestedHost,
				telegramOrigin,
				error: {
					code: err.code,
					message: prelaunchErrorCopy(err.code, explicitPath ?? null),
					path: explicitPath ?? undefined,
				},
			};
			const visibleText = telegramOrigin
				? `That path didn't validate: ${prelaunchErrorCopy(err.code, explicitPath ?? null)} Reply with a different path, or \`cancel\` to back out.`
				: "That path didn't validate. Pick a different path or cancel.";
			if (telegramOrigin) {
				return { replyText: visibleText, actionRequestId: null };
			}
			return {
				replyText: `${visibleText}${encodeWorkspaceScaffoldMeta(errorMeta)}`,
				actionRequestId: null,
			};
		}
		// Any other error (e.g. WorkspaceCollisionExhaustedError) — surface
		// to the user as plain text and keep the picker draft alive.
		const message = err instanceof Error ? err.message : "Could not pick a workspace path.";
		return {
			replyText: `Couldn't scaffold a workspace: ${message} Try picking a project from the list, or paste an absolute path.`,
			actionRequestId: null,
		};
	}

	// Persist the pending scaffold onto the draft so the next reply can
	// confirm / cancel / customize without re-deriving the slug.
	const pending: PendingWorkspaceScaffold = {
		taskSlug,
		resolvedPath,
		actions: prelaunchActions.map((a) => ({
			kind: "scaffold_workarea" as const,
			path: a.path,
			gitInit: a.gitInit,
			seedClaudeMd: a.seedClaudeMd,
		})),
		suggestedHost,
	};
	const nextFields: LaunchDisambiguationDraftFields = {
		...fields,
		pendingScaffold: pending,
	};
	await db
		.update(aiPendingProjectDrafts)
		.set({
			draftFields: nextFields,
			// Reset retry counter when the user transitions into the
			// scaffold step so a fresh 3-strike budget applies to confirm
			// parsing.
			nextQuestion: { ...(draft.nextQuestion as NextQuestion), retryCount: 0 },
			updatedAt: sqlNow(),
		})
		.where(eq(aiPendingProjectDrafts.id, draft.id));

	const visibleText = renderScaffoldVisibleText({
		resolvedPath,
		suggestedHost,
		telegramOrigin,
	});
	if (telegramOrigin) {
		return { replyText: visibleText, actionRequestId: null };
	}

	const meta: WorkspaceScaffoldMeta = {
		kind: "workspace_scaffold",
		draftId: draft.id,
		resolvedPath,
		taskSlug,
		actions: prelaunchActions.map((a) => ({
			kind: a.kind,
			path: a.path,
			gitInit: a.gitInit,
			seedClaudeMdPath: a.seedClaudeMd?.path,
			seedClaudeMdBytes: a.seedClaudeMd?.content
				? new TextEncoder().encode(a.seedClaudeMd.content).length
				: undefined,
		})),
		canScaffold,
		suggestedHost,
		telegramOrigin,
	};
	return {
		replyText: `${visibleText}${encodeWorkspaceScaffoldMeta(meta)}`,
		actionRequestId: null,
	};
}

function renderScaffoldVisibleText(args: {
	resolvedPath: string;
	suggestedHost: string | undefined;
	telegramOrigin: boolean;
}): string {
	const hostClause = args.suggestedHost ? ` on **${args.suggestedHost}**` : "";
	const lines: string[] = [];
	lines.push(`I'll create a fresh workspace${hostClause} at \`${args.resolvedPath}\`.`);
	lines.push("");
	lines.push("Reply `yes` to confirm, paste a different absolute path, or `cancel` to back out.");
	if (args.telegramOrigin) {
		lines.push("");
		lines.push("(Reply here in Telegram — answers are delivered through the same channel.)");
	}
	return lines.join("\n");
}

interface ResolveScaffoldConfirmArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	reply: string;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
	fields: LaunchDisambiguationDraftFields;
}

async function resolveScaffoldConfirm(
	args: ResolveScaffoldConfirmArgs,
): Promise<DisambiguationResult> {
	const { draft, reply, origin, threadId, telegramChatId, fields } = args;
	const pending = fields.pendingScaffold;
	if (!pending) {
		// Defense-in-depth: caller guarantees this; treat as unparsed if
		// the field is somehow missing.
		await markDraftResolved(draft.id);
		return {
			replyText: "Workspace draft expired. Ask again to retry.",
			actionRequestId: null,
		};
	}

	const parsed = parseScaffoldConfirmReply(reply);
	const now = sqlNow();

	switch (parsed.tag) {
		case "cancel": {
			// Hard delete so the draft slot is freed for the next ask
			// (ruby §11.1: "Cancelled — say `new` again or pick a project").
			await db.delete(aiPendingProjectDrafts).where(eq(aiPendingProjectDrafts.id, draft.id));
			return {
				replyText:
					"Cancelled. Say `new` again or pick a project from the list to launch elsewhere.",
				actionRequestId: null,
			};
		}
		case "custom_path": {
			// Re-invoke the scaffold pipeline with the new explicit path.
			// Validation errors render as a workspace_scaffold sentinel
			// with `error` set so the recovery UI is identical to the
			// initial UI (ruby §11.2).
			return handleNewKeyword({
				draft,
				origin,
				threadId,
				fields,
				explicitPath: parsed.path,
			});
		}
		case "confirm": {
			return executeScaffoldConfirm({
				draft,
				origin,
				threadId,
				telegramChatId,
				fields,
				pending,
			});
		}
		default: {
			// Garbage input — bump the retry counter (mirrors picker
			// behavior). After 3 misses, the draft expires and the user
			// has to start over.
			const newDraftAfter = await bumpRetryCount(draft, now);
			if (!newDraftAfter) {
				return {
					replyText:
						"I wasn't able to figure out whether to confirm or cancel after 3 tries. Start over by asking again.",
					actionRequestId: null,
				};
			}
			const telegramOrigin = origin === "telegram";
			const visibleText = renderScaffoldVisibleText({
				resolvedPath: pending.resolvedPath,
				suggestedHost: pending.suggestedHost,
				telegramOrigin,
			});
			if (telegramOrigin) {
				return {
					replyText: `I didn't understand that. ${visibleText}`,
					actionRequestId: null,
				};
			}
			const meta: WorkspaceScaffoldMeta = {
				kind: "workspace_scaffold",
				draftId: draft.id,
				resolvedPath: pending.resolvedPath,
				taskSlug: pending.taskSlug,
				actions: pending.actions.map((a) => ({
					kind: a.kind,
					path: a.path,
					gitInit: a.gitInit,
					seedClaudeMdPath: a.seedClaudeMd?.path,
					seedClaudeMdBytes: a.seedClaudeMd?.content
						? new TextEncoder().encode(a.seedClaudeMd.content).length
						: undefined,
				})),
				canScaffold: true,
				suggestedHost: pending.suggestedHost,
				telegramOrigin: false,
			};
			return {
				replyText: `I didn't understand that. ${visibleText}${encodeWorkspaceScaffoldMeta(meta)}`,
				actionRequestId: null,
			};
		}
	}
}

interface ExecuteScaffoldConfirmArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
	fields: LaunchDisambiguationDraftFields;
	pending: PendingWorkspaceScaffold;
}

async function executeScaffoldConfirm(
	args: ExecuteScaffoldConfirmArgs,
): Promise<DisambiguationResult> {
	const { draft, origin, threadId, telegramChatId, fields, pending } = args;

	// Ensure the project name is unique. createProject's findCwdConflict
	// already gates by cwd, but a name clash (someone else registered
	// "plan-caching" under a different cwd) would still 409 — append a
	// 4-char suffix in that case.
	let projectName = pending.taskSlug;
	const existing = await listProjects();
	const usedNames = new Set(existing.map((p) => p.name));
	if (usedNames.has(projectName)) {
		projectName = `${projectName}-${Math.random().toString(36).slice(2, 6)}`;
	}

	const created = await createProject({
		name: projectName,
		cwd: pending.resolvedPath,
		tags: ["scratch", "ai-initiated"],
	});
	if (created.conflict) {
		// Cwd already owned by another project — surface inline; keep the
		// draft open so the user can pick a different path.
		return {
			replyText: `Couldn't register the scratch workspace: a project at \`${pending.resolvedPath}\` already exists. Reply with a different absolute path, or \`cancel\` to back out.`,
			actionRequestId: null,
		};
	}
	if (!created.project) {
		return {
			replyText:
				"Couldn't register the scratch workspace. Reply with a different absolute path, or `cancel` to back out.",
			actionRequestId: null,
		};
	}

	// Refresh project cache so handleAskLaunchIntent's getProjectByName()
	// can resolve the brand-new row.
	await bumpVersionAndReload();

	await markDraftResolved(draft.id);

	const reconstructed: Extract<LaunchIntent, { kind: "launch" }> = {
		kind: "launch",
		projectName: created.project.name,
		mode: fields.mode as LaunchMode | undefined,
		agentType: fields.agentType as AgentType | undefined,
		taskHint: fields.taskHint,
		displayName: fields.displayName,
		taskBrief: fields.taskBrief as TaskBrief | undefined,
	};
	const prelaunchActions: PrelaunchAction[] = pending.actions.map((a) => ({
		kind: "scaffold_workarea" as const,
		path: a.path,
		gitInit: a.gitInit,
		seedClaudeMd: a.seedClaudeMd,
	}));
	return handleAskLaunchIntent({
		intent: reconstructed,
		origin,
		threadId,
		telegramChatId,
		prelaunchActions,
	});
}

/**
 * Map a PrelaunchErrorCode (or workspace path validation code) to the
 * user-facing copy from ruby's §11.2 / §13.3 table. Path interpolation is
 * permitted; `path` is the user-supplied value when available.
 */
export function prelaunchErrorCopy(code: string, path: string | null): string {
	switch (code) {
		case "path_not_absolute":
			return "That path isn't absolute. Use a path starting with `/` or `~/`.";
		case "path_traversal_rejected":
			return "Path can't contain `..` — that's a security guardrail.";
		case "path_outside_trusted_roots":
			return "That path is outside the directories AgentPulse is allowed to write to. Pick a path under your home directory.";
		case "symlink_rejected":
			return "That path traverses a symlink that leaves your home directory. Pick a different path.";
		case "path_not_empty":
			return path
				? `\`${path}\` already has files in it. Pick a different location, or cd to that directory and ask me to launch there instead.`
				: "That path already has files in it. Pick a different location.";
		case "permission_denied":
			return path
				? `I don't have permission to write to \`${path}\`. Pick a path under your home directory (\`~/...\`).`
				: "I don't have permission to write there. Pick a path under your home directory (`~/...`).";
		case "disk_full":
			return "Can't create the workspace — your disk is full.";
		case "git_init_failed":
			return "Created the directory, but `git init` failed. The host may not have git installed.";
		case "claude_md_write_failed":
			return "Created the directory, but writing CLAUDE.md failed (file integrity check failed).";
		case "unknown_action_kind":
			return "AgentPulse and the supervisor are out of sync — the supervisor doesn't recognize this action. Update the supervisor binary.";
		// Slice 6d: clone-specific PrelaunchErrorCode entries (ruby §13.3).
		case "clone_url_invalid":
			return "That URL doesn't parse as a git repository URL. Reply with a corrected URL or `cancel`.";
		case "clone_scheme_disallowed":
			return "That URL scheme is disabled. Open Settings → Workspaces → Git clone defaults to allow it, or use an HTTPS URL.";
		case "clone_credentials_in_url":
			return "That URL contains embedded credentials. Use SSH with key auth, or store credentials in a git credential helper — never put them in the URL.";
		case "clone_target_exists":
			return path
				? `\`${path}\` already has files in it. Pick a different location, or cd to that directory and ask me to launch there instead.`
				: "That path already has files in it. Pick a different location.";
		case "clone_failed":
			return "`git clone` failed. This usually means auth, network, or a wrong URL. Reply with a different URL or open Settings → Workspaces if you need to allow SSH.";
		case "clone_timeout":
			return "The clone took longer than the configured timeout. Open Settings → Workspaces to bump it, or reply with a shallow clone.";
		default:
			return "Workspace scaffolding failed. Try a different path or pick a project from the list.";
	}
}

// ─────────────────────────────────────────────────────────────────────
// Slice 6d: workspace_clone flow
// ─────────────────────────────────────────────────────────────────────

export type ParsedCloneReply =
	| { tag: "confirm" }
	| { tag: "cancel" }
	| { tag: "custom_path"; path: string }
	| { tag: "branch_override"; branch: string }
	| { tag: "depth_override"; depth: number }
	| { tag: "unparsed" };

/**
 * Pure parser for replies on an open workspace_clone draft. Sibling to
 * parseScaffoldConfirmReply, but additionally recognizes "branch <name>"
 * and "depth <n>" so power users can edit the parsed cloneSpec without
 * starting over (ruby §13.2 More options).
 */
export function parseCloneConfirmReply(reply: string): ParsedCloneReply {
	const trimmed = reply.trim();
	if (trimmed.length === 0) return { tag: "unparsed" };
	const lower = trimmed.toLowerCase();
	if (CONFIRM_KEYWORDS.has(lower)) return { tag: "confirm" };
	if (CANCEL_KEYWORDS.has(lower)) return { tag: "cancel" };

	// "branch dev" / "branch=dev"
	const branchMatch = trimmed.match(/^branch[\s=:]+(.+)$/i);
	if (branchMatch) {
		const branch = branchMatch[1].trim();
		if (branch.length > 0) return { tag: "branch_override", branch };
	}

	// "depth 1" / "depth=1"
	const depthMatch = trimmed.match(/^depth[\s=:]+(\d+)$/i);
	if (depthMatch) {
		const depth = Number.parseInt(depthMatch[1], 10);
		if (Number.isInteger(depth) && depth > 0) return { tag: "depth_override", depth };
	}

	if (trimmed.startsWith("/") || trimmed.startsWith("~/")) {
		return { tag: "custom_path", path: trimmed };
	}
	return { tag: "unparsed" };
}

export interface CreateLaunchCloneDraftArgs {
	threadId: string;
	origin: "web" | "telegram";
	channelId?: string | null;
	telegramChatId?: string | null;
	intent: Extract<LaunchIntent, { kind: "launch" } | { kind: "launch_needs_project" }> & {
		cloneSpec: CloneSpec;
	};
	originalMessage: string;
}

/**
 * Slice 6d entry point: when the classifier emitted a `cloneSpec`,
 * persist a launch_disambiguation draft with `pendingClone` populated
 * and return the assistant reply with the workspace_clone sentinel
 * embedded. Sibling to `createLaunchDisambiguationDraft` (which renders
 * the picker for clone-less launches).
 *
 * The draft is reused for confirm/cancel/custom-path/edit-options
 * follow-ups in `resolveLaunchDisambiguation`. Supersedes any open draft
 * on the same thread.
 */
export async function createLaunchCloneDraft(
	args: CreateLaunchCloneDraftArgs,
): Promise<DisambiguationResult> {
	const { threadId, origin, channelId, intent, originalMessage } = args;
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

	const draftFields: LaunchDisambiguationDraftFields = {
		originalMessage,
		taskHint: intent.taskHint,
		taskBrief: intent.taskBrief,
		displayName: intent.displayName,
		agentType: intent.agentType,
		mode: intent.mode,
		// The cloner doesn't need a project — but we still snapshot the
		// proposedProjectChoices slot for shape consistency. Empty when no
		// projects exist; preserved if they do (in case the user later
		// cancels the cloner and we want to fall back to the picker — out
		// of scope for v1, but the snapshot is cheap).
		proposedProjectChoices: [],
	};

	const nextQuestion: NextQuestion = {
		field: "name",
		prompt: "clone_choice",
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

	return handleCloneIntent({
		draft: row,
		origin,
		threadId,
		telegramChatId: args.telegramChatId,
		fields: draftFields,
		cloneSpec: intent.cloneSpec,
		explicitPath: undefined,
	});
}

interface HandleCloneIntentArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
	fields: LaunchDisambiguationDraftFields;
	cloneSpec: CloneSpec;
	explicitPath: string | undefined;
}

/**
 * Compute (or recompute) the workspace clone for the open draft and
 * persist the result onto draftFields.pendingClone so the next reply
 * can confirm / cancel / customize without re-running validation.
 * Returns the assistant reply with the workspace_clone sentinel embedded.
 *
 * Sibling to `handleNewKeyword` (Slice 5d) but on the cloner state
 * machine. URL policy is enforced server-side via cloneRepo's call to
 * validateCloneUrlPolicy; the supervisor revalidates per §12.4.
 */
async function handleCloneIntent(args: HandleCloneIntentArgs): Promise<DisambiguationResult> {
	const { draft, origin, fields, cloneSpec, explicitPath } = args;
	const telegramOrigin = origin === "telegram";

	const { canClone, suggestedHost } = await computeCanClone();
	if (!canClone) {
		// No connected supervisor advertises can_clone_repo — keep the
		// draft open, surface a steering message (ruby §13.8). Mirrors
		// the no-scaffold no-capability response.
		return {
			replyText:
				"None of your connected supervisors can clone repositories yet. Update the supervisor binary on the host where you want this to land, or pick an existing project.",
			actionRequestId: null,
		};
	}

	const settings = await getWorkspaceSettings();
	const taskSummary = fields.taskBrief?.summary;

	// Slug: prefer displayName / taskBrief.summary / taskHint; fall back
	// to repo basename inside cloneRepo when none yields a usable slug.
	const slugCandidates = [fields.displayName ?? "", taskSummary ?? "", fields.taskHint ?? ""];
	let taskSlug = "";
	for (const candidate of slugCandidates) {
		const s = slugifyTaskName(candidate);
		if (s.length > 0) {
			taskSlug = s;
			break;
		}
	}

	// Collision snapshot from the projects table (advisory; the
	// supervisor's idempotency check is the safety net — bob §12.5 step 8).
	const allProjects = await listProjects();
	const colliding = new Set<string>(allProjects.map((p) => p.cwd));

	let resolvedPath: string;
	let prelaunchActions: CloneRepoPrelaunchAction[];
	try {
		const result = await cloneRepo({
			url: cloneSpec.url,
			branch: cloneSpec.branch,
			taskSlug: taskSlug.length > 0 ? taskSlug : undefined,
			taskSummary,
			workspaceSettings: { ...settings.workspace, gitClone: settings.gitClone },
			collidingPaths: colliding,
			explicitPath,
		});
		resolvedPath = result.resolvedPath;
		prelaunchActions = result.prelaunchActions;
	} catch (err) {
		if (err instanceof WorkspacePathValidationError) {
			// User-supplied custom path or URL failed validation. Render
			// the error inline on a fresh cloner so the user can retry.
			const errorMeta: WorkspaceCloneMeta = {
				kind: "workspace_clone",
				draftId: draft.id,
				url: cloneSpec.url,
				resolvedPath: explicitPath ?? "",
				branch: cloneSpec.branch,
				depth: cloneSpec.depth,
				timeoutSeconds: settings.gitClone.timeoutSeconds,
				canClone,
				suggestedHost,
				telegramOrigin,
				error: {
					code: err.code,
					message: prelaunchErrorCopy(err.code, explicitPath ?? null),
					path: explicitPath ?? undefined,
				},
			};
			const visibleText = telegramOrigin
				? `That clone didn't validate: ${prelaunchErrorCopy(err.code, explicitPath ?? null)} Reply with a different path, or \`cancel\` to back out.`
				: "That clone didn't validate. Edit the URL or path or cancel.";
			if (telegramOrigin) {
				return { replyText: visibleText, actionRequestId: null };
			}
			return {
				replyText: `${visibleText}${encodeWorkspaceCloneMeta(errorMeta)}`,
				actionRequestId: null,
			};
		}
		const message = err instanceof Error ? err.message : "Could not pick a clone path.";
		return {
			replyText: `Couldn't prepare the clone: ${message} Reply with a different absolute path, or \`cancel\` to back out.`,
			actionRequestId: null,
		};
	}

	// Read-back the actual depth that cloneRepo emitted (the helper
	// suppresses the default-depth setting when a branch is set; bob §12.6).
	const emittedAction = prelaunchActions[0];
	const emittedDepth = emittedAction.depth;
	const emittedBranch = emittedAction.branch;
	const emittedTimeout = emittedAction.timeoutSeconds ?? settings.gitClone.timeoutSeconds;

	const pending: PendingWorkspaceClone = {
		taskSlug:
			taskSlug.length > 0
				? taskSlug
				: // cloneRepo derives a fallback from the URL; surface the
					// final basename here so executeCloneConfirm can register
					// a project under the same name.
					basenameFromPath(resolvedPath),
		resolvedPath,
		url: emittedAction.url,
		branch: emittedBranch,
		depth: emittedDepth,
		timeoutSeconds: emittedTimeout,
		actions: prelaunchActions.map((a) => ({
			kind: "clone_repo" as const,
			url: a.url,
			intoPath: a.intoPath,
			branch: a.branch,
			depth: a.depth,
			timeoutSeconds: a.timeoutSeconds,
			seedClaudeMd: a.seedClaudeMd,
		})),
		suggestedHost,
	};
	const nextFields: LaunchDisambiguationDraftFields = {
		...fields,
		pendingClone: pending,
		// Defensive: mutually exclusive with pendingScaffold. If the user
		// somehow had both, the cloner branch wins (bob §12.10).
		pendingScaffold: undefined,
	};
	await db
		.update(aiPendingProjectDrafts)
		.set({
			draftFields: nextFields,
			nextQuestion: { ...(draft.nextQuestion as NextQuestion), retryCount: 0 },
			updatedAt: sqlNow(),
		})
		.where(eq(aiPendingProjectDrafts.id, draft.id));

	const visibleText = renderCloneVisibleText({
		url: emittedAction.url,
		resolvedPath,
		suggestedHost,
		telegramOrigin,
	});
	if (telegramOrigin) {
		return { replyText: visibleText, actionRequestId: null };
	}

	const meta: WorkspaceCloneMeta = {
		kind: "workspace_clone",
		draftId: draft.id,
		url: emittedAction.url,
		resolvedPath,
		branch: emittedBranch,
		depth: emittedDepth,
		timeoutSeconds: emittedTimeout,
		canClone,
		suggestedHost,
		telegramOrigin,
	};
	return {
		replyText: `${visibleText}${encodeWorkspaceCloneMeta(meta)}`,
		actionRequestId: null,
	};
}

function basenameFromPath(p: string): string {
	const segs = p.split("/").filter((s) => s.length > 0);
	return segs[segs.length - 1] ?? "clone";
}

function renderCloneVisibleText(args: {
	url: string;
	resolvedPath: string;
	suggestedHost: string | undefined;
	telegramOrigin: boolean;
}): string {
	const hostClause = args.suggestedHost ? ` on **${args.suggestedHost}**` : "";
	const lines: string[] = [];
	lines.push(`I'll clone \`${args.url}\`${hostClause} into \`${args.resolvedPath}\`.`);
	lines.push("");
	lines.push("Reply `yes` to confirm, paste a different absolute path, or `cancel` to back out.");
	if (args.telegramOrigin) {
		lines.push("");
		lines.push("(Reply here in Telegram — answers are delivered through the same channel.)");
	}
	return lines.join("\n");
}

interface ResolveCloneConfirmArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	reply: string;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
	fields: LaunchDisambiguationDraftFields;
}

async function resolveCloneConfirm(args: ResolveCloneConfirmArgs): Promise<DisambiguationResult> {
	const { draft, reply, origin, threadId, telegramChatId, fields } = args;
	const pending = fields.pendingClone;
	if (!pending) {
		await markDraftResolved(draft.id);
		return {
			replyText: "Clone draft expired. Ask again to retry.",
			actionRequestId: null,
		};
	}

	const parsed = parseCloneConfirmReply(reply);
	const now = sqlNow();

	switch (parsed.tag) {
		case "cancel": {
			await db.delete(aiPendingProjectDrafts).where(eq(aiPendingProjectDrafts.id, draft.id));
			return {
				replyText:
					"Cancelled. Ask again with a different repo URL, or pick a project from your list.",
				actionRequestId: null,
			};
		}
		case "custom_path": {
			return handleCloneIntent({
				draft,
				origin,
				threadId,
				telegramChatId,
				fields,
				cloneSpec: { url: pending.url, branch: pending.branch, depth: pending.depth },
				explicitPath: parsed.path,
			});
		}
		case "branch_override": {
			return handleCloneIntent({
				draft,
				origin,
				threadId,
				telegramChatId,
				fields,
				cloneSpec: { url: pending.url, branch: parsed.branch, depth: pending.depth },
				explicitPath: undefined,
			});
		}
		case "depth_override": {
			return handleCloneIntent({
				draft,
				origin,
				threadId,
				telegramChatId,
				fields,
				cloneSpec: { url: pending.url, branch: pending.branch, depth: parsed.depth },
				explicitPath: undefined,
			});
		}
		case "confirm": {
			return executeCloneConfirm({
				draft,
				origin,
				threadId,
				telegramChatId,
				fields,
				pending,
			});
		}
		default: {
			const newDraftAfter = await bumpRetryCount(draft, now);
			if (!newDraftAfter) {
				return {
					replyText:
						"I wasn't able to figure out whether to confirm or cancel after 3 tries. Start over by asking again.",
					actionRequestId: null,
				};
			}
			const telegramOrigin = origin === "telegram";
			const visibleText = renderCloneVisibleText({
				url: pending.url,
				resolvedPath: pending.resolvedPath,
				suggestedHost: pending.suggestedHost,
				telegramOrigin,
			});
			if (telegramOrigin) {
				return {
					replyText: `I didn't understand that. ${visibleText}`,
					actionRequestId: null,
				};
			}
			const meta: WorkspaceCloneMeta = {
				kind: "workspace_clone",
				draftId: draft.id,
				url: pending.url,
				resolvedPath: pending.resolvedPath,
				branch: pending.branch,
				depth: pending.depth,
				timeoutSeconds: pending.timeoutSeconds,
				canClone: true,
				suggestedHost: pending.suggestedHost,
				telegramOrigin: false,
			};
			return {
				replyText: `I didn't understand that. ${visibleText}${encodeWorkspaceCloneMeta(meta)}`,
				actionRequestId: null,
			};
		}
	}
}

interface ExecuteCloneConfirmArgs {
	draft: typeof aiPendingProjectDrafts.$inferSelect;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
	fields: LaunchDisambiguationDraftFields;
	pending: PendingWorkspaceClone;
}

async function executeCloneConfirm(args: ExecuteCloneConfirmArgs): Promise<DisambiguationResult> {
	const { draft, origin, threadId, telegramChatId, fields, pending } = args;

	// Ensure project name uniqueness — same disambiguation pattern as
	// executeScaffoldConfirm. The basename slug may collide with an
	// existing project even though the cwd is fresh.
	let projectName = pending.taskSlug;
	const existing = await listProjects();
	const usedNames = new Set(existing.map((p) => p.name));
	if (usedNames.has(projectName)) {
		projectName = `${projectName}-${Math.random().toString(36).slice(2, 6)}`;
	}

	const created = await createProject({
		name: projectName,
		cwd: pending.resolvedPath,
		// "cloned" tag distinguishes a clone-originated scratch project
		// from a scaffold-originated one (per bob §12.10 step 7).
		tags: ["scratch", "ai-initiated", "cloned"],
	});
	if (created.conflict) {
		return {
			replyText: `Couldn't register the cloned workspace: a project at \`${pending.resolvedPath}\` already exists. Reply with a different absolute path, or \`cancel\` to back out.`,
			actionRequestId: null,
		};
	}
	if (!created.project) {
		return {
			replyText:
				"Couldn't register the cloned workspace. Reply with a different absolute path, or `cancel` to back out.",
			actionRequestId: null,
		};
	}

	await bumpVersionAndReload();
	await markDraftResolved(draft.id);

	const reconstructed: Extract<LaunchIntent, { kind: "launch" }> = {
		kind: "launch",
		projectName: created.project.name,
		mode: fields.mode as LaunchMode | undefined,
		agentType: fields.agentType as AgentType | undefined,
		taskHint: fields.taskHint,
		displayName: fields.displayName,
		taskBrief: fields.taskBrief as TaskBrief | undefined,
	};
	const prelaunchActions: PrelaunchAction[] = pending.actions.map((a) => ({
		kind: "clone_repo" as const,
		url: a.url,
		intoPath: a.intoPath,
		branch: a.branch,
		depth: a.depth,
		timeoutSeconds: a.timeoutSeconds,
		seedClaudeMd: a.seedClaudeMd,
	}));
	return handleAskLaunchIntent({
		intent: reconstructed,
		origin,
		threadId,
		telegramChatId,
		prelaunchActions,
	});
}
