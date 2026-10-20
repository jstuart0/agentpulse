import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { events, sessions, watcherProposals } from "../../db/schema/index.js";
import { toDbTimestamp } from "../util/db-time.js";
import { intelligenceForSession } from "./intelligence-service.js";

/**
 * Project / repo digest: cross-session summary grouped by working
 * directory. Deterministic aggregation only — LLM synthesis of a
 * written "what happened today" blurb is a future add-on behind
 * `ai.digestSynthesis`, but is not yet implemented in this phase.
 */

export interface RepoDigestSession {
	sessionId: string;
	displayName: string | null;
	status: string;
	health: string | null;
	healthReason: string | null;
	lastActivityAt: string;
	totalToolUses: number;
}

export interface RepoDigest {
	repoKey: string;
	cwd: string | null;
	projectName: string;
	activeCount: number;
	blockedCount: number;
	stuckCount: number;
	completedToday: number;
	failedToday: number;
	topPlanCompletions: string[];
	notableFailures: Array<{ sessionId: string; message: string | null; at: string }>;
	sessions: RepoDigestSession[];
}

export interface Digest {
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	totals: {
		repos: number;
		sessions: number;
		active: number;
		blocked: number;
		stuck: number;
		completedToday: number;
	};
	repos: RepoDigest[];
}

function projectNameFor(cwd: string | null): string {
	if (!cwd) return "(no cwd)";
	const parts = cwd.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || cwd;
}

/**
 * Group by normalized cwd. For the first cut we use cwd directly; the
 * plan calls for git-root grouping when available, which can layer in
 * later without changing this function's contract.
 */
function groupKeyFor(cwd: string | null): string {
	if (!cwd) return "__no_cwd__";
	return cwd.replace(/\/+$/, "");
}

/**
 * Whose view a digest is. The rows a viewer may not read are dropped before anything is counted, so a
 * digest never carries a count, a name or a failure from a session its audience couldn't open. `key`
 * names the audience for the cache: two audiences with the same key must read the same sessions.
 */
export interface DigestAudience {
	key: string;
	canRead(session: { ownerUserId: string | null }): boolean;
}

/** Everyone: solo, an admin, and the web's shared team reads. */
export const EVERYONE: DigestAudience = { key: "all", canRead: () => true };

const DEFAULT_DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DigestOptions {
	/** Only include sessions with activity within this window. Default 24h. */
	windowMs?: number;
	now?: Date;
	/** Whose view to build. Default: everyone. */
	audience?: DigestAudience;
}

/**
 * How many sessions this audience would find in the digest window, and nothing else: one grouped count by owner,
 * no classification, no plan or proposal reads, no names. It agrees with `buildDigest(...).totals.sessions` (the
 * same window, the same archive rule, the same audience filter) at a fraction of the cost, which is what the
 * digest push needs to decide whether there is anything to say.
 */
export async function countDigestSessions(options: DigestOptions = {}): Promise<number> {
	const now = options.now ?? new Date();
	const windowStart = new Date(now.getTime() - (options.windowMs ?? DEFAULT_DIGEST_WINDOW_MS));
	const audience = options.audience ?? EVERYONE;
	const owners = await getDb()
		.select({ ownerUserId: sessions.ownerUserId, sessions: count() })
		.from(sessions)
		.where(
			and(gte(sessions.lastActivityAt, windowStart.toISOString()), eq(sessions.isArchived, false)),
		)
		.groupBy(sessions.ownerUserId);
	return owners
		.filter((o) => audience.canRead({ ownerUserId: o.ownerUserId ?? null }))
		.reduce((total, o) => total + Number(o.sessions), 0);
}

export async function buildDigest(options: DigestOptions = {}): Promise<Digest> {
	const now = options.now ?? new Date();
	const windowMs = options.windowMs ?? DEFAULT_DIGEST_WINDOW_MS;
	const windowStart = new Date(now.getTime() - windowMs);

	// Pull sessions active or recently-updated within the window.
	// Slice G: exclude archived sessions explicitly (latent bug fix — the
	// previous query had no archive filter at all, causing archived sessions
	// to appear in repo groupings and counts).
	const allRows = await getDb()
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			cwd: sessions.cwd,
			status: sessions.status,
			lastActivityAt: sessions.lastActivityAt,
			totalToolUses: sessions.totalToolUses,
			ownerUserId: sessions.ownerUserId,
		})
		.from(sessions)
		.where(
			and(gte(sessions.lastActivityAt, windowStart.toISOString()), eq(sessions.isArchived, false)),
		)
		.orderBy(desc(sessions.lastActivityAt));
	const audience = options.audience ?? EVERYONE;
	const rows = allRows.filter((r) => audience.canRead({ ownerUserId: r.ownerUserId ?? null }));

	const sessionIds = rows.map((r) => r.sessionId);

	// Count completed/failed for today per session in one pass.
	const completedSet = new Set(
		rows.filter((r) => r.status === "completed").map((r) => r.sessionId),
	);
	const failedSet = new Set(rows.filter((r) => r.status === "failed").map((r) => r.sessionId));

	// Group sessions by repo key.
	const groups = new Map<string, { cwd: string | null; sessions: typeof rows }>();
	for (const r of rows) {
		const key = groupKeyFor(r.cwd);
		const existing = groups.get(key);
		if (existing) existing.sessions.push(r);
		else groups.set(key, { cwd: r.cwd, sessions: [r] });
	}

	// Classify sessions that are still active/idle so we can count
	// blocked/stuck within each repo. Other statuses don't get classified
	// because the heuristics need live-ish state.
	const liveIds = rows
		.filter((r) => r.status === "active" || r.status === "idle")
		.map((r) => r.sessionId);
	const healthBySession = new Map<string, { health: string; reasonCode: string }>();
	for (const id of liveIds) {
		try {
			const intel = await intelligenceForSession(id, now);
			if (intel) {
				healthBySession.set(id, {
					health: intel.health,
					reasonCode: intel.reasonCode,
				});
			}
		} catch {
			// ignore
		}
	}

	// Pull plan_update events in window to find top plan completions.
	const planCompletionsByRepo = new Map<string, string[]>();
	if (sessionIds.length) {
		const planEvents = await getDb()
			.select({
				sessionId: events.sessionId,
				content: events.content,
			})
			.from(events)
			.where(
				and(
					inArray(events.sessionId, sessionIds),
					eq(events.category, "plan_update"),
					// R10: events.created_at is a bare "YYYY-MM-DD HH:MM:SS" (SQLite)
					// or a Postgres-offset string — never a "T"-separated ISO string.
					// Comparing against windowStart.toISOString() lexicographically
					// excluded the window's first day (" " < "T" for the same wall
					// date). toDbTimestamp formats windowStart the same way the
					// column is stored.
					gte(events.createdAt, toDbTimestamp(windowStart)),
				),
			)
			.orderBy(desc(events.id));
		const cwdBySession = new Map(rows.map((r) => [r.sessionId, r.cwd ?? null]));
		for (const e of planEvents) {
			if (!e.content) continue;
			if (!/complete/i.test(e.content)) continue;
			const key = groupKeyFor(cwdBySession.get(e.sessionId) ?? null);
			const list = planCompletionsByRepo.get(key) ?? [];
			if (list.length < 5) list.push(e.content.slice(0, 200));
			planCompletionsByRepo.set(key, list);
		}
	}

	// Failed proposals as notable failures.
	const notableByRepo = new Map<string, RepoDigest["notableFailures"]>();
	if (sessionIds.length) {
		const failedProps = await getDb()
			.select({
				sessionId: watcherProposals.sessionId,
				errorMessage: watcherProposals.errorMessage,
				updatedAt: watcherProposals.updatedAt,
			})
			.from(watcherProposals)
			.where(
				and(
					inArray(watcherProposals.sessionId, sessionIds),
					eq(watcherProposals.state, "failed"),
					gte(watcherProposals.updatedAt, windowStart.toISOString()),
				),
			)
			.orderBy(desc(watcherProposals.updatedAt));
		const cwdBySession = new Map(rows.map((r) => [r.sessionId, r.cwd ?? null]));
		for (const p of failedProps) {
			const key = groupKeyFor(cwdBySession.get(p.sessionId) ?? null);
			const list = notableByRepo.get(key) ?? [];
			if (list.length < 5) {
				list.push({
					sessionId: p.sessionId,
					message: p.errorMessage,
					at: p.updatedAt,
				});
			}
			notableByRepo.set(key, list);
		}
	}

	// Assemble repo digests.
	const repos: RepoDigest[] = [];
	for (const [key, group] of groups) {
		let active = 0;
		let blocked = 0;
		let stuck = 0;
		let completed = 0;
		let failed = 0;
		const repoSessions: RepoDigestSession[] = [];
		for (const r of group.sessions) {
			if (r.status === "active" || r.status === "idle") active++;
			const h = healthBySession.get(r.sessionId);
			if (h) {
				if (h.health === "blocked") blocked++;
				else if (h.health === "stuck") stuck++;
			}
			if (completedSet.has(r.sessionId)) completed++;
			if (failedSet.has(r.sessionId)) failed++;
			repoSessions.push({
				sessionId: r.sessionId,
				displayName: r.displayName,
				status: r.status,
				health: h?.health ?? null,
				healthReason: h?.reasonCode ?? null,
				lastActivityAt: r.lastActivityAt,
				totalToolUses: r.totalToolUses ?? 0,
			});
		}
		repos.push({
			repoKey: key,
			cwd: group.cwd,
			projectName: projectNameFor(group.cwd),
			activeCount: active,
			blockedCount: blocked,
			stuckCount: stuck,
			completedToday: completed,
			failedToday: failed,
			topPlanCompletions: planCompletionsByRepo.get(key) ?? [],
			notableFailures: notableByRepo.get(key) ?? [],
			sessions: repoSessions,
		});
	}

	// Sort repos: most active first, then most blocked, then name.
	repos.sort((a, b) => {
		if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
		if (b.blockedCount !== a.blockedCount) return b.blockedCount - a.blockedCount;
		return a.projectName.localeCompare(b.projectName);
	});

	const totals = repos.reduce(
		(acc, r) => ({
			sessions: acc.sessions + r.sessions.length,
			active: acc.active + r.activeCount,
			blocked: acc.blocked + r.blockedCount,
			stuck: acc.stuck + r.stuckCount,
			completedToday: acc.completedToday + r.completedToday,
		}),
		{ sessions: 0, active: 0, blocked: 0, stuck: 0, completedToday: 0 },
	);

	return {
		generatedAt: now.toISOString(),
		windowStart: windowStart.toISOString(),
		windowEnd: now.toISOString(),
		totals: { repos: repos.length, ...totals },
		repos,
	};
}

// Simple in-memory digest cache to avoid recomputing for every dashboard
// poll. The plan specifies one automatic digest per (repo, day) per user;
// we use a coarser but equivalent whole-digest cache keyed by the day and the
// audience, so one viewer's digest is never served to another.
const digestCache = new Map<string, { at: number; digest: Digest }>();
const DIGEST_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
/** A bound on audiences cached at once (one per signed-in person at most); the oldest goes first. */
const DIGEST_CACHE_MAX_ENTRIES = 500;

function todayKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function cacheKeyFor(now: Date, audience: DigestAudience): string {
	return `${todayKey(now)}|${audience.key}`;
}

export async function getDailyDigest(options: DigestOptions = {}): Promise<Digest> {
	const now = options.now ?? new Date();
	const key = cacheKeyFor(now, options.audience ?? EVERYONE);
	const cached = digestCache.get(key);
	if (cached && now.getTime() - cached.at < DIGEST_CACHE_TTL_MS) {
		return cached.digest;
	}
	const digest = await buildDigest(options);
	digestCache.delete(key);
	digestCache.set(key, { at: now.getTime(), digest });
	if (digestCache.size > DIGEST_CACHE_MAX_ENTRIES) {
		const oldest = digestCache.keys().next().value;
		if (oldest !== undefined) digestCache.delete(oldest);
	}
	return digest;
}

export function invalidateDigestCache(): void {
	digestCache.clear();
}
