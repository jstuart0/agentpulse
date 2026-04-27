import { eq, sql } from "drizzle-orm";
import type { AgentType, LaunchMode, SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import { createActionRequest } from "../ai/action-requests-service.js";
import { findActiveChannelByChatId } from "../channels/channels-service.js";
import {
	buildLaunchSpec,
	pickFirstCapableSupervisor,
	validateAgainstSupervisor,
} from "../launch-compatibility.js";
import { getCachedProjects } from "../projects/cache.js";
import { getSearchBackend } from "../search/index.js";
import { listSupervisors } from "../supervisor-registry.js";
import { normalizeTemplateInput, validateTemplateInput } from "../template-preview.js";
import type { ResumeIntent } from "./launch-intent-detector.js";
import { sendTelegramActionRequest } from "./telegram-helpers.js";

export type { ResumeIntent };

export interface HandleResumeIntentArgs {
	intent: ResumeIntent;
	origin: "web" | "telegram";
	threadId: string;
	telegramChatId?: string | null;
}

export interface HandleResumeIntentResult {
	replyText: string;
	actionRequestId: string | null;
}

// ---- Session resolution (resume-specific: needs cwd + model) ---------------

interface ResumedSessionInfo {
	sessionId: string;
	displayName: string | null;
	cwd: string | null;
	agentType: string;
	model: string | null;
	status: string;
}

const AMBIGUITY_SCORE_GAP = 0.05;

async function resolveSessionForResume(
	hint: string | null,
): Promise<
	| { ok: true; session: ResumedSessionInfo }
	| { ok: false; reason: "not_found"; replyText: string }
	| { ok: false; reason: "ambiguous"; replyText: string }
> {
	if (hint === null) {
		const [row] = await db
			.select({
				sessionId: sessions.sessionId,
				displayName: sessions.displayName,
				cwd: sessions.cwd,
				agentType: sessions.agentType,
				model: sessions.model,
				status: sessions.status,
			})
			.from(sessions)
			.where(eq(sessions.isArchived, false))
			.orderBy(sql`last_activity_at DESC`)
			.limit(1);
		if (!row) {
			return { ok: false, reason: "not_found", replyText: "No sessions found." };
		}
		return { ok: true, session: row };
	}

	const backend = getSearchBackend();
	const result = await backend.search({ q: hint, mode: "or", limit: 5 });
	const hits = result.hits;

	if (hits.length === 0) {
		return {
			ok: false,
			reason: "not_found",
			replyText: `I couldn't find a session matching **${hint}** — it may have been deleted or not exist yet.`,
		};
	}

	const bySession = new Map<string, (typeof hits)[number]>();
	for (const h of hits) {
		const existing = bySession.get(h.sessionId);
		if (!existing || h.score > existing.score) {
			bySession.set(h.sessionId, h);
		}
	}
	const unique = Array.from(bySession.values()).sort((a, b) => b.score - a.score);

	if (
		unique.length > 1 &&
		unique[0].score > 0 &&
		(unique[0].score - unique[1].score) / unique[0].score < AMBIGUITY_SCORE_GAP
	) {
		const top = unique.slice(0, 3);
		const candidates = top
			.map((h, i) => `${i + 1}. **${h.sessionDisplayName ?? h.sessionId.slice(0, 8)}**`)
			.join("\n");
		return {
			ok: false,
			reason: "ambiguous",
			replyText: `I found multiple sessions that could match — which one did you mean?\n${candidates}`,
		};
	}

	const best = unique[0];
	const [row] = await db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			cwd: sessions.cwd,
			agentType: sessions.agentType,
			model: sessions.model,
			status: sessions.status,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, best.sessionId))
		.limit(1);

	if (!row) {
		return {
			ok: false,
			reason: "not_found",
			replyText: `I couldn't find that session anymore — it may have been deleted.`,
		};
	}
	return { ok: true, session: row };
}

// ---- Public handler ---------------------------------------------------------

export async function handleResumeIntent(
	args: HandleResumeIntentArgs,
): Promise<HandleResumeIntentResult> {
	const { intent, origin, threadId, telegramChatId } = args;

	// Guard: no new prompt yet — ask for one before queuing anything.
	if (!intent.newPrompt) {
		return {
			replyText:
				"What prompt should the new session start with? Tell me what you'd like it to work on.",
			actionRequestId: null,
		};
	}

	// Resolve the parent session.
	const resolution = await resolveSessionForResume(intent.sessionHint);
	if (!resolution.ok) {
		return { replyText: resolution.replyText, actionRequestId: null };
	}

	const parentSession = resolution.session;
	const parentName = parentSession.displayName ?? parentSession.sessionId.slice(0, 8);

	// Pre-check existence: re-fetch to confirm the row is still present
	// (guards against deletion between resolution and payload creation).
	const [stillExists] = await db
		.select({ sessionId: sessions.sessionId })
		.from(sessions)
		.where(eq(sessions.sessionId, parentSession.sessionId))
		.limit(1);
	if (!stillExists) {
		return {
			replyText: `I couldn't find that session anymore — it may have been deleted.`,
			actionRequestId: null,
		};
	}

	// Build template from parent session's cwd/agentType/model.
	const agentType: AgentType =
		intent.agentType ?? (parentSession.agentType as AgentType | null) ?? "claude_code";
	const launchMode: LaunchMode = intent.mode ?? "interactive_terminal";

	const rawTemplate: Partial<SessionTemplateInput> = {
		name: `${parentName} (resumed)`,
		agentType,
		cwd: parentSession.cwd ?? "",
		model: parentSession.model ?? undefined,
		taskPrompt: intent.newPrompt,
		baseInstructions: "",
		env: {},
		tags: ["ai-initiated", "resumed"],
	};

	const template = normalizeTemplateInput(rawTemplate);

	const templateValidation = validateTemplateInput(template);
	if (templateValidation.errors.length > 0) {
		return {
			replyText: `Can't queue a resume for **${parentName}**: ${templateValidation.errors.join(" ")}`,
			actionRequestId: null,
		};
	}

	const allSupervisors = await listSupervisors();
	const connectedSupervisors = allSupervisors.filter((s) => s.status === "connected");

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
			replyText: `No host machine is available right now to resume **${parentName}**.${detail}`,
			actionRequestId: null,
		};
	}

	const launchSpec = buildLaunchSpec(template, launchMode, supervisor);

	// Resolve channel for Telegram origin.
	let channelId: string | null = null;
	if (origin === "telegram" && telegramChatId) {
		const channel = await findActiveChannelByChatId(telegramChatId);
		channelId = channel?.id ?? null;
	}

	// Find the project this session belongs to (if any) — used for inbox display.
	const cachedProjects = getCachedProjects();
	const parentProject = parentSession.cwd
		? cachedProjects.find((p) => p.cwd === parentSession.cwd)
		: null;

	// Build the question string in this handler (O-H3 / J-M3): the inbox
	// card shows this text so the user knows exactly what they're approving.
	const truncatedPrompt =
		intent.newPrompt.length > 120 ? `${intent.newPrompt.slice(0, 120)}…` : intent.newPrompt;
	const question = `Resume session **${parentName}** with new prompt: "${truncatedPrompt}" — launch a new session in \`${parentSession.cwd ?? "(unknown cwd)"}\`?`;

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
			projectId: parentProject?.id ?? null,
			projectName: parentProject?.name ?? parentName,
			// Resume traceability fields — the executor ignores these; the
			// inbox card reads them to distinguish resume from fresh launch.
			parentSessionId: parentSession.sessionId,
			parentSessionName: parentName,
		},
	});

	if (origin === "telegram" && telegramChatId) {
		await sendTelegramActionRequest(telegramChatId, actionRequest.id, question, "Resume request");
	}

	const inboxRef = origin === "telegram" ? "via the Telegram buttons I just sent" : "in the inbox";
	return {
		replyText: `Queued a resume for **${parentName}** with new prompt. Approve ${inboxRef} to start the session.`,
		actionRequestId: actionRequest.id,
	};
}
