/**
 * Service keys: API keys with no owner that an admin has explicitly marked as
 * service keys, by listing them on `instance.adminServiceKeyIds` (ownerless
 * manage keys with admin authority) or `instance.serviceKeyIds` (plain
 * service keys). Nothing is inferred: an ownerless key that is on neither
 * list is undecided, however it came to have no owner. This module owns the
 * key operations that must keep the lists honest — revoking a listed key or
 * giving it an owner takes it off them in the same transaction.
 *
 * Every write here runs under the admin lock and uses the transaction
 * handle it is given; reads accept an optional handle so a locked caller
 * (the mode switch) sees its own transaction's view.
 */
import { and, eq, isNull } from "drizzle-orm";
import { SCOPE_ALL, SCOPE_MANAGE, parseScopes } from "../auth/api-key.js";
import { assertOwnerActive, assertOwnerAssignable } from "../auth/owner-state.js";
import { withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { apiKeys, sessions, users } from "../db/schema/index.js";
import {
	delistAdminServiceKey,
	delistServiceKey,
	getAdminServiceKeyIds,
	getServiceKeyIds,
	listAdminServiceKey,
	listServiceKey,
} from "./service-key-lists.js";

export {
	ADMIN_SERVICE_KEY_IDS_SETTING,
	SERVICE_KEY_IDS_SETTING,
	delistAdminServiceKey,
	delistServiceKey,
	getAdminServiceKeyIds,
	getServiceKeyIds,
	listAdminServiceKey,
	listServiceKey,
	writeAdminServiceKeyIds,
} from "./service-key-lists.js";

export interface ServiceKeySummary {
	id: string;
	name: string;
	keyPrefix: string;
}

/** Off both lists: a revoked key, or one that now has an owner, is neither kind of service key. */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function delistFromAllServiceKeyLists(keyId: string, tx: any): Promise<void> {
	await delistAdminServiceKey(keyId, tx);
	await delistServiceKey(keyId, tx);
}

/**
 * Is this key row a service key? Only an ownerless key on one of the two
 * lists. The creator is not consulted: every user-minted key has one, and a
 * key whose owner an admin cleared must not silently become a service key.
 */
export function isServiceKeyRow(
	row: { id: string; ownerUserId: string | null },
	lists: { admin: readonly string[]; plain: readonly string[] },
): boolean {
	if (row.ownerUserId !== null) return false;
	return lists.admin.includes(row.id) || lists.plain.includes(row.id);
}

/** How many active ownerless keys are on neither list: still waiting for an admin's decision. */
export async function countUndecidedServiceKeys(): Promise<number> {
	const [keys, admin, plain] = await Promise.all([
		getDb()
			.select({ id: apiKeys.id, ownerUserId: apiKeys.ownerUserId })
			.from(apiKeys)
			.where(and(isNull(apiKeys.ownerUserId), eq(apiKeys.isActive, true))),
		getAdminServiceKeyIds(),
		getServiceKeyIds(),
	]);
	return keys.filter((key) => !isServiceKeyRow(key, { admin, plain })).length;
}

/** Every active key with no owner and manage or wildcard scope, listed or not. */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function listActiveOwnerlessManageKeys(handle?: any): Promise<ServiceKeySummary[]> {
	const rows = await (handle ?? getDb())
		.select()
		.from(apiKeys)
		.where(and(isNull(apiKeys.ownerUserId), eq(apiKeys.isActive, true)))
		.orderBy(apiKeys.createdAt, apiKeys.id);
	return rows
		.filter((row: typeof apiKeys.$inferSelect) => {
			const scopes = parseScopes(row.scopes);
			return scopes.includes(SCOPE_MANAGE) || scopes.includes(SCOPE_ALL);
		})
		.map((row: typeof apiKeys.$inferSelect) => ({
			id: row.id,
			name: row.name,
			keyPrefix: row.keyPrefix,
		}));
}

/** The ownerless manage keys that aren't on the list: the ones team mode treats as plain members. */
export async function listUndecidedServiceKeys(): Promise<ServiceKeySummary[]> {
	const [keys, kept] = await Promise.all([
		listActiveOwnerlessManageKeys(),
		getAdminServiceKeyIds(),
	]);
	return keys.filter((key) => !kept.includes(key.id));
}

/** Deactivates a key and takes it off the list. False when there is no such key. */
export async function revokeApiKey(keyId: string): Promise<boolean> {
	return withAdminLock(async (tx) => {
		const [existing] = await tx
			.select({ id: apiKeys.id })
			.from(apiKeys)
			.where(eq(apiKeys.id, keyId))
			.limit(1);
		if (!existing) return false;
		await tx.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, keyId));
		await delistFromAllServiceKeyLists(keyId, tx);
		return true;
	});
}

/**
 * Sets (or clears, with null) a key's owner. Giving a key an owner takes it
 * off the admin-service list: its authority is now its owner's role. Refuses a
 * disabled owner. False when there is no such key.
 */
export async function reassignApiKeyOwner(
	keyId: string,
	ownerUserId: string | null,
): Promise<boolean> {
	return withAdminLock(async (tx) => {
		const [existing] = await tx
			.select({ id: apiKeys.id })
			.from(apiKeys)
			.where(eq(apiKeys.id, keyId))
			.limit(1);
		if (!existing) return false;
		if (ownerUserId) await assertOwnerActive(tx, ownerUserId);
		await tx.update(apiKeys).set({ ownerUserId }).where(eq(apiKeys.id, keyId));
		if (ownerUserId) await delistFromAllServiceKeyLists(keyId, tx);
		return true;
	});
}

export class KeyHasOwnerError extends Error {
	constructor() {
		super("A key with an owner is not an admin service key; its authority is its owner's role.");
		this.name = "KeyHasOwnerError";
	}
}

export class KeyNotManageError extends Error {
	constructor() {
		super("Only a key with manage scope can be kept as an admin service key.");
		this.name = "KeyNotManageError";
	}
}

export class HumanAdminRequiredForOwnerError extends Error {
	constructor() {
		super(
			"Only a signed-in admin can give a key to an admin, or give any owner to a key that can manage.",
		);
		this.name = "HumanAdminRequiredForOwnerError";
	}
}

export interface ApiKeyPatch {
	/** A user id to hand the key to, or null to make it a service key. Absent leaves the owner alone. */
	ownerUserId?: string | null;
	/** With an owner: also give that user the sessions this key reported while it had none. */
	attributeSessions?: boolean;
	/** Keep (true) or stop keeping (false) the key as an admin service key. Not together with an owner. */
	adminService?: boolean;
	/**
	 * Keep (true) or stop keeping (false) the key on the plain service-key list.
	 * Ownerless keys only. Applies to a key minted as a service key too, since
	 * minting is just a listing.
	 */
	serviceKey?: boolean;
}

export type ApiKeyPatchResult =
	| { found: false }
	| { found: true; attributedSessions: number; adminService: boolean; serviceKey: boolean };

/**
 * A caller that isn't a signed-in admin (an admin's key, a kept service key)
 * can't use a handover to keep admin power after its own key is gone: it may
 * not give a key to an admin, nor give anyone a key that can manage.
 */
async function assertHandoverIsNotAnEscalation(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
	key: typeof apiKeys.$inferSelect,
	newOwnerUserId: string,
): Promise<void> {
	const scopes = parseScopes(key.scopes);
	if (scopes.includes(SCOPE_MANAGE) || scopes.includes(SCOPE_ALL)) {
		throw new HumanAdminRequiredForOwnerError();
	}
	const [target] = await tx
		.select({ role: users.role })
		.from(users)
		.where(eq(users.id, newOwnerUserId))
		.limit(1);
	if (target?.role === "admin") throw new HumanAdminRequiredForOwnerError();
}

/**
 * An admin's change to a key, all or nothing under the admin lock: its owner
 * (a user checked in the same transaction, or null for a service key), the
 * sessions it reported as a service key, and whether it is kept as an admin
 * service key. Giving a key an owner takes it off the kept list.
 */
export async function applyApiKeyPatch(
	keyId: string,
	patch: ApiKeyPatch,
	callerIsHumanAdmin: boolean,
): Promise<ApiKeyPatchResult> {
	return withAdminLock(async (tx) => {
		const [existing] = await tx.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
		if (!existing) return { found: false as const };

		// Every refusal comes before the first write.
		const ownerAfter = patch.ownerUserId !== undefined ? patch.ownerUserId : existing.ownerUserId;
		if (patch.ownerUserId !== undefined && patch.ownerUserId !== null) {
			await assertOwnerAssignable(tx, patch.ownerUserId);
			if (!callerIsHumanAdmin)
				await assertHandoverIsNotAnEscalation(tx, existing, patch.ownerUserId);
		}
		if (patch.adminService === true) {
			if (ownerAfter !== null) throw new KeyHasOwnerError();
			const scopes = parseScopes(existing.scopes);
			if (!scopes.includes(SCOPE_MANAGE) && !scopes.includes(SCOPE_ALL)) {
				throw new KeyNotManageError();
			}
		}
		if (patch.serviceKey !== undefined && ownerAfter !== null) throw new KeyHasOwnerError();

		let attributedSessions = 0;
		if (patch.ownerUserId !== undefined) {
			await tx.update(apiKeys).set({ ownerUserId: patch.ownerUserId }).where(eq(apiKeys.id, keyId));
			await delistAdminServiceKey(keyId, tx);
			if (patch.ownerUserId !== null) await delistServiceKey(keyId, tx);
			if (patch.attributeSessions && patch.ownerUserId !== null) {
				const attributed = await tx
					.update(sessions)
					.set({ ownerUserId: patch.ownerUserId })
					.where(and(eq(sessions.ingestKeyId, keyId), isNull(sessions.ownerUserId)))
					.returning({ id: sessions.id });
				attributedSessions = attributed.length;
			}
		}

		if (patch.adminService === true) {
			await listAdminServiceKey(keyId, tx);
		} else if (patch.adminService === false) {
			await delistAdminServiceKey(keyId, tx);
		}

		if (patch.serviceKey !== undefined) {
			if (patch.serviceKey) await listServiceKey(keyId, tx);
			else await delistServiceKey(keyId, tx);
		}

		const admin = await getAdminServiceKeyIds(tx);
		const plain = await getServiceKeyIds(tx);
		return {
			found: true as const,
			attributedSessions,
			adminService: admin.includes(keyId),
			serviceKey: isServiceKeyRow({ id: keyId, ownerUserId: ownerAfter }, { admin, plain }),
		};
	});
}
