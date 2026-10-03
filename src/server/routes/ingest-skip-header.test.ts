// The skip header on the server (X-AgentPulse-Skip): a Claude Code HTTP hook in
// direct mode can't apply path rules, but it can say "don't keep this". The
// middleware answers 200 {ok:true} before the body is read and before the rate
// limiter is touched, behind API-key auth, and counts the drop on /health. A
// skipped delivery never creates or touches a session, an event, a project or
// a search row. These tests run against whichever database the suite is
// pointed at (SQLite by default, Postgres under DATABASE_URL).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const {
	aiHitlRequests,
	aiWatcherRuns,
	aiDailySpend,
	events,
	eventEmbeddings,
	projects,
	sessions,
	watcherProposals,
} = await import("../db/schema/index.js");
const { eq, sql } = await import("drizzle-orm");
const { ingest } = await import("./ingest.js");
const { health, _resetDbReadyForTest } = await import("./health.js");
const { searchRouter } = await import("./search.js");
const { _resetBucketsForTest, _setRateLimitClockForTest, tryConsume, RATE_LIMIT_CAPACITY } =
	await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest, getInFlightCount } = await import("./ingest-counters.js");
const { createApiKey } = await import("../auth/api-key.js");
const { SKIP_HEADER, SKIP_HEADER_MAX_LENGTH } = await import("../../shared/hook-headers.js");

const originalDisableAuth = config.disableAuth;

const app = new Hono();
app.route("/api/v1", ingest);
app.route("/api/v1", health);
app.route("/api/v1", searchRouter);

beforeAll(async () => {
	await initializeDatabase();
	_resetDbReadyForTest(true);
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
	_resetDbReadyForTest(false);
});
beforeEach(() => {
	config.disableAuth = true;
	_resetBucketsForTest();
	_resetCountersForTest();
});
afterEach(() => {
	_setRateLimitClockForTest(null);
});

async function until(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const start = Date.now();
	let hits = 0;
	while (hits < 2) {
		hits = (await cond()) ? hits + 1 : 0;
		if (hits >= 2) return;
		if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

async function post(
	path: "/hooks" | "/hooks/status",
	body: unknown,
	opts: { skip?: string; key?: string; raw?: BodyInit } = {},
) {
	return app.request(`/api/v1${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Agent-Type": "claude_code",
			...(opts.skip !== undefined ? { [SKIP_HEADER]: opts.skip } : {}),
			...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
		},
		body: opts.raw ?? JSON.stringify(body),
	});
}

async function counters(): Promise<{ skip: number; limited: number; oversize: number }> {
	const res = await app.request("/api/v1/health");
	const body = (await res.json()) as Record<string, number>;
	return {
		skip: body.skipHeaderDropped as number,
		limited: body.rateLimitedDropped as number,
		oversize: body.oversizeDropped as number,
	};
}

/** How long a poll for a condition may take on a loaded machine. */
const POLL_CAP_MS = 15_000;

/**
 * Waits for the ingest queue to drain. A hook that is processed bumps the in-flight count before
 * the response returns and drops it when its task has finished, so "zero after the response" means
 * nothing this request started is still running (a skipped request never raises it at all).
 */
async function settle() {
	await until(() => getInFlightCount() === 0, POLL_CAP_MS);
}

async function sessionRow(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

async function eventCount(sessionId: string): Promise<number> {
	return (await getDb().select().from(events).where(eq(events.sessionId, sessionId))).length;
}

async function projectCount(): Promise<number> {
	const [row] = await getDb().select({ n: sql<number>`count(*)` }).from(projects);
	return Number(row?.n ?? 0);
}

/** Row counts of every table a hook event can write to (the AI tables included, the SQLite-only one when it exists). */
async function storedRows(): Promise<Record<string, number>> {
	const count = async (table: unknown, name: string) => {
		const [row] = await getDb()
			.select({ n: sql<number>`count(*)` })
			.from(table as typeof sessions);
		return [name, Number(row?.n ?? 0)] as const;
	};
	const tables: [unknown, string][] = [
		[sessions, "sessions"],
		[events, "events"],
		[projects, "projects"],
		[aiWatcherRuns, "ai_watcher_runs"],
		[aiHitlRequests, "ai_hitl_requests"],
		[watcherProposals, "watcher_proposals"],
		[aiDailySpend, "ai_daily_spend"],
	];
	if (eventEmbeddings) tables.push([eventEmbeddings, "event_embeddings"]);
	return Object.fromEntries(await Promise.all(tables.map(([t, n]) => count(t, n))));
}

const prompt = (sessionId: string, cwd: string, text = "hello") => ({
	session_id: sessionId,
	hook_event_name: "UserPromptSubmit",
	cwd,
	prompt: text,
});

describe("the skip header: an allowlist, nothing else", () => {
	for (const value of ["1", "true", "TRUE", "Yes", "on", " 1 ", "\tYes\r\n", " ON\n"]) {
		test(`${JSON.stringify(value)} is dropped: 200 {ok:true}, counted, nothing stored`, async () => {
			const id = newId("skip-yes");
			const before = await counters();
			const res = await post("/hooks", prompt(id, "/work/skip", "hi"), { skip: value });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect((await counters()).skip).toBe(before.skip + 1);
			await settle();
			expect(await sessionRow(id)).toBeUndefined();
		});
	}

	for (const value of [
		"$AGENTPULSE_SKIP",
		"",
		"0",
		"false",
		"off",
		"no",
		"2",
		"truee",
		// would be "1" if it were cut to the cap; it is longer than the cap, so it is not looked at at all
		`1${" ".repeat(SKIP_HEADER_MAX_LENGTH - 1)}x`,
	]) {
		test(`${JSON.stringify(value.slice(0, 20))} (length ${value.length}) is processed normally`, async () => {
			const id = newId("skip-no");
			const before = await counters();
			const res = await post("/hooks", prompt(id, "/work/normal"), { skip: value });
			expect(res.status).toBe(200);
			expect((await counters()).skip).toBe(before.skip);
			// the session row and its events are written one after the other: wait for both
			await until(
				async () => (await sessionRow(id)) !== undefined && (await eventCount(id)) > 0,
				POLL_CAP_MS,
			);
		});
	}

	test("no header at all: processed normally", async () => {
		const id = newId("skip-absent");
		await post("/hooks", prompt(id, "/work/normal"));
		await until(async () => (await sessionRow(id)) !== undefined, POLL_CAP_MS);
	});

	test("the same allowlist drops a status update, and a status update for a normal request is processed", async () => {
		const id = newId("skip-status");
		await post("/hooks", prompt(id, "/work/status"));
		await until(async () => (await sessionRow(id)) !== undefined, POLL_CAP_MS);
		const before = await counters();
		const dropped = await post(
			"/hooks/status",
			{ session_id: id, status: "blocked", task: "dropped" },
			{ skip: "1" },
		);
		expect(dropped.status).toBe(200);
		expect(await dropped.json()).toEqual({ ok: true });
		expect((await counters()).skip).toBe(before.skip + 1);
		await settle();
		expect((await sessionRow(id))?.currentTask).not.toBe("dropped");
		await post("/hooks/status", { session_id: id, status: "working", task: "kept" }, { skip: "0" });
		await until(async () => (await sessionRow(id))?.currentTask === "kept", POLL_CAP_MS);
	});
});

describe("the skip header is behind API-key auth, not a way around it", () => {
	test("an invalid key with the header gets 401 on both endpoints, and nothing is counted", async () => {
		config.disableAuth = false;
		const before = await counters();
		for (const path of ["/hooks", "/hooks/status"] as const) {
			const res = await post(
				path,
				{ session_id: "x", hook_event_name: "Stop" },
				{
					skip: "1",
					key: "ap_not-a-real-key",
				},
			);
			expect(res.status, path).toBe(401);
		}
		const noKey = await post("/hooks", { session_id: "x", hook_event_name: "Stop" }, { skip: "1" });
		expect(noKey.status).toBe(401);
		expect((await counters()).skip).toBe(before.skip);
	});

	test("a scope-less key (no ingest) is refused the same way a normal hook is", async () => {
		config.disableAuth = false;
		const { key } = await createApiKey("skip-no-ingest", ["manage"]);
		const res = await post(
			"/hooks",
			{ session_id: "x", hook_event_name: "Stop" },
			{ skip: "1", key },
		);
		expect(res.status).toBe(403);
	});

	test("a valid ingest key with the header is dropped and counted", async () => {
		config.disableAuth = false;
		const { key } = await createApiKey("skip-ok", ["ingest"]);
		const before = await counters();
		const res = await post("/hooks", prompt(newId("auth-ok"), "/w"), { skip: "1", key });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect((await counters()).skip).toBe(before.skip + 1);
	});
});

describe("a skip request from any valid ingest key for any session id changes nothing", () => {
	test("another key's skip request for an existing session, and one for an unseen id, leave every row, event and counter but the skip counter alone", async () => {
		config.disableAuth = false;
		const owner = await createApiKey("skip-owner", ["ingest"]);
		const other = await createApiKey("skip-other", ["ingest"]);
		const existing = newId("owned");
		await post("/hooks", prompt(existing, "/work/owned", "first"), { key: owner.key });
		await until(
			async () => (await sessionRow(existing)) !== undefined && (await eventCount(existing)) > 0,
			POLL_CAP_MS,
		);
		await settle();
		const rowBefore = await sessionRow(existing);
		const eventsBefore = await eventCount(existing);
		const projectsBefore = await projectCount();
		const before = await counters();
		const unseen = newId("unseen");
		const rowsBefore = await storedRows();

		for (const id of [existing, unseen]) {
			for (const path of ["/hooks", "/hooks/status"] as const) {
				const body =
					path === "/hooks"
						? prompt(id, "/elsewhere", "from another key")
						: { session_id: id, status: "blocked", task: "changed" };
				const res = await post(path, body, { skip: "1", key: other.key });
				expect(res.status, `${path} ${id}`).toBe(200);
				expect(await res.json()).toEqual({ ok: true });
			}
		}
		await settle();
		expect(await sessionRow(existing)).toEqual(rowBefore);
		expect(await eventCount(existing)).toBe(eventsBefore);
		expect(await sessionRow(unseen)).toBeUndefined();
		expect(await eventCount(unseen)).toBe(0);
		expect(await projectCount()).toBe(projectsBefore);
		expect(await storedRows()).toEqual(rowsBefore);
		const after = await counters();
		expect(after.skip).toBe(before.skip + 4);
		expect(after.limited).toBe(before.limited);
		expect(after.oversize).toBe(before.oversize);
	});
});

describe("the skip drop sits ahead of the rate limiter", () => {
	test("with the limiter saturated for the key, a skip request is 200, counted as skipped, and leaves the rate-limited counter alone; a normal request is limited (the control)", async () => {
		config.disableAuth = false;
		_setRateLimitClockForTest(() => 1_000_000);
		const { key, id: keyId } = await createApiKey("skip-limiter", ["ingest"]);
		while (tryConsume(keyId)) {}
		const before = await counters();
		const res = await post("/hooks", prompt(newId("lim"), "/w"), { skip: "1", key });
		expect(res.status).toBe(200);
		const after = await counters();
		expect(after.skip).toBe(before.skip + 1);
		expect(after.limited).toBe(before.limited);
		const normal = await post("/hooks", prompt(newId("lim-n"), "/w"), { key });
		expect(normal.status).toBe(200);
		expect((await counters()).limited).toBe(before.limited + 1);
	});

	test("skip requests never consume capacity: after more than a bucket's worth, a normal request is not rate-limited", async () => {
		config.disableAuth = false;
		_setRateLimitClockForTest(() => 2_000_000);
		const { key } = await createApiKey("skip-capacity", ["ingest"]);
		const before = await counters();
		for (let i = 0; i < RATE_LIMIT_CAPACITY + 50; i++) {
			await post("/hooks", prompt("cap", "/w"), { skip: "1", key });
		}
		const id = newId("cap-normal");
		await post("/hooks", prompt(id, "/work/cap"), { key });
		const after = await counters();
		expect(after.limited).toBe(before.limited);
		expect(after.skip).toBe(before.skip + RATE_LIMIT_CAPACITY + 50);
		await until(async () => (await sessionRow(id)) !== undefined, POLL_CAP_MS);
	});
});

describe("the body is never read for a skip request", () => {
	test("an unparseable body and an oversize body both get 200, and the oversize counter does not move", async () => {
		const before = await counters();
		const garbage = await post("/hooks", null, { skip: "1", raw: "{ this is not json" });
		expect(garbage.status).toBe(200);
		expect(await garbage.json()).toEqual({ ok: true });
		const huge = await post("/hooks", null, {
			skip: "1",
			raw: JSON.stringify({
				cwd: "x".repeat(17 * 1024 * 1024),
				session_id: "huge",
				hook_event_name: "Stop",
			}),
		});
		expect(huge.status).toBe(200);
		const status = await post("/hooks/status", null, { skip: "yes", raw: "\u0000\u0001" });
		expect(status.status).toBe(200);
		expect((await counters()).oversize).toBe(before.oversize);
		// the control: the same oversize body without the header IS read and counted
		const control = await post("/hooks", null, {
			raw: JSON.stringify({
				cwd: "x".repeat(17 * 1024 * 1024),
				session_id: "huge2",
				hook_event_name: "Stop",
			}),
		});
		expect(control.status).toBe(200);
		expect((await counters()).oversize).toBe(before.oversize + 1);
	});
});

describe("the body is not even touched for a skip request (a stream that would fail if anything read it)", () => {
	test("a request body stream that errors when pulled is never pulled for a skip request, and is for a normal one (the control)", async () => {
		function trap() {
			const state = { pulled: false };
			// highWaterMark 0: nothing is pulled until a consumer asks for data
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						state.pulled = true;
						controller.error(new Error("the body was read"));
					},
				},
				{ highWaterMark: 0 },
			);
			return { state, body };
		}
		const request = (body: ReadableStream<Uint8Array>, skip: boolean) =>
			app.request("/api/v1/hooks", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Agent-Type": "claude_code",
					...(skip ? { [SKIP_HEADER]: "1" } : {}),
				},
				body,
				duplex: "half",
			} as RequestInit);
		const skipped = trap();
		const res = await request(skipped.body, true);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		await new Promise((r) => setTimeout(r, 30));
		const controlTrap = trap();
		try {
			await request(controlTrap.body, false);
		} catch {
			// the stream errors when the handler reads it; that is the point
		}
		await new Promise((r) => setTimeout(r, 30));
		// the control proves the probe can see a read; if the runtime pulls streams eagerly the
		// skipped request would show it too, and this assertion says so rather than passing vacuously
		expect(controlTrap.state.pulled, "the probe can see a read").toBe(true);
		expect(skipped.state.pulled, "the skip request read the body").toBe(false);
	});
});

describe("a skipped delivery never creates or touches a session", () => {
	const token = () => `skiptoken${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

	async function searchHits(q: string): Promise<number> {
		const res = await app.request(`/api/v1/search?q=${encodeURIComponent(q)}`);
		const body = (await res.json()) as { hits?: unknown[] };
		return body.hits?.length ?? 0;
	}

	test("a brand-new session id: no session, no event, no project, nothing searchable", async () => {
		const id = newId("brand-new");
		const t = token();
		const cwd = `/work/${t}/proj`;
		const projectsBefore = await projectCount();
		const rowsBefore = await storedRows();
		const res = await post("/hooks", prompt(id, cwd, `please ${t}`), { skip: "1" });
		expect(res.status).toBe(200);
		await settle();
		expect(await sessionRow(id)).toBeUndefined();
		expect(await eventCount(id)).toBe(0);
		expect(await projectCount()).toBe(projectsBefore);
		expect(await searchHits(t)).toBe(0);
		expect(await storedRows(), "no table a hook event can write to changed").toEqual(rowsBefore);
	});

	test("the control: the same delivery without the header creates the session and is found (the harness can see creation)", async () => {
		const id = newId("control");
		const t = token();
		await post("/hooks", prompt(id, `/work/${t}/proj`, `please ${t}`));
		await until(
			async () => (await sessionRow(id)) !== undefined && (await eventCount(id)) > 0,
			POLL_CAP_MS,
		);
		await until(async () => (await searchHits(t)) > 0, POLL_CAP_MS);
	});

	test("an existing session: every field stays as it was across skipped events of every kind", async () => {
		const id = newId("existing");
		await post("/hooks", prompt(id, "/work/existing", "first"));
		await until(
			async () => (await sessionRow(id)) !== undefined && (await eventCount(id)) > 0,
			POLL_CAP_MS,
		);
		await settle();
		await getDb()
			.update(sessions)
			.set({
				metadata: {
					permissionWait: { ids: ["t1"], anon: 0, prevStatus: "working" },
					acknowledgedAt: "2026-01-01 00:00:00",
				},
				isWorking: false,
				lastActivityAt: "2026-01-01 00:00:00",
			})
			.where(eq(sessions.sessionId, id));
		const before = await sessionRow(id);
		const eventsBefore = await eventCount(id);
		for (const event of [
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PermissionRequest",
			"Stop",
			"SessionStart",
			"SessionEnd",
			"Notification",
		]) {
			const res = await post(
				"/hooks",
				{
					session_id: id,
					hook_event_name: event,
					cwd: "/elsewhere",
					tool_name: "Bash",
					tool_use_id: "t1",
					prompt: "again",
				},
				{ skip: "true" },
			);
			expect(res.status, event).toBe(200);
		}
		await post(
			"/hooks/status",
			{ session_id: id, status: "blocked", task: "changed", plan: ["a"] },
			{ skip: "ON" },
		);
		await settle();
		expect(await sessionRow(id)).toEqual(before);
		expect(await eventCount(id)).toBe(eventsBefore);
	});
});
