/**
 * A key can't be used to make something more powerful than itself.
 *  - Only a HUMAN admin may give a key an owner who is an admin, or give any
 *    owner to a key holding manage (or the wildcard).
 *  - A key-minted key is owned by the caller's owner (ownerless if the caller
 *    is ownerless) and never kept as an admin service key; the response says
 *    so with adminService:false.
 *  - Minting is rate-limited per caller.
 *  - GET /api-keys/:id answers 404 for a missing key and for one that isn't
 *    yours alike.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { apiKeys, settings } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { _resetKeyMintLimitForTest, _setKeyMintClockForTest } = await import(
	"../services/key-mint-limit.js"
);

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	_resetKeyMintLimitForTest();
	_setKeyMintClockForTest(null);
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

async function world() {
	const admin = await seedLocalUser("ae-admin", "admin");
	const adminTwo = await seedLocalUser("ae-admin-two", "admin");
	const member = await seedLocalUser("ae-member");
	const other = await seedLocalUser("ae-other");
	const adminOwnedKey = await seedKey("ae-admin-key", ["manage"], admin.id);
	const listed = await seedKey("ae-listed", ["manage"]);
	await setAdminServiceKeyList([listed.id]);
	return {
		admin: { id: admin.id, cookie: await cookieHeadersFor(admin.id) },
		adminTwo,
		member: { id: member.id, cookie: await cookieHeadersFor(member.id) },
		other: { id: other.id, cookie: await cookieHeadersFor(other.id) },
		adminOwnedKey: { id: adminOwnedKey.id, headers: bearerHeaders(adminOwnedKey.key) },
		listed: { id: listed.id, headers: bearerHeaders(listed.key) },
	};
}

const call = (path: string, method: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body, headers));
async function keyRow(id: string) {
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id));
	return row;
}
async function code(res: Response): Promise<string | undefined> {
	return ((await res.json().catch(() => ({}))) as { error?: string }).error;
}

describe("handing a key to an owner", () => {
	test("a key that is an admin can't give a key to an admin user; the key is left as it was", async () => {
		await setStoredMode("team");
		const w = await world();
		const target = await seedKey("ae-target", ["ingest"]);

		for (const headers of [w.adminOwnedKey.headers, w.listed.headers]) {
			const res = await call(
				`/api-keys/${target.id}`,
				"PATCH",
				{ ownerUserId: w.adminTwo.id },
				headers,
			);
			expect(res.status).toBe(403);
			expect(await code(res)).toBe("human_admin_required");
		}
		expect((await keyRow(target.id))?.ownerUserId).toBeNull();
	});

	test("a key that is an admin can't give a manage key to anyone, even a member", async () => {
		await setStoredMode("team");
		const w = await world();
		const manage = await seedKey("ae-manage", ["manage"]);

		const res = await call(
			`/api-keys/${manage.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			w.adminOwnedKey.headers,
		);
		expect(res.status).toBe(403);
		expect(await code(res)).toBe("human_admin_required");
		expect((await keyRow(manage.id))?.ownerUserId).toBeNull();
	});

	test("the wildcard scope counts as manage", async () => {
		await setStoredMode("team");
		const w = await world();
		const wildcard = await seedKey("ae-wild", ["ingest"]);
		await getDb()
			.update(apiKeys)
			.set({ scopes: JSON.stringify(["*"]) })
			.where(eq(apiKeys.id, wildcard.id));

		const res = await call(
			`/api-keys/${wildcard.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			w.listed.headers,
		);
		expect(res.status).toBe(403);
	});

	test("a key that is an admin can still give an ingest-only key to a member", async () => {
		await setStoredMode("team");
		const w = await world();
		const ingest = await seedKey("ae-ingest", ["ingest"]);

		const res = await call(
			`/api-keys/${ingest.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			w.adminOwnedKey.headers,
		);
		expect(res.status).toBe(200);
		expect((await keyRow(ingest.id))?.ownerUserId).toBe(w.member.id);
	});

	test("a human admin can give a manage key to an admin", async () => {
		await setStoredMode("team");
		const w = await world();
		const manage = await seedKey("ae-manage-2", ["manage"]);

		const res = await call(
			`/api-keys/${manage.id}`,
			"PATCH",
			{ ownerUserId: w.adminTwo.id },
			w.admin.cookie,
		);
		expect(res.status).toBe(200);
		expect((await keyRow(manage.id))?.ownerUserId).toBe(w.adminTwo.id);
	});
});

describe("minting with a key", () => {
	test("a key minted by an owned key is owned by that owner, and is not kept as an admin service key", async () => {
		await setStoredMode("team");
		const w = await world();

		const res = await call(
			"/api-keys",
			"POST",
			{ name: "child", scopes: ["manage"] },
			w.adminOwnedKey.headers,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			ownerUserId: string | null;
			adminService: boolean;
		};
		expect(body.ownerUserId).toBe(w.admin.id);
		expect(body.adminService).toBe(false);
		expect((await keyRow(body.id))?.ownerUserId).toBe(w.admin.id);
	});

	test("a key minted by a kept admin service key is ownerless, not kept, acts as a member, and the response says so", async () => {
		await setStoredMode("team");
		const w = await world();

		const res = await call(
			"/api-keys",
			"POST",
			{ name: "child", scopes: ["manage"] },
			w.listed.headers,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			key: string;
			ownerUserId: string | null;
			adminService: boolean;
		};
		expect(body.adminService).toBe(false);
		expect(body.ownerUserId).toBeNull();
		const [kept] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, "instance.adminServiceKeyIds"));
		expect(kept?.value).toEqual([w.listed.id]);

		// Member-level: an admin-only route refuses it.
		const asChild = await app.request("/api/v1/users", { headers: bearerHeaders(body.key) });
		expect(asChild.status).toBe(403);
	});

	test("a key can't mint a service key, owned or not", async () => {
		await setStoredMode("team");
		const w = await world();
		for (const headers of [w.adminOwnedKey.headers, w.listed.headers]) {
			const res = await call(
				"/api-keys",
				"POST",
				{ name: "svc", scopes: ["ingest"], service: true },
				headers,
			);
			expect(res.status).toBe(403);
			expect(await code(res)).toBe("human_admin_required");
		}
	});

	test("the response always says whether the key is kept: a human admin's manage service key is", async () => {
		await setStoredMode("team");
		const w = await world();

		const kept = await call(
			"/api-keys",
			"POST",
			{ name: "svc", scopes: ["manage"], service: true },
			w.admin.cookie,
		);
		expect(((await kept.json()) as { adminService: boolean }).adminService).toBe(true);

		const own = await call(
			"/api-keys",
			"POST",
			{ name: "mine", scopes: ["ingest"] },
			w.member.cookie,
		);
		expect(((await own.json()) as { adminService: boolean }).adminService).toBe(false);
	});

	test("solo: a key mints as before and the response says adminService false", async () => {
		const w = await world();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "solo", scopes: ["ingest"] },
			w.listed.headers,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { adminService: boolean }).adminService).toBe(false);
	});
});

describe("minting is rate-limited per caller", () => {
	test("past the limit a caller gets 429 with Retry-After; another caller is unaffected; a later minute starts fresh", async () => {
		await setStoredMode("team");
		const w = await world();
		let now = 5_000_000;
		_setKeyMintClockForTest(() => now);

		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			const res = await call(
				"/api-keys",
				"POST",
				{ name: `k${i}`, scopes: ["ingest"] },
				w.member.cookie,
			);
			statuses.push(res.status);
			if (res.status === 429) {
				expect(await code(res)).toBe("rate_limited");
				expect(res.headers.get("Retry-After")).not.toBeNull();
			}
		}
		expect(statuses.filter((s) => s === 200).length).toBe(10);
		expect(statuses.filter((s) => s === 429).length).toBe(2);

		const other = await call(
			"/api-keys",
			"POST",
			{ name: "o", scopes: ["ingest"] },
			w.other.cookie,
		);
		expect(other.status).toBe(200);

		now += 61_000;
		const later = await call(
			"/api-keys",
			"POST",
			{ name: "later", scopes: ["ingest"] },
			w.member.cookie,
		);
		expect(later.status).toBe(200);
	});

	test("one person's cookie and keys share the allowance", async () => {
		await setStoredMode("team");
		const w = await world();
		_setKeyMintClockForTest(() => 6_000_000);
		const memberKey = await seedKey("ae-member-key", ["manage"], w.member.id);
		for (let i = 0; i < 10; i++) {
			const res = await call(
				"/api-keys",
				"POST",
				{ name: `c${i}`, scopes: ["ingest"] },
				w.member.cookie,
			);
			expect(res.status).toBe(200);
		}
		const viaKey = await call(
			"/api-keys",
			"POST",
			{ name: "viakey", scopes: ["ingest"] },
			bearerHeaders(memberKey.key),
		);
		expect(viaKey.status).toBe(429);
	});
});

describe("GET /api-keys/:id", () => {
	test("a member gets the same 404 for a key that isn't theirs and one that doesn't exist", async () => {
		await setStoredMode("team");
		const w = await world();
		const theirs = await seedKey("ae-theirs", ["ingest"], w.other.id);

		const notYours = await call(`/api-keys/${theirs.id}`, "GET", undefined, w.member.cookie);
		const missing = await call(
			`/api-keys/${crypto.randomUUID()}`,
			"GET",
			undefined,
			w.member.cookie,
		);

		expect(notYours.status).toBe(404);
		expect(missing.status).toBe(404);
		expect(await notYours.json()).toEqual(await missing.json());
	});

	test("the owner and an admin still see it; an admin gets 404 for a missing one; solo is unchanged", async () => {
		await setStoredMode("team");
		const w = await world();
		const mine = await seedKey("ae-mine", ["ingest"], w.member.id);

		expect((await call(`/api-keys/${mine.id}`, "GET", undefined, w.member.cookie)).status).toBe(
			200,
		);
		expect((await call(`/api-keys/${mine.id}`, "GET", undefined, w.admin.cookie)).status).toBe(200);
		expect(
			(await call(`/api-keys/${crypto.randomUUID()}`, "GET", undefined, w.admin.cookie)).status,
		).toBe(404);

		await setStoredMode("solo");
		expect((await call(`/api-keys/${mine.id}`, "GET", undefined, w.other.cookie)).status).toBe(200);
	});
});

describe("clearing a key's owner", () => {
	const keptIds = async (): Promise<string[]> => {
		const [row] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, "instance.adminServiceKeyIds"));
		return (row?.value as string[] | undefined) ?? [];
	};

	test("a kept admin service key that is made ownerless is delisted unless a human admin keeps it in the same request", async () => {
		await setStoredMode("team");
		const w = await world();

		const plain = await call(
			`/api-keys/${w.listed.id}`,
			"PATCH",
			{ ownerUserId: null },
			w.admin.cookie,
		);
		expect(plain.status).toBe(200);
		expect(((await plain.json()) as { adminService: boolean }).adminService).toBe(false);
		expect(await keptIds()).not.toContain(w.listed.id);
	});

	test("with adminService: true from a human admin it stays listed, and the response says so", async () => {
		await setStoredMode("team");
		const w = await world();

		const res = await call(
			`/api-keys/${w.listed.id}`,
			"PATCH",
			{ ownerUserId: null, adminService: true },
			w.admin.cookie,
		);

		expect(res.status).toBe(200);
		expect(((await res.json()) as { adminService: boolean }).adminService).toBe(true);
		expect(await keptIds()).toContain(w.listed.id);
	});

	test("an owned manage key made ownerless and kept in one request: listed", async () => {
		await setStoredMode("team");
		const w = await world();
		const owned = await seedKey("ae-owned-manage", ["manage"], w.member.id);

		const res = await call(
			`/api-keys/${owned.id}`,
			"PATCH",
			{ ownerUserId: null, adminService: true },
			w.admin.cookie,
		);

		expect(res.status).toBe(200);
		expect((await keyRow(owned.id))?.ownerUserId).toBeNull();
		expect(await keptIds()).toContain(owned.id);
	});

	test("an admin's key can't keep one (human admin only), and an ingest-only key can't be kept", async () => {
		await setStoredMode("team");
		const w = await world();
		const viaKey = await call(
			`/api-keys/${w.listed.id}`,
			"PATCH",
			{ ownerUserId: null, adminService: true },
			w.adminOwnedKey.headers,
		);
		expect(viaKey.status).toBe(403);
		expect(await code(viaKey)).toBe("human_admin_required");

		const ingestOnly = await seedKey("ae-ingest-only", ["ingest"], w.member.id);
		const notManage = await call(
			`/api-keys/${ingestOnly.id}`,
			"PATCH",
			{ ownerUserId: null, adminService: true },
			w.admin.cookie,
		);
		expect(notManage.status).toBe(409);
		expect((await keyRow(ingestOnly.id))?.ownerUserId).toBe(w.member.id);
	});

	test("an owner and adminService together is still refused", async () => {
		await setStoredMode("team");
		const w = await world();
		const res = await call(
			`/api-keys/${w.listed.id}`,
			"PATCH",
			{ ownerUserId: w.member.id, adminService: true },
			w.admin.cookie,
		);
		expect(res.status).toBe(400);
	});

	test("every patch answers with whether the key is kept afterwards", async () => {
		await setStoredMode("team");
		const w = await world();
		const ingest = await seedKey("ae-handover", ["ingest"]);
		const res = await call(
			`/api-keys/${ingest.id}`,
			"PATCH",
			{ ownerUserId: w.member.id },
			w.admin.cookie,
		);
		expect(((await res.json()) as { adminService: boolean }).adminService).toBe(false);
	});
});
