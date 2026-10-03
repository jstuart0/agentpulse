/**
 * Service-key bookkeeping behind team mode: which ownerless manage keys are
 * kept as admin-equivalent (the protected list), and the operations that
 * must keep that list honest — revoking a listed key or giving it an owner
 * takes it off the list in the same transaction.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { apiKeys, settings, users } = await import("../db/schema/index.js");
const { createUser } = await import("./local-auth-service.js");
const { createApiKey } = await import("../auth/api-key.js");
const { isOnServiceKeyList } = await import("./service-key-lists.js");
const { OwnerDisabledError } = await import("../auth/owner-state.js");
const {
	getAdminServiceKeyIds,
	getServiceKeyIds,
	isServiceKeyRow,
	listUndecidedServiceKeys,
	reassignApiKeyOwner,
	revokeApiKey,
} = await import("./service-keys.js");

const LIST_KEY = "instance.adminServiceKeyIds";
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
});
beforeEach(resetIdentityState);
afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await resetIdentityState();
});

function uniqueName(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

async function storeList(value: unknown) {
	await getDb()
		.insert(settings)
		.values({ key: LIST_KEY, value, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function storedList(): Promise<unknown> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, LIST_KEY)).limit(1);
	return row?.value;
}

async function keyRow(id: string) {
	const [row] = await getDb().select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
	return row;
}

describe("getAdminServiceKeyIds", () => {
	test("is empty when nothing is stored", async () => {
		expect(await getAdminServiceKeyIds()).toEqual([]);
	});

	test("returns the stored ids", async () => {
		await storeList(["a", "b"]);
		expect(await getAdminServiceKeyIds()).toEqual(["a", "b"]);
	});

	test("a malformed stored value is an empty list, and non-string entries are dropped", async () => {
		await storeList("not-a-list");
		expect(await getAdminServiceKeyIds()).toEqual([]);
		await storeList({ a: 1 });
		expect(await getAdminServiceKeyIds()).toEqual([]);
		await storeList(["ok", 7, null, "also-ok"]);
		expect(await getAdminServiceKeyIds()).toEqual(["ok", "also-ok"]);
	});
});

describe("listUndecidedServiceKeys", () => {
	test("active, ownerless keys with manage or the wildcard scope that aren't on the list", async () => {
		const manage = await createApiKey(uniqueName("manage"), ["manage"]);
		const listed = await createApiKey(uniqueName("listed"), ["manage"]);
		await storeList([listed.id]);
		const wildcard = await createApiKey(uniqueName("wild"), ["ingest"]);
		await getDb().update(apiKeys).set({ scopes: '["*"]' }).where(eq(apiKeys.id, wildcard.id));
		const owner = await createUser({
			username: uniqueName("owner"),
			password: "a-very-long-password-123",
			role: "user",
		});
		await createApiKey(uniqueName("owned"), ["manage"], owner.id);
		await createApiKey(uniqueName("ingest"), ["ingest"]);
		await createApiKey(uniqueName("observe"), ["observe"]);
		const inactive = await createApiKey(uniqueName("inactive"), ["manage"]);
		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, inactive.id));

		const found = await listUndecidedServiceKeys();

		expect(found.map((k) => k.id).sort()).toEqual([manage.id, wildcard.id].sort());
		expect(found.find((k) => k.id === manage.id)?.keyPrefix).toBe(manage.key.slice(0, 11));
	});
});

describe("revokeApiKey", () => {
	test("deactivates the key and takes a listed key off the list, leaving the others", async () => {
		const a = await createApiKey(uniqueName("a"), ["manage"]);
		const b = await createApiKey(uniqueName("b"), ["manage"]);
		await storeList([a.id, b.id]);

		expect(await revokeApiKey(a.id)).toBe(true);

		expect((await keyRow(a.id))?.isActive).toBe(false);
		expect((await keyRow(b.id))?.isActive).toBe(true);
		expect(await storedList()).toEqual([b.id]);
	});

	test("an unlisted key is revoked without writing the list at all", async () => {
		const a = await createApiKey(uniqueName("a"), ["manage"]);

		expect(await revokeApiKey(a.id)).toBe(true);

		expect((await keyRow(a.id))?.isActive).toBe(false);
		expect(await storedList()).toBeUndefined();
	});

	test("an unknown key reports false and changes nothing", async () => {
		const a = await createApiKey(uniqueName("a"), ["manage"]);
		await storeList([a.id]);

		expect(await revokeApiKey(crypto.randomUUID())).toBe(false);

		expect(await storedList()).toEqual([a.id]);
	});

	test("DELETE /api-keys/:id goes through it: a revoked listed key leaves the list", async () => {
		const { app } = await import("../app.js");
		(config as Record<string, unknown>).disableAuth = false;
		const caller = await createApiKey(uniqueName("caller"), ["manage"]);
		const listed = await createApiKey(uniqueName("listed"), ["manage"]);
		await storeList([listed.id, caller.id]);

		const res = await app.request(`/api/v1/api-keys/${listed.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${caller.key}` },
		});

		expect(res.status).toBe(200);
		expect((await keyRow(listed.id))?.isActive).toBe(false);
		expect(await storedList()).toEqual([caller.id]);
	});

	test("DELETE /api-keys/:id for an unknown key is still 404", async () => {
		const { app } = await import("../app.js");
		(config as Record<string, unknown>).disableAuth = false;
		const caller = await createApiKey(uniqueName("caller"), ["manage"]);

		const res = await app.request(`/api/v1/api-keys/${crypto.randomUUID()}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${caller.key}` },
		});

		expect(res.status).toBe(404);
	});
});

describe("reassignApiKeyOwner", () => {
	async function member() {
		return createUser({
			username: uniqueName("member"),
			password: "a-very-long-password-123",
			role: "user",
		});
	}

	test("gives a listed key an owner and takes it off the list", async () => {
		const listed = await createApiKey(uniqueName("listed"), ["manage"]);
		const other = await createApiKey(uniqueName("other"), ["manage"]);
		await storeList([listed.id, other.id]);
		const owner = await member();

		expect(await reassignApiKeyOwner(listed.id, owner.id)).toBe(true);

		expect((await keyRow(listed.id))?.ownerUserId).toBe(owner.id);
		expect(await storedList()).toEqual([other.id]);
	});

	test("making a key ownerless again doesn't put it on the list", async () => {
		const owner = await member();
		const owned = await createApiKey(uniqueName("owned"), ["manage"], owner.id);

		expect(await reassignApiKeyOwner(owned.id, null)).toBe(true);

		expect((await keyRow(owned.id))?.ownerUserId).toBeNull();
		expect(await storedList()).toBeUndefined();
	});

	test("refuses a disabled owner and changes nothing", async () => {
		const key = await createApiKey(uniqueName("k"), ["manage"]);
		await storeList([key.id]);
		const disabled = await member();
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, disabled.id));

		await expect(reassignApiKeyOwner(key.id, disabled.id)).rejects.toBeInstanceOf(
			OwnerDisabledError,
		);

		expect((await keyRow(key.id))?.ownerUserId).toBeNull();
		expect(await storedList()).toEqual([key.id]);
	});

	test("an unknown key reports false", async () => {
		const owner = await member();
		expect(await reassignApiKeyOwner(crypto.randomUUID(), owner.id)).toBe(false);
	});
});

describe("the locked operations issue every statement on the lock's transaction", () => {
	// See the same check in instance-mode.test.ts: on SQLite a statement that
	// ignored the handle would still roll back with it, so only the source
	// shows it.
	test("revokeApiKey and reassignApiKeyOwner never reach for the pool", async () => {
		const source = await readFile(new URL("./service-keys.ts", import.meta.url), "utf8");
		const section = source.slice(source.indexOf("export async function revokeApiKey"));

		expect(section.length).toBeGreaterThan(400);
		expect(section).not.toMatch(/\bgetDb\(/);
		for (const call of section.match(/(?:delistAdminServiceKey|assertOwnerActive)\([^)]*\)/g) ??
			[]) {
			expect(call).toMatch(/\btx\b/);
		}
	});
});

describe("the plain service-key list", () => {
	const PLAIN_KEY = "instance.serviceKeyIds";
	async function storePlain(ids: string[]) {
		await getDb()
			.insert(settings)
			.values({ key: PLAIN_KEY, value: ids, updatedAt: new Date().toISOString() })
			.onConflictDoUpdate({ target: settings.key, set: { value: ids } });
	}

	test("giving a key an owner, or revoking it, takes it off the plain list too", async () => {
		const first = await createApiKey(uniqueName("plain-first"), ["ingest"]);
		const second = await createApiKey(uniqueName("plain-second"), ["ingest"]);
		const other = await createApiKey(uniqueName("plain-other"), ["ingest"]);
		await storePlain([first.id, second.id, other.id]);
		const owner = await createUser({
			username: uniqueName("plain-owner"),
			password: "a-very-long-password-123",
			role: "user",
		});

		expect(await reassignApiKeyOwner(first.id, owner.id)).toBe(true);
		expect(await getServiceKeyIds()).toEqual([second.id, other.id]);
		expect(await revokeApiKey(second.id)).toBe(true);
		expect(await getServiceKeyIds()).toEqual([other.id]);
	});

	test("a key is a service key only by being on a list: minted, kept and listed keys are; an owner, an undecided key and an unknown id are not", async () => {
		const admin = await createUser({
			username: uniqueName("isk-admin"),
			password: "a-very-long-password-123",
			role: "admin",
		});
		const minted = await createApiKey(uniqueName("isk-minted"), ["ingest"], admin.id, {
			service: true,
		});
		const kept = await createApiKey(uniqueName("isk-kept"), ["manage"]);
		const listed = await createApiKey(uniqueName("isk-listed"), ["ingest"]);
		const undecided = await createApiKey(uniqueName("isk-undecided"), ["ingest"]);
		const owned = await createApiKey(uniqueName("isk-owned"), ["ingest"], admin.id);
		await storeList([kept.id, owned.id]);
		await storePlain([minted.id, listed.id, owned.id]);

		expect(await isOnServiceKeyList(minted.id)).toBe(true);
		expect(await isOnServiceKeyList(kept.id)).toBe(true);
		expect(await isOnServiceKeyList(listed.id)).toBe(true);
		expect(await isOnServiceKeyList(undecided.id)).toBe(false);
		expect(await isOnServiceKeyList("no-such-key")).toBe(false);

		const lists = { admin: await getAdminServiceKeyIds(), plain: await getServiceKeyIds() };
		// Listed on both lists, but it has an owner: not a service key.
		expect(isServiceKeyRow({ id: owned.id, ownerUserId: admin.id }, lists)).toBe(false);
		// A key its creator minted for itself is not one either: the creator isn't consulted.
		expect(isServiceKeyRow({ id: undecided.id, ownerUserId: null }, lists)).toBe(false);
		expect(isServiceKeyRow({ id: minted.id, ownerUserId: null }, lists)).toBe(true);
	});
});
