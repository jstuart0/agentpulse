import { describe, expect, test } from "bun:test";
import type { AuthMeResponse } from "../../shared/types.js";
import { authStateFromMe } from "./auth-state.js";

const base = {
	authenticated: true,
	signOutUrl: "/api/v1/auth/logout",
	disableAuth: false,
	allowSignup: false,
};

describe("authStateFromMe", () => {
	test("a team-mode member: the new fields land at the top level", () => {
		const res: AuthMeResponse = {
			...base,
			user: {
				name: "bob",
				source: "local",
				id: "u2",
				role: "user",
				userId: "u2",
				displayName: "bob",
				mustChangePassword: false,
				effectiveRole: "member",
			},
			mode: "team",
			modeLockedByEnv: true,
		};
		const state = authStateFromMe(res);
		expect(state.userId).toBe("u2");
		expect(state.effectiveRole).toBe("member");
		expect(state.mustChangePassword).toBe(false);
		expect(state.mode).toBe("team");
		expect(state.modeLockedByEnv).toBe(true);
		expect(state.authenticated).toBe(true);
		expect(state.signOutUrl).toBe("/api/v1/auth/logout");
		expect(state.user?.name).toBe("bob");
	});

	test("a flagged user is flagged", () => {
		const state = authStateFromMe({
			...base,
			user: {
				name: "carol",
				source: "local",
				id: "u3",
				role: "user",
				userId: "u3",
				mustChangePassword: true,
				effectiveRole: "member",
			},
			mode: "team",
		});
		expect(state.mustChangePassword).toBe(true);
	});

	test("an older server that sends none of the new fields reads as solo, unflagged, nobody in particular", () => {
		const state = authStateFromMe({
			...base,
			user: { name: "alice", source: "local", id: "u1", role: "admin" },
		});
		expect(state.mode).toBe("solo");
		expect(state.modeLockedByEnv).toBe(false);
		expect(state.userId).toBeNull();
		expect(state.effectiveRole).toBeNull();
		expect(state.mustChangePassword).toBe(false);
	});

	test("signed out: no user, nothing flagged", () => {
		const state = authStateFromMe({ ...base, authenticated: false, user: null, signOutUrl: null });
		expect(state.authenticated).toBe(false);
		expect(state.user).toBeNull();
		expect(state.userId).toBeNull();
		expect(state.mustChangePassword).toBe(false);
	});

	test("an API-key identity carries its owner's id", () => {
		const state = authStateFromMe({
			...base,
			user: {
				name: "ci",
				source: "api_key",
				id: null,
				role: null,
				userId: "u9",
				effectiveRole: "admin",
			},
		});
		expect(state.userId).toBe("u9");
		expect(state.effectiveRole).toBe("admin");
	});
});
