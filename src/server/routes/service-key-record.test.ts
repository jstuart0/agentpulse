/**
 * "Service key" is an explicit record, never inferred. A key counts as one
 * only when it is on one of the two protected lists: minting with
 * `service: true` puts it there (in the same transaction as the key), and an
 * admin's PATCH can add or remove it. Handing a member's key to nobody leaves
 * it ownerless and undecided: it can't attach to someone else's launched
 * session, and it shows in `undecidedServiceKeys` until an admin decides.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const {
	events,
	launchRequests,
	managedSessions,
	sessions,
	settings,
	supervisorCredentials,
	supervisors,
} = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
const { processHookEvent } = await import("../services/event-processor.js");
const { _resetCountersForTest } = await import("./ingest-counters.js");

afterAll(async () => {
	(await import("./health.js"))._resetDbReadyForTest(false);
});
beforeAll(async () => {
	await initializeDatabase();
	(await import("./health.js")).markDbReady();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(sessions);
	await getDb().delete(supervisorCredentials);
	await getDb().delete(supervisors);
	_resetCountersForTest();
}
beforeEach(reset);
afterEach(reset);

const call = (path: string, method: string, body: unknown, headers: Headers) =>
	app.request(`/api/v1${path}`, jsonRequest(method, body, headers));

async function listValue(key: string): Promise<string[]> {
	const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
	return (row?.value as string[] | undefined) ?? [];
}

async function world() {
	await setStoredMode("team");
	const admin = await seedLocalUser("sk-admin", "admin");
	const hostOwner = await seedLocalUser("sk-host-owner");
	const launcher = await seedLocalUser("sk-launcher");
	const member = await seedLocalUser("sk-member");
	const memberKey = await seedKey("sk-member-key", ["ingest"], member.id);

	const hostId = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id: hostId,
			hostName: "sk-host",
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
			ownerUserId: hostOwner.id,
		});
	const { token } = await createSupervisorCredential(hostId, "sk-host-credential");
	return {
		admin,
		adminCookie: await cookieHeadersFor(admin.id),
		launcher,
		member,
		memberKey,
		hostId,
		hostCredential: token,
	};
}
type World = Awaited<ReturnType<typeof world>>;

/** The launcher starts a session on someone else's host: owned by them, no recorded key. */
async function launchOnHost(w: World, sessionId: string): Promise<void> {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/sk-launch",
			requestedSupervisorId: w.hostId,
			claimedBySupervisorId: w.hostId,
			status: "launching",
			requestedByUserId: w.launcher.id,
		})
		.returning();
	const res = await app.request(
		`/api/v1/supervisors/${w.hostId}/managed-session-state`,
		jsonRequest(
			"POST",
			{ sessionId, agentType: "claude_code", launchRequestId: launch.id, managedState: "managed" },
			new Headers({ Authorization: `Bearer ${w.hostCredential}` }),
		),
	);
	expect(res.status).toBe(200);
}

const hook = (sessionId: string, toolUseId: string) => ({
	session_id: sessionId,
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_use_id: toolUseId,
});
const ownerless = (id: string) => ({
	keyId: id,
	deliveryId: null,
	origin: "native" as const,
	attribution: { ownerUserId: null, ingestKeyId: id },
});

async function sessionRow(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

async function undecidedCount(w: World): Promise<number> {
	const res = await call("/instance", "GET", undefined, w.adminCookie);
	return ((await res.json()) as { counts: { undecidedServiceKeys: number } }).counts
		.undecidedServiceKeys;
}

async function keyRow(w: World, id: string) {
	const res = await call("/api-keys", "GET", undefined, w.adminCookie);
	const { keys } = (await res.json()) as {
		keys: Array<{ id: string; serviceKey: boolean; adminService: boolean }>;
	};
	return keys.find((k) => k.id === id);
}

describe("an admin clears the owner of a member's key", () => {
	test("the key is ownerless and undecided: not a service key, counted, and dropped on a launched session", async () => {
		const w = await world();
		await launchOnHost(w, "sk-cleared");
		const res = await call(
			`/api-keys/${w.memberKey.id}`,
			"PATCH",
			{ ownerUserId: null },
			w.adminCookie,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { serviceKey: boolean }).serviceKey).toBe(false);

		expect((await keyRow(w, w.memberKey.id))?.serviceKey).toBe(false);
		expect(await undecidedCount(w)).toBe(1);

		const attempt = await processHookEvent(
			hook("sk-cleared", "t1"),
			"claude_code",
			ownerless(w.memberKey.id),
		);
		expect(attempt.session).toBeNull();
		expect((await sessionRow("sk-cleared"))?.ingestKeyId).toBeNull();
	});

	test("positive control: the same request with serviceKey: true makes it a service key that attaches", async () => {
		const w = await world();
		await launchOnHost(w, "sk-decided");
		const res = await call(
			`/api-keys/${w.memberKey.id}`,
			"PATCH",
			{ ownerUserId: null, serviceKey: true },
			w.adminCookie,
		);
		expect(res.status).toBe(200);

		expect((await keyRow(w, w.memberKey.id))?.serviceKey).toBe(true);
		expect(await undecidedCount(w)).toBe(0);
		const attempt = await processHookEvent(
			hook("sk-decided", "t1"),
			"claude_code",
			ownerless(w.memberKey.id),
		);
		expect(attempt.session).not.toBeNull();
		expect((await sessionRow("sk-decided"))?.ingestKeyId).toBe(w.memberKey.id);
	});
});

describe("minting with service: true", () => {
	test("a key without manage scope goes on the plain list, in the same request", async () => {
		const w = await world();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "sk-ci", scopes: ["ingest"], service: true },
			w.adminCookie,
		);
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };

		expect(await listValue("instance.serviceKeyIds")).toContain(id);
		expect((await keyRow(w, id))?.serviceKey).toBe(true);
		expect(await undecidedCount(w)).toBe(0);
	});

	test("a key with manage scope goes on the admin list and is a service key", async () => {
		const w = await world();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "sk-ops", scopes: ["manage"], service: true },
			w.adminCookie,
		);
		const { id } = (await res.json()) as { id: string };
		expect(await listValue("instance.adminServiceKeyIds")).toContain(id);
		expect((await keyRow(w, id))?.serviceKey).toBe(true);
	});

	test("a key an admin minted for themselves (no service flag) is theirs, not a service key", async () => {
		const w = await world();
		const res = await call(
			"/api-keys",
			"POST",
			{ name: "sk-mine", scopes: ["ingest"] },
			w.adminCookie,
		);
		const { id } = (await res.json()) as { id: string };
		expect((await keyRow(w, id))?.serviceKey).toBe(false);
		expect(await listValue("instance.serviceKeyIds")).not.toContain(id);
	});
});

describe("serviceKey: false", () => {
	test("un-marks a key that was minted as a service key, which then stops attaching", async () => {
		const w = await world();
		await launchOnHost(w, "sk-unmark");
		const minted = await call(
			"/api-keys",
			"POST",
			{ name: "sk-temp", scopes: ["ingest"], service: true },
			w.adminCookie,
		);
		const { id } = (await minted.json()) as { id: string };
		expect((await keyRow(w, id))?.serviceKey).toBe(true);

		const res = await call(`/api-keys/${id}`, "PATCH", { serviceKey: false }, w.adminCookie);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { serviceKey: boolean }).serviceKey).toBe(false);
		expect((await keyRow(w, id))?.serviceKey).toBe(false);
		expect(await undecidedCount(w)).toBe(1);

		const attempt = await processHookEvent(hook("sk-unmark", "t1"), "claude_code", ownerless(id));
		expect(attempt.session).toBeNull();
	});
});
