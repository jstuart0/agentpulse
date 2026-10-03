/**
 * In TEAM mode a hook event (or native-name write) for a session that has an
 * owner, from a key owned by someone else, or from an ownerless key that isn't
 * the session's recorded ingest key, is dropped: answered 200, nothing stored,
 * no status change, no acknowledge stamp, no permission-wait transition,
 * counted on /health. Accepted: the session's own recorded key, any key of the
 * session's owner, any key when the session is unowned. In solo nothing changes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { processHookEvent, _setPreInsertRaceHookForTest } = await import(
	"../services/event-processor.js"
);
const {
	_resetCountersForTest,
	getIngestForeignKeyDroppedCount,
	getIngestOwnerMismatchCount,
	getInFlightCount,
} = await import("./ingest-counters.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

// Other files read /health expecting the not-ready state a fresh process has.
afterAll(async () => {
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
});

beforeAll(async () => {
	await initializeDatabase();
	// /health answers 503 until the database is marked ready.
	(await import("../routes/health.js")).markDbReady();
});

async function reset() {
	_setPreInsertRaceHookForTest(null);
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
	_resetCountersForTest();
}
beforeEach(reset);
afterEach(reset);

interface World {
	owner: { id: string };
	stranger: { id: string };
	ownerKey1: { id: string; key: string };
	ownerKey2: { id: string; key: string };
	strangerKey: { id: string; key: string };
	serviceKey: { id: string; key: string };
	otherServiceKey: { id: string; key: string };
}

async function world(): Promise<World> {
	const owner = await seedLocalUser("fk-owner");
	const stranger = await seedLocalUser("fk-stranger");
	return {
		owner,
		stranger,
		ownerKey1: await seedKey("fk-owner-1", ["ingest"], owner.id),
		ownerKey2: await seedKey("fk-owner-2", ["ingest"], owner.id),
		strangerKey: await seedKey("fk-stranger-key", ["ingest"], stranger.id),
		serviceKey: await seedKey("fk-service", ["ingest"]),
		otherServiceKey: await seedKey("fk-service-2", ["ingest"]),
	};
}

type KeyRow = { id: string; ownerUserId: string | null };
function ctxFor(key: KeyRow) {
	return {
		keyId: key.id,
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId: key.ownerUserId, ingestKeyId: key.id },
	};
}

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

/** An owned session created by the owner's first key. */
async function createOwned(w: World, sessionId: string) {
	await processHookEvent(
		hook(sessionId, "SessionStart"),
		"claude_code",
		ctxFor({ id: w.ownerKey1.id, ownerUserId: w.owner.id }),
	);
	expect((await row(sessionId))?.ownerUserId).toBe(w.owner.id);
}

const asKey = (k: { id: string }, ownerUserId: string | null): KeyRow => ({
	id: k.id,
	ownerUserId,
});

describe("team mode: a foreign key's event is dropped", () => {
	test("nothing is stored, nothing changes, and it is counted", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-1");
		const before = await row("fk-1");
		const eventsBefore = await eventCount("fk-1");

		const result = await processHookEvent(
			hook("fk-1", "PostToolUse", { tool_name: "Bash", cwd: "/elsewhere" }),
			"claude_code",
			ctxFor(asKey(w.strangerKey, w.stranger.id)),
		);
		expect(result.session).toBeNull();
		expect(result.events).toEqual([]);
		const after = await row("fk-1");
		expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
		expect(after?.cwd).toBe(before?.cwd);
		expect(after?.totalToolUses).toBe(before?.totalToolUses);
		expect(await eventCount("fk-1")).toBe(eventsBefore);
		expect(getIngestForeignKeyDroppedCount()).toBe(1);
	});

	test("an ownerless key that isn't the session's recorded key is dropped too", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-service-drop");
		for (const key of [w.serviceKey, w.otherServiceKey]) {
			const result = await processHookEvent(
				hook("fk-service-drop", "PostToolUse"),
				"claude_code",
				ctxFor(asKey(key, null)),
			);
			expect(result.session).toBeNull();
		}
		expect(getIngestForeignKeyDroppedCount()).toBe(2);
	});

	test("it can't reanimate a failed session", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-failed");
		const endedAt = new Date().toISOString();
		await getDb()
			.update(sessions)
			.set({ status: "failed", endedAt })
			.where(eq(sessions.sessionId, "fk-failed"));

		await processHookEvent(
			hook("fk-failed", "PreToolUse"),
			"claude_code",
			ctxFor(asKey(w.strangerKey, w.stranger.id)),
		);
		const after = await row("fk-failed");
		expect(after?.status).toBe("failed");
		expect(after?.endedAt).toBe(endedAt);
	});

	test("it can't clear the owner's WAITING with a prompt event", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-waiting");
		await getDb()
			.update(sessions)
			.set({ lastAgentTurnCompletedAt: new Date().toISOString(), isWorking: false })
			.where(eq(sessions.sessionId, "fk-waiting"));

		await processHookEvent(
			hook("fk-waiting", "UserPromptSubmit"),
			"claude_code",
			ctxFor(asKey(w.strangerKey, w.stranger.id)),
		);
		await processHookEvent(
			hook("fk-waiting", "UserAcknowledge"),
			"claude_code",
			ctxFor(asKey(w.strangerKey, w.stranger.id)),
		);
		const after = await row("fk-waiting");
		expect(after?.lastUserAcknowledgedAt).toBeNull();
		expect(after?.isWorking).toBe(false);
	});

	test("it can't open or clear a permission wait", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-perm");
		const stranger = ctxFor(asKey(w.strangerKey, w.stranger.id));

		await processHookEvent(
			hook("fk-perm", "PermissionRequest", { tool_use_id: "tu-1" }),
			"claude_code",
			stranger,
		);
		expect((await row("fk-perm"))?.metadata).not.toHaveProperty("permissionWait");

		// The owner opens one; a stranger can't clear it.
		await processHookEvent(
			hook("fk-perm", "PermissionRequest", { tool_use_id: "tu-2" }),
			"claude_code",
			ctxFor(asKey(w.ownerKey1, w.owner.id)),
		);
		const opened = (await row("fk-perm"))?.metadata as { permissionWait?: unknown };
		expect(opened.permissionWait).toBeDefined();
		for (const name of ["PermissionDenied", "PostToolUse", "UserPromptSubmit", "Stop"]) {
			await processHookEvent(
				hook("fk-perm", name, { tool_use_id: "tu-2" }),
				"claude_code",
				stranger,
			);
		}
		expect(
			((await row("fk-perm"))?.metadata as { permissionWait?: unknown }).permissionWait,
		).toEqual(opened.permissionWait);
	});

	test("the loser of a creation race to an owned session is dropped", async () => {
		await setStoredMode("team");
		const w = await world();
		_setPreInsertRaceHookForTest(async (sessionId) => {
			_setPreInsertRaceHookForTest(null);
			await processHookEvent(
				hook(sessionId, "SessionStart"),
				"claude_code",
				ctxFor(asKey(w.ownerKey1, w.owner.id)),
			);
		});
		const result = await processHookEvent(
			hook("fk-race", "PostToolUse"),
			"claude_code",
			ctxFor(asKey(w.strangerKey, w.stranger.id)),
		);
		expect(result.session).toBeNull();
		expect((await row("fk-race"))?.ownerUserId).toBe(w.owner.id);
		expect(getIngestForeignKeyDroppedCount()).toBe(1);
	});

	test("a drop on the real route is still a 200", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-route");
		const before = await row("fk-route");
		const res = await app.request(
			"/api/v1/hooks",
			jsonRequest("POST", hook("fk-route", "PostToolUse"), bearerHeaders(w.strangerKey.key)),
		);
		expect(res.status).toBe(200);
		for (let i = 0; i < 200 && getInFlightCount() > 0; i++)
			await new Promise((r) => setTimeout(r, 10));
		expect((await row("fk-route"))?.lastActivityAt).toBe(before?.lastActivityAt);
		expect(getIngestForeignKeyDroppedCount()).toBe(1);
		const health = await app.request("/api/v1/health");
		expect(((await health.json()) as { foreignKeyDropped?: number }).foreignKeyDropped).toBe(1);
	});
});

describe("team mode: what is accepted", () => {
	test("the owner's second key", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-ok-key2");
		const before = await eventCount("fk-ok-key2");
		const result = await processHookEvent(
			hook("fk-ok-key2", "PostToolUse"),
			"claude_code",
			ctxFor(asKey(w.ownerKey2, w.owner.id)),
		);
		expect(result.session).not.toBeNull();
		expect(await eventCount("fk-ok-key2")).toBeGreaterThan(before);
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
	});

	test("the session's own recorded ingest key, even when it has no owner", async () => {
		await setStoredMode("team");
		const w = await world();
		// A launched session: owned by the launcher, first reported through a service key.
		await getDb().insert(sessions).values({
			sessionId: "fk-recorded",
			agentType: "claude_code",
			status: "active",
			ownerUserId: w.owner.id,
			ingestKeyId: w.serviceKey.id,
		});
		const own = await processHookEvent(
			hook("fk-recorded", "PostToolUse"),
			"claude_code",
			ctxFor(asKey(w.serviceKey, null)),
		);
		expect(own.session).not.toBeNull();
		const other = await processHookEvent(
			hook("fk-recorded", "PostToolUse"),
			"claude_code",
			ctxFor(asKey(w.otherServiceKey, null)),
		);
		expect(other.session).toBeNull();
	});

	test("any key, when the session has no owner", async () => {
		await setStoredMode("team");
		const w = await world();
		await getDb()
			.insert(sessions)
			.values({ sessionId: "fk-unowned", agentType: "claude_code", status: "active" });
		for (const key of [asKey(w.strangerKey, w.stranger.id), asKey(w.serviceKey, null)]) {
			const result = await processHookEvent(
				hook("fk-unowned", "PostToolUse"),
				"claude_code",
				ctxFor(key),
			);
			expect(result.session).not.toBeNull();
		}
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
	});
});

describe("solo mode: unchanged", () => {
	test("a foreign key's event is accepted, and counted as a mismatch as before", async () => {
		const w = await world();
		await createOwned(w, "fk-solo");
		const result = await processHookEvent(
			hook("fk-solo", "PostToolUse"),
			"claude_code",
			ctxFor(asKey(w.strangerKey, w.stranger.id)),
		);
		expect(result.session).not.toBeNull();
		expect(getIngestForeignKeyDroppedCount()).toBe(0);
		expect(getIngestOwnerMismatchCount()).toBe(1);
	});
});

describe("statements for an existing session", () => {
	test("the owner's own key adds none: the mode is not read unless the key looks foreign", async () => {
		const w = await world();
		await createOwned(w, "fk-cost-own");
		const key = ctxFor(asKey(w.ownerKey1, w.owner.id));
		await processHookEvent(hook("fk-cost-own", "PostToolUse"), "claude_code", key);
		const own = await countDbCalls(async () => {
			await processHookEvent(hook("fk-cost-own", "PostToolUse"), "claude_code", key);
		});
		expect(own).toBe(8);
	});

	test("a foreign-looking key costs one more (the mode lookup), in solo and in team alike", async () => {
		const w = await world();
		await createOwned(w, "fk-cost-foreign");
		const stranger = ctxFor(asKey(w.strangerKey, w.stranger.id));
		await processHookEvent(hook("fk-cost-foreign", "PostToolUse"), "claude_code", stranger);
		const solo = await countDbCalls(async () => {
			await processHookEvent(hook("fk-cost-foreign", "PostToolUse"), "claude_code", stranger);
		});
		expect(solo).toBe(9);

		await setStoredMode("team");
		const team = await countDbCalls(async () => {
			await processHookEvent(hook("fk-cost-foreign", "PostToolUse"), "claude_code", stranger);
		});
		// Dropped before any write: the existence read, the mode lookup, and the
		// look at whether the session runs on the posting key owner's host.
		expect(team).toBe(3);
	});
});

describe("native-name writes follow the same rule", () => {
	const nativeName = (sessionId: string, name: string, headers: Headers) =>
		app.request(`/api/v1/sessions/${sessionId}/native-name`, jsonRequest("PUT", { name }, headers));

	test("team: a foreign key's native name is dropped (200, not applied, counted); the owner's key applies", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-name");
		const foreign = await nativeName("fk-name", "Hijacked", bearerHeaders(w.strangerKey.key));
		expect(foreign.status).toBe(200);
		expect(await foreign.json()).toEqual({ ok: true, applied: false });
		expect((await row("fk-name"))?.displayName).not.toBe("Hijacked");
		expect(getIngestForeignKeyDroppedCount()).toBe(1);

		const own = await nativeName("fk-name", "Mine", bearerHeaders(w.ownerKey2.key));
		expect(((await own.json()) as { applied: boolean }).applied).toBe(true);
		expect((await row("fk-name"))?.displayName).toBe("Mine");
	});

	test("team: rename with source sync from a foreign manage key is dropped the same way", async () => {
		await setStoredMode("team");
		const w = await world();
		const manage = await seedKey("fk-manage", ["manage"], w.stranger.id);
		await createOwned(w, "fk-sync");
		const res = await app.request(
			"/api/v1/sessions/fk-sync/rename",
			jsonRequest("PUT", { name: "Hijacked", source: "sync" }, bearerHeaders(manage.key)),
		);
		expect(res.status).toBe(200);
		expect((await row("fk-sync"))?.displayName).not.toBe("Hijacked");
	});

	test("team: a member's own cookie can't set a native name on someone else's session either", async () => {
		await setStoredMode("team");
		const w = await world();
		await createOwned(w, "fk-cookie");
		const { cookieHeadersFor } = await import("../test-utils/team-fixtures.js");
		const res = await nativeName("fk-cookie", "Hijacked", await cookieHeadersFor(w.stranger.id));
		expect(res.status).toBe(403);
		expect((await row("fk-cookie"))?.displayName).not.toBe("Hijacked");
	});

	test("solo: unchanged, any key applies", async () => {
		const w = await world();
		await createOwned(w, "fk-name-solo");
		const res = await nativeName("fk-name-solo", "Shared", bearerHeaders(w.strangerKey.key));
		expect(((await res.json()) as { applied: boolean }).applied).toBe(true);
	});
});
