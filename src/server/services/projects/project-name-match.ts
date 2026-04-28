/**
 * Fuzzy project-name matching used by the Ask launch-intent flow.
 *
 * Users type project names with whitespace, dashes, underscores, dots, and
 * minor typos ("agent pulse", "agent-pulse", "agnetpulse"). The detector
 * gate, the LLM-output resolver, and the CRUD lookup all need a single,
 * predictable matching strategy. This module is that strategy.
 *
 * Conservatism: case-sensitive → case-insensitive → normalized → typo. We
 * only fall through to typo (Levenshtein) matching when there is exactly
 * one closest project; ties return null so the caller can disambiguate
 * with a follow-up. We refuse typo matching on candidates shorter than
 * 4 chars to avoid cross-matching unrelated short names ("ap" → "api").
 */

/**
 * Normalize a project name for fuzzy comparison. Lowercases, then strips
 * whitespace, dashes, underscores, dots, and parentheses. "Agent Pulse",
 * "agent-pulse", "agent_pulse", "Agent.Pulse", and "(agent pulse)" all
 * collapse to "agentpulse".
 */
export function normalizeProjectName(s: string): string {
	return s.toLowerCase().replace(/[\s\-_.()]/g, "");
}

export type MatchKind = "exact" | "case_insensitive" | "normalized" | "typo";

export interface MatchResult<P extends { id: string; name: string; cwd: string }> {
	project: P;
	matchKind: MatchKind;
	distance?: number;
}

const TYPO_MAX_DISTANCE = 2;
const TYPO_MIN_CANDIDATE_LEN = 4;

/**
 * Standard dynamic-programming Levenshtein distance. Operates on whole
 * strings — callers normalize first if they want shape-insensitive
 * matching. ~30 lines, no third-party dep.
 */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	// Two-row rolling buffer keeps memory at O(min(a, b)).
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1] + 1, // insertion
				prev[j] + 1, // deletion
				prev[j - 1] + cost, // substitution
			);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[b.length];
}

/**
 * Match a candidate string (from a user message or LLM output) against a
 * list of known project records. Returns the matched project + match kind,
 * or null when nothing matches with confidence.
 *
 * Match levels (try in order, return first hit):
 *   1. Exact case-sensitive equality on .name.
 *   2. Exact case-insensitive equality on .name.
 *   3. Equality on normalizeProjectName().
 *   4. Levenshtein distance ≤ 2 on normalized form, but ONLY if the
 *      single closest project is uniquely closest. Multiple projects
 *      tied within 2 → return null (let disambiguation handle it). We
 *      also refuse typo matching when the candidate is shorter than
 *      4 chars — short names cross-match too easily.
 */
export function matchProjectByName<P extends { id: string; name: string; cwd: string }>(
	candidate: string,
	projects: ReadonlyArray<P>,
): MatchResult<P> | null {
	if (!candidate || projects.length === 0) return null;

	// Level 1: exact case-sensitive.
	for (const p of projects) {
		if (p.name === candidate) return { project: p, matchKind: "exact" };
	}

	// Level 2: case-insensitive.
	const candidateLower = candidate.toLowerCase();
	for (const p of projects) {
		if (p.name.toLowerCase() === candidateLower) {
			return { project: p, matchKind: "case_insensitive" };
		}
	}

	// Level 3: normalized (whitespace/punctuation-collapsed).
	const candidateNorm = normalizeProjectName(candidate);
	if (!candidateNorm) return null;
	for (const p of projects) {
		if (normalizeProjectName(p.name) === candidateNorm) {
			return { project: p, matchKind: "normalized" };
		}
	}

	// Level 4: typo (Levenshtein) on normalized form. Refuse on too-short
	// candidates to avoid spurious cross-matches.
	if (candidateNorm.length < TYPO_MIN_CANDIDATE_LEN) return null;

	let bestDistance = TYPO_MAX_DISTANCE + 1;
	let bestProject: P | null = null;
	let tieCount = 0;
	for (const p of projects) {
		const d = levenshtein(candidateNorm, normalizeProjectName(p.name));
		if (d > TYPO_MAX_DISTANCE) continue;
		if (d < bestDistance) {
			bestDistance = d;
			bestProject = p;
			tieCount = 1;
		} else if (d === bestDistance) {
			tieCount += 1;
		}
	}

	if (bestProject && tieCount === 1) {
		return { project: bestProject, matchKind: "typo", distance: bestDistance };
	}

	return null;
}
