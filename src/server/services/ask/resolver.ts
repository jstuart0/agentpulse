import { desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";

/**
 * Resolver: map a user's free-form message ("how's the agentpulse session?",
 * "the one working on auth", "Claude Code is stuck") to a set of candidate
 * session rows that should inform the answer. The LLM itself never runs
 * SQL — this function narrows the universe *before* we spend tokens.
 *
 * Scoring mix:
 *  - Working sessions get a boost (user is most likely asking about live work).
 *  - Name / cwd / git_branch / current_task substring hits score higher.
 *  - Recently-active sessions outrank stale ones when ties happen.
 *
 * If the message doesn't mention anything session-ish (e.g. "what are my
 * agents doing overall?"), we fall back to active+working sessions ordered
 * by recency.
 */

export interface ResolvedSession {
	sessionId: string;
	displayName: string | null;
	cwd: string | null;
	status: string;
	isWorking: boolean;
	agentType: string;
	lastActivityAt: string;
	/** Arbitrary number; higher = better match. */
	score: number;
}

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"was",
	"are",
	"how",
	"what",
	"where",
	"when",
	"who",
	"on",
	"for",
	"of",
	"to",
	"it",
	"my",
	"our",
	"i",
	"you",
	"working",
	"session",
	"sessions",
	"agent",
	"agents",
	"running",
	"progress",
	"progressing",
	"status",
	"doing",
	"tell",
	"me",
	"about",
	"going",
	"this",
	"that",
	"and",
	"or",
]);

function tokenize(message: string): string[] {
	return (
		message
			.toLowerCase()
			// Allow dashes inside tokens (e.g. "my-project") but strip most punctuation.
			.replace(/[^a-z0-9._\- ]+/g, " ")
			.split(/\s+/)
			.map((t) => t.trim())
			.filter((t) => t.length >= 3 && !STOPWORDS.has(t))
	);
}

function scoreSession(tokens: string[], row: typeof sessions.$inferSelect): number {
	if (tokens.length === 0) {
		// Floor score so we can still rank by activity downstream.
		return row.isWorking ? 2 : row.status === "active" ? 1 : 0;
	}
	let score = 0;
	const haystack = [
		row.displayName ?? "",
		row.cwd ?? "",
		row.gitBranch ?? "",
		row.currentTask ?? "",
		row.agentType ?? "",
	].map((s) => s.toLowerCase());

	for (const tok of tokens) {
		for (const hay of haystack) {
			if (!hay) continue;
			if (hay === tok) score += 5;
			else if (hay.includes(tok)) score += 2;
		}
	}
	// Light boosts so ties resolve toward currently-interesting sessions.
	if (score > 0 && row.isWorking) score += 1;
	if (score > 0 && row.status === "active") score += 0.5;
	return score;
}

export interface ResolveInput {
	message: string;
	/** Top-N cap. Higher = more context, fewer tokens budget per session. */
	limit?: number;
	/**
	 * If true, include sessions that weren't matched by message tokens —
	 * used for the "tell me everything" default case. Ignored when the
	 * message had specific hits.
	 */
	fallbackToActive?: boolean;
}

export async function resolveCandidateSessions(input: ResolveInput): Promise<ResolvedSession[]> {
	const limit = input.limit ?? 5;
	const tokens = tokenize(input.message);

	// Pull active + idle sessions (exclude archived/completed unless matched
	// by keyword). Cap the candidate pool so we don't score the whole DB.
	const pool = await db
		.select()
		.from(sessions)
		.where(
			or(eq(sessions.status, "active"), eq(sessions.status, "idle"), eq(sessions.isWorking, true)),
		)
		.orderBy(desc(sessions.lastActivityAt))
		.limit(80);

	const scoredAll = pool.map((row) => ({ row, score: scoreSession(tokens, row) }));
	const hasAnyMatch = scoredAll.some((s) => s.score > 0);
	// If we had keywords but nothing matched them, treat it as an
	// ambiguous "tell me about my agents" case — fall back to active
	// sessions so the LLM has something to answer with instead of an
	// empty block.
	const useFallback = input.fallbackToActive && (!hasAnyMatch || tokens.length === 0);
	const scored = scoredAll
		.filter((r) => (useFallback ? true : r.score > 0))
		.sort(
			(a, b) => b.score - a.score || a.row.lastActivityAt.localeCompare(b.row.lastActivityAt) * -1,
		)
		.slice(0, limit);

	return scored.map((r) => ({
		sessionId: r.row.sessionId,
		displayName: r.row.displayName,
		cwd: r.row.cwd,
		status: r.row.status,
		isWorking: Boolean(r.row.isWorking),
		agentType: r.row.agentType ?? "unknown",
		lastActivityAt: r.row.lastActivityAt,
		score: r.score,
	}));
}

/**
 * Direct fetch by session id — for "@mention" style references in the UI
 * and the explicit sessionId payload case.
 */
export async function fetchSessionsById(ids: string[]): Promise<ResolvedSession[]> {
	if (ids.length === 0) return [];
	const rows = await db.select().from(sessions).where(inArray(sessions.sessionId, ids));
	// SQLite's IN clause doesn't preserve input order; re-order rows to match
	// the caller's id list so "@mention"-style references in the UI stay stable.
	const byId = new Map(rows.map((row) => [row.sessionId, row]));
	return ids
		.map((id) => byId.get(id))
		.filter((row): row is (typeof rows)[number] => Boolean(row))
		.map((row) => ({
			sessionId: row.sessionId,
			displayName: row.displayName,
			cwd: row.cwd,
			status: row.status,
			isWorking: Boolean(row.isWorking),
			agentType: row.agentType ?? "unknown",
			lastActivityAt: row.lastActivityAt,
			score: 100, // explicitly-picked rows always rank first
		}));
}
