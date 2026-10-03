/**
 * Host ownership in team mode: an admin can hand a host to a user (or take its
 * owner away); rotating and revoking a host is for its owner or an admin, an
 * unowned host for an admin, and solo is unchanged; the owner gates those two
 * operations only, never who may launch on the host; and revoking a host is
 * one transaction (the host and its credential change together or not at all).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { supervisorCredentials, supervisorEnrollmentTokens, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
const { _setRevokeHostStepHookForTest } = await import("../services/supervisor-registry.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	_setRevokeHostStepHookForTest(null);
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(supervisorEnrollmentTokens);
	await getDb().delete(supervisorCredentials);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

interface World {
	admin: { id: string; cookie: Headers };
	owner: { id: string; cookie: Headers };
	other: { id: string; cookie: Headers };
	adminKey: Headers;
	listed: Headers;
	ownedHost: string;
	unownedHost: string;
}

const CAPABILITIES = {
	version: 1,
	agentTypes: ["claude_code"],
	launchModes: ["headless"],
	os: "linux",
	terminalSupport: [],
	features: [],
	executables: {
		claude: { available: true, command: "claude", resolvedPath: "/usr/bin/claude", source: "auto" },
	},
};

async function seedHost(label: string, ownerUserId: string | null): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `st-${label}`,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: CAPABILITIES,
			trustedRoots: ["/tmp"],
			status: "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			createdAt: now,
			updatedAt: now,
			ownerUserId,
		});
	await createSupervisorCredential(id, `st-${label}-credential`);
	return id;
}

async function world(): Promise<World> {
	const admin = await seedLocalUser("st-admin", "admin");
	const owner = await seedLocalUser("st-owner");
	const other = await seedLocalUser("st-other");
	const adminKey = await seedKey("st-admin-key", ["manage"], admin.id);
	const listed = await seedKey("st-listed", ["manage"]);
	await setAdminServiceKeyList([listed.id]);
	return {
		admin: { id: admin.id, cookie: await cookieHeadersFor(admin.id) },
		owner: { id: owner.id, cookie: await cookieHeadersFor(owner.id) },
		other: { id: other.id, cookie: await cookieHeadersFor(other.id) },
		adminKey: bearerHeaders(adminKey.key),
		listed: bearerHeaders(listed.key),
		ownedHost: await seedHost("owned", owner.id),
		unownedHost: await seedHost("unowned", null),
	};
}

async function hostRow(id: string) {
	const [row] = await getDb().select().from(supervisors).where(eq(supervisors.id, id));
	return row;
}
async function credentialActive(id: string) {
	const [row] = await getDb()
		.select()
		.from(supervisorCredentials)
		.where(eq(supervisorCredentials.supervisorId, id));
	return row?.isActive;
}

async function errorCode(res: Response): Promise<string | undefined> {
	return ((await res.json().catch(() => ({}))) as { error?: string }).error;
}
const patch = (id: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1/admin/supervisors/${id}`, jsonRequest("PATCH", body, headers));
const rotate = (id: string, headers: Headers) =>
	app.request(`/api/v1/admin/supervisors/${id}/rotate`, jsonRequest("POST", {}, headers));
const revoke = (id: string, headers: Headers) =>
	app.request(`/api/v1/admin/supervisors/${id}/revoke`, jsonRequest("POST", {}, headers));
async function tokenCount() {
	return (await getDb().select().from(supervisorEnrollmentTokens)).length;
}

describe("PATCH /admin/supervisors/:id", () => {
	test("an admin hands a host to a user, or takes its owner away; an admin-owned key may too", async () => {
		const w = await world();
		const res = await patch(w.unownedHost, { ownerUserId: w.owner.id }, w.admin.cookie);
		expect(res.status).toBe(200);
		expect((await hostRow(w.unownedHost))?.ownerUserId).toBe(w.owner.id);
		expect((await patch(w.unownedHost, { ownerUserId: null }, w.adminKey)).status).toBe(200);
		expect((await hostRow(w.unownedHost))?.ownerUserId).toBeNull();
		expect((await patch(w.unownedHost, { ownerUserId: w.other.id }, w.listed)).status).toBe(200);
	});

	test("a member is refused and nothing is written", async () => {
		await setStoredMode("team");
		const w = await world();
		const res = await patch(w.ownedHost, { ownerUserId: w.other.id }, w.other.cookie);
		expect(res.status).toBe(403);
		expect((await hostRow(w.ownedHost))?.ownerUserId).toBe(w.owner.id);
	});

	test("an unknown host is 404, an unknown user 404, a disabled one 409, a bad body 400", async () => {
		const w = await world();
		await disableUserDirectly(w.other.id);
		expect((await patch("nope", { ownerUserId: null }, w.admin.cookie)).status).toBe(404);
		const unknown = await patch(w.unownedHost, { ownerUserId: "nope" }, w.admin.cookie);
		expect(unknown.status).toBe(404);
		expect(await errorCode(unknown)).toBe("user_not_found");
		const disabled = await patch(w.unownedHost, { ownerUserId: w.other.id }, w.admin.cookie);
		expect(disabled.status).toBe(409);
		expect(await errorCode(disabled)).toBe("user_disabled");
		expect((await patch(w.unownedHost, {}, w.admin.cookie)).status).toBe(400);
		expect((await patch(w.unownedHost, { ownerUserId: 7 }, w.admin.cookie)).status).toBe(400);
		expect((await hostRow(w.unownedHost))?.ownerUserId).toBeNull();
	});

	test("a foreign Origin is refused, and the change is logged against the acting admin", async () => {
		const w = await world();
		const foreign = new Headers(w.admin.cookie);
		foreign.set("Origin", "https://evil.example.test");
		const refused = await patch(w.unownedHost, { ownerUserId: w.owner.id }, foreign);
		expect(refused.status).toBe(403);
		expect(await errorCode(refused)).toBe("bad_origin");

		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		try {
			await patch(w.unownedHost, { ownerUserId: w.owner.id }, w.admin.cookie);
		} finally {
			spy.mockRestore();
		}
		const audit = lines
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.find((line) => line?.kind === "supervisor_owner_changed");
		expect(audit?.by).toBe(w.admin.id);
		expect(audit?.supervisorId).toBe(w.unownedHost);
		expect(audit?.to).toBe(w.owner.id);
	});
});

describe("rotate and revoke", () => {
	test("solo is unchanged: any manage caller may", async () => {
		const w = await world();
		expect((await rotate(w.ownedHost, w.other.cookie)).status).toBe(201);
		expect((await revoke(w.ownedHost, w.other.cookie)).status).toBe(200);
		expect((await hostRow(w.ownedHost))?.enrollmentState).toBe("revoked");
	});

	test("team: the host's owner and an admin may", async () => {
		await setStoredMode("team");
		const w = await world();
		for (const headers of [w.owner.cookie, w.admin.cookie, w.adminKey, w.listed]) {
			expect({ status: (await rotate(w.ownedHost, headers)).status }).toEqual({ status: 201 });
		}
		expect((await revoke(w.ownedHost, w.owner.cookie)).status).toBe(200);
		expect((await hostRow(w.ownedHost))?.enrollmentState).toBe("revoked");
	});

	test("team: another member may not: 403 not_owner, no token minted, the host untouched", async () => {
		await setStoredMode("team");
		const w = await world();
		const before = await tokenCount();
		const rotated = await rotate(w.ownedHost, w.other.cookie);
		expect(rotated.status).toBe(403);
		expect(await rotated.json()).toEqual({ error: "not_owner" });
		expect(await tokenCount()).toBe(before);

		const revoked = await revoke(w.ownedHost, w.other.cookie);
		expect(revoked.status).toBe(403);
		expect(await revoked.json()).toEqual({ error: "not_owner" });
		expect((await hostRow(w.ownedHost))?.enrollmentState).toBe("active");
		expect(await credentialActive(w.ownedHost)).toBe(true);
	});

	test("team: an unowned host is an admin's", async () => {
		await setStoredMode("team");
		const w = await world();
		expect((await rotate(w.unownedHost, w.owner.cookie)).status).toBe(403);
		expect((await revoke(w.unownedHost, w.owner.cookie)).status).toBe(403);
		expect((await rotate(w.unownedHost, w.admin.cookie)).status).toBe(201);
		expect((await revoke(w.unownedHost, w.admin.cookie)).status).toBe(200);
	});

	test("an unknown host answers as it always has, in either mode", async () => {
		const w = await world();
		expect((await rotate("nope", w.admin.cookie)).status).toBe(404);
		expect((await revoke("nope", w.admin.cookie)).status).toBe(200);
		await setStoredMode("team");
		expect((await rotate("nope", w.owner.cookie)).status).toBe(404);
		expect((await revoke("nope", w.owner.cookie)).status).toBe(200);
	});

	test("revoke is one transaction: a credential revoke that fails leaves the host active, not half revoked", async () => {
		const w = await world();
		const authModule = await import("../auth/supervisor-auth.js");
		const failing = spyOn(authModule, "revokeSupervisorCredential").mockImplementation(async () => {
			throw new Error("credential store unavailable");
		});
		try {
			const res = await revoke(w.ownedHost, w.admin.cookie);
			expect(res.status).toBe(500);
		} finally {
			failing.mockRestore();
		}
		expect((await hostRow(w.ownedHost))?.enrollmentState).toBe("active");
		expect(await credentialActive(w.ownedHost)).toBe(true);
	});

	test("revoke is one transaction: a failure after the host is marked revoked leaves host and credential untouched", async () => {
		const w = await world();
		_setRevokeHostStepHookForTest(async (step) => {
			if (step === "host-revoked") throw new Error("injected failure");
		});
		const res = await revoke(w.ownedHost, w.admin.cookie);
		expect(res.status).toBe(500);
		expect((await hostRow(w.ownedHost))?.enrollmentState).toBe("active");
		expect(await credentialActive(w.ownedHost)).toBe(true);

		_setRevokeHostStepHookForTest(null);
		expect((await revoke(w.ownedHost, w.admin.cookie)).status).toBe(200);
		expect((await hostRow(w.ownedHost))?.enrollmentState).toBe("revoked");
		expect(await credentialActive(w.ownedHost)).toBe(false);
	});
});

describe("host ownership gates rotate and revoke, never who may launch on the host", () => {
	test("a member who neither owns the host nor is an admin launches on it and is refused rotate and revoke", async () => {
		await setStoredMode("team");
		const w = await world();
		const fixtureId = crypto.randomUUID();
		const cwd = `/tmp/host-owner-launch-${fixtureId}`;
		const launch = await app.request(
			"/api/v1/launches",
			jsonRequest(
				"POST",
				{
					template: { name: `host-owner-${fixtureId}`, agentType: "claude_code", cwd },
					requestedSupervisorId: w.ownedHost,
					requestedLaunchMode: "headless",
					launchSpec: {
						version: 1,
						launchCorrelationId: crypto.randomUUID(),
						managedMode: "unmanaged_preview",
						agentType: "claude_code",
						cwd,
						model: null,
						approvalPolicy: null,
						sandboxMode: null,
						baseInstructions: "",
						taskPrompt: "",
						env: {},
						providerConfig: { command: "claude", cliArgs: [], instructionsFile: "CLAUDE.md" },
					},
				},
				w.other.cookie,
			),
		);
		expect(launch.status).toBe(201);
		expect((await rotate(w.ownedHost, w.other.cookie)).status).toBe(403);
		expect((await revoke(w.ownedHost, w.other.cookie)).status).toBe(403);
	});
});
