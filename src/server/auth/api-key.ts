import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

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

// Create a new API key and store its hash
export async function createApiKey(name: string): Promise<{ key: string; id: string }> {
	const key = generateApiKey();
	const keyHash = await hashKey(key);
	const keyPrefix = key.slice(0, 11); // "ap_" + first 8 hex chars

	const [record] = await db
		.insert(apiKeys)
		.values({
			name,
			keyHash,
			keyPrefix,
		})
		.returning();

	return { key, id: record.id };
}

// Verify an API key and return the key record if valid
export async function verifyApiKey(key: string): Promise<{ id: string; name: string } | null> {
	if (!key || !key.startsWith("ap_")) {
		return null;
	}

	const keyHash = await hashKey(key);
	const [record] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);

	if (!record || !record.isActive) {
		return null;
	}

	// Update last used timestamp (fire and forget)
	db.update(apiKeys)
		.set({ lastUsedAt: new Date().toISOString() })
		.where(eq(apiKeys.id, record.id))
		.execute()
		.catch(() => {});

	return { id: record.id, name: record.name };
}

// Ensure at least one API key exists (for initial setup)
export async function ensureDefaultApiKey(): Promise<string | null> {
	const existing = await db.select().from(apiKeys).limit(1);
	if (existing.length > 0) {
		return null; // Already has keys
	}

	const { key } = await createApiKey("default");
	console.log(`[auth] Created default API key: ${key}`);
	console.log("[auth] Save this key -- it won't be shown again.");
	return key;
}
