/**
 * The machine a hook says it came from (X-AgentPulse-Host), for sessions no
 * supervisor launched. The value is self-declared and unauthenticated: it is
 * stored for display only and is never read by any ownership, access or routing
 * decision. These tests cover the header on the wire, the one write per change,
 * the statement cost, the exclude rule, and the "display only" promise.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { processHookEvent } = await import("../services/event-processor.js");
const { getSession, getSessions } = await import("../services/session-tracker.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount, getIngestForeignKeyDroppedCount } = await import(
	"./ingest-counters.js"
);
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const { HOST_HEADER, SKIP_HEADER } = await import("../../shared/hook-headers.js");

const WIRE_HOST_HEADER = "X-AgentPulse-Host";

beforeAll(async () => {
	await initializeDatabase();
	(await import("../routes/health.js")).markDbReady();
});
afterAll(async () => {
	(await import("../routes/health.js"))._resetDbReadyForTest(false);
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
	_resetCountersForTest();
	_resetBucketsForTest();
}
beforeEach(reset);
afterEach(reset);

async function until(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	let hits = 0;
	while (hits < 2) {
		hits = cond() ? hits + 1 : 0;
		if (hits >= 2) return;
		if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

async function postHook(
	key: string,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Type": "claude_code",
			Authorization: `Bearer ${key}`,
			...headers,
		},
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await until(() => getInFlightCount() === 0);
	return res;
}

async function row(sessionId: string) {
	const [r] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return r;
}

describe("the header", () => {
	test("is named X-AgentPulse-Host", () => {
		expect(HOST_HEADER).toBe(WIRE_HOST_HEADER);
	});

	test("a hook that carries it creates the session with that host", async () => {
		const { key } = await seedKey("host-create", ["ingest"]);
		const id = newId("host-create");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "alice-mbp" },
		);
		expect((await row(id))?.reportedHost).toBe("alice-mbp");
	});

	test("a percent-encoded name is decoded and stored cleaned", async () => {
		const { key } = await seedKey("host-clean", ["ingest"]);
		const id = newId("host-clean");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "Alex%E2%80%99s%20Mac%0A%1B%5B31m%E2%80%AE" },
		);
		expect((await row(id))?.reportedHost).toBe("Alex’s Mac[31m");
	});

	test("no header means no host, and the field is null on the wire", async () => {
		const { key } = await seedKey("host-none", ["ingest"]);
		const id = newId("host-none");
		await postHook(key, { session_id: id, hook_event_name: "SessionStart" });
		expect((await row(id))?.reportedHost).toBeNull();
		expect((await getSession(id))?.reportedHost).toBeNull();
	});

	test("a header with nothing usable in it stores nothing", async () => {
		const { key } = await seedKey("host-empty", ["ingest"]);
		const id = newId("host-empty");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "%0A%09%E2%80%8B" },
		);
		expect((await row(id))?.reportedHost).toBeNull();
	});

	test("a name over 128 characters is cut to 128", async () => {
		const { key } = await seedKey("host-long", ["ingest"]);
		const id = newId("host-long");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "h".repeat(300) },
		);
		expect((await row(id))?.reportedHost).toBe("h".repeat(128));
	});
});

describe("written once, when it changes", () => {
	test("a later hook with a different host replaces it; the same host leaves it; a hook without one keeps it", async () => {
		const { key } = await seedKey("host-change", ["ingest"]);
		const id = newId("host-change");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "laptop" },
		);
		expect((await row(id))?.reportedHost).toBe("laptop");

		await postHook(
			key,
			{ session_id: id, hook_event_name: "PreToolUse" },
			{ [WIRE_HOST_HEADER]: "desktop" },
		);
		expect((await row(id))?.reportedHost).toBe("desktop");

		await postHook(
			key,
			{ session_id: id, hook_event_name: "PreToolUse" },
			{ [WIRE_HOST_HEADER]: "desktop" },
		);
		expect((await row(id))?.reportedHost).toBe("desktop");

		await postHook(key, { session_id: id, hook_event_name: "Stop" });
		expect((await row(id))?.reportedHost).toBe("desktop");
	});

	test("a session that had no host gets one from a later hook that carries it", async () => {
		const { key } = await seedKey("host-late", ["ingest"]);
		const id = newId("host-late");
		await postHook(key, { session_id: id, hook_event_name: "SessionStart" });
		expect((await row(id))?.reportedHost).toBeNull();
		await postHook(
			key,
			{ session_id: id, hook_event_name: "PreToolUse" },
			{ [WIRE_HOST_HEADER]: "late-box" },
		);
		expect((await row(id))?.reportedHost).toBe("late-box");
	});

	test("shows on the session DTO (detail and list)", async () => {
		const { key } = await seedKey("host-dto", ["ingest"]);
		const id = newId("host-dto");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "dto-box" },
		);
		expect((await getSession(id))?.reportedHost).toBe("dto-box");
		const listed = (await getSessions({ limit: 50 })).sessions.find((s) => s.sessionId === id);
		expect(listed?.reportedHost).toBe("dto-box");
	});
});

describe("only a changed host is written", () => {
	/** Every value the processor passes to an UPDATE on sessions while `fn` runs. */
	async function sessionUpdateValues(
		fn: () => Promise<void>,
	): Promise<Array<Record<string, unknown>>> {
		const db = getDb();
		const real = db.update.bind(db);
		const seen: Array<Record<string, unknown>> = [];
		// biome-ignore lint/suspicious/noExplicitAny: wrapping the builder surface only
		const spy = spyOn(db, "update").mockImplementation(((table: any) => {
			const builder = real(table);
			const set = builder.set.bind(builder);
			// biome-ignore lint/suspicious/noExplicitAny: wrapping the builder surface only
			builder.set = ((values: any) => {
				seen.push(values);
				return set(values);
			}) as typeof builder.set;
			return builder;
			// biome-ignore lint/suspicious/noExplicitAny: wrapping the builder surface only
		}) as any);
		try {
			await fn();
		} finally {
			spy.mockRestore();
		}
		return seen;
	}

	const ctx = (reportedHost: string | null) => ({
		keyId: "key-host-once",
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId: null, ingestKeyId: "key-host-once" },
		reportedHost,
	});

	test("an unchanged host is not part of the update; a changed one is; none reported leaves it out", async () => {
		const id = newId("host-once");
		await processHookEvent(
			{ session_id: id, hook_event_name: "SessionStart" },
			"claude_code",
			ctx("box"),
		);

		const same = await sessionUpdateValues(async () => {
			await processHookEvent(
				{ session_id: id, hook_event_name: "PostToolUse" },
				"claude_code",
				ctx("box"),
			);
		});
		const changed = await sessionUpdateValues(async () => {
			await processHookEvent(
				{ session_id: id, hook_event_name: "PostToolUse" },
				"claude_code",
				ctx("other"),
			);
		});
		const none = await sessionUpdateValues(async () => {
			await processHookEvent(
				{ session_id: id, hook_event_name: "PostToolUse" },
				"claude_code",
				ctx(null),
			);
		});

		// Population floor: the hook really did UPDATE the session each time.
		for (const updates of [same, changed, none]) {
			expect(updates.some((v) => "lastActivityAt" in v)).toBe(true);
		}
		expect(same.some((v) => "reportedHost" in v)).toBe(false);
		expect(changed.filter((v) => "reportedHost" in v)).toEqual([
			expect.objectContaining({ reportedHost: "other" }),
		]);
		expect(none.some((v) => "reportedHost" in v)).toBe(false);
	});
});

describe("statements per hook (the hot path)", () => {
	const ctx = (reportedHost?: string | null) => ({
		keyId: "key-host-cost",
		deliveryId: null,
		origin: "native" as const,
		attribution: { ownerUserId: "user-host-cost", ingestKeyId: "key-host-cost" },
		...(reportedHost === undefined ? {} : { reportedHost }),
	});

	async function measure(host: string | null | undefined, followHost: string | null | undefined) {
		const id = newId("host-cost");
		const created = await countDbCalls(async () => {
			await processHookEvent(
				{ session_id: id, hook_event_name: "SessionStart" },
				"claude_code",
				ctx(host),
			);
		});
		const followed = await countDbCalls(async () => {
			await processHookEvent(
				{ session_id: id, hook_event_name: "PostToolUse" },
				"claude_code",
				ctx(followHost),
			);
		});
		return { created, followed };
	}

	test("a host adds no statement on create, on an unchanged host, or on a changed host", async () => {
		const without = await measure(undefined, undefined);
		const same = await measure("box", "box");
		const changed = await measure("box", "other-box");
		const gained = await measure(undefined, "box");

		// The same numbers ingest-latency.test.ts pins for a hook with no host.
		expect(without).toEqual({ created: 10, followed: 8 });
		expect(same).toEqual(without);
		expect(changed).toEqual(without);
		expect(gained).toEqual(without);
	});
});

describe("exclude rule", () => {
	test("a skipped delivery stores nothing, host included", async () => {
		const { key } = await seedKey("host-skip", ["ingest"]);
		const id = newId("host-skip");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "skipped-box", [SKIP_HEADER]: "1" },
		);
		expect(await row(id)).toBeUndefined();
	});

	test("a skipped delivery does not update the host of an existing session", async () => {
		const { key } = await seedKey("host-skip-existing", ["ingest"]);
		const id = newId("host-skip-existing");
		await postHook(
			key,
			{ session_id: id, hook_event_name: "SessionStart" },
			{ [WIRE_HOST_HEADER]: "first" },
		);
		await postHook(
			key,
			{ session_id: id, hook_event_name: "PreToolUse" },
			{ [WIRE_HOST_HEADER]: "second", [SKIP_HEADER]: "1" },
		);
		expect((await row(id))?.reportedHost).toBe("first");
	});
});

describe("display only: the reported host decides nothing", () => {
	function ctxFor(key: { id: string; ownerUserId: string | null }, reportedHost: string | null) {
		return {
			keyId: key.id,
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: key.ownerUserId, ingestKeyId: key.id },
			reportedHost,
		};
	}

	test("team mode: a stranger's key is dropped whatever host it reports, including the owner's", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("host-owner");
		const stranger = await seedLocalUser("host-stranger");
		const ownerKey = await seedKey("host-owner-key", ["ingest"], owner.id);
		const strangerKey = await seedKey("host-stranger-key", ["ingest"], stranger.id);
		const id = newId("host-authz");

		await processHookEvent(
			{ session_id: id, hook_event_name: "SessionStart" },
			"claude_code",
			ctxFor({ id: ownerKey.id, ownerUserId: owner.id }, "owners-laptop"),
		);
		const before = await row(id);
		expect(before?.ownerUserId).toBe(owner.id);

		for (const reported of ["owners-laptop", "some-other-box", null]) {
			const result = await processHookEvent(
				{ session_id: id, hook_event_name: "PostToolUse" },
				"claude_code",
				ctxFor({ id: strangerKey.id, ownerUserId: stranger.id }, reported),
			);
			expect(result.session).toBeNull();
		}
		expect(getIngestForeignKeyDroppedCount()).toBe(3);
		const after = await row(id);
		expect(after?.reportedHost).toBe("owners-laptop");
		expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
		expect(after?.ownerUserId).toBe(owner.id);
		expect(after?.ingestKeyId).toBe(ownerKey.id);
	});

	test("team mode: the owner's own key changing host changes the host and nothing else about who owns it", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("host-owner2");
		const ownerKey = await seedKey("host-owner2-key", ["ingest"], owner.id);
		const id = newId("host-authz2");
		const key = { id: ownerKey.id, ownerUserId: owner.id };

		await processHookEvent(
			{ session_id: id, hook_event_name: "SessionStart" },
			"claude_code",
			ctxFor(key, "a"),
		);
		await processHookEvent(
			{ session_id: id, hook_event_name: "PostToolUse" },
			"claude_code",
			ctxFor(key, "b"),
		);
		const after = await row(id);
		expect(after?.reportedHost).toBe("b");
		expect(after?.ownerUserId).toBe(owner.id);
		expect(after?.ingestKeyId).toBe(ownerKey.id);
	});

	test("an unowned session is not claimed by a host, and a host does not make a stranger's acknowledge succeed", async () => {
		await setStoredMode("team");
		const owner = await seedLocalUser("host-owner3");
		const stranger = await seedLocalUser("host-stranger3");
		const ownerKey = await seedKey("host-owner3-key", ["ingest"], owner.id);
		const strangerKey = await seedKey("host-stranger3-key", ["ingest"], stranger.id);
		const id = newId("host-ack");
		await processHookEvent(
			{ session_id: id, hook_event_name: "SessionStart" },
			"claude_code",
			ctxFor({ id: ownerKey.id, ownerUserId: owner.id }, "shared-name"),
		);
		await getDb()
			.update(sessions)
			.set({ lastAgentTurnCompletedAt: new Date().toISOString(), isWorking: false })
			.where(eq(sessions.sessionId, id));

		await processHookEvent(
			{ session_id: id, hook_event_name: "UserAcknowledge" },
			"claude_code",
			ctxFor({ id: strangerKey.id, ownerUserId: stranger.id }, "shared-name"),
		);
		expect((await row(id))?.lastUserAcknowledgedAt).toBeNull();
	});

	test("no ownership, access or routing module reads the reported host", async () => {
		const serverRoot = join(import.meta.dir, "..");
		const guarded = [
			"services/authorization.ts",
			"services/session-attribution.ts",
			"services/actor.ts",
			"services/session-creation-limit.ts",
			"services/service-keys.ts",
			"services/instance-mode.ts",
			"services/launch-dispatch.ts",
			"services/supervisor-registry.ts",
			"services/correlation-resolver.ts",
		];
		const authFiles = (await readdir(join(serverRoot, "auth"))).filter(
			(n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
		);
		const files = [...guarded, ...authFiles.map((n) => `auth/${n}`)];
		let scanned = 0;
		for (const file of files) {
			let text: string;
			try {
				text = await readFile(join(serverRoot, file), "utf8");
			} catch {
				continue;
			}
			scanned++;
			expect(text.includes("reportedHost")).toBe(false);
			expect(text.includes("reported_host")).toBe(false);
			expect(text.includes("HOST_HEADER")).toBe(false);
		}
		// Population floor: the scan must really have looked at the auth directory and the named modules.
		expect(scanned).toBeGreaterThanOrEqual(10);
		expect(authFiles).toContain("middleware.ts");
	});
});
