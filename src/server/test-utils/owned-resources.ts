/**
 * Shared test fixture: everything a user can own that disabling them must
 * touch or leave alone — a login session, an API key, an unused enrollment
 * token, a host with a credential, and a `sessions` row — plus a snapshot of
 * the fields that change. Not a test file; imported by the suites that
 * exercise disableUser.
 */
import { eq } from "drizzle-orm";
import { createApiKey } from "../auth/api-key.js";
import {
	createSupervisorCredential,
	createSupervisorEnrollmentToken,
} from "../auth/supervisor-auth.js";
import { getDb } from "../db/client.js";
import {
	apiKeys,
	authSessions,
	sessions,
	supervisorCredentials,
	supervisorEnrollmentTokens,
	supervisors,
	users,
} from "../db/schema/index.js";
import { issueSession } from "../services/local-auth-service.js";

export interface OwnedResources {
	userId: string;
	tokenHash: string;
	keyId: string;
	enrollmentTokenId: string;
	hostId: string;
	credentialName: string;
	sessionRowId: string;
}

export async function seedOwnedResources(userId: string): Promise<OwnedResources> {
	const label = crypto.randomUUID().slice(0, 8);
	const { tokenHash } = await issueSession({ userId });
	const { id: keyId } = await createApiKey(`owned-key-${label}`, ["manage"], userId);
	const enrollment = await createSupervisorEnrollmentToken(
		`owned-token-${label}`,
		null,
		null,
		userId,
	);
	const hostId = crypto.randomUUID();
	await getDb()
		.insert(supervisors)
		.values({
			id: hostId,
			hostName: `owned-host-${label}`,
			platform: "linux",
			arch: "x64",
			version: "0.0.0",
			ownerUserId: userId,
		});
	const credentialName = `owned-host-credential-${label}`;
	await createSupervisorCredential(hostId, credentialName);
	const sessionRowId = crypto.randomUUID();
	await getDb()
		.insert(sessions)
		.values({
			id: sessionRowId,
			sessionId: `owned-session-${sessionRowId}`,
			agentType: "claude_code",
			ownerUserId: userId,
		});
	return {
		userId,
		tokenHash,
		keyId,
		enrollmentTokenId: enrollment.info.id,
		hostId,
		credentialName,
		sessionRowId,
	};
}

export async function snapshotOwnedResources(seed: OwnedResources) {
	const db = getDb();
	const [user] = await db.select().from(users).where(eq(users.id, seed.userId));
	const loginSessions = await db
		.select()
		.from(authSessions)
		.where(eq(authSessions.tokenHash, seed.tokenHash));
	const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, seed.keyId));
	const [token] = await db
		.select()
		.from(supervisorEnrollmentTokens)
		.where(eq(supervisorEnrollmentTokens.id, seed.enrollmentTokenId));
	const [host] = await db.select().from(supervisors).where(eq(supervisors.id, seed.hostId));
	const [credential] = await db
		.select()
		.from(supervisorCredentials)
		.where(eq(supervisorCredentials.name, seed.credentialName));
	const [sessionRow] = await db.select().from(sessions).where(eq(sessions.id, seed.sessionRowId));
	return {
		disabledAt: user?.disabledAt ?? null,
		loginSessions: loginSessions.length,
		keyActive: key?.isActive,
		tokenActive: token?.isActive,
		tokenRevokedAt: token?.revokedAt ?? null,
		hostState: host?.enrollmentState,
		credentialActive: credential?.isActive,
		sessionRowOwner: sessionRow?.ownerUserId ?? null,
	};
}

/** The snapshot of a freshly seeded, enabled user. */
export const UNTOUCHED_OWNED_RESOURCES = (userId: string) => ({
	disabledAt: null,
	loginSessions: 1,
	keyActive: true,
	tokenActive: true,
	tokenRevokedAt: null,
	hostState: "active",
	credentialActive: true,
	sessionRowOwner: userId,
});
