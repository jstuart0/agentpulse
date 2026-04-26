import type { AgentType, LaunchMode, SessionTemplateInput } from "../../../shared/types.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import { getTelegramBotToken } from "../channels/telegram-credentials.js";
import {
	buildLaunchSpec,
	pickFirstCapableSupervisor,
	validateAgainstSupervisor,
} from "../launch-compatibility.js";
import { getProjectByName, listProjects } from "../projects/projects-service.js";
import { listSupervisors } from "../supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "../template-preview.js";
import type { LaunchIntent } from "./launch-intent-detector.js";

export interface HandleAskLaunchIntentArgs {
	intent: Extract<LaunchIntent, { kind: "launch" }>;
	origin: "web" | "telegram";
	threadId: string;
	/** Raw Telegram chat id (string), only present when origin="telegram". */
	telegramChatId?: string | null;
}

export interface HandleAskLaunchIntentResult {
	replyText: string;
	actionRequestId: string | null;
}

/**
 * Send an inline-button Telegram message for the action request.
 * Best-effort — failures are logged but don't block the reply.
 */
async function sendTelegramActionRequest(
	chatId: string,
	actionRequestId: string,
	question: string,
): Promise<void> {
	const token = getTelegramBotToken();
	if (!token) return;
	const keyboard = {
		inline_keyboard: [
			[
				{
					text: "Approve",
					callback_data: `act:approve:${actionRequestId}`,
				},
				{
					text: "Decline",
					callback_data: `act:decline:${actionRequestId}`,
				},
			],
		],
	};
	await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			chat_id: chatId,
			text: `AgentPulse · Launch request\n\n${question}`,
			reply_markup: keyboard,
		}),
	}).catch((err) => {
		console.warn("[ask-launch] Telegram send failed:", err);
	});
}

export async function handleAskLaunchIntent(
	args: HandleAskLaunchIntentArgs,
): Promise<HandleAskLaunchIntentResult> {
	const { intent, origin, threadId, telegramChatId } = args;

	// === Step 1: Resolve project ===
	const project = await getProjectByName(intent.projectName);
	if (!project) {
		// List known projects for a helpful reply.
		const all = await listProjects();
		const names = all.map((p) => p.name);
		const list = names.length > 0 ? names.map((n) => `• ${n}`).join("\n") : "(none configured)";
		return {
			replyText: `I don't have a project named **${intent.projectName}** configured. Known projects:\n\n${list}\n\nYou can add projects in Settings → Projects.`,
			actionRequestId: null,
		};
	}

	// === Step 2: Build template from project defaults + intent overrides ===
	const agentType: AgentType =
		intent.agentType ?? (project.defaultAgentType as AgentType | null) ?? "claude_code";
	const launchMode: LaunchMode =
		intent.mode ?? (project.defaultLaunchMode as LaunchMode | null) ?? "interactive_terminal";

	const rawTemplate: Partial<SessionTemplateInput> = {
		name: `${project.name} (ask-initiated)`,
		agentType,
		cwd: project.cwd,
		model: project.defaultModel ?? undefined,
		taskPrompt: intent.taskHint ?? "",
		baseInstructions: "",
		env: {},
		tags: ["ai-initiated", `project:${project.name}`],
	};

	const template = normalizeTemplateInput(rawTemplate);

	// === Step 3: Pure validation pass (no DB writes) ===
	const templateValidation = validateTemplateInput(template);
	if (templateValidation.errors.length > 0) {
		return {
			replyText: `Can't queue a launch for **${project.name}**: ${templateValidation.errors.join(" ")}`,
			actionRequestId: null,
		};
	}

	// Surface validation warnings that indicate guaranteed failure.
	if (
		templateValidation.warnings.some(
			(w) => w.toLowerCase().includes("headless") && agentType !== "claude_code",
		)
	) {
		return {
			replyText: `Can't queue a headless launch for **${project.name}**: headless mode only applies to Claude Code. Specify agent type "claude" or remove the headless override.`,
			actionRequestId: null,
		};
	}

	const allSupervisors = await listSupervisors();
	const connectedSupervisors = allSupervisors.filter((s) => s.status === "connected");

	// Check for headless+codex incompatibility explicitly (surface before creating request).
	if (launchMode === "headless" && agentType === "codex_cli") {
		const { errors } = validateAgainstSupervisor(
			template,
			connectedSupervisors[0] ?? {
				id: "noop",
				hostName: "noop",
				platform: "linux",
				arch: "x64",
				version: "0",
				capabilities: {
					version: 1,
					agentTypes: ["codex_cli"],
					launchModes: ["headless"],
					os: "linux",
					terminalSupport: [],
					features: [],
				},
				trustedRoots: [],
				status: "connected",
				capabilitySchemaVersion: 1,
				configSchemaVersion: 1,
				lastHeartbeatAt: new Date().toISOString(),
				heartbeatLeaseExpiresAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			launchMode,
		);
		// errors will include "Headless launch mode currently applies to Claude Code only."
		if (errors.some((e) => e.includes("Headless"))) {
			return {
				replyText: `Can't queue that launch: headless mode only applies to Claude Code, not Codex. Try without "headless" or specify Claude.`,
				actionRequestId: null,
			};
		}
	}

	const supervisor = pickFirstCapableSupervisor(template, launchMode, connectedSupervisors);
	if (!supervisor) {
		const capabilityErrors: string[] = [];
		for (const s of connectedSupervisors) {
			const { errors } = validateAgainstSupervisor(template, s, launchMode);
			capabilityErrors.push(...errors.map((e) => `${s.hostName}: ${e}`));
		}
		const detail =
			capabilityErrors.length > 0 ? `\n\nDetails: ${capabilityErrors.slice(0, 3).join("; ")}` : "";
		return {
			replyText: `No host machine is available right now to launch **${project.name}**.${detail}`,
			actionRequestId: null,
		};
	}

	const launchSpec = buildLaunchSpec(template, launchMode, supervisor);

	// === Step 4: Resolve channel UUID for Telegram origin ===
	let channelId: string | null = null;
	if (origin === "telegram" && telegramChatId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	// === Step 5: Create action request ===
	const question = `Launch ${agentType} (${launchMode}) for **${project.name}** at \`${project.cwd}\`?${intent.taskHint ? `\nTask: ${intent.taskHint}` : ""}`;

	const actionRequest = await createActionRequest({
		kind: "launch_request",
		question,
		origin,
		channelId,
		askThreadId: threadId,
		payload: {
			template,
			launchSpec,
			requestedLaunchMode: launchMode,
			validatedSupervisorId: supervisor.id,
			projectId: project.id,
			projectName: project.name,
		},
	});

	// === Step 6: Send Telegram inline buttons if origin=telegram ===
	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question);
	}

	const inboxRef = origin === "telegram" ? "via the Telegram buttons I just sent" : "in the inbox";
	return {
		replyText: `Queued a launch for **${project.name}** (${agentType}, ${launchMode}). Approve ${inboxRef} to start the session.`,
		actionRequestId: actionRequest.id,
	};
}
