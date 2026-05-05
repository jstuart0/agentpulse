/**
 * Substring snippet extractor for search result highlighting.
 *
 * Produces a 64-char window around the first case-insensitive occurrence
 * of `token` in `source`. The matched substring (in its original casing) is
 * wrapped in `<mark>…</mark>` tags so the UI can highlight it consistently
 * regardless of which backend produced the result.
 *
 * Output format matches SQLite FTS5's `snippet()` output (with `<mark>` /
 * `</mark>` markers and `…` ellipsis) so the UI doesn't need backend-aware
 * rendering logic.
 *
 * Used by `PostgresSearchBackend`. The `SqliteFtsBackend` delegates to
 * SQLite's built-in `snippet()` function directly.
 */

const WINDOW_HALF = 32; // 32 chars either side → 64-char window
const MARK_OPEN = "<mark>";
const MARK_CLOSE = "</mark>";
const ELLIPSIS = "…";

/**
 * Extract a highlighted snippet from `source` around the first occurrence
 * of `token` (case-insensitive). Returns an empty string when `source` is
 * empty or `token` is not found.
 *
 * @param source   The full text to extract from (e.g. a session display name
 *                 or event content field).
 * @param token    The search token to highlight. Should be a single word
 *                 (no wildcards, no FTS5 syntax).
 */
export function extractSnippet(source: string, token: string): string {
	if (!source || !token) return "";

	const lower = source.toLowerCase();
	const lowerToken = token.toLowerCase();
	const idx = lower.indexOf(lowerToken);
	if (idx === -1) return "";

	const start = Math.max(0, idx - WINDOW_HALF);
	const end = Math.min(source.length, idx + token.length + WINDOW_HALF);

	const prefix = start > 0 ? ELLIPSIS : "";
	const suffix = end < source.length ? ELLIPSIS : "";

	// Preserve the original casing of the matched substring.
	const before = source.slice(start, idx);
	const matched = source.slice(idx, idx + token.length);
	const after = source.slice(idx + token.length, end);

	return `${prefix}${before}${MARK_OPEN}${matched}${MARK_CLOSE}${after}${suffix}`;
}
