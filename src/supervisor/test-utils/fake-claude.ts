/** What a test needs to know about the fake `claude` (providers/__fixtures__/fake-claude-tree.ts) from its log. */
export function fakeClaudeReady(
	entries: ReadonlyArray<Record<string, unknown>>,
	env: Record<string, string>,
): boolean {
	const has = (role: string) => entries.some((entry) => entry.role === role);
	if (!has("claude")) return false;
	// The child writes `child-ready` after installing its SIGTERM handling; until then a stop could race it.
	return (env.FAKE_CLAUDE_CHILD ?? "none") === "none" || (has("child") && has("child-ready"));
}
