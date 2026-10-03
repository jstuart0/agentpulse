/**
 * /instance: what any signed-in caller (even a read-only key) may see about the
 * instance, the mode switch (a human admin, both directions, with every
 * ownerless manage key decided inside the lock) and claiming the sessions
 * nobody owns.
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
const { config } = await import("../config.js");
const { apiKeys, sessions, settings } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

const originalDisableAuth = config.disableAuth;
const MODE_ENV = "AGENTPULSE_MODE";
const originalModeEnv = process.env[MODE_ENV];

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	if (originalModeEnv === undefined) delete process.env[MODE_ENV];
	else process.env[MODE_ENV] = originalModeEnv;
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

async function seedSession(
	sessionId: string,
	owner: string | null,
	ingestKeyId: string | null = null,
) {
	await getDb().insert(sessions).values({
		sessionId,
		agentType: "claude_code",
		status: "completed",
		ownerUserId: owner,
		ingestKeyId,
	});
}

async function ownerOf(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row?.ownerUserId ?? null;
}

async function storedMode() {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, "instance.mode"));
	return row?.value ?? null;
}

const MODE = "/api/v1/instance/mode";
const CLAIM = "/api/v1/instance/claim-unassigned";

describe("GET /instance", () => {
	test("reports the mode, whether the env fixes it, and the counts, to any signed-in caller", async () => {
		const admin = await seedLocalUser("in-admin", "admin");
		const member = await seedLocalUser("in-member");
		const service = await seedKey("in-service", ["manage"]);
		await seedKey("in-service-ingest", ["ingest"]);
		const listed = await seedKey("in-listed", ["manage"]);
		await seedKey("in-owned", ["manage"], member.id);
		await setAdminServiceKeyList([listed.id]);
		await seedSession("in-unassigned-1", null);
		await seedSession("in-unassigned-2", null);
		await seedSession("in-service-session", null, service.id);
		await seedSession("in-owned-session", member.id);

		const expected = {
			mode: "solo",
			modeLockedByEnv: false,
			counts: {
				unassignedSessions: 2,
				serviceKeys: 3,
				undecidedManageServiceKeys: 1,
				undecidedServiceKeys: 2,
			},
		};
		for (const headers of [await cookieHeadersFor(admin.id), await cookieHeadersFor(member.id)]) {
			const res = await app.request("/api/v1/instance", { headers });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual(expected);
		}
	});

	test("a read-only key may read it; an unauthenticated request may not", async () => {
		const { key } = await seedKey("in-observe", ["observe"]);
		const ok = await app.request("/api/v1/instance", { headers: bearerHeaders(key) });
		expect(ok.status).toBe(200);
		expect((await app.request("/api/v1/instance")).status).toBe(401);
	});

	test("says when the env fixes the mode", async () => {
		process.env[MODE_ENV] = "team";
		const admin = await seedLocalUser("in-env", "admin");
		const res = await app.request("/api/v1/instance", {
			headers: await cookieHeadersFor(admin.id),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { mode: string; modeLockedByEnv: boolean };
		expect(body.mode).toBe("team");
		expect(body.modeLockedByEnv).toBe(true);
	});
});

describe("PUT /instance/mode: who", () => {
	test("a member is refused, and so is every key, including an admin's and a kept service key", async () => {
		const admin = await seedLocalUser("in-who-admin", "admin");
		const member = await seedLocalUser("in-who-member");
		const adminKey = await seedKey("in-who-admin-key", ["manage"], admin.id);
		const service = await seedKey("in-who-service", ["manage"]);
		const body = { mode: "team", serviceKeyDecisions: [{ keyId: service.id, decision: "keep" }] };

		const asMember = await app.request(
			MODE,
			jsonRequest("PUT", body, await cookieHeadersFor(member.id)),
		);
		expect(asMember.status).toBe(403);
		expect(((await asMember.json()) as { error: string }).error).toBe("admin_required");

		for (const headers of [bearerHeaders(adminKey.key), bearerHeaders(service.key)]) {
			const res = await app.request(MODE, jsonRequest("PUT", body, headers));
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toBe("human_admin_required");
		}
		expect(await storedMode()).toBeNull();
	});

	test("a foreign Origin is refused", async () => {
		const admin = await seedLocalUser("in-origin", "admin");
		const headers = await cookieHeadersFor(admin.id);
		headers.set("Origin", "https://evil.example.test");
		const res = await app.request(MODE, jsonRequest("PUT", { mode: "team" }, headers));
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("bad_origin");
	});
});

describe("PUT /instance/mode: switching to team", () => {
	test("is refused with the keys that still need a decision, and changes nothing", async () => {
		const admin = await seedLocalUser("in-undecided", "admin");
		const service = await seedKey("in-undecided-key", ["manage"]);
		const res = await app.request(
			MODE,
			jsonRequest(
				"PUT",
				{ mode: "team", serviceKeyDecisions: [] },
				await cookieHeadersFor(admin.id),
			),
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; keys: Array<{ id: string }> };
		expect(body.error).toBe("service_keys_undecided");
		expect(body.keys.map((k) => k.id)).toEqual([service.id]);
		expect(await storedMode()).toBeNull();
	});

	test("applies keep, assign and revoke together with the mode, and the next request is judged as team", async () => {
		const admin = await seedLocalUser("in-switch-admin", "admin");
		const member = await seedLocalUser("in-switch-member");
		const keep = await seedKey("in-keep", ["manage"]);
		const assign = await seedKey("in-assign", ["manage"]);
		const revoke = await seedKey("in-revoke", ["manage"]);
		const adminHeaders = await cookieHeadersFor(admin.id);
		const memberHeaders = await cookieHeadersFor(member.id);

		const put = (headers: Headers) =>
			app.request("/api/v1/settings/workspace", jsonRequest("PUT", {}, headers));
		expect((await put(memberHeaders)).status).toBe(200);

		const res = await app.request(
			MODE,
			jsonRequest(
				"PUT",
				{
					mode: "team",
					serviceKeyDecisions: [
						{ keyId: keep.id, decision: "keep" },
						{ keyId: assign.id, decision: "assign", userId: member.id },
						{ keyId: revoke.id, decision: "revoke" },
					],
				},
				adminHeaders,
			),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mode: "team", changed: true });
		expect(await storedMode()).toBe("team");

		const [assigned] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, assign.id));
		expect(assigned?.ownerUserId).toBe(member.id);
		const [revoked] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, revoke.id));
		expect(revoked?.isActive).toBe(false);

		// No cache: the very next request is a team request.
		const refused = await put(memberHeaders);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("admin_required");
		expect((await put(adminHeaders)).status).toBe(200);
		// The kept key is still an admin; the others are not.
		const keptCall = await app.request(
			"/api/v1/settings/workspace",
			jsonRequest("PUT", {}, bearerHeaders(keep.key)),
		);
		expect(keptCall.status).toBe(200);
	});

	test("a decision for a key that isn't an ownerless manage key is a 400", async () => {
		const admin = await seedLocalUser("in-bad-decision", "admin");
		const res = await app.request(
			MODE,
			jsonRequest(
				"PUT",
				{ mode: "team", serviceKeyDecisions: [{ keyId: "nope", decision: "keep" }] },
				await cookieHeadersFor(admin.id),
			),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_service_key_decision");
	});

	test("an invalid mode, or a malformed decision, is a 400", async () => {
		const admin = await seedLocalUser("in-invalid", "admin");
		const headers = await cookieHeadersFor(admin.id);
		const bad = await app.request(MODE, jsonRequest("PUT", { mode: "everyone" }, headers));
		expect(bad.status).toBe(400);
		const badDecision = await app.request(
			MODE,
			jsonRequest(
				"PUT",
				{ mode: "team", serviceKeyDecisions: [{ keyId: "x", decision: "burn" }] },
				headers,
			),
		);
		expect(badDecision.status).toBe(400);
	});

	test("with the env fixing the mode it is 409 mode_locked_by_env", async () => {
		process.env[MODE_ENV] = "solo";
		const admin = await seedLocalUser("in-locked", "admin");
		const res = await app.request(
			MODE,
			jsonRequest(
				"PUT",
				{ mode: "team", serviceKeyDecisions: [] },
				await cookieHeadersFor(admin.id),
			),
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe("mode_locked_by_env");
	});

	test("a disabled admin is not one", async () => {
		const admin = await seedLocalUser("in-disabled-admin", "admin");
		const other = await seedLocalUser("in-other-admin", "admin");
		const headers = await cookieHeadersFor(admin.id);
		await disableUserDirectly(admin.id);
		const res = await app.request(MODE, jsonRequest("PUT", { mode: "team" }, headers));
		expect(res.status).toBe(401);
		expect(other.id).not.toBe(admin.id);
	});
});

describe("PUT /instance/mode: under DISABLE_AUTH", () => {
	test("team is unreachable (400 team_requires_auth) and solo is a no-op", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const team = await app.request(
			MODE,
			jsonRequest("PUT", { mode: "team", serviceKeyDecisions: [] }, new Headers()),
		);
		expect(team.status).toBe(400);
		expect(((await team.json()) as { error: string }).error).toBe("team_requires_auth");
		const solo = await app.request(MODE, jsonRequest("PUT", { mode: "solo" }, new Headers()));
		expect(solo.status).toBe(200);
		expect(await solo.json()).toEqual({ mode: "solo", changed: false });
		expect(await storedMode()).toBeNull();
	});
});

describe("PUT /instance/mode: switching back to solo", () => {
	test("a human admin may, with the confirmation counts left to the UI; the next request is judged as solo", async () => {
		await setStoredMode("team");
		const admin = await seedLocalUser("in-back-admin", "admin");
		const member = await seedLocalUser("in-back-member");
		const put = (headers: Headers) =>
			app.request("/api/v1/settings/workspace", jsonRequest("PUT", {}, headers));
		expect((await put(await cookieHeadersFor(member.id))).status).toBe(403);

		const res = await app.request(
			MODE,
			jsonRequest("PUT", { mode: "solo" }, await cookieHeadersFor(admin.id)),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mode: "solo", changed: true });
		expect((await put(await cookieHeadersFor(member.id))).status).toBe(200);
	});

	test("a member and a kept admin service key are refused, as for the other direction", async () => {
		await setStoredMode("team");
		const member = await seedLocalUser("in-back-refused");
		const service = await seedKey("in-back-service", ["manage"]);
		await setAdminServiceKeyList([service.id]);
		const asMember = await app.request(
			MODE,
			jsonRequest("PUT", { mode: "solo" }, await cookieHeadersFor(member.id)),
		);
		expect(asMember.status).toBe(403);
		const asKey = await app.request(
			MODE,
			jsonRequest("PUT", { mode: "solo" }, bearerHeaders(service.key)),
		);
		expect(asKey.status).toBe(403);
		expect(((await asKey.json()) as { error: string }).error).toBe("human_admin_required");
		expect(await storedMode()).toBe("team");
	});
});

describe("the audit line for a mode change", () => {
	test("names who switched", async () => {
		const admin = await seedLocalUser("in-audit", "admin");
		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		try {
			await app.request(
				MODE,
				jsonRequest(
					"PUT",
					{ mode: "team", serviceKeyDecisions: [] },
					await cookieHeadersFor(admin.id),
				),
			);
		} finally {
			spy.mockRestore();
		}
		const line = lines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((l) => l?.kind === "instance_mode_changed");
		expect(line?.by).toBe(admin.id);
		expect(line?.to).toBe("team");
	});
});

describe("POST /instance/claim-unassigned", () => {
	test("gives the target user the sessions nobody owns and leaves the rest alone", async () => {
		const admin = await seedLocalUser("in-claim-admin", "admin");
		const target = await seedLocalUser("in-claim-target");
		const service = await seedKey("in-claim-service", ["ingest"]);
		await seedSession("in-claim-u1", null);
		await seedSession("in-claim-u2", null);
		await seedSession("in-claim-service", null, service.id);
		await seedSession("in-claim-owned", admin.id);

		const res = await app.request(
			CLAIM,
			jsonRequest("POST", { userId: target.id }, await cookieHeadersFor(admin.id)),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ claimed: 2 });
		expect(await ownerOf("in-claim-u1")).toBe(target.id);
		expect(await ownerOf("in-claim-u2")).toBe(target.id);
		expect(await ownerOf("in-claim-service")).toBeNull();
		expect(await ownerOf("in-claim-owned")).toBe(admin.id);
	});

	test("refuses a member and every key, and a disabled or unknown target", async () => {
		const admin = await seedLocalUser("in-claim-admin2", "admin");
		const member = await seedLocalUser("in-claim-member");
		const adminKey = await seedKey("in-claim-adminkey", ["manage"], admin.id);
		const gone = await seedLocalUser("in-claim-gone");
		await disableUserDirectly(gone.id);
		await seedSession("in-claim-keep", null);

		const asMember = await app.request(
			CLAIM,
			jsonRequest("POST", { userId: member.id }, await cookieHeadersFor(member.id)),
		);
		expect(asMember.status).toBe(403);
		const asKey = await app.request(
			CLAIM,
			jsonRequest("POST", { userId: member.id }, bearerHeaders(adminKey.key)),
		);
		expect(asKey.status).toBe(403);
		expect(((await asKey.json()) as { error: string }).error).toBe("human_admin_required");

		const adminHeaders = await cookieHeadersFor(admin.id);
		const disabled = await app.request(
			CLAIM,
			jsonRequest("POST", { userId: gone.id }, adminHeaders),
		);
		expect(disabled.status).toBe(409);
		expect(((await disabled.json()) as { error: string }).error).toBe("user_disabled");
		const unknown = await app.request(
			CLAIM,
			jsonRequest("POST", { userId: "no-such-user" }, adminHeaders),
		);
		expect(unknown.status).toBe(404);
		const missing = await app.request(CLAIM, jsonRequest("POST", {}, adminHeaders));
		expect(missing.status).toBe(400);
		expect(await ownerOf("in-claim-keep")).toBeNull();
	});
});
