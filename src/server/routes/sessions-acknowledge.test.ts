// POST /api/v1/sessions/:sessionId/acknowledge (AGEN) — dashboard "mark as
// seen". Stamps lastUserAcknowledgedAt only, subject to the ownership rule:
// counts only for the session's owner, an unowned session, or when auth is
// disabled; otherwise a 200 no-op ({ acknowledged: false, reason: "not_owner" }).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createApiKey, SCOPE_MANAGE, SCOPE_OBSERVE } = await import("../auth/api-key.js");
const { createUser, issueSession, SESSION_COOKIE_NAME } = await import(
	"../services/local-auth-service.js"
);
const { _resetBucketsForTest, _setRateLimitClockForTest, RATE_LIMIT_CAPACITY, tryConsume } =
	await import("../middleware/hook-rate-limit.js");
const { sessionBus } = await import("../services/notifier.js");
const { getOperationalStatus } = await import("../../shared/session-state.js");

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
	_resetBucketsForTest();
});

afterEach(() => {
	_setRateLimitClockForTest(null);
	_resetBucketsForTest();
});

async function seedSession(
	sessionId: string,
	ownerUserId: string | null = null,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: "2026-10-01T09:00:00.000Z",
			ownerUserId,
			metadata: {},
			...overrides,
		})
		.execute();
}

async function getRow(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

function cookieHeaders(token: string): Headers {
	return new Headers({ Cookie: `${SESSION_COOKIE_NAME}=${token}` });
}

function bearerHeaders(key: string): Headers {
	return new Headers({ Authorization: `Bearer ${key}` });
}

async function acknowledge(sessionId: string, headers: Headers) {
	return app.request(`/api/v1/sessions/${sessionId}/acknowledge`, { method: "POST", headers });
}

async function unacknowledge(sessionId: string, headers: Headers) {
	return app.request(`/api/v1/sessions/${sessionId}/acknowledge`, { method: "DELETE", headers });
}

/** Counts session_updated broadcasts fired on sessionBus during `fn`. */
async function countBroadcasts(fn: () => Promise<unknown>): Promise<number> {
	let count = 0;
	const listener = () => {
		count += 1;
	};
	sessionBus.on("session_updated", listener);
	try {
		await fn();
	} finally {
		sessionBus.off("session_updated", listener);
	}
	return count;
}

describe("POST /sessions/:sessionId/acknowledge", () => {
	test("unknown session -> 404, nothing stored", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await acknowledge("does-not-exist", new Headers());
			expect(res.status).toBe(404);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("DISABLE_AUTH=true: acknowledges an owned session for any caller", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			await seedSession("s-disable-auth", "owner-x", {
				lastAgentTurnCompletedAt: "2026-10-01T08:59:00.000Z",
			});
			const res = await acknowledge("s-disable-auth", new Headers());
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ acknowledged: true });
			const row = await getRow("s-disable-auth");
			expect(row?.lastUserAcknowledgedAt).not.toBeNull();
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("unowned session: any authenticated caller acknowledges", async () => {
		const user = await createUser({
			username: `ack-unowned-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: user.id });
		await seedSession("s-unowned", null, {
			lastAgentTurnCompletedAt: "2026-10-01T08:59:00.000Z",
		});

		const res = await acknowledge("s-unowned", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: true });
		const row = await getRow("s-unowned");
		expect(row?.lastUserAcknowledgedAt).not.toBeNull();
	});

	test("owner: acknowledges their own session", async () => {
		const owner = await createUser({
			username: `ack-owner-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await seedSession("s-owned-by-owner", owner.id, {
			lastAgentTurnCompletedAt: "2026-10-01T08:59:00.000Z",
		});

		const res = await acknowledge("s-owned-by-owner", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: true });
		const row = await getRow("s-owned-by-owner");
		expect(row?.lastUserAcknowledgedAt).not.toBeNull();
	});

	test("non-owner member: 200 no-op, reason not_owner, nothing stamped or stored", async () => {
		const owner = await createUser({
			username: `ack-owner2-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const other = await createUser({
			username: `ack-other-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: other.id });
		await seedSession("s-owned-by-owner2", owner.id);
		const before = await getRow("s-owned-by-owner2");

		const res = await acknowledge("s-owned-by-owner2", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: false, reason: "not_owner" });

		const after = await getRow("s-owned-by-owner2");
		expect(after?.lastUserAcknowledgedAt).toBe(before?.lastUserAcknowledgedAt ?? null);
		expect(after?.lastActivityAt).toBe(before?.lastActivityAt ?? "");
		const stored = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "s-owned-by-owner2"));
		expect(stored).toHaveLength(0);
	});

	test("manage-scoped key owned by the session owner: acknowledges", async () => {
		const owner = await createUser({
			username: `ack-owner3-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key } = await createApiKey("ack-owner-key", [SCOPE_MANAGE], owner.id);
		await seedSession("s-owned-by-owner3", owner.id);

		const res = await acknowledge("s-owned-by-owner3", bearerHeaders(key));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: true });
	});

	test("manage-scoped key with no owner (service key) acting on an owned session: 200 no-op, reason not_owner", async () => {
		const owner = await createUser({
			username: `ack-svc-owner-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key } = await createApiKey("ack-service-key", [SCOPE_MANAGE]);
		await seedSession("s-owned-service-key", owner.id);

		const res = await acknowledge("s-owned-service-key", bearerHeaders(key));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: false, reason: "not_owner" });
		const row = await getRow("s-owned-service-key");
		expect(row?.lastUserAcknowledgedAt).toBeNull();
	});

	test("ingest-scoped key: rejected by route scope before ownership is ever consulted", async () => {
		const { SCOPE_INGEST } = await import("../auth/api-key.js");
		const owner = await createUser({
			username: `ack-ingest-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key } = await createApiKey("ack-ingest-key", [SCOPE_INGEST], owner.id);
		await seedSession("s-owned-ingest-scope", owner.id);

		const res = await acknowledge("s-owned-ingest-scope", bearerHeaders(key));
		expect(res.status).toBe(403);
		const row = await getRow("s-owned-ingest-scope");
		expect(row?.lastUserAcknowledgedAt).toBeNull();
	});

	test("manage-scoped key owned by someone else: 200 no-op, reason not_owner", async () => {
		const owner = await createUser({
			username: `ack-owner4-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const someoneElse = await createUser({
			username: `ack-someoneelse-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key } = await createApiKey("ack-someone-else-key", [SCOPE_MANAGE], someoneElse.id);
		await seedSession("s-owned-by-owner4", owner.id);

		const res = await acknowledge("s-owned-by-owner4", bearerHeaders(key));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: false, reason: "not_owner" });
	});

	test("observe-scoped key: rejected by route scope before ownership is ever consulted", async () => {
		const owner = await createUser({
			username: `ack-owner5-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key } = await createApiKey("ack-observe-key", [SCOPE_OBSERVE], owner.id);
		await seedSession("s-owned-by-owner5", owner.id);

		const res = await acknowledge("s-owned-by-owner5", bearerHeaders(key));
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "insufficient_scope", required: "manage" });
		const row = await getRow("s-owned-by-owner5");
		expect(row?.lastUserAcknowledgedAt).toBeNull();
	});

	test("idempotent: two consecutive calls from the owner both succeed", async () => {
		const owner = await createUser({
			username: `ack-owner6-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await seedSession("s-idempotent", owner.id);

		const first = await acknowledge("s-idempotent", cookieHeaders(token));
		expect(first.status).toBe(200);
		const second = await acknowledge("s-idempotent", cookieHeaders(token));
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ acknowledged: true });
	});

	test("stamps only lastUserAcknowledgedAt — isWorking, status and lastActivityAt are untouched", async () => {
		const owner = await createUser({
			username: `ack-owner7-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-side-effects",
				agentType: "claude_code",
				status: "active",
				isWorking: true,
				// A pending turn (AGEN): without one there's nothing to
				// acknowledge, and the idempotent no-op path would skip the
				// write entirely — this test is about what else does/doesn't
				// move when there IS something to acknowledge.
				lastAgentTurnCompletedAt: "2026-10-01T08:59:00.000Z",
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();

		const res = await acknowledge("s-side-effects", cookieHeaders(token));
		expect(res.status).toBe(200);
		const row = await getRow("s-side-effects");
		expect(row?.isWorking).toBe(true);
		expect(row?.status).toBe("active");
		expect(row?.lastActivityAt).toBe("2026-10-01T09:00:00.000Z");
		expect(row?.lastUserAcknowledgedAt).not.toBeNull();
	});

	test("stores exactly one user_ack event with source dashboard", async () => {
		const owner = await createUser({
			username: `ack-owner8-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await seedSession("s-event-row", owner.id, {
			lastAgentTurnCompletedAt: "2026-10-01T08:59:00.000Z",
		});

		await acknowledge("s-event-row", cookieHeaders(token));
		const stored = await getDb().select().from(events).where(eq(events.sessionId, "s-event-row"));
		expect(stored).toHaveLength(1);
		expect(stored[0]?.eventType).toBe("UserAcknowledge");
		expect(stored[0]?.category).toBe("user_ack");
		expect((stored[0]?.rawPayload as Record<string, unknown>)?.source).toBe("dashboard");
	});
});

describe("POST /sessions/:sessionId/acknowledge — classifier effects", () => {
	test("acknowledging a failed session moves it out of ERROR into COMPLETED", async () => {
		const { getOperationalStatus } = await import("../../shared/session-state.js");
		const owner = await createUser({
			username: `ack-error-dismiss-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-error-dismiss",
				agentType: "claude_code",
				status: "failed",
				endedAt: "2026-10-01T09:00:00.000Z",
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();
		expect(getOperationalStatus(await getRow("s-error-dismiss"))).toBe("error");

		const res = await acknowledge("s-error-dismiss", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: true });
		expect(getOperationalStatus(await getRow("s-error-dismiss"))).toBe("completed");
	});

	test("acknowledging an already-completed session does not revive it", async () => {
		const { getOperationalStatus } = await import("../../shared/session-state.js");
		const owner = await createUser({
			username: `ack-no-revive-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-no-revive",
				agentType: "claude_code",
				status: "completed",
				endedAt: "2026-10-01T09:00:00.000Z",
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();

		const res = await acknowledge("s-no-revive", cookieHeaders(token));
		expect(res.status).toBe(200);
		const row = await getRow("s-no-revive");
		expect(row?.status).toBe("completed");
		expect(row?.endedAt).toBe("2026-10-01T09:00:00.000Z");
		expect(getOperationalStatus(row)).toBe("completed");
	});

	test("acknowledging does not clear an active permission wait, and reports the no-op (not success)", async () => {
		const { getOperationalStatus } = await import("../../shared/session-state.js");
		const owner = await createUser({
			username: `ack-perm-wait-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-perm-wait",
				agentType: "claude_code",
				status: "active",
				semanticStatus: "waiting",
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				ownerUserId: owner.id,
				metadata: { permissionWait: { ids: ["t1"], anon: 0, prevStatus: null } },
			})
			.execute();

		const res = await acknowledge("s-perm-wait", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: false, reason: "permission_wait" });
		const row = await getRow("s-perm-wait");
		expect(getOperationalStatus(row)).toBe("waiting");
		expect((row?.metadata as Record<string, unknown>)?.permissionWait).toBeTruthy();
		expect(row?.lastUserAcknowledgedAt).toBeNull();
	});

	// AGEN: a session can be WAITING *solely* because of an outstanding
	// permission prompt (no finished turn to acknowledge at all) -- the old
	// isAlreadyAcknowledged check saw "nothing pending" and reported a false
	// `{acknowledged: true}` success, even though the session never left
	// WAITING. The permission-wait check must come first and must be a true
	// no-op: no write, no stored event, no broadcast.
	test("a session WAITING only on an outstanding permission prompt (no finished turn) reports permission_wait, not a false success", async () => {
		const { getOperationalStatus } = await import("../../shared/session-state.js");
		const owner = await createUser({
			username: `ack-perm-wait-only-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-perm-wait-only",
				agentType: "claude_code",
				status: "active",
				isWorking: true,
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				lastAgentTurnCompletedAt: null,
				lastUserAcknowledgedAt: null,
				ownerUserId: owner.id,
				metadata: { permissionWait: { ids: ["t1"], anon: 0, prevStatus: null } },
			})
			.execute();
		expect(getOperationalStatus(await getRow("s-perm-wait-only"))).toBe("waiting");

		const res = await acknowledge("s-perm-wait-only", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ acknowledged: false, reason: "permission_wait" });

		const row = await getRow("s-perm-wait-only");
		expect(row?.lastUserAcknowledgedAt).toBeNull();
		expect(getOperationalStatus(row)).toBe("waiting");

		const stored = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "s-perm-wait-only"));
		expect(stored.filter((e) => e.eventType === "UserAcknowledge")).toHaveLength(0);
	});
});

// AGEN: acknowledge is a dashboard-adjacent write path, not the ingest
// firehose — rate-limited the same way /native-name is (its own token
// bucket, a real 429 rather than /hooks' always-200 contract).
describe("POST /sessions/:sessionId/acknowledge — rate limit", () => {
	test("sustained calls from one key exceed the rate limit -> 429 {error:rate_limited}; a second key is unaffected", async () => {
		const owner = await createUser({
			username: `ack-rl-owner-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key: keyA, id: idA } = await createApiKey("ack-rl-key-a", [SCOPE_MANAGE], owner.id);
		const { key: keyB } = await createApiKey("ack-rl-key-b", [SCOPE_MANAGE], owner.id);
		await seedSession("rl-ack-1", owner.id);

		const frozen = Date.now();
		_setRateLimitClockForTest(() => frozen);
		for (let i = 0; i < RATE_LIMIT_CAPACITY - 1; i++) {
			expect(tryConsume(`acknowledge:${idA}`)).toBe(true);
		}
		expect((await acknowledge("rl-ack-1", bearerHeaders(keyA))).status).toBe(200);
		const limited = await acknowledge("rl-ack-1", bearerHeaders(keyA));
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBe("1");
		expect(await limited.json()).toEqual({ error: "rate_limited" });

		const resB = await acknowledge("rl-ack-1", bearerHeaders(keyB));
		expect(resB.status).toBe(200);
	});
});

// AGEN: an acknowledge call that wouldn't change the turn/failure signal
// must be a true no-op — no DB write, no stored event, no broadcast — so
// a dashboard that re-sends the same acknowledgement (e.g. a retried
// click) never spams the timeline or the WebSocket feed.
describe("POST /sessions/:sessionId/acknowledge — idempotent no-op (AGEN)", () => {
	test("a second call after the first stores no additional event and broadcasts nothing", async () => {
		const owner = await createUser({
			username: `ack-idem-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-idem-noop",
				agentType: "claude_code",
				status: "active",
				lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
				lastActivityAt: "2026-10-01T09:00:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();

		const first = await acknowledge("s-idem-noop", cookieHeaders(token));
		expect(first.status).toBe(200);
		const afterFirst = await getRow("s-idem-noop");
		const storedAfterFirst = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "s-idem-noop"));
		expect(storedAfterFirst).toHaveLength(1);

		const broadcasts = await countBroadcasts(async () => {
			const second = await acknowledge("s-idem-noop", cookieHeaders(token));
			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({ acknowledged: true });
		});
		expect(broadcasts).toBe(0);

		const afterSecond = await getRow("s-idem-noop");
		expect(afterSecond?.lastUserAcknowledgedAt).toBe(afterFirst?.lastUserAcknowledgedAt ?? null);
		const storedAfterSecond = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "s-idem-noop"));
		expect(storedAfterSecond).toHaveLength(1);
	});

	test("a fresh session with no finished turn: acknowledging is a no-op from the start (nothing pending)", async () => {
		const owner = await createUser({
			username: `ack-idem-fresh-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await seedSession("s-idem-fresh", owner.id);

		const broadcasts = await countBroadcasts(async () => {
			const res = await acknowledge("s-idem-fresh", cookieHeaders(token));
			expect(res.status).toBe(200);
		});
		expect(broadcasts).toBe(0);
		const stored = await getDb().select().from(events).where(eq(events.sessionId, "s-idem-fresh"));
		expect(stored).toHaveLength(0);
	});
});

// AGEN: "mark as unseen" — the inverse of acknowledge. Clears
// lastUserAcknowledgedAt so a WAITING session goes back to WAITING and a
// dismissed failure goes back to ERROR. Same ownership rule as acknowledge.
describe("DELETE /sessions/:sessionId/acknowledge — mark as unseen (AGEN)", () => {
	test("unknown session -> 404, nothing stored", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const res = await unacknowledge("does-not-exist", new Headers());
			expect(res.status).toBe(404);
		} finally {
			(config as Record<string, unknown>).disableAuth = false;
		}
	});

	test("clears the acknowledgement: a session goes from idle back to waiting", async () => {
		const owner = await createUser({
			username: `unack-owner-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-unack-idle",
				agentType: "claude_code",
				status: "active",
				lastAgentTurnCompletedAt: "2026-10-01T09:00:00.000Z",
				lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
				lastActivityAt: "2026-10-01T09:05:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();
		expect(getOperationalStatus(await getRow("s-unack-idle"))).toBe("idle");

		const res = await unacknowledge("s-unack-idle", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ unacknowledged: true });
		const row = await getRow("s-unack-idle");
		expect(row?.lastUserAcknowledgedAt).toBeNull();
		expect(getOperationalStatus(row)).toBe("waiting");

		const stored = await getDb().select().from(events).where(eq(events.sessionId, "s-unack-idle"));
		expect(stored).toHaveLength(1);
	});

	test("clears a dismissed failure: brings ERROR back", async () => {
		const owner = await createUser({
			username: `unack-error-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-unack-error",
				agentType: "claude_code",
				status: "failed",
				endedAt: "2026-10-01T09:00:00.000Z",
				lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
				lastActivityAt: "2026-10-01T09:05:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();
		expect(getOperationalStatus(await getRow("s-unack-error"))).toBe("completed");

		const res = await unacknowledge("s-unack-error", cookieHeaders(token));
		expect(res.status).toBe(200);
		const row = await getRow("s-unack-error");
		expect(getOperationalStatus(row)).toBe("error");
	});

	test("non-owner member: 200 no-op, reason not_owner, nothing cleared", async () => {
		const owner = await createUser({
			username: `unack-notowner-owner-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const other = await createUser({
			username: `unack-notowner-other-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: other.id });
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "s-unack-notowner",
				agentType: "claude_code",
				status: "active",
				lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
				lastActivityAt: "2026-10-01T09:05:00.000Z",
				ownerUserId: owner.id,
				metadata: {},
			})
			.execute();

		const res = await unacknowledge("s-unack-notowner", cookieHeaders(token));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ unacknowledged: false, reason: "not_owner" });
		const row = await getRow("s-unack-notowner");
		expect(row?.lastUserAcknowledgedAt).toBe("2026-10-01T09:05:00.000Z");
	});

	test("idempotent: already-unacknowledged session stores no event and broadcasts nothing", async () => {
		const owner = await createUser({
			username: `unack-idem-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { token } = await issueSession({ userId: owner.id });
		await seedSession("s-unack-idem", owner.id);

		const broadcasts = await countBroadcasts(async () => {
			const res = await unacknowledge("s-unack-idem", cookieHeaders(token));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ unacknowledged: true });
		});
		expect(broadcasts).toBe(0);
		const stored = await getDb().select().from(events).where(eq(events.sessionId, "s-unack-idem"));
		expect(stored).toHaveLength(0);
	});

	test("ingest-scoped key is rejected by route scope", async () => {
		const { createApiKey: mkKey, SCOPE_INGEST } = await import("../auth/api-key.js");
		const owner = await createUser({
			username: `unack-ingest-${crypto.randomUUID()}`,
			password: "AckTest1Password!",
			role: "user",
		});
		const { key } = await mkKey("unack-ingest-key", [SCOPE_INGEST], owner.id);
		await seedSession("s-unack-ingest-scope", owner.id);

		const res = await unacknowledge("s-unack-ingest-scope", bearerHeaders(key));
		expect(res.status).toBe(403);
	});
});
