/**
 * AGEN-83 Phase 1: a managed-events delivery that carries `X-AgentPulse-Delivery-Id` is
 * idempotent through a durable receipt written in the same transaction as the rows;
 * `occurredAt` is display-only and kept only inside a plausible window; a delivery sent with
 * the replay header is `late` on the bus and counted against a small concurrency cap.
 *
 * The window-drop scenario is the one a row-based dedup cannot cover: every row of the first
 * attempt is dropped by the 50-row content window, so no row remembers the delivery, yet its
 * replay (after the originals have left the window) must still store nothing. A committed
 * negative twin runs it with the receipt insert disabled and proves the replay then stores rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import "../db/__test_db.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";
import { countDbCalls } from "../test-utils/db-call-counter.js";

const { eq, sql } = await import("drizzle-orm");
const { config } = await import("../config.js");
const clientModule = await import("../db/client.js");
const { initializeDatabase, getDb } = clientModule;
const { events, managedDeliveryReceipts, sessions } = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { getEventsDeduplicatedCounts } = await import("../services/event-dedup.js");
const { sessionBus } = await import("../services/notifier.js");
const { appendManagedSessionDelivery, _resetOccurredAtRejectionLogForTest } = await import(
	"../services/managed-session-state.js"
);
const { insertNormalizedEvents } = await import("../services/event-processor.js");
const { __resetReplayLimiterForTests, tryAcquireReplay, replaysInFlight, MAX_CONCURRENT_REPLAYS } =
	await import("../services/replay-limiter.js");
const { embedLiveSessionEvent } = await import("../services/ai/embeddings/embedding-service.js");
const { parseDbTimestamp } = await import("../services/util/db-time.js");
const { DELIVERY_ID_HEADER, REPLAY_HEADER } = await import("../../shared/hook-headers.js");

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;

interface Supervisor {
	id: string;
	credential: string;
}

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});

afterEach(() => {
	__resetReplayLimiterForTests();
	_resetOccurredAtRejectionLogForTest();
});

afterAll(async () => {
	await deleteAllSupervisors();
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function registerSupervisor(): Promise<Supervisor> {
	const { token } = await createSupervisorEnrollmentToken(
		`dedup-${crypto.randomUUID()}`,
		null,
		null,
	);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "dedup-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
		}),
	});
	const body = (await res.json()) as { supervisorCredential: string };
	return { id, credential: body.supervisorCredential };
}

async function ownedSession(supervisor: Supervisor): Promise<string> {
	const sessionId = `dedup-s-${crypto.randomUUID()}`;
	await getDb().insert(sessions).values({ sessionId, agentType: "claude_code", status: "active" });
	await seedOwnedLaunch(sessionId, supervisor.id);
	return sessionId;
}

let counter = 0;
const note = (content?: string, extra: Record<string, unknown> = {}) => ({
	eventType: "ManagedProbe",
	category: "system_event",
	content: content ?? `probe-${++counter}-${crypto.randomUUID()}`,
	...extra,
});

interface PostOptions {
	deliveryId?: string;
	replay?: boolean;
	rawBody?: string;
}

async function postEvents(
	supervisor: Supervisor,
	sessionId: string,
	eventsBody: unknown[],
	opts: PostOptions = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${supervisor.credential}`,
	};
	if (opts.deliveryId) headers[DELIVERY_ID_HEADER] = opts.deliveryId;
	if (opts.replay) headers[REPLAY_HEADER] = "1";
	return app.request(`/api/v1/supervisors/${supervisor.id}/managed-sessions/${sessionId}/events`, {
		method: "POST",
		headers,
		body: opts.rawBody ?? JSON.stringify({ events: eventsBody }),
	});
}

async function storedRows(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId)).orderBy(events.id);
}

async function receiptRows(sessionId: string) {
	return getDb()
		.select()
		.from(managedDeliveryReceipts)
		.where(eq(managedDeliveryReceipts.sessionId, sessionId));
}

const fillers = (n: number) => Array.from({ length: n }, () => note());
const newDeliveryId = () => crypto.randomUUID();

describe("delivery receipt: a replay stores nothing", () => {
	test("the same id and body after 60 intervening events stores 0 rows and counts one deliveryRetry", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const batch = [note(), note()];
		const deliveryId = newDeliveryId();

		expect((await postEvents(sup, sessionId, batch, { deliveryId })).status).toBe(200);
		expect(await storedRows(sessionId)).toHaveLength(2);
		expect(
			await receiptRows(sessionId),
			"positive control: the first delivery left a receipt",
		).toHaveLength(1);

		await postEvents(sup, sessionId, fillers(60));
		const rowsBefore = (await storedRows(sessionId)).length;
		const before = getEventsDeduplicatedCounts().deliveryRetry;

		const replay = await postEvents(sup, sessionId, batch, { deliveryId, replay: true });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ events: [] });
		expect(await storedRows(sessionId)).toHaveLength(rowsBefore);
		expect(getEventsDeduplicatedCounts().deliveryRetry - before).toBe(1);
	});

	test("window drop: every row of the first attempt is dropped by the window, yet the receipt exists and a later replay stores 0 rows", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const batch = [note(), note(), note()];
		const deliveryId = newDeliveryId();

		// Live first, without the header: the rows are stored.
		await postEvents(sup, sessionId, batch);
		expect(await storedRows(sessionId)).toHaveLength(3);

		// The same batch with an id: the window drops every row...
		const retry = await postEvents(sup, sessionId, batch, { deliveryId });
		expect(retry.status).toBe(200);
		expect(await storedRows(sessionId), "all rows dropped by the content window").toHaveLength(3);
		// ...but the receipt is there regardless.
		expect(await receiptRows(sessionId)).toHaveLength(1);

		// 60 filler events push the originals out of the 50-row window.
		await postEvents(sup, sessionId, fillers(60));
		const after = await storedRows(sessionId);
		expect(after).toHaveLength(63);

		const replay = await postEvents(sup, sessionId, batch, { deliveryId, replay: true });
		expect(replay.status).toBe(200);
		expect(await storedRows(sessionId), "the replay is recognised by its receipt").toHaveLength(63);
	});

	test("negative twin: with the receipt insert disabled the same scenario stores rows on replay", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const batch = [note(), note(), note()];
		const deliveryId = newDeliveryId();
		const noReceipt = { insertReceipt: async () => true };
		const send = () =>
			appendManagedSessionDelivery(
				sup.id,
				sessionId,
				batch as never,
				{ deliveryId, bodyDigest: "digest" },
				noReceipt,
			);

		await postEvents(sup, sessionId, batch);
		expect(await storedRows(sessionId)).toHaveLength(3);
		expect((await send()).events, "window drops the retry").toEqual([]);
		await postEvents(sup, sessionId, fillers(60));
		expect(await storedRows(sessionId)).toHaveLength(63);

		const replay = await send();
		expect(replay.replay).toBe(false);
		expect(replay.events, "without the receipt the replay stores the rows again").toHaveLength(3);
		expect(await storedRows(sessionId)).toHaveLength(66);
		expect(await receiptRows(sessionId)).toHaveLength(0);
	});

	test("rollback: a failure after the receipt leaves no receipt and no events, and a retry stores the rows", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const batch = [note(), note()];
		const delivery = { deliveryId: newDeliveryId(), bodyDigest: "digest-rb" };

		await expect(
			appendManagedSessionDelivery(sup.id, sessionId, batch as never, delivery, {
				persist: async () => {
					throw new Error("injected events failure");
				},
			}),
		).rejects.toThrow("injected events failure");
		expect(await receiptRows(sessionId)).toHaveLength(0);
		expect(await storedRows(sessionId)).toHaveLength(0);

		const retry = await appendManagedSessionDelivery(sup.id, sessionId, batch as never, delivery);
		expect(retry.replay).toBe(false);
		expect(retry.events).toHaveLength(2);
		expect(await receiptRows(sessionId)).toHaveLength(1);
	});

	test("the same id with a different body is a new delivery and is stored", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const deliveryId = newDeliveryId();
		await postEvents(sup, sessionId, [note("body-one")], { deliveryId });
		await postEvents(sup, sessionId, [note("body-two")], { deliveryId });
		expect(await storedRows(sessionId)).toHaveLength(2);
		expect(await receiptRows(sessionId)).toHaveLength(2);
	});

	test("the same id and body from two supervisors, and on two sessions of one supervisor, are all stored", async () => {
		const a = await registerSupervisor();
		const b = await registerSupervisor();
		const sessionA1 = await ownedSession(a);
		const sessionA2 = await ownedSession(a);
		const sessionB = await ownedSession(b);
		const deliveryId = newDeliveryId();
		const body = [note("shared-content")];

		for (const [sup, sessionId] of [
			[a, sessionA1],
			[a, sessionA2],
			[b, sessionB],
		] as const) {
			await postEvents(sup, sessionId, body, { deliveryId });
			expect(await storedRows(sessionId), sessionId).toHaveLength(1);
		}
	});

	test("a malformed delivery id takes today's path: stored, no receipt, content window applies", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const batch = [note()];
		await postEvents(sup, sessionId, batch, { deliveryId: "bad id!" });
		await postEvents(sup, sessionId, batch, { deliveryId: "bad id!" });
		expect(await storedRows(sessionId)).toHaveLength(1);
		expect(await receiptRows(sessionId)).toHaveLength(0);
	});

	test("no header is identical to base: rows stored, no receipt", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const res = await postEvents(sup, sessionId, [note(), note()]);
		const body = (await res.json()) as { events: unknown[] };
		expect(body.events).toHaveLength(2);
		expect(await receiptRows(sessionId)).toHaveLength(0);
	});

	test("a 1,000-event delivery stores all its rows and a receipt", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const res = await postEvents(sup, sessionId, fillers(1000), { deliveryId: newDeliveryId() });
		expect(res.status).toBe(200);
		expect(await storedRows(sessionId)).toHaveLength(1000);
		expect(await receiptRows(sessionId)).toHaveLength(1);
	});
});

describe("occurredAt is display only, kept inside [-25 h, +5 min]", () => {
	const HOUR = 3_600_000;
	async function occurredAtOf(rawValue: unknown) {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const before = Date.now();
		const res = await postEvents(sup, sessionId, [note(undefined, { occurredAt: rawValue })]);
		expect(res.status).toBe(200);
		const [row] = await storedRows(sessionId);
		return { row, before, after: Date.now() };
	}

	test("25 h minus a second is kept (normalized ISO) and 25 h plus a second is stored as null", async () => {
		const keep = new Date(Date.now() - 25 * HOUR + 1000).toISOString();
		const inside = await occurredAtOf(keep);
		expect(inside.row?.occurredAt).toBe(keep);
		const drop = await occurredAtOf(new Date(Date.now() - 25 * HOUR - 1000).toISOString());
		expect(drop.row?.occurredAt).toBeNull();
	});

	test("five minutes ahead minus a second is kept and plus a second is null", async () => {
		const keep = new Date(Date.now() + 5 * 60_000 - 1000).toISOString();
		expect((await occurredAtOf(keep)).row?.occurredAt).toBe(keep);
		expect(
			(await occurredAtOf(new Date(Date.now() + 5 * 60_000 + 1000).toISOString())).row?.occurredAt,
		).toBeNull();
	});

	test("junk values are stored as null and never fail the request", async () => {
		for (const junk of [
			12345,
			{ a: 1 },
			"",
			"NaN",
			"9999-12-31T23:59:59Z",
			true,
			[],
			"yesterday",
		]) {
			expect((await occurredAtOf(junk)).row?.occurredAt, JSON.stringify(junk)).toBeNull();
		}
	});

	test("created_at is the server's time, never the supplied one", async () => {
		const supplied = new Date(Date.now() - 2 * HOUR).toISOString();
		const { row } = await occurredAtOf(supplied);
		expect(row?.occurredAt).toBe(supplied);
		expect(row?.createdAt).not.toBe(supplied);
		expect(parseDbTimestamp(row?.createdAt as string) as number).toBeGreaterThan(
			Date.now() - 60_000,
		);
	});

	test("the DTO carries occurredAt when set and omits it when null", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const supplied = new Date(Date.now() - HOUR).toISOString();
		const res = await postEvents(sup, sessionId, [
			note("with-time", { occurredAt: supplied }),
			note("without-time"),
		]);
		const body = (await res.json()) as { events: Array<Record<string, unknown>> };
		const byContent = new Map(body.events.map((e) => [e.content, e]));
		expect(byContent.get("with-time")?.occurredAt).toBe(supplied);
		expect("occurredAt" in (byContent.get("without-time") ?? {})).toBe(false);
	});

	test("a rejected time is logged once per supervisor, without the value", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const sup = await registerSupervisor();
			const sessionId = await ownedSession(sup);
			const bad = "2001-01-01T00:00:00.000Z";
			await postEvents(sup, sessionId, [note(undefined, { occurredAt: bad })]);
			await postEvents(sup, sessionId, [note(undefined, { occurredAt: bad })]);
			const lines = warn.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("occurred_at_rejected"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).not.toContain("2001");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("body handling", () => {
	test("a body of 2 MiB + 1 is 413 payload_too_large on the events route and the state route", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const huge = "x".repeat(2 * 1024 * 1024 + 1);
		const events = await postEvents(sup, sessionId, [], { rawBody: huge });
		expect(events.status).toBe(413);
		expect(await events.json()).toEqual({ error: "payload_too_large" });
		const state = await app.request(`/api/v1/supervisors/${sup.id}/managed-session-state`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${sup.credential}` },
			body: huge,
		});
		expect(state.status).toBe(413);
	});

	test("a malformed body is 400 invalid_body, not a 500, on both routes", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		for (const rawBody of ["{not json", "null", "[]", '{"events":"nope"}', '{"events":[1]}']) {
			const res = await postEvents(sup, sessionId, [], { rawBody });
			expect(res.status, rawBody).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_body" });
		}
		const state = await app.request(`/api/v1/supervisors/${sup.id}/managed-session-state`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${sup.credential}` },
			body: "{oops",
		});
		expect(state.status).toBe(400);
		expect(await state.json()).toEqual({ error: "invalid_body" });
	});
});

describe("statement budget", () => {
	test("no header: the base count; with a delivery id: base + 1 (the receipt), at 1 and at 1,000 events", async () => {
		const sup = await registerSupervisor();
		const measure = async (n: number, deliveryId?: string) => {
			const sessionId = await ownedSession(sup);
			let status = 0;
			const calls = await countDbCalls(async () => {
				status = (await postEvents(sup, sessionId, fillers(n), { deliveryId })).status;
			});
			expect(status).toBe(200);
			return calls;
		};
		// Warm anything lazily initialised (auth caches, mode reads) so counts are steady.
		await measure(1);

		const base = await measure(1);
		// The base path is credential check + ownership + recent-rows read + one insert + the
		// session read for the broadcast. Pinned as a literal so a change to it is seen.
		expect(base).toBe(BASE_STATEMENTS);
		expect(await measure(1000)).toBe(base);

		expect(await measure(1, newDeliveryId())).toBe(base + 1);
		expect(await measure(1000, newDeliveryId())).toBe(base + 1);
	});

	test("no statement inside the transaction goes through getDb(): only the transaction opener asks for it", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const spy = spyOn(clientModule, "getDb");
		try {
			// Positive control: the spy sees the non-transactional path's own getDb() calls.
			await insertNormalizedEvents(sessionId, [
				{
					eventType: "ManagedProbe",
					category: "system_event",
					source: "launch_system",
					content: `control-${crypto.randomUUID()}`,
					isNoise: false,
					providerEventType: null,
					toolName: null,
					toolInput: null,
					toolResponse: null,
					rawPayload: {},
				},
			]);
			const plain = spy.mock.calls.length;
			expect(plain, "the spy must observe getDb() calls to mean anything").toBeGreaterThan(1);

			spy.mockClear();
			await appendManagedSessionDelivery(sup.id, sessionId, [note()] as never, {
				deliveryId: newDeliveryId(),
				bodyDigest: "digest-spy",
			});
			// getDb() is called by assertSupervisorCanWriteSession (ownership read) and by
			// withTransaction itself; nothing inside the transaction body.
			const insideStarted = spy.mock.calls.length;
			spy.mockClear();
			await appendManagedSessionDelivery(sup.id, sessionId, [] as never, {
				deliveryId: newDeliveryId(),
				bodyDigest: "digest-empty",
			});
			const withoutTransaction = spy.mock.calls.length;
			// The delta between a delivery that opens the transaction and one that doesn't is
			// exactly the opener's single getDb().
			expect(insideStarted - withoutTransaction).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("single-event latency with and without the header is logged (target p95 <= 50 ms, not asserted)", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const time = async (withHeader: boolean) => {
			const samples: number[] = [];
			for (let i = 0; i < 50; i++) {
				const start = performance.now();
				await postEvents(sup, sessionId, [note()], {
					deliveryId: withHeader ? newDeliveryId() : undefined,
				});
				samples.push(performance.now() - start);
			}
			samples.sort((x, y) => x - y);
			return samples[Math.floor(samples.length * 0.95) - 1] as number;
		};
		const plain = await time(false);
		const receipted = await time(true);
		console.log(
			JSON.stringify({
				kind: "managed_events_latency_p95_ms",
				dialect: config.dialect,
				noHeader: Math.round(plain * 10) / 10,
				withDeliveryId: Math.round(receipted * 10) / 10,
			}),
		);
		expect(Number.isFinite(plain) && Number.isFinite(receipted)).toBe(true);
	});
});

/** The statements of a no-header, single-event events request, measured at this commit. */
const BASE_STATEMENTS = 8;

describe("replay header: late fan-out and the concurrency cap", () => {
	function collect() {
		const seen: Array<{ late?: true }> = [];
		const updated: Array<{ late?: true } | undefined> = [];
		const onEvent = (p: { late?: true }) => seen.push(p);
		const onUpdated = (_s: unknown, meta?: { late?: true }) => updated.push(meta);
		sessionBus.on("session_event", onEvent);
		sessionBus.on("session_updated", onUpdated);
		return {
			seen,
			updated,
			stop: () => {
				sessionBus.off("session_event", onEvent);
				sessionBus.off("session_updated", onUpdated);
			},
		};
	}

	test("a replay-header delivery is late on both bus events; a live one is not", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const tap = collect();
		try {
			await postEvents(sup, sessionId, [note()]);
			expect(tap.seen.at(-1)?.late).toBeUndefined();
			expect(tap.updated.at(-1)).toBeUndefined();

			await postEvents(sup, sessionId, [note()], { replay: true, deliveryId: newDeliveryId() });
			expect(tap.seen.at(-1)?.late).toBe(true);
			expect(tap.updated.at(-1)).toEqual({ late: true });
		} finally {
			tap.stop();
		}
	});

	test("lateness comes only from the header, never from an event's own time", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const tap = collect();
		try {
			const old = new Date(Date.now() - 20 * 3_600_000).toISOString();
			await postEvents(sup, sessionId, [note(undefined, { occurredAt: old })]);
			expect(tap.seen.at(-1)?.late).toBeUndefined();
		} finally {
			tap.stop();
		}
	});

	test("a late event is not embedded inline; a live one is", () => {
		const embedded: number[] = [];
		const embed = async (id: number) => {
			embedded.push(id);
		};
		embedLiveSessionEvent({ event: { id: 1 }, late: true }, embed);
		expect(embedded).toEqual([]);
		embedLiveSessionEvent({ event: { id: 2 } }, embed);
		expect(embedded).toEqual([2]);
	});

	test(`the ${MAX_CONCURRENT_REPLAYS + 1}th concurrent replay request gets 503 busy with Retry-After; live reports are never refused`, async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		const held = Array.from({ length: MAX_CONCURRENT_REPLAYS }, () => tryAcquireReplay());
		expect(held.every((release) => release !== null)).toBe(true);
		expect(tryAcquireReplay(), "positive control: the cap is really full").toBeNull();

		const refused = await postEvents(sup, sessionId, [note()], { replay: true });
		expect(refused.status).toBe(503);
		expect(refused.headers.get("Retry-After")).toBe("2");
		expect(await refused.json()).toEqual({ error: "busy" });
		expect(await storedRows(sessionId)).toHaveLength(0);

		const state = await app.request(`/api/v1/supervisors/${sup.id}/managed-session-state`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${sup.credential}`,
				[REPLAY_HEADER]: "1",
			},
			body: JSON.stringify({ sessionId }),
		});
		expect(state.status).toBe(503);

		expect((await postEvents(sup, sessionId, [note()])).status, "live is not capped").toBe(200);

		held[0]?.();
		expect((await postEvents(sup, sessionId, [note()], { replay: true })).status).toBe(200);
	});

	test("the slot is released after success, an error status, and a thrown error", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		await postEvents(sup, sessionId, [note()], { replay: true });
		await postEvents(sup, sessionId, [], { replay: true, rawBody: "{bad" });
		await postEvents(sup, "no-such-session", [note()], { replay: true });
		expect(replaysInFlight()).toBe(0);
	});

	test("an unauthenticated replay request can't take a slot", async () => {
		const res = await app.request("/api/v1/supervisors/nope/managed-session-state", {
			method: "POST",
			headers: { [REPLAY_HEADER]: "1", "Content-Type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(replaysInFlight()).toBe(0);
	});
});

describe("receipts are scoped to their session", () => {
	test("deleting the session removes its receipts", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		await postEvents(sup, sessionId, [note()], { deliveryId: newDeliveryId() });
		expect(await receiptRows(sessionId)).toHaveLength(1);
		await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));
		expect(await receiptRows(sessionId)).toHaveLength(0);
	});

	test("receipt created_at is the toDbTimestamp form, not a database default", async () => {
		const sup = await registerSupervisor();
		const sessionId = await ownedSession(sup);
		await postEvents(sup, sessionId, [note()], { deliveryId: newDeliveryId() });
		const [row] = await receiptRows(sessionId);
		expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		void sql;
	});
});
