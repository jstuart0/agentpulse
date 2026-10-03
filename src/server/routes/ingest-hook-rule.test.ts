/**
 * Team-mode rule for an event addressed to an OWNED session, on /hooks,
 * /hooks/status and the native-name write. Accepted when any holds:
 *  (a) the posting key's owner is the session's owner;
 *  (b) the posting key is the session's recorded ingest key;
 *  (c) the session is supervisor-managed and the posting key's owner is that
 *      host's owner;
 *  (d) the session has a host of record (a managed row or a claimed launch),
 *      no recorded ingest key, and the posting key is an ownerless SERVICE key
 *      (admin-minted as one, kept as an admin service key, or listed as a
 *      plain service key): accepted, and that key becomes the session's
 *      ingest key, but only once the event is actually applied.
 * Otherwise dropped (200, nothing stored, counted). Unowned sessions accept any
 * key; solo is unchanged.
 *
 * The sessions here are created through the supervisor's own report path, the
 * way a launch on someone else's host creates them: owned by the launcher, no
 * recorded ingest key.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	jsonRequest,
	seedAdminMintedServiceKey,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
	setServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, launchRequests, managedSessions, sessions, supervisorCredentials, supervisors } =
	await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createSupervisorCredential } = await import("../auth/supervisor-auth.js");
const { processHookEvent, processStatusUpdate } = await import("../services/event-processor.js");
const { _resetCountersForTest, getInFlightCount, getIngestForeignKeyDroppedCount } = await import(
	"./ingest-counters.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

// Other files read /health expecting the not-ready state a fresh process has.
afterAll(async () => {
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
});

beforeAll(async () => {
	await initializeDatabase();
	(await import("../routes/health.js")).markDbReady();
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

type KeyRow = { id: string; ownerUserId: string | null };
const ctxFor = (key: KeyRow, origin: "native" | "codex-observer" = "native") => ({
	keyId: key.id,
	deliveryId: null,
	origin,
	attribution: { ownerUserId: key.ownerUserId, ingestKeyId: key.id },
});
const hook = (sessionId: string, eventName: string, extra: Record<string, unknown> = {}) => ({
	session_id: sessionId,
	hook_event_name: eventName,
	...extra,
});
async function row(sessionId: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return r;
}
async function eventCount(sessionId: string) {
	return (await getDb().select().from(events).where(eq(events.sessionId, sessionId))).length;
}
async function settled() {
	for (let i = 0; i < 300 && getInFlightCount() > 0; i++)
		await new Promise((r) => setTimeout(r, 10));
}

async function world() {
	const alice = await seedLocalUser("hr-alice");
	const bob = await seedLocalUser("hr-bob");
	const carol = await seedLocalUser("hr-carol");
	const aliceKey = {
		...(await seedKey("hr-alice-key", ["ingest"], alice.id)),
		ownerUserId: alice.id,
	};
	const bobKey = { ...(await seedKey("hr-bob-key", ["ingest"], bob.id)), ownerUserId: bob.id };
	const carolKey = {
		...(await seedKey("hr-carol-key", ["ingest"], carol.id)),
		ownerUserId: carol.id,
	};
	const admin = await seedLocalUser("hr-admin", "admin");
	const hostKey1 = {
		...(await seedAdminMintedServiceKey("hr-host-key-1", ["ingest"], admin.id)),
		ownerUserId: null,
	};
	const hostKey2 = {
		...(await seedAdminMintedServiceKey("hr-host-key-2", ["ingest"], admin.id)),
		ownerUserId: null,
	};
	// An ownerless key nobody has decided about: what every pre-switch shared key and the default key are.
	const oldKey = { ...(await seedKey("hr-old-key", ["ingest"])), ownerUserId: null };
	const hostId = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id: hostId,
			hostName: "hr-alice-host",
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
	const { token: hostCredential } = await createSupervisorCredential(hostId, "hr-host-credential");
	return {
		alice,
		bob,
		carol,
		aliceKey,
		bobKey,
		carolKey,
		admin,
		hostKey1,
		hostKey2,
		oldKey,
		hostId,
		hostCredential,
	};
}
type World = Awaited<ReturnType<typeof world>>;

/** Bob launches on Alice's host; the supervisor reports the session. Owned by Bob, no ingest key. */
async function launchOnHost(w: World, sessionId: string): Promise<void> {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/hr-launch",
			requestedSupervisorId: w.hostId,
			claimedBySupervisorId: w.hostId,
			status: "launching",
			requestedByUserId: w.bob.id,
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
	const created = await row(sessionId);
	expect(created?.ownerUserId).toBe(w.bob.id);
	expect(created?.ingestKeyId).toBeNull();
}

describe("a session the supervisor created for a launch on someone else's host", () => {
	test("the launcher's own key and the host owner's key are both accepted", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-s1");

		const asHostOwner = await processHookEvent(
			hook("hr-s1", "PostToolUse", { tool_name: "Bash" }),
			"claude_code",
			ctxFor(w.aliceKey),
		);
		expect(asHostOwner.session).not.toBeNull();
		expect(asHostOwner.events.length).toBeGreaterThan(0);

		const asLauncher = await processHookEvent(
			hook("hr-s1", "PostToolUse", { tool_name: "Bash", tool_use_id: "t2" }),
			"claude_code",
			ctxFor(w.bobKey),
		);
		expect(asLauncher.session).not.toBeNull();
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
		expect((await row("hr-s1"))?.ingestKeyId).toBeNull();
	});

	test("a third user's key is dropped", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-s2");
		const before = await eventCount("hr-s2");

		const result = await processHookEvent(
			hook("hr-s2", "PostToolUse"),
			"claude_code",
			ctxFor(w.carolKey),
		);

		expect(result.session).toBeNull();
		expect(await eventCount("hr-s2")).toBe(before);
		expect(getIngestForeignKeyDroppedCount()).toBe(1);
	});

	test("an ownerless host key is accepted and recorded on its first event; a second ownerless key is dropped", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-s3");

		const first = await processHookEvent(
			hook("hr-s3", "PostToolUse", { tool_name: "Bash" }),
			"claude_code",
			ctxFor(w.hostKey1),
		);
		expect(first.session).not.toBeNull();
		const bound = await row("hr-s3");
		expect(bound?.ingestKeyId).toBe(w.hostKey1.id);
		expect(bound?.ownerUserId).toBe(w.bob.id);

		const second = await processHookEvent(
			hook("hr-s3", "PostToolUse", { tool_name: "Bash", tool_use_id: "t2" }),
			"claude_code",
			ctxFor(w.hostKey2),
		);
		expect(second.session).toBeNull();
		expect(getIngestForeignKeyDroppedCount()).toBe(1);

		// After the binding: the bound key, the owner's keys and the host owner's keys.
		for (const [key, id] of [
			[w.hostKey1, "t3"],
			[w.bobKey, "t4"],
			[w.aliceKey, "t5"],
		] as const) {
			const ok = await processHookEvent(
				hook("hr-s3", "PostToolUse", { tool_name: "Bash", tool_use_id: id }),
				"claude_code",
				ctxFor(key),
			);
			expect(ok.session).not.toBeNull();
		}
		expect(
			(await processHookEvent(hook("hr-s3", "PostToolUse"), "claude_code", ctxFor(w.carolKey)))
				.session,
		).toBeNull();
	});

	test("the binding is counted on /health", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-s4");
		await processHookEvent(hook("hr-s4", "PostToolUse"), "claude_code", ctxFor(w.hostKey1));
		await processHookEvent(hook("hr-s4", "PostToolUse"), "claude_code", ctxFor(w.hostKey1));

		const health = await app.request("/api/v1/health");
		expect(((await health.json()) as { ingestKeyBound?: number }).ingestKeyBound).toBe(1);
	});

	test("the Codex observer posting with the host's key is stored", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-s5");

		const owned = await processHookEvent(
			hook("hr-s5", "PostToolUse", { tool_name: "Bash" }),
			"codex_cli",
			ctxFor(w.aliceKey, "codex-observer"),
		);
		expect(owned.session).not.toBeNull();

		const ownerless = await processHookEvent(
			hook("hr-s5", "PostToolUse", { tool_name: "Bash", tool_use_id: "o2" }),
			"codex_cli",
			ctxFor(w.hostKey1, "codex-observer"),
		);
		expect(ownerless.session).not.toBeNull();
		expect(await eventCount("hr-s5")).toBeGreaterThanOrEqual(2);
	});

	test("the Codex observer's HTTP delivery is judged the same way", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-s5-http");
		const send = (key: string, toolUseId: string) =>
			app.request(
				"/api/v1/hooks",
				jsonRequest(
					"POST",
					{
						session_id: "hr-s5-http",
						hook_event_name: "PostToolUse",
						tool_name: "Bash",
						tool_use_id: toolUseId,
					},
					bearerHeaders(key, {
						"X-Agent-Type": "codex_cli",
						"X-AgentPulse-Origin": "codex-observer",
					}),
				),
			);

		expect((await send(w.carolKey.key, "h1")).status).toBe(200);
		await settled();
		expect(await eventCount("hr-s5-http")).toBe(0);
		expect((await send(w.aliceKey.key, "h2")).status).toBe(200);
		await settled();
		expect(await eventCount("hr-s5-http")).toBeGreaterThanOrEqual(1);
		expect(getIngestForeignKeyDroppedCount()).toBe(1);
	});

	test("the host owner's key is accepted only for a managed session on that host", async () => {
		await setStoredMode("team");
		const w = await world();
		// Owned by Bob, created by Bob's own key: not managed, so Alice's key is foreign to it.
		await processHookEvent(hook("hr-plain", "SessionStart"), "claude_code", ctxFor(w.bobKey));
		const result = await processHookEvent(
			hook("hr-plain", "PostToolUse"),
			"claude_code",
			ctxFor(w.aliceKey),
		);
		expect(result.session).toBeNull();
	});
});

/** An owned session an admin claimed after the fact: owned, no recorded key, no host of record. */
async function claimedHistoricalSession(w: World, sessionId: string): Promise<void> {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", ownerUserId: null });
	const { claimUnassignedSessions } = await import("../services/session-owner-admin.js");
	await claimUnassignedSessions(w.bob.id);
	const claimed = await row(sessionId);
	expect(claimed?.ownerUserId).toBe(w.bob.id);
	expect(claimed?.ingestKeyId).toBeNull();
}

describe("only a service key may attach to a session that has a host of record and no recorded key", () => {
	test("an old ownerless key (not a service key) is dropped on a fresh launch and binds nothing; the host's service key then binds", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-old-launch");
		const before = await eventCount("hr-old-launch");

		const old = await processHookEvent(
			hook("hr-old-launch", "PostToolUse", { tool_name: "Bash" }),
			"claude_code",
			ctxFor(w.oldKey),
		);
		expect(old.session).toBeNull();
		expect(await eventCount("hr-old-launch")).toBe(before);
		expect((await row("hr-old-launch"))?.ingestKeyId).toBeNull();
		expect(getIngestForeignKeyDroppedCount()).toBe(1);

		const real = await processHookEvent(
			hook("hr-old-launch", "PostToolUse", { tool_name: "Bash", tool_use_id: "r1" }),
			"claude_code",
			ctxFor(w.hostKey1),
		);
		expect(real.session).not.toBeNull();
		expect((await row("hr-old-launch"))?.ingestKeyId).toBe(w.hostKey1.id);
		expect((await row("hr-old-launch"))?.ownerUserId).toBe(w.bob.id);
	});

	test("on a session an admin claimed for a person (no host of record) no ownerless key attaches, service key or not", async () => {
		await setStoredMode("team");
		const w = await world();
		await claimedHistoricalSession(w, "hr-claimed");

		for (const key of [w.oldKey, w.hostKey1]) {
			const result = await processHookEvent(
				hook("hr-claimed", "PostToolUse"),
				"claude_code",
				ctxFor(key),
			);
			expect(result.session).toBeNull();
		}
		expect((await row("hr-claimed"))?.ingestKeyId).toBeNull();
		expect(getIngestForeignKeyDroppedCount()).toBe(2);
		// The person it was claimed for still can.
		expect(
			(await processHookEvent(hook("hr-claimed", "PostToolUse"), "claude_code", ctxFor(w.bobKey)))
				.session,
		).not.toBeNull();
	});

	test("a key listed as a plain service key, and one kept as an admin service key, bind on a launched session", async () => {
		await setStoredMode("team");
		const w = await world();
		const listed = { ...(await seedKey("hr-listed", ["ingest"])), ownerUserId: null };
		const kept = { ...(await seedKey("hr-kept", ["ingest", "manage"])), ownerUserId: null };
		await setServiceKeyList([listed.id]);
		await setAdminServiceKeyList([kept.id]);
		await launchOnHost(w, "hr-listed-s");
		await launchOnHost(w, "hr-kept-s");

		expect(
			(await processHookEvent(hook("hr-listed-s", "PostToolUse"), "claude_code", ctxFor(listed)))
				.session,
		).not.toBeNull();
		expect((await row("hr-listed-s"))?.ingestKeyId).toBe(listed.id);
		expect((await row("hr-listed-s"))?.ownerUserId).toBe(w.bob.id);
		expect(
			(await processHookEvent(hook("hr-kept-s", "PostToolUse"), "claude_code", ctxFor(kept)))
				.session,
		).not.toBeNull();
		expect((await row("hr-kept-s"))?.ingestKeyId).toBe(kept.id);
		expect((await row("hr-kept-s"))?.ownerUserId).toBe(w.bob.id);
	});

	test("events between the session row and the managed row are judged against the launch's host", async () => {
		await setStoredMode("team");
		const w = await world();
		await getDb().insert(launchRequests).values({
			launchCorrelationId: "hr-gap",
			agentType: "claude_code",
			cwd: "/tmp/hr-gap",
			requestedSupervisorId: w.hostId,
			claimedBySupervisorId: w.hostId,
			status: "launching",
			requestedByUserId: w.bob.id,
		});
		await getDb().insert(sessions).values({
			sessionId: "hr-gap",
			agentType: "claude_code",
			status: "active",
			ownerUserId: w.bob.id,
		});

		expect(
			(await processHookEvent(hook("hr-gap", "PostToolUse"), "claude_code", ctxFor(w.aliceKey)))
				.session,
		).not.toBeNull();
		expect(
			(await processHookEvent(hook("hr-gap", "PostToolUse"), "claude_code", ctxFor(w.carolKey)))
				.session,
		).toBeNull();
		expect(
			(await processHookEvent(hook("hr-gap", "PostToolUse"), "claude_code", ctxFor(w.oldKey)))
				.session,
		).toBeNull();
		expect(
			(await processHookEvent(hook("hr-gap", "PostToolUse"), "claude_code", ctxFor(w.hostKey1)))
				.session,
		).not.toBeNull();
		expect((await row("hr-gap"))?.ingestKeyId).toBe(w.hostKey1.id);
		expect((await row("hr-gap"))?.ownerUserId).toBe(w.bob.id);
	});

	test("a refused acknowledge binds nothing", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-ack");

		const result = await processHookEvent(
			hook("hr-ack", "UserAcknowledge"),
			"claude_code",
			ctxFor(w.hostKey1),
		);
		expect(result.session).toBeNull();
		expect((await row("hr-ack"))?.ingestKeyId).toBeNull();
	});

	test("a native-name that doesn't apply binds nothing", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-name-pinned");
		await getDb()
			.update(sessions)
			.set({ metadata: { renameSource: "user" } })
			.where(eq(sessions.sessionId, "hr-name-pinned"));

		const res = await app.request(
			"/api/v1/sessions/hr-name-pinned/native-name",
			jsonRequest("PUT", { name: "Agent chosen" }, bearerHeaders(w.hostKey1.key)),
		);
		expect(await res.json()).toEqual({ ok: true, applied: false });
		expect((await row("hr-name-pinned"))?.ingestKeyId).toBeNull();
	});
});

describe("binding is guarded in SQL, not just in memory", () => {
	test("a stale snapshot with no recorded key can't overwrite a key that bound in the meantime", async () => {
		const { judgeForeignKeyWrite, commitForeignKeyVerdict } = await import(
			"../services/authorization.js"
		);
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-race");
		// What a second request read before the first one's binding landed.
		const stale = await row("hr-race");
		expect(stale?.ingestKeyId).toBeNull();
		const verdict = await judgeForeignKeyWrite(
			{ sessionId: "hr-race", ownerUserId: stale?.ownerUserId ?? null, ingestKeyId: null },
			{ ownerUserId: null, ingestKeyId: w.hostKey2.id },
		);
		expect(verdict).toEqual({ drop: false, bindKeyId: w.hostKey2.id });

		// The first service key binds in between.
		await processHookEvent(hook("hr-race", "PostToolUse"), "claude_code", ctxFor(w.hostKey1));
		expect((await row("hr-race"))?.ingestKeyId).toBe(w.hostKey1.id);

		expect(await commitForeignKeyVerdict("hr-race", verdict)).toBe(false);
		const after = await row("hr-race");
		expect(after?.ingestKeyId).toBe(w.hostKey1.id);
		expect(after?.ownerUserId).toBe(w.bob.id);
		// The key that already won is let through again by the same guard.
		expect(
			await commitForeignKeyVerdict("hr-race", { drop: false, bindKeyId: w.hostKey1.id }),
		).toBe(true);
	});
});

describe("unowned sessions and solo are unchanged", () => {
	test("any key on an unowned session; nothing is bound", async () => {
		await setStoredMode("team");
		const w = await world();
		await getDb()
			.insert(sessions)
			.values({ sessionId: "hr-unowned", agentType: "claude_code", status: "active" });
		for (const key of [w.carolKey, w.hostKey1]) {
			expect(
				(await processHookEvent(hook("hr-unowned", "PostToolUse"), "claude_code", ctxFor(key)))
					.session,
			).not.toBeNull();
		}
		expect((await row("hr-unowned"))?.ingestKeyId).toBeNull();
	});

	test("solo: every key is accepted and nothing is bound", async () => {
		const w = await world();
		await launchOnHost(w, "hr-solo");
		for (const key of [w.carolKey, w.hostKey1]) {
			expect(
				(await processHookEvent(hook("hr-solo", "PostToolUse"), "claude_code", ctxFor(key)))
					.session,
			).not.toBeNull();
		}
		expect((await row("hr-solo"))?.ingestKeyId).toBeNull();
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
	});
});

describe("statements for an existing session's event", () => {
	test("the owner's own key adds none; each other case is pinned", async () => {
		const w = await world();
		await processHookEvent(hook("hr-cost", "SessionStart"), "claude_code", ctxFor(w.bobKey));
		await launchOnHost(w, "hr-cost-bind");
		const run = (sessionId: string, key: KeyRow, tool: string) =>
			countDbCalls(async () => {
				await processHookEvent(
					hook(sessionId, "PostToolUse", { tool_name: tool }),
					"claude_code",
					ctxFor(key),
				);
			});
		await run("hr-cost", w.bobKey, "warm");

		expect(await run("hr-cost", w.bobKey, "own")).toBe(8);
		// Solo: a foreign-looking key costs the mode read.
		expect(await run("hr-cost", w.carolKey, "solo-foreign")).toBe(9);

		await setStoredMode("team");
		// Dropped: the existence read, the mode read, and the managed-host lookup.
		expect(await run("hr-cost", w.carolKey, "team-foreign")).toBe(3);
		// Dropped: an ownerless key when a key is already recorded needs only the mode read.
		expect(await run("hr-cost", w.hostKey1, "team-ownerless-recorded")).toBe(2);
		// Dropped: a key that is not a service key costs the mode, the host lookup and one read
		// of the two lists, only on this rare path.
		await launchOnHost(w, "hr-cost-old");
		expect(await run("hr-cost-old", w.oldKey, "team-old-key")).toBe(4);
		// Bound on the first event: the mode read, the host lookup, the list read and the binding
		// write, then the event as usual.
		expect(await run("hr-cost-bind", w.hostKey1, "team-bind")).toBe(BOUND_FIRST_EVENT);
		// After the binding the bound key is the recorded key and costs nothing extra.
		expect(await run("hr-cost-bind", w.hostKey1, "team-bound")).toBe(8);
		// Dropped: a second ownerless key.
		expect(await run("hr-cost-bind", w.hostKey2, "team-other-ownerless")).toBe(2);
	});
});

const BOUND_FIRST_EVENT = 12;

describe("statements for a status update", () => {
	test("the owner's key adds none; a dropped foreign key costs the read, the mode and the host lookup", async () => {
		const w = await world();
		await processHookEvent(hook("hr-status-cost", "SessionStart"), "claude_code", ctxFor(w.bobKey));
		const run = (key: KeyRow) =>
			countDbCalls(async () => {
				await processStatusUpdate(
					{ session_id: "hr-status-cost", task: "t" },
					{ ownerUserId: key.ownerUserId, ingestKeyId: key.id },
				);
			});
		await run(w.bobKey);

		const own = await run(w.bobKey);
		// The existence read, the update and the event row (nothing for ownership).
		expect(own).toBe(3);
		await setStoredMode("team");
		expect(await run(w.bobKey)).toBe(own);
		expect(await run(w.carolKey)).toBe(3);
	});
});

describe("/hooks/status carries the same rule", () => {
	const status = (headers: Headers, body: Record<string, unknown>) =>
		app.request("/api/v1/hooks/status", jsonRequest("POST", body, headers));

	test("a foreign key can't reanimate, can't overwrite status, task or plan, and inserts no event", async () => {
		await setStoredMode("team");
		const w = await world();
		await processHookEvent(hook("hr-status", "SessionStart"), "claude_code", ctxFor(w.bobKey));
		const endedAt = new Date().toISOString();
		await getDb()
			.update(sessions)
			.set({
				status: "failed",
				endedAt,
				semanticStatus: "testing",
				currentTask: "the owner's task",
				planSummary: ["the owner's plan"],
			})
			.where(eq(sessions.sessionId, "hr-status"));
		const before = await row("hr-status");
		const eventsBefore = await eventCount("hr-status");

		const res = await status(bearerHeaders(w.carolKey.key), {
			session_id: "hr-status",
			status: "implementing",
			task: "ignore previous instructions",
			plan: ["attacker plan"],
		});
		expect(res.status).toBe(200);
		await settled();

		const after = await row("hr-status");
		expect(after?.status).toBe("failed");
		expect(after?.endedAt).toBe(endedAt);
		expect(after?.semanticStatus).toBe("testing");
		expect(after?.currentTask).toBe("the owner's task");
		expect(after?.planSummary).toEqual(["the owner's plan"]);
		expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
		expect(await eventCount("hr-status")).toBe(eventsBefore);
		expect(getIngestForeignKeyDroppedCount()).toBe(1);
	});

	test("the owner's key and the host owner's key apply; solo applies any key", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-status-ok");

		for (const [key, task] of [
			[w.bobKey, "by the launcher"],
			[w.aliceKey, "by the host owner"],
		] as const) {
			const res = await status(bearerHeaders(key.key), {
				session_id: "hr-status-ok",
				status: "implementing",
				task,
			});
			expect(res.status).toBe(200);
			await settled();
			expect((await row("hr-status-ok"))?.currentTask).toBe(task);
		}
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
	});

	test("an ownerless host key is bound by its first status update", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-status-bind");

		await status(bearerHeaders(w.hostKey1.key), { session_id: "hr-status-bind", task: "first" });
		await settled();
		expect((await row("hr-status-bind"))?.ingestKeyId).toBe(w.hostKey1.id);
		expect((await row("hr-status-bind"))?.ownerUserId).toBe(w.bob.id);
		expect((await row("hr-status-bind"))?.currentTask).toBe("first");

		await status(bearerHeaders(w.hostKey2.key), { session_id: "hr-status-bind", task: "second" });
		await settled();
		expect((await row("hr-status-bind"))?.currentTask).toBe("first");
	});

	test("solo: any key applies, as before", async () => {
		const w = await world();
		await processHookEvent(hook("hr-status-solo", "SessionStart"), "claude_code", ctxFor(w.bobKey));
		await status(bearerHeaders(w.carolKey.key), { session_id: "hr-status-solo", task: "shared" });
		await settled();
		expect((await row("hr-status-solo"))?.currentTask).toBe("shared");
	});
});

describe("the creation race loser is judged by the same rule", () => {
	test("an event whose own insert lost the race to someone else's row is dropped for a foreign key, and binds nothing for an old one", async () => {
		const { _setPreInsertRaceHookForTest } = await import("../services/event-processor.js");
		await setStoredMode("team");
		const w = await world();
		const winner = async (sessionId: string) => {
			await getDb()
				.insert(sessions)
				.values({ sessionId, agentType: "claude_code", status: "active", ownerUserId: w.bob.id });
		};
		try {
			for (const [sessionId, key] of [
				["hr-race-carol", w.carolKey],
				["hr-race-old", w.oldKey],
			] as const) {
				_setPreInsertRaceHookForTest(async (id) => {
					if (id === sessionId) await winner(sessionId);
				});
				const result = await processHookEvent(
					hook(sessionId, "SessionStart"),
					"claude_code",
					ctxFor(key),
				);
				expect(result.session).toBeNull();
				expect(await eventCount(sessionId)).toBe(0);
				expect((await row(sessionId))?.ingestKeyId).toBeNull();
				expect((await row(sessionId))?.ownerUserId).toBe(w.bob.id);
			}
			expect(getIngestForeignKeyDroppedCount()).toBe(2);
		} finally {
			_setPreInsertRaceHookForTest(null);
		}
	});
});

describe("the native-name write follows the same rule", () => {
	test("a service key's applied name is bound; the sync rename route binds the same way; another service key is then dropped", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-name-bind");
		await launchOnHost(w, "hr-rename-bind");

		const named = await nativeName("hr-name-bind", "From the agent", bearerHeaders(w.hostKey1.key));
		expect(((await named.json()) as { applied: boolean }).applied).toBe(true);
		expect((await row("hr-name-bind"))?.ingestKeyId).toBe(w.hostKey1.id);
		expect((await row("hr-name-bind"))?.ownerUserId).toBe(w.bob.id);
		const second = await nativeName("hr-name-bind", "Another", bearerHeaders(w.hostKey2.key));
		expect(await second.json()).toEqual({ ok: true, applied: false });
		expect((await row("hr-name-bind"))?.displayName).toBe("From the agent");

		// The relay's name sync uses a manage-scoped key.
		const manageKey = await seedAdminMintedServiceKey("hr-manage-svc", ["manage"], w.admin.id);
		const synced = await app.request(
			"/api/v1/sessions/hr-rename-bind/rename",
			jsonRequest("PUT", { name: "Synced", source: "sync" }, bearerHeaders(manageKey.key)),
		);
		expect(synced.status).toBe(200);
		expect((await row("hr-rename-bind"))?.ingestKeyId).toBe(manageKey.id);
		expect((await row("hr-rename-bind"))?.ownerUserId).toBe(w.bob.id);
	});

	const nativeName = (sessionId: string, name: string, headers: Headers) =>
		app.request(`/api/v1/sessions/${sessionId}/native-name`, jsonRequest("PUT", { name }, headers));

	test("the host owner's key applies on a supervisor-created session; a third user's is dropped", async () => {
		await setStoredMode("team");
		const w = await world();
		await launchOnHost(w, "hr-name");

		const dropped = await nativeName("hr-name", "Hijacked", bearerHeaders(w.carolKey.key));
		expect(await dropped.json()).toEqual({ ok: true, applied: false });
		const applied = await nativeName("hr-name", "From the host", bearerHeaders(w.aliceKey.key));
		expect(((await applied.json()) as { applied: boolean }).applied).toBe(true);
		expect((await row("hr-name"))?.displayName).toBe("From the host");
	});
});
