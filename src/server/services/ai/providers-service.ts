import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { llmProviders } from "../../db/schema.js";
import type { ProviderKind } from "./llm/types.js";
import { credentialHint, encryptSecret, decryptSecret } from "./secrets.js";

export interface ProviderRecord {
	id: string;
	userId: string;
	name: string;
	kind: ProviderKind;
	model: string;
	baseUrl: string | null;
	credentialHint: string;
	isDefault: boolean;
	createdAt: string;
	updatedAt: string;
}

function toRecord(row: typeof llmProviders.$inferSelect): ProviderRecord {
	return {
		id: row.id,
		userId: row.userId,
		name: row.name,
		kind: row.kind as ProviderKind,
		model: row.model,
		baseUrl: row.baseUrl,
		credentialHint: row.credentialHint,
		isDefault: row.isDefault,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export interface CreateProviderInput {
	userId?: string;
	name: string;
	kind: ProviderKind;
	model: string;
	baseUrl?: string | null;
	apiKey: string;
	isDefault?: boolean;
}

export async function createProvider(input: CreateProviderInput): Promise<ProviderRecord> {
	const userId = input.userId ?? "local";
	const now = new Date().toISOString();
	const ciphertext = encryptSecret(input.apiKey);
	const hint = credentialHint(input.apiKey);

	// If this is being marked default, clear any existing default for this user.
	if (input.isDefault) {
		await db
			.update(llmProviders)
			.set({ isDefault: false, updatedAt: now })
			.where(and(eq(llmProviders.userId, userId), eq(llmProviders.isDefault, true)));
	}

	const [row] = await db
		.insert(llmProviders)
		.values({
			userId,
			name: input.name,
			kind: input.kind,
			model: input.model,
			baseUrl: input.baseUrl ?? null,
			credentialCiphertext: ciphertext,
			credentialHint: hint,
			isDefault: input.isDefault ?? false,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return toRecord(row);
}

export async function listProviders(userId = "local"): Promise<ProviderRecord[]> {
	const rows = await db
		.select()
		.from(llmProviders)
		.where(eq(llmProviders.userId, userId))
		.orderBy(desc(llmProviders.isDefault), desc(llmProviders.updatedAt));
	return rows.map(toRecord);
}

export async function getProvider(id: string): Promise<ProviderRecord | null> {
	const [row] = await db
		.select()
		.from(llmProviders)
		.where(eq(llmProviders.id, id))
		.limit(1);
	return row ? toRecord(row) : null;
}

export async function getProviderApiKey(id: string): Promise<string | null> {
	const [row] = await db
		.select()
		.from(llmProviders)
		.where(eq(llmProviders.id, id))
		.limit(1);
	if (!row) return null;
	return decryptSecret(row.credentialCiphertext);
}

export async function getDefaultProvider(userId = "local"): Promise<ProviderRecord | null> {
	const [row] = await db
		.select()
		.from(llmProviders)
		.where(and(eq(llmProviders.userId, userId), eq(llmProviders.isDefault, true)))
		.limit(1);
	return row ? toRecord(row) : null;
}

export interface UpdateProviderInput {
	name?: string;
	model?: string;
	baseUrl?: string | null;
	apiKey?: string;
	isDefault?: boolean;
}

export async function updateProvider(id: string, input: UpdateProviderInput): Promise<ProviderRecord | null> {
	const existing = await getProvider(id);
	if (!existing) return null;
	const now = new Date().toISOString();

	if (input.isDefault) {
		await db
			.update(llmProviders)
			.set({ isDefault: false, updatedAt: now })
			.where(
				and(eq(llmProviders.userId, existing.userId), eq(llmProviders.isDefault, true)),
			);
	}

	const updates: Partial<typeof llmProviders.$inferInsert> = { updatedAt: now };
	if (input.name !== undefined) updates.name = input.name;
	if (input.model !== undefined) updates.model = input.model;
	if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
	if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
	if (input.apiKey !== undefined) {
		updates.credentialCiphertext = encryptSecret(input.apiKey);
		updates.credentialHint = credentialHint(input.apiKey);
	}

	await db.update(llmProviders).set(updates).where(eq(llmProviders.id, id));
	return getProvider(id);
}

export async function deleteProvider(id: string): Promise<boolean> {
	const result = await db.delete(llmProviders).where(eq(llmProviders.id, id)).returning();
	return result.length > 0;
}
