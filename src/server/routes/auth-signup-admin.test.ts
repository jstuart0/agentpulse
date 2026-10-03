/**
 * POST /auth/signup by a signed-in admin (seat creation, kept alongside
 * POST /users). It sits outside the role-policy bundle, so it applies the same
 * rules itself: the Origin check, no use by an admin who must change their
 * password first, a human admin only, and an audit line.
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
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { users } = await import("../db/schema/index.js");
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

const NEW_PASSWORD = "Another-long-password-456";
const signup = (username: string, headers: Headers) =>
	app.request(
		"/api/v1/auth/signup",
		jsonRequest("POST", { username, password: NEW_PASSWORD }, headers),
	);
async function userNamed(username: string) {
	const [row] = await getDb().select().from(users).where(eq(users.username, username));
	return row;
}

describe("signup by a signed-in admin", () => {
	test("creates the user, who must change the password, and writes an audit line without secrets", async () => {
		const admin = await seedLocalUser("su-admin", "admin");
		const lines: string[] = [];
		const original = console.log;
		console.log = (line: unknown) => {
			lines.push(String(line));
		};
		let res: Response;
		try {
			res = await signup("su-new-user", await cookieHeadersFor(admin.id));
		} finally {
			console.log = original;
		}
		expect(res.status).toBe(201);
		const created = await userNamed("su-new-user");
		expect(created?.mustChangePassword).toBe(true);

		const audit = lines.map((l) => {
			try {
				return JSON.parse(l) as Record<string, unknown>;
			} catch {
				return {};
			}
		});
		const entry = audit.find((l) => l.kind === "user_created");
		expect(entry).toBeDefined();
		expect(entry?.by).toBe(admin.id);
		expect(entry?.userId).toBe(created?.id);
		expect(JSON.stringify(entry)).not.toContain(NEW_PASSWORD);
	});

	test("a foreign Origin is refused and nothing is created", async () => {
		const admin = await seedLocalUser("su-origin", "admin");
		const headers = await cookieHeadersFor(admin.id);
		headers.set("Origin", "https://evil.example.test");

		const res = await signup("su-origin-new", headers);

		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
		expect(await userNamed("su-origin-new")).toBeUndefined();
	});

	test("an admin who must change their password can't create users", async () => {
		const admin = await seedLocalUser("su-flagged", "admin", { mustChangePassword: true });

		const res = await signup("su-flagged-new", await cookieHeadersFor(admin.id));

		expect(res.status).toBe(403);
		expect(await userNamed("su-flagged-new")).toBeUndefined();
	});

	test("a member, and an admin's API key, can't use it", async () => {
		const admin = await seedLocalUser("su-owner", "admin");
		const member = await seedLocalUser("su-member");
		const adminKey = await seedKey("su-admin-key", ["manage"], admin.id);

		expect((await signup("su-by-member", await cookieHeadersFor(member.id))).status).toBe(403);
		expect((await signup("su-by-key", bearerHeaders(adminKey.key))).status).toBe(403);
		expect(await userNamed("su-by-member")).toBeUndefined();
		expect(await userNamed("su-by-key")).toBeUndefined();
	});
});
