/**
 * A prompt (resume) starts a new agent process on the supervisor, so the queued action
 * carries the launch's recorded approval policy and sandbox mode for it to re-apply.
 * A retry clones the launch row, so its privileges carry over as well.
 *
 * DB-touching: runs on both dialects.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const ACTOR: Actor = { userId: null, label: "user" };

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { queuePromptAction, retryLaunchForSession } = await import("./control-actions.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

async function seedCapableHost(id: string) {
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: id,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless", "interactive_terminal"],
				os: "linux",
				terminalSupport: ["xterm"],
				features: ["enforces_launch_privileges"],
				executables: {
					claude: { available: true, command: "claude", resolvedPath: "/bin/claude" },
				},
			},
			trustedRoots: ["/tmp"],
			status: "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			createdAt: now,
			updatedAt: now,
		} as never);
}

async function seedManaged(
	sessionId: string,
	privileges: { approvalPolicy: string | null; sandboxMode: string | null },
) {
	const launch = await seedOwnedLaunch(sessionId, "sup-A");
	await getDb()
		.update(launchRequests)
		.set(privileges)
		.where(eq(launchRequests.id, launch.launchId));
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		})
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launch.launchId,
			supervisorId: "sup-A",
			managedState: "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

describe("queuePromptAction carries the launch's privileges", () => {
	test("recorded values are copied into the action metadata", async () => {
		await seedManaged("priv-sess-1", { approvalPolicy: "manual", sandboxMode: "read-only" });
		const action = await queuePromptAction("priv-sess-1", "hello", ACTOR);
		expect(action.metadata).toMatchObject({ approvalPolicy: "manual", sandboxMode: "read-only" });
	});

	test("an unset launch is recorded as explicit nulls, so the supervisor can tell it from a missing field", async () => {
		await seedManaged("priv-sess-2", { approvalPolicy: null, sandboxMode: null });
		const action = await queuePromptAction("priv-sess-2", "hello", ACTOR);
		const metadata = action.metadata as Record<string, unknown>;
		expect("approvalPolicy" in metadata).toBe(true);
		expect(metadata.approvalPolicy).toBeNull();
		expect("sandboxMode" in metadata).toBe(true);
		expect(metadata.sandboxMode).toBeNull();
	});
});

describe("retryLaunchForSession keeps the privileges", () => {
	test("the cloned launch row has the original's approval policy and sandbox mode", async () => {
		await seedCapableHost("sup-A");
		await seedManaged("priv-sess-3", {
			approvalPolicy: "untrusted",
			sandboxMode: "danger-full-access",
		});
		const { launchRequest } = await retryLaunchForSession("priv-sess-3", ACTOR);
		expect(launchRequest.approvalPolicy).toBe("untrusted");
		expect(launchRequest.sandboxMode).toBe("danger-full-access");
	});
});
