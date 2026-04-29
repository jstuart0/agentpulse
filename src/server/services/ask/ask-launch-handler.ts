import { and, eq, gt } from "drizzle-orm";
import type {
	AgentType,
	AskThreadOrigin,
	LaunchMode,
	PrelaunchAction,
	SessionTemplateInput,
} from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import {
	buildLaunchSpec,
	pickFirstCapableSupervisor,
	validateAgainstSupervisor,
} from "../launch-compatibility.js";
import { randomSlugSuffix, slugifyTaskName } from "../name-generator.js";
import { getProjectByName, listProjects } from "../projects/projects-service.js";
import { listSupervisors } from "../supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "../template-preview.js";
import type { LaunchIntent, TaskBrief } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

/**
 * Resolve a unique-within-project display name from the slug. If another
 * session in the same project picked the same slug in the last 7 days,
 * append a 4-char random suffix so the dashboard isn't ambiguous.
 */
async function ensureUniqueDisplayName(slug: string, projectId: string): Promise<string> {
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const [conflict] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.projectId, projectId),
				eq(sessions.displayName, slug),
				gt(sessions.startedAt, cutoff),
			),
		)
		.limit(1);
	if (!conflict) return slug;
	return `${slug}-${randomSlugSuffix()}`;
}

const READ_CLAUDE_MD_PREFIX = "Read CLAUDE.md if present in this directory before starting.";

/**
 * Render the launched session's initial prompt. Prefer the structured
 * taskBrief when the classifier emitted one; otherwise fall back to the
 * free-text taskHint. Returns "" when neither is present so the existing
 * "no prompt" launch path stays unchanged.
 */
export function formatTaskPrompt(
	taskBrief: TaskBrief | undefined,
	taskHint: string | undefined,
): string {
	if (taskBrief) {
		const lines: string[] = [];
		lines.push(READ_CLAUDE_MD_PREFIX);
		lines.push("");
		lines.push(`Task: ${taskBrief.summary}`);
		if (taskBrief.outputPath) {
			lines.push(`- Place the deliverable under \`${taskBrief.outputPath}\` if relevant.`);
		}
		if (taskBrief.format) {
			lines.push(`- Use ${taskBrief.format} format.`);
		}
		lines.push("- Follow project conventions (see CLAUDE.md / existing files for examples).");
		lines.push("");
		lines.push("Report when done.");
		return lines.join("\n");
	}
	if (taskHint && taskHint.length > 0) {
		return `${READ_CLAUDE_MD_PREFIX}\n\n${taskHint}`;
	}
	return "";
}

export interface HandleAskLaunchIntentArgs {
	intent: Extract<LaunchIntent, { kind: "launch" }>;
	origin: AskThreadOrigin;
	threadId: string;
	/** Raw Telegram chat id (string), only present when origin="telegram". */
	telegramChatId?: string | null;
	/**
	 * Slice 5d: prelaunch actions that the supervisor must run before the
	 * agent invocation. When supplied, supervisor selection filters to hosts
	 * advertising the matching capability flags (bob §10.2). The actions are
	 * attached to the LaunchSpec so they survive the action_request →
	 * launch_request handoff.
	 */
	prelaunchActions?: PrelaunchAction[];
}

export interface HandleAskLaunchIntentResult {
	replyText: string;
	actionRequestId: string | null;
}

export async function handleAskLaunchIntent(
	args: HandleAskLaunchIntentArgs,
): Promise<HandleAskLaunchIntentResult> {
	const { intent, origin, threadId, telegramChatId, prelaunchActions } = args;

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
		taskPrompt: formatTaskPrompt(intent.taskBrief, intent.taskHint),
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

	const supervisor = pickFirstCapableSupervisor(
		template,
		launchMode,
		connectedSupervisors,
		prelaunchActions,
	);
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

	const launchSpec = buildLaunchSpec(template, launchMode, supervisor, prelaunchActions);

	// === Step 4: Resolve channel UUID for Telegram origin ===
	let channelId: string | null = null;
	if (origin === "telegram" && telegramChatId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	// Slice 3: derive a task-flavored display name from the classifier output
	// (or taskBrief / taskHint as fallbacks) and disambiguate against recent
	// sessions in the same project. Stays undefined when nothing usable
	// survives slugification — callers fall back to generateSessionName().
	const displayNameCandidate =
		slugifyTaskName(intent.displayName ?? "") ||
		slugifyTaskName(intent.taskBrief?.summary ?? intent.taskHint ?? "");
	const desiredDisplayName = displayNameCandidate
		? await ensureUniqueDisplayName(displayNameCandidate, project.id)
		: undefined;

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
			aiInitiated: true,
			askThreadId: threadId,
			desiredDisplayName,
		},
	});

	// === Step 6: Send Telegram inline buttons if origin=telegram ===
	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, "Launch request");
	}

	const inboxRef = origin === "telegram" ? "via the Telegram buttons I just sent" : "in the inbox";
	return {
		replyText: `Queued a launch for **${project.name}** (${agentType}, ${launchMode}). Approve ${inboxRef} to start the session.`,
		actionRequestId: actionRequest.id,
	};
}
