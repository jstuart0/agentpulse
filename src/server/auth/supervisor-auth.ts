import { and, eq, isNull } from "drizzle-orm";
import type { SupervisorEnrollmentTokenInfo } from "../../shared/types.js";
import { getDb } from "../db/client.js";
import { supervisorCredentials, supervisorEnrollmentTokens, users } from "../db/schema/index.js";

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

function mapEnrollment(
	row: typeof supervisorEnrollmentTokens.$inferSelect,
): SupervisorEnrollmentTokenInfo {
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
		createdByUserId: row.createdByUserId ?? null,
	};
}

export async function createSupervisorEnrollmentToken(
	name: string,
	expiresAt?: string | null,
	supervisorId?: string | null,
	createdByUserId?: string | null,
) {
	const token = generateToken("ape_");
	const tokenHash = await hashToken(token);
	const tokenPrefix = token.slice(0, 11);

	const [record] = await getDb()
		.insert(supervisorEnrollmentTokens)
		.values({
			name,
			supervisorId: supervisorId ?? null,
			tokenHash,
			tokenPrefix,
			expiresAt: expiresAt ?? null,
			createdByUserId: createdByUserId ?? null,
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
	const [record] = await getDb()
		.select()
		.from(supervisorEnrollmentTokens)
		.where(eq(supervisorEnrollmentTokens.tokenHash, tokenHash))
		.limit(1);
	if (!record || !record.isActive || record.usedAt || record.revokedAt) return null;
	if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) return null;
	if (record.createdByUserId && (await isUserDisabled(record.createdByUserId))) return null;
	return mapEnrollment(record);
}

async function isUserDisabled(userId: string): Promise<boolean> {
	const [row] = await getDb()
		.select({ disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row !== undefined && row.disabledAt !== null;
}

/**
 * Marks the token used and returns it, or null when it isn't usable. The
 * update itself carries the "still active and unused" condition, so two
 * simultaneous consumes (or a consume racing the creator's disable, which
 * deactivates the token) can't both win: only the call whose update matched
 * a row gets the token back.
 */
export async function consumeEnrollmentToken(token: string) {
	const verified = await verifyEnrollmentToken(token);
	if (!verified) return null;
	const tokenHash = await hashToken(token);
	const claimed = await getDb()
		.update(supervisorEnrollmentTokens)
		.set({
			isActive: false,
			usedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(supervisorEnrollmentTokens.tokenHash, tokenHash),
				eq(supervisorEnrollmentTokens.isActive, true),
				isNull(supervisorEnrollmentTokens.usedAt),
			),
		)
		.returning({ id: supervisorEnrollmentTokens.id });
	return claimed.length > 0 ? verified : null;
}

/**
 * Deactivate (and mark revoked) every unused enrollment token a user
 * created. Part of disabling the user; accepts the admin lock's transaction
 * handle so it commits or rolls back with the rest of the disable. A token
 * that was already used or revoked keeps its history.
 */
export async function deactivateEnrollmentTokensCreatedByUser(
	userId: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx?: any,
): Promise<void> {
	await (tx ?? getDb())
		.update(supervisorEnrollmentTokens)
		.set({ isActive: false, revokedAt: new Date().toISOString() })
		.where(
			and(
				eq(supervisorEnrollmentTokens.createdByUserId, userId),
				eq(supervisorEnrollmentTokens.isActive, true),
				isNull(supervisorEnrollmentTokens.usedAt),
				isNull(supervisorEnrollmentTokens.revokedAt),
			),
		);
}

/**
 * Deactivate (and mark revoked) every unused enrollment token with no recorded
 * creator. Part of the solo to team switch, on the admin lock's transaction
 * handle: a token minted in solo can't be judged against a creator when it is
 * used, so it must not outlive the switch (a host-scoped one could re-key a
 * host). Used, revoked and creator-recorded tokens keep their state.
 */
export async function deactivateCreatorlessEnrollmentTokens(
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx: any,
): Promise<void> {
	await tx
		.update(supervisorEnrollmentTokens)
		.set({ isActive: false, revokedAt: new Date().toISOString() })
		.where(
			and(
				isNull(supervisorEnrollmentTokens.createdByUserId),
				eq(supervisorEnrollmentTokens.isActive, true),
				isNull(supervisorEnrollmentTokens.usedAt),
				isNull(supervisorEnrollmentTokens.revokedAt),
			),
		);
}

export async function revokeEnrollmentToken(id: string) {
	await getDb()
		.update(supervisorEnrollmentTokens)
		.set({
			isActive: false,
			revokedAt: new Date().toISOString(),
		})
		.where(eq(supervisorEnrollmentTokens.id, id));
}

export async function createSupervisorCredential(
	supervisorId: string,
	name: string,
	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
	tx?: any,
) {
	const token = generateToken("aps_");
	const tokenHash = await hashToken(token);
	const tokenPrefix = token.slice(0, 11);

	const [record] = await (tx ?? getDb())
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
	const [record] = await getDb()
		.select()
		.from(supervisorCredentials)
		.where(eq(supervisorCredentials.tokenHash, tokenHash))
		.limit(1);
	if (!record || !record.isActive || record.revokedAt) return null;
	getDb()
		.update(supervisorCredentials)
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

/**
 * Accepts an optional transaction handle so a caller running inside
 * withAdminLock issues this on the same tx as the rest of the sequence.
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function revokeSupervisorCredential(supervisorId: string, tx?: any) {
	await (tx ?? getDb())
		.update(supervisorCredentials)
		.set({
			isActive: false,
			revokedAt: new Date().toISOString(),
		})
		.where(eq(supervisorCredentials.supervisorId, supervisorId));
}
