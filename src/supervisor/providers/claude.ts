import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

type ClaudePromptAction = {
	sessionId: string;
	prompt: string;
	cwd: string;
	model?: string | null;
	env?: Record<string, string>;
	managedState?: string | null;
	terminalOwner?: Record<string, unknown> | null;
	interactiveBridge?: Record<string, unknown> | null;
};

type ActivityEntry = {
	kind: "assistant" | "status" | "tool" | "error";
	text: string;
	timestamp: string;
};

type TerminalOwner = {
	app: "Terminal" | "iTerm";
	windowId: string | null;
};

type InteractiveBridge = {
	socketPath: string;
	configPath: string;
	controlDir: string;
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

function appleScriptArgs(lines: string[]) {
	return lines.flatMap((line) => ["-e", line]);
}

function systemEventsProcessName(app: TerminalOwner["app"]) {
	return app === "iTerm" ? "iTerm2" : "Terminal";
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

function buildLaunchBaseArgs(launch: LaunchRequest, executable: string) {
	const args = [executable, "--session-id", launch.launchCorrelationId];
	if (launch.model) {
		args.push("--model", launch.model);
	}
	if (launch.baseInstructions.trim()) {
		args.push("--append-system-prompt", launch.baseInstructions.trim());
	}
	return args;
}

function buildResumeBaseArgs(action: ClaudePromptAction, executable: string) {
	const args = [executable, "--resume", action.sessionId];
	if (action.model) {
		args.push("--model", action.model);
	}
	return args;
}

function buildPrompt(launch: LaunchRequest) {
	return launch.taskPrompt.trim() || "Continue working on this project.";
}

function buildActionPrompt(action: ClaudePromptAction) {
	return action.prompt.trim();
}

function buildLaunchEnv(launch: LaunchRequest) {
	return {
		...process.env,
		...launch.env,
		AGENTPULSE_LAUNCH_CORRELATION_ID: launch.launchCorrelationId,
	};
}

function buildActionEnv(action: ClaudePromptAction) {
	return {
		...process.env,
		...(action.env ?? {}),
		AGENTPULSE_LAUNCH_CORRELATION_ID: action.sessionId,
	};
}

function buildTerminalExports(launch: LaunchRequest) {
	return {
		...launch.env,
		AGENTPULSE_LAUNCH_CORRELATION_ID: launch.launchCorrelationId,
	};
}

function buildActionTerminalExports(action: ClaudePromptAction) {
	return {
		...(action.env ?? {}),
		AGENTPULSE_LAUNCH_CORRELATION_ID: action.sessionId,
	};
}

const bridgeScriptPath = fileURLToPath(
	new URL("../../../scripts/claude_terminal_bridge.py", import.meta.url),
);

async function createInteractiveBridge(
	launch: LaunchRequest,
	config: Awaited<ReturnType<typeof loadSupervisorConfig>>,
	command: string[],
) {
	const controlDir = join(homedir(), ".agentpulse", "interactive", launch.launchCorrelationId);
	const socketPath = join(controlDir, "control.sock");
	const configPath = join(controlDir, "bridge.json");
	await mkdir(controlDir, { recursive: true });
	await chmod(controlDir, 0o700);
	const bridgeConfig = {
		session_id: launch.launchCorrelationId,
		cwd: launch.cwd,
		command,
		env: buildLaunchEnv(launch),
		server_url: config.serverUrl,
		supervisor_id: config.id ?? "",
		supervisor_token: config.supervisorCredential ?? null,
		api_key: config.apiKey ?? null,
		socket_path: socketPath,
	};
	await Bun.write(configPath, JSON.stringify(bridgeConfig, null, 2));
	await chmod(configPath, 0o600);
	return {
		socketPath,
		configPath,
		controlDir,
	} satisfies InteractiveBridge;
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

async function runAppleScript(lines: string[], timeoutMs = 5000) {
	const proc = Bun.spawnSync({
		cmd: ["/usr/bin/osascript", ...appleScriptArgs(lines)],
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	if (proc.signalCode === "SIGTERM") {
		throw new Error(
			"AppleScript timed out. AgentPulse needs macOS Automation/Accessibility permission to control Terminal for interactive prompt handoff.",
		);
	}
	if (proc.exitCode !== 0) {
		const stderr = new TextDecoder().decode(proc.stderr).trim();
		if (stderr.includes("Not authorized") || stderr.includes("not allowed assistive access")) {
			throw new Error(
				"AgentPulse is not authorized to control Terminal. Enable Automation and Accessibility permissions for the AgentPulse supervisor process.",
			);
		}
		throw new Error(stderr || "AppleScript command failed.");
	}
	return new TextDecoder().decode(proc.stdout).trim();
}

async function openMacTerminal(command: string, terminalPreference?: string) {
	const app = terminalPreference?.toLowerCase().includes("iterm") ? "iTerm" : "Terminal";
	if (app === "iTerm") {
		const script = [
			`tell application "iTerm"`,
			`activate`,
			`create window with default profile`,
			`tell current session of current window to write text "${escapeAppleScript(command)}"`,
			`delay 0.2`,
			`return (id of current window as text)`,
			`end tell`,
		];
		const windowId = await runAppleScript(script);
		return { pid: null, owner: { app, windowId } satisfies TerminalOwner };
	}

	const script = [
		`tell application "Terminal"`,
		`activate`,
		`do script "${escapeAppleScript(command)}"`,
		`delay 0.2`,
		`return (id of front window as text)`,
		`end tell`,
	];
	const windowId = await runAppleScript(script);
	return { pid: null, owner: { app, windowId } satisfies TerminalOwner };
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
	const args = buildLaunchBaseArgs(launch, executable);
	args.push(buildPrompt(launch));
	const bridge = await createInteractiveBridge(launch, config, args);
	const bridgeCommand = [
		"python3",
		bridgeScriptPath,
		"--config",
		bridge.configPath,
	];

	const shellCommand = [
		`cd ${quoteShell(launch.cwd)}`,
		`exec ${bridgeCommand.map((value) => quoteShell(value)).join(" ")}`,
	].join("; ");

	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		return {
			pid: 0,
			metadata: {
				mode: "interactive_terminal",
				command: bridgeCommand,
				resolvedExecutable: executable,
				startedAt: new Date().toISOString(),
				terminalSupport: config.capabilities.terminalSupport,
				shellCommand,
				interactiveBridge: bridge,
				dryRun: true,
			} satisfies LaunchMetadata,
		};
	}

	let proc;
	let terminalOwner: TerminalOwner | null = null;
	if (config.capabilities.os === "macos") {
		const opened = await openMacTerminal(shellCommand, config.terminalPreference);
		proc = opened;
		terminalOwner = opened.owner;
	} else if (config.capabilities.os === "linux") {
		proc = await openLinuxTerminal(shellCommand, config.capabilities.terminalSupport);
	} else {
		throw new Error(`Interactive terminal launches are not implemented on ${config.capabilities.os}.`);
	}
	if ("unref" in proc && typeof proc.unref === "function") proc.unref();

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
			providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
			metadata: {
				launchMode: "interactive_terminal",
				pid: proc.pid ?? null,
				terminalOwner,
				interactiveBridge: bridge,
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
					terminalOwner,
					interactiveBridge: bridge,
				},
			},
		]);
	}

	return {
		pid: proc.pid ?? null,
		metadata: {
			mode: "interactive_terminal",
			command: bridgeCommand,
			resolvedExecutable: executable,
			startedAt: new Date().toISOString(),
			terminalSupport: config.capabilities.terminalSupport,
			terminalPreference: config.terminalPreference ?? null,
			shellCommand,
			terminalOwner,
			interactiveBridge: bridge,
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
	const args = buildLaunchBaseArgs(launch, executable);
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
			providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
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
				providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
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
				providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
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

export async function promptClaudeHeadlessSession(
	action: ClaudePromptAction,
	reportProgress: (update: HeadlessProgressUpdate) => Promise<void>,
	callbacks?: LaunchCallbacks,
) {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude";
	const args = buildResumeBaseArgs(action, executable);
	args.push(
		"--print",
		"--verbose",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		buildActionPrompt(action),
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

	const proc = Bun.spawn({
		cmd: args,
		cwd: action.cwd,
		env: buildActionEnv(action),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (callbacks) {
		await callbacks.reportState({
			sessionId: action.sessionId,
			agentType: "claude_code",
			cwd: action.cwd,
			model: action.model ?? null,
			status: "active",
			managedState: "headless",
			providerSessionId: action.sessionId,
			correlationSource: "launch_correlation_id",
			providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
			metadata: {
				launchMode: "headless",
				pid: proc.pid ?? null,
				executionState: "running",
			},
		});
		await callbacks.reportEvents([
			{
				eventType: "HeadlessPromptSubmitted",
				category: "prompt",
				content: action.prompt,
				rawPayload: { source: "agentpulse_workspace" },
			},
		]);
	}

	let lastReportAt = 0;
	let emittedActivityCount = 0;
	const flushProgress = async () => {
		const now = Date.now();
		if (now - lastReportAt < 750) return;
		lastReportAt = now;
		if (callbacks && metadata.output.activity.length > emittedActivityCount) {
			const newActivity = metadata.output.activity.slice(emittedActivityCount);
			emittedActivityCount = metadata.output.activity.length;
			await callbacks.reportEvents(newActivity.map(activityToManagedEvent));
		}
		if (callbacks) {
			await callbacks.reportState({
				sessionId: action.sessionId,
				agentType: "claude_code",
				cwd: action.cwd,
				model: action.model ?? null,
				status: "active",
				managedState: "headless",
				providerSessionId: action.sessionId,
				correlationSource: "launch_correlation_id",
				providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
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
				sessionId: action.sessionId,
				agentType: "claude_code",
				cwd: action.cwd,
				model: action.model ?? null,
				status: exitCode === 0 ? "completed" : "failed",
				managedState: exitCode === 0 ? "completed" : "failed",
				providerSessionId: action.sessionId,
				correlationSource: "launch_correlation_id",
				providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
				metadata: {
					launchMode: "headless",
					pid: proc.pid ?? null,
					executionState: metadata.executionState,
					exitCode,
				},
			});
			await callbacks.reportEvents([
				{
					eventType: exitCode === 0 ? "HeadlessPromptCompleted" : "HeadlessPromptFailed",
					category: "system_event",
					content:
						exitCode === 0
							? "Headless follow-up task completed."
							: metadata.output.stderrPreview || `Headless follow-up failed with exit code ${exitCode}.`,
					rawPayload: { source: "agentpulse_workspace", exitCode },
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

	return { pid: proc.pid, metadata, monitor };
}

export async function promptClaudeInteractiveSession(
	action: ClaudePromptAction,
	callbacks?: LaunchCallbacks,
) {
	const config = await loadSupervisorConfig();
	const interactiveBridge =
		action.interactiveBridge &&
		typeof action.interactiveBridge === "object" &&
		!Array.isArray(action.interactiveBridge) &&
		typeof action.interactiveBridge.socketPath === "string"
			? ({
					socketPath: action.interactiveBridge.socketPath,
					configPath:
						typeof action.interactiveBridge.configPath === "string"
							? action.interactiveBridge.configPath
							: "",
					controlDir:
						typeof action.interactiveBridge.controlDir === "string"
							? action.interactiveBridge.controlDir
							: "",
				} satisfies InteractiveBridge)
			: null;
	if (!interactiveBridge?.socketPath) {
		throw new Error("Interactive prompt handoff is unavailable because this session is not using an owned interactive bridge.");
	}

	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(interactiveBridge.socketPath, () => {
			socket.end(`${action.prompt}\n`);
		});
		socket.on("close", () => resolve());
		socket.on("error", (error) => reject(error));
	});

	if (callbacks) {
		await callbacks.reportState({
			sessionId: action.sessionId,
			agentType: "claude_code",
			cwd: action.cwd,
			model: action.model ?? null,
			status: "active",
			managedState: "interactive_terminal",
			providerSessionId: action.sessionId,
			correlationSource: "launch_correlation_id",
			providerCapabilitySnapshot: config.capabilities as unknown as Record<string, unknown>,
				metadata: {
					launchMode: "interactive_terminal",
					terminalOwner: action.terminalOwner ?? null,
					interactiveBridge,
				},
			});
		await callbacks.reportEvents([
			{
				eventType: "InteractivePromptSubmitted",
				category: "prompt",
				content: action.prompt,
				rawPayload: { source: "agentpulse_workspace" },
			},
			{
				eventType: "InteractivePromptHandedOff",
				category: "system_event",
				content: "Prompt handed off to the owned interactive Claude session.",
				rawPayload: { source: "agentpulse_workspace", interactiveBridge },
			},
		]);
	}

	return {
		pid: null,
		metadata: {
			mode: "interactive_terminal",
			command: [],
			resolvedExecutable: config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude",
			startedAt: new Date().toISOString(),
			terminalSupport: config.capabilities.terminalSupport,
			terminalPreference: config.terminalPreference ?? null,
			terminalOwner: action.terminalOwner ?? null,
			interactiveBridge,
			resume: true,
		} satisfies LaunchMetadata,
	};
}
