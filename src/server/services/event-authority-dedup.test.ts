// Must-keep dedup behaviors that the AGEN-16 fix has to preserve, plus the
// off-UTC authority bug (stored SQLite timestamps parsed as local time).
// Every test uses its own session id and filters by it; nothing here assumes
// an empty DB, so the file is safe on a shared Postgres database.

import { beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { insertNormalizedEvents, processHookEvent, processStatusUpdate } = await import(
	"./event-processor.js"
);
const { createAssistantTranscriptEvent, normalizeHookEvent } = await import(
	"./event-normalizer.js"
);
const { appendManagedSessionEvents } = await import("./managed-session-state.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { emitAiEvent } = await import("./ai/ai-events.js");
const { eq } = await import("drizzle-orm");

import type { HookEventPayload } from "../../shared/types.js";

const FILE_TZ = process.env.TZ;
const MESSAGE = "All done here.";

beforeAll(() => initializeDatabase());

async function withTZ<T>(tz: string, fn: () => Promise<T>): Promise<T> {
	const saved = process.env.TZ;
	process.env.TZ = tz;
	try {
		return await fn();
	} finally {
		process.env.TZ = saved ?? "UTC";
	}
}

function newSessionId(prefix: string) {
	return `${prefix}-${crypto.randomUUID()}`;
}

async function mkSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			metadata: {},
		})
		.execute();
}

async function rowsFor(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

async function histogram(sessionId: string) {
	const counts: Record<string, number> = {};
	for (const row of await rowsFor(sessionId)) {
		const key = `${row.eventType}/${row.source}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return JSON.stringify(counts);
}

async function assistantRows(sessionId: string) {
	return (await rowsFor(sessionId)).filter((row) => row.category === "assistant_message");
}

function stopPayload(sessionId: string): HookEventPayload {
	return {
		session_id: sessionId,
		hook_event_name: "Stop",
		cwd: "/tmp/agentpulse-dedup-test",
		last_assistant_message: MESSAGE,
	};
}

function transcriptEvent(uuid = "tu-1") {
	return createAssistantTranscriptEvent(
		MESSAGE,
		{ transcript_uuid: uuid, transcript_type: "assistant" },
		"claude_transcript_text",
	);
}

function hookAssistantEvents(sessionId: string) {
	return normalizeHookEvent(stopPayload(sessionId), "claude_code").filter(
		(event) => event.category === "assistant_message",
	);
}

function hookAssistant(content: string): ReturnType<typeof transcriptEvent> {
	return {
		eventType: "AssistantMessage",
		category: "assistant_message",
		source: "observed_hook",
		content,
		isNoise: false,
		providerEventType: "Stop",
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
	};
}

async function hookThenTranscript(prefix: string) {
	const sid = newSessionId(prefix);
	await processHookEvent(stopPayload(sid), "claude_code");
	await insertNormalizedEvents(sid, [transcriptEvent()]);
	const rows = await assistantRows(sid);
	expect(
		rows.map((row) => row.source),
		await histogram(sid),
	).toEqual(["observed_transcript"]);
}

async function transcriptThenHook(prefix: string) {
	const sid = newSessionId(prefix);
	await mkSession(sid);
	await insertNormalizedEvents(sid, [transcriptEvent()]);
	const second = await insertNormalizedEvents(sid, hookAssistantEvents(sid));
	expect(second, await histogram(sid)).toEqual([]);
	const rows = await assistantRows(sid);
	expect(
		rows.map((row) => row.source),
		await histogram(sid),
	).toEqual(["observed_transcript"]);
}

function bareUtc(ms: number) {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

async function backdatedStaysTwo(prefix: string) {
	const sid = newSessionId(prefix);
	await mkSession(sid);
	const [first] = await insertNormalizedEvents(sid, hookAssistantEvents(sid));
	expect(first?.id).toBeGreaterThan(0);
	await getDb()
		.update(events)
		.set({ createdAt: bareUtc(Date.now() - 60_000) })
		.where(eq(events.id, first?.id ?? -1));
	await insertNormalizedEvents(sid, [transcriptEvent()]);
	const rows = await assistantRows(sid);
	expect(rows.map((row) => row.source).sort(), await histogram(sid)).toEqual([
		"observed_hook",
		"observed_transcript",
	]);
}

describe("hook-vs-transcript authority across batches", () => {
	test("P1.1 hook then transcript under America/New_York keeps only the transcript row", () =>
		withTZ("America/New_York", () => hookThenTranscript("p1-1")));

	test("P1.2 transcript then hook under America/New_York drops the hook row", () =>
		withTZ("America/New_York", () => transcriptThenHook("p1-2")));

	test("P1.3 both orders under Asia/Kolkata", () =>
		withTZ("Asia/Kolkata", async () => {
			await hookThenTranscript("p1-3a");
			await transcriptThenHook("p1-3b");
		}));

	test("P1.4 both orders under UTC", () =>
		withTZ("UTC", async () => {
			await hookThenTranscript("p1-4a");
			await transcriptThenHook("p1-4b");
		}));

	test("P1.5 a row older than the window is not superseded (New_York and UTC)", async () => {
		await withTZ("America/New_York", () => backdatedStaysTwo("p1-5ny"));
		await withTZ("UTC", () => backdatedStaysTwo("p1-5utc"));
	});

	// F84: a mutant that applies only the first retained row's deletes
	// (`retained.slice(0,1).flatMap(...)` instead of `retained.flatMap(...)`
	// in event-processor.ts) survives every other test in this suite — every
	// other multi-row batch either has 0 or 1 rows that supersede something,
	// or supersedes the same stored row twice. This is the population that
	// discriminates: two DISTINCT stored rows, each superseded by its own
	// row in one two-row incoming batch.
	test("P1.11 a two-row batch deletes both of the two distinct rows it supersedes", async () => {
		const sid = newSessionId("p1-11");
		await mkSession(sid);

		const [hookRow1] = await insertNormalizedEvents(sid, [hookAssistant("first message")]);
		const [hookRow2] = await insertNormalizedEvents(sid, [hookAssistant("second message")]);
		expect(hookRow1?.id, await histogram(sid)).toBeGreaterThan(0);
		expect(hookRow2?.id, await histogram(sid)).toBeGreaterThan(0);
		expect(hookRow1?.id).not.toBe(hookRow2?.id);

		const inserted = await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent(
				"first message",
				{ transcript_uuid: "tu-p1-11-a" },
				"claude_transcript_text",
			),
			createAssistantTranscriptEvent(
				"second message",
				{ transcript_uuid: "tu-p1-11-b" },
				"claude_transcript_text",
			),
		]);
		expect(inserted, await histogram(sid)).toHaveLength(2);

		// Exactly the two transcript rows survive — no `observed_hook` row is
		// left behind. (Row ids aren't asserted directly: the events table's
		// cascade-FK rebuild rebuilds it without AUTOINCREMENT, so a freed id
		// can legitimately be recycled by an unrelated later insert; the
		// source/count check below is what actually discriminates the mutant —
		// under `retained.slice(0,1).flatMap(...)`, hookRow2 would survive
		// with source "observed_hook", changing this exact array.)
		const rows = await assistantRows(sid);
		expect(rows, await histogram(sid)).toHaveLength(2);
		expect(rows.map((row) => row.source).sort(), await histogram(sid)).toEqual([
			"observed_transcript",
			"observed_transcript",
		]);
	});
});

describe("content-window dedup that must survive the fix", () => {
	test("P1.6 identical /hooks/status batches collapse to one row", async () => {
		const sid = newSessionId("p1-6");
		await mkSession(sid);
		expect(await processStatusUpdate({ session_id: sid, status: "implementing" })).toBe(true);
		expect(await processStatusUpdate({ session_id: sid, status: "implementing" })).toBe(true);
		const rows = (await rowsFor(sid)).filter((row) => row.category === "status_update");
		expect(rows, await histogram(sid)).toHaveLength(1);
	});

	test("P1.7 identical managed events collapse to one row", async () => {
		const sid = newSessionId("p1-7");
		await mkSession(sid);
		const supervisorId = crypto.randomUUID();
		await seedOwnedLaunch(sid, supervisorId);
		const input = [
			{
				eventType: "LaunchStarted",
				category: "system_event" as const,
				content: "Launch started",
			},
		];
		expect(await appendManagedSessionEvents(supervisorId, sid, input)).toHaveLength(1);
		expect(await appendManagedSessionEvents(supervisorId, sid, input)).toEqual([]);
		expect(await rowsFor(sid), await histogram(sid)).toHaveLength(1);
	});

	test("P1.8 same text with different transcript_uuid in one batch stores both", async () => {
		const sid = newSessionId("p1-8");
		await mkSession(sid);
		const inserted = await insertNormalizedEvents(sid, [
			transcriptEvent("tu-a"),
			transcriptEvent("tu-b"),
		]);
		expect(inserted).toHaveLength(2);
		expect(await rowsFor(sid), await histogram(sid)).toHaveLength(2);
	});

	test("P1.9 identical emitAiEvent (observed_hook) returns null the second time", async () => {
		const sid = newSessionId("p1-9");
		await mkSession(sid);
		const payload = {
			sessionId: sid,
			source: "observed_hook" as const,
			category: "ai_error" as const,
			eventType: "ParseFailure",
			content: "bad json",
			rawPayload: { sub_type: "parse_failure" },
		};
		expect(await emitAiEvent(payload)).not.toBeNull();
		expect(await emitAiEvent(payload)).toBeNull();
		expect(await rowsFor(sid), await histogram(sid)).toHaveLength(1);
	});
});

test("P1.10 TZ sentinel: the file leaves TZ restored", () => {
	expect(process.env.TZ).toBe(FILE_TZ ?? "UTC");
	if (!FILE_TZ) {
		expect(Date.parse("2026-01-01 00:00:00")).toBe(Date.UTC(2026, 0, 1));
	}
});
