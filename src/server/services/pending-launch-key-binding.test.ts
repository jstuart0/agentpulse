/**
 * A new session that correlates to a pending launch is owned by the launch's
 * requester, and the posting key is recorded as its ingest key (write access
 * for the life of the session). In team mode that happens only for the
 * requester's keys, the keys of the owner of the launch's target host, and
 * service keys; anyone else's first event creates nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedAdminMintedServiceKey,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { processHookEvent } = await import("./event-processor.js");
const { _resetCountersForTest, getIngestForeignKeyDroppedCount } = await import(
	"../routes/ingest-counters.js"
);

afterAll(async () => {
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
});

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
	_resetCountersForTest();
}
beforeEach(reset);
afterEach(reset);

type KeyRow = { id: string; ownerUserId: string | null };
const ctxFor = (key: KeyRow) => ({
	keyId: key.id,
	deliveryId: null,
	origin: "native" as const,
	attribution: { ownerUserId: key.ownerUserId, ingestKeyId: key.id },
});
const start = (sessionId: string) => ({ session_id: sessionId, hook_event_name: "SessionStart" });

async function row(sessionId: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return r;
}

async function world(opts: { hostChosen?: boolean; claimed?: boolean } = {}) {
	const admin = await seedLocalUser("pl-admin", "admin");
	const alice = await seedLocalUser("pl-alice");
	const bob = await seedLocalUser("pl-bob");
	const carol = await seedLocalUser("pl-carol");
	const keyOf = async (label: string, userId: string) => ({
		...(await seedKey(label, ["ingest"], userId)),
		ownerUserId: userId,
	});
	const hostId = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id: hostId,
			hostName: "pl-alice-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {},
			trustedRoots: ["/tmp"],
			status: "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			createdAt: now,
			updatedAt: now,
			ownerUserId: alice.id,
		});
	const launch = async (sessionId: string) => {
		await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: sessionId,
				agentType: "claude_code",
				cwd: "/tmp/pl-launch",
				requestedSupervisorId: opts.hostChosen === false ? null : hostId,
				claimedBySupervisorId: opts.hostChosen === false || opts.claimed === false ? null : hostId,
				status: "awaiting_session",
				requestedByUserId: bob.id,
			});
	};
	return {
		alice,
		bob,
		carol,
		aliceKey: await keyOf("pl-alice-key", alice.id),
		bobKey: await keyOf("pl-bob-key", bob.id),
		carolKey: await keyOf("pl-carol-key", carol.id),
		serviceKey: {
			...(await seedAdminMintedServiceKey("pl-service", ["ingest"], admin.id)),
			ownerUserId: null,
		},
		oldKey: { ...(await seedKey("pl-old", ["ingest"])), ownerUserId: null },
		launch,
	};
}

describe("the first event for someone else's pending launch", () => {
	test("a member posting it with their own key creates nothing; the host's real key then creates the session", async () => {
		await setStoredMode("team");
		const w = await world();
		await w.launch("pl-s1");

		const stranger = await processHookEvent(start("pl-s1"), "claude_code", ctxFor(w.carolKey));
		expect(stranger.session).toBeNull();
		expect(await row("pl-s1")).toBeUndefined();
		expect(getIngestForeignKeyDroppedCount()).toBe(1);

		const host = await processHookEvent(start("pl-s1"), "claude_code", ctxFor(w.aliceKey));
		expect(host.session).not.toBeNull();
		const created = await row("pl-s1");
		expect(created?.ownerUserId).toBe(w.bob.id);
		expect(created?.ingestKeyId).toBe(w.aliceKey.id);
	});

	test("the requester's key, and a service key, create the session and are recorded", async () => {
		await setStoredMode("team");
		const w = await world();
		await w.launch("pl-s2");
		await w.launch("pl-s3");

		await processHookEvent(start("pl-s2"), "claude_code", ctxFor(w.bobKey));
		expect((await row("pl-s2"))?.ingestKeyId).toBe(w.bobKey.id);
		await processHookEvent(start("pl-s3"), "claude_code", ctxFor(w.serviceKey));
		expect((await row("pl-s3"))?.ingestKeyId).toBe(w.serviceKey.id);
		expect((await row("pl-s3"))?.ownerUserId).toBe(w.bob.id);
	});

	test("an old ownerless key that isn't a service key creates nothing either", async () => {
		await setStoredMode("team");
		const w = await world();
		await w.launch("pl-s4");
		const result = await processHookEvent(start("pl-s4"), "claude_code", ctxFor(w.oldKey));
		expect(result.session).toBeNull();
		expect(await row("pl-s4")).toBeUndefined();
	});

	test("a launch with no chosen host: only the requester and service keys create it", async () => {
		await setStoredMode("team");
		const w = await world({ hostChosen: false });
		await w.launch("pl-s5");

		expect(
			(await processHookEvent(start("pl-s5"), "claude_code", ctxFor(w.aliceKey))).session,
		).toBeNull();
		expect(
			(await processHookEvent(start("pl-s5"), "claude_code", ctxFor(w.bobKey))).session,
		).not.toBeNull();
	});

	test("a launch not yet claimed is judged against the host it was sent to", async () => {
		await setStoredMode("team");
		const w = await world({ claimed: false });
		await w.launch("pl-s7");
		expect(
			(await processHookEvent(start("pl-s7"), "claude_code", ctxFor(w.carolKey))).session,
		).toBeNull();
		expect(
			(await processHookEvent(start("pl-s7"), "claude_code", ctxFor(w.aliceKey))).session,
		).not.toBeNull();
	});

	test("solo: any key creates it, as before", async () => {
		const w = await world();
		await w.launch("pl-s6");
		const result = await processHookEvent(start("pl-s6"), "claude_code", ctxFor(w.carolKey));
		expect(result.session).not.toBeNull();
		expect((await row("pl-s6"))?.ownerUserId).toBe(w.bob.id);
	});
});
