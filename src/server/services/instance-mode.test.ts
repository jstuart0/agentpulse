/**
 * Instance mode (solo/team): env precedence over the stored setting, the
 * boot refusals for an unsafe combination, the mode switch (admin-only,
 * re-enumerating service keys inside the lock, all-or-nothing), and the two
 * boot-time warnings (unlisted admin service keys in an env-locked team
 * install; admins whose identity could transfer to whoever the identity
 * provider next gives the same username to).
 *
 * The identity state, the mode env, the bootstrap env and DISABLE_AUTH are
 * reset before AND after every test, so no test depends on what another left.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb, getSqlite } = await import("../db/client.js");
const { config } = await import("../config.js");
const { users, apiKeys, settings, supervisorEnrollmentTokens } = await import(
	"../db/schema/index.js"
);
const { createUser } = await import("./local-auth-service.js");
const { createApiKey } = await import("../auth/api-key.js");
const { resolveSsoUser } = await import("./user-identity.js");
const {
	getMode,
	assertBootable,
	setMode,
	ModeLockedByEnvError,
	ServiceKeysUndecidedError,
	TeamRequiresAuthError,
	HumanAdminRequiredError,
	InvalidServiceKeyDecisionError,
	warnAboutUnlistedAdminServiceKeysAtBoot,
	warnAboutRiskySubjectSourceAdmins,
	_setModeSwitchStepHookForTest,
} = await import("./instance-mode.js");

const MODE_ENV = "AGENTPULSE_MODE";
const SUBJECTS_ENV = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
const MODE_KEY = "instance.mode";
const LIST_KEY = "instance.adminServiceKeyIds";
const PASSWORD = "a-very-long-password-123";

const originalDisableAuth = config.disableAuth;
const originalBootstrapUser = config.localAdminUsername;
const originalBootstrapPassword = config.localAdminPassword;
const originalModeEnv = process.env[MODE_ENV];
const originalSubjectsEnv = process.env[SUBJECTS_ENV];

function restoreProcessState() {
	if (originalModeEnv === undefined) delete process.env[MODE_ENV];
	else process.env[MODE_ENV] = originalModeEnv;
	if (originalSubjectsEnv === undefined) delete process.env[SUBJECTS_ENV];
	else process.env[SUBJECTS_ENV] = originalSubjectsEnv;
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(config as Record<string, unknown>).localAdminUsername = originalBootstrapUser;
	(config as Record<string, unknown>).localAdminPassword = originalBootstrapPassword;
	_setModeSwitchStepHookForTest(null);
}

async function cleanSlate() {
	restoreProcessState();
	(config as Record<string, unknown>).disableAuth = false;
	(config as Record<string, unknown>).localAdminUsername = "";
	(config as Record<string, unknown>).localAdminPassword = "";
	delete process.env[MODE_ENV];
	delete process.env[SUBJECTS_ENV];
	await resetIdentityState();
}

beforeAll(async () => {
	await initializeDatabase();
});
beforeEach(cleanSlate);
afterEach(async () => {
	await resetIdentityState();
	restoreProcessState();
});

function uniqueName(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

const seedAdmin = (label = "mode-admin") =>
	createUser({ username: uniqueName(label), password: PASSWORD, role: "admin" });
const seedMember = (label = "mode-member") =>
	createUser({ username: uniqueName(label), password: PASSWORD, role: "user" });
const humanActor = (userId: string) => ({ userId, label: "user" as const });

/** Writes the stored (non-env) mode setting directly. */
async function storeMode(value: unknown) {
	await getDb()
		.insert(settings)
		.values({ key: MODE_KEY, value, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function storeAdminKeyList(ids: string[]) {
	await getDb()
		.insert(settings)
		.values({ key: LIST_KEY, value: ids, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({ target: settings.key, set: { value: ids } });
}

async function settingValue(key: string): Promise<unknown> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key)).limit(1);
	return row?.value;
}

async function keyRow(id: string) {
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
	return row;
}

/** Every mode-relevant fact in one value, to assert "nothing changed" with one comparison. */
async function instanceState(keyIds: string[]) {
	const keys = await Promise.all(keyIds.map(keyRow));
	return {
		storedMode: await settingValue(MODE_KEY),
		keyList: await settingValue(LIST_KEY),
		keys: keys.map((k) => ({ id: k?.id, active: k?.isActive, owner: k?.ownerUserId })),
	};
}

async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return lines;
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
	}
	return lines;
}

describe("getMode — precedence and freshness", () => {
	test("defaults to solo with nothing set", async () => {
		expect(await getMode()).toBe("solo");
	});

	test("the stored setting is honored when no env is set", async () => {
		await storeMode("team");
		expect(await getMode()).toBe("team");
	});

	test("the env wins over the stored setting, in both directions", async () => {
		await storeMode("solo");
		process.env[MODE_ENV] = "team";
		expect(await getMode()).toBe("team");

		await storeMode("team");
		process.env[MODE_ENV] = "solo";
		expect(await getMode()).toBe("solo");
	});

	test("the env value is trimmed and case-insensitive", async () => {
		process.env[MODE_ENV] = "  TEAM ";
		expect(await getMode()).toBe("team");
	});

	test("an unrecognised stored value is solo", async () => {
		await storeMode("everyone");
		expect(await getMode()).toBe("solo");
	});

	test("nothing is cached: a change to the stored setting is seen by the very next call", async () => {
		expect(await getMode()).toBe("solo");
		await storeMode("team");
		expect(await getMode()).toBe("team");
		await storeMode("solo");
		expect(await getMode()).toBe("solo");
	});
});

describe("assertBootable — what refuses to start", () => {
	const bootstrapEnv = (username: string, password: string) => {
		(config as Record<string, unknown>).localAdminUsername = username;
		(config as Record<string, unknown>).localAdminPassword = password;
	};

	test("team under DISABLE_AUTH is refused; the message names AGENTPULSE_MODE=solo", async () => {
		process.env[MODE_ENV] = "team";
		(config as Record<string, unknown>).disableAuth = true;
		await expect(assertBootable()).rejects.toThrow(/AGENTPULSE_MODE=solo/);
	});

	test("a stored team mode under DISABLE_AUTH is refused too", async () => {
		await storeMode("team");
		(config as Record<string, unknown>).disableAuth = true;
		await expect(assertBootable()).rejects.toThrow(/AGENTPULSE_MODE=solo/);
	});

	test("env-locked team with no admin source is refused, and the message names AGENTPULSE_MODE=solo before any other setting", async () => {
		process.env[MODE_ENV] = "team";
		let message = "";
		try {
			await assertBootable();
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/AGENTPULSE_MODE=solo/);
		const soloAt = message.indexOf("AGENTPULSE_MODE=solo");
		for (const other of ["AGENTPULSE_LOCAL_ADMIN", "AGENTPULSE_ADMIN_SSO_SUBJECTS"]) {
			const otherAt = message.indexOf(other);
			if (otherAt !== -1) expect(soloAt).toBeLessThan(otherAt);
		}
	});

	test("the bootstrap env counts as an admin source", async () => {
		process.env[MODE_ENV] = "team";
		bootstrapEnv("boot-admin", PASSWORD);
		await expect(assertBootable()).resolves.toBeUndefined();
	});

	test("a bootstrap username with an empty password doesn't count; neither does a password with no username", async () => {
		process.env[MODE_ENV] = "team";
		bootstrapEnv("boot-admin", "");
		await expect(assertBootable()).rejects.toThrow(/AGENTPULSE_MODE=solo/);
		bootstrapEnv("", PASSWORD);
		await expect(assertBootable()).rejects.toThrow(/AGENTPULSE_MODE=solo/);
	});

	test("an active local admin row counts", async () => {
		process.env[MODE_ENV] = "team";
		await seedAdmin();
		await expect(assertBootable()).resolves.toBeUndefined();
	});

	test("an active SSO admin row counts too: a removed subject doesn't demote, so that admin is still there", async () => {
		process.env[MODE_ENV] = "team";
		const sso = await resolveSsoUser({
			provider: "authentik",
			subject: uniqueName("sso-admin"),
			source: "uid",
			username: "ssoadmin",
		});
		await getDb().update(users).set({ role: "admin" }).where(eq(users.id, sso.id));
		await expect(assertBootable()).resolves.toBeUndefined();
	});

	test("a disabled-only admin doesn't count, and neither does an active member", async () => {
		process.env[MODE_ENV] = "team";
		const admin = await seedAdmin();
		await seedMember();
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, admin.id));
		await expect(assertBootable()).rejects.toThrow(/AGENTPULSE_MODE=solo/);
	});

	test("a non-empty AGENTPULSE_ADMIN_SSO_SUBJECTS counts; a blank one doesn't", async () => {
		process.env[MODE_ENV] = "team";
		process.env[SUBJECTS_ENV] = " , ";
		await expect(assertBootable()).rejects.toThrow(/AGENTPULSE_MODE=solo/);
		process.env[SUBJECTS_ENV] = "uid-1";
		await expect(assertBootable()).resolves.toBeUndefined();
	});

	test("a stored team mode (not env-locked) with no admin source still boots: the switch needed an admin, and the last one can't be removed", async () => {
		await storeMode("team");
		await expect(assertBootable()).resolves.toBeUndefined();
	});

	test("solo always boots: under DISABLE_AUTH, with garbage stored, with no admins", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		await storeMode("garbage");
		await expect(assertBootable()).resolves.toBeUndefined();
	});

	test("an AGENTPULSE_MODE that is set but not solo/team refuses boot, naming both valid values", async () => {
		for (const bad of ["teem", "multi", "1", "solo,team"]) {
			process.env[MODE_ENV] = bad;
			let message = "";
			try {
				await assertBootable();
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).toContain("solo");
			expect(message).toContain("team");
			expect(message).toContain(bad);
		}
	});

	test("a blank AGENTPULSE_MODE is the same as unset", async () => {
		process.env[MODE_ENV] = "   ";
		await expect(assertBootable()).resolves.toBeUndefined();
	});
});

describe("setMode — who may switch, and when", () => {
	test("is refused while the mode is locked by env, whichever mode is asked for", async () => {
		const admin = await seedAdmin();
		for (const [env, asked] of [
			["solo", "team"],
			["team", "team"],
			["team", "solo"],
		] as const) {
			process.env[MODE_ENV] = env;
			await expect(
				setMode({ mode: asked, serviceKeyDecisions: [] }, humanActor(admin.id)),
			).rejects.toBeInstanceOf(ModeLockedByEnvError);
		}
		expect(await settingValue(MODE_KEY)).toBeUndefined();
	});

	test("refuses team under DISABLE_AUTH", async () => {
		const admin = await seedAdmin();
		(config as Record<string, unknown>).disableAuth = true;
		await expect(
			setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id)),
		).rejects.toBeInstanceOf(TeamRequiresAuthError);
		expect(await settingValue(MODE_KEY)).toBeUndefined();
	});

	test("refuses an actor that isn't a human admin, and writes nothing", async () => {
		const admin = await seedAdmin();
		const member = await seedMember();
		const disabledAdmin = await seedAdmin("disabled-admin");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, disabledAdmin.id));
		const { id: keyId } = await createApiKey(uniqueName("service"), ["manage"]);
		const refused = [
			{ userId: null, label: "system" as const },
			{ userId: null, label: "anonymous" as const },
			{ userId: null, label: "api_key" as const },
			// An admin's own key: still a key, never a human.
			{ userId: admin.id, label: "api_key" as const },
			humanActor(member.id),
			humanActor(disabledAdmin.id),
			humanActor(crypto.randomUUID()),
		];

		for (const actor of refused) {
			await expect(
				setMode({ mode: "team", serviceKeyDecisions: [{ keyId, decision: "keep" }] }, actor),
			).rejects.toBeInstanceOf(HumanAdminRequiredError);
		}

		expect(await instanceState([keyId])).toEqual({
			storedMode: undefined,
			keyList: undefined,
			keys: [{ id: keyId, active: true, owner: null }],
		});
	});

	test("switching to the mode already stored changes nothing and reports it", async () => {
		const admin = await seedAdmin();
		await storeMode("team");

		const result = await setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id));

		expect(result).toEqual({ mode: "team", changed: false });
		const solo = await setMode({ mode: "solo", serviceKeyDecisions: [] }, humanActor(admin.id));
		expect(solo).toEqual({ mode: "solo", changed: true });
		expect(await setMode({ mode: "solo", serviceKeyDecisions: [] }, humanActor(admin.id))).toEqual({
			mode: "solo",
			changed: false,
		});
	});
});

describe("setMode — solo to team and the service-key decisions", () => {
	test("keep, assign and revoke commit together with the mode; the very next getMode sees team", async () => {
		const admin = await seedAdmin();
		const target = await seedMember("assign-target");
		const { id: keepId } = await createApiKey(uniqueName("keep-key"), ["manage"]);
		const { id: assignId } = await createApiKey(uniqueName("assign-key"), ["manage"]);
		const { id: revokeId } = await createApiKey(uniqueName("revoke-key"), ["manage"]);

		const result = await setMode(
			{
				mode: "team",
				serviceKeyDecisions: [
					{ keyId: keepId, decision: "keep" },
					{ keyId: assignId, decision: "assign", userId: target.id },
					{ keyId: revokeId, decision: "revoke" },
				],
			},
			humanActor(admin.id),
		);

		expect(result).toEqual({ mode: "team", changed: true });
		expect(await getMode()).toBe("team");
		expect(await settingValue(MODE_KEY)).toBe("team");
		expect(await settingValue(LIST_KEY)).toEqual([keepId]);
		expect(await keyRow(keepId)).toMatchObject({ isActive: true, ownerUserId: null });
		expect(await keyRow(assignId)).toMatchObject({ isActive: true, ownerUserId: target.id });
		expect(await keyRow(revokeId)).toMatchObject({ isActive: false, ownerUserId: null });
	});

	test("with no ownerless manage keys the switch needs no decisions", async () => {
		const admin = await seedAdmin();
		const owned = await seedMember();
		await createApiKey(uniqueName("owned-manage"), ["manage"], owned.id);
		await createApiKey(uniqueName("ingest-only"), ["ingest"]);

		const result = await setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id));

		expect(result.changed).toBe(true);
		expect(await getMode()).toBe("team");
	});

	test("an undecided ownerless manage key (and a wildcard one) refuses the switch, listing exactly those keys", async () => {
		const admin = await seedAdmin();
		const { id: manageId } = await createApiKey(uniqueName("manage"), ["manage"]);
		const { id: wildcardId } = await createApiKey(uniqueName("wild"), ["ingest"]);
		await getDb().update(apiKeys).set({ scopes: '["*"]' }).where(eq(apiKeys.id, wildcardId));
		const { id: ingestId } = await createApiKey(uniqueName("ingest"), ["ingest"]);
		const { id: observeId } = await createApiKey(uniqueName("observe"), ["observe"]);

		let caught: unknown;
		try {
			await setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id));
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(ServiceKeysUndecidedError);
		const listed = (caught as InstanceType<typeof ServiceKeysUndecidedError>).keys.map((k) => k.id);
		expect([...listed].sort()).toEqual([manageId, wildcardId].sort());
		expect(listed).not.toContain(ingestId);
		expect(listed).not.toContain(observeId);
		expect(await instanceState([manageId, wildcardId])).toEqual({
			storedMode: undefined,
			keyList: undefined,
			keys: [
				{ id: manageId, active: true, owner: null },
				{ id: wildcardId, active: true, owner: null },
			],
		});
	});

	test("a key minted between lock acquisition and the enumeration is caught: the switch fails, nothing is written", async () => {
		const admin = await seedAdmin();
		const { id: knownKeyId } = await createApiKey(uniqueName("known-manage"), ["manage"]);
		let raceKeyId = "";
		// Fires inside the lock, before the server looks at which keys exist. An
		// implementation that enumerated before taking the lock would have
		// already decided and would commit without ever seeing this key.
		_setModeSwitchStepHookForTest(async (step) => {
			if (step !== "lock-acquired") return;
			raceKeyId = (await createApiKey(uniqueName("race-manage"), ["manage"])).id;
		});

		let caught: unknown;
		try {
			await setMode(
				{ mode: "team", serviceKeyDecisions: [{ keyId: knownKeyId, decision: "keep" }] },
				humanActor(admin.id),
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(ServiceKeysUndecidedError);
		expect(
			(caught as InstanceType<typeof ServiceKeysUndecidedError>).keys.map((k) => k.id),
		).toEqual([raceKeyId]);
		expect(await getMode()).toBe("solo");
		expect(await instanceState([knownKeyId])).toEqual({
			storedMode: undefined,
			keyList: undefined,
			keys: [{ id: knownKeyId, active: true, owner: null }],
		});
	});

	test("with the same hook minting a key that needs no decision, the switch succeeds (positive control)", async () => {
		const admin = await seedAdmin();
		const { id: knownKeyId } = await createApiKey(uniqueName("known-manage"), ["manage"]);
		let mintedId = "";
		_setModeSwitchStepHookForTest(async (step) => {
			if (step !== "lock-acquired") return;
			mintedId = (await createApiKey(uniqueName("late-ingest"), ["ingest"])).id; // not a manage key
		});

		await setMode(
			{ mode: "team", serviceKeyDecisions: [{ keyId: knownKeyId, decision: "keep" }] },
			humanActor(admin.id),
		);

		expect(await getMode()).toBe("team");
		expect(mintedId).not.toBe("");
	});

	test("a decision naming a key that isn't an active, ownerless manage key is rejected before anything is written", async () => {
		const admin = await seedAdmin();
		const victim = await seedMember("victim");
		const { id: ownedManageId } = await createApiKey(
			uniqueName("victims-key"),
			["manage"],
			victim.id,
		);
		const { id: ingestOnlyId } = await createApiKey(uniqueName("ingest-only"), ["ingest"]);
		const { id: inactiveId } = await createApiKey(uniqueName("inactive-manage"), ["manage"]);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, inactiveId));
		const { id: realId } = await createApiKey(uniqueName("real-service-key"), ["manage"]);
		const watched = [ownedManageId, ingestOnlyId, inactiveId, realId];
		const before = await instanceState(watched);

		const attacks = [
			// Someone else's key: revoking it would lock the victim out, assigning it would take it over.
			{ keyId: ownedManageId, decision: "revoke" as const },
			{ keyId: ownedManageId, decision: "assign" as const, userId: admin.id },
			{ keyId: ownedManageId, decision: "keep" as const },
			{ keyId: ingestOnlyId, decision: "revoke" as const },
			{ keyId: inactiveId, decision: "keep" as const },
			{ keyId: crypto.randomUUID(), decision: "keep" as const },
		];
		for (const attack of attacks) {
			await expect(
				setMode(
					{
						mode: "team",
						// A valid decision for the real key alongside the bad one: the bad one must sink the whole switch.
						serviceKeyDecisions: [{ keyId: realId, decision: "keep" }, attack],
					},
					humanActor(admin.id),
				),
			).rejects.toBeInstanceOf(InvalidServiceKeyDecisionError);
			expect(await instanceState(watched)).toEqual(before);
			expect(await getMode()).toBe("solo");
		}
	});

	test("duplicate decisions for one key are rejected, nothing written", async () => {
		const admin = await seedAdmin();
		const { id } = await createApiKey(uniqueName("dup"), ["manage"]);
		const before = await instanceState([id]);

		await expect(
			setMode(
				{
					mode: "team",
					serviceKeyDecisions: [
						{ keyId: id, decision: "keep" },
						{ keyId: id, decision: "revoke" },
					],
				},
				humanActor(admin.id),
			),
		).rejects.toBeInstanceOf(InvalidServiceKeyDecisionError);

		expect(await instanceState([id])).toEqual(before);
	});

	test("assign needs a user that exists and is enabled", async () => {
		const admin = await seedAdmin();
		const disabled = await seedMember("disabled-target");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, disabled.id));
		const { id } = await createApiKey(uniqueName("assign-bad"), ["manage"]);
		const before = await instanceState([id]);

		for (const decision of [
			{ keyId: id, decision: "assign" as const },
			{ keyId: id, decision: "assign" as const, userId: crypto.randomUUID() },
			{ keyId: id, decision: "assign" as const, userId: disabled.id },
		]) {
			await expect(
				setMode({ mode: "team", serviceKeyDecisions: [decision] }, humanActor(admin.id)),
			).rejects.toBeInstanceOf(InvalidServiceKeyDecisionError);
			expect(await instanceState([id])).toEqual(before);
		}
	});

	test("a failure injected at any step of the switch leaves the mode, the keys and the list exactly as they were", async () => {
		const admin = await seedAdmin();
		const target = await seedMember();
		const { id: keepId } = await createApiKey(uniqueName("keep"), ["manage"]);
		const { id: assignId } = await createApiKey(uniqueName("assign"), ["manage"]);
		const { id: revokeId } = await createApiKey(uniqueName("revoke"), ["manage"]);
		const watched = [keepId, assignId, revokeId];
		const decisions = [
			{ keyId: keepId, decision: "keep" as const },
			{ keyId: assignId, decision: "assign" as const, userId: target.id },
			{ keyId: revokeId, decision: "revoke" as const },
		];
		const before = await instanceState(watched);

		for (const failAt of ["lock-acquired", "decisions-applied", "mode-written"] as const) {
			_setModeSwitchStepHookForTest(async (step) => {
				if (step === failAt) throw new Error(`injected failure at ${failAt}`);
			});
			await expect(
				setMode({ mode: "team", serviceKeyDecisions: decisions }, humanActor(admin.id)),
			).rejects.toThrow(`injected failure at ${failAt}`);
			expect(await instanceState(watched)).toEqual(before);
			expect(await getMode()).toBe("solo");
		}

		// Positive control: the same call without the failure applies all of it.
		_setModeSwitchStepHookForTest(null);
		await setMode({ mode: "team", serviceKeyDecisions: decisions }, humanActor(admin.id));
		expect(await getMode()).toBe("team");
		expect((await keyRow(revokeId))?.isActive).toBe(false);
	});

	test("two concurrent switches to team: one switches, the other finds it already done; the list holds the key once", async () => {
		const admin = await seedAdmin();
		const { id: keyId } = await createApiKey(uniqueName("concurrent"), ["manage"]);
		const input = {
			mode: "team" as const,
			serviceKeyDecisions: [{ keyId, decision: "keep" as const }],
		};

		const results = await Promise.all([
			setMode(input, humanActor(admin.id)),
			setMode(input, humanActor(admin.id)),
		]);

		expect(results.filter((r) => r.changed).length).toBe(1);
		expect(results.every((r) => r.mode === "team")).toBe(true);
		expect(await settingValue(LIST_KEY)).toEqual([keyId]);
	});

	test("two concurrent opposite switches are serialized: both complete and the stored mode is a clean solo or team", async () => {
		const admin = await seedAdmin();
		await storeMode("team");

		const results = await Promise.allSettled([
			setMode({ mode: "solo", serviceKeyDecisions: [] }, humanActor(admin.id)),
			setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id)),
		]);

		expect(results.every((r) => r.status === "fulfilled")).toBe(true);
		expect(["solo", "team"]).toContain(await getMode());
		expect(["solo", "team"]).toContain((await settingValue(MODE_KEY)) as string);
	});

	describeSqliteOnly("with an unrelated transaction open on the shared connection", () => {
		test("the switch retries until it can begin, then succeeds", async () => {
			const admin = await seedAdmin();
			const sqlite = getSqlite();
			sqlite.exec("BEGIN IMMEDIATE");
			const originalExec = sqlite.exec.bind(sqlite);
			let attempts = 0;
			let outsiderCommitted = false;
			// biome-ignore lint/suspicious/noExplicitAny: test spy on a native binding
			(sqlite as any).exec = (...args: unknown[]) => {
				if (args[0] === "BEGIN IMMEDIATE") {
					attempts++;
					if (attempts === 3 && !outsiderCommitted) {
						outsiderCommitted = true;
						originalExec("COMMIT");
					}
				}
				return originalExec(...(args as [string]));
			};
			try {
				const result = await setMode(
					{ mode: "team", serviceKeyDecisions: [] },
					humanActor(admin.id),
				);
				expect(result).toEqual({ mode: "team", changed: true });
				expect(attempts).toBe(3);
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: restore the native binding
				(sqlite as any).exec = originalExec;
				if (!outsiderCommitted) originalExec("COMMIT");
			}
		});
	});
});

describe("setMode — team to solo", () => {
	test("a human admin can switch back; the kept-key list is cleared so a later switch asks again", async () => {
		const admin = await seedAdmin();
		const { id: keyId } = await createApiKey(uniqueName("kept"), ["manage"]);
		await setMode(
			{ mode: "team", serviceKeyDecisions: [{ keyId, decision: "keep" }] },
			humanActor(admin.id),
		);
		expect(await settingValue(LIST_KEY)).toEqual([keyId]);

		const back = await setMode({ mode: "solo", serviceKeyDecisions: [] }, humanActor(admin.id));

		expect(back).toEqual({ mode: "solo", changed: true });
		expect(await getMode()).toBe("solo");
		expect(await settingValue(LIST_KEY)).toEqual([]);
		expect((await keyRow(keyId))?.isActive).toBe(true);
		await expect(
			setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id)),
		).rejects.toBeInstanceOf(ServiceKeysUndecidedError);
	});

	test("decisions make no sense on the way back to solo and are rejected", async () => {
		const admin = await seedAdmin();
		const { id: keyId } = await createApiKey(uniqueName("kept"), ["manage"]);
		await storeMode("team");

		await expect(
			setMode(
				{ mode: "solo", serviceKeyDecisions: [{ keyId, decision: "revoke" }] },
				humanActor(admin.id),
			),
		).rejects.toBeInstanceOf(InvalidServiceKeyDecisionError);
		expect(await getMode()).toBe("team");
		expect((await keyRow(keyId))?.isActive).toBe(true);
	});

	test("only a human admin may switch back", async () => {
		const member = await seedMember();
		await storeMode("team");

		await expect(
			setMode({ mode: "solo", serviceKeyDecisions: [] }, humanActor(member.id)),
		).rejects.toBeInstanceOf(HumanAdminRequiredError);
		expect(await getMode()).toBe("team");
	});
});

describe("setMode — the audit line", () => {
	test("a successful switch logs who did it and what it did; a refused or no-op switch logs nothing", async () => {
		const admin = await seedAdmin();
		const member = await seedMember();
		const { id: keepId } = await createApiKey(uniqueName("audit-keep"), ["manage"]);
		const { id: revokeId } = await createApiKey(uniqueName("audit-revoke"), ["manage"]);

		const refusedLogs = await captureLogs(async () => {
			await setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(member.id)).catch(
				() => {},
			);
		});
		const successLogs = await captureLogs(async () => {
			await setMode(
				{
					mode: "team",
					serviceKeyDecisions: [
						{ keyId: keepId, decision: "keep" },
						{ keyId: revokeId, decision: "revoke" },
					],
				},
				humanActor(admin.id),
			);
		});
		const noopLogs = await captureLogs(async () => {
			await setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id));
		});

		expect(refusedLogs.filter((l) => l.includes("instance_mode_changed"))).toEqual([]);
		expect(noopLogs.filter((l) => l.includes("instance_mode_changed"))).toEqual([]);
		const lines = successLogs.filter((l) => l.includes("instance_mode_changed"));
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0] as string)).toMatchObject({
			kind: "instance_mode_changed",
			from: "solo",
			to: "team",
			by: admin.id,
			kept: 1,
			revoked: 1,
			assigned: 0,
		});
	});
});

describe("boot warning — unlisted admin service keys under env-locked team mode", () => {
	test("one warning names every unlisted ownerless manage key by prefix and name", async () => {
		process.env[MODE_ENV] = "team";
		const firstName = uniqueName("unlisted-one");
		const secondName = uniqueName("unlisted-two");
		const first = await createApiKey(firstName, ["manage"]);
		const second = await createApiKey(secondName, ["manage"]);

		const warnings = await captureWarnings(warnAboutUnlistedAdminServiceKeysAtBoot);

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain(first.key.slice(0, 11));
		expect(warnings[0]).toContain(firstName);
		expect(warnings[0]).toContain(second.key.slice(0, 11));
		expect(warnings[0]).toContain(secondName);
	});

	test("no warning for keys that are listed, owned, ingest-only or inactive", async () => {
		process.env[MODE_ENV] = "team";
		const owner = await seedMember();
		const listed = await createApiKey(uniqueName("listed"), ["manage"]);
		await storeAdminKeyList([listed.id]);
		await createApiKey(uniqueName("owned"), ["manage"], owner.id);
		await createApiKey(uniqueName("ingest"), ["ingest"]);
		const inactive = await createApiKey(uniqueName("inactive"), ["manage"]);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, inactive.id));

		expect(await captureWarnings(warnAboutUnlistedAdminServiceKeysAtBoot)).toEqual([]);
	});

	test("no warning unless team mode is locked by env: solo, env solo, and a stored team all stay quiet", async () => {
		await createApiKey(uniqueName("quiet"), ["manage"]);
		expect(await captureWarnings(warnAboutUnlistedAdminServiceKeysAtBoot)).toEqual([]);
		process.env[MODE_ENV] = "solo";
		expect(await captureWarnings(warnAboutUnlistedAdminServiceKeysAtBoot)).toEqual([]);
		delete process.env[MODE_ENV];
		await storeMode("team");
		expect(await captureWarnings(warnAboutUnlistedAdminServiceKeysAtBoot)).toEqual([]);
	});
});

describe("boot warning — admins identified by something that can be reassigned", () => {
	async function ssoAdmin(source: "uid" | "username" | null, subject = uniqueName("sso")) {
		const resolved = await resolveSsoUser({
			provider: "authentik",
			subject,
			source,
			username: `display-${subject}`,
		});
		await getDb().update(users).set({ role: "admin" }).where(eq(users.id, resolved.id));
		return resolved.id;
	}

	test("a single line covers every active admin whose subject source is 'username' or unknown, and never a uid one", async () => {
		const usernameId = await ssoAdmin("username");
		const unknownId = await ssoAdmin(null);
		const uidId = await ssoAdmin("uid");

		const warnings = await captureWarnings(warnAboutRiskySubjectSourceAdmins);

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain(usernameId);
		expect(warnings[0]).toContain(unknownId);
		expect(warnings[0]).not.toContain(uidId);
	});

	test("two risky admins still produce one line", async () => {
		await ssoAdmin("username");
		await ssoAdmin("username");
		expect((await captureWarnings(warnAboutRiskySubjectSourceAdmins)).length).toBe(1);
	});

	test("no warning for a disabled risky admin, a local admin, a risky member, or no admins at all", async () => {
		const disabledId = await ssoAdmin("username");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, disabledId));
		await seedAdmin("local-admin");
		const memberSso = await resolveSsoUser({
			provider: "authentik",
			subject: uniqueName("member-sso"),
			source: "username",
			username: "member",
		});
		expect(memberSso.role).toBe("user");

		expect(await captureWarnings(warnAboutRiskySubjectSourceAdmins)).toEqual([]);
	});
});

describe("the mode setting and the kept-key list are protected settings", () => {
	async function putSetting(key: string, value: unknown) {
		const { app } = await import("../app.js");
		const { key: apiKey } = await createApiKey(uniqueName("settings-writer"), ["manage"]);
		(config as Record<string, unknown>).disableAuth = false;
		return app.request("/api/v1/settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ key, value }),
		});
	}

	test("PUT /settings can't write instance.mode", async () => {
		const res = await putSetting(MODE_KEY, "team");

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "key_not_user_settable", key: MODE_KEY });
		expect(await settingValue(MODE_KEY)).toBeUndefined();
		expect(await getMode()).toBe("solo");
	});

	test("PUT /settings can't write instance.adminServiceKeyIds", async () => {
		const res = await putSetting(LIST_KEY, ["anything"]);

		expect(res.status).toBe(403);
		expect(await settingValue(LIST_KEY)).toBeUndefined();
	});
});

describe("the switch issues every statement on the lock's transaction", () => {
	// On Postgres the injected-failure cases prove this: a statement that left
	// the transaction would survive the rollback. On SQLite the lock hands out
	// the one shared connection, so a statement that ignored the handle would
	// still be rolled back with it and nothing observable differs; this
	// source-level check is what notices it on both dialects.
	test("no statement in the switch section reaches for the pool, and every write passes the transaction", async () => {
		const source = await readFile(new URL("./instance-mode.ts", import.meta.url), "utf8");
		const section = source.slice(
			source.indexOf("// ── The switch"),
			source.indexOf("// ── Test-only seam"),
		);

		expect(section.length).toBeGreaterThan(500);
		expect(section).not.toMatch(/\bgetDb\(/);
		for (const call of section.match(
			/(?:upsertSetting|writeAdminServiceKeyIds|listActiveOwnerlessManageKeys)\([^)]*\)/g,
		) ?? []) {
			expect(call).toMatch(/\btx\b/);
		}
	});
});

describe("the solo to team switch and enrollment tokens with no recorded creator", () => {
	test("unused creatorless tokens are deactivated; creator-recorded, used and revoked ones keep their state", async () => {
		const { createSupervisorEnrollmentToken, verifyEnrollmentToken, consumeEnrollmentToken } =
			await import("../auth/supervisor-auth.js");
		const admin = await seedAdmin();
		const creatorless = await createSupervisorEnrollmentToken("solo-token");
		const hostScoped = await createSupervisorEnrollmentToken("solo-host-token", null, "some-host");
		const withCreator = await createSupervisorEnrollmentToken("owned-token", null, null, admin.id);
		const used = await createSupervisorEnrollmentToken("used-token");
		await consumeEnrollmentToken(used.token);

		await setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id));

		expect(await verifyEnrollmentToken(creatorless.token)).toBeNull();
		expect(await verifyEnrollmentToken(hostScoped.token)).toBeNull();
		expect(await verifyEnrollmentToken(withCreator.token)).not.toBeNull();
		const rows = await getDb().select().from(supervisorEnrollmentTokens);
		const byName = new Map(rows.map((r) => [r.name, r]));
		expect(byName.get("solo-token")?.revokedAt).not.toBeNull();
		expect(byName.get("used-token")?.revokedAt).toBeNull();
	});

	test("a switch that fails leaves the tokens usable", async () => {
		const { createSupervisorEnrollmentToken, verifyEnrollmentToken } = await import(
			"../auth/supervisor-auth.js"
		);
		const admin = await seedAdmin();
		const token = await createSupervisorEnrollmentToken("solo-token");
		_setModeSwitchStepHookForTest(async (step) => {
			if (step === "mode-written") throw new Error("injected failure");
		});

		await expect(
			setMode({ mode: "team", serviceKeyDecisions: [] }, humanActor(admin.id)),
		).rejects.toThrow("injected failure");

		expect(await verifyEnrollmentToken(token.token)).not.toBeNull();
	});

	test("team to solo leaves tokens alone", async () => {
		const { createSupervisorEnrollmentToken, verifyEnrollmentToken } = await import(
			"../auth/supervisor-auth.js"
		);
		const admin = await seedAdmin();
		await storeMode("team");
		const token = await createSupervisorEnrollmentToken("team-era-token");

		await setMode({ mode: "solo", serviceKeyDecisions: [] }, humanActor(admin.id));

		expect(await verifyEnrollmentToken(token.token)).not.toBeNull();
	});
});

describe("the switch's decisions and the plain service-key list", () => {
	test("a revoked or assigned key leaves the plain list; a kept one stays on it", async () => {
		const admin = await seedAdmin();
		const member = await seedMember();
		const revoked = await createApiKey("plain-revoked", ["manage"]);
		const assigned = await createApiKey("plain-assigned", ["manage"]);
		const kept = await createApiKey("plain-kept", ["manage"]);
		await getDb()
			.insert(settings)
			.values({
				key: "instance.serviceKeyIds",
				value: [revoked.id, assigned.id, kept.id],
				updatedAt: new Date().toISOString(),
			});

		await setMode(
			{
				mode: "team",
				serviceKeyDecisions: [
					{ keyId: revoked.id, decision: "revoke" },
					{ keyId: assigned.id, decision: "assign", userId: member.id },
					{ keyId: kept.id, decision: "keep" },
				],
			},
			humanActor(admin.id),
		);

		expect(await settingValue("instance.serviceKeyIds")).toEqual([kept.id]);
	});
});
