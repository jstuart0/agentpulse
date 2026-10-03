/**
 * The two protected lists that make a key a service key: the kept-admin list
 * (ownerless keys with admin authority) and the plain list (ownerless keys an
 * admin has decided are service keys, without admin authority). A key is a
 * service key only by being on one of them; nothing is inferred from who
 * minted it. Kept apart from service-keys.ts so key minting can write the
 * list in the same transaction as the key without importing back into the
 * auth layer.
 *
 * Every write takes the transaction handle it runs on (an admin-locked one);
 * reads accept an optional handle so a locked caller sees its own view.
 */
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { settings } from "../db/schema/index.js";
import { upsertSetting } from "./settings-service.js";

export const ADMIN_SERVICE_KEY_IDS_SETTING = "instance.adminServiceKeyIds";
/** Ids of keys an admin keeps as plain service keys (ownerless, no admin authority). */
export const SERVICE_KEY_IDS_SETTING = "instance.serviceKeyIds";

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
async function readIdList(setting: string, handle?: any): Promise<string[]> {
	const [row] = await (handle ?? getDb())
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, setting))
		.limit(1);
	if (!row || !Array.isArray(row.value)) return [];
	return row.value.filter((entry: unknown): entry is string => typeof entry === "string");
}

async function writeIdList(
	setting: string,
	ids: string[],
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
): Promise<void> {
	await upsertSetting(setting, [...new Set(ids)], { allowProtected: true, tx });
}

async function addToIdList(
	setting: string,
	id: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
): Promise<void> {
	const current = await readIdList(setting, tx);
	if (current.includes(id)) return;
	await writeIdList(setting, [...current, id], tx);
}

async function removeFromIdList(
	setting: string,
	id: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
): Promise<void> {
	const current = await readIdList(setting, tx);
	if (!current.includes(id)) return;
	await writeIdList(
		setting,
		current.filter((entry) => entry !== id),
		tx,
	);
}

/** The kept admin-service key ids. A missing or malformed stored value is an empty list. */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function getAdminServiceKeyIds(handle?: any): Promise<string[]> {
	return readIdList(ADMIN_SERVICE_KEY_IDS_SETTING, handle);
}

/** Replaces the whole list. Only the mode switch (and the helpers below) write it. */
export async function writeAdminServiceKeyIds(
	ids: string[],
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
): Promise<void> {
	await writeIdList(ADMIN_SERVICE_KEY_IDS_SETTING, ids, tx);
}

/** Puts one key on the list; writes nothing when it is already there. */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function listAdminServiceKey(keyId: string, tx: any): Promise<void> {
	await addToIdList(ADMIN_SERVICE_KEY_IDS_SETTING, keyId, tx);
}

/** Takes one key off the list; writes nothing when it isn't on it. */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function delistAdminServiceKey(keyId: string, tx: any): Promise<void> {
	await removeFromIdList(ADMIN_SERVICE_KEY_IDS_SETTING, keyId, tx);
}

/** The plain service-key ids. A missing or malformed stored value is an empty list. */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function getServiceKeyIds(handle?: any): Promise<string[]> {
	return readIdList(SERVICE_KEY_IDS_SETTING, handle);
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function listServiceKey(keyId: string, tx: any): Promise<void> {
	await addToIdList(SERVICE_KEY_IDS_SETTING, keyId, tx);
}

// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function delistServiceKey(keyId: string, tx: any): Promise<void> {
	await removeFromIdList(SERVICE_KEY_IDS_SETTING, keyId, tx);
}

export interface ServiceKeyLists {
	admin: string[];
	plain: string[];
}

/** Both lists in one statement. A missing or malformed stored value is an empty list. */
export async function readServiceKeyLists(): Promise<ServiceKeyLists> {
	const rows = await getDb()
		.select({ key: settings.key, value: settings.value })
		.from(settings)
		.where(inArray(settings.key, [ADMIN_SERVICE_KEY_IDS_SETTING, SERVICE_KEY_IDS_SETTING]));
	const idsFor = (setting: string): string[] => {
		const value = rows.find((row) => row.key === setting)?.value;
		return Array.isArray(value)
			? value.filter((entry: unknown): entry is string => typeof entry === "string")
			: [];
	};
	return { admin: idsFor(ADMIN_SERVICE_KEY_IDS_SETTING), plain: idsFor(SERVICE_KEY_IDS_SETTING) };
}

/**
 * Is this ownerless key on either list? One statement for both lists. The
 * caller has already established the key has no owner (it came from the
 * request's own key verification); an owned key is never a service key.
 */
export async function isOnServiceKeyList(keyId: string): Promise<boolean> {
	const { admin, plain } = await readServiceKeyLists();
	return admin.includes(keyId) || plain.includes(keyId);
}
