import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchRequest } from "../../shared/types.js";
import { loadSupervisorConfig } from "../config.js";
import type {
	ClaudePromptAction,
	InteractiveBridge,
	LaunchCallbacks,
	LaunchMetadata,
	TerminalOwner,
} from "./claude-shared.js";
import {
	appleScriptArgs,
	buildActionPrompt,
	buildLaunchBaseArgs,
	buildLaunchEnv,
	escapeAppleScript,
	quoteShell,
} from "./claude-shared.js";

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
			"activate",
			"create window with default profile",
			`tell current session of current window to write text "${escapeAppleScript(command)}"`,
			"delay 0.2",
			"return (id of current window as text)",
			"end tell",
		];
		const windowId = await runAppleScript(script);
		return { pid: null, owner: { app, windowId } satisfies TerminalOwner };
	}

	const script = [
		`tell application "Terminal"`,
		"activate",
		`do script "${escapeAppleScript(command)}"`,
		"delay 0.2",
		"return (id of front window as text)",
		"end tell",
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
	args.push(launch.taskPrompt.trim() || "Continue working on this project.");
	const bridge = await createInteractiveBridge(launch, config, args);
	const bridgeCommand = ["python3", bridgeScriptPath, "--config", bridge.configPath];

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
		throw new Error(
			`Interactive terminal launches are not implemented on ${config.capabilities.os}.`,
		);
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
		throw new Error(
			"Interactive prompt handoff is unavailable because this session is not using an owned interactive bridge.",
		);
	}

	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(interactiveBridge.socketPath, () => {
			socket.end(`${buildActionPrompt(action)}\n`);
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
			resolvedExecutable:
				config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude",
			startedAt: new Date().toISOString(),
			terminalSupport: config.capabilities.terminalSupport,
			terminalPreference: config.terminalPreference ?? null,
			terminalOwner: action.terminalOwner ?? null,
			interactiveBridge,
			resume: true,
		} satisfies LaunchMetadata,
	};
}
