import { Hono } from "hono";
import { requireAuth, requireScope } from "../auth/middleware.js";
import { getSearchBackend } from "../services/search/index.js";
import type { SearchFilters, SearchRowKind } from "../services/search/types.js";

/**
 * Global search across session metadata + event content.
 *
 * Backend: dialect-aware dispatch via getSearchBackend() in services/search/index.ts.
 *   SQLite: FTS5 (SqliteFtsBackend)
 *   Postgres: ILIKE direct-search (PostgresSearchBackend)
 *
 * Filters are validated and clamped before being passed to the
 * backend — untrusted input never reaches raw SQL.
 */
const searchRouter = new Hono();
searchRouter.use("*", requireAuth());
searchRouter.use("*", requireScope("manage"));

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

searchRouter.get("/search", async (c) => {
	const q = c.req.query("q")?.trim() ?? "";
	if (!q) {
		return c.json({ hits: [], total: 0, backend: getSearchBackend().name });
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

/** Rebuild the FTS index from scratch. Requires manage scope (router-level gate). */
searchRouter.post("/search/rebuild", async (c) => {
	try {
		const res = await getSearchBackend().rebuild();
		return c.json({ ok: true, ...res });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: `Rebuild failed: ${message}` }, 500);
	}
});

export { searchRouter };
