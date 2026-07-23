import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { apiKeys } from "../db/schema/index.js";

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

/**
 * Create a new API key and store its hash.
 * @param name   Human-readable label for the key.
 * @param scopes Capability set. Defaults to ["ingest"]. Rejects unknown values.
 */
export async function createApiKey(
	name: string,
	scopes: string[] = [SCOPE_INGEST],
): Promise<{ key: string; id: string }> {
	validateScopes(scopes);

	const key = generateApiKey();
	const keyHash = await hashKey(key);
	const keyPrefix = key.slice(0, 11); // "ap_" + first 8 hex chars

	const [record] = await getDb()
		.insert(apiKeys)
		.values({
			name,
			keyHash,
			keyPrefix,
			scopes: JSON.stringify(scopes),
		})
		.returning();

	return { key, id: record.id };
}

/**
 * Verify an API key and return the key record if valid.
 * Returns scopes parsed from the DB record (not from the request).
 */
export async function verifyApiKey(
	key: string,
): Promise<{ id: string; name: string; scopes: string[] } | null> {
	if (!key || !key.startsWith("ap_")) {
		return null;
	}

	const keyHash = await hashKey(key);
	const [record] = await getDb()
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.keyHash, keyHash))
		.limit(1);

	if (!record || !record.isActive) {
		return null;
	}

	// Update last used timestamp (fire and forget)
	getDb()
		.update(apiKeys)
		.set({ lastUsedAt: new Date().toISOString() })
		.where(eq(apiKeys.id, record.id))
		.execute()
		.catch(() => {});

	return { id: record.id, name: record.name, scopes: parseScopes(record.scopes) };
}

/**
 * Ensure at least one API key exists (for initial setup).
 * The bootstrap key gets ["ingest","manage"] so a fresh operator can manage supervisors.
 */
export async function ensureDefaultApiKey(): Promise<string | null> {
	const existing = await getDb().select().from(apiKeys).limit(1);
	if (existing.length > 0) {
		return null; // Already has keys
	}

	const { key } = await createApiKey("default", [SCOPE_INGEST, SCOPE_MANAGE]);
	console.log(`[auth] Created default API key: ${key}`);
	console.log("[auth] Save this key -- it won't be shown again.");
	return key;
}
