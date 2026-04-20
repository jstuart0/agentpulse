import { desc, eq } from "drizzle-orm";
import type { SessionTemplateInput } from "../../../shared/types.js";
import { db } from "../../db/client.js";
import { events, sessionTemplates, sessions } from "../../db/schema.js";

/**
 * Template distillation service. Consumes a successful session's
 * history and proposes a reviewable draft template that can be fed
 * into the existing validation / preview pipeline. Never writes the
 * template itself — the caller must go through the preview + save UX
 * so operators retain review authority.
 */

export interface TemplateDraft {
	source: {
		fromSessionIds: string[];
		generatedAt: string;
		providerId?: string | null;
		model?: string | null;
	};
	draft: SessionTemplateInput;
	notes: string[];
}

export interface DistillInput {
	sessionId: string;
	now?: Date;
	/** Optional existing template to "improve from outcomes". */
	baseTemplateId?: string | null;
	/** For provenance only — which LLM provider/model produced this (if any). */
	providerId?: string | null;
	model?: string | null;
}

export async function distillTemplate(input: DistillInput): Promise<TemplateDraft | null> {
	const [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, input.sessionId))
		.limit(1);
	if (!session) return null;

	const now = input.now ?? new Date();
	const notes: string[] = [];

	const base = input.baseTemplateId
		? (
				await db
					.select()
					.from(sessionTemplates)
					.where(eq(sessionTemplates.id, input.baseTemplateId))
					.limit(1)
			)[0]
		: null;
	if (input.baseTemplateId && !base) {
		notes.push(`baseTemplate ${input.baseTemplateId} not found; starting from session`);
	}

	// Grab the last N user prompts + assistant messages to seed the
	// baseInstructions / taskPrompt. We keep this deterministic; an
	// optional LLM-synthesized title/summary is a future hook.
	const recent = await db
		.select()
		.from(events)
		.where(eq(events.sessionId, input.sessionId))
		.orderBy(desc(events.createdAt))
		.limit(200);

	const userPrompts = recent
		.filter((e) => e.category === "prompt")
		.map((e) => (e.content ?? "").trim())
		.filter(Boolean)
		.reverse();

	const firstPrompt = userPrompts[0] ?? "";
	const laterPrompts = userPrompts.slice(1, 5);

	const assistantSummaries = recent
		.filter((e) => e.category === "assistant_message")
		.map((e) => (e.content ?? "").trim())
		.filter(Boolean);
	const lastSummary = assistantSummaries[0] ?? "";

	const name = base?.name
		? `${base.name} (distilled ${now.toISOString().slice(0, 10)})`
		: `${session.displayName ?? session.sessionId.slice(0, 8)} template`;

	const description = base?.description ?? lastSummary.slice(0, 200);

	const baseInstructions = (base?.baseInstructions ?? session.claudeMdContent ?? "").trim();
	const taskPrompt = base?.taskPrompt?.trim()
		? base.taskPrompt
		: buildTaskPromptFromHistory(firstPrompt, laterPrompts, session.currentTask);

	const tags = dedupeTags([...(base?.tags ?? []), "distilled"]);

	const draft: SessionTemplateInput = {
		name,
		description,
		agentType: (base?.agentType ?? session.agentType) as SessionTemplateInput["agentType"],
		cwd: base?.cwd ?? session.cwd ?? "",
		baseInstructions,
		taskPrompt,
		model: base?.model ?? session.model ?? null,
		approvalPolicy: base?.approvalPolicy as SessionTemplateInput["approvalPolicy"],
		sandboxMode: base?.sandboxMode as SessionTemplateInput["sandboxMode"],
		env: base?.env ?? {},
		tags,
		isFavorite: false,
	};

	const fromSessionIds = [input.sessionId];
	return {
		source: {
			fromSessionIds,
			generatedAt: now.toISOString(),
			providerId: input.providerId ?? null,
			model: input.model ?? null,
		},
		draft,
		notes,
	};
}

export function provenanceMetadata(draft: TemplateDraft, fromTemplateId?: string | null) {
	return {
		provenance: {
			source: "ai_distillation",
			fromSessionIds: draft.source.fromSessionIds,
			fromTemplateId: fromTemplateId ?? null,
			generatedAt: draft.source.generatedAt,
			providerId: draft.source.providerId ?? null,
			model: draft.source.model ?? null,
		},
	};
}

function buildTaskPromptFromHistory(
	firstPrompt: string,
	laterPrompts: string[],
	currentTask: string | null,
): string {
	const parts: string[] = [];
	if (currentTask?.trim()) parts.push(currentTask.trim());
	if (firstPrompt) parts.push(`Starting prompt from successful session:\n${firstPrompt}`);
	if (laterPrompts.length > 0) {
		parts.push(
			`Additional prompts that shaped the run:\n${laterPrompts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
		);
	}
	return parts.join("\n\n").trim() || "Continue the work from the reference session.";
}

function dedupeTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of tags) {
		const k = t.trim();
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(k);
	}
	return out;
}
