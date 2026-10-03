/**
 * A HEAD request is judged exactly as the GET it stands in for: the always-admin
 * read gate is not a status oracle for a caller who isn't an admin.
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

const { initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const { ALWAYS_ADMIN_ROUTES } = await import("./route-scope-policy.js");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const GET_ROUTES = [...ALWAYS_ADMIN_ROUTES.keys()]
	.filter((entry) => entry.startsWith("GET "))
	.map((entry) => entry.slice(4).replace(/:[A-Za-z]+/g, "abc"));

describe("HEAD on an always-admin read route", () => {
	test("there are always-admin GET routes to check", () => {
		expect(GET_ROUTES.length).toBeGreaterThan(0);
	});

	test("a member gets the same 403 for HEAD as for GET, in solo and in team", async () => {
		for (const mode of ["solo", "team"] as const) {
			await setStoredMode(mode);
			const member = await seedLocalUser(`hp-member-${mode}`);
			const headers = await cookieHeadersFor(member.id);
			for (const path of GET_ROUTES) {
				const get = await app.request(`/api/v1${path}`, { method: "GET", headers });
				const head = await app.request(`/api/v1${path}`, { method: "HEAD", headers });
				expect({ mode, path, get: get.status }).toEqual({ mode, path, get: 403 });
				expect({ mode, path, head: head.status }).toEqual({ mode, path, head: 403 });
			}
		}
	});

	test("an admin's HEAD is not refused by the policy", async () => {
		const admin = await seedLocalUser("hp-admin", "admin");
		const headers = await cookieHeadersFor(admin.id);
		for (const path of GET_ROUTES) {
			const head = await app.request(`/api/v1${path}`, { method: "HEAD", headers });
			expect(head.status).not.toBe(403);
		}
	});
});
