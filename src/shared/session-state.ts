/**
 * Canonical archive-state predicates for session listings.
 *
 * `sessions.isArchived` is the single persisted truth for archival state.
 * `sessions.status` was historically a second write path (frontend wrote
 * `status='archived'` as an optimistic update), but as of Slice G that
 * write is gone. The `'archived'` literal remains in the `SessionStatus`
 * union for backwards-compat with any rows predating this slice; new code
 * never reads or writes that value as the archive signal.
 *
 * Use `isVisibleSession` everywhere a list/filter wants to exclude archived
 * sessions.  Use `isArchivedSession` for the inverse (e.g. the Archived tab).
 */

/**
 * Returns true when the session should appear in ordinary (non-archived)
 * listings.  Structural typing so both full `Session` objects and Drizzle
 * projection shapes (which only select `{ isArchived }`) satisfy it.
 */
export function isVisibleSession(s: { isArchived: boolean }): boolean {
	return !s.isArchived;
}

/**
 * Returns true when the session belongs in the "Archived" view.
 * Inverse of isVisibleSession — keep both to avoid accidental negation bugs
 * at call sites.
 */
export function isArchivedSession(s: { isArchived: boolean }): boolean {
	return s.isArchived;
}
