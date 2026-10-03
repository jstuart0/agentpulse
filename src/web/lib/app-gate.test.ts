import { describe, expect, test } from "bun:test";
import { deriveAppGate } from "./app-gate.js";

const signedIn = {
	loaded: true,
	authenticated: true,
	disableAuth: false,
	mustChangePassword: false,
};

describe("deriveAppGate", () => {
	test("until /auth/me answers, nothing but the loading shell", () => {
		expect(deriveAppGate({ ...signedIn, loaded: false })).toBe("loading");
		expect(deriveAppGate({ ...signedIn, loaded: false, mustChangePassword: true })).toBe("loading");
	});

	test("signed out goes to the sign-in page", () => {
		expect(deriveAppGate({ ...signedIn, authenticated: false })).toBe("login");
	});

	test("a flagged user sees only the password change, never the app", () => {
		expect(deriveAppGate({ ...signedIn, mustChangePassword: true })).toBe("change_password");
	});

	test("a normal signed-in user gets the app", () => {
		expect(deriveAppGate(signedIn)).toBe("app");
	});

	test("with auth disabled there is no sign-in and no password to change", () => {
		expect(deriveAppGate({ ...signedIn, authenticated: false, disableAuth: true })).toBe("app");
		expect(deriveAppGate({ ...signedIn, disableAuth: true, mustChangePassword: true })).toBe("app");
	});
});
