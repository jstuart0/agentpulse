import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { getSearchBackend } from "../services/search/index.js";
import type { SearchFilters, SearchRowKind } from "../services/search/types.js";

/**
 * Global search across session metadata + event content.
 *
 * Backend: SQLite FTS5 today. When the Postgres backend ships
 * (see thoughts/2026-04-24-postgres-backend-plan.md), the interface
 * stays the same and the backend registry swaps in
 * PostgresTsvectorBackend.
 *
 * Filters are validated and clamped before being passed to the
 * backend — untrusted input never reaches raw SQL.
 */
const searchRouter = new Hono();
const auth = requireAuth();

function parseKinds(input: string | undefined): SearchRowKind[] | undefined {
	if (!input) return undefined;
	const parts = input
		.split(",")
		.map((s) => s.trim())
		.filter((s): s is SearchRowKind => s === "session" || s === "event");
	return parts.length > 0 ? parts : undefined;
}

function parseAgentType(input: string | undefined): "claude_code" | "codex_cli" | undefined {
	return input === "claude_code" || input === "codex_cli" ? input : undefined;
}

function parseSessionStatus(
	input: string | undefined,
): "active" | "idle" | "completed" | "archived" | undefined {
	return input === "active" || input === "idle" || input === "completed" || input === "archived"
		? input
		: undefined;
}

searchRouter.get("/search", auth, async (c) => {
	const q = c.req.query("q")?.trim() ?? "";
	if (!q) {
		return c.json({ hits: [], total: 0, backend: "sqlite-fts5" });
	}

	const filters: SearchFilters = {
		q,
		sessionId: c.req.query("sessionId") || undefined,
		cwd: c.req.query("cwd") || undefined,
		agentType: parseAgentType(c.req.query("agentType")),
		sessionStatus: parseSessionStatus(c.req.query("sessionStatus")),
		eventType: c.req.query("eventType") || undefined,
		since: c.req.query("since") || undefined,
		until: c.req.query("until") || undefined,
		kinds: parseKinds(c.req.query("kinds")),
		limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
		offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
	};

	try {
		const result = await getSearchBackend().search(filters);
		return c.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: `Search failed: ${message}` }, 500);
	}
});

/**
 * Admin-only — rebuilds the FTS index from scratch. Useful after
 * bulk imports or schema changes. Currently auth'd as any logged-in
 * user; Phase 4 of the security plan will narrow this to admin-only
 * once requireAdmin() exists.
 */
searchRouter.post("/search/rebuild", auth, async (c) => {
	try {
		const res = await getSearchBackend().rebuild();
		return c.json({ ok: true, ...res });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: `Rebuild failed: ${message}` }, 500);
	}
});

export { searchRouter };
