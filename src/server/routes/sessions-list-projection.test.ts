/**
 * F128 (percy): the relay's Codex name sync pages GET /sessions every tick.
 * An opt-in `fields=` projection returns only allowlisted fields and skips
 * the count(*); the default response is unchanged for every other consumer;
 * a composite (agent_type, last_activity_at) index serves the relay's query.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createApiKey, SCOPE_OBSERVE } = await import("../auth/api-key.js");
const { getSessions } = await import("../services/session-tracker.js");

const originalDisableAuth = config.disableAuth;
let observeKey: string;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = false;
	observeKey = (await createApiKey("projection-observe", [SCOPE_OBSERVE])).key;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(sessions).execute();
	const base = Date.parse("2026-09-28T12:00:00.000Z");
	for (let i = 0; i < 3; i++) {
		await getDb()
			.insert(sessions)
			.values({
				sessionId: `cx-${i}`,
				displayName: `name-${i}`,
				agentType: "codex_cli",
				status: "active",
				cwd: "/w",
				claudeMdContent: "x".repeat(2000),
				lastActivityAt: new Date(base + i * 1000).toISOString(),
				metadata: i === 0 ? { renameSource: "user", nativeName: "codex-title" } : {},
			})
			.execute();
	}
	await getDb()
		.insert(sessions)
		.values({
			sessionId: "cc-1",
			displayName: "claude",
			agentType: "claude_code",
			status: "active",
		})
		.execute();
});

const get = (qs: string) =>
	app.request(`/api/v1/sessions${qs}`, { headers: { Authorization: `Bearer ${observeKey}` } });

describe("GET /sessions?fields= (F128)", () => {
	test("returns only the requested allowlisted fields, newest first, with no total", async () => {
		const res = await get(
			"?agent_type=codex_cli&limit=50&offset=0&fields=sessionId,displayName,nameSource",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<Record<string, unknown>>; total?: number };
		expect("total" in body).toBe(false);
		expect(body.sessions.map((s) => s.sessionId)).toEqual(["cx-2", "cx-1", "cx-0"]);
		for (const s of body.sessions)
			expect(Object.keys(s).sort()).toEqual(["displayName", "nameSource", "sessionId"]);
		expect(body.sessions[2]).toEqual({
			sessionId: "cx-0",
			displayName: "name-0",
			nameSource: "user",
		});
	});

	test("every allowlisted field is available", async () => {
		const res = await get(
			"?agent_type=codex_cli&fields=sessionId,displayName,nameSource,nativeName,agentType,lastActivityAt",
		);
		const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
		expect(body.sessions[2]).toMatchObject({ nativeName: "codex-title", agentType: "codex_cli" });
		expect(typeof body.sessions[0].lastActivityAt).toBe("string");
	});

	test("paging and filters still apply", async () => {
		const res = await get("?agent_type=codex_cli&limit=2&offset=1&fields=sessionId");
		const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
		expect(body.sessions).toEqual([{ sessionId: "cx-1" }, { sessionId: "cx-0" }]);
	});

	test("an unknown or empty field list is a 400 naming the value", async () => {
		const bad = await get("?fields=sessionId,claudeMdContent");
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "invalid_field", value: "claudeMdContent" });
		const empty = await get("?fields=");
		expect(empty.status).toBe(400);
	});

	test("without fields the response is exactly getSessions(): full rows plus total, tagged with the applied scope", async () => {
		const res = await get("?agent_type=codex_cli&limit=50");
		const { ownerScope, hostFilter, ...body } = (await res.json()) as {
			sessions: Array<Record<string, unknown>>;
			total: number;
			ownerScope: unknown;
			hostFilter: unknown;
		};
		expect(ownerScope).toEqual({ kind: "all" });
		expect(hostFilter).toEqual({ kind: "all" });
		expect(body.total).toBe(3);
		expect(body.sessions[0].claudeMdContent).toBe("x".repeat(2000));
		expect("managed" in body.sessions[0]).toBe(true);
		const direct = await getSessions({ agentType: "codex_cli", limit: 50, offset: 0 });
		expect(body).toEqual(JSON.parse(JSON.stringify(direct)));
	});
});

describe.skipIf(config.dialect !== "sqlite")(
	"the relay's query uses the composite index (F128)",
	() => {
		test("EXPLAIN QUERY PLAN: idx_sessions_agent_type_last_activity, no temp B-tree sort", async () => {
			const db = getDb() as unknown as { all: (q: unknown) => Array<{ detail: string }> };
			const plan = await db.all(
				sql`EXPLAIN QUERY PLAN SELECT session_id, display_name, metadata FROM sessions WHERE agent_type = 'codex_cli' ORDER BY last_activity_at DESC LIMIT 50 OFFSET 0`,
			);
			const details = plan.map((r) => r.detail).join(" | ");
			expect(details).toContain("idx_sessions_agent_type_last_activity");
			expect(details).not.toContain("TEMP B-TREE");
		});
	},
);
