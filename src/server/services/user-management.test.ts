/**
 * user-management.ts: role changes, disable/enable, admin password reset,
 * the admin user list, and the env-locked-admin rule. Real database, real
 * lock; a fake socket stands in for a WebSocket so the close behaviour can
 * be observed without a server.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	UNTOUCHED_OWNED_RESOURCES,
	seedOwnedResources,
	snapshotOwnedResources,
} from "../test-utils/owned-resources.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { users, authSessions } = await import("../db/schema/index.js");
const { createUser, verifyCredentials, issueSession } = await import("./local-auth-service.js");
const { resolveSsoUser } = await import("./user-identity.js");
const { handleWsOpen, handleWsClose } = await import("../ws/handler.js");
const {
	setUserRole,
	disableUser,
	enableUser,
	resetUserPassword,
	listUsersForAdmin,
	isRoleLockedByEnv,
	LastAdminError,
	RoleLockedByEnvError,
	UserNotFoundError,
} = await import("./user-management.js");

const ACTOR = { userId: null, label: "system" } as const;
const PASSWORD = "a-very-long-password-123";
const ADMIN_SUBJECTS_ENV = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
const originalAdminSubjects = process.env[ADMIN_SUBJECTS_ENV];

beforeAll(async () => {
	await initializeDatabase();
});

afterEach(async () => {
	if (originalAdminSubjects === undefined) {
		delete process.env[ADMIN_SUBJECTS_ENV];
	} else {
		process.env[ADMIN_SUBJECTS_ENV] = originalAdminSubjects;
	}
	await resetIdentityState();
});

function uniqueName(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

function seedLocal(role: "user" | "admin" = "user", password = PASSWORD) {
	return createUser({ username: uniqueName(`um-${role}`), password, role });
}

async function seedSsoAdmin(opts: {
	subject: string;
	source: "uid" | "username" | null;
	provider?: string;
}) {
	const resolved = await resolveSsoUser({
		provider: opts.provider ?? "authentik",
		subject: opts.subject,
		source: opts.source,
		username: `display-${opts.subject}`,
	});
	await getDb().update(users).set({ role: "admin" }).where(eq(users.id, resolved.id));
	return resolved.id;
}

async function userRow(id: string) {
	const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
	return row;
}

/** A WebSocket stand-in registered through the real open handler. */
function openFakeSocket(userId: string | null) {
	const closes: Array<{ code: number; reason: string }> = [];
	const ws = {
		data: { userId, keyId: null },
		send: () => {},
		close: (code: number, reason: string) => closes.push({ code, reason }),
	};
	// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
	handleWsOpen(ws as any);
	return {
		closes,
		forget: () => {
			// biome-ignore lint/suspicious/noExplicitAny: a minimal ServerWebSocket stand-in
			handleWsClose(ws as any);
		},
	};
}

describe("isRoleLockedByEnv", () => {
	const locked = {
		authSource: "forwardauth",
		role: "admin",
		provider: "authentik",
		subject: "uid-locked",
		subjectSource: "uid",
	};

	test("true for a uid-sourced admin of the configured provider whose subject is listed", () => {
		process.env[ADMIN_SUBJECTS_ENV] = "uid-other, uid-locked ,";
		expect(isRoleLockedByEnv(locked)).toBe(true);
	});

	test("false when the same subject belongs to a different provider", () => {
		process.env[ADMIN_SUBJECTS_ENV] = "uid-locked";
		expect(isRoleLockedByEnv({ ...locked, provider: "some-other-idp" })).toBe(false);
	});

	test("false when the subject isn't listed, or nothing is listed", () => {
		process.env[ADMIN_SUBJECTS_ENV] = "someone-else";
		expect(isRoleLockedByEnv(locked)).toBe(false);
		process.env[ADMIN_SUBJECTS_ENV] = "";
		expect(isRoleLockedByEnv(locked)).toBe(false);
	});

	test("false unless the persisted subject source is uid", () => {
		process.env[ADMIN_SUBJECTS_ENV] = "uid-locked";
		expect(isRoleLockedByEnv({ ...locked, subjectSource: "username" })).toBe(false);
		expect(isRoleLockedByEnv({ ...locked, subjectSource: null })).toBe(false);
	});

	test("false for a member, a local account, or a row with no subject", () => {
		process.env[ADMIN_SUBJECTS_ENV] = "uid-locked";
		expect(isRoleLockedByEnv({ ...locked, role: "user" })).toBe(false);
		expect(isRoleLockedByEnv({ ...locked, authSource: "local" })).toBe(false);
		expect(isRoleLockedByEnv({ ...locked, subject: null })).toBe(false);
	});
});

describe("setUserRole", () => {
	test("promotes a member to admin and returns the updated user", async () => {
		const target = await seedLocal("user");

		const { user } = await setUserRole(target.id, "admin", ACTOR);

		expect(user.role).toBe("admin");
		expect((await userRow(target.id))?.role).toBe("admin");
	});

	test("demotes an admin while another active admin remains", async () => {
		const a = await seedLocal("admin");
		await seedLocal("admin");

		await setUserRole(a.id, "user", ACTOR);

		expect((await userRow(a.id))?.role).toBe("user");
	});

	test("refuses to demote the last active admin and leaves the role alone", async () => {
		const only = await seedLocal("admin");

		await expect(setUserRole(only.id, "user", ACTOR)).rejects.toBeInstanceOf(LastAdminError);

		expect((await userRow(only.id))?.role).toBe("admin");
	});

	test("a disabled admin doesn't count as an active one", async () => {
		const active = await seedLocal("admin");
		const other = await seedLocal("admin");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, other.id));

		await expect(setUserRole(active.id, "user", ACTOR)).rejects.toBeInstanceOf(LastAdminError);
	});

	test("an env-locked admin can't be demoted, even with other admins around", async () => {
		process.env[ADMIN_SUBJECTS_ENV] = "uid-env-admin";
		const envAdminId = await seedSsoAdmin({ subject: "uid-env-admin", source: "uid" });
		await seedLocal("admin");

		await expect(setUserRole(envAdminId, "user", ACTOR)).rejects.toBeInstanceOf(
			RoleLockedByEnvError,
		);

		expect((await userRow(envAdminId))?.role).toBe("admin");
	});

	test("a username-sourced admin with a listed subject is not env-locked", async () => {
		process.env[ADMIN_SUBJECTS_ENV] = "legacy-name";
		const id = await seedSsoAdmin({ subject: "legacy-name", source: "username" });
		await seedLocal("admin");

		await setUserRole(id, "user", ACTOR);

		expect((await userRow(id))?.role).toBe("user");
	});

	test("an unknown user is UserNotFoundError", async () => {
		await expect(setUserRole(crypto.randomUUID(), "admin", ACTOR)).rejects.toBeInstanceOf(
			UserNotFoundError,
		);
	});
});

describe("disableUser", () => {
	test("sets disabled_at, deletes login sessions, deactivates keys and tokens, revokes owned hosts, closes sockets; sessions rows stay", async () => {
		await seedLocal("admin");
		const target = await seedLocal("user");
		const bystander = await seedLocal("user");
		const seed = await seedOwnedResources(target.id);
		const bystanderSeed = await seedOwnedResources(bystander.id);
		const targetSocket = openFakeSocket(target.id);
		const bystanderSocket = openFakeSocket(bystander.id);
		expect(await snapshotOwnedResources(seed)).toEqual(UNTOUCHED_OWNED_RESOURCES(target.id));

		try {
			await disableUser(target.id, {}, ACTOR);

			const after = await snapshotOwnedResources(seed);
			expect(after.disabledAt).not.toBeNull();
			expect(after.loginSessions).toBe(0);
			expect(after.keyActive).toBe(false);
			expect(after.tokenActive).toBe(false);
			expect(after.hostState).toBe("revoked");
			expect(after.credentialActive).toBe(false);
			expect(after.sessionRowOwner).toBe(target.id);
			expect(targetSocket.closes).toEqual([{ code: 4001, reason: "account_disabled" }]);
			expect(bystanderSocket.closes).toEqual([]);
			expect(await snapshotOwnedResources(bystanderSeed)).toEqual(
				UNTOUCHED_OWNED_RESOURCES(bystander.id),
			);
		} finally {
			targetSocket.forget();
			bystanderSocket.forget();
		}
	});

	test("a disabled user can no longer log in", async () => {
		await seedLocal("admin");
		const target = await seedLocal("user");

		await disableUser(target.id, {}, ACTOR);

		expect(await verifyCredentials(target.username, PASSWORD)).toBeNull();
	});

	test("with revokeHosts false the owned host and its credential stay, everything else still goes", async () => {
		await seedLocal("admin");
		const target = await seedLocal("user");
		const seed = await seedOwnedResources(target.id);

		await disableUser(target.id, { revokeHosts: false }, ACTOR);

		const after = await snapshotOwnedResources(seed);
		expect(after.hostState).toBe("active");
		expect(after.credentialActive).toBe(true);
		expect(after.disabledAt).not.toBeNull();
		expect(after.keyActive).toBe(false);
		expect(after.loginSessions).toBe(0);
	});

	test("disabling again is a no-op: the first disabled_at stands", async () => {
		await seedLocal("admin");
		const target = await seedLocal("user");

		await disableUser(target.id, {}, ACTOR);
		const first = (await userRow(target.id))?.disabledAt;
		await Bun.sleep(5);
		await disableUser(target.id, {}, ACTOR);

		expect(first).not.toBeNull();
		expect((await userRow(target.id))?.disabledAt).toBe(first as string);
	});

	test("refuses the last active admin, an env-locked admin and an unknown user, changing nothing", async () => {
		const onlyAdmin = await seedLocal("admin");
		const seed = await seedOwnedResources(onlyAdmin.id);
		await expect(disableUser(onlyAdmin.id, {}, ACTOR)).rejects.toBeInstanceOf(LastAdminError);
		expect(await snapshotOwnedResources(seed)).toEqual(UNTOUCHED_OWNED_RESOURCES(onlyAdmin.id));

		process.env[ADMIN_SUBJECTS_ENV] = "uid-env-disable";
		const envAdminId = await seedSsoAdmin({ subject: "uid-env-disable", source: "uid" });
		await expect(disableUser(envAdminId, {}, ACTOR)).rejects.toBeInstanceOf(RoleLockedByEnvError);
		expect((await userRow(envAdminId))?.disabledAt).toBeNull();

		await expect(disableUser(crypto.randomUUID(), {}, ACTOR)).rejects.toBeInstanceOf(
			UserNotFoundError,
		);
	});
});

describe("enableUser", () => {
	test("clears disabled_at and nothing else: revoked keys, hosts and login sessions stay gone", async () => {
		await seedLocal("admin");
		const target = await seedLocal("user");
		const seed = await seedOwnedResources(target.id);
		await disableUser(target.id, {}, ACTOR);

		await enableUser(target.id, ACTOR);

		const after = await snapshotOwnedResources(seed);
		expect(after.disabledAt).toBeNull();
		expect(after.keyActive).toBe(false);
		expect(after.tokenActive).toBe(false);
		expect(after.hostState).toBe("revoked");
		expect(after.credentialActive).toBe(false);
		expect(after.loginSessions).toBe(0);
		expect(await verifyCredentials(target.username, PASSWORD)).not.toBeNull();
	});

	test("enabling an active user is harmless; an unknown user is UserNotFoundError", async () => {
		const target = await seedLocal("user");

		await enableUser(target.id, ACTOR);

		expect((await userRow(target.id))?.disabledAt).toBeNull();
		await expect(enableUser(crypto.randomUUID(), ACTOR)).rejects.toBeInstanceOf(UserNotFoundError);
	});
});

describe("resetUserPassword", () => {
	test("returns a new password once; the old one stops working, the new one works, the user must change it, sessions and sockets are gone", async () => {
		const target = await seedLocal("user");
		const { tokenHash } = await issueSession({ userId: target.id });
		const socket = openFakeSocket(target.id);

		try {
			const { password } = await resetUserPassword(target.id, ACTOR);

			expect(password.length).toBeGreaterThanOrEqual(12);
			expect(password).not.toBe(PASSWORD);
			expect(await verifyCredentials(target.username, PASSWORD)).toBeNull();
			expect(await verifyCredentials(target.username, password)).not.toBeNull();
			const row = await userRow(target.id);
			expect(row?.mustChangePassword).toBe(true);
			expect(row?.passwordHash).not.toContain(password);
			const sessionRows = await getDb()
				.select()
				.from(authSessions)
				.where(eq(authSessions.tokenHash, tokenHash));
			expect(sessionRows.length).toBe(0);
			expect(socket.closes.length).toBe(1);
		} finally {
			socket.forget();
		}
	});

	test("each reset generates a different password", async () => {
		const target = await seedLocal("user");

		const first = await resetUserPassword(target.id, ACTOR);
		const second = await resetUserPassword(target.id, ACTOR);

		expect(first.password).not.toBe(second.password);
	});

	test("the plaintext is never written to any log channel", async () => {
		const target = await seedLocal("user");
		const logged: string[] = [];
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((channel) =>
			spyOn(console, channel).mockImplementation((...args: unknown[]) => {
				logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
			}),
		);
		let password = "";
		try {
			({ password } = await resetUserPassword(target.id, ACTOR));
		} finally {
			for (const spy of spies) spy.mockRestore();
		}

		expect(password).not.toBe("");
		expect(logged.some((line) => line.includes(password))).toBe(false);
	});

	test("refuses an SSO account and changes nothing; an unknown user is UserNotFoundError", async () => {
		const ssoId = (
			await resolveSsoUser({
				provider: "authentik",
				subject: uniqueName("sso-reset"),
				source: "uid",
				username: "sso person",
			})
		).id;
		const before = await userRow(ssoId);

		await expect(resetUserPassword(ssoId, ACTOR)).rejects.toThrow(/only available for local/);

		const after = await userRow(ssoId);
		expect(after?.passwordHash).toBe(before?.passwordHash as string);
		expect(after?.mustChangePassword).toBe(false);
		await expect(resetUserPassword(crypto.randomUUID(), ACTOR)).rejects.toBeInstanceOf(
			UserNotFoundError,
		);
	});
});

describe("listUsersForAdmin", () => {
	test("lists every user without any password material, with source, role, disabled and lock flags", async () => {
		process.env[ADMIN_SUBJECTS_ENV] = "uid-listed";
		const local = await seedLocal("admin");
		const disabled = await seedLocal("user");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, disabled.id));
		const lockedId = await seedSsoAdmin({ subject: "uid-listed", source: "uid" });
		const usernameId = await seedSsoAdmin({ subject: "by-username", source: "username" });
		const nullId = await seedSsoAdmin({ subject: "by-cookie", source: null });

		const list = await listUsersForAdmin();
		const byId = new Map(list.map((row) => [row.id, row]));

		expect(list.length).toBe(5);
		const serialised = JSON.stringify(list);
		expect(serialised).not.toContain("argon2");
		expect(serialised).not.toContain("passwordHash");
		for (const row of list) expect(Object.keys(row)).not.toContain("passwordHash");

		expect(byId.get(local.id)).toMatchObject({
			username: local.username,
			role: "admin",
			disabled: false,
			authSource: "local",
			subjectSource: null,
			roleLockedByEnv: false,
		});
		expect(byId.get(disabled.id)?.disabled).toBe(true);
		expect(byId.get(lockedId)).toMatchObject({
			authSource: "forwardauth",
			provider: "authentik",
			subjectSource: "uid",
			roleLockedByEnv: true,
		});
		expect(byId.get(usernameId)?.subjectSource).toBe("username");
		expect(byId.get(nullId)?.subjectSource).toBeNull();
	});

	test("an SSO user is labelled by display name, never the stored sso: username", async () => {
		const id = await seedSsoAdmin({ subject: "label-subject", source: "uid" });

		const row = (await listUsersForAdmin()).find((r) => r.id === id);

		expect(row?.username).toBe("display-label-subject");
		expect(row?.username.startsWith("sso:")).toBe(false);
	});
});
