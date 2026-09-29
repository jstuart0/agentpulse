// Phase 7 (AGEN-16): the hook_delivery policy — durable identity dedup
// (t:/d: keys), the whole-delivery-drop rule (F48), the must-keeps this fix
// has to preserve (authority, permission-wait, the primary-row rule), and
// the observability counters. Every test uses its own session id and
// filters by it (harness rule 1); counters are asserted as deltas (rule 2).

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { eq } = await import("drizzle-orm");
const { processHookEvent, insertHookEvents } = await import("./event-processor.js");
const { computeDedupKey, getEventsDeduplicatedCounts, _resetEventDedupForTest } = await import(
	"./event-dedup.js"
);
const { normalizeHookEvent } = await import("./event-normalizer.js");
const { appendManagedSessionEvents } = await import("./managed-session-state.js");

import type {
	AgentType,
	ClaudeCodeEvent,
	CodexEvent,
	HookEventPayload,
} from "../../shared/types.js";
import type { HookDeliveryContext } from "./event-dedup.js";

const CLAUDE_CODE_EVENTS: ClaudeCodeEvent[] = [
	"SessionStart",
	"SessionEnd",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"TaskCreated",
	"TaskCompleted",
	"UserPromptSubmit",
	"PermissionRequest",
	"PermissionDenied",
	"Notification",
	"PreCompact",
	"PostCompact",
	"PostToolUseFailure",
];
const CODEX_EVENTS: CodexEvent[] = [
	"SessionStart",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"PermissionRequest",
	"PreCompact",
	"PostCompact",
];

beforeAll(() => initializeDatabase());
beforeEach(() => _resetEventDedupForTest());

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
		const key = `${row.eventType}/${row.source}/${row.content}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return JSON.stringify(counts);
}

async function sessionRow(sessionId: string) {
	const [row] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row;
}

const ANON_CTX: HookDeliveryContext = { keyId: "anonymous", deliveryId: null, origin: "native" };
function ctxWith(deliveryId: string | null): HookDeliveryContext {
	return { keyId: "anonymous", deliveryId, origin: "native" };
}

// Real native Codex hooks always carry transcript_path (Context); only the
// legacy pre-upgrade observer omits it while also posting with no origin
// header. Every test in this file that posts as codex_cli is exercising
// genuine native-hook identity, not the legacy branch — ingest-legacy-
// observer.test.ts owns that. So stamp transcript_path here unless a test
// explicitly overrides it.
async function post(
	sessionId: string,
	payload: Partial<HookEventPayload> & { hook_event_name: string },
	agentType: AgentType = "claude_code",
	ctx: HookDeliveryContext = ANON_CTX,
) {
	const body = { session_id: sessionId, cwd: "/w", ...payload } as HookEventPayload;
	if (agentType === "codex_cli" && !body.transcript_path) {
		body.transcript_path = "/fake/transcript.jsonl";
	}
	return processHookEvent(body, agentType, ctx);
}

// ── P2.1-P2.10: population scenarios (F131) ─────────────────────────────────

describe("P2.1-P2.10: hook_delivery stores every distinct row", () => {
	test("A: 300 distinct-tool_use_id PreToolUse events all store", async () => {
		const sid = newSessionId("p2-a");
		await post(sid, { hook_event_name: "SessionStart", source: "startup" });
		for (let i = 1; i < 300; i++) {
			await post(sid, {
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: `echo ${i}` },
				tool_use_id: `toolu_${i}`,
			});
		}
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(300);
	}, 20_000);

	test("B: 20 interleaved Pre/Post Bash pairs plus a prompt — 41 rows, includes tu7", async () => {
		const sid = newSessionId("p2-b");
		await post(sid, { hook_event_name: "UserPromptSubmit", prompt: "run the build" });
		for (let i = 0; i < 20; i++) {
			await post(sid, {
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: `npm run step${i}` },
				tool_use_id: `tu${i}`,
			});
			await post(sid, {
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: `npm run step${i}` },
				tool_response: { stdout: `out ${i}` },
				tool_use_id: `tu${i}`,
			});
		}
		const rows = await rowsFor(sid);
		expect(rows.length, await histogram(sid)).toBe(41);
		expect(
			rows.some(
				(r) => r.rawPayload && (r.rawPayload as Record<string, unknown>).tool_use_id === "tu7",
			),
		).toBe(true);
	}, 20_000);

	test("C: 3 prompts x 10 mixed-tool pairs x Stop — 66 rows, 3 Stops", async () => {
		const sid = newSessionId("p2-c");
		const tools = ["Read", "Edit", "Bash"];
		for (let p = 0; p < 3; p++) {
			await post(sid, { hook_event_name: "UserPromptSubmit", prompt: `prompt ${p}` });
			for (let i = 0; i < 10; i++) {
				const t = tools[i % 3];
				const id = `c${p}_${i}`;
				await post(sid, {
					hook_event_name: "PreToolUse",
					tool_name: t,
					tool_input: { file_path: `/w/f${i}.ts` },
					tool_use_id: id,
				});
				await post(sid, {
					hook_event_name: "PostToolUse",
					tool_name: t,
					tool_response: `r${i}`,
					tool_use_id: id,
				});
			}
			await post(sid, { hook_event_name: "Stop" });
		}
		const rows = await rowsFor(sid);
		expect(rows.length, await histogram(sid)).toBe(66);
		expect(rows.filter((r) => r.eventType === "Stop")).toHaveLength(3);
	}, 20_000);

	test("identical Claude Stop x2 -> 2 (id-less, unkeyed, fail-open)", async () => {
		const sid = newSessionId("p2-stop2");
		await post(sid, { hook_event_name: "Stop" });
		await post(sid, { hook_event_name: "Stop" });
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);
	});

	test('"yes" UserPromptSubmit x2 -> 2', async () => {
		const sid = newSessionId("p2-yes2");
		await post(sid, { hook_event_name: "UserPromptSubmit", prompt: "yes" });
		await post(sid, { hook_event_name: "UserPromptSubmit", prompt: "yes" });
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);
	});

	test("Permission a/b -> 2; Request/Denied a -> 2 (GUARD, distinct eventType keys)", async () => {
		const sid = newSessionId("p2-perm");
		await post(sid, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "a" });
		await post(sid, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "b" });
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);

		const sid2 = newSessionId("p2-perm-ab");
		await post(sid2, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "a" });
		await post(sid2, { hook_event_name: "PermissionDenied", tool_name: "Bash", tool_use_id: "a" });
		expect((await rowsFor(sid2)).length, await histogram(sid2)).toBe(2);
	});

	test("id-less PostToolUse x2 -> 2 (unkeyed, no content-window collapse)", async () => {
		const sid = newSessionId("p2-idless-post");
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "ok" });
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "ok" });
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);
	});

	test("SessionStart x2 -> 2", async () => {
		const sid = newSessionId("p2-start2");
		await post(sid, { hook_event_name: "SessionStart" });
		await post(sid, { hook_event_name: "SessionStart" });
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);
	});

	test("Codex Pre+Post then a fresh call -> 4", async () => {
		const sid = newSessionId("p2-codex4");
		await post(
			sid,
			{ hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "call_1" },
			"codex_cli",
		);
		await post(
			sid,
			{ hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "call_1" },
			"codex_cli",
		);
		await post(
			sid,
			{ hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "call_2" },
			"codex_cli",
		);
		await post(
			sid,
			{ hook_event_name: "PostToolUse", tool_name: "exec_command", tool_use_id: "call_2" },
			"codex_cli",
		);
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(4);
	});

	test("Codex Stop x2 with distinct turn_id (as last_assistant_message) -> 4", async () => {
		const sid = newSessionId("p2-codex-stop4");
		await post(
			sid,
			{ hook_event_name: "Stop", last_assistant_message: "turn one done" },
			"codex_cli",
		);
		await post(
			sid,
			{ hook_event_name: "Stop", last_assistant_message: "turn two done" },
			"codex_cli",
		);
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(4);
	});
});

// ── P2.11-P2.21 ───────────────────────────────────────────────────────────

describe("P2.11-P2.21", () => {
	test("P2.11 dup1, other, dup1 -> 2, toolUseRetry +1", async () => {
		const sid = newSessionId("p2-11");
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "dup1" });
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "other" });
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "dup1" });
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
	});

	test("P2.12 the Codex Post verbatim x2 -> 1, toolUseRetry +1", async () => {
		const sid = newSessionId("p2-12");
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		const payload = {
			hook_event_name: "PostToolUse",
			tool_name: "exec_command",
			tool_input: { command: "ls" },
			tool_response: "a\nb",
			tool_use_id: "call_x",
		};
		await post(sid, payload, "codex_cli");
		await post(sid, payload, "codex_cli");
		expect((await rowsFor(sid)).length, await histogram(sid)).toBe(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
	});

	test("P2.13 the same tool_use_id in two sessions -> 1 each (GUARD)", async () => {
		const sidA = newSessionId("p2-13a");
		const sidB = newSessionId("p2-13b");
		await post(sidA, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "shared" });
		await post(sidB, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "shared" });
		expect((await rowsFor(sidA)).length).toBe(1);
		expect((await rowsFor(sidB)).length).toBe(1);
	});

	test("P2.15 insertHookEvents rejects for a missing session; once created, the retry is stored with toolUseRetry +0", async () => {
		const sid = newSessionId("p2-15");
		const normalized = normalizeHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "x",
			} as HookEventPayload,
			"claude_code",
		);
		await expect(
			insertHookEvents(sid, normalized, { kind: "hook_delivery", ctx: ANON_CTX, rawPayload: {} }),
		).rejects.toThrow();

		await mkSession(sid);
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		const stored = await insertHookEvents(sid, normalized, {
			kind: "hook_delivery",
			ctx: ANON_CTX,
			rawPayload: {},
		});
		expect(stored).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(0);
	});

	test("P2.16 Post P1, PermissionRequest P1, then Post P1 verbatim -> 1 Post row, toolUseRetry +1, wait cleared (GUARD)", async () => {
		const sid = newSessionId("p2-16");
		await mkSession(sid);
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "P1" });
		await post(sid, { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "P1" });
		const midSession = await sessionRow(sid);
		expect((midSession.metadata as Record<string, unknown> | null)?.permissionWait).toBeTruthy();
		await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "P1" });

		const rows = await rowsFor(sid);
		expect(
			rows.filter((r) => r.eventType === "PostToolUse"),
			await histogram(sid),
		).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
		const finalSession = await sessionRow(sid);
		expect(
			(finalSession.metadata as Record<string, unknown> | null)?.permissionWait,
		).toBeUndefined();
	});

	test("P2.19 eventsDeduplicated has exactly 4 keys, legacyObserverDeliveries is separate", () => {
		const counts = getEventsDeduplicatedCounts();
		expect(Object.keys(counts).sort()).toEqual(
			["authority", "contentWindow", "deliveryRetry", "toolUseRetry"].sort(),
		);
		for (const v of Object.values(counts)) expect(typeof v).toBe("number");
		expect("legacyObserverDeliveries" in counts).toBe(false);
	});

	test("P2.20 identical status x2 -> 1 row, contentWindow +1", async () => {
		const { processStatusUpdate } = await import("./event-processor.js");
		const sid = newSessionId("p2-20");
		await mkSession(sid);
		const before = getEventsDeduplicatedCounts().contentWindow;
		await processStatusUpdate({ session_id: sid, status: "implementing" });
		await processStatusUpdate({ session_id: sid, status: "implementing" });
		const rows = (await rowsFor(sid)).filter((r) => r.category === "status_update");
		expect(rows, await histogram(sid)).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().contentWindow - before).toBe(1);
	});
});

// ── NK1 / DUR1 / C1 ──────────────────────────────────────────────────────

test("NK1: a NULL-key pre-Phase-7 row plus a posted tuX row -> 2 rows (fail-open)", async () => {
	const { insertNormalizedEvents } = await import("./event-processor.js");
	const sid = newSessionId("nk1");
	await mkSession(sid);
	await insertNormalizedEvents(
		sid,
		normalizeHookEvent(
			{
				session_id: sid,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "tuX",
			} as HookEventPayload,
			"claude_code",
		),
	);
	await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tuX" });
	expect((await rowsFor(sid)).length, await histogram(sid)).toBe(2);
});

test("DUR1: a key written by an earlier process blocks the retry", async () => {
	const sid = newSessionId("dur1");
	await mkSession(sid);
	const seedKey = computeDedupKey({
		kind: "t",
		keyId: "anonymous",
		eventType: "PostToolUse",
		toolUseId: "X",
	});
	await getDb().insert(events).values({
		sessionId: sid,
		eventType: "PostToolUse",
		category: "tool_event",
		source: "observed_hook",
		content: "seed",
		isNoise: false,
		providerEventType: "PostToolUse",
		toolName: "Bash",
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		dedupKey: seedKey,
	});

	const before = getEventsDeduplicatedCounts().toolUseRetry;
	await post(sid, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "X" });
	const rows = await rowsFor(sid);
	expect(rows, await histogram(sid)).toHaveLength(1);
	expect(rows[0]?.content).toBe("seed");
	expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
});

test("C1: a real race — two concurrent insertHookEvents with the same t key -> 1 row, toolUseRetry +1", async () => {
	const sid = newSessionId("c1");
	await mkSession(sid);
	const normalized = normalizeHookEvent(
		{
			session_id: sid,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "race",
		} as HookEventPayload,
		"claude_code",
	);
	const before = getEventsDeduplicatedCounts().toolUseRetry;
	await Promise.all([
		insertHookEvents(sid, normalized, { kind: "hook_delivery", ctx: ANON_CTX, rawPayload: {} }),
		insertHookEvents(sid, normalized, { kind: "hook_delivery", ctx: ANON_CTX, rawPayload: {} }),
	]);
	expect((await rowsFor(sid)).length, await histogram(sid)).toBe(1);
	expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
});

// ── PR-inv ───────────────────────────────────────────────────────────────

test("PR-inv: the primary row is never an assistant row, for every known hook event name", () => {
	for (const agentType of ["claude_code", "codex_cli"] as const) {
		const names = agentType === "claude_code" ? CLAUDE_CODE_EVENTS : CODEX_EVENTS;
		for (const name of [...names, "SomeUnknownFutureEvent"]) {
			const rows = normalizeHookEvent(
				{
					session_id: "pr-inv",
					hook_event_name: name,
					last_assistant_message: "m",
					prompt: "p",
					tool_name: "Bash",
					tool_use_id: "u",
				} as HookEventPayload,
				agentType,
			);
			expect(rows[0]?.category, `${agentType}/${name}`).not.toBe("assistant_message");
		}
	}
});

// ── RP1-RP3c: whole-delivery drop (F48) ─────────────────────────────────

describe("RP1-RP3c: whole-delivery drop protects an authority-superseded secondary", () => {
	function bareUtc(ms: number) {
		return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
	}

	test("RP1: a replay after the assistant echo was authority-deleted stores nothing new; deliveryRetry +2", async () => {
		const { insertNormalizedEvents } = await import("./event-processor.js");
		const { createAssistantTranscriptEvent } = await import("./event-normalizer.js");
		const sid = newSessionId("rp1");
		await mkSession(sid);
		const ctx = ctxWith("delivery-rp1-aaaa");

		await post(sid, { hook_event_name: "Stop", last_assistant_message: "hi" }, "codex_cli", ctx);
		const afterFirst = await rowsFor(sid);
		expect(afterFirst, await histogram(sid)).toHaveLength(2); // Stop + AssistantMessage

		await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent("hi", { transcript_uuid: "tu-rp1" }, "claude_transcript_text"),
		]);
		const assistantRows = (await rowsFor(sid)).filter((r) => r.category === "assistant_message");
		expect(
			assistantRows.map((r) => r.source),
			await histogram(sid),
		).toEqual(["observed_transcript"]);
		const transcriptRow = assistantRows[0];
		await getDb()
			.update(events)
			.set({ createdAt: bareUtc(Date.now() - 3_600_000) })
			.where(eq(events.id, transcriptRow?.id ?? -1));

		const before = getEventsDeduplicatedCounts().deliveryRetry;
		await post(sid, { hook_event_name: "Stop", last_assistant_message: "hi" }, "codex_cli", ctx);

		const finalRows = await rowsFor(sid);
		const finalAssistant = finalRows.filter((r) => r.category === "assistant_message");
		expect(finalAssistant, await histogram(sid)).toHaveLength(1);
		expect(finalAssistant[0]?.source).toBe("observed_transcript");
		expect(
			finalRows.filter((r) => r.eventType === "Stop"),
			await histogram(sid),
		).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().deliveryRetry - before).toBe(2);
	});

	test("RP2: transcript arrives first, so the hook assistant is never stored -> 1 assistant row after the replay", async () => {
		const { insertNormalizedEvents } = await import("./event-processor.js");
		const { createAssistantTranscriptEvent } = await import("./event-normalizer.js");
		const sid = newSessionId("rp2");
		await mkSession(sid);
		const ctx = ctxWith("delivery-rp2-aaaa");

		await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent("hi", { transcript_uuid: "tu-rp2" }, "claude_transcript_text"),
		]);
		await post(sid, { hook_event_name: "Stop", last_assistant_message: "hi" }, "codex_cli", ctx);
		await post(sid, { hook_event_name: "Stop", last_assistant_message: "hi" }, "codex_cli", ctx);

		const assistantRows = (await rowsFor(sid)).filter((r) => r.category === "assistant_message");
		expect(assistantRows, await histogram(sid)).toHaveLength(1);
		expect(assistantRows[0]?.source).toBe("observed_transcript");
	});

	test("RP3: a compensated replay leaves no trace — no new broadcast row, no id growth, no extra assistant row", async () => {
		const { insertNormalizedEvents } = await import("./event-processor.js");
		const { createAssistantTranscriptEvent } = await import("./event-normalizer.js");
		const { processHookEvent } = await import("./event-processor.js");
		const sid = newSessionId("rp3");
		await mkSession(sid);
		const ctx = ctxWith("delivery-rp3-aaaa");

		await post(sid, { hook_event_name: "Stop", last_assistant_message: "hi" }, "codex_cli", ctx);
		await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent("hi", { transcript_uuid: "tu-rp3" }, "claude_transcript_text"),
		]);
		const transcriptRow = (await rowsFor(sid)).find((r) => r.source === "observed_transcript");
		await getDb()
			.update(events)
			.set({ createdAt: bareUtc(Date.now() - 3_600_000) })
			.where(eq(events.id, transcriptRow?.id ?? -1));

		const maxIdBefore = Math.max(...(await rowsFor(sid)).map((r) => r.id));
		const result = await processHookEvent(
			{
				session_id: sid,
				cwd: "/w",
				hook_event_name: "Stop",
				last_assistant_message: "hi",
				transcript_path: "/fake/transcript.jsonl",
			} as HookEventPayload,
			"codex_cli",
			ctx,
		);
		expect(result.events, JSON.stringify(result.events)).toEqual([]);

		const finalRows = await rowsFor(sid);
		const maxIdAfter = Math.max(...finalRows.map((r) => r.id));
		expect(maxIdAfter).toBe(maxIdBefore);
		expect(
			finalRows.filter((r) => r.category === "assistant_message"),
			await histogram(sid),
		).toHaveLength(1);
	});

	test("RP3b: the t-key variant — an unkeyed secondary is still compensated when the t-keyed primary conflicts", async () => {
		const { insertNormalizedEvents } = await import("./event-processor.js");
		const { createAssistantTranscriptEvent } = await import("./event-normalizer.js");
		const sid = newSessionId("rp3b");
		await mkSession(sid);

		await post(sid, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "T",
			last_assistant_message: "m",
		});
		const afterFirst = await rowsFor(sid);
		expect(afterFirst, await histogram(sid)).toHaveLength(2);

		await insertNormalizedEvents(sid, [
			createAssistantTranscriptEvent("m", { transcript_uuid: "tu-rp3b" }, "claude_transcript_text"),
		]);
		const transcriptRow = (await rowsFor(sid)).find((r) => r.source === "observed_transcript");
		await getDb()
			.update(events)
			.set({ createdAt: bareUtc(Date.now() - 3_600_000) })
			.where(eq(events.id, transcriptRow?.id ?? -1));

		const before = getEventsDeduplicatedCounts().toolUseRetry;
		await post(sid, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "T",
			last_assistant_message: "m",
		});

		const finalRows = await rowsFor(sid);
		expect(
			finalRows.filter((r) => r.eventType === "PostToolUse"),
			await histogram(sid),
		).toHaveLength(1);
		expect(
			finalRows.filter((r) => r.category === "assistant_message"),
			await histogram(sid),
		).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(2);
	});
});

// ── P6-l1 (moved from Phase 6) ───────────────────────────────────────────

test("P6-l1: an unstored row triggers no authority delete — a managed row survives a lost-race secondary", async () => {
	const sid = newSessionId("p6-l1");
	await mkSession(sid);
	const stored = await appendManagedSessionEvents(sid, [
		{
			eventType: "AssistantMessage",
			category: "assistant_message",
			source: "managed_control",
			content: "X",
		},
	]);
	expect(stored).toHaveLength(1);

	const ctx = ctxWith("delivery-p6l1-aaaa");
	// Must match exactly what post() will send: the same key set, in the
	// same insertion order (transcript_path is appended last for codex_cli).
	const bodyDigest = (await import("./util/hash.js")).sha256Hex(
		JSON.stringify({
			session_id: sid,
			cwd: "/w",
			hook_event_name: "Stop",
			last_assistant_message: "X",
			transcript_path: "/fake/transcript.jsonl",
		}),
	);
	const secondaryKey = computeDedupKey({
		kind: "d",
		keyId: ctx.keyId,
		deliveryId: ctx.deliveryId as string,
		bodyDigest,
		rowIndex: 1,
	});
	await getDb().insert(events).values({
		sessionId: sid,
		eventType: "AssistantMessage",
		category: "assistant_message",
		source: "observed_hook",
		content: "X",
		isNoise: false,
		providerEventType: "Stop",
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		dedupKey: secondaryKey,
	});

	await post(sid, { hook_event_name: "Stop", last_assistant_message: "X" }, "codex_cli", ctx);

	const rows = await rowsFor(sid);
	expect(
		rows.filter((r) => r.eventType === "Stop"),
		await histogram(sid),
	).toHaveLength(1);
	expect(
		rows.some((r) => r.source === "managed_control" && r.content === "X"),
		await histogram(sid),
	).toBe(true);
});
