/**
 * `GET /sessions?status=archived` lists archived sessions: the archive flag, and rows that still carry the
 * legacy `archived` status. It used to filter on the status column alone, which new rows never hold, so it
 * answered nothing. Same meaning as search's `sessionStatus=archived`. Runs on both dialects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { inArray } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");

const RUN = crypto.randomUUID().slice(0, 8);
const ids = {
	flag: `sa-flag-${RUN}`,
	legacy: `sa-legacy-${RUN}`,
	active: `sa-active-${RUN}`,
	done: `sa-done-${RUN}`,
};
let auth: Record<string, string> = {};

beforeAll(async () => {
	await initializeDatabase();
	auth = { Authorization: `Bearer ${(await createApiKey(`sa-${RUN}`, ["manage"])).key}` };
	const now = new Date().toISOString();
	const base = { agentType: "claude_code", startedAt: now, lastActivityAt: now, metadata: {} };
	await getDb()
		.insert(sessions)
		.values([
			{ ...base, sessionId: ids.flag, status: "completed", isArchived: true },
			{ ...base, sessionId: ids.legacy, status: "archived" },
			{ ...base, sessionId: ids.active, status: "active" },
			{ ...base, sessionId: ids.done, status: "completed" },
		] as never);
});
afterAll(async () => {
	await getDb()
		.delete(sessions)
		.where(inArray(sessions.sessionId, Object.values(ids)));
});

async function list(query: string): Promise<string[]> {
	const res = await app.request(`/api/v1/sessions?limit=500&${query}`, { headers: auth });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { sessions: Array<{ sessionId: string }>; total: number };
	const mine = new Set(Object.values(ids));
	return body.sessions
		.map((s) => s.sessionId)
		.filter((id) => mine.has(id))
		.sort();
}

describe("GET /sessions?status=archived", () => {
	test("matches the archive flag and the legacy status, and nothing else", async () => {
		expect(await list("status=archived")).toEqual([ids.flag, ids.legacy].sort());
	});

	test("the total counts the same set", async () => {
		const res = await app.request("/api/v1/sessions?limit=1&status=archived", { headers: auth });
		const { total } = (await res.json()) as { total: number };
		expect(total).toBeGreaterThanOrEqual(2);
	});

	test("agrees with the archived tab on the flagged session", async () => {
		expect(await list("tab=archived")).toContain(ids.flag);
	});

	test("the other statuses still filter on the status column", async () => {
		expect(await list("status=active")).toEqual([ids.active]);
		expect(await list("status=completed")).toEqual([ids.done, ids.flag].sort());
	});

	test("it works in the card view as well", async () => {
		expect(await list("status=archived&view=card")).toEqual([ids.flag, ids.legacy].sort());
	});
});
