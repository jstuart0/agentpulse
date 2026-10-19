import { launchEnvErrors } from "../../shared/launch-env-policy.js";
import { LaunchPrivilegeError, requireLaunchPrivileges } from "../../shared/launch-privileges.js";
import type {
	LaunchRequest,
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	ManagedState,
	Session,
} from "../../shared/types.js";

export type LaunchMetadata = {
	mode: "headless" | "interactive_terminal";
	command: string[];
	resolvedExecutable: string;
	startedAt: string;
	[key: string]: unknown;
};

export type HeadlessProgressUpdate = {
	status: "running" | "completed" | "failed";
	pid?: number | null;
	error?: string | null;
	providerLaunchMetadata: Record<string, unknown>;
};

export type LaunchCallbacks = {
	reportState: (
		input: ManagedSessionStateInput,
	) => Promise<{ session: Session; managedSession: ManagedSession }>;
	reportEvents: (events: ManagedSessionEventInput[]) => Promise<void>;
};

export type ClaudePromptAction = {
	sessionId: string;
	/**
	 * The launch's recorded privileges, re-applied when a resume starts a new process.
	 * `undefined` means the action didn't carry them, and a resume refuses to start.
	 */
	approvalPolicy?: unknown;
	sandboxMode?: unknown;
	prompt: string;
	cwd: string;
	model?: string | null;
	env?: Record<string, string>;
	managedState?: ManagedState | null;
	terminalOwner?: Record<string, unknown> | null;
	interactiveBridge?: Record<string, unknown> | null;
};

export type ActivityEntry = {
	kind: "assistant" | "status" | "tool" | "error";
	text: string;
	timestamp: string;
};

export type TerminalOwner = {
	app: "Terminal" | "iTerm";
	windowId: string | null;
};

export type InteractiveBridge = {
	socketPath: string;
	configPath: string;
	controlDir: string;
};

export const MAX_PREVIEW_CHARS = 12_000;
export const MAX_ACTIVITY_ENTRIES = 18;
const NOISY_PROVIDER_EVENTS = new Set(["system", "stream", "stream_event", "rate_limit_event"]);

export function quoteShell(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function escapeAppleScript(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function appleScriptArgs(lines: string[]) {
	return lines.flatMap((line) => ["-e", line]);
}

export function sanitizeCliText(value: string) {
	return value.replace(/\0/g, "").trim();
}

export function appendTail(current: string, chunk: string, maxChars = MAX_PREVIEW_CHARS) {
	const next = `${current}${chunk}`;
	return next.length <= maxChars ? next : next.slice(-maxChars);
}

export function pushActivity(entries: ActivityEntry[], entry: ActivityEntry) {
	const previous = entries[entries.length - 1];
	if (previous && previous.kind === entry.kind && previous.text === entry.text) return entries;
	return [...entries.slice(-(MAX_ACTIVITY_ENTRIES - 1)), entry];
}

function extractVisibleText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	if (Array.isArray(value))
		return value
			.map((item) => extractVisibleText(item))
			.filter(Boolean)
			.join("");
	const record = value as Record<string, unknown>;
	for (const key of ["text", "delta", "message", "result", "content", "completion"]) {
		const candidate = extractVisibleText(record[key]);
		if (candidate) return candidate;
	}
	return "";
}

export function summarizeStreamLine(
	line: string,
): { activity?: ActivityEntry; assistantDelta?: string } | null {
	const timestamp = new Date().toISOString();
	const trimmed = line.trim();
	if (!trimmed) return null;

	try {
		const payload = JSON.parse(trimmed) as Record<string, unknown>;
		const providerEventType =
			typeof payload.type === "string"
				? payload.type
				: typeof payload.event === "string"
					? payload.event
					: "stream";
		const text = sanitizeCliText(extractVisibleText(payload));

		if (typeof payload.tool_name === "string") {
			return {
				activity: {
					kind: "tool",
					text: text ? `${payload.tool_name}: ${text}` : `Using ${payload.tool_name}`,
					timestamp,
				},
			};
		}

		if (providerEventType.includes("error")) {
			return {
				activity: {
					kind: "error",
					text: text || providerEventType,
					timestamp,
				},
			};
		}

		if (providerEventType.includes("assistant") || providerEventType.includes("message")) {
			if (!text) return null;
			return {
				assistantDelta: text,
				activity: {
					kind: "assistant",
					text,
					timestamp,
				},
			};
		}

		if (providerEventType.includes("result") || providerEventType.includes("complete")) {
			if (!text) {
				return {
					activity: {
						kind: "status",
						text: "Task completed.",
						timestamp,
					},
				};
			}
			return {
				assistantDelta: text,
				activity: {
					kind: "assistant",
					text,
					timestamp,
				},
			};
		}

		if (NOISY_PROVIDER_EVENTS.has(providerEventType) && !text) {
			return null;
		}

		if (text) {
			return {
				activity: {
					kind: "status",
					text,
					timestamp,
				},
			};
		}

		return null;
	} catch {
		return {
			assistantDelta: trimmed,
			activity: {
				kind: "assistant",
				text: trimmed,
				timestamp,
			},
		};
	}
}

export function appendAssistantDelta(current: string, next: string) {
	const cleanNext = sanitizeCliText(next);
	if (!cleanNext) return current;
	const lastLine = current.trim().split("\n").filter(Boolean).at(-1);
	if (lastLine === cleanNext) return current;
	return appendTail(current, `${cleanNext}\n`);
}

export function activityToManagedEvent(activity: ActivityEntry): ManagedSessionEventInput {
	if (activity.kind === "assistant") {
		return {
			eventType: "HeadlessAssistantMessage",
			category: "assistant_message",
			content: activity.text,
			rawPayload: { source: "claude_headless", timestamp: activity.timestamp },
		};
	}
	if (activity.kind === "error") {
		return {
			eventType: "HeadlessError",
			category: "status_update",
			content: activity.text,
			rawPayload: { source: "claude_headless", timestamp: activity.timestamp, level: "error" },
		};
	}
	return {
		eventType: "HeadlessStatus",
		category: "progress_update",
		content: activity.text,
		rawPayload: { source: "claude_headless", timestamp: activity.timestamp, kind: activity.kind },
	};
}

/** What the launch's recorded privileges become for Claude Code. Throws when they can't be applied. */
export function claudeLaunchPrivileges(launch: LaunchRequest) {
	return requireLaunchPrivileges("claude_code", launch.approvalPolicy, launch.sandboxMode);
}

/** Same for a resume, which has no row: an action that didn't carry the privileges is refused. */
export function claudeResumePrivileges(action: ClaudePromptAction) {
	if (action.approvalPolicy === undefined || action.sandboxMode === undefined) {
		throw new LaunchPrivilegeError([
			"This resume doesn't carry the launch's approval policy and sandbox mode, so it can't be started with the right privileges. Start a new launch instead.",
		]);
	}
	return requireLaunchPrivileges("claude_code", action.approvalPolicy, action.sandboxMode);
}

export function buildLaunchBaseArgs(launch: LaunchRequest, executable: string) {
	const privileges = claudeLaunchPrivileges(launch);
	assertEnvAllowed(launch.env);
	const args = [executable, "--session-id", launch.launchCorrelationId];
	if (launch.model) {
		args.push("--model", launch.model);
	}
	args.push(...privileges.cliArgs);
	if (launch.baseInstructions.trim()) {
		args.push("--append-system-prompt", launch.baseInstructions.trim());
	}
	return args;
}

export function buildResumeBaseArgs(action: ClaudePromptAction, executable: string) {
	const privileges = claudeResumePrivileges(action);
	assertEnvAllowed(action.env);
	const args = [executable, "--resume", action.sessionId];
	if (action.model) {
		args.push("--model", action.model);
	}
	args.push(...privileges.cliArgs);
	return args;
}

/**
 * A prompt that starts with '-' could be read as an option if it ever reached the command
 * line bare. It is always placed after `--` as well; refusing it is the second layer.
 */
export function assertPromptNotOption(prompt: string): string {
	if (prompt.startsWith("-")) {
		throw new LaunchPrivilegeError([
			"The prompt starts with '-', which could be read as a command-line option. Start it with a word instead.",
		]);
	}
	return prompt;
}

export function buildPrompt(launch: LaunchRequest) {
	return assertPromptNotOption(launch.taskPrompt.trim() || "Continue working on this project.");
}

/** For a prompt delivered as the last argv element (a headless resume). */
export function buildActionPrompt(action: ClaudePromptAction) {
	return assertPromptNotOption(action.prompt.trim());
}

function assertEnvAllowed(env: Record<string, unknown> | undefined) {
	const errors = launchEnvErrors(env);
	if (errors.length > 0) throw new LaunchPrivilegeError(errors);
}

export function buildLaunchEnv(launch: LaunchRequest) {
	assertEnvAllowed(launch.env);
	return {
		...process.env,
		...launch.env,
		AGENTPULSE_LAUNCH_CORRELATION_ID: launch.launchCorrelationId,
	};
}

export function buildActionEnv(action: ClaudePromptAction) {
	assertEnvAllowed(action.env);
	return {
		...process.env,
		...(action.env ?? {}),
		AGENTPULSE_LAUNCH_CORRELATION_ID: action.sessionId,
	};
}

export async function readTextStream(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => Promise<void> | void,
) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				await onLine(line);
			}
		}
		const rest = buffer + decoder.decode();
		if (rest.trim()) {
			await onLine(rest);
		}
	} finally {
		reader.releaseLock();
	}
}
