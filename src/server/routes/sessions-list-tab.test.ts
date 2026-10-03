/**
 * GET /sessions?tab=active|completed|archived: the contract at the route.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

async function world() {
	await setStoredMode("team");
	const me = await seedLocalUser("tab-me");
	const now = new Date().toISOString();
	const base = { agentType: "claude_code", metadata: {}, startedAt: now, lastActivityAt: now };
	await getDb()
		.insert(sessions)
		.values([
			{ ...base, sessionId: "t-active", displayName: "t-active", status: "active" },
			{
				...base,
				sessionId: "t-completed",
				displayName: "t-completed",
				status: "completed",
				endedAt: now,
			},
			{
				...base,
				sessionId: "t-archived",
				displayName: "t-archived",
				status: "completed",
				endedAt: now,
				isArchived: true,
			},
		] as never);
	return { headers: await cookieHeadersFor(me.id) };
}

interface ListBody {
	sessions: Array<{ sessionId: string }>;
	total: number;
	ownerScope: unknown;
	error?: string;
	value?: string;
	allowed?: string[];
	params?: string[];
}

async function get(path: string, headers: Headers) {
	const res = await app.request(`/api/v1${path}`, { headers });
	return { status: res.status, body: (await res.json()) as ListBody };
}

describe("tab parameter", () => {
	test("each tab answers its own rows, the total and the scope echo", async () => {
		const { headers } = await world();
		for (const [tab, id] of [
			["active", "t-active"],
			["completed", "t-completed"],
			["archived", "t-archived"],
		] as const) {
			const res = await get(`/sessions?tab=${tab}`, headers);
			expect(res.status).toBe(200);
			expect(res.body.sessions.map((s) => s.sessionId)).toEqual([id]);
			expect(res.body.total).toBe(1);
			expect(res.body.ownerScope).toEqual({ kind: "all" });
		}
	});

	test("an unknown tab is a 400 that echoes a short prefix of what was sent", async () => {
		const { headers } = await world();
		const res = await get(`/sessions?tab=${"x".repeat(500)}`, headers);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("invalid_tab");
		expect(String(res.body.value).length).toBeLessThanOrEqual(64);
		expect(res.body.allowed).toEqual(["active", "completed", "archived"]);
	});

	test("tab with operational or status is refused rather than half-honoured", async () => {
		const { headers } = await world();
		for (const other of ["operational=idle", "status=active"]) {
			const res = await get(`/sessions?tab=active&${other}`, headers);
			expect(res.status).toBe(400);
			expect(res.body.error).toBe("unsupported_combination");
			expect(res.body.params).toEqual(["tab", other.split("=")[0]]);
		}
	});
});
