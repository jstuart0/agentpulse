/**
 * A refusal changes nothing. Each case here asserts the write is absent, not
 * just the status: a refused key mint leaves no key row, a refused user create
 * no user row, a refused password reset leaves the hash, the must-change flag
 * and the target's sessions as they were, and a refused self-promotion leaves
 * the role alone — in solo and in team.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys, authSessions, users } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const call = (path: string, method: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body, headers));
const keyCount = async () => (await getDb().select().from(apiKeys)).length;
const userCount = async () => (await getDb().select().from(users)).length;
async function userRow(id: string) {
	const [row] = await getDb().select().from(users).where(eq(users.id, id));
	return row;
}
async function usernameExists(username: string) {
	return (await getDb().select().from(users).where(eq(users.username, username))).length > 0;
}

describe("a refused service-key mint writes no key", () => {
	test("a member, an admin's key and a kept service key are each refused, and the key table is unchanged", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("rw-admin", "admin");
		const member = await seedLocalUser("rw-member");
		const adminKey = await seedKey("rw-admin-key", ["manage"], admin.id);
		const kept = await seedKey("rw-kept", ["manage"]);
		await setAdminServiceKeyList([kept.id]);
		const before = await keyCount();

		const asMember = await call(
			"/api-keys",
			"POST",
			{ name: "svc", scopes: ["ingest"], service: true },
			await cookieHeadersFor(member.id),
		);
		const asAdminKey = await call(
			"/api-keys",
			"POST",
			{ name: "svc", scopes: ["manage"], service: true },
			bearerHeaders(adminKey.key),
		);
		const asKept = await call(
			"/api-keys",
			"POST",
			{ name: "svc", scopes: ["ingest"], service: true },
			bearerHeaders(kept.key),
		);

		for (const res of [asMember, asAdminKey, asKept]) expect(res.status).toBe(403);
		expect(await keyCount()).toBe(before);
	});

	test("an ownerless key that isn't kept can't mint at all in team mode, and leaves nothing behind", async () => {
		await setStoredMode("team");
		const unkept = await seedKey("rw-unkept", ["manage"]);
		const before = await keyCount();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "child", scopes: ["ingest"] },
			bearerHeaders(unkept.key),
		);
		expect(res.status).toBe(403);
		expect(await keyCount()).toBe(before);
	});
});

describe("a refused user create writes no user", () => {
	test("by a member, by an admin's key, from a foreign origin, and with a bad name", async () => {
		for (const mode of ["solo", "team"] as const) {
			await reset();
			if (mode === "team") await setStoredMode("team");
			const admin = await seedLocalUser(`rw-u-admin-${mode}`, "admin");
			const member = await seedLocalUser(`rw-u-member-${mode}`);
			const adminKey = await seedKey("rw-u-key", ["manage"], admin.id);
			const before = await userCount();

			const attempts: Array<[string, Response]> = [
				[
					"member",
					await call(
						"/users",
						"POST",
						{ username: `m-${mode}` },
						await cookieHeadersFor(member.id),
					),
				],
				[
					"key",
					await call("/users", "POST", { username: `k-${mode}` }, bearerHeaders(adminKey.key)),
				],
				[
					"origin",
					await call("/users", "POST", { username: `o-${mode}` }, await foreignOrigin(admin.id)),
				],
				[
					"name",
					await call("/users", "POST", { username: "sso:evil" }, await cookieHeadersFor(admin.id)),
				],
			];
			for (const [label, res] of attempts) {
				expect({ mode, label, refused: res.status >= 400 }).toEqual({ mode, label, refused: true });
			}
			expect(await userCount()).toBe(before);
			for (const name of [`m-${mode}`, `k-${mode}`, `o-${mode}`, "sso:evil"]) {
				expect(await usernameExists(name)).toBe(false);
			}
		}
	});
});

async function foreignOrigin(userId: string): Promise<Headers> {
	const headers = await cookieHeadersFor(userId);
	headers.set("Origin", "https://evil.example.test");
	return headers;
}

describe("a member's refused password reset changes nothing", () => {
	test("the hash, the must-change flag and the target's sessions are as they were", async () => {
		for (const mode of ["solo", "team"] as const) {
			await reset();
			if (mode === "team") await setStoredMode("team");
			const member = await seedLocalUser(`rw-r-member-${mode}`);
			const target = await seedLocalUser(`rw-r-target-${mode}`, "admin");
			const targetCookie = await cookieHeadersFor(target.id);
			const before = await userRow(target.id);
			const sessionsBefore = await getDb()
				.select()
				.from(authSessions)
				.where(eq(authSessions.userId, target.id));

			const res = await call(
				`/users/${target.id}/reset-password`,
				"POST",
				{},
				await cookieHeadersFor(member.id),
			);

			expect({ mode, status: res.status }).toEqual({ mode, status: 403 });
			const after = await userRow(target.id);
			expect(after?.passwordHash).toBe(before?.passwordHash);
			expect(after?.mustChangePassword).toBe(before?.mustChangePassword);
			const sessionsAfter = await getDb()
				.select()
				.from(authSessions)
				.where(eq(authSessions.userId, target.id));
			expect(sessionsAfter.length).toBe(sessionsBefore.length);
			// The target's own cookie still works.
			expect((await app.request("/api/v1/auth/me", { headers: targetCookie })).status).toBe(200);
		}
	});
});

describe("self-promotion on the real route", () => {
	test("a member and a non-admin local user can't make themselves admin, in solo and in team", async () => {
		for (const mode of ["solo", "team"] as const) {
			await reset();
			if (mode === "team") await setStoredMode("team");
			const self = await seedLocalUser(`rw-self-${mode}`);
			const other = await seedLocalUser(`rw-self-other-${mode}`);

			for (const target of [self, other]) {
				const res = await call(
					`/users/${target.id}`,
					"PATCH",
					{ role: "admin" },
					await cookieHeadersFor(self.id),
				);
				expect({
					mode,
					target: target.id === self.id ? "self" : "other",
					status: res.status,
				}).toEqual({ mode, target: target.id === self.id ? "self" : "other", status: 403 });
				expect((await userRow(target.id))?.role).toBe("user");
			}
		}
	});

	test("an owned manage key of a member can't promote its owner either", async () => {
		await setStoredMode("team");
		const self = await seedLocalUser("rw-self-key");
		const key = await seedKey("rw-self-manage", ["manage"], self.id);
		const res = await call(`/users/${self.id}`, "PATCH", { role: "admin" }, bearerHeaders(key.key));
		expect(res.status).toBe(403);
		expect((await userRow(self.id))?.role).toBe("user");
	});
});
