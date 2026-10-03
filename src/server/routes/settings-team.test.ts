/**
 * Settings in team mode: PUT /settings is judged per key (the theme stays
 * writable by any member, the other user-settable keys are an admin's, and the
 * protected keys stay refused), and GET /settings never carries the instance
 * rows (the mode is read from /instance; the kept-key list is not a setting a
 * client should see).
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
const { settings } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	for (const key of [
		"theme",
		"eventsRetentionDays",
		"sessionIdleTimeoutMinutes",
		"sessionEndTimeoutMinutes",
	]) {
		await getDb().delete(settings).where(eq(settings.key, key));
	}
}
beforeEach(reset);
afterEach(reset);

const put = (key: string, value: unknown, headers: Headers) =>
	app.request("/api/v1/settings", jsonRequest("PUT", { key, value }, headers));

async function stored(key: string) {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
	return row?.value ?? null;
}

describe("PUT /settings in team mode", () => {
	test("a member may set the theme and nothing else", async () => {
		await setStoredMode("team");
		const member = await seedLocalUser("st-member");
		const headers = await cookieHeadersFor(member.id);
		expect((await put("theme", "light", headers)).status).toBe(200);
		expect(await stored("theme")).toBe("light");

		for (const key of [
			"eventsRetentionDays",
			"sessionIdleTimeoutMinutes",
			"sessionEndTimeoutMinutes",
		]) {
			const res = await put(key, 5, headers);
			expect({ key, status: res.status }).toEqual({ key, status: 403 });
			expect(((await res.json()) as { error: string }).error).toBe("admin_required");
			expect(await stored(key)).toBeNull();
		}
	});

	test("an admin, an admin-owned key and a kept service key may set any user-settable key", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("st-admin", "admin");
		const adminKey = await seedKey("st-admin-key", ["manage"], admin.id);
		const service = await seedKey("st-service", ["manage"]);
		await setAdminServiceKeyList([service.id]);
		for (const headers of [
			await cookieHeadersFor(admin.id),
			bearerHeaders(adminKey.key),
			bearerHeaders(service.key),
		]) {
			expect((await put("eventsRetentionDays", 30, headers)).status).toBe(200);
		}
		expect(await stored("eventsRetentionDays")).toBe(30);
	});

	test("a member's key and an unlisted service key are members", async () => {
		await setStoredMode("team");
		const member = await seedLocalUser("st-key-member");
		const memberKey = await seedKey("st-member-key", ["manage"], member.id);
		const service = await seedKey("st-unlisted", ["manage"]);
		for (const headers of [bearerHeaders(memberKey.key), bearerHeaders(service.key)]) {
			expect((await put("eventsRetentionDays", 7, headers)).status).toBe(403);
			expect((await put("theme", "dark", headers)).status).toBe(200);
		}
	});

	test("protected keys stay refused for an admin, including the instance rows", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("st-protected", "admin");
		const headers = await cookieHeadersFor(admin.id);
		for (const key of ["ai.enabled", "instance.mode", "instance.adminServiceKeyIds"]) {
			const res = await put(key, "x", headers);
			expect({ key, status: res.status }).toEqual({ key, status: 403 });
			expect(((await res.json()) as { error: string }).error).toBe("key_not_user_settable");
		}
		expect(await stored("instance.mode")).toBe("team");
	});
});

describe("PUT /settings in solo mode is unchanged", () => {
	test("a member may set any user-settable key", async () => {
		const member = await seedLocalUser("st-solo");
		const headers = await cookieHeadersFor(member.id);
		for (const key of [
			"theme",
			"eventsRetentionDays",
			"sessionIdleTimeoutMinutes",
			"sessionEndTimeoutMinutes",
		]) {
			expect({ key, status: (await put(key, 10, headers)).status }).toEqual({ key, status: 200 });
		}
	});
});

describe("GET /settings", () => {
	test("never carries an instance row, in either mode", async () => {
		const admin = await seedLocalUser("st-get", "admin");
		const service = await seedKey("st-get-service", ["manage"]);
		await setAdminServiceKeyList([service.id]);
		await put("theme", "dark", await cookieHeadersFor(admin.id));
		for (const mode of ["solo", "team"] as const) {
			await setStoredMode(mode);
			const res = await app.request("/api/v1/settings", {
				headers: await cookieHeadersFor(admin.id),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.theme).toBe("dark");
			expect(Object.keys(body).filter((key) => key.startsWith("instance."))).toEqual([]);
		}
		expect(await stored("instance.adminServiceKeyIds")).toEqual([service.id]);
	});
});
