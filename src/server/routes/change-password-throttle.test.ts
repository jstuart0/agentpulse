/**
 * POST /auth/change-password throttles failed current-password attempts per
 * user: five failures in fifteen minutes lock the user out of the endpoint
 * (429 with Retry-After) until the window passes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	TEST_PASSWORD,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedLocalUser,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase } = await import("../db/client.js");
const { app } = await import("../app.js");
const {
	PASSWORD_CHANGE_FAILURE_LIMIT,
	PASSWORD_CHANGE_WINDOW_MS,
	_resetPasswordChangeLimitForTest,
	_setPasswordChangeClockForTest,
} = await import("../services/password-change-limit.js");

const NEW_PASSWORD = "A-brand-new-Pass-77!";

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	_setPasswordChangeClockForTest(null);
	_resetPasswordChangeLimitForTest();
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const change = (currentPassword: string, headers: Headers) =>
	app.request(
		"/api/v1/auth/change-password",
		jsonRequest("POST", { currentPassword, newPassword: NEW_PASSWORD }, headers),
	);

describe("change-password failure throttle", () => {
	test("five failures in fifteen minutes", () => {
		expect(PASSWORD_CHANGE_FAILURE_LIMIT).toBe(5);
		expect(PASSWORD_CHANGE_WINDOW_MS).toBe(15 * 60_000);
	});

	test("the sixth attempt after five failures is a 429 with Retry-After, even with the right password; the window then passes", async () => {
		let now = 1_000_000;
		_setPasswordChangeClockForTest(() => now);
		try {
			const user = await seedLocalUser("cp-user");
			const headers = await cookieHeadersFor(user.id);
			for (let i = 0; i < PASSWORD_CHANGE_FAILURE_LIMIT; i++) {
				expect((await change("wrong-password-1", headers)).status).toBe(401);
			}

			const locked = await change(TEST_PASSWORD, headers);
			expect(locked.status).toBe(429);
			// The window started with the first failure, and counts down.
			expect(Number(locked.headers.get("Retry-After"))).toBe(15 * 60);
			now += 5 * 60_000;
			const later = await change(TEST_PASSWORD, headers);
			expect(later.status).toBe(429);
			expect(Number(later.headers.get("Retry-After"))).toBe(10 * 60);
			now -= 5 * 60_000;

			now += PASSWORD_CHANGE_WINDOW_MS + 1;
			expect((await change(TEST_PASSWORD, headers)).status).toBe(200);
		} finally {
			_setPasswordChangeClockForTest(null);
		}
	});

	test("another user is not locked out, and a success clears the user's count", async () => {
		_setPasswordChangeClockForTest(() => 2_000_000);
		try {
			const first = await seedLocalUser("cp-first");
			const second = await seedLocalUser("cp-second");
			const firstHeaders = await cookieHeadersFor(first.id);
			for (let i = 0; i < PASSWORD_CHANGE_FAILURE_LIMIT; i++) {
				await change("wrong-password-1", firstHeaders);
			}
			expect((await change(TEST_PASSWORD, firstHeaders)).status).toBe(429);
			expect((await change(TEST_PASSWORD, await cookieHeadersFor(second.id))).status).toBe(200);

			const third = await seedLocalUser("cp-third");
			let headers = await cookieHeadersFor(third.id);
			for (let i = 0; i < PASSWORD_CHANGE_FAILURE_LIMIT - 1; i++) {
				expect((await change("wrong-password-1", headers)).status).toBe(401);
			}
			const ok = await change(TEST_PASSWORD, headers);
			expect(ok.status).toBe(200);
			headers = new Headers({ Cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0] });
			for (let i = 0; i < PASSWORD_CHANGE_FAILURE_LIMIT - 1; i++) {
				expect((await change("wrong-password-1", headers)).status).toBe(401);
			}
		} finally {
			_setPasswordChangeClockForTest(null);
		}
	});

	test("a weak new password is a 400 and doesn't count as a failed guess", async () => {
		_setPasswordChangeClockForTest(() => 3_000_000);
		try {
			const user = await seedLocalUser("cp-weak");
			const headers = await cookieHeadersFor(user.id);
			for (let i = 0; i < PASSWORD_CHANGE_FAILURE_LIMIT + 2; i++) {
				const res = await app.request(
					"/api/v1/auth/change-password",
					jsonRequest(
						"POST",
						{ currentPassword: "wrong-password-1", newPassword: "short" },
						headers,
					),
				);
				expect(res.status).toBe(400);
			}
			expect((await change(TEST_PASSWORD, headers)).status).toBe(200);
		} finally {
			_setPasswordChangeClockForTest(null);
		}
	});
});
