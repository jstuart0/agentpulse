import { homedir, hostname, platform, arch } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";
import type { SupervisorRegistrationInput } from "../shared/types.js";

export interface SupervisorConfig {
	serverUrl: string;
	apiKey?: string;
	id?: string;
	hostName: string;
	platform: string;
	arch: string;
	version: string;
	trustedRoots: string[];
	capabilities: SupervisorRegistrationInput["capabilities"];
}

const defaultConfigPath = join(homedir(), ".agentpulse", "supervisor.json");

export async function loadSupervisorConfig() {
	const file = Bun.file(defaultConfigPath);
	const exists = await file.exists();
	if (exists) {
		return (await file.json()) as SupervisorConfig;
	}

	return {
		serverUrl: process.env.AGENTPULSE_SERVER_URL || "http://localhost:3000",
		apiKey: process.env.AGENTPULSE_API_KEY,
		id: process.env.AGENTPULSE_SUPERVISOR_ID,
		hostName: hostname(),
		platform: platform(),
		arch: arch(),
		version: "0.1.0",
		trustedRoots: [join(homedir(), "dev")],
		capabilities: {
			version: 1,
			agentTypes: ["claude_code", "codex_cli"],
			launchModes: ["interactive_terminal", "managed_codex"],
			os:
				platform() === "darwin"
					? "macos"
					: platform() === "linux"
						? "linux"
						: platform() === "win32"
							? "windows"
							: "unknown",
			terminalSupport: [],
			features: ["can_write_agents_md", "can_write_claude_md", "managed_codex"],
		},
	} satisfies SupervisorConfig;
}

export async function saveSupervisorConfig(config: SupervisorConfig) {
	await mkdir(join(homedir(), ".agentpulse"), { recursive: true });
	await Bun.write(defaultConfigPath, JSON.stringify(config, null, 2));
}
