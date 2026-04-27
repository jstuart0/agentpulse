import type { AgentType, LaunchMode } from "../../../shared/types.js";
import type { ProjectDraftFields } from "../../db/schema.js";
import { getAdapter } from "../ai/llm/registry.js";
import type { ProviderKind } from "../ai/llm/types.js";
import { getDefaultProvider, getProviderApiKey } from "../ai/providers-service.js";
import { addGlobalSpendCents, checkSpendBudget } from "../ai/spend-service.js";
import type { CachedProject } from "../projects/cache.js";

// Local OpenAI-compatible models (Ollama, vLLM, llama.cpp) often emit
// chain-of-thought before answering, breaking JSON-only classifier prompts.
// qwen3 honors `/no_think` to skip its thinking phase; smaller llama/mistral
// models simply ignore unknown directives, so this is safe to append.
function withNoThinkForLocalProviders(systemPrompt: string, providerKind: ProviderKind): string {
	if (providerKind === "openai_compatible") {
		return `${systemPrompt}\n\n/no_think`;
	}
	return systemPrompt;
}

export type LaunchIntent =
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string }
	| {
			kind: "launch";
			projectName: string;
			mode?: LaunchMode;
			taskHint?: string;
			agentType?: AgentType;
	  }
	| {
			kind: "add_project";
			initialFields: Partial<ProjectDraftFields>;
	  };

const LAUNCH_VERBS = ["open", "launch", "start", "spin up", "fire up", "boot", "kick off"];

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure synchronous gate: returns true only if the message contains a launch
 * verb AND a whole-word match of a known project name. This runs on every
 * Ask turn at microsecond cost — the LLM classifier is only called when this
 * gate passes.
 */
export function gatePasses(message: string, projects: CachedProject[]): boolean {
	const lower = message.toLowerCase();
	const hasVerb = LAUNCH_VERBS.some((v) => lower.includes(v));
	if (!hasVerb) return false;
	const hasProject = projects.some((p) =>
		new RegExp(`\\b${escapeRegex(p.name.toLowerCase())}\\b`).test(lower),
	);
	return hasProject;
}

const INTENT_SYSTEM_PROMPT = (
	projectNames: string[],
): string => `You are a launch-intent classifier for AgentPulse, a tool that manages AI coding sessions.

Your job is to determine whether the user's message is requesting to launch a new coding session for a specific project.

Known project names: ${projectNames.map((n) => `"${n}"`).join(", ")}

Respond with a JSON object (no markdown, no backticks) in one of these two shapes:

If this is NOT a launch request:
{"intent":"none"}

If this IS a launch request:
{"intent":"launch","projectName":"<exact project name from the known list>","agentType":"claude_code|codex_cli|null","mode":"interactive_terminal|headless|managed_codex|null","taskHint":"<short description of the task, or null>"}

Rules:
- Only use project names from the known list (case-insensitive match).
- agentType: "claude_code" if user says "claude", "codex_cli" if user says "codex", null otherwise.
- mode: "headless" if user says "headless", "interactive_terminal" if user explicitly asks for interactive, null otherwise (default will be applied).
- taskHint: any task description the user gave after "to ...", "for ...", e.g. "look at the failing tests".
- Respond ONLY with the JSON object. No explanation, no extra text.`;

/**
 * Two-stage intent detection:
 * 1. Keyword gate (synchronous) — exits fast on the common case (no launch intent).
 * 2. LLM classifier (async, only when gate passes) — resolves ambiguous phrasing.
 *
 * Spend tracking is wired explicitly here because Ask itself does not call
 * checkSpendBudget/recordSpend for its LLM calls (pre-existing gap, out of
 * scope to fix in this plan). The classifier IS a new LLM call we control
 * end-to-end, so we gate it behind the daily cap.
 */
export async function detectLaunchIntent(
	message: string,
	projects: CachedProject[],
): Promise<LaunchIntent> {
	if (!gatePasses(message, projects)) {
		return { kind: "none" };
	}

	// Stage 2: LLM classifier. Only reached when gate passes.

	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify launch intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	// Preflight spend check. Estimate cost conservatively.
	// We use a fixed estimate (200 output tokens + ~1000 input chars ≈ ~250 tokens)
	// at a rough $1/M token rate (well above most providers' actual cost).
	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		// Over-cap: silently degrade (the daily-spend warning exists at /ai/diagnostics).
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	const projectNames = projects.map((p) => p.name);
	const systemPrompt = withNoThinkForLocalProviders(INTENT_SYSTEM_PROMPT(projectNames), full.kind);

	try {
		const res = await adapter.complete({
			systemPrompt,
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 200,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		// Postflight spend recording. Classifier cost isn't attributable to a
		// specific session so we use the global (non-session) spend function.
		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {
			// spend tracking is best-effort; don't block the intent result
		});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") {
			return { kind: "none" };
		}

		if (parsed.intent !== "launch" || typeof parsed.projectName !== "string") {
			return { kind: "none" };
		}

		// Case-insensitive match back to known project name.
		const matchedProject = projects.find(
			(p) => p.name.toLowerCase() === (parsed.projectName as string).toLowerCase(),
		);
		if (!matchedProject) {
			return { kind: "none" };
		}

		const mode =
			parsed.mode === "headless" ||
			parsed.mode === "interactive_terminal" ||
			parsed.mode === "managed_codex"
				? (parsed.mode as LaunchMode)
				: undefined;

		const agentType =
			parsed.agentType === "claude_code" || parsed.agentType === "codex_cli"
				? (parsed.agentType as AgentType)
				: undefined;

		const taskHint =
			typeof parsed.taskHint === "string" && parsed.taskHint ? parsed.taskHint : undefined;

		return {
			kind: "launch",
			projectName: matchedProject.name,
			mode,
			taskHint,
			agentType,
		};
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

const SEARCH_TRIGGERS = [
	"find session",
	"search session",
	"show me session",
	"what sessions",
	"which sessions",
	"list sessions",
	"any sessions",
	"sessions about",
	"sessions with",
	"sessions that",
	"sessions on",
	"sessions for",
	"stuck sessions",
	"failed sessions",
	"active sessions",
	"completed sessions",
	"what's stuck",
	"what is stuck",
	"broken sessions",
	"crashed sessions",
];

/**
 * Pure synchronous gate: returns true if the message looks like an NL
 * session-search request. Conservative — false negatives fall through to
 * the normal Ask LLM which can answer conversationally.
 */
export function searchGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return SEARCH_TRIGGERS.some((t) => lower.includes(t));
}

const DIGEST_TRIGGERS = [
	"what happened",
	"give me a digest",
	"daily digest",
	"session digest",
	"activity summary",
	"what's going on",
	"what is going on",
	"overview of",
	"summary of sessions",
];

/**
 * Pure synchronous gate: returns true if the message looks like a digest
 * or activity-summary request.
 */
export function digestGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return DIGEST_TRIGGERS.some((t) => lower.includes(t));
}

const ADD_PROJECT_VERBS = [
	"add project",
	"create project",
	"new project",
	"add a project",
	"create a project",
];

/**
 * Pure synchronous gate for add-project intent. Intentionally loose
 * (no project-name requirement) — the LLM classifier confirms intent.
 */
export function addProjectGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return ADD_PROJECT_VERBS.some((v) => lower.includes(v));
}

const SESSION_ACTION_VERBS = [
	"pin",
	"unpin",
	"archive",
	"stop",
	"rename",
	"add note",
	"add a note",
	"note for",
	"delete session",
];

/**
 * Pure synchronous gate: returns true if the message looks like a
 * single-session action request (pin, unpin, archive, stop, rename,
 * add note, delete). Intentionally broad — the LLM classifier
 * confirms intent and rejects false positives like "stop worrying".
 */
export function sessionActionGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return SESSION_ACTION_VERBS.some((v) => lower.includes(v));
}

export type SessionActionKind =
	| { kind: "session_action" }
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string };

export interface SessionActionIntent {
	action: "pin" | "unpin" | "rename" | "add_note" | "archive" | "stop" | "delete";
	sessionHint: string | null;
	noteText: string | null;
	newName: string | null;
}

const SESSION_ACTION_CLASSIFIER_PROMPT = `You are a session-action classifier for AgentPulse.
Determine whether the user wants to perform an action on a SINGLE session.

Actions: pin | unpin | rename | add_note | archive | stop | delete

Respond with JSON (no markdown, no backticks):

If NOT a session action, or if the request targets MULTIPLE sessions (uses "all", "every", "older than", "each", etc.):
{"intent":"none"}

If YES (single session action):
{
  "intent": "session_action",
  "action": "pin|unpin|rename|add_note|archive|stop|delete",
  "sessionHint": "<session name fragment or null>",
  "noteText": "<note content if action=add_note, else null>",
  "newName": "<new name if action=rename, else null>"
}

Rules:
- sessionHint: any name, cwd fragment, or description the user gave to identify ONE specific session. Null if no hint.
- If the request targets multiple sessions or uses bulk qualifiers, return intent:none.
- "stop worrying", "stop the music", etc. are NOT session actions — return intent:none.
- Respond ONLY with the JSON object.`;

export async function detectSessionActionIntent(
	message: string,
): Promise<SessionActionKind & { intent?: SessionActionIntent }> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify session action intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	try {
		const res = await adapter.complete({
			systemPrompt: withNoThinkForLocalProviders(SESSION_ACTION_CLASSIFIER_PROMPT, full.kind),
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 200,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };
		if (parsed.intent !== "session_action") return { kind: "none" };

		const validActions = ["pin", "unpin", "rename", "add_note", "archive", "stop", "delete"];
		if (!validActions.includes(parsed.action as string)) return { kind: "none" };

		return {
			kind: "session_action",
			intent: {
				action: parsed.action as SessionActionIntent["action"],
				sessionHint: typeof parsed.sessionHint === "string" ? parsed.sessionHint : null,
				noteText: typeof parsed.noteText === "string" ? parsed.noteText : null,
				newName: typeof parsed.newName === "string" ? parsed.newName : null,
			},
		};
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

const ADD_PROJECT_SYSTEM_PROMPT = `You are an add-project-intent classifier for AgentPulse.

The user may be requesting to add a new project to AgentPulse. Extract what you can from their message.

Respond with JSON (no markdown, no backticks):

If this is NOT an add-project request:
{"intent":"none"}

If this IS an add-project request:
{
  "intent": "add_project",
  "name": "<project name or null>",
  "cwd": "<absolute directory path or null>",
  "defaultAgentType": "claude_code|codex_cli|null",
  "defaultModel": "<model string or null>",
  "defaultLaunchMode": "interactive_terminal|headless|managed_codex|null",
  "githubRepoUrl": "<url or null>"
}

Rules:
- name: extract if the user provided one. Must be 1-80 chars. Null if not provided.
- cwd: extract if the user provided an absolute path (starts with /). Null if not provided.
- Only return fields the user explicitly stated. All fields default to null.
- Respond ONLY with the JSON object.`;

// ---- Resume intent --------------------------------------------------------
//
// Resume gate runs BEFORE the launch gate. The classifier system prompt
// explicitly lists known project names so "continue agentpulse with: …"
// is rejected as a project name, not resolved as a session hint.

export interface ResumeIntent {
	kind: "resume";
	sessionHint: string | null;
	newPrompt: string | null;
	agentType?: AgentType;
	mode?: LaunchMode;
}

export type ResumeDetectResult =
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string }
	| ResumeIntent;

const RESUME_VERBS = [
	"resume",
	"continue",
	"pick up",
	"restart with",
	"continue with",
	"follow up on",
	"follow up with",
];

/**
 * Pure synchronous gate: true if the message contains any resume verb.
 * The downstream LLM classifier rejects false positives (e.g. "continue reading").
 */
export function resumeGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return RESUME_VERBS.some((v) => lower.includes(v));
}

const RESUME_SYSTEM_PROMPT = (projectNames: string[]): string =>
	`You are a session-resume classifier for AgentPulse.

Known project names (these are project names, NOT session names): ${projectNames.map((n) => `"${n}"`).join(", ")}

Respond with JSON (no markdown, no backticks):

If NOT a resume request, OR if the identifier refers to a known project name rather than a session:
{"intent":"none"}

If YES:
{
  "intent": "resume",
  "sessionHint": "<session name or description fragment>",
  "newPrompt": "<the task or prompt to start the new session with, or null>",
  "agentType": "claude_code|codex_cli|null",
  "mode": "interactive_terminal|headless|null"
}

Rules:
- sessionHint: the description used to identify the target parent session. Must be a session name or fragment, NOT a project name. If the identifier matches a known project name, return intent:none.
- newPrompt: text after "with:", "with this:", or a natural "to <verb>..." phrase. If no explicit new prompt is present, return null.
- Use the ": " separator or explicit "with:" phrase as a high-confidence resume signal.
- "continue reading", "continue watching", or other non-session phrases must return intent:none.
- Respond ONLY with the JSON object.`;

export async function detectResumeIntent(
	message: string,
	projectNames: string[],
): Promise<ResumeDetectResult> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify resume intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	try {
		const res = await adapter.complete({
			systemPrompt: withNoThinkForLocalProviders(RESUME_SYSTEM_PROMPT(projectNames), full.kind),
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 200,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };
		if (parsed.intent !== "resume") return { kind: "none" };

		const agentType =
			parsed.agentType === "claude_code" || parsed.agentType === "codex_cli"
				? (parsed.agentType as AgentType)
				: undefined;

		const mode =
			parsed.mode === "interactive_terminal" || parsed.mode === "headless"
				? (parsed.mode as LaunchMode)
				: undefined;

		return {
			kind: "resume",
			sessionHint: typeof parsed.sessionHint === "string" ? parsed.sessionHint : null,
			newPrompt: typeof parsed.newPrompt === "string" && parsed.newPrompt ? parsed.newPrompt : null,
			agentType,
			mode,
		};
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---- Project/template CRUD intent ----------------------------------------

const CRUD_VERBS = [
	"edit project",
	"update project",
	"change project",
	"rename project",
	"delete project",
	"remove project",
	"edit template",
	"update template",
	"change template",
	"rename template",
	"delete template",
	"remove template",
];

const CHANNEL_SETUP_TRIGGERS = [
	"set up telegram",
	"add telegram",
	"configure telegram",
	"set up a webhook",
	"add a webhook",
	"add webhook",
	"set up notification",
	"add notification channel",
	"configure notification",
	"set up channel",
	"add channel",
	"set up email notification",
	"add email notification",
	"set up a telegram",
	"add a telegram",
];

/**
 * Pure synchronous gate: returns true if the message looks like a request
 * to create a notification channel (Telegram, webhook, or email). No LLM
 * classifier needed — heuristic detection is sufficient here.
 */
export function channelSetupGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return CHANNEL_SETUP_TRIGGERS.some((t) => lower.includes(t));
}

/**
 * Pure synchronous gate: true if the message contains a project/template
 * CRUD verb. The downstream LLM classifier confirms the specific operation
 * and resolves the target name.
 */
export function projectTemplateCrudGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return CRUD_VERBS.some((v) => lower.includes(v));
}

export type ProjectTemplateCrudIntent =
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string }
	| {
			kind: "edit_project";
			targetName: string;
			fields: Partial<{
				name: string;
				cwd: string;
				defaultAgentType: string | null;
				defaultModel: string | null;
				defaultLaunchMode: string | null;
				githubRepoUrl: string | null;
				notes: string | null;
			}>;
	  }
	| { kind: "delete_project"; targetName: string }
	| {
			kind: "edit_template";
			targetName: string;
			fields: Partial<{
				name: string;
				description: string;
				taskPrompt: string;
				model: string | null;
			}>;
	  }
	| { kind: "delete_template"; targetName: string };

const CRUD_SYSTEM_PROMPT = (projectNames: string[], templateNames: string[]): string =>
	`You are a project/template CRUD classifier for AgentPulse.

Known project names: ${projectNames.length > 0 ? projectNames.map((n) => `"${n}"`).join(", ") : "(none)"}
Known template names: ${templateNames.length > 0 ? templateNames.map((n) => `"${n}"`).join(", ") : "(none)"}

Determine whether the user wants to edit or delete a project or template, and extract the target and proposed changes.

Respond with JSON (no markdown, no backticks):

If NOT a project/template edit or delete:
{"intent":"none"}

If editing a project:
{"intent":"edit_project","targetName":"<exact project name>","fields":{"name":"<new name or omit>","cwd":"<absolute path or omit>","defaultAgentType":"claude_code|codex_cli|null or omit","defaultModel":"<model or null or omit>","defaultLaunchMode":"interactive_terminal|headless|managed_codex|null or omit","githubRepoUrl":"<url or null or omit>","notes":"<notes or null or omit>"}}

If deleting a project:
{"intent":"delete_project","targetName":"<exact project name>"}

If editing a template:
{"intent":"edit_template","targetName":"<exact template name>","fields":{"name":"<new name or omit>","description":"<description or omit>","taskPrompt":"<task prompt or omit>","model":"<model or null or omit>"}}

If deleting a template:
{"intent":"delete_template","targetName":"<exact template name>"}

Rules:
- targetName: use an exact match from the known names lists (case-insensitive). If the user refers to a project or template not in the known lists, still extract the name they provided.
- fields: include ONLY fields the user explicitly mentioned. Omit everything else.
- cwd: only include if the user provides an absolute path (starts with /).
- defaultAgentType: "claude_code" for Claude/claude, "codex_cli" for Codex/codex, null to clear.
- For delete operations, no fields needed.
- Respond ONLY with the JSON object.`;

export async function detectProjectTemplateCrudIntent(
	message: string,
	projectNames: string[],
	templateNames: string[],
): Promise<ProjectTemplateCrudIntent> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify CRUD intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	try {
		const res = await adapter.complete({
			systemPrompt: withNoThinkForLocalProviders(
				CRUD_SYSTEM_PROMPT(projectNames, templateNames),
				full.kind,
			),
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 300,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };

		if (parsed.intent === "delete_project") {
			if (typeof parsed.targetName !== "string") return { kind: "none" };
			return { kind: "delete_project", targetName: parsed.targetName };
		}

		if (parsed.intent === "delete_template") {
			if (typeof parsed.targetName !== "string") return { kind: "none" };
			return { kind: "delete_template", targetName: parsed.targetName };
		}

		if (parsed.intent === "edit_project") {
			if (typeof parsed.targetName !== "string") return { kind: "none" };
			const rawFields = (parsed.fields as Record<string, unknown>) ?? {};
			type EditProjectFields = Extract<
				ProjectTemplateCrudIntent,
				{ kind: "edit_project" }
			>["fields"];
			const fields: EditProjectFields = {};
			if (typeof rawFields.name === "string" && rawFields.name.length > 0)
				fields.name = rawFields.name;
			if (typeof rawFields.cwd === "string" && rawFields.cwd.startsWith("/"))
				fields.cwd = rawFields.cwd;
			if ("defaultAgentType" in rawFields) {
				fields.defaultAgentType =
					rawFields.defaultAgentType === "claude_code" || rawFields.defaultAgentType === "codex_cli"
						? rawFields.defaultAgentType
						: null;
			}
			if ("defaultModel" in rawFields) {
				fields.defaultModel =
					typeof rawFields.defaultModel === "string" ? rawFields.defaultModel : null;
			}
			if ("defaultLaunchMode" in rawFields) {
				const lm = rawFields.defaultLaunchMode;
				fields.defaultLaunchMode =
					lm === "interactive_terminal" || lm === "headless" || lm === "managed_codex" ? lm : null;
			}
			if ("githubRepoUrl" in rawFields) {
				fields.githubRepoUrl =
					typeof rawFields.githubRepoUrl === "string" ? rawFields.githubRepoUrl : null;
			}
			if ("notes" in rawFields) {
				fields.notes = typeof rawFields.notes === "string" ? rawFields.notes : null;
			}
			return { kind: "edit_project", targetName: parsed.targetName, fields };
		}

		if (parsed.intent === "edit_template") {
			if (typeof parsed.targetName !== "string") return { kind: "none" };
			const rawFields = (parsed.fields as Record<string, unknown>) ?? {};
			type EditTemplateFields = Extract<
				ProjectTemplateCrudIntent,
				{ kind: "edit_template" }
			>["fields"];
			const fields: EditTemplateFields = {};
			if (typeof rawFields.name === "string" && rawFields.name.length > 0)
				fields.name = rawFields.name;
			if (typeof rawFields.description === "string") fields.description = rawFields.description;
			if (typeof rawFields.taskPrompt === "string") fields.taskPrompt = rawFields.taskPrompt;
			if ("model" in rawFields) {
				fields.model = typeof rawFields.model === "string" ? rawFields.model : null;
			}
			return { kind: "edit_template", targetName: parsed.targetName, fields };
		}

		return { kind: "none" };
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---- Alert rule intent ---------------------------------------------------

const ALERT_RULE_TRIGGERS = [
	"alert me when",
	"notify me when",
	"tell me when",
	"warn me when",
	"alert when",
	"notify when",
	"watch for",
	"monitor for",
];

/**
 * Pure synchronous gate: returns true only if the message contains an
 * alert-rule trigger phrase. The downstream LLM classifier confirms the
 * constrained rule type and rejects freeform alert requests.
 */
export function alertRuleGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return ALERT_RULE_TRIGGERS.some((t) => lower.includes(t));
}

export type AlertRuleIntent =
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string }
	| {
			kind: "create_alert_rule";
			projectHint: string | null;
			ruleType: "status_failed" | "status_stuck" | "status_completed" | "no_activity_minutes";
			thresholdMinutes?: number | null;
	  }
	| {
			kind: "create_freeform_alert_rule";
			projectHint: string | null;
			condition: string;
			dailyTokenBudget: number | null; // null → handler asks follow-up
			sampleRate: number;
	  };

const ALERT_RULE_CLASSIFIER_PROMPT = (projectNames: string[]): string =>
	`You are an alert-rule classifier for AgentPulse, a tool that manages AI coding sessions.

Known project names: ${projectNames.length > 0 ? projectNames.map((n) => `"${n}"`).join(", ") : "(none)"}

Rule types and their meanings:
- status_failed: fires when a session transitions to status=failed (agent crashed or launch failed)
- status_stuck: fires when the AI classifier marks a session as stuck (no progress for extended time)
- status_completed: fires when a session completes successfully
- no_activity_minutes: fires when a session has been active but shows no new events for N minutes
- create_freeform_alert_rule: fires when session events match a user-described natural-language condition

Respond with JSON (no markdown, no backticks):

If NOT a session-monitoring alert rule request (e.g. "alert me when my meeting starts"):
{"intent":"none"}

If YES and the rule type is one of the four constrained types above:
{
  "intent": "create_alert_rule",
  "projectHint": "<project name from known list, or null if not specified>",
  "ruleType": "status_failed|status_stuck|status_completed|no_activity_minutes",
  "thresholdMinutes": <integer for no_activity_minutes, or null>
}

If YES and the condition is freeform (e.g. "alert when the agent mentions X", "notify me when the agent encounters a security issue"):
{
  "intent": "create_freeform_alert_rule",
  "projectHint": "<project name from known list, or null if not specified>",
  "condition": "<natural language condition string, extracted from the user's message>",
  "dailyTokenBudget": <integer tokens if the user stated a budget, or null>,
  "sampleRate": 1.0
}

Rules:
- projectHint: extract from known project names (case-insensitive). Null if not specified.
- thresholdMinutes: only required for no_activity_minutes; extract from "for N minutes" or similar.
- condition: the natural-language condition the user described, verbatim or lightly cleaned.
- dailyTokenBudget: extract from "with a budget of N tokens/day" or similar; null if not stated.
- Respond ONLY with the JSON object.`;

export async function detectAlertRuleIntent(
	message: string,
	projectNames: string[],
): Promise<AlertRuleIntent> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify alert rule intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	try {
		const res = await adapter.complete({
			systemPrompt: withNoThinkForLocalProviders(
				ALERT_RULE_CLASSIFIER_PROMPT(projectNames),
				full.kind,
			),
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 200,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };

		if (parsed.intent === "create_freeform_alert_rule") {
			const condition = typeof parsed.condition === "string" ? parsed.condition.trim() : "";
			if (!condition) return { kind: "none" };
			return {
				kind: "create_freeform_alert_rule",
				projectHint: typeof parsed.projectHint === "string" ? parsed.projectHint : null,
				condition,
				dailyTokenBudget:
					typeof parsed.dailyTokenBudget === "number" ? parsed.dailyTokenBudget : null,
				sampleRate: typeof parsed.sampleRate === "number" ? parsed.sampleRate : 1.0,
			};
		}

		if (parsed.intent !== "create_alert_rule") return { kind: "none" };

		const validRuleTypes = [
			"status_failed",
			"status_stuck",
			"status_completed",
			"no_activity_minutes",
		] as const;
		if (!validRuleTypes.includes(parsed.ruleType as (typeof validRuleTypes)[number])) {
			return { kind: "none" };
		}

		const ruleType = parsed.ruleType as AlertRuleIntent extends { kind: "create_alert_rule" }
			? AlertRuleIntent["ruleType"]
			: never;

		const thresholdMinutes =
			typeof parsed.thresholdMinutes === "number" ? parsed.thresholdMinutes : null;

		return {
			kind: "create_alert_rule",
			projectHint: typeof parsed.projectHint === "string" ? parsed.projectHint : null,
			ruleType,
			thresholdMinutes,
		};
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---- Bulk session action intent -------------------------------------------

// These phrases unambiguously describe a multi-session operation. The gate
// must fire before the single-session gate so "archive all" doesn't leak
// through to sessionActionGatePasses.
const BULK_ACTION_TRIGGERS = [
	"stop all",
	"stop everything",
	"archive all",
	"archive every",
	"delete all",
	"delete every",
	"stop all sessions",
	"archive all sessions",
	"archive completed sessions", // "all" keyword not required — still multi-session
	"archive old sessions",
	"delete all sessions",
	"stop sessions on",
	"archive sessions on",
];

/**
 * Pure synchronous gate: returns true only if the message contains a
 * phrase that unambiguously describes a bulk (multi-session) operation.
 * Must be checked BEFORE sessionActionGatePasses to prevent single-session
 * classifier from seeing "archive all completed sessions".
 */
export function bulkActionGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return BULK_ACTION_TRIGGERS.some((t) => lower.includes(t));
}

export type BulkFilter =
	| {
			strategy: "attribute";
			status?: string;
			olderThanDays?: number;
			projectHint?: string;
	  }
	| { strategy: "hint"; searchHint: string; projectHint?: string };

export interface BulkActionIntent {
	kind: "bulk_action";
	action: "stop" | "archive" | "delete";
	filter: BulkFilter;
}

export type BulkActionDetectResult =
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string }
	| BulkActionIntent;

const BULK_ACTION_CLASSIFIER_PROMPT = `You are a bulk-session-action classifier for AgentPulse, a tool that manages AI coding sessions.
Determine whether the user wants to perform a stop/archive/delete action on MULTIPLE sessions at once.

Respond with JSON (no markdown, no backticks):

Not a bulk action:
{"intent":"none"}

Bulk action with attribute filter:
{
  "intent": "bulk_action",
  "action": "stop|archive|delete",
  "filter": {
    "strategy": "attribute",
    "status": "completed|active|idle|failed|null",
    "olderThanDays": <integer or null>,
    "projectHint": "<project name or null>"
  }
}

Bulk action with search hint:
{
  "intent": "bulk_action",
  "action": "stop|archive|delete",
  "filter": {
    "strategy": "hint",
    "searchHint": "<description fragment to search for>",
    "projectHint": "<project name or null>"
  }
}

Rules:
- If the action targets exactly ONE named session, return intent:none (the single-session gate handles it).
- If the message uses "all", "every", "older than", "completed", "old sessions", etc., return bulk_action.
- olderThanDays: extract from "older than N days", "more than N days old", etc.
- projectHint: extract from "on project X" or "in project X".
- action: "stop" for stop/kill/terminate; "archive" for archive/hide; "delete" for delete/remove.
- Respond ONLY with the JSON object.`;

export async function detectBulkActionIntent(
	message: string,
	projectNames: string[],
): Promise<BulkActionDetectResult> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify bulk action intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	// Provide project names so the classifier can fill projectHint accurately.
	const projectContext =
		projectNames.length > 0
			? `Known project names: ${projectNames.map((n) => `"${n}"`).join(", ")}`
			: "";
	const systemPrompt = withNoThinkForLocalProviders(
		projectContext
			? `${BULK_ACTION_CLASSIFIER_PROMPT}\n\n${projectContext}`
			: BULK_ACTION_CLASSIFIER_PROMPT,
		full.kind,
	);

	try {
		const res = await adapter.complete({
			systemPrompt,
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 200,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };
		if (parsed.intent !== "bulk_action") return { kind: "none" };

		const validActions = ["stop", "archive", "delete"] as const;
		if (!validActions.includes(parsed.action as (typeof validActions)[number])) {
			return { kind: "none" };
		}
		const action = parsed.action as "stop" | "archive" | "delete";

		const rawFilter = parsed.filter as Record<string, unknown> | undefined;
		if (!rawFilter || typeof rawFilter.strategy !== "string") return { kind: "none" };

		let filter: BulkFilter;
		if (rawFilter.strategy === "attribute") {
			filter = {
				strategy: "attribute",
				status:
					typeof rawFilter.status === "string" && rawFilter.status !== "null"
						? rawFilter.status
						: undefined,
				olderThanDays:
					typeof rawFilter.olderThanDays === "number" ? rawFilter.olderThanDays : undefined,
				projectHint:
					typeof rawFilter.projectHint === "string" && rawFilter.projectHint !== "null"
						? rawFilter.projectHint
						: undefined,
			};
		} else if (rawFilter.strategy === "hint") {
			if (typeof rawFilter.searchHint !== "string" || !rawFilter.searchHint)
				return { kind: "none" };
			filter = {
				strategy: "hint",
				searchHint: rawFilter.searchHint,
				projectHint:
					typeof rawFilter.projectHint === "string" && rawFilter.projectHint !== "null"
						? rawFilter.projectHint
						: undefined,
			};
		} else {
			return { kind: "none" };
		}

		return { kind: "bulk_action", action, filter };
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---- Per-session Q&A intent -------------------------------------------------

const QA_TRIGGERS = [
	"summarize session",
	"summarize the session",
	"why did session",
	"what is session",
	"what happened in session",
	"explain session",
	"what was session",
	"tell me about session",
	"describe session",
];

/**
 * Pure synchronous gate: true if the message contains a Q&A trigger phrase.
 * Conservative — false negatives fall through to the LLM fallback.
 */
export function qaGatePasses(message: string): boolean {
	const lower = message.toLowerCase();
	return QA_TRIGGERS.some((t) => lower.includes(t));
}

export interface QaIntent {
	kind: "qa";
	sessionHint: string | null;
	question: string;
}

export type QaDetectResult =
	| { kind: "none" }
	| { kind: "classifier_failed"; error: string }
	| QaIntent;

const QA_CLASSIFIER_PROMPT = `You are a session-Q&A classifier for AgentPulse.
Determine whether the user is asking a question about a specific AI coding session.

Respond with JSON (no markdown, no backticks):

Not a session Q&A request:
{"intent":"none"}

Is a session Q&A request:
{"intent":"qa","sessionHint":"<session name or description fragment, or null>"}

Rules:
- sessionHint: the name fragment or description the user gave to identify ONE specific session. Null if no hint.
- "summarize session times" or "summarize the team session schedule" or "summarize session metrics" are NOT session Q&A — return intent:none.
- The request must be about inspecting a single specific session's history, not aggregate data across sessions.
- Respond ONLY with the JSON object.`;

export async function detectQaIntent(message: string): Promise<QaDetectResult> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify Q&A intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	try {
		const res = await adapter.complete({
			systemPrompt: withNoThinkForLocalProviders(QA_CLASSIFIER_PROMPT, full.kind),
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 150,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };
		if (parsed.intent !== "qa") return { kind: "none" };

		return {
			kind: "qa",
			sessionHint: typeof parsed.sessionHint === "string" ? parsed.sessionHint : null,
			question: message,
		};
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function detectAddProjectIntent(message: string): Promise<LaunchIntent> {
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			kind: "classifier_failed",
			error: "No default LLM provider configured — cannot classify add-project intent.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider record disappeared — check Settings → AI.",
		};
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return {
			kind: "classifier_failed",
			error: "Default LLM provider credentials are unreadable.",
		};
	}

	const ESTIMATED_COST_CENTS = 1;
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_COST_CENTS);
	if (!spendCheck.allowed) {
		return { kind: "none" };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	try {
		const res = await adapter.complete({
			systemPrompt: withNoThinkForLocalProviders(ADD_PROJECT_SYSTEM_PROMPT, full.kind),
			transcriptPrompt: `User message: ${message}`,
			model: full.model,
			maxTokens: 200,
			temperature: 0.0,
			timeoutMs: 8_000,
		});

		const actualCents = res.usage.estimated
			? ESTIMATED_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
		void addGlobalSpendCents(actualCents).catch(() => {});

		const raw = res.text.trim();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: "classifier_failed",
				error: `LLM returned non-JSON response: ${raw.slice(0, 200)}`,
			};
		}

		if (parsed.intent === "none") return { kind: "none" };
		if (parsed.intent !== "add_project") return { kind: "none" };

		const initialFields: Partial<ProjectDraftFields> = {};
		if (typeof parsed.name === "string" && parsed.name.length > 0 && parsed.name.length <= 80) {
			initialFields.name = parsed.name;
		}
		if (typeof parsed.cwd === "string" && parsed.cwd.startsWith("/")) {
			initialFields.cwd = parsed.cwd;
		}
		if (parsed.defaultAgentType === "claude_code" || parsed.defaultAgentType === "codex_cli") {
			initialFields.defaultAgentType = parsed.defaultAgentType;
		}
		if (typeof parsed.defaultModel === "string" && parsed.defaultModel) {
			initialFields.defaultModel = parsed.defaultModel;
		}
		if (
			parsed.defaultLaunchMode === "interactive_terminal" ||
			parsed.defaultLaunchMode === "headless" ||
			parsed.defaultLaunchMode === "managed_codex"
		) {
			initialFields.defaultLaunchMode = parsed.defaultLaunchMode;
		}
		if (typeof parsed.githubRepoUrl === "string" && parsed.githubRepoUrl.startsWith("https://")) {
			initialFields.githubRepoUrl = parsed.githubRepoUrl;
		}

		return { kind: "add_project", initialFields };
	} catch (err) {
		return {
			kind: "classifier_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
