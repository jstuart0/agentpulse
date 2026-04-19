import { homedir, hostname, platform, arch } from "os";
import { delimiter, isAbsolute, join } from "path";
import { mkdir } from "fs/promises";
import { accessSync, constants } from "fs";
import type { SupervisorRegistrationInput } from "../shared/types.js";

export interface SupervisorConfig {
	serverUrl: string;
	apiKey?: string;
	supervisorCredential?: string;
	enrollmentToken?: string;
	id?: string;
	hostName: string;
	platform: string;
	arch: string;
	version: string;
	trustedRoots: string[];
	capabilities: SupervisorRegistrationInput["capabilities"];
	claudeCommand?: string;
	codexCommand?: string;
	terminalPreference?: string;
}

const defaultConfigPath = join(homedir(), ".agentpulse", "supervisor.json");

function currentOs() {
	return platform() === "darwin"
		? "macos"
		: platform() === "linux"
			? "linux"
			: platform() === "win32"
				? "windows"
				: "unknown";
}

function buildDefaultConfig(): SupervisorConfig {
	return {
		serverUrl: process.env.AGENTPULSE_SERVER_URL || "http://localhost:3000",
		apiKey: process.env.AGENTPULSE_API_KEY,
		supervisorCredential: process.env.AGENTPULSE_SUPERVISOR_CREDENTIAL,
		enrollmentToken: process.env.AGENTPULSE_SUPERVISOR_ENROLLMENT_TOKEN,
		id: process.env.AGENTPULSE_SUPERVISOR_ID,
		hostName: hostname(),
		platform: platform(),
		arch: arch(),
		version: "0.1.0",
		trustedRoots: [join(homedir(), "dev")],
		claudeCommand: process.env.AGENTPULSE_CLAUDE_COMMAND,
		codexCommand: process.env.AGENTPULSE_CODEX_COMMAND,
		terminalPreference: process.env.AGENTPULSE_TERMINAL_APP,
		capabilities: {
			version: 1,
			agentTypes: ["claude_code", "codex_cli"],
			launchModes: ["headless", "managed_codex"],
			os: currentOs(),
			terminalSupport: [],
			features: ["can_write_agents_md", "can_write_claude_md", "managed_codex", "headless_claude"],
		},
	};
}

function canExecute(path: string) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveExecutable(command: string | undefined, fallback: string) {
	const candidate = (command || fallback).trim() || fallback;
	if (isAbsolute(candidate)) {
		return {
			command: candidate,
			resolvedPath: canExecute(candidate) ? candidate : null,
			source: command ? "config" : "auto",
		} as const;
	}

	for (const root of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
		const full = join(root, candidate);
		if (canExecute(full)) {
			return {
				command: candidate,
				resolvedPath: full,
				source: command ? "config" : "auto",
			} as const;
		}
	}

	return {
		command: candidate,
		resolvedPath: null,
		source: command ? "config" : "auto",
	} as const;
}

function detectTerminalSupport(config: SupervisorConfig) {
	const detected: string[] = [];
	const preference = config.terminalPreference?.trim();
	const os = currentOs();

	if (preference) {
		detected.push(preference);
	}

	if (os === "macos") {
		if (canExecute("/usr/bin/osascript")) detected.push("terminal_app");
	}

	if (os === "linux") {
		for (const candidate of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
			if (resolveExecutable(undefined, candidate).resolvedPath) detected.push(candidate);
		}
	}

	if (os === "windows") {
		detected.push("windows_terminal");
	}

	return [...new Set(detected)];
}

function detectInteractiveTerminalControl(os: SupervisorRegistrationInput["capabilities"]["os"]) {
	if (!resolveExecutable(undefined, "python3").resolvedPath) {
		return {
			available: false,
			reason: "python3 is required for the interactive session bridge.",
		};
	}

	if (os !== "macos" && os !== "linux") {
		return {
			available: false,
			reason: "Interactive prompt handoff is only implemented for macOS and Linux right now.",
		};
	}

	return {
		available: true,
		reason: null,
	};
}

function withExecutableCapabilities(config: SupervisorConfig): SupervisorConfig {
	const claude = resolveExecutable(config.claudeCommand, "claude");
	const codex = resolveExecutable(config.codexCommand, "codex");
	const terminalSupport = detectTerminalSupport(config);
	const interactiveTerminalControl = detectInteractiveTerminalControl(currentOs());
	const launchModes: SupervisorRegistrationInput["capabilities"]["launchModes"] = ["headless"];
	if (terminalSupport.length > 0) launchModes.push("interactive_terminal");
	if (codex.resolvedPath) launchModes.push("managed_codex");
	return {
		...config,
		capabilities: {
			...config.capabilities,
			launchModes,
			terminalSupport,
			features: [
				"can_write_agents_md",
				"can_write_claude_md",
				"headless_claude",
				...(terminalSupport.length > 0 ? ["interactive_terminal"] : []),
				...(interactiveTerminalControl.available ? ["interactive_terminal_control"] : []),
				...(codex.resolvedPath ? ["managed_codex"] : []),
			],
			interactiveTerminalControl,
			executables: {
				claude: {
					available: Boolean(claude.resolvedPath),
					command: claude.command,
					resolvedPath: claude.resolvedPath,
					source: claude.source,
				},
				codex: {
					available: Boolean(codex.resolvedPath),
					command: codex.command,
					resolvedPath: codex.resolvedPath,
					source: codex.source,
				},
			},
		},
	};
}

export async function loadSupervisorConfig() {
	const defaults = buildDefaultConfig();
	const file = Bun.file(defaultConfigPath);
	const exists = await file.exists();
	if (exists) {
		const raw = (await file.json()) as Partial<SupervisorConfig>;
		return withExecutableCapabilities({
			...defaults,
			...raw,
			capabilities: {
				...defaults.capabilities,
				...(raw.capabilities ?? {}),
			},
		});
	}

	return withExecutableCapabilities(defaults);
}

export async function saveSupervisorConfig(config: SupervisorConfig) {
	await mkdir(join(homedir(), ".agentpulse"), { recursive: true });
	await Bun.write(defaultConfigPath, JSON.stringify(config, null, 2));
}
