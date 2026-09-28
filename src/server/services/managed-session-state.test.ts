import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { managedSessions, sessions } = await import("../db/schema/index.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
});

async function mkSession(sessionId: string, metadata: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "codex_cli",
			status: "active",
			lastActivityAt: new Date().toISOString(),
			metadata,
		})
		.execute();
}

async function readSession(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

describe("upsertManagedSessionState — metadata merge (late read-modify-write)", () => {
	test("merges input.metadata onto existing metadata for an existing session", async () => {
		await mkSession("managed-1", { existing: "value" });

		await upsertManagedSessionState("sup-1", {
			sessionId: "managed-1",
			metadata: { providerRunId: "run-1" },
		});

		const row = await readSession("managed-1");
		expect(row?.metadata).toEqual({ existing: "value", providerRunId: "run-1" });
	});

	test("preserves a concurrent writer's metadata keys (e.g. permissionWait) alongside its own", async () => {
		await mkSession("managed-2", {
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
		});

		await upsertManagedSessionState("sup-1", {
			sessionId: "managed-2",
			metadata: { providerRunId: "run-2" },
		});

		const row = await readSession("managed-2");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
			providerRunId: "run-2",
		});
	});

	test("new-session insert path is unaffected — metadata is just input.metadata", async () => {
		await upsertManagedSessionState("sup-1", {
			sessionId: "managed-new",
			metadata: { providerRunId: "run-new" },
		});

		const row = await readSession("managed-new");
		expect(row?.metadata).toEqual({ providerRunId: "run-new" });
	});
});

// F85 (ian mid-build): the returned `session` (what supervisors.ts's
// `c.json(result)` sends back to the caller verbatim) must carry
// nameSource/nativeName, not just the WS broadcast the caller can't see.
describe("upsertManagedSessionState — result.session carries nameSource/nativeName (F85)", () => {
	test("a manually-pinned session's result.session reflects nameSource:'user'", async () => {
		await mkSession("managed-pinned", { renameSource: "user", nativeName: "codex-thread-name" });

		const result = await upsertManagedSessionState("sup-1", {
			sessionId: "managed-pinned",
			metadata: { providerRunId: "run-3" },
		});

		expect(result.session.nameSource).toBe("user");
		expect(result.session.nativeName).toBe("codex-thread-name");
	});

	test("a new session's result.session defaults to nameSource:'generated'", async () => {
		const result = await upsertManagedSessionState("sup-1", {
			sessionId: "managed-generated",
		});

		expect(result.session.nameSource).toBe("generated");
		expect(result.session.nativeName).toBeNull();
	});
});
