/**
 * Payload shaping for a phone: `view=card`, the detail's `eventsLimit` / `compact` /
 * `omit`, the timeline's `beforeId` keyset and `compact`, and the event context's
 * `compact`.
 *
 * Three promises are tested here:
 *  1. Without the parameters nothing changes: the recorded key sets of the default
 *     responses, and byte-for-byte equality with the explicitly-defaulted request.
 *  2. The shaped responses meet their gzip budgets on a fat fixture (500 events of
 *     32 KB raw payload, 8 KB tool input and 4 KB content each).
 *  3. Keyset paging is stable while events are written.
 *
 * Runs on both dialects.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import "../db/__test_db.js";
import { spyOn } from "bun:test";

setDefaultTimeout(120_000);

const { eq, inArray } = await import("drizzle-orm");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, launchRequests, projects, sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { SESSION_CARD_FIELDS } = await import("../services/session-card.js");

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read by field name
type Body = Record<string, any>;

const RUN = crypto.randomUUID().slice(0, 8);
const projectId = crypto.randomUUID();
let auth: Record<string, string> = {};

beforeAll(async () => {
	await initializeDatabase();
	const { key } = await createApiKey(`shaping-${RUN}`, ["manage"]);
	auth = { Authorization: `Bearer ${key}` };
	const now = new Date().toISOString();
	await getDb()
		.insert(projects)
		.values({
			id: projectId,
			cwd: `/tmp/shaping-${RUN}`,
			name: `shaping-${RUN}`,
			createdAt: now,
			updatedAt: now,
		});
});

const seededSessionIds: string[] = [];
afterAll(async () => {
	if (seededSessionIds.length > 0) {
		await getDb().delete(events).where(inArray(events.sessionId, seededSessionIds));
		await getDb()
			.delete(launchRequests)
			.where(inArray(launchRequests.launchCorrelationId, seededSessionIds));
		await getDb().delete(sessions).where(inArray(sessions.sessionId, seededSessionIds));
	}
	await getDb().delete(projects).where(eq(projects.id, projectId));
});

const get = (path: string) => app.request(`/api/v1${path}`, { headers: auth });
const text = async (path: string) => {
	const res = await get(path);
	return { status: res.status, body: await res.text() };
};
const json = async (path: string) => {
	const { status, body } = await text(path);
	return { status, body: JSON.parse(body) as Body };
};
const gzipBytes = (body: string) => Bun.gzipSync(new TextEncoder().encode(body)).length;
const keys = (value: object) => Object.keys(value).sort();

// ── fixtures ───────────────────────────────────────────────────────────────

/** Deterministic prose-like text of exactly `bytes` characters: compresses like real agent output, not like a run of one letter. */
function prose(seed: number, bytes: number): string {
	const words = [
		"the",
		"agent",
		"reads",
		"file",
		"src",
		"server",
		"routes",
		"then",
		"runs",
		"tests",
		"and",
		"edits",
		"function",
		"return",
		"const",
		"await",
		"session",
		"event",
		"payload",
		"error",
		"warning",
		"build",
		"passes",
		"diff",
		"commit",
		"branch",
		"config",
		"value",
		"index",
		"module",
		"import",
		"export",
	];
	let state = seed >>> 0 || 1;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
	let out = "";
	while (out.length < bytes) {
		const word = words[next() % words.length] as string;
		out += next() % 7 === 0 ? `${word}${next() % 10000} ` : `${word} `;
	}
	return out.slice(0, bytes);
}

async function seedSession(
	sessionId: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const now = new Date().toISOString();
	seededSessionIds.push(sessionId);
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			projectId,
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
			...extra,
		} as never);
	return sessionId;
}

async function seedEvents(
	sessionId: string,
	count: number,
	shape: (i: number) => Record<string, unknown> = () => ({}),
): Promise<void> {
	const CHUNK = 25;
	for (let start = 0; start < count; start += CHUNK) {
		const rows = [];
		for (let i = start; i < Math.min(count, start + CHUNK); i++) {
			rows.push({
				sessionId,
				eventType: "PostToolUse",
				category: "tool_use",
				source: "observed_hook",
				content: `event ${i}`,
				toolName: "Bash",
				toolInput: null,
				toolResponse: null,
				rawPayload: { i },
				dedupKey: `shaping-${sessionId}-${i}-${crypto.randomUUID()}`,
				...shape(i),
			});
		}
		await getDb()
			.insert(events)
			.values(rows as never);
	}
}

async function eventIds(sessionId: string): Promise<number[]> {
	const rows = await getDb()
		.select({ id: events.id })
		.from(events)
		.where(eq(events.sessionId, sessionId));
	return rows.map((r) => r.id).sort((a, b) => b - a);
}

// The recorded key sets of today's responses. A change here is a change to what every
// existing client receives, which is exactly what the shaping parameters must not cause.
const SESSION_ROW_KEYS = [
	"agentType",
	"aiSpendCents",
	"claudeMdChecksum",
	"claudeMdContent",
	"claudeMdPath",
	"claudeMdUpdatedAt",
	"currentTask",
	"currentTurnStartedAt",
	"cwd",
	"displayName",
	"endedAt",
	"gitBranch",
	"id",
	"isArchived",
	"isPinned",
	"isWorking",
	"lastActivityAt",
	"lastAgentTurnCompletedAt",
	"lastUserAcknowledgedAt",
	"metadata",
	"model",
	"nameSource",
	"nativeName",
	"notes",
	"operationalStatus",
	"ownerKind",
	"ownerUserId",
	"planSummary",
	"projectId",
	"reportedHost",
	"semanticStatus",
	"sessionId",
	"startedAt",
	"status",
	"totalToolUses",
	"transcriptPath",
	"watcherLastRunAt",
	"watcherLastUserPromptAt",
	"watcherState",
];
const LIST_ROW_KEYS = [...SESSION_ROW_KEYS, "machine", "managed"].sort();
const EVENT_KEYS = [
	"category",
	"content",
	"createdAt",
	"eventType",
	"id",
	"isNoise",
	"providerEventType",
	"rawPayload",
	"sessionId",
	"source",
	"toolInput",
	"toolName",
	"toolResponse",
];

// ── 1. defaults ────────────────────────────────────────────────────────────

describe("without the shaping parameters nothing changes", () => {
	let sessionId = "";
	beforeAll(async () => {
		sessionId = await seedSession(`shaping-defaults-${RUN}`, {
			notes: "some notes",
			claudeMdContent: "# claude",
		});
		await seedEvents(sessionId, 6, (i) => ({
			content: `content ${i}`,
			toolInput: { command: `echo ${i}` },
			rawPayload: { i, big: "x".repeat(50) },
		}));
	});

	test("the list rows, the detail, the timeline and the context have exactly the recorded keys", async () => {
		const list = await json(`/sessions?projectId=${projectId}`);
		expect(list.status).toBe(200);
		expect(keys(list.body)).toEqual(["hostFilter", "ownerScope", "sessions", "total"]);
		const row = (list.body.sessions as Array<Record<string, unknown>>).find(
			(s) => s.sessionId === sessionId,
		);
		expect(keys(row as object)).toEqual(LIST_ROW_KEYS);

		const detail = await json(`/sessions/${sessionId}`);
		expect(detail.status).toBe(200);
		expect(keys(detail.body.session)).toEqual([...SESSION_ROW_KEYS, "managedSession"].sort());
		expect(
			keys(detail.body).filter((k) => k !== "controlActions" && k !== "reportedByKey"),
		).toEqual(["events", "session"]);
		expect(detail.body.events).toHaveLength(6);
		expect(keys(detail.body.events[0])).toEqual(EVENT_KEYS);

		const timeline = await json(`/sessions/${sessionId}/timeline`);
		expect(keys(timeline.body)).toEqual(["events"]);
		expect(keys(timeline.body.events[0])).toEqual(EVENT_KEYS);

		const ids = await eventIds(sessionId);
		const context = await json(`/sessions/${sessionId}/events/${ids[2]}/context`);
		expect(keys(context.body)).toEqual(["events", "target"]);
		expect(keys(context.body.events[0])).toEqual(EVENT_KEYS);
	});

	test("an event keeps its raw payload and its whole text when nothing asks for less", async () => {
		const timeline = await json(`/sessions/${sessionId}/timeline`);
		const event = timeline.body.events[0];
		expect(event.rawPayload.big).toBe("x".repeat(50));
		expect("contentTruncated" in event).toBe(false);
		expect("toolInputTruncated" in event).toBe(false);
	});

	test("the explicitly-defaulted request is byte-for-byte the plain one", async () => {
		const pairs: Array<[string, string]> = [
			[`/sessions?projectId=${projectId}`, `/sessions?projectId=${projectId}&view=full`],
			[`/sessions/${sessionId}`, `/sessions/${sessionId}?eventsLimit=500&compact=false&omit=`],
			[
				`/sessions/${sessionId}/timeline`,
				`/sessions/${sessionId}/timeline?compact=false&limit=50&offset=0`,
			],
		];
		for (const [plain, explicit] of pairs) {
			const a = await text(plain);
			const b = await text(explicit);
			expect({ plain, status: a.status }).toEqual({ plain, status: 200 });
			expect(b).toEqual(a);
		}
	});
});

// ── 2. view=card ───────────────────────────────────────────────────────────

describe("GET /sessions?view=card", () => {
	const cardIds: string[] = [];
	beforeAll(async () => {
		const heavy = prose(7, 60_000);
		for (let i = 0; i < 6; i++) {
			const id = await seedSession(`shaping-card-${RUN}-${i}`, {
				displayName: `card ${i}`,
				notes: heavy,
				claudeMdContent: heavy,
				claudeMdPath: "/tmp/CLAUDE.md",
				transcriptPath: "/tmp/transcript.jsonl",
				planSummary: ["step one", "step two"],
				reportedHost: i === 0 ? "build-box" : null,
				ownerUserId: null,
				metadata: {
					renameSource: "user",
					permissionWait:
						i === 1 ? { ids: ["toolu_secret_a", "toolu_secret_b"], anon: 1 } : { ids: [], anon: 0 },
					junk: heavy.slice(0, 5000),
				},
				isWorking: i === 2,
				currentTurnStartedAt: i === 2 ? "2026-10-19T10:00:00.000Z" : null,
				status: i === 3 ? "failed" : "active",
				endedAt: i === 3 ? new Date().toISOString() : null,
				isArchived: i === 4,
			});
			cardIds.push(id);
		}
		// The failed session was started by a launch that failed with a message.
		await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: cardIds[3] as string,
				agentType: "claude_code",
				cwd: "/tmp/x",
				status: "failed",
				error: `claude is not installed\n\tat /usr/local/bin/claude:1\u0007 ${"y".repeat(400)}`,
			} as never);
	});

	const cards = async (query = "") => {
		const res = await json(`/sessions?projectId=${projectId}&view=card${query}`);
		expect(res.status).toBe(200);
		return res.body as { sessions: Array<Body>; total: number };
	};

	test("rows have exactly the card fields plus the permission count and the failure reason", async () => {
		const { sessions: rows, total } = await cards();
		expect(total).toBeGreaterThanOrEqual(6);
		const row = rows.find((r) => r.sessionId === cardIds[0]);
		expect(keys(row as object)).toEqual(
			[...SESSION_CARD_FIELDS, "permissionWait", "failureReason"].sort(),
		);
		for (const heavy of [
			"notes",
			"claudeMdContent",
			"claudeMdPath",
			"claudeMdChecksum",
			"claudeMdUpdatedAt",
			"planSummary",
			"transcriptPath",
			"metadata",
			"reportedHost",
			"aiSpendCents",
			"watcherState",
			"managedSession",
		]) {
			expect(heavy in (row as object)).toBe(false);
		}
	});

	test("it carries the owner, managed flag, machine, turn start and operational state", async () => {
		const { sessions: rows } = await cards();
		const byId = (i: number) => rows.find((r) => r.sessionId === cardIds[i]) as Body;
		expect(byId(0).machine).toBe("build-box");
		expect(byId(0).managed).toBe(false);
		expect(byId(0).ownerUserId).toBeNull();
		expect(byId(0).nameSource).toBe("user");
		expect(byId(2).currentTurnStartedAt).toBe("2026-10-19T10:00:00.000Z");
		expect(byId(2).operationalStatus).toBe("working");
		expect(byId(4).isArchived).toBe(true);
	});

	test("the heavy columns are not read from the database at all, not just left out of the answer", async () => {
		const { SESSION_CARD_ROW, SESSION_ROW_WITH_MACHINE } = await import(
			"../services/session-tracker.js"
		);
		const readsOf = (selection: typeof SESSION_ROW_WITH_MACHINE) =>
			getDb().select(selection).from(sessions).toSQL().sql;
		const heavy = [
			"claude_md_content",
			"claude_md_path",
			"claude_md_checksum",
			"claude_md_updated_at",
			"notes",
			"plan_summary",
			"transcript_path",
		];
		// the full row reads them (so the check below is not vacuous) and the card row does not
		const full = readsOf(SESSION_ROW_WITH_MACHINE);
		const card = readsOf(SESSION_CARD_ROW);
		for (const column of heavy) {
			expect({ column, full: full.includes(`"${column}"`) }).toEqual({ column, full: true });
			expect({ column, card: card.includes(`"${column}"`) }).toEqual({ column, card: false });
		}
		expect(card).toContain('"session_id"');
		expect(card).toContain('"metadata"');
	});

	test("the card page's statements select the NULLed columns, for the plain page and for the operational page", async () => {
		const db = getDb();
		const spy = spyOn(db, "select");
		try {
			for (const query of ["", "&operational=working"]) {
				spy.mockClear();
				expect((await get(`/sessions?projectId=${projectId}&view=card${query}`)).status).toBe(200);
				// every statement that reads session rows whole: its CLAUDE.md column is not a column
				const reads = spy.mock.calls
					.map((call) => call[0] as Record<string, unknown> | undefined)
					.filter((fields) => fields && "claudeMdContent" in fields && "sessionId" in fields);
				expect({ query, statements: reads.length > 0 }).toEqual({ query, statements: true });
				for (const fields of reads) {
					expect("columnType" in (fields?.claudeMdContent as object)).toBe(false);
					expect("columnType" in (fields?.notes as object)).toBe(false);
				}
			}
			// positive control: the full list does select the column
			spy.mockClear();
			expect((await get(`/sessions?projectId=${projectId}`)).status).toBe(200);
			const full = spy.mock.calls
				.map((call) => call[0] as Record<string, unknown> | undefined)
				.filter((fields) => fields && "claudeMdContent" in fields && "sessionId" in fields);
			expect(full.length).toBeGreaterThan(0);
			for (const fields of full)
				expect("columnType" in (fields?.claudeMdContent as object)).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	test("a session that isn't failed says nothing about failing, even when a launch of it recorded an error", async () => {
		await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: cardIds[5] as string,
				agentType: "claude_code",
				cwd: "/tmp/x",
				status: "cancelled",
				error: "cancelled by the user: not a failure",
			} as never);
		const { sessions: rows } = await cards();
		expect(rows.find((r) => r.sessionId === cardIds[5])?.failureReason).toBeNull();
	});

	test("the permission wait is a count, and no tool id is in the response", async () => {
		const { status, body } = await text(`/sessions?projectId=${projectId}&view=card`);
		expect(status).toBe(200);
		expect(body).not.toContain("toolu_secret");
		const rows = (JSON.parse(body) as { sessions: Array<Body> }).sessions;
		const waiting = rows.find((r) => r.sessionId === cardIds[1]);
		expect(waiting?.permissionWait).toBe(3);
		expect(waiting?.operationalStatus).toBe("waiting");
		expect(rows.find((r) => r.sessionId === cardIds[0])?.permissionWait).toBe(0);
	});

	test("a failed session says why in one short printable line; the others say nothing", async () => {
		const { sessions: rows } = await cards();
		const failed = rows.find((r) => r.sessionId === cardIds[3]) as Body;
		expect(failed.status).toBe("failed");
		expect(typeof failed.failureReason).toBe("string");
		expect(
			failed.failureReason.startsWith("claude is not installed at /usr/local/bin/claude:1"),
		).toBe(true);
		expect(Array.from(failed.failureReason).length).toBeLessThanOrEqual(120);
		expect(failed.failureReason.endsWith("…")).toBe(true);
		expect(
			Array.from(failed.failureReason as string).some((c) => (c.codePointAt(0) ?? 0) < 32),
		).toBe(false);
		for (const i of [0, 1, 2, 4, 5]) {
			expect(rows.find((r) => r.sessionId === cardIds[i])?.failureReason).toBeNull();
		}
	});

	test("it works with operational, tab and total", async () => {
		const working = await cards("&operational=working");
		expect(working.sessions.map((r) => r.sessionId)).toContain(cardIds[2] as string);
		expect(working.sessions.every((r) => r.operationalStatus === "working")).toBe(true);
		expect(keys(working.sessions[0] as object)).toContain("permissionWait");
		expect(working.total).toBe(working.sessions.length);

		const archived = await cards("&tab=archived");
		expect(archived.sessions.map((r) => r.sessionId)).toEqual([cardIds[4] as string]);
		expect(archived.total).toBe(1);

		const paged = await cards("&limit=2&offset=1");
		expect(paged.sessions).toHaveLength(2);
		expect(paged.total).toBeGreaterThanOrEqual(6);
	});

	test("an unknown view, and a view with the fields projection, are refused", async () => {
		const bad = await json("/sessions?view=tiny");
		expect(bad.status).toBe(400);
		expect(bad.body).toMatchObject({ error: "invalid_view", allowed: ["full", "card"] });
		const both = await json("/sessions?view=card&fields=sessionId");
		expect(both.status).toBe(400);
		expect(both.body).toMatchObject({ error: "unsupported_combination" });
	});
});

// ── 3. detail ──────────────────────────────────────────────────────────────

describe("GET /sessions/:id with eventsLimit, compact and omit", () => {
	let sessionId = "";
	beforeAll(async () => {
		sessionId = await seedSession(`shaping-detail-${RUN}`, {
			notes: "keep me",
			claudeMdContent: "# claude md",
			claudeMdPath: "/p/CLAUDE.md",
			claudeMdChecksum: "abc",
			claudeMdUpdatedAt: new Date().toISOString(),
		});
		await seedEvents(sessionId, 12, (i) => ({
			content: `content ${i} ${"c".repeat(5000)}`,
			toolResponse: "r".repeat(5000),
			toolInput: { command: "k".repeat(6000), cwd: "/work" },
			rawPayload: { i, blob: "b".repeat(3000) },
		}));
	});

	test("eventsLimit keeps the newest events", async () => {
		const ids = await eventIds(sessionId);
		const { body } = await json(`/sessions/${sessionId}?eventsLimit=3`);
		expect(body.events.map((e: { id: number }) => e.id)).toEqual(ids.slice(0, 3));
		const none = await json(`/sessions/${sessionId}?eventsLimit=0`);
		expect(none.body.events).toEqual([]);
	});

	test("eventsLimit=0 doesn't read events at all", async () => {
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		const statements = async (query: string) =>
			countDbCalls(async () => {
				expect((await get(`/sessions/${sessionId}?${query}`)).status).toBe(200);
			});
		expect(await statements("eventsLimit=0")).toBe(await statements("omit=events"));
		expect(await statements("eventsLimit=0")).toBeLessThan(await statements("eventsLimit=1"));
	});

	test("eventsLimit outside 0..500 or not a number is refused", async () => {
		for (const value of ["501", "-1", "abc", "1.5", "99999999999"]) {
			const res = await json(`/sessions/${sessionId}?eventsLimit=${value}`);
			expect({ value, status: res.status }).toEqual({ value, status: 400 });
			expect(res.body).toMatchObject({ error: "invalid_events_limit", max: 500 });
		}
	});

	test("compact drops the raw payload and cuts each long field, flagging the cut", async () => {
		const full = await json(`/sessions/${sessionId}`);
		const { body } = await json(`/sessions/${sessionId}?compact=true`);
		expect(body.events).toHaveLength(full.body.events.length);
		const event = body.events[0];
		expect("rawPayload" in event).toBe(false);
		expect(event.contentTruncated).toBe(true);
		expect(event.toolResponseTruncated).toBe(true);
		expect(event.toolInputTruncated).toBe(true);
		expect(new TextEncoder().encode(event.content).length).toBeLessThanOrEqual(2048);
		expect(typeof event.toolInput).toBe("object");
		// Everything but the shaped fields is what the full read says.
		expect(event.id).toBe(full.body.events[0].id);
		expect(event.eventType).toBe(full.body.events[0].eventType);
		expect(body.session).toEqual(full.body.session);
	});

	test("an event that already fits is left whole", async () => {
		const small = await seedSession(`shaping-small-${RUN}`);
		await seedEvents(small, 1, () => ({
			content: "short",
			toolInput: { a: 1 },
			rawPayload: { z: 1 },
		}));
		const { body } = await json(`/sessions/${small}?compact=true`);
		expect(body.events[0].content).toBe("short");
		expect(body.events[0].toolInput).toEqual({ a: 1 });
		expect("contentTruncated" in body.events[0]).toBe(false);
		expect("rawPayload" in body.events[0]).toBe(false);
	});

	test("omit leaves the named parts out; omitted text parts stay as null", async () => {
		const { body } = await json(
			`/sessions/${sessionId}?omit=events,claudeMd&omit=notes,controlActions,reportedByKey`,
		);
		expect(body.events).toEqual([]);
		expect("controlActions" in body).toBe(false);
		expect("reportedByKey" in body).toBe(false);
		for (const field of [
			"claudeMdContent",
			"claudeMdPath",
			"claudeMdChecksum",
			"claudeMdUpdatedAt",
			"notes",
		]) {
			expect({ field, value: body.session[field] }).toEqual({ field, value: null });
		}
		// The rest of the session is untouched.
		const full = await json(`/sessions/${sessionId}`);
		for (const field of Object.keys(full.body.session)) {
			if (/^claudeMd|^notes$/.test(field)) continue;
			expect({ field, value: body.session[field] }).toEqual({
				field,
				value: full.body.session[field],
			});
		}
	});

	test("omitting nothing, or an empty entry, changes nothing; an unknown part is refused", async () => {
		const plain = await text(`/sessions/${sessionId}`);
		expect(await text(`/sessions/${sessionId}?omit=`)).toEqual(plain);
		expect(await text(`/sessions/${sessionId}?omit=,`)).toEqual(plain);
		const bad = await json(`/sessions/${sessionId}?omit=events,metadata`);
		expect(bad.status).toBe(400);
		expect(bad.body).toMatchObject({ error: "invalid_omit", value: "metadata" });
	});

	test("compact must be true or false", async () => {
		const bad = await json(`/sessions/${sessionId}?compact=yes`);
		expect(bad.status).toBe(400);
		expect(bad.body).toMatchObject({ error: "invalid_compact" });
	});

	test("an unknown session is still 404, with or without the parameters", async () => {
		expect((await get("/sessions/nope-nope?eventsLimit=3&compact=true")).status).toBe(404);
	});
});

// ── 4. timeline + context ──────────────────────────────────────────────────

describe("GET /sessions/:id/timeline with beforeId and compact", () => {
	let sessionId = "";
	beforeAll(async () => {
		sessionId = await seedSession(`shaping-timeline-${RUN}`);
		await seedEvents(sessionId, 130, (i) => ({
			content: `event ${i} ${"t".repeat(4000)}`,
			rawPayload: { i, blob: "p".repeat(2000) },
		}));
	});

	const page = async (query: string) => {
		const res = await json(`/sessions/${sessionId}/timeline?${query}`);
		expect(res.status).toBe(200);
		return res.body.events as Array<{ id: number }>;
	};

	test("beforeId returns the events older than it, newest first, and walking pages covers every event once", async () => {
		const all = await eventIds(sessionId);
		const first = await page("limit=50");
		expect(first.map((e) => e.id)).toEqual(all.slice(0, 50));

		const second = await page(`limit=50&beforeId=${first.at(-1)?.id}`);
		expect(second.map((e) => e.id)).toEqual(all.slice(50, 100));

		const third = await page(`limit=50&beforeId=${second.at(-1)?.id}`);
		expect(third.map((e) => e.id)).toEqual(all.slice(100));
		expect(third).toHaveLength(30);

		const end = await page(`limit=50&beforeId=${third.at(-1)?.id}`);
		expect(end).toEqual([]);
	});

	test("a phone's read says where the next page starts: the oldest id of a full page, null once the log ends", async () => {
		const all = await eventIds(sessionId);
		const read = async (query: string) =>
			(await json(`/sessions/${sessionId}/timeline?${query}`)).body as {
				events: Array<{ id: number }>;
				nextBeforeId?: number | null;
			};

		const first = await read("limit=50&compact=true");
		expect(first.nextBeforeId).toBe(all[49]);
		const second = await read(`limit=50&beforeId=${first.nextBeforeId}`);
		expect(second.events.map((e) => e.id)).toEqual(all.slice(50, 100));
		expect(second.nextBeforeId).toBe(all[99]);
		const third = await read(`limit=50&beforeId=${second.nextBeforeId}`);
		expect(third.events).toHaveLength(30);
		expect(third.nextBeforeId).toBeNull();
		// a page that is exactly full is told there may be more; the next read finds the end
		const exact = await read(`limit=30&beforeId=${all[99]}`);
		expect(exact.nextBeforeId).toBe(all[129]);
		const end = await read(`limit=30&beforeId=${exact.nextBeforeId}`);
		expect(end.events).toEqual([]);
		expect(end.nextBeforeId).toBeNull();
	});

	test("plain and offset reads keep the `{ events }` shape: no cursor, byte for byte as before", async () => {
		for (const query of [
			"limit=5",
			"limit=5&offset=0",
			"limit=5&offset=5&compact=true",
			"limit=5&compact=false",
		]) {
			const { body } = await json(`/sessions/${sessionId}/timeline?${query}`);
			expect({ query, keys: keys(body) }).toEqual({ query, keys: ["events"] });
		}
	});

	test("beforeId is exclusive: the event it names is not in the page", async () => {
		const all = await eventIds(sessionId);
		const events = await page(`limit=5&beforeId=${all[10]}`);
		expect(events.map((e) => e.id)).toEqual(all.slice(11, 16));
	});

	test("an id beyond any event (even past a 32-bit integer) returns the newest page", async () => {
		const all = await eventIds(sessionId);
		for (const beforeId of ["9999999999", "999999999999999"]) {
			const events = await page(`limit=3&beforeId=${beforeId}`);
			expect(events.map((e) => e.id)).toEqual(all.slice(0, 3));
		}
	});

	test("beforeId must be a positive integer and can't be combined with offset", async () => {
		for (const value of ["0", "-3", "abc", "1.5", "", "1234567890123456"]) {
			const res = await json(`/sessions/${sessionId}/timeline?beforeId=${value}`);
			expect({ value, status: res.status }).toEqual({ value, status: 400 });
			expect(res.body).toMatchObject({ error: "invalid_before_id" });
		}
		const both = await json(`/sessions/${sessionId}/timeline?beforeId=5&offset=1`);
		expect(both.status).toBe(400);
		expect(both.body).toMatchObject({ error: "unsupported_combination" });
	});

	test("compact applies to a keyset page the same way", async () => {
		const { body } = await json(`/sessions/${sessionId}/timeline?limit=5&compact=true`);
		for (const event of body.events) {
			expect("rawPayload" in event).toBe(false);
			expect(event.contentTruncated).toBe(true);
		}
	});

	test("the event context is compact on request and whole otherwise", async () => {
		const all = await eventIds(sessionId);
		const target = all[60];
		const full = await json(`/sessions/${sessionId}/events/${target}/context?around=3`);
		expect(full.body.events).toHaveLength(7);
		expect("rawPayload" in full.body.events[0]).toBe(true);
		const compact = await json(
			`/sessions/${sessionId}/events/${target}/context?around=3&compact=true`,
		);
		expect(compact.body.target).toEqual({ id: target });
		expect(compact.body.events.map((e: { id: number }) => e.id)).toEqual(
			full.body.events.map((e: { id: number }) => e.id),
		);
		for (const event of compact.body.events) {
			expect("rawPayload" in event).toBe(false);
			expect(event.contentTruncated).toBe(true);
		}
		const bad = await json(`/sessions/${sessionId}/events/${target}/context?compact=1`);
		expect(bad.status).toBe(400);
	});
});

describe("keyset paging is stable while events are written", () => {
	test("a walk from the newest page sees every event that existed when it began, once, in order, whatever is inserted meanwhile", async () => {
		const sessionId = await seedSession(`shaping-stable-${RUN}`);
		await seedEvents(sessionId, 140);
		const existing = await eventIds(sessionId);

		let writing = true;
		let written = 0;
		const writer = (async () => {
			while (writing && written < 120) {
				await seedEvents(sessionId, 3);
				written += 3;
			}
		})();

		const seen: number[] = [];
		let beforeId: number | null = null;
		for (let guard = 0; guard < 30; guard++) {
			const query: string = `limit=25${beforeId === null ? "" : `&beforeId=${beforeId}`}`;
			const res = await json(`/sessions/${sessionId}/timeline?${query}`);
			expect(res.status).toBe(200);
			const ids = (res.body.events as Array<{ id: number }>).map((e) => e.id);
			if (ids.length === 0) break;
			seen.push(...ids);
			beforeId = ids.at(-1) as number;
			// let the writer land a few more rows between pages
			await Bun.sleep(5);
		}
		writing = false;
		await writer;

		expect(written).toBeGreaterThan(0);
		// No repeats, strictly descending.
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen).toEqual([...seen].sort((a, b) => b - a));
		// Every event from before the walk began is there: nothing slipped through a gap.
		const seenSet = new Set(seen);
		expect(existing.filter((id) => !seenSet.has(id))).toEqual([]);
	});

	test("offset paging, by contrast, repeats events when rows are inserted between pages", async () => {
		const sessionId = await seedSession(`shaping-offset-${RUN}`);
		await seedEvents(sessionId, 60);
		const first = (await json(`/sessions/${sessionId}/timeline?limit=20&offset=0`)).body.events;
		await seedEvents(sessionId, 5);
		const second = (await json(`/sessions/${sessionId}/timeline?limit=20&offset=20`)).body.events;
		const firstIds = new Set(first.map((e: { id: number }) => e.id));
		expect(second.some((e: { id: number }) => firstIds.has(e.id))).toBe(true);
	});
});

// ── 5. gzip budgets ────────────────────────────────────────────────────────

describe("gzip budgets on the fat fixture", () => {
	const FAT_EVENTS = 500;
	let fatSession = "";
	const FAT_ROWS = 50;

	beforeAll(async () => {
		fatSession = await seedSession(`shaping-fat-${RUN}`);
		await seedEvents(fatSession, FAT_EVENTS, (i) => ({
			content: prose(i * 3 + 1, 4 * 1024),
			toolInput: { command: prose(i * 3 + 2, 8 * 1024), description: "run" },
			toolResponse: prose(i * 3 + 4, 4 * 1024),
			rawPayload: { transcript: prose(i * 3 + 3, 32 * 1024), i },
		}));
		const heavy = prose(99, 80_000);
		for (let i = 0; i < FAT_ROWS; i++) {
			await seedSession(`shaping-fatrow-${RUN}-${i}`, {
				notes: heavy,
				claudeMdContent: heavy,
				planSummary: Array.from({ length: 20 }, (_, n) => prose(n + i, 120)),
				currentTask: prose(i, 200),
				cwd: `/work/${prose(i, 80).replace(/ /g, "/")}`,
				metadata: { renameSource: "user", blob: heavy.slice(0, 20_000) },
			});
		}
	});

	test("a 50-event timeline page, compact: <= 64 KB gzipped", async () => {
		const { status, body } = await text(`/sessions/${fatSession}/timeline?limit=50&compact=true`);
		expect(status).toBe(200);
		const gz = gzipBytes(body);
		console.log(`[budget] timeline page (50, compact): ${gz} B gz, ${body.length} B raw`);
		expect(gz).toBeLessThanOrEqual(64 * 1024);
	});

	test("a compact detail: <= 150 KB gzipped, with all 500 events and with the app's 50", async () => {
		const whole = await text(
			`/sessions/${fatSession}?compact=true&eventsLimit=500&omit=claudeMd,notes`,
		);
		expect(whole.status).toBe(200);
		const wholeGz = gzipBytes(whole.body);
		console.log(
			`[budget] detail (500 events, compact): ${wholeGz} B gz, ${whole.body.length} B raw`,
		);
		expect(wholeGz).toBeLessThanOrEqual(150 * 1024);

		const app50 = await text(
			`/sessions/${fatSession}?compact=true&eventsLimit=50&omit=claudeMd,notes`,
		);
		const gz50 = gzipBytes(app50.body);
		console.log(`[budget] detail (50 events, compact): ${gz50} B gz, ${app50.body.length} B raw`);
		expect(gz50).toBeLessThanOrEqual(150 * 1024);
	});

	test("a compact detail that doesn't say how many events it wants gets 50, and stays small in raw bytes", async () => {
		const { status, body } = await text(`/sessions/${fatSession}?compact=true`);
		expect(status).toBe(200);
		const parsed = JSON.parse(body) as { events: Array<{ id: number }> };
		expect(parsed.events).toHaveLength(50);
		const ids = await eventIds(fatSession);
		expect(parsed.events.map((e) => e.id)).toEqual(ids.slice(0, 50));
		const raw = new TextEncoder().encode(body).length;
		console.log(`[budget] compact detail default (50 events): ${raw} B raw`);
		expect(raw).toBeLessThanOrEqual(300 * 1024);
		// the maximum is unchanged, and an explicit ask is honoured either way
		const more = JSON.parse(
			(await text(`/sessions/${fatSession}?compact=true&eventsLimit=500`)).body,
		);
		expect(more.events).toHaveLength(500);
		const fewer = JSON.parse(
			(await text(`/sessions/${fatSession}?compact=true&eventsLimit=7`)).body,
		);
		expect(fewer.events).toHaveLength(7);
		expect((await get(`/sessions/${fatSession}?compact=true&eventsLimit=501`)).status).toBe(400);
	});

	test("without compact the detail still embeds every event, as it always did", async () => {
		const parsed = JSON.parse((await text(`/sessions/${fatSession}?omit=claudeMd,notes`)).body);
		expect(parsed.events).toHaveLength(500);
		expect(keys(parsed.events[0])).toEqual(EVENT_KEYS);
	});

	test("the uncompacted timeline page is far over the budget (the fixture is fat enough to mean something)", async () => {
		const { body } = await text(`/sessions/${fatSession}/timeline?limit=50`);
		const gz = gzipBytes(body);
		console.log(`[budget] timeline page (50, full): ${gz} B gz, ${body.length} B raw`);
		expect(gz).toBeGreaterThan(64 * 1024);
		expect(body.length).toBeGreaterThan(50 * 40 * 1024);
	});

	test("a 50-row card list: <= 40 KB gzipped", async () => {
		const { status, body } = await text(`/sessions?projectId=${projectId}&view=card&limit=50`);
		expect(status).toBe(200);
		const rows = (JSON.parse(body) as { sessions: unknown[] }).sessions;
		expect(rows).toHaveLength(50);
		const gz = gzipBytes(body);
		console.log(`[budget] card list (50 rows): ${gz} B gz, ${body.length} B raw`);
		expect(gz).toBeLessThanOrEqual(40 * 1024);

		const full = await text(`/sessions?projectId=${projectId}&limit=50`);
		expect(gzipBytes(full.body)).toBeGreaterThan(40 * 1024);
	});
});
