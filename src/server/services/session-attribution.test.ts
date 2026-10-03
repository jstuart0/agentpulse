/**
 * Tests for session-attribution.ts: the pure rules that decide a session's
 * owner at creation, fill an unowned row's owner from its first real event,
 * and detect an owner mismatch worth counting — plus the DB-backed
 * first-write-wins behavior wired through processHookEvent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, apiKeys } = await import("../db/schema/index.js");
const { config } = await import("../config.js");
const { ownerForNewSession, fillForUnownedRow, isOwnerMismatch } = await import(
	"./session-attribution.js"
);
const { processHookEvent, _setPreInsertRaceHookForTest } = await import("./event-processor.js");
const { getIngestOwnerMismatchCount, _resetIngestOwnerMismatchForTest } = await import(
	"../routes/ingest-counters.js"
);

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(sessions);
	await getDb().delete(apiKeys);
	_resetIngestOwnerMismatchForTest();
});

afterEach(() => {
	// Defense in depth: a test that throws before its own finally-reset must
	// not leak the race hook into the next test.
	_setPreInsertRaceHookForTest(null);
});

function uniqueId(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

// ── ownerForNewSession (pure) ───────────────────────────────────────────────

describe("ownerForNewSession — pure decision table", () => {
	test("hook path, owned key, no launch: owner and key both from the posting key", () => {
		const result = ownerForNewSession({
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-1" },
		});
		expect(result).toEqual({ ownerUserId: "user-A", ingestKeyId: "key-1" });
	});

	test("hook path, service key, no launch: owner null, key set", () => {
		const result = ownerForNewSession({
			attribution: { ownerUserId: null, ingestKeyId: "key-service" },
		});
		expect(result).toEqual({ ownerUserId: null, ingestKeyId: "key-service" });
	});

	test("a pending launch wins over the posting key's owner, but ingestKeyId still comes from the posting key", () => {
		const result = ownerForNewSession({
			launchRequesterUserId: "user-launcher",
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-1" },
		});
		expect(result).toEqual({ ownerUserId: "user-launcher", ingestKeyId: "key-1" });
	});

	test("supervisor path, no launch: owner from the supervisor, key always null", () => {
		const result = ownerForNewSession({ supervisorOwnerUserId: "user-supervisor-owner" });
		expect(result).toEqual({ ownerUserId: "user-supervisor-owner", ingestKeyId: null });
	});

	test("supervisor path with a pending launch: the launch wins, key stays null", () => {
		const result = ownerForNewSession({
			launchRequesterUserId: "user-launcher",
			supervisorOwnerUserId: "user-supervisor-owner",
		});
		expect(result).toEqual({ ownerUserId: "user-launcher", ingestKeyId: null });
	});

	test("DISABLE_AUTH / no attribution at all: both null", () => {
		const result = ownerForNewSession({});
		expect(result).toEqual({ ownerUserId: null, ingestKeyId: null });
	});
});

// ── fillForUnownedRow (pure) ─────────────────────────────────────────────────

describe("fillForUnownedRow — pure decision table", () => {
	test("a both-null row touched by an owned key: fills both columns", () => {
		const result = fillForUnownedRow(
			{ ownerUserId: null, ingestKeyId: null },
			{ ownerUserId: "user-A", ingestKeyId: "key-1" },
		);
		expect(result).toEqual({ ownerUserId: "user-A", ingestKeyId: "key-1" });
	});

	test("a both-null row touched by a service key: fills only ingestKeyId", () => {
		const result = fillForUnownedRow(
			{ ownerUserId: null, ingestKeyId: null },
			{ ownerUserId: null, ingestKeyId: "key-service" },
		);
		expect(result).toEqual({ ingestKeyId: "key-service" });
	});

	test("a both-null row touched by DISABLE_AUTH (no attribution at all): nothing to fill", () => {
		const result = fillForUnownedRow(
			{ ownerUserId: null, ingestKeyId: null },
			{ ownerUserId: null, ingestKeyId: null },
		);
		expect(result).toBeNull();
	});

	test("an already-owned row is never touched, regardless of the incoming attribution", () => {
		const result = fillForUnownedRow(
			{ ownerUserId: "user-A", ingestKeyId: null },
			{ ownerUserId: "user-B", ingestKeyId: "key-2" },
		);
		expect(result).toBeNull();
	});

	test("a service-key-owned row (owner null, key set) is never claimed by a later owned key", () => {
		const result = fillForUnownedRow(
			{ ownerUserId: null, ingestKeyId: "key-service" },
			{ ownerUserId: "user-A", ingestKeyId: "key-1" },
		);
		expect(result).toBeNull();
	});
});

// ── isOwnerMismatch (pure) ───────────────────────────────────────────────────

describe("isOwnerMismatch — counts only non-null-vs-non-null disagreement", () => {
	test("two different owned keys, different owners: mismatch", () => {
		expect(
			isOwnerMismatch({ ownerUserId: "user-A" }, { ownerUserId: "user-B", ingestKeyId: "key-2" }),
		).toBe(true);
	});

	test("two different owned keys, same owner: no mismatch", () => {
		expect(
			isOwnerMismatch({ ownerUserId: "user-A" }, { ownerUserId: "user-A", ingestKeyId: "key-2" }),
		).toBe(false);
	});

	test("an owned row touched by a service key (null owner): no mismatch", () => {
		expect(
			isOwnerMismatch({ ownerUserId: "user-A" }, { ownerUserId: null, ingestKeyId: "key-service" }),
		).toBe(false);
	});

	test("an unassigned row (both null) touched by any key: no mismatch, nothing to disagree with", () => {
		expect(
			isOwnerMismatch({ ownerUserId: null }, { ownerUserId: null, ingestKeyId: "key-service" }),
		).toBe(false);
	});
});

// ── DB-backed: first-write-wins through processHookEvent ────────────────────

describe("an owned key's first event creates the session owned by that key", () => {
	test("any event type — SessionStart, UserPromptSubmit, or otherwise — sets owner_user_id and ingest_key_id on creation", async () => {
		const sessionId = uniqueId("first-event-owner");
		const ctx = {
			keyId: "key-1",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-1" },
		};

		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit" },
			"claude_code",
			ctx,
		);

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBe("user-A");
		expect(row.ingestKeyId).toBe("key-1");
	});
});

describe("a second key's SessionStart on an owned session changes nothing, and counts exactly one mismatch", () => {
	test("first-write-wins: the row keeps its original owner; a third event from a key with the SAME owner doesn't count again", async () => {
		const sessionId = uniqueId("steal-attempt");
		const ownedByA = {
			keyId: "key-A",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-A" },
		};
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "SessionStart" },
			"claude_code",
			ownedByA,
		);

		const ownedByB = {
			keyId: "key-B",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-B", ingestKeyId: "key-B" },
		};
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "SessionStart" },
			"claude_code",
			ownedByB,
		);

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBe("user-A");
		expect(row.ingestKeyId).toBe("key-A");
		expect(getIngestOwnerMismatchCount()).toBe(1);

		// A different key, same owner as the row: doesn't count again.
		const anotherKeyOwnedByA = {
			keyId: "key-A-second",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-A-second" },
		};
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "PostToolUse" },
			"claude_code",
			anotherKeyOwnedByA,
		);
		expect(getIngestOwnerMismatchCount()).toBe(1);
	});
});

describe("a service key creates owner null + key set; a later owned key never claims it", () => {
	test("the row stays Service key, not Unassigned, forever (per ingest)", async () => {
		const sessionId = uniqueId("service-key-first");
		const serviceCtx = {
			keyId: "key-service",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: null, ingestKeyId: "key-service" },
		};
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "SessionStart" },
			"claude_code",
			serviceCtx,
		);

		const [afterFirst] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterFirst.ownerUserId).toBeNull();
		expect(afterFirst.ingestKeyId).toBe("key-service");

		const ownedCtx = {
			keyId: "key-A",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-A" },
		};
		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "PostToolUse" },
			"claude_code",
			ownedCtx,
		);

		const [afterSecond] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		expect(afterSecond.ownerUserId).toBeNull();
		expect(afterSecond.ingestKeyId).toBe("key-service");
	});
});

describe("a pre-existing unowned row is NEVER filled by an ordinary event — owner is decided only at creation", () => {
	async function seedUnownedRow(sessionId: string, startedAt = new Date().toISOString()) {
		await getDb().insert(sessions).values({
			sessionId,
			displayName: "pre-existing",
			agentType: "claude_code",
			status: "active",
			startedAt,
			lastActivityAt: startedAt,
			metadata: {},
		});
	}

	// A member must not be able to claim a live unassigned session just by
	// posting one event to its id — regardless of which event type they pick.
	for (const hookEventName of [
		"SessionStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"Stop",
		"SessionEnd",
	]) {
		test(`${hookEventName} on an existing both-null row leaves it unowned`, async () => {
			const sessionId = uniqueId(`preexisting-unowned-${hookEventName}`);
			await seedUnownedRow(sessionId);

			await processHookEvent(
				{ session_id: sessionId, hook_event_name: hookEventName },
				"claude_code",
				{
					keyId: "key-A",
					deliveryId: null,
					origin: "native",
					attribution: { ownerUserId: "user-A", ingestKeyId: "key-A" },
				},
			);

			const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
			expect(row.ownerUserId).toBeNull();
			expect(row.ingestKeyId).toBeNull();
		});
	}

	test("a service key's event on an existing both-null row leaves it unowned too — ingest never fills an existing row's key either", async () => {
		const sessionId = uniqueId("preexisting-unowned-service");
		await seedUnownedRow(sessionId);

		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "PostToolUse" },
			"claude_code",
			{
				keyId: "key-service",
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: null, ingestKeyId: "key-service" },
			},
		);

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBeNull();
		expect(row.ingestKeyId).toBeNull();
	});

	// A pre-upgrade-style row: both owner columns null, timestamps from long
	// before this feature existed. The rule makes no exception for age — it
	// stays unassigned until an admin sets it explicitly in a later phase.
	test("a pre-upgrade-style row (both null, started a year ago) stays unowned", async () => {
		const sessionId = uniqueId("pre-upgrade-row");
		const old = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString();
		await seedUnownedRow(sessionId, old);

		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit" },
			"claude_code",
			{
				keyId: "key-A",
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: "user-A", ingestKeyId: "key-A" },
			},
		);

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBeNull();
		expect(row.ingestKeyId).toBeNull();
	});

	// A second, different key posting to an already-owned row still never
	// fills (it can't — fillForUnownedRow requires both columns null) and
	// still counts the mismatch, independent of fill eligibility.
	test("a different key's event on an already-owned row is unchanged and still counts the mismatch", async () => {
		const sessionId = uniqueId("owned-row-second-key");
		const now = new Date().toISOString();
		await getDb().insert(sessions).values({
			sessionId,
			displayName: "owned",
			agentType: "claude_code",
			status: "active",
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
			ownerUserId: "user-A",
			ingestKeyId: "key-A",
		});

		await processHookEvent(
			{ session_id: sessionId, hook_event_name: "PostToolUse" },
			"claude_code",
			{
				keyId: "key-B",
				deliveryId: null,
				origin: "native",
				attribution: { ownerUserId: "user-B", ingestKeyId: "key-B" },
			},
		);

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBe("user-A");
		expect(row.ingestKeyId).toBe("key-A");
		expect(getIngestOwnerMismatchCount()).toBe(1);
	});
});

describe("the creation-race loser — the one exception to creation-only ownership", () => {
	test("a losing insert fills the winner's row when the winner left it fully unowned", async () => {
		const sessionId = uniqueId("race-loser-fills");
		_setPreInsertRaceHookForTest(async (raceSessionId) => {
			if (raceSessionId !== sessionId) return;
			// Simulate a concurrent winner (e.g. a DISABLE_AUTH/anonymous
			// caller, or the supervisor path with no owner) creating the row
			// between our existence check and our own insert.
			await getDb()
				.insert(sessions)
				.values({
					sessionId,
					displayName: "winner",
					agentType: "claude_code",
					status: "active",
					startedAt: new Date().toISOString(),
					lastActivityAt: new Date().toISOString(),
					metadata: {},
					ownerUserId: null,
					ingestKeyId: null,
				})
				.onConflictDoNothing();
		});

		try {
			const result = await processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				{
					keyId: "key-loser",
					deliveryId: null,
					origin: "native",
					attribution: { ownerUserId: "user-loser", ingestKeyId: "key-loser" },
				},
			);
			expect(result.isNew).toBe(false);
		} finally {
			_setPreInsertRaceHookForTest(null);
		}

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBe("user-loser");
		expect(row.ingestKeyId).toBe("key-loser");
	});

	test("a losing insert does NOT fill when the winner's row already carries an owner, and the mismatch counter fires", async () => {
		const sessionId = uniqueId("race-loser-no-fill");
		_setPreInsertRaceHookForTest(async (raceSessionId) => {
			if (raceSessionId !== sessionId) return;
			await getDb()
				.insert(sessions)
				.values({
					sessionId,
					displayName: "winner",
					agentType: "claude_code",
					status: "active",
					startedAt: new Date().toISOString(),
					lastActivityAt: new Date().toISOString(),
					metadata: {},
					ownerUserId: "user-winner",
					ingestKeyId: "key-winner",
				})
				.onConflictDoNothing();
		});

		try {
			const result = await processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				{
					keyId: "key-loser",
					deliveryId: null,
					origin: "native",
					attribution: { ownerUserId: "user-loser", ingestKeyId: "key-loser" },
				},
			);
			expect(result.isNew).toBe(false);
		} finally {
			_setPreInsertRaceHookForTest(null);
		}

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).toBe("user-winner");
		expect(row.ingestKeyId).toBe("key-winner");
		expect(getIngestOwnerMismatchCount()).toBe(1);
	});
});

describe("real concurrency: N concurrent first events for one new session id, two different keys", () => {
	test("exactly one owner wins, no error, and isNew is true for exactly one caller", async () => {
		const sessionId = uniqueId("concurrent-create-race");
		const ctxA = {
			keyId: "key-A",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-A", ingestKeyId: "key-A" },
		};
		const ctxB = {
			keyId: "key-B",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-B", ingestKeyId: "key-B" },
		};

		const results = await Promise.all([
			processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				ctxA,
			),
			processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				ctxB,
			),
			processHookEvent(
				{ session_id: sessionId, hook_event_name: "UserPromptSubmit" },
				"claude_code",
				ctxA,
			),
			processHookEvent(
				{ session_id: sessionId, hook_event_name: "UserPromptSubmit" },
				"claude_code",
				ctxB,
			),
		]);

		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		expect(row.ownerUserId).not.toBeNull();
		expect(["user-A", "user-B"]).toContain(row.ownerUserId as string);
		expect(row.ingestKeyId).toBe(row.ownerUserId === "user-A" ? "key-A" : "key-B");

		const newCount = results.filter((r) => r.isNew).length;
		expect(newCount).toBe(1);
	});
});

describe("DISABLE_AUTH sessions are created unassigned", () => {
	test("a new session created with DISABLE_AUTH's anonymous caller has both owner columns null", async () => {
		const originalDisableAuth = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			const sessionId = uniqueId("disable-auth-new");
			await processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				{
					keyId: "anonymous",
					deliveryId: null,
					origin: "native",
					attribution: { ownerUserId: null, ingestKeyId: null },
				},
			);

			const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
			expect(row.ownerUserId).toBeNull();
			expect(row.ingestKeyId).toBeNull();
		} finally {
			(config as Record<string, unknown>).disableAuth = originalDisableAuth;
		}
	});
});
