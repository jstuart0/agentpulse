/**
 * GET /users rows carry sessionCount (sessions the user owns), counted in the
 * same grouped style as the key and host counts: one extra statement however
 * many users there are. The Disable dialog shows it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

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

interface Row {
	id: string;
	sessionCount: number;
}

async function listUsers(headers: Headers): Promise<Row[]> {
	const res = await app.request("/api/v1/users", { headers });
	expect(res.status).toBe(200);
	return ((await res.json()) as { users: Row[] }).users;
}

function sessionRows(owner: string | null, n: number, prefix: string) {
	return Array.from({ length: n }, (_, i) => ({
		sessionId: `${prefix}-${i}`,
		agentType: "claude_code",
		metadata: {},
		ownerUserId: owner,
	}));
}

describe("GET /users sessionCount", () => {
	test("counts every session a user owns, archived or not, and nothing unowned", async () => {
		const admin = await seedLocalUser("sc-admin", "admin");
		const busy = await seedLocalUser("sc-busy");
		const idle = await seedLocalUser("sc-idle");
		await getDb()
			.insert(sessions)
			.values([
				...sessionRows(busy.id, 3, "busy"),
				...sessionRows(admin.id, 1, "admin"),
				...sessionRows(null, 4, "nobody"),
				{
					sessionId: "busy-archived",
					agentType: "claude_code",
					metadata: {},
					ownerUserId: busy.id,
					isArchived: true,
				},
			]);
		const rows = new Map(
			(await listUsers(await cookieHeadersFor(admin.id))).map((r) => [r.id, r.sessionCount]),
		);
		expect(rows.get(busy.id)).toBe(4);
		expect(rows.get(admin.id)).toBe(1);
		expect(rows.get(idle.id)).toBe(0);
	});

	test("one grouped statement: the count does not grow with the number of users", async () => {
		const admin = await seedLocalUser("sc-many-admin", "admin");
		const headers = await cookieHeadersFor(admin.id);
		await getDb()
			.insert(sessions)
			.values(sessionRows(admin.id, 2, "many"));
		const few = await countDbCalls(async () => {
			await listUsers(headers);
		});
		const others = await Promise.all(
			Array.from({ length: 6 }, (_, i) => seedLocalUser(`sc-many-${i}`)),
		);
		await getDb()
			.insert(sessions)
			.values(others.flatMap((u, i) => sessionRows(u.id, 2, `many-${i}`)));
		const many = await countDbCalls(async () => {
			await listUsers(headers);
		});
		expect(many).toBe(few);
	});
});
