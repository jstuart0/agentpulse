/**
 * AGEN-146 reader matrix: the readers of stored event text still work on redacted rows. Each case
 * stores through the real ingest path and reads back with a plain select().
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { ingest, getInFlightCount } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest } = await import("./ingest-counters.js");
const { _resetEventDedupForTest, getEventsDeduplicatedCounts } = await import(
	"../services/event-dedup.js"
);
const { insertManagedEvents, insertNormalizedEvents } = await import(
	"../services/event-processor.js"
);
const { createAssistantTranscriptEvent } = await import("../services/event-normalizer.js");
const { computeTurnKey } = await import("../services/ai/turn-identity.js");
const { compactRawPayload } = await import("../services/event-compact.js");
const { getIngestRedactionCounters, redactEventsForStorage } = await import(
	"../services/ingest-redaction.js"
);

const originalDisableAuth = config.disableAuth;
const KEY = `sk-ant-${"api03-"}${"A".repeat(40)}`;
const PROOF = "AAAAAAAAAAAAAAAA";
const app = new Hono().route("/api/v1", ingest);

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
beforeEach(async () => {
	_resetBucketsForTest();
	_resetCountersForTest();
	_resetEventDedupForTest();
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function quiesce() {
	for (let i = 0; i < 600 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	expect(getInFlightCount()).toBe(0);
}

async function post(body: Record<string, unknown>, agent: string, deliveryId?: string) {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"X-Agent-Type": agent,
	};
	if (deliveryId) headers["X-AgentPulse-Delivery-Id"] = deliveryId;
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await quiesce();
}

const rowsOf = (sessionId: string) =>
	getDb().select().from(events).where(eq(events.sessionId, sessionId));

describe("dedup", () => {
	test("a d: retry of a secret-bearing prompt stores one row, and the key is over the body as sent", async () => {
		const sessionId = `d-retry-${Date.now()}`;
		const body = {
			session_id: sessionId,
			hook_event_name: "UserPromptSubmit",
			prompt: `go ${KEY}`,
		};
		await post(body, "claude_code", "dlv-d-retry-1");
		await post(body, "claude_code", "dlv-d-retry-1");
		const rows = await rowsOf(sessionId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dedupKey?.startsWith("d:")).toBe(true);
		expect(JSON.stringify(rows)).not.toContain(PROOF);
		expect(getEventsDeduplicatedCounts().deliveryRetry).toBe(1);
	});

	test("the content window still drops a repeat of redacted text from a source with no delivery id", async () => {
		const sessionId = `window-${Date.now()}`;
		await post(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			"claude_code",
		);
		const make = () => [createAssistantTranscriptEvent(`answer ${KEY}`, {}, "assistant")];
		await insertNormalizedEvents(sessionId, make());
		await insertNormalizedEvents(sessionId, make());
		const rows = (await rowsOf(sessionId)).filter((r) => r.category === "assistant_message");
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain(PROOF);
	});

	test("hook-vs-transcript authority still collapses the same secret-bearing message to one row", async () => {
		const sessionId = `authority-${Date.now()}`;
		const text = `Done. Used ${KEY} to deploy.`;
		await post(
			{ session_id: sessionId, hook_event_name: "Stop", last_assistant_message: text },
			"claude_code",
		);
		await insertNormalizedEvents(sessionId, [
			createAssistantTranscriptEvent(text, {}, "assistant"),
		]);
		const rows = (await rowsOf(sessionId)).filter((r) => r.category === "assistant_message");
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain(PROOF);
	});

	test("a managed delivery replay stores nothing and scans nothing", async () => {
		const sessionId = `managed-replay-${Date.now()}`;
		await post(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			"claude_code",
		);
		const delivery = { senderId: "sup-1", deliveryId: "dlv-managed-1", bodyDigest: "digest-1" };
		const batch = () => [
			{
				eventType: "ManagedAgentMessage",
				category: "assistant_message" as const,
				source: "managed_control" as const,
				content: `reply ${"padding ".repeat(400)}${KEY}`,
				isNoise: false,
				providerEventType: null,
				toolName: null,
				toolInput: null,
				toolResponse: null,
				rawPayload: {},
			},
		];
		const first = await insertManagedEvents(sessionId, batch(), delivery);
		expect(first.replay).toBe(false);
		expect(first.events).toHaveLength(1);
		const scannedAfterFirst = getIngestRedactionCounters().unitsScanned;
		const second = await insertManagedEvents(sessionId, batch(), delivery);
		expect(second).toEqual({ events: [], replay: true });
		expect(getIngestRedactionCounters().unitsScanned).toBe(scannedAfterFirst);
		expect(JSON.stringify(await rowsOf(sessionId))).not.toContain(PROOF);
	});
});

describe("turn identity and tool pairing", () => {
	test("a Codex turn keeps its turn_id, so the turn key is still t:<id>", async () => {
		const sessionId = `turn-${Date.now()}`;
		const turnId = "01a0e994-8a45-7541-883a-684b4a5c8a15";
		await post(
			{
				session_id: sessionId,
				turn_id: turnId,
				hook_event_name: "UserPromptSubmit",
				prompt: `p ${KEY}`,
			},
			"codex_cli",
		);
		await post(
			{
				session_id: sessionId,
				turn_id: turnId,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "exec-1",
				tool_input: { command: "ls" },
				tool_response: "ok",
			},
			"codex_cli",
		);
		const rows = (await rowsOf(sessionId)).sort((a, b) => a.id - b.id);
		const [session] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, sessionId));
		for (const row of rows) {
			expect(
				await computeTurnKey(getDb(), { sessionId, agentType: session?.agentType ?? "" }, row),
			).toBe(`t:${turnId}`);
		}
	});

	test("Pre and Post of one call keep the same tool_use_id", async () => {
		const sessionId = `pair-${Date.now()}`;
		const call = {
			session_id: sessionId,
			tool_name: "Bash",
			tool_use_id: "toolu_pair_1",
			tool_input: { command: `echo ${KEY}` },
		};
		await post({ ...call, hook_event_name: "PreToolUse" }, "claude_code");
		await post({ ...call, hook_event_name: "PostToolUse", tool_response: "x" }, "claude_code");
		const ids = (await rowsOf(sessionId)).map(
			(r) => (r.rawPayload as Record<string, unknown>).tool_use_id,
		);
		expect(ids).toEqual(["toolu_pair_1", "toolu_pair_1"]);
	});
});

describe("compact event form", () => {
	test("exit_code is still read from a redacted JSON response, and tool_use_id is kept", async () => {
		const sessionId = `compact-${Date.now()}`;
		await post(
			{
				session_id: sessionId,
				hook_event_name: "PostToolUseFailure",
				tool_name: "Bash",
				tool_use_id: "toolu_compact",
				tool_input: { command: "false" },
				tool_response: { exit_code: 2, stdout: `leaked ${KEY}` },
			},
			"claude_code",
		);
		const [row] = await rowsOf(sessionId);
		const compact = compactRawPayload(row?.rawPayload);
		expect(compact?.tool_use_id).toBe("toolu_compact");
		expect(compact?.exit_code).toBe(2);
		expect(JSON.stringify(row)).not.toContain(PROOF);
	});
});

describe("a continued Claude session's call rows", () => {
	test("pass through the redaction step byte for byte", async () => {
		const call = {
			eventType: "HeadlessStatus",
			category: "progress_update" as const,
			source: "managed_control" as const,
			content: "Bash: ran without asking",
			isNoise: false,
			providerEventType: "HeadlessStatus",
			toolName: null,
			toolInput: null,
			toolResponse: null,
			rawPayload: {
				source: "claude_stream",
				kind: "call",
				tool: "Bash",
				toolOutcome: "unasked",
				is_error: false,
				tool_use_id: "toolu_01abcDEF-ghi_2",
				claudeStreamRuntime: true,
			},
		};
		const [out] = await redactEventsForStorage("s:sup", [call]);
		expect(out).toEqual(call);
		// The web's Details lookup finds the same call by the id the row still carries.
		const { callRowToolUseId } = await import(
			"../../web/components/session-detail/fork-detail-availability.js"
		);
		expect(
			callRowToolUseId({
				eventType: "HeadlessStatus",
				createdAt: "2026-01-01T00:00:00Z",
				rawPayload: out?.rawPayload,
			}),
		).toBe("toolu_01abcDEF-ghi_2");
		expect(JSON.stringify(out)).toBe(JSON.stringify(call));
	});
});
