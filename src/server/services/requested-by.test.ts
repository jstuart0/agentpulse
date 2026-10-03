/**
 * Real requestedBy / resolvedBy: launch requests, control actions, and
 * the scratch-cleanup action carry the caller's real user id, not a
 * hardcoded placeholder. DISABLE_AUTH writes the anonymous actor.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests, controlActions, supervisors, projects } = await import(
	"../db/schema/index.js"
);
const { actorFromAuthUser, ANONYMOUS_ACTOR } = await import("../auth/actor.js");
const { createValidatedLaunchRequest } = await import("./launch-validator.js");
const { queueCleanupWorkArea } = await import("./control-actions.js");

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(launchRequests);
	await getDb().delete(controlActions);
	await getDb().delete(supervisors);
	await getDb().delete(projects);
});

describe("actorFromAuthUser — the pure resolution helper", () => {
	test("a local or SSO caller with a userId → label 'user', that userId", () => {
		const actor = actorFromAuthUser({
			source: "local",
			name: "alice",
			userId: "user-alice",
			keyId: null,
			mustChangePassword: false,
			displayName: null,
		});
		expect(actor).toEqual({ userId: "user-alice", label: "user" });
	});

	test("an owned API key → label 'api_key', the key's owner", () => {
		const actor = actorFromAuthUser({
			source: "api_key",
			name: "my-key",
			id: "key-1",
			userId: "user-bob",
			keyId: "key-1",
			mustChangePassword: false,
			displayName: null,
		});
		expect(actor).toEqual({ userId: "user-bob", label: "api_key" });
	});

	test("DISABLE_AUTH's synthetic 'anonymous' api_key caller → the anonymous actor, not label 'api_key'", () => {
		const actor = actorFromAuthUser({
			source: "api_key",
			name: "anonymous",
			id: "anonymous",
			userId: null,
			keyId: null,
			mustChangePassword: false,
			displayName: null,
		});
		expect(actor).toEqual(ANONYMOUS_ACTOR);
	});

	test("no caller at all (undefined) → the anonymous actor", () => {
		expect(actorFromAuthUser(undefined)).toEqual(ANONYMOUS_ACTOR);
	});
});

describe("launch requests carry the real requester", () => {
	test("createValidatedLaunchRequest stamps requested_by_user_id and the legacy label from the real actor", async () => {
		const supervisorId = `sup-${crypto.randomUUID()}`;
		await getDb()
			.insert(supervisors)
			.values({
				id: supervisorId,
				hostName: "host",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["headless"],
					os: "linux",
					terminalSupport: [],
					features: [],
				},
				trustedRoots: [],
				status: "connected",
				lastHeartbeatAt: new Date().toISOString(),
				heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});

		const fixtureId = crypto.randomUUID();
		const { launchRequest } = await createValidatedLaunchRequest(
			{
				template: {
					name: `requested-by-fixture-${fixtureId}`,
					agentType: "claude_code" as const,
					cwd: `/tmp/requested-by-fixture-${fixtureId}`,
				},
				requestedSupervisorId: supervisorId,
				launchSpec: {
					version: 1 as const,
					launchCorrelationId: crypto.randomUUID(),
					managedMode: "unmanaged_preview" as const,
					agentType: "claude_code" as const,
					cwd: `/tmp/requested-by-fixture-${fixtureId}`,
					model: null,
					approvalPolicy: null,
					sandboxMode: null,
					baseInstructions: "",
					taskPrompt: "",
					env: {},
					providerConfig: {
						command: "claude",
						cliArgs: [],
						instructionsFile: "CLAUDE.md" as const,
					},
				},
			},
			{ userId: "user-launcher", label: "user" },
		);

		expect(launchRequest.requestedByUserId).toBe("user-launcher");

		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchRequest.id));
		expect(row.requestedBy).toBe("user");
	});

	test("DISABLE_AUTH writes the anonymous actor: requested_by_user_id null, requested_by 'anonymous'", async () => {
		const supervisorId = `sup-${crypto.randomUUID()}`;
		await getDb()
			.insert(supervisors)
			.values({
				id: supervisorId,
				hostName: "host2",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["headless"],
					os: "linux",
					terminalSupport: [],
					features: [],
				},
				trustedRoots: [],
				status: "connected",
				lastHeartbeatAt: new Date().toISOString(),
				heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});

		const fixtureId = crypto.randomUUID();
		const { launchRequest } = await createValidatedLaunchRequest(
			{
				template: {
					name: `requested-by-fixture-2-${fixtureId}`,
					agentType: "claude_code" as const,
					cwd: `/tmp/requested-by-fixture-2-${fixtureId}`,
				},
				requestedSupervisorId: supervisorId,
				launchSpec: {
					version: 1 as const,
					launchCorrelationId: crypto.randomUUID(),
					managedMode: "unmanaged_preview" as const,
					agentType: "claude_code" as const,
					cwd: `/tmp/requested-by-fixture-2-${fixtureId}`,
					model: null,
					approvalPolicy: null,
					sandboxMode: null,
					baseInstructions: "",
					taskPrompt: "",
					env: {},
					providerConfig: {
						command: "claude",
						cliArgs: [],
						instructionsFile: "CLAUDE.md" as const,
					},
				},
			},
			ANONYMOUS_ACTOR,
		);

		expect(launchRequest.requestedByUserId).toBeNull();
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchRequest.id));
		expect(row.requestedBy).toBe("anonymous");
	});
});

describe("no hardcoded placeholder actor remains", () => {
	test('the literal "local-user" string is gone from every production source file', async () => {
		const { readdir, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");

		async function* walk(dir: string): AsyncGenerator<string> {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					yield* walk(full);
				} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
					yield full;
				}
			}
		}

		const hits: string[] = [];
		const root = join(import.meta.dir, "..");
		for await (const file of walk(root)) {
			const text = await readFile(file, "utf-8");
			if (text.includes('"local-user"')) hits.push(file);
		}

		expect(hits).toEqual([]);
	});
});

describe("scratch cleanup carries the requester (previously missed)", () => {
	test("queueCleanupWorkArea stamps requested_by_user_id from the real caller", async () => {
		const action = await queueCleanupWorkArea(
			{
				projectId: `proj-${crypto.randomUUID()}`,
				cwd: `/tmp/scratch-requested-by-fixture-${crypto.randomUUID()}`,
				targetSupervisorId: `sup-${crypto.randomUUID()}`,
			},
			{ userId: "user-cleanup-caller", label: "user" },
		);
		expect(action.requestedByUserId).toBe("user-cleanup-caller");

		const [row] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, action.id));
		expect(row.requestedBy).toBe("user");
	});
});
