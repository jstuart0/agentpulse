/**
 * "This key is a service key", recorded on the server: a protected list of
 * plain service keys beside the kept-admin list, an admin's PATCH to change
 * it, `serviceKey` on key rows, and the count of ownerless keys nobody has
 * decided about on GET /instance.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedAdminMintedServiceKey,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys, settings } = await import("../db/schema/index.js");
const { app } = await import("../app.js");

const LIST_KEY = "instance.serviceKeyIds";

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const call = (path: string, method: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body, headers));

async function plainList(): Promise<string[]> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, LIST_KEY));
	return (row?.value as string[] | undefined) ?? [];
}

async function world() {
	const admin = await seedLocalUser("sf-admin", "admin");
	const member = await seedLocalUser("sf-member");
	return {
		admin,
		member,
		adminCookie: await cookieHeadersFor(admin.id),
		memberCookie: await cookieHeadersFor(member.id),
		minted: await seedAdminMintedServiceKey("sf-minted", ["ingest"], admin.id),
		kept: await seedKey("sf-kept", ["manage"]),
		plain: await seedKey("sf-plain", ["ingest"]),
		listed: await seedKey("sf-listed", ["ingest"]),
		owned: await seedKey("sf-owned", ["ingest"], member.id),
	};
}

type Row = { id: string; serviceKey: boolean };
async function rows(headers: Headers): Promise<Map<string, Row>> {
	const res = await call("/api-keys", "GET", undefined, headers);
	expect(res.status).toBe(200);
	const { keys } = (await res.json()) as { keys: Row[] };
	return new Map(keys.map((k) => [k.id, k]));
}

describe("serviceKey on GET /api-keys", () => {
	test("true for an admin-minted key, a kept admin key and a listed key; false for an undecided one and an owned one", async () => {
		const w = await world();
		await setAdminServiceKeyList([w.kept.id]);
		await setServiceKeyList([w.minted.id, w.listed.id]);

		for (const mode of ["solo", "team"] as const) {
			await setStoredMode(mode);
			const byId = await rows(w.adminCookie);
			expect(byId.get(w.minted.id)?.serviceKey).toBe(true);
			expect(byId.get(w.kept.id)?.serviceKey).toBe(true);
			expect(byId.get(w.listed.id)?.serviceKey).toBe(true);
			expect(byId.get(w.plain.id)?.serviceKey).toBe(false);
			expect(byId.get(w.owned.id)?.serviceKey).toBe(false);
		}
	});
});

describe("PATCH /api-keys/:id { serviceKey }", () => {
	test("an admin lists and delists an ownerless key, in both modes", async () => {
		const w = await world();
		for (const mode of ["solo", "team"] as const) {
			await setStoredMode(mode);
			const on = await call(
				`/api-keys/${w.plain.id}`,
				"PATCH",
				{ serviceKey: true },
				w.adminCookie,
			);
			expect(on.status).toBe(200);
			expect(((await on.json()) as { serviceKey: boolean }).serviceKey).toBe(true);
			expect(await plainList()).toContain(w.plain.id);
			expect((await rows(w.adminCookie)).get(w.plain.id)?.serviceKey).toBe(true);

			const off = await call(
				`/api-keys/${w.plain.id}`,
				"PATCH",
				{ serviceKey: false },
				w.adminCookie,
			);
			expect(off.status).toBe(200);
			expect(((await off.json()) as { serviceKey: boolean }).serviceKey).toBe(false);
			expect(await plainList()).not.toContain(w.plain.id);
		}
	});

	test("an owned key is a 409 key_has_owner; a member is refused; a non-boolean is a 400; an unknown key is a 404", async () => {
		const w = await world();
		await setStoredMode("team");
		const owned = await call(
			`/api-keys/${w.owned.id}`,
			"PATCH",
			{ serviceKey: true },
			w.adminCookie,
		);
		expect(owned.status).toBe(409);
		expect(((await owned.json()) as { error: string }).error).toBe("key_has_owner");
		expect(await plainList()).toEqual([w.minted.id]);

		const member = await call(
			`/api-keys/${w.plain.id}`,
			"PATCH",
			{ serviceKey: true },
			w.memberCookie,
		);
		expect(member.status).toBe(403);
		const bad = await call(
			`/api-keys/${w.plain.id}`,
			"PATCH",
			{ serviceKey: "yes" },
			w.adminCookie,
		);
		expect(bad.status).toBe(400);
		const missing = await call(
			"/api-keys/no-such-key",
			"PATCH",
			{ serviceKey: true },
			w.adminCookie,
		);
		expect(missing.status).toBe(404);
		expect(await plainList()).toEqual([w.minted.id]);
	});

	test("handing the key to a person together with serviceKey: true changes nothing", async () => {
		const w = await world();
		const res = await call(
			`/api-keys/${w.plain.id}`,
			"PATCH",
			{ ownerUserId: w.member.id, serviceKey: true },
			w.adminCookie,
		);
		expect(res.status).toBe(409);
		const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, w.plain.id));
		expect(row.ownerUserId).toBeNull();
	});
});

describe("the list is kept honest", () => {
	test("revoking a listed key, or giving it an owner, takes it off the list", async () => {
		const w = await world();
		const second = await seedKey("sf-second", ["ingest"]);
		await setServiceKeyList([w.minted.id, w.listed.id, second.id]);

		expect(
			(await call(`/api-keys/${w.listed.id}`, "DELETE", undefined, w.adminCookie)).status,
		).toBe(200);
		expect(await plainList()).toEqual([w.minted.id, second.id]);

		const handed = await call(
			`/api-keys/${second.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			w.adminCookie,
		);
		expect(handed.status).toBe(200);
		expect(await plainList()).toEqual([w.minted.id]);
	});

	test("the list is not readable or writable through /settings", async () => {
		const w = await world();
		await setServiceKeyList([w.plain.id]);
		const read = await call("/settings", "GET", undefined, w.adminCookie);
		expect(Object.keys((await read.json()) as object)).not.toContain(LIST_KEY);
		const write = await call("/settings", "PUT", { key: LIST_KEY, value: [] }, w.adminCookie);
		expect(write.status).toBe(403);
		expect(await plainList()).toEqual([w.plain.id]);
	});
});

describe("GET /instance undecidedServiceKeys", () => {
	test("counts active ownerless keys that are on neither list: minted, kept and listed keys are decided", async () => {
		const w = await world();
		await setAdminServiceKeyList([w.kept.id]);
		await setServiceKeyList([w.minted.id, w.listed.id]);
		const revoked = await seedKey("sf-revoked", ["ingest"]);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, revoked.id));

		const res = await call("/instance", "GET", undefined, w.memberCookie);
		const body = (await res.json()) as { counts: { undecidedServiceKeys: number } };
		// Only the plain ownerless key is undecided.
		expect(body.counts.undecidedServiceKeys).toBe(1);

		await call(`/api-keys/${w.plain.id}`, "PATCH", { serviceKey: true }, w.adminCookie);
		const after = await call("/instance", "GET", undefined, w.memberCookie);
		expect(
			((await after.json()) as { counts: { undecidedServiceKeys: number } }).counts,
		).toMatchObject({ undecidedServiceKeys: 0 });
	});
});
