/**
 * AGEN-146 fix pass: each case goes through the real ingest, tracker or managed path and reads the
 * stored rows back. Secrets are built at run time.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, managedSessions, sessions } = await import("../db/schema/index.js");
const { ingest, getInFlightCount } = await import("./ingest.js");
const { sessionsRouter } = await import("./sessions.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest } = await import("./ingest-counters.js");
const { _resetEventDedupForTest } = await import("../services/event-dedup.js");
const { __testing, redactEventsForStorage, redactTextForStorage } = await import(
	"../services/ingest-redaction.js"
);
const { appendManagedSessionEvents, upsertManagedSessionState } = await import(
	"../services/managed-session-state.js"
);
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { needsHuman, WITHHELD_WHY } = await import("../services/ai/human-gate.js");
const { evaluateRisk } = await import("../services/ai/risk-classes.js");

const originalDisableAuth = config.disableAuth;
const KEY = `sk-ant-${"api03-"}${"A".repeat(40)}`;
const GH = `ghp_${"d".repeat(36)}`;
const NO_RISK = { version: 1, classes: [] };
const app = new Hono().route("/api/v1", ingest).route("/api/v1", sessionsRouter);

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
	__testing.reset();
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(sessions).execute();
});
afterEach(() => __testing.setCaps());

async function quiesce() {
	for (let i = 0; i < 600 && getInFlightCount() > 0; i++)
		await new Promise((r) => setTimeout(r, 5));
	expect(getInFlightCount()).toBe(0);
}
async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json", "X-Agent-Type": "claude_code", ...headers },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await quiesce();
}
const rowsOf = (id: string) => getDb().select().from(events).where(eq(events.sessionId, id));
const sessionOf = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];
const filler = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);

describe("1: a long token across the head/tail seam", () => {
	// The scanned tail begins 520,448 characters before the end; the kept part 20,480 characters later.
	// The gap puts the kept start inside the run, so the part of the run in view has no `sk-ant-` left.
	for (const [run, gap] of [
		[50 * 1024, 480_000],
		[50 * 1024, 470_000],
		[1024 * 1024, 100_000],
		[1024 * 1024, 400_000],
	] as const) {
		test(`a ${run}-character sk-ant run with ${gap} characters after it is gone`, async () => {
			const token = `sk-ant-${"A".repeat(run)}`;
			const text = `${filler(600_000)}\n${token}\n${filler(gap)}`;
			const out = await redactTextForStorage(text, "t");
			expect(out).not.toContain("AAAAAAAA");
		}, 120_000);
	}
});

describe("2: managed event labels", () => {
	test("eventType, category and source carrying a key are not stored", async () => {
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "lbl-1",
				displayName: "lbl-1",
				agentType: "codex_cli",
				status: "active",
				lastActivityAt: new Date().toISOString(),
				metadata: {},
			})
			.execute();
		await seedOwnedLaunch("lbl-1", "sup-1");
		await appendManagedSessionEvents("sup-1", "lbl-1", [
			{
				eventType: `Evt:${KEY}`,
				category: `cat:${KEY}` as never,
				source: `src:${KEY}` as never,
				content: "x",
			},
		]);
		const rows = await rowsOf("lbl-1");
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain("AAAAAAAA");
		expect(rows[0]?.category).toBe("system_event");
	});
});

describe("3: native names are redacted before the cap", () => {
	test("a ghp_ token at offset 161 is masked, not cut to a leaking remnant", async () => {
		const id = `name-${Date.now()}`;
		await post({ session_id: id, hook_event_name: "UserPromptSubmit", prompt: "hi" });
		const name = `${"n".repeat(160)} ${GH} tail`;
		const res = await app.request(`/api/v1/sessions/${id}/native-name`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name }),
		});
		expect([200, 204]).toContain(res.status);
		const row = await sessionOf(id);
		expect(row?.displayName).not.toContain("dddd");
		expect(row?.displayName).toContain("[REDACTED:github_token]");
	});

	test("a sync rename with no source is masked; an explicit user rename is the person's own", async () => {
		const id = `rename-${Date.now()}`;
		await post({ session_id: id, hook_event_name: "UserPromptSubmit", prompt: "hi" });
		const rename = (body: Record<string, unknown>) =>
			app.request(`/api/v1/sessions/${id}/rename`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		await rename({ name: `agent ${GH}` });
		expect((await sessionOf(id))?.displayName).not.toContain("dddd");
		await rename({ name: "my own words", source: "user" });
		expect((await sessionOf(id))?.displayName).toBe("my own words");
	});
});

describe("4 and 5: other stored fields", () => {
	test("providerSyncError, a reported host and plan items are masked or dropped", async () => {
		await seedOwnedLaunch("fld-1", "sup-1");
		await upsertManagedSessionState("sup-1", {
			sessionId: "fld-1",
			providerSyncState: "failed",
			providerSyncError: `failed at ${KEY}`,
		});
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "fld-1"));
		expect(managed?.providerSyncError).not.toContain("AAAAAAAA");

		const id = `fld-2-${Date.now()}`;
		await post(
			{ session_id: id, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			{ "X-AgentPulse-Host": encodeURIComponent(`host-${GH}`) },
		);
		expect(JSON.stringify(await sessionOf(id))).not.toContain("dddd");

		const res = await app.request("/api/v1/hooks/status", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: id,
				status: "bogus status",
				plan: [`a ${KEY}`, 5, { x: KEY }],
			}),
		});
		expect(res.status).toBe(200);
		await quiesce();
		const row = await sessionOf(id);
		expect(JSON.stringify(row)).not.toContain("AAAAAAAA");
		expect(row?.planSummary).toEqual([expect.stringContaining("[REDACTED:anthropic_api_key]")]);
		expect(row?.semanticStatus).not.toBe("bogus status");
	});
});

describe("6: logging", () => {
	test("the invalid-hook log carries no secret session id or event name", async () => {
		const lines: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			await post({ session_id: `x:${GH}` });
		} finally {
			console.warn = original;
		}
		expect(lines.join("\n")).toContain("ingest_missing_fields");
		expect(lines.join("\n")).not.toContain("dddd");
	});
});

describe("7: admission fairness", () => {
	test("a sender's second large event does not hold another sender's small one behind it", async () => {
		__testing.setCaps(1_500_000, 10_000_000);
		const big = () => [
			{
				eventType: "ManagedAgentMessage",
				category: "assistant_message" as const,
				source: "managed_control" as const,
				content: filler(1_000_000),
				isNoise: false,
				providerEventType: null,
				toolName: null,
				toolInput: null,
				toolResponse: null,
				rawPayload: {},
			},
		];
		const small = [{ ...big()[0], content: "hello" }] as ReturnType<typeof big>;
		const order: string[] = [];
		const a1 = redactEventsForStorage("s:a", big()).then(() => order.push("a1"));
		const a2 = redactEventsForStorage("s:a", big()).then((out) => {
			order.push("a2");
			expect(out[0]?.content).not.toBe("[REDACTED:redaction_backlog]");
		});
		const b = redactEventsForStorage("s:b", small).then((out) => {
			order.push("b");
			expect(out[0]?.content).toBe("hello");
		});
		await Promise.all([a1, a2, b]);
		expect(order[0]).toBe("b");
		expect(__testing.pending().units).toBe(0);
		expect(__testing.pending().waiters).toBe(0);
	}, 60_000);
});

describe("8: a tool_response on an event that carries none is counted", () => {
	test("it is stored as a marker when it does not fit", async () => {
		__testing.setCaps(2_000, 10_000_000);
		const id = `tr-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			tool_response: `${filler(6000)}${GH}`,
		});
		const rows = await rowsOf(id);
		expect(JSON.stringify(rows)).not.toContain("dddd");
		expect(rows[0]?.toolResponse).toBe("[REDACTED:redaction_backlog]");
	});
});

describe("9: a backlogged call is withheld, not harmless", () => {
	test("a PreToolUse stored as a marker holds the human gate and fails the risk check", async () => {
		__testing.setCaps(200, 10_000_000);
		const id = `pre-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: "toolu_pre",
			tool_input: { command: `rm -rf ${filler(2000)}` },
		});
		const [row] = await rowsOf(id);
		expect(row?.toolInput).toEqual({ _withheld: "[REDACTED:redaction_backlog]" });
		const turn = [row as never];
		expect(needsHuman(turn, NO_RISK)).toMatchObject({ hold: true, why: WITHHELD_WHY });
		const hits = evaluateRisk(NO_RISK, { proposedPrompt: JSON.stringify(row?.toolInput) });
		expect(hits.length).toBeGreaterThan(0);
	});
});

describe("10: redaction does not hide what a reader needs", () => {
	test("a cookie or digest line that swallows a command is withheld text", async () => {
		for (const line of ["Cookie: a=b; rm -rf ~", "Authorization: Digest x=abcdefghij; rm -rf ~"]) {
			const id = `swallow-${Math.random()}`;
			await post({
				session_id: id,
				hook_event_name: "Stop",
				last_assistant_message: `Next: ${"\n"}${line}`,
			});
			const rows = (await rowsOf(id)).filter((r) => r.category === "assistant_message");
			expect(JSON.stringify(rows)).not.toContain("rm -rf");
			expect(needsHuman(rows as never, NO_RISK).hold, line).toBe(true);
		}
	});

	test("a question mark after a secret value is kept, so the gate still sees a question", async () => {
		const id = `q-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "Stop",
			last_assistant_message: "Should I use TOKEN=abcdef123?",
		});
		const rows = (await rowsOf(id)).filter((r) => r.category === "assistant_message");
		expect(rows[0]?.content?.endsWith("?")).toBe(true);
		expect(rows[0]?.content).toContain("[REDACTED]");
		expect(needsHuman(rows as never, NO_RISK).hold).toBe(true);
	});
});

describe("13: keys, nesting and argv", () => {
	test("object keys are charged and distinct keys capped", async () => {
		__testing.setCaps(1_000, 10_000_000);
		const keys = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [`k${i}${"x".repeat(20)}`, 1]),
		);
		const id = `keys-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: keys,
		});
		const [row] = await rowsOf(id);
		expect(row?.toolInput).toEqual({ _withheld: "[REDACTED:redaction_backlog]" });
	});

	test("distinct keys past the cap become a marker", async () => {
		const { prepareHookPayloadForStorage } = await import("../services/ingest-redaction.js");
		const keys = Object.fromEntries(Array.from({ length: 10_050 }, (_, i) => [`k${i}`, 1]));
		const out = await prepareHookPayloadForStorage(
			{ session_id: "s", hook_event_name: "PreToolUse", tool_input: keys } as never,
			{ keyId: "k" },
		);
		if ("refused" in out) throw new Error("refused");
		const kept = Object.keys(out.payload.tool_input as Record<string, unknown>);
		expect(kept).toContain("[REDACTED:key]");
		expect(kept.length).toBeLessThanOrEqual(10_001);
	});

	test("strings under a nested object of a secret key, and argv arrays, are masked", async () => {
		const id = `nest-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: {
				credentials: { user: "alicealice", inner: { pass: "hunter22x" } },
				argv: ["curl", "--token", "abcdefgh", "https://example.test"],
			},
		});
		const text = JSON.stringify(await rowsOf(id));
		expect(text).not.toContain("alicealice");
		expect(text).not.toContain("hunter22x");
		expect(text).not.toContain("abcdefgh");
		expect(text).toContain("https://example.test");
	});
});
