import { and, desc, eq, gte, inArray, like, lte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";
import type { CachedProject } from "../projects/cache.js";
import { getSearchBackend } from "../search/index.js";
import type { SearchFilters, SearchHit } from "../search/types.js";

interface SessionMeta {
	status: string;
	agentType: string;
}

// ---- Status synonym table -----------------------------------------------

const FAILED_SYNONYMS = /\b(fail(ed|ing)?|broken|crashed|errored|not\s+working)\b/i;
const STUCK_SYNONYMS = /\b(stuck|blocked)\b/i;
const COMPLETED_RE = /\bcomplet/i;
const ACTIVE_RE = /\bactive\b/i;
const ARCHIVED_RE = /\barchived?\b/i;

// ---- Time helpers --------------------------------------------------------

function startOfDayUtc(now: Date): Date {
	const d = new Date(now);
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

function startOfYesterdayUtc(now: Date): Date {
	const d = startOfDayUtc(now);
	d.setUTCDate(d.getUTCDate() - 1);
	return d;
}

// ---- Filter derivation ---------------------------------------------------

/**
 * Translate a free-form NL query into SearchFilters.
 * Pure synchronous — no DB, no async, no LLM call.
 * All filter detection is heuristic regex; v1 intentionally avoids LLM
 * classifier overhead for a read-only operation.
 */
export function buildSearchFilters(
	message: string,
	projects: CachedProject[],
	now: Date = new Date(),
): SearchFilters {
	const filters: SearchFilters = { q: "", mode: "or", limit: 10 };

	// Status filter — check synonyms before other patterns.
	if (FAILED_SYNONYMS.test(message)) {
		filters.sessionStatus = "failed";
	} else if (STUCK_SYNONYMS.test(message)) {
		filters.sessionStatus = "idle";
	} else if (COMPLETED_RE.test(message)) {
		filters.sessionStatus = "completed";
	} else if (ACTIVE_RE.test(message)) {
		filters.sessionStatus = "active";
	} else if (ARCHIVED_RE.test(message)) {
		filters.sessionStatus = "archived";
	}

	// Time filter.
	const lastNMatch = message.match(/\blast\s+(\d+)\s+(hour|day)s?\b/i);
	if (lastNMatch) {
		const n = Number.parseInt(lastNMatch[1], 10);
		const unit = lastNMatch[2].toLowerCase();
		const ms = unit === "hour" ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
		filters.since = new Date(now.getTime() - ms).toISOString();
	} else if (/\byesterday\b/i.test(message)) {
		filters.since = startOfYesterdayUtc(now).toISOString();
		filters.until = startOfDayUtc(now).toISOString();
	} else if (/\btoday\b/i.test(message)) {
		filters.since = startOfDayUtc(now).toISOString();
	}

	// Project/cwd filter — whole-word match against known project names.
	for (const p of projects) {
		const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`\\b${escaped}\\b`, "i").test(message)) {
			filters.cwd = p.cwd;
			break;
		}
	}

	// Build residual q: strip the filter trigger words from the message so
	// the FTS query doesn't repeat what the structured filters already cover.
	// This is best-effort — extra noise tokens just widen an OR query.
	let q = message
		.replace(FAILED_SYNONYMS, "")
		.replace(STUCK_SYNONYMS, "")
		.replace(COMPLETED_RE, "")
		.replace(ACTIVE_RE, "")
		.replace(ARCHIVED_RE, "")
		.replace(/\blast\s+\d+\s+(hour|day)s?\b/gi, "")
		.replace(/\b(yesterday|today)\b/gi, "")
		.replace(/\b(find|search|show|list|get|what|which|any|me)\b/gi, "")
		.replace(/\b(sessions?|about|with|that|for|on|in|the)\b/gi, "");

	// Strip the matched project name from q.
	if (filters.cwd) {
		const matchedProject = projects.find((p) => p.cwd === filters.cwd);
		if (matchedProject) {
			const escaped = matchedProject.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			q = q.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "");
		}
	}

	q = q.replace(/\s+/g, " ").trim();
	filters.q = q;

	return filters;
}

// ---- Result formatting ---------------------------------------------------

function deduplicateBySession(hits: SearchHit[]): SearchHit[] {
	const seen = new Set<string>();
	const out: SearchHit[] = [];
	for (const h of hits) {
		if (!seen.has(h.sessionId)) {
			seen.add(h.sessionId);
			out.push(h);
		}
	}
	return out;
}

export function formatSearchResults(
	hits: SearchHit[],
	capped: boolean,
	sessionMeta?: Map<string, SessionMeta>,
): string {
	if (hits.length === 0) return "";
	const lines = hits.map((h) => {
		const name = h.sessionDisplayName ?? h.sessionId.slice(0, 8);
		const snippet = h.snippet.replace(/<\/?mark>/g, "").slice(0, 120);
		const detail = snippet || h.sessionCwd || "";
		const meta = sessionMeta?.get(h.sessionId);
		const parenthetical = meta ? `(${meta.status}, ${meta.agentType})` : null;
		return parenthetical
			? `• **${name}** ${parenthetical} — ${detail}`
			: `• **${name}** — ${detail}`;
	});
	if (capped) {
		lines.push("_(and possibly more — refine your query to narrow results)_");
	}
	return lines.join("\n");
}

// ---- Direct session query (when q is empty) ------------------------------

/**
 * When q is empty (all tokens were filter words), the FTS backend returns
 * nothing. Fall back to a direct session query against the structured
 * filters — status, cwd, and time range.
 *
 * Returns both the SearchHit array and a pre-populated SessionMeta map so
 * the caller can pass it directly to formatSearchResults without an extra
 * round-trip.
 */
async function querySessionsDirect(
	filters: SearchFilters,
): Promise<{ hits: SearchHit[]; meta: Map<string, SessionMeta> }> {
	const clauses = [];
	if (filters.sessionStatus) clauses.push(eq(sessions.status, filters.sessionStatus));
	if (filters.cwd) clauses.push(like(sessions.cwd, `%${filters.cwd}%`));
	if (filters.since) clauses.push(gte(sessions.lastActivityAt, filters.since));
	if (filters.until) clauses.push(lte(sessions.lastActivityAt, filters.until));

	const rows = await db
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			cwd: sessions.cwd,
			status: sessions.status,
			agentType: sessions.agentType,
			lastActivityAt: sessions.lastActivityAt,
		})
		.from(sessions)
		.where(clauses.length > 0 ? and(...clauses) : undefined)
		.orderBy(desc(sessions.lastActivityAt))
		.limit(filters.limit ?? 10);

	const hits: SearchHit[] = rows.map((r) => ({
		kind: "session" as const,
		sessionId: r.sessionId,
		eventId: null,
		eventType: null,
		snippet: r.cwd ?? "",
		score: 1.0,
		timestamp: r.lastActivityAt,
		sessionDisplayName: r.displayName,
		sessionCwd: r.cwd,
	}));

	const meta = new Map(
		rows.map((r) => [r.sessionId, { status: r.status, agentType: r.agentType }]),
	);

	return { hits, meta };
}

// ---- Public handler ------------------------------------------------------

/**
 * Run the NL search and format results as a plain-text reply block.
 * Returns null when there are zero deduplicated results — caller falls
 * through to normal Ask LLM completion.
 */
export async function handleNlSearch(
	message: string,
	projects: CachedProject[],
	now?: Date,
): Promise<string | null> {
	const filters = buildSearchFilters(message, projects, now);

	// If the query is entirely empty and there are no structured filters,
	// skip search entirely so the LLM can handle fully open-ended questions.
	const hasStructured =
		filters.sessionStatus !== undefined ||
		filters.cwd !== undefined ||
		filters.since !== undefined ||
		filters.until !== undefined;
	if (!filters.q && !hasStructured) return null;

	let hits: SearchHit[];
	let sessionMeta: Map<string, SessionMeta>;

	if (!filters.q && hasStructured) {
		// FTS backend requires non-empty q — use direct query instead.
		// querySessionsDirect already has status+agentType in its SELECT.
		const result = await querySessionsDirect(filters);
		hits = result.hits;
		sessionMeta = result.meta;
	} else {
		const backend = getSearchBackend();
		const result = await backend.search(filters);
		hits = result.hits;

		// Batch-fetch status + agentType for the matched sessions in one query.
		const ids = [...new Set(hits.map((h) => h.sessionId))];
		if (ids.length === 0) {
			sessionMeta = new Map();
		} else {
			const rows = await db
				.select({
					sessionId: sessions.sessionId,
					status: sessions.status,
					agentType: sessions.agentType,
				})
				.from(sessions)
				.where(inArray(sessions.sessionId, ids));
			sessionMeta = new Map(
				rows.map((r) => [r.sessionId, { status: r.status, agentType: r.agentType }]),
			);
		}
	}

	const unique = deduplicateBySession(hits);
	if (unique.length === 0) return null;

	const capped = unique.length >= 10;
	const display = unique.slice(0, 10);
	return formatSearchResults(display, capped, sessionMeta);
}
