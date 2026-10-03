import { eq, inArray } from "drizzle-orm";
import { withAdminLock } from "../db/admin-lock.js";
import { getDb } from "../db/client.js";
import { apiKeys, users } from "../db/schema/index.js";
import { listServiceKey } from "../services/service-key-lists.js";
import { assertOwnerActive } from "./owner-state.js";

// ── Scope constants ───────────────────────────────────────────────────────────
//
// SCOPE_MANAGE/SCOPE_OBSERVE/SCOPE_ALL are duplicated by design in
// packages/agentpulse-mcp/src/scope-constants.ts (Pattern B, D3 of
// thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md) — the
// published MCP package can't import server-internal modules. Renaming any
// of these three literals here is a cross-package breaking change; keep the
// two sites in sync.

/** Authorizes posting hook events from Claude Code / Codex. */
export const SCOPE_INGEST = "ingest";
/** Authorizes management operations: supervisor enroll/rotate/revoke, API-key CRUD. */
export const SCOPE_MANAGE = "manage";
/**
 * Authorizes read-only access to observability routes. Secret-free at the
 * REST boundary: the route allowlist (route-scope-policy.ts, OBSERVE_READ_PATHS)
 * excludes every DTO that carries env vars, launch payloads, or claim tokens.
 */
export const SCOPE_OBSERVE = "observe";
/** Wildcard — all scopes. Only valid when stored in the DB (never accepted from a client request). */
export const SCOPE_ALL = "*";

const RECOGNIZED_SCOPES = new Set([SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE]);

// ── Scope utilities ───────────────────────────────────────────────────────────

/**
 * Parse a JSON-encoded scopes string from the database.
 * Fails closed to ["ingest"] on any error (malformed JSON, non-array, non-string elements).
 */
export function parseScopes(raw?: string | null): string[] {
	try {
		const parsed = JSON.parse(raw ?? "");
		if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string" && s.length > 0)) {
			return parsed;
		}
	} catch {
		// fall through
	}
	return [SCOPE_INGEST];
}

/** Typed error thrown when an unknown scope value is supplied at key-mint time. */
export class InvalidScopeError extends Error {
	readonly value: string;
	constructor(value: string) {
		super(`Unknown scope: "${value}". Recognized values: ${[...RECOGNIZED_SCOPES].join(", ")}`);
		this.name = "InvalidScopeError";
		this.value = value;
	}
}

/** Validate scope values at mint time. Throws InvalidScopeError on any unknown value. */
function validateScopes(scopes: string[]): void {
	for (const s of scopes) {
		if (!RECOGNIZED_SCOPES.has(s)) {
			throw new InvalidScopeError(s);
		}
	}
}

// ── Key generation ────────────────────────────────────────────────────────────

// Generate a new API key: ap_<32 random hex chars>
export function generateApiKey(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `ap_${hex}`;
}

// Hash an API key using SHA-256
async function hashKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export interface CreateApiKeyOptions {
	/**
	 * A key with no owner even though a user minted it (an admin's service
	 * key), listed as a service key in the same transaction. The minting user is
	 * still recorded as its creator, which says nothing about being a service key.
	 */
	service?: boolean;
	/**
	 * Runs on the transaction that inserts the key, with its id, so work that
	 * must commit or fail with the key (listing it as a kept admin service
	 * key) can't be left half done. Takes the admin lock.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	withinTransaction?: (tx: any, keyId: string) => Promise<void>;
}

/**
 * Create a new API key and store its hash.
 * @param name        Human-readable label for the key.
 * @param scopes      Capability set. Defaults to ["ingest"]. Rejects unknown values.
 * @throws OwnerDisabledError when mintedByUserId names a disabled user.
 * @param mintedByUserId The minting caller's userId (AuthUser.userId), or null
 *   for a caller with no user — DISABLE_AUTH, boot-time bootstrap, or an
 *   existing service key minting another key. The new key's owner and
 *   creator are both this value: a key minted by a user is owned by that
 *   user; a key minted with no caller userId is a service key (both columns
 *   null). `options.service` keeps the creator but leaves the key ownerless.
 */
export async function createApiKey(
	name: string,
	scopes: string[] = [SCOPE_INGEST],
	mintedByUserId: string | null = null,
	options: CreateApiKeyOptions = {},
): Promise<{ key: string; id: string }> {
	validateScopes(scopes);

	const key = generateApiKey();
	const keyHash = await hashKey(key);
	const keyPrefix = key.slice(0, 11); // "ap_" + first 8 hex chars
	const ownerUserId = options.service ? null : mintedByUserId;

	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	const insertKey = async (handle: any) => {
		const [record] = await handle
			.insert(apiKeys)
			.values({
				name,
				keyHash,
				keyPrefix,
				scopes: JSON.stringify(scopes),
				ownerUserId,
				createdByUserId: mintedByUserId,
			})
			.returning();
		return record as { id: string };
	};

	// A key owned by a user is created under the admin lock, in the same
	// transaction as the owner check, so it can't land after (and escape) a
	// disable that revoked that user's keys. A service key is listed in the same
	// transaction as its insert: it is a service key because it is on the list,
	// so a key can't exist as one without the record.
	const record =
		ownerUserId || options.service || options.withinTransaction
			? await withAdminLock(async (tx) => {
					if (ownerUserId) await assertOwnerActive(tx, ownerUserId);
					const inserted = await insertKey(tx);
					if (options.service) await listServiceKey(inserted.id, tx);
					await options.withinTransaction?.(tx, inserted.id);
					return inserted;
				})
			: await insertKey(getDb());

	return { key, id: record.id };
}

/** What a verified key says about its owner, read in the same statement as the key. */
export interface VerifiedApiKey {
	id: string;
	name: string;
	scopes: string[];
	/** Null for a service key. */
	ownerUserId: string | null;
	/** The owner's current role; null for a service key or an owner with no row. */
	ownerRole: "user" | "admin" | null;
	/** The owner's must-change-password flag; false for a service key. */
	ownerMustChangePassword: boolean;
}

/**
 * Verify an API key and return the key record if valid.
 * Returns scopes parsed from the DB record (not from the request).
 *
 * The owner's state rides on the same statement (a left join on the primary
 * key): a key whose owner is disabled is refused here, as a backstop for a
 * disable that did not get to switch the key row off, and the owner's current
 * role and password flag come back with the key at no extra cost. A service
 * key (no owner) joins to nothing.
 */
export async function verifyApiKey(key: string): Promise<VerifiedApiKey | null> {
	if (!key || !key.startsWith("ap_")) {
		return null;
	}

	const keyHash = await hashKey(key);
	const [row] = await getDb()
		.select({
			record: apiKeys,
			ownerRole: users.role,
			ownerDisabledAt: users.disabledAt,
			ownerMustChangePassword: users.mustChangePassword,
		})
		.from(apiKeys)
		.leftJoin(users, eq(users.id, apiKeys.ownerUserId))
		.where(eq(apiKeys.keyHash, keyHash))
		.limit(1);

	if (!row || !row.record.isActive) {
		return null;
	}
	if (row.ownerDisabledAt) {
		return null;
	}
	const record = row.record;

	// Update last used timestamp (fire and forget)
	getDb()
		.update(apiKeys)
		.set({ lastUsedAt: new Date().toISOString() })
		.where(eq(apiKeys.id, record.id))
		.execute()
		.catch(() => {});

	return {
		id: record.id,
		name: record.name,
		scopes: parseScopes(record.scopes),
		ownerUserId: record.ownerUserId,
		ownerRole: row.ownerRole === "admin" ? "admin" : row.ownerRole === "user" ? "user" : null,
		ownerMustChangePassword: row.ownerMustChangePassword ?? false,
	};
}

/**
 * Deactivate every active key owned by a user, as part of disabling them. Accepts an
 * optional transaction handle so a caller running inside
 * withAdminLock issues this on the same tx as the rest of the sequence.
 * Returns the deactivated key ids (used for socket teardown / audit).
 */
export async function deactivateApiKeysOwnedByUser(
	userId: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx?: any,
): Promise<string[]> {
	const rows = await (tx ?? getDb())
		.update(apiKeys)
		.set({ isActive: false })
		.where(eq(apiKeys.ownerUserId, userId))
		.returning({ id: apiKeys.id });
	return rows.map((r: { id: string }) => r.id);
}

/**
 * Of the given key ids, those that are inactive or no longer exist — one
 * batched statement. Used by the WebSocket heartbeat sweep to close sockets
 * opened with a key that has since been revoked.
 */
export async function getInactiveApiKeyIds(keyIds: string[]): Promise<Set<string>> {
	if (keyIds.length === 0) return new Set();
	const rows = await getDb()
		.select({ id: apiKeys.id, isActive: apiKeys.isActive })
		.from(apiKeys)
		.where(inArray(apiKeys.id, keyIds));
	const active = new Set(rows.filter((r) => r.isActive).map((r) => r.id));
	return new Set(keyIds.filter((id) => !active.has(id)));
}

/**
 * Ensure at least one API key exists (for initial setup).
 * The bootstrap key gets ["ingest","manage"] so a fresh operator can manage supervisors.
 */
export async function ensureDefaultApiKey(mode: "solo" | "team" = "solo"): Promise<string | null> {
	const existing = await getDb().select().from(apiKeys).limit(1);
	if (existing.length > 0) {
		return null; // Already has keys
	}

	// In team mode an ownerless manage key would act as a plain member and look
	// like admin power; the first admin makes real keys. Ingest-only is enough
	// for hooks to work from the first minute.
	const scopes = mode === "team" ? [SCOPE_INGEST] : [SCOPE_INGEST, SCOPE_MANAGE];
	const { key } = await createApiKey("default", scopes);
	console.log(`[auth] Created default API key: ${key}`);
	console.log("[auth] Save this key -- it won't be shown again.");
	return key;
}
