import { spawn } from "node:child_process";
import { loadSupervisorConfig } from "../config.js";
import type {
	LaunchRequest,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	ManagedSession,
	Session,
} from "../../shared/types.js";

type LaunchMetadata = {
	mode: "headless" | "interactive_terminal";
	command: string[];
	resolvedExecutable: string;
	startedAt: string;
	[key: string]: unknown;
};

type HeadlessProgressUpdate = {
	status: "running" | "completed" | "failed";
	pid?: number | null;
	error?: string | null;
	providerLaunchMetadata: Record<string, unknown>;
};

type LaunchCallbacks = {
	reportState: (input: ManagedSessionStateInput) => Promise<{ session: Session; managedSession: ManagedSession }>;
	reportEvents: (events: ManagedSessionEventInput[]) => Promise<void>;
};

type ActivityEntry = {
	kind: "assistant" | "status" | "tool" | "error";
	text: string;
	timestamp: string;
};

const MAX_PREVIEW_CHARS = 12_000;
const MAX_ACTIVITY_ENTRIES = 18;
const NOISY_PROVIDER_EVENTS = new Set(["system", "stream", "stream_event", "rate_limit_event"]);

function quoteShell(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScript(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sanitizeCliText(value: string) {
	return value.replace(/\0/g, "").trim();
}

function appendTail(current: string, chunk: string, maxChars = MAX_PREVIEW_CHARS) {
	const next = `${current}${chunk}`;
	return next.length <= maxChars ? next : next.slice(-maxChars);
}

function pushActivity(entries: ActivityEntry[], entry: ActivityEntry) {
	const previous = entries[entries.length - 1];
	if (previous && previous.kind === entry.kind && previous.text === entry.text) return entries;
	return [...entries.slice(-(MAX_ACTIVITY_ENTRIES - 1)), entry];
}

function extractVisibleText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	if (Array.isArray(value)) return value.map((item) => extractVisibleText(item)).filter(Boolean).join("");
	const record = value as Record<string, unknown>;
	for (const key of ["text", "delta", "message", "result", "content", "completion"]) {
		const candidate = extractVisibleText(record[key]);
		if (candidate) return candidate;
	}
	return "";
}

function summarizeStreamLine(line: string): { activity?: ActivityEntry; assistantDelta?: string } | null {
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

function appendAssistantDelta(current: string, next: string) {
	const cleanNext = sanitizeCliText(next);
	if (!cleanNext) return current;
	const lastLine = current.trim().split("\n").filter(Boolean).at(-1);
	if (lastLine === cleanNext) return current;
	return appendTail(current, `${cleanNext}\n`);
}

function activityToManagedEvent(activity: ActivityEntry): ManagedSessionEventInput {
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

function buildBaseArgs(launch: LaunchRequest, executable: string) {
	const args = [executable, "--session-id", launch.launchCorrelationId];
	if (launch.model) {
		args.push("--model", launch.model);
	}
	if (launch.baseInstructions.trim()) {
		args.push("--append-system-prompt", launch.baseInstructions.trim());
	}
	return args;
}

function buildPrompt(launch: LaunchRequest) {
	return launch.taskPrompt.trim() || "Continue working on this project.";
}

function buildLaunchEnv(launch: LaunchRequest) {
	return {
		...process.env,
		...launch.env,
		AGENTPULSE_LAUNCH_CORRELATION_ID: launch.launchCorrelationId,
	};
}

function buildTerminalExports(launch: LaunchRequest) {
	return {
		...launch.env,
		AGENTPULSE_LAUNCH_CORRELATION_ID: launch.launchCorrelationId,
	};
}

async function readTextStream(
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

async function openMacTerminal(command: string, terminalPreference?: string) {
	const app = terminalPreference?.toLowerCase().includes("iterm") ? "iTerm" : "Terminal";
	if (app === "iTerm") {
		const script = [
			`tell application "iTerm"`,
			`activate`,
			`if (count of windows) = 0 then create window with default profile`,
			`tell current session of current window to write text "${escapeAppleScript(command)}"`,
			`end tell`,
		];
		return spawn("/usr/bin/osascript", script.flatMap((line) => ["-e", line]), {
			stdio: "ignore",
			detached: true,
		});
	}

	const script = [
		`tell application "Terminal" to activate`,
		`tell application "Terminal" to do script "${escapeAppleScript(command)}"`,
	];
	return spawn("/usr/bin/osascript", script.flatMap((line) => ["-e", line]), {
		stdio: "ignore",
		detached: true,
	});
}

async function openLinuxTerminal(command: string, terminalSupport: string[]) {
	const choice = terminalSupport.find((terminal) =>
		["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"].includes(terminal),
	);
	if (!choice) {
		throw new Error("No supported Linux terminal command is available for interactive launches.");
	}

	if (choice === "gnome-terminal") {
		return spawn(choice, ["--", "bash", "-lc", command], { stdio: "ignore", detached: true });
	}
	if (choice === "konsole") {
		return spawn(choice, ["-e", "bash", "-lc", command], { stdio: "ignore", detached: true });
	}
	return spawn(choice, ["-e", "bash", "-lc", command], { stdio: "ignore", detached: true });
}

export async function launchClaudeInteractiveRequest(
	launch: LaunchRequest,
	callbacks?: LaunchCallbacks,
) {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude";
	const args = buildBaseArgs(launch, executable);
	args.push(buildPrompt(launch));

	const shellCommand = [
		`cd ${quoteShell(launch.cwd)}`,
		...Object.entries(buildTerminalExports(launch)).map(([key, value]) => `export ${key}=${quoteShell(String(value))}`),
		`exec ${args.map((value) => quoteShell(value)).join(" ")}`,
	].join("; ");

	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		return {
			pid: 0,
			metadata: {
				mode: "interactive_terminal",
				command: args,
				resolvedExecutable: executable,
				startedAt: new Date().toISOString(),
				terminalSupport: config.capabilities.terminalSupport,
				shellCommand,
				dryRun: true,
			} satisfies LaunchMetadata,
		};
	}

	let proc;
	if (config.capabilities.os === "macos") {
		proc = await openMacTerminal(shellCommand, config.terminalPreference);
	} else if (config.capabilities.os === "linux") {
		proc = await openLinuxTerminal(shellCommand, config.capabilities.terminalSupport);
	} else {
		throw new Error(`Interactive terminal launches are not implemented on ${config.capabilities.os}.`);
	}
	proc.unref();

	if (callbacks) {
		await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			agentType: "claude_code",
			cwd: launch.cwd,
			model: launch.model ?? null,
			status: "active",
			managedState: "interactive_terminal",
			providerSessionId: launch.launchCorrelationId,
			correlationSource: "launch_correlation_id",
			metadata: {
				launchMode: "interactive_terminal",
				pid: proc.pid ?? null,
			},
		});
		await callbacks.reportEvents([
			{
				eventType: "InteractiveSessionLaunched",
				category: "system_event",
				content: "Interactive Claude session opened on the selected host terminal.",
				rawPayload: {
					launchMode: "interactive_terminal",
					pid: proc.pid ?? null,
				},
			},
		]);
	}

	return {
		pid: proc.pid ?? null,
		metadata: {
			mode: "interactive_terminal",
			command: args,
			resolvedExecutable: executable,
			startedAt: new Date().toISOString(),
			terminalSupport: config.capabilities.terminalSupport,
			terminalPreference: config.terminalPreference ?? null,
			shellCommand,
		} satisfies LaunchMetadata,
	};
}

export async function launchClaudeHeadlessRequest(
	launch: LaunchRequest,
	reportProgress: (update: HeadlessProgressUpdate) => Promise<void>,
	callbacks?: LaunchCallbacks,
) {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude";
	const args = buildBaseArgs(launch, executable);
	args.push(
		"--print",
		"--verbose",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		buildPrompt(launch),
	);

	const metadata: LaunchMetadata & {
		executionState: "running" | "completed" | "failed";
		output: {
			assistantPreview: string;
			stderrPreview: string;
			activity: ActivityEntry[];
			rawEventCount: number;
		};
	} = {
		mode: "headless",
		command: args,
		resolvedExecutable: executable,
		startedAt: new Date().toISOString(),
		executionState: "running",
		output: {
			assistantPreview: "",
			stderrPreview: "",
			activity: [],
			rawEventCount: 0,
		},
	};

	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		return {
			pid: 0,
			metadata: {
				...metadata,
				dryRun: true,
			},
		};
	}

	const proc = Bun.spawn({
		cmd: args,
		cwd: launch.cwd,
		env: buildLaunchEnv(launch),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (callbacks) {
		await callbacks.reportState({
			sessionId: launch.launchCorrelationId,
			launchRequestId: launch.id,
			agentType: "claude_code",
			cwd: launch.cwd,
			model: launch.model ?? null,
			status: "active",
			managedState: "headless",
			providerSessionId: launch.launchCorrelationId,
			correlationSource: "launch_correlation_id",
			metadata: {
				launchMode: "headless",
				pid: proc.pid ?? null,
			},
		});
		await callbacks.reportEvents([
			{
				eventType: "HeadlessTaskStarted",
				category: "system_event",
				content: "Headless Claude task started from AgentPulse.",
				rawPayload: {
					launchMode: "headless",
					pid: proc.pid ?? null,
				},
			},
		]);
	}

	let lastReportAt = 0;
	let emittedActivityCount = 0;
	const flushProgress = async (force = false) => {
		const now = Date.now();
		if (!force && now - lastReportAt < 750) return;
		lastReportAt = now;
		if (callbacks && metadata.output.activity.length > emittedActivityCount) {
			const newActivity = metadata.output.activity.slice(emittedActivityCount);
			emittedActivityCount = metadata.output.activity.length;
			await callbacks.reportEvents(newActivity.map(activityToManagedEvent));
		}
		if (callbacks) {
			await callbacks.reportState({
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				agentType: "claude_code",
				cwd: launch.cwd,
				model: launch.model ?? null,
				status: "active",
				managedState: "headless",
				providerSessionId: launch.launchCorrelationId,
				correlationSource: "launch_correlation_id",
				metadata: {
					launchMode: "headless",
					pid: proc.pid ?? null,
					executionState: metadata.executionState,
				},
			});
		}
		await reportProgress({
			status: "running",
			pid: proc.pid,
			providerLaunchMetadata: metadata,
		});
	};

	const stdoutTask = readTextStream(proc.stdout, async (line) => {
		const summarized = summarizeStreamLine(line);
		if (!summarized) return;
		metadata.output.rawEventCount += 1;
		if (summarized.assistantDelta) {
			metadata.output.assistantPreview = appendAssistantDelta(
				metadata.output.assistantPreview,
				summarized.assistantDelta,
			);
		}
		if (summarized.activity) {
			metadata.output.activity = pushActivity(metadata.output.activity, summarized.activity);
		}
		await flushProgress();
	});

	const stderrTask = readTextStream(proc.stderr, async (line) => {
		const cleaned = sanitizeCliText(line);
		if (!cleaned) return;
		metadata.output.stderrPreview = appendTail(metadata.output.stderrPreview, `${cleaned}\n`);
		metadata.output.activity = pushActivity(metadata.output.activity, {
			kind: "error",
			text: cleaned,
			timestamp: new Date().toISOString(),
		});
		await flushProgress();
	});

	const monitor = (async () => {
		const [exitCode] = await Promise.all([proc.exited, stdoutTask, stderrTask]);
		metadata.executionState = exitCode === 0 ? "completed" : "failed";
		metadata.completedAt = new Date().toISOString();
		metadata.exitCode = exitCode;
		metadata.durationMs =
			new Date(metadata.completedAt as string).getTime() - new Date(metadata.startedAt).getTime();

		if (callbacks) {
			if (metadata.output.activity.length > emittedActivityCount) {
				const newActivity = metadata.output.activity.slice(emittedActivityCount);
				emittedActivityCount = metadata.output.activity.length;
				await callbacks.reportEvents(newActivity.map(activityToManagedEvent));
			}
			await callbacks.reportState({
				sessionId: launch.launchCorrelationId,
				launchRequestId: launch.id,
				agentType: "claude_code",
				cwd: launch.cwd,
				model: launch.model ?? null,
				status: exitCode === 0 ? "completed" : "failed",
				managedState: exitCode === 0 ? "completed" : "failed",
				providerSessionId: launch.launchCorrelationId,
				correlationSource: "launch_correlation_id",
				metadata: {
					launchMode: "headless",
					pid: proc.pid ?? null,
					executionState: metadata.executionState,
					exitCode,
				},
			});
			await callbacks.reportEvents([
				{
					eventType: exitCode === 0 ? "HeadlessTaskCompleted" : "HeadlessTaskFailed",
					category: "system_event",
					content:
						exitCode === 0
							? "Headless Claude task completed."
							: metadata.output.stderrPreview || `Headless Claude task failed with exit code ${exitCode}.`,
					rawPayload: {
						launchMode: "headless",
						exitCode,
					},
				},
			]);
		}

		await reportProgress({
			status: exitCode === 0 ? "completed" : "failed",
			pid: proc.pid,
			error: exitCode === 0 ? null : metadata.output.stderrPreview || `Claude exited with code ${exitCode}`,
			providerLaunchMetadata: metadata,
		});
	})();

	return {
		pid: proc.pid,
		metadata,
		monitor,
	};
}
