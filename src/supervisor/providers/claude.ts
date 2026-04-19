import { loadSupervisorConfig } from "../config.js";
import type { LaunchRequest } from "../../shared/types.js";

export async function launchClaudeRequest(launch: LaunchRequest) {
	const config = await loadSupervisorConfig();
	const executable =
		config.capabilities.executables?.claude?.resolvedPath || config.claudeCommand || "claude";
	const args = [
		executable,
		"--session-id",
		launch.launchCorrelationId,
		"--print",
	];

	if (launch.model) {
		args.push("--model", launch.model);
	}

	args.push(launch.taskPrompt || launch.baseInstructions || "Start session");

	if (process.env.AGENTPULSE_SUPERVISOR_DRY_RUN === "true") {
		return {
			pid: 0,
			metadata: {
				dryRun: true,
				command: args,
				resolvedExecutable: config.capabilities.executables?.claude?.resolvedPath ?? null,
			},
		};
	}

	const proc = Bun.spawn({
		cmd: args,
		cwd: launch.cwd,
		env: {
			...process.env,
			AGENTPULSE_LAUNCH_CORRELATION_ID: launch.launchCorrelationId,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	return {
		pid: proc.pid,
		metadata: {
			command: args,
			resolvedExecutable: config.capabilities.executables?.claude?.resolvedPath ?? executable,
		},
	};
}
