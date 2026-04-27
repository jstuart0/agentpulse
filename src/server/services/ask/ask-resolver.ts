import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import { getSearchBackend } from "../search/index.js";

/**
 * Minimal session projection for session-action handlers: enough to route
 * the action and compose a reply, without loading the full session row.
 */
export interface ResolvedSession {
	sessionId: string;
	displayName: string | null;
	status: string;
	agentType: string;
}

export type ResolveSessionResult =
	| { ok: true; session: ResolvedSession }
	| { ok: false; reason: "not_found"; replyText: string }
	| { ok: false; reason: "ambiguous"; replyText: string };

/**
 * Ambiguity threshold: if the top two BM25 scores are within 5% of each
 * other we treat the match as ambiguous and ask for clarification rather
 * than silently picking the first hit. Combined with the >1-hit check this
 * protects against wrong-session mutations on non-deterministic FTS tiebreaks.
 */
const AMBIGUITY_SCORE_GAP = 0.05;

/**
 * Map a free-form session name hint to a single session row.
 *
 * - `hint === null` → recency fallback: most recently active non-archived session.
 * - Single clear winner → `{ ok: true, session }`.
 * - Multiple sessions within the ambiguity gap → `{ ok: false, reason: "ambiguous" }`.
 * - No matches → `{ ok: false, reason: "not_found" }`.
 *
 * This is the canonical resolver for single-session action handlers
 * (pin/note/rename/stop/archive/delete). Slice B (Q&A) and Slice C (bulk)
 * import from here instead of depending on ask-session-action-handler.
 */
export async function resolveSession(hint: string | null): Promise<ResolveSessionResult> {
	if (hint === null) {
		// Recency fallback: no name hint → most recently active non-archived session.
		const [row] = await db
			.select({
				sessionId: sessions.sessionId,
				displayName: sessions.displayName,
				status: sessions.status,
				agentType: sessions.agentType,
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
			replyText: `I couldn't find a session matching **${hint}** — try a more specific name.`,
		};
	}

	// Deduplicate by sessionId (take highest-score hit per session).
	const bySession = new Map<string, (typeof hits)[number]>();
	for (const h of hits) {
		const existing = bySession.get(h.sessionId);
		if (!existing || h.score > existing.score) {
			bySession.set(h.sessionId, h);
		}
	}
	const unique = Array.from(bySession.values()).sort((a, b) => b.score - a.score);

	// Ambiguous: multiple sessions where the top two scores are within the gap threshold.
	// We ask for clarification rather than silently picking the first.
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
	// Load full session row to get status + agentType.
	const [row] = await db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			status: sessions.status,
			agentType: sessions.agentType,
		})
		.from(sessions)
		.where(eq(sessions.sessionId, best.sessionId))
		.limit(1);

	if (!row) {
		return {
			ok: false,
			reason: "not_found",
			replyText: `Couldn't load session details for **${best.sessionDisplayName ?? best.sessionId.slice(0, 8)}**.`,
		};
	}
	return { ok: true, session: row };
}
