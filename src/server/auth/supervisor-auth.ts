import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { supervisorCredentials, supervisorEnrollmentTokens } from "../db/schema.js";
import type { SupervisorEnrollmentTokenInfo } from "../../shared/types.js";

function generateToken(prefix: string): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${prefix}${hex}`;
}

async function hashToken(token: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function extractSupervisorToken(headers: Headers | { get(name: string): string | null }) {
	const direct = headers.get("X-AgentPulse-Supervisor-Token");
	if (direct) return direct;
	const auth = headers.get("Authorization");
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	return null;
}

function mapEnrollment(row: typeof supervisorEnrollmentTokens.$inferSelect): SupervisorEnrollmentTokenInfo {
	return {
		id: row.id,
		name: row.name,
		supervisorId: row.supervisorId ?? null,
		tokenPrefix: row.tokenPrefix,
		isActive: row.isActive,
		expiresAt: row.expiresAt ?? null,
		createdAt: row.createdAt,
		usedAt: row.usedAt ?? null,
		revokedAt: row.revokedAt ?? null,
	};
}

export async function createSupervisorEnrollmentToken(
	name: string,
	expiresAt?: string | null,
	supervisorId?: string | null,
) {
	const token = generateToken("ape_");
	const tokenHash = await hashToken(token);
	const tokenPrefix = token.slice(0, 11);

	const [record] = await db
		.insert(supervisorEnrollmentTokens)
		.values({
			name,
			supervisorId: supervisorId ?? null,
			tokenHash,
			tokenPrefix,
			expiresAt: expiresAt ?? null,
		})
		.returning();

	return {
		token,
		info: mapEnrollment(record),
	};
}

export async function verifyEnrollmentToken(token: string) {
	if (!token?.startsWith("ape_")) return null;
	const tokenHash = await hashToken(token);
	const [record] = await db
		.select()
		.from(supervisorEnrollmentTokens)
		.where(eq(supervisorEnrollmentTokens.tokenHash, tokenHash))
		.limit(1);
	if (!record || !record.isActive || record.usedAt || record.revokedAt) return null;
	if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) return null;
	return mapEnrollment(record);
}

export async function consumeEnrollmentToken(token: string) {
	const verified = await verifyEnrollmentToken(token);
	if (!verified) return null;
	const tokenHash = await hashToken(token);
	const timestamp = new Date().toISOString();
	await db
		.update(supervisorEnrollmentTokens)
		.set({
			isActive: false,
			usedAt: timestamp,
		})
		.where(eq(supervisorEnrollmentTokens.tokenHash, tokenHash));
	return verified;
}

export async function revokeEnrollmentToken(id: string) {
	await db
		.update(supervisorEnrollmentTokens)
		.set({
			isActive: false,
			revokedAt: new Date().toISOString(),
		})
		.where(eq(supervisorEnrollmentTokens.id, id));
}

export async function createSupervisorCredential(supervisorId: string, name: string) {
	const token = generateToken("aps_");
	const tokenHash = await hashToken(token);
	const tokenPrefix = token.slice(0, 11);

	const [record] = await db
		.insert(supervisorCredentials)
		.values({
			supervisorId,
			name,
			tokenHash,
			tokenPrefix,
		})
		.onConflictDoUpdate({
			target: supervisorCredentials.supervisorId,
			set: {
				name,
				tokenHash,
				tokenPrefix,
				isActive: true,
				lastUsedAt: null,
				revokedAt: null,
			},
		})
		.returning();

	return {
		token,
		id: record.id,
		tokenPrefix: record.tokenPrefix,
	};
}

export async function verifySupervisorCredential(token: string) {
	if (!token?.startsWith("aps_")) return null;
	const tokenHash = await hashToken(token);
	const [record] = await db
		.select()
		.from(supervisorCredentials)
		.where(eq(supervisorCredentials.tokenHash, tokenHash))
		.limit(1);
	if (!record || !record.isActive || record.revokedAt) return null;
	db.update(supervisorCredentials)
		.set({ lastUsedAt: new Date().toISOString() })
		.where(eq(supervisorCredentials.id, record.id))
		.execute()
		.catch(() => {});
	return {
		id: record.id,
		supervisorId: record.supervisorId,
		name: record.name,
	};
}

export async function revokeSupervisorCredential(supervisorId: string) {
	await db
		.update(supervisorCredentials)
		.set({
			isActive: false,
			revokedAt: new Date().toISOString(),
		})
		.where(eq(supervisorCredentials.supervisorId, supervisorId));
}
