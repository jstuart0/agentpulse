import { and, desc, eq, max } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, aiQaCache } from "../../db/schema.js";
import { getAdapter } from "../ai/llm/registry.js";
import { getDefaultProvider, getProviderApiKey } from "../ai/providers-service.js";
import { addGlobalSpendCents, checkSpendBudget } from "../ai/spend-service.js";
import { resolveSession } from "./ask-resolver.js";
import type { QaIntent } from "./launch-intent-detector.js";

// Conservative per-call spend estimate: 10k token budget at Haiku rates ≈ 3 cents.
const ESTIMATED_QA_COST_CENTS = 3;

// Token budget expressed as character count. charCount / 4 ≈ tokens (standard GPT heuristic).
const TOKEN_BUDGET_QA_CHARS = 40_000; // ~10k tokens

const QA_SYSTEM_PROMPT = `You are an AI assistant analyzing an AI coding session's event transcript.
Answer the user's question based solely on the events provided. Do not speculate beyond the evidence.
At the end of your response, append a provenance line on its own line exactly as described below — do not omit it.`;

/**
 * Normalize a question for cache key computation: lowercase, trim, collapse
 * internal whitespace to a single space. This makes "  Summarize SESSION X  "
 * hash the same cache row as "summarize session x".
 */
function normalizeQuestion(question: string): string {
	return question.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Compute SHA-256 hex of the normalized question.
 * crypto.subtle.digest is async in the Web Crypto API (Bun runtime).
 */
async function hashQuestion(question: string): Promise<string> {
	const normalized = normalizeQuestion(question);
	const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
	return Buffer.from(buffer).toString("hex");
}

/**
 * Format an event row into a human-readable transcript line.
 * Extracts the most useful text from the event, falling back to event type.
 */
function formatEvent(event: {
	id: number;
	eventType: string;
	toolName: string | null;
	content: string | null;
	createdAt: string;
}): string {
	const ts = event.createdAt.slice(0, 16).replace("T", " ");
	const base = `[${ts}] ${event.eventType}`;
	if (event.toolName) return `${base}(${event.toolName})`;
	if (event.content) return `${base}: ${event.content.slice(0, 300)}`;
	return base;
}

export async function handleSessionQa(
	intent: QaIntent,
	_args: { origin: string; threadId: string },
): Promise<{ replyText: string }> {
	// 1. Resolve session.
	const resolved = await resolveSession(intent.sessionHint);
	if (!resolved.ok) {
		return { replyText: resolved.replyText };
	}
	const { sessionId } = resolved.session;

	// 2. Compute question hash.
	const questionHash = await hashQuestion(intent.question);
	const now = new Date();
	const nowIso = now.toISOString();

	// 3. Find max event id for this session (needed for both cache check and cache write).
	const [maxRow] = await db
		.select({ maxId: max(events.id) })
		.from(events)
		.where(eq(events.sessionId, sessionId));
	const maxEventId = maxRow?.maxId ?? 0;

	// 4. Cache check: valid if TTL not exceeded AND no new events since last write.
	// Small race window: max(events.id) is read before the cache row — a concurrent
	// event insert between these two reads could cause one spurious cache miss.
	// Acceptable: the result is a fresh LLM call rather than a stale cached answer.
	const [cacheRow] = await db
		.select()
		.from(aiQaCache)
		.where(and(eq(aiQaCache.sessionId, sessionId), eq(aiQaCache.questionHash, questionHash)))
		.limit(1);

	if (cacheRow && cacheRow.expiresAt > nowIso && cacheRow.lastEventId >= (maxEventId ?? 0)) {
		return { replyText: cacheRow.response };
	}

	// 5. Spend pre-flight.
	const spendCheck = await checkSpendBudget("local", null, ESTIMATED_QA_COST_CENTS);
	if (!spendCheck.allowed) {
		return { replyText: "Daily AI spend limit reached. Try again tomorrow." };
	}

	// 6. Load events newest-first for tail truncation, then take from the front
	//    until the character budget is reached. This keeps the most recent (most
	//    relevant) events and drops the oldest when truncation is needed.
	const allEvents = await db
		.select({
			id: events.id,
			eventType: events.eventType,
			toolName: events.toolName,
			content: events.content,
			createdAt: events.createdAt,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId))
		.orderBy(desc(events.id));

	let charCount = 0;
	const selectedNewestFirst: typeof allEvents = [];
	for (const evt of allEvents) {
		const line = formatEvent(evt);
		if (charCount + line.length > TOKEN_BUDGET_QA_CHARS) break;
		selectedNewestFirst.push(evt);
		charCount += line.length + 1; // +1 for newline
	}

	const truncated = selectedNewestFirst.length < allEvents.length;
	// Reverse to chronological order so the LLM reads oldest-first.
	const chronological = selectedNewestFirst.slice().reverse();

	const transcriptLines = chronological.map(formatEvent).join("\n");

	const earliestTs = chronological[0]?.createdAt?.slice(0, 16).replace("T", " ") ?? "unknown";
	const latestTs =
		chronological[chronological.length - 1]?.createdAt?.slice(0, 16).replace("T", " ") ?? "unknown";
	const eventCount = chronological.length;

	let provenanceFooter = `Based on the most recent ${eventCount} events from ${earliestTs} to ${latestTs}.`;
	if (truncated) {
		provenanceFooter += " (Oldest events omitted due to token budget.)";
	}

	// 7. LLM provider setup.
	const provider = await getDefaultProvider();
	if (!provider) {
		return {
			replyText: "No AI provider configured. Add one in Settings → AI to use Q&A.",
		};
	}
	const full = await (await import("../ai/providers-service.js")).getProvider(provider.id);
	if (!full) {
		return { replyText: "AI provider configuration could not be loaded." };
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		return { replyText: "AI provider credentials are unreadable." };
	}

	const adapter = getAdapter({
		kind: full.kind,
		apiKey,
		baseUrl: full.baseUrl ?? undefined,
	});

	// 8. Build and send LLM request.
	const transcriptPrompt =
		allEvents.length === 0
			? `No events found for this session.\n\nUser question: ${intent.question}`
			: `Session transcript:\n${transcriptLines}\n\nUser question: ${intent.question}`;

	let replyText: string;
	let actualCents = ESTIMATED_QA_COST_CENTS;

	try {
		const res = await adapter.complete({
			systemPrompt: QA_SYSTEM_PROMPT,
			transcriptPrompt,
			model: full.model,
			maxTokens: 800,
			temperature: 0.3,
			timeoutMs: 60_000,
		});

		replyText = res.text.trim() || "(no response)";
		actualCents = res.usage.estimated
			? ESTIMATED_QA_COST_CENTS
			: Math.max(
					1,
					Math.round(((res.usage.inputTokens + res.usage.outputTokens) / 1_000_000) * 100),
				);
	} catch {
		return { replyText: "The AI provider returned an error. Try again in a moment." };
	}

	// 9. Record spend (best-effort; don't block the reply).
	void addGlobalSpendCents(actualCents).catch(() => {});

	// 10. Append provenance footer.
	const fullReply = `${replyText}\n\n${provenanceFooter}`;

	// 11. Write to cache. Upsert so a concurrent request overwrites with the same data.
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
	const nowFormatted = now.toISOString().replace("T", " ").slice(0, 19);
	await db
		.insert(aiQaCache)
		.values({
			sessionId,
			questionHash,
			response: fullReply,
			lastEventId: maxEventId ?? 0,
			cachedAt: nowFormatted,
			expiresAt,
		})
		.onConflictDoUpdate({
			target: [aiQaCache.sessionId, aiQaCache.questionHash],
			set: {
				response: fullReply,
				lastEventId: maxEventId ?? 0,
				cachedAt: nowFormatted,
				expiresAt,
			},
		});

	return { replyText: fullReply };
}
