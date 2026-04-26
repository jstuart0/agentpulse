import type { AgentType, LaunchMode } from "../../../shared/types.js";
import type { ProjectDraftFields } from "../../db/schema.js";
import { getAdapter } from "../ai/llm/registry.js";
import { getDefaultProvider, getProviderApiKey } from "../ai/providers-service.js";
import { addGlobalSpendCents, checkSpendBudget } from "../ai/spend-service.js";
import type { CachedProject } from "../projects/cache.js";

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
	const systemPrompt = INTENT_SYSTEM_PROMPT(projectNames);

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
			systemPrompt: SESSION_ACTION_CLASSIFIER_PROMPT,
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
			systemPrompt: RESUME_SYSTEM_PROMPT(projectNames),
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
			systemPrompt: ADD_PROJECT_SYSTEM_PROMPT,
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
