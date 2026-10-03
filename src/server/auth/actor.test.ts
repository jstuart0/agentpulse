/**
 * actorFromAuthUser: every caller kind gets an honest Actor label. A
 * supervisor credential is its own caller kind — not a user, not a real
 * API key — and must not fold into the generic "api_key" label just
 * because it shares AuthUser.source === "api_key" for scope-gating
 * purposes.
 */
import { describe, expect, test } from "bun:test";
import { ANONYMOUS_ACTOR, actorFromAuthUser } from "./actor.js";
import type { AuthUser } from "./middleware.js";

function baseAuthUser(overrides: Partial<AuthUser>): AuthUser {
	return {
		source: "api_key",
		name: "test",
		userId: null,
		keyId: null,
		mustChangePassword: false,
		displayName: null,
		...overrides,
	};
}

describe("actorFromAuthUser — one label per caller kind", () => {
	test("no authUser at all (undefined) → anonymous", () => {
		expect(actorFromAuthUser(undefined)).toEqual(ANONYMOUS_ACTOR);
	});

	test("no authUser at all (null) → anonymous", () => {
		expect(actorFromAuthUser(null)).toEqual(ANONYMOUS_ACTOR);
	});

	test("DISABLE_AUTH's synthetic anonymous api_key caller → anonymous, not api_key", () => {
		const authUser = baseAuthUser({ id: "anonymous", name: "anonymous" });
		expect(actorFromAuthUser(authUser)).toEqual(ANONYMOUS_ACTOR);
	});

	test("a local user → user, with their own userId", () => {
		const authUser = baseAuthUser({ source: "local", id: "user-1", userId: "user-1" });
		expect(actorFromAuthUser(authUser)).toEqual({ userId: "user-1", label: "user" });
	});

	test("an SSO (forwardauth) user → user, with their own userId", () => {
		const authUser = baseAuthUser({
			source: "forwardauth",
			provider: "authentik",
			id: "uid-2",
			userId: "user-2",
		});
		expect(actorFromAuthUser(authUser)).toEqual({ userId: "user-2", label: "user" });
	});

	test("an owned API key → api_key, with the key's owner as userId", () => {
		const authUser = baseAuthUser({ id: "key-1", userId: "user-3", keyId: "key-1" });
		expect(actorFromAuthUser(authUser)).toEqual({ userId: "user-3", label: "api_key" });
	});

	test("an ownerless (service) API key → api_key, with null userId", () => {
		const authUser = baseAuthUser({ id: "key-2", userId: null, keyId: "key-2" });
		expect(actorFromAuthUser(authUser)).toEqual({ userId: null, label: "api_key" });
	});

	test('a supervisor credential → its own "supervisor" label, not api_key, with null userId', () => {
		const authUser = baseAuthUser({
			id: "supervisor-1",
			userId: null,
			keyId: null,
			isSupervisorCredential: true,
		});
		expect(actorFromAuthUser(authUser)).toEqual({ userId: null, label: "supervisor" });
	});
});
