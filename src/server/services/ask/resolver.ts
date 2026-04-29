import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import type { SemanticEnricher } from "../ai/semantic-enricher.js";
import { getSearchBackend } from "../search/index.js";

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
	/**
	 * Optional semantic enricher (LLM query expansion today, vector
	 * similarity later). When provided, we broaden the FTS query with
	 * the enricher's extraTerms and merge its directHits into the
	 * candidate pool — letting Ask find sessions whose event content is
	 * paraphrased but not literal. Null / undefined = lexical-only.
	 */
	enricher?: SemanticEnricher | null;
}

/**
 * Run the FTS backend against the user's message to find sessions whose
 * *event content* mentions the terms — metadata-only substring matching
 * can't see prompts, assistant messages, or reports. Returns a map of
 * sessionId → best FTS score (0..1), empty if FTS is unavailable or the
 * query yielded nothing. Intentionally swallows errors so Ask keeps
 * working even if the search backend isn't healthy (pre-bootstrap, on
 * a Postgres install without tsvector yet, etc.).
 *
 * Note we pass only the stopword-filtered tokens and use OR mode. The
 * full message ANDed together ("find", "a", "session", …, "tightly",
 * "coupled") practically never matches a single document; OR'ing the
 * content words ("tightly" OR "coupled" OR "code") gets us back to
 * something useful.
 *
 * `extraTerms` come from the semantic enricher — LLM-generated synonyms
 * / related jargon today, open to vector-driven term suggestions later.
 * We merge them with the lexical tokens and dedupe before ORing.
 */
async function ftsScoresForMessage(
	tokens: string[],
	extraTerms: string[] = [],
): Promise<Map<string, number>> {
	const scores = new Map<string, number>();
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const t of [...tokens, ...extraTerms]) {
		const normalized = t.trim().toLowerCase();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		merged.push(normalized);
	}
	if (merged.length === 0) return scores;
	try {
		// Bump the limit generously — we aggregate many hits per session
		// into one score and need enough coverage that a session with
		// lots of weak matches can still outrank one with a single
		// strong hit on a rare synonym.
		const result = await getSearchBackend().search({
			q: merged.join(" "),
			kinds: ["event", "session"],
			mode: "or",
			limit: 200,
		});
		// BM25 penalizes high-frequency documents per-hit, so taking the
		// per-session max underrates the session that's *actually about*
		// the topic (many mentions, each scored moderately) vs. a session
		// with one rare-term match. Fold in a count-based boost:
		//   sessionScore = maxHit + log1p(totalHits) × 0.1
		// `× 0.1` keeps the boost gentle — it acts as a tie-breaker
		// between comparable max scores rather than swamping them.
		const perSession = new Map<string, { max: number; count: number }>();
		for (const hit of result.hits) {
			const entry = perSession.get(hit.sessionId) ?? { max: 0, count: 0 };
			if (hit.score > entry.max) entry.max = hit.score;
			entry.count += 1;
			perSession.set(hit.sessionId, entry);
		}
		for (const [sessionId, { max, count }] of perSession) {
			scores.set(sessionId, max + Math.log1p(count) * 0.1);
		}
	} catch {
		// Silent fallback — Ask is still useful without FTS.
	}
	return scores;
}

export async function resolveCandidateSessions(input: ResolveInput): Promise<ResolvedSession[]> {
	const limit = input.limit ?? 5;
	const tokens = tokenize(input.message);

	// Pull active + idle sessions (exclude archived/completed unless matched
	// by keyword). Cap the candidate pool so we don't score the whole DB.
	// Slice G: explicit isArchived exclusion wraps the OR so archived sessions
	// with status='active' (a valid orthogonal state) don't leak into the pool.
	const pool = await db
		.select()
		.from(sessions)
		.where(
			and(
				or(
					eq(sessions.status, "active"),
					eq(sessions.status, "idle"),
					eq(sessions.isWorking, true),
				),
				eq(sessions.isArchived, false),
			),
		)
		.orderBy(desc(sessions.lastActivityAt))
		.limit(80);

	// Semantic enrichment (LLM expansion today, vector similarity later).
	// When an enricher is attached, we widen the FTS query with its
	// extraTerms and fold its directHits into the score map. This is
	// where "search for meaning, not exact words" becomes real.
	const enrichment = input.enricher ? await input.enricher.enrich(input.message) : null;

	// FTS-driven pool extension. Sessions whose event content matches the
	// user's message but that fell outside the recency window (e.g. a
	// question about "coupled" when the relevant session is weeks old)
	// would otherwise be invisible. Fetch missing sessions by id and
	// merge them in. Only meaningful when the user gave us tokens.
	const ftsScores = await ftsScoresForMessage(tokens, enrichment?.extraTerms ?? []);
	// Fold in the enricher's direct hits (vector search populates this;
	// LLM expansion leaves it empty).
	if (enrichment) {
		for (const [sessionId, score] of enrichment.directHits) {
			const prev = ftsScores.get(sessionId) ?? 0;
			if (score > prev) ftsScores.set(sessionId, score);
		}
	}
	let extendedPool = pool;
	if (ftsScores.size > 0) {
		const known = new Set(pool.map((r) => r.sessionId));
		const missingIds = [...ftsScores.keys()].filter((id) => !known.has(id));
		if (missingIds.length > 0) {
			// FTS just told us these sessions semantically match the user's
			// question — trust that signal and include completed ones too.
			// We still hide archived sessions (user intent: "don't show
			// these") but anything else is fair game; "find the session
			// where I did X" is often a question about past, finished work.
			// Slice G: filter on isArchived (canonical truth), not status='archived'.
			const extra = await db
				.select()
				.from(sessions)
				.where(and(inArray(sessions.sessionId, missingIds), eq(sessions.isArchived, false)));
			extendedPool = pool.concat(extra);
		}
	}

	const scoredAll = extendedPool.map((row) => {
		let score = scoreSession(tokens, row);
		const ftsBoost = ftsScores.get(row.sessionId);
		// Weight FTS high enough that a strong event-content match beats
		// a weak metadata substring hit, but not so high that substring
		// matches on the displayName (worth 5) get drowned out.
		if (ftsBoost !== undefined) score += ftsBoost * 4;
		return { row, score };
	});
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
