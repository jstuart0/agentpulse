/**
 * A host-scoped enrollment token re-keys a host (registering with it re-activates
 * the host, revokes its credential and issues a new one), so in team mode it is
 * minted only for a host that exists, by the host's owner or an admin; a revoked
 * host is re-enrolled by an admin only; and registering re-checks that the
 * token's creator is still allowed. Solo is unchanged.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
	setUserRoleDirectly,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { supervisorCredentials, supervisorEnrollmentTokens, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(supervisorEnrollmentTokens);
	await getDb().delete(supervisorCredentials);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

const CAPABILITIES = {
	version: 1,
	agentTypes: ["claude_code"],
	launchModes: ["headless"],
	os: "linux",
	terminalSupport: [],
	features: [],
};

async function seedHost(
	label: string,
	ownerUserId: string | null,
	enrollmentState: "active" | "revoked" = "active",
): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `es-${label}`,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: CAPABILITIES,
			trustedRoots: ["/tmp"],
			status: enrollmentState === "revoked" ? "offline" : "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			enrollmentState,
			createdAt: now,
			updatedAt: now,
			ownerUserId,
		});
	if (enrollmentState === "active") await createSupervisorCredential(id, `es-${label}-credential`);
	return id;
}

async function world() {
	const admin = await seedLocalUser("es-admin", "admin");
	const owner = await seedLocalUser("es-owner");
	const attacker = await seedLocalUser("es-attacker");
	return {
		admin: { id: admin.id, cookie: await cookieHeadersFor(admin.id) },
		owner: { id: owner.id, cookie: await cookieHeadersFor(owner.id) },
		attacker: { id: attacker.id, cookie: await cookieHeadersFor(attacker.id) },
	};
}

const enroll = (body: unknown, headers: Headers) =>
	app.request("/api/v1/admin/supervisors/enroll", jsonRequest("POST", body, headers));
const rotate = (id: string, headers: Headers) =>
	app.request(`/api/v1/admin/supervisors/${id}/rotate`, jsonRequest("POST", {}, headers));
const register = (enrollmentToken: string, id: string) =>
	app.request(
		"/api/v1/supervisors/register",
		jsonRequest("POST", {
			id,
			enrollmentToken,
			hostName: "attacker-box",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: CAPABILITIES,
			trustedRoots: ["/tmp"],
		}),
	);
async function errorCode(res: Response): Promise<string | undefined> {
	return ((await res.json().catch(() => ({}))) as { error?: string }).error;
}
async function tokenCount() {
	return (await getDb().select().from(supervisorEnrollmentTokens)).length;
}
async function hostRow(id: string) {
	const [row] = await getDb().select().from(supervisors).where(eq(supervisors.id, id));
	return row;
}
async function activeCredentialCount(id: string) {
	const rows = await getDb()
		.select()
		.from(supervisorCredentials)
		.where(eq(supervisorCredentials.supervisorId, id));
	return rows.filter((row) => row.isActive).length;
}

describe("minting a host-scoped enrollment token in team mode", () => {
	test("a member can't mint one for a host that isn't theirs; nothing is written", async () => {
		await setStoredMode("team");
		const w = await world();
		const victim = await seedHost("victim", w.owner.id);

		const res = await enroll({ supervisorId: victim }, w.attacker.cookie);

		expect(res.status).toBe(403);
		expect(await errorCode(res)).toBe("not_owner");
		expect(await tokenCount()).toBe(0);
	});

	test("an unowned host is an admin's: a member is refused", async () => {
		await setStoredMode("team");
		const w = await world();
		const unowned = await seedHost("unowned", null);

		const res = await enroll({ supervisorId: unowned }, w.attacker.cookie);

		expect(res.status).toBe(403);
		expect(await tokenCount()).toBe(0);
	});

	test("a scoped token for a host that doesn't exist is refused with 404", async () => {
		await setStoredMode("team");
		const w = await world();

		const res = await enroll({ supervisorId: crypto.randomUUID() }, w.owner.cookie);

		expect(res.status).toBe(404);
		expect(await tokenCount()).toBe(0);
	});

	test("the host's owner and an admin can mint one", async () => {
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("mine", w.owner.id);

		expect((await enroll({ supervisorId: host }, w.owner.cookie)).status).toBe(201);
		expect((await enroll({ supervisorId: host }, w.admin.cookie)).status).toBe(201);
		expect(await tokenCount()).toBe(2);
	});

	test("an unscoped token is still open to a member", async () => {
		await setStoredMode("team");
		const w = await world();
		expect((await enroll({ name: "new box" }, w.attacker.cookie)).status).toBe(201);
	});

	test("a revoked host is re-enrolled by an admin only, owner or not", async () => {
		await setStoredMode("team");
		const w = await world();
		const revoked = await seedHost("revoked", w.owner.id, "revoked");

		const asOwner = await enroll({ supervisorId: revoked }, w.owner.cookie);
		expect(asOwner.status).toBe(403);
		expect(await errorCode(asOwner)).toBe("admin_required");
		const rotated = await rotate(revoked, w.owner.cookie);
		expect(rotated.status).toBe(403);
		expect(await errorCode(rotated)).toBe("admin_required");
		expect(await tokenCount()).toBe(0);

		expect((await enroll({ supervisorId: revoked }, w.admin.cookie)).status).toBe(201);
	});

	test("an admin-listed service key can mint one for any host; an unlisted key can't", async () => {
		await setStoredMode("team");
		const host = await seedHost("svc", null);
		const listed = await seedKey("es-listed", ["manage"]);
		await setAdminServiceKeyList([listed.id]);
		const unlisted = await seedKey("es-unlisted", ["manage"]);

		expect((await enroll({ supervisorId: host }, bearerHeaders(listed.key))).status).toBe(201);
		expect((await enroll({ supervisorId: host }, bearerHeaders(unlisted.key))).status).toBe(403);
	});

	test("solo is unchanged: any caller mints a scoped token, even for an unknown id", async () => {
		const w = await world();
		const host = await seedHost("solo", w.owner.id);

		expect((await enroll({ supervisorId: host }, w.attacker.cookie)).status).toBe(201);
		expect((await enroll({ supervisorId: crypto.randomUUID() }, w.attacker.cookie)).status).toBe(
			201,
		);
	});
});

describe("registering with a host-scoped token re-checks its creator", () => {
	test("the owner's token works while the owner still owns the host, and re-keys it", async () => {
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("rekey", w.owner.id);
		const { token } = (await (await enroll({ supervisorId: host }, w.owner.cookie)).json()) as {
			token: string;
		};

		const res = await register(token, host);

		expect(res.status).toBe(200);
		expect((await hostRow(host))?.ownerUserId).toBe(w.owner.id);
		expect(await activeCredentialCount(host)).toBe(1);
	});

	test("a token minted before the host changed hands is refused and left unconsumed", async () => {
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("handed", w.owner.id);
		const { token } = (await (await enroll({ supervisorId: host }, w.owner.cookie)).json()) as {
			token: string;
		};
		await getDb()
			.update(supervisors)
			.set({ ownerUserId: w.attacker.id })
			.where(eq(supervisors.id, host));
		const credentialsBefore = await activeCredentialCount(host);

		const res = await register(token, host);

		expect(res.status).toBe(409);
		expect(await activeCredentialCount(host)).toBe(credentialsBefore);
		const [row] = await getDb().select().from(supervisorEnrollmentTokens);
		expect(row?.usedAt ?? null).toBeNull();
	});

	test("a token minted by an admin who has since been demoted is refused", async () => {
		await setStoredMode("team");
		const w = await world();
		const other = await seedLocalUser("es-other-admin", "admin");
		const host = await seedHost("demoted", w.owner.id);
		const { token } = (await (
			await enroll({ supervisorId: host }, await cookieHeadersFor(other.id))
		).json()) as { token: string };
		await setUserRoleDirectly(other.id, "user");

		expect((await register(token, host)).status).toBe(409);
	});

	test("a token minted by the owner before the host was revoked can't re-activate it", async () => {
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("later-revoked", w.owner.id);
		const { token } = (await (await enroll({ supervisorId: host }, w.owner.cookie)).json()) as {
			token: string;
		};
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked", status: "offline" })
			.where(eq(supervisors.id, host));

		expect((await register(token, host)).status).toBe(409);
		expect((await hostRow(host))?.enrollmentState).toBe("revoked");
	});

	test("a token whose creator was disabled after minting is refused and left unconsumed", async () => {
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("creator-disabled", w.owner.id);
		const { token } = (await (await enroll({ supervisorId: host }, w.owner.cookie)).json()) as {
			token: string;
		};
		await disableUserDirectly(w.owner.id);
		const credentialsBefore = await activeCredentialCount(host);

		expect((await register(token, host)).status).toBe(401);

		expect(await activeCredentialCount(host)).toBe(credentialsBefore);
		const [row] = await getDb().select().from(supervisorEnrollmentTokens);
		expect(row?.usedAt ?? null).toBeNull();
	});

	test("a token for a host that was deleted between minting and registering is refused and left unconsumed", async () => {
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("deleted", w.owner.id);
		const { token } = (await (await enroll({ supervisorId: host }, w.owner.cookie)).json()) as {
			token: string;
		};
		await getDb().delete(supervisorCredentials).where(eq(supervisorCredentials.supervisorId, host));
		await getDb().delete(supervisors).where(eq(supervisors.id, host));

		expect((await register(token, host)).status).toBe(409);

		expect(await hostRow(host)).toBeUndefined();
		const [row] = await getDb().select().from(supervisorEnrollmentTokens);
		expect(row?.usedAt ?? null).toBeNull();
	});

	test("solo registration with a scoped token is unchanged", async () => {
		const w = await world();
		const host = await seedHost("solo-reg", w.owner.id);
		const { token } = (await (await enroll({ supervisorId: host }, w.attacker.cookie)).json()) as {
			token: string;
		};

		expect((await register(token, host)).status).toBe(200);
	});
});

describe("isHostTokenCreatorStillAllowed, judged directly", () => {
	// The route's own token check already turns away a disabled creator before
	// this function runs, so the function's own refusals are pinned here.
	test("refuses a creator who is disabled, or who no longer exists, or a host that no longer exists", async () => {
		const { isHostTokenCreatorStillAllowed } = await import("../services/authorization.js");
		await setStoredMode("team");
		const w = await world();
		const host = await seedHost("direct", w.owner.id);

		expect(
			await isHostTokenCreatorStillAllowed({ createdByUserId: w.owner.id, hostId: host }),
		).toBe(true);
		await disableUserDirectly(w.owner.id);
		expect(
			await isHostTokenCreatorStillAllowed({ createdByUserId: w.owner.id, hostId: host }),
		).toBe(false);
		expect(
			await isHostTokenCreatorStillAllowed({ createdByUserId: "no-such-user", hostId: host }),
		).toBe(false);
		expect(
			await isHostTokenCreatorStillAllowed({ createdByUserId: w.admin.id, hostId: "no-such-host" }),
		).toBe(false);
		expect(
			await isHostTokenCreatorStillAllowed({ createdByUserId: w.admin.id, hostId: host }),
		).toBe(true);
	});
});
