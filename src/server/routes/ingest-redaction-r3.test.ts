/** AGEN-146 confirm round: cut-before-redact, bounded ids, the gate, per-owner admission. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { ingest, getInFlightCount } = await import("./ingest.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest } = await import("./ingest-counters.js");
const { _resetEventDedupForTest } = await import("../services/event-dedup.js");
const ir = await import("../services/ingest-redaction.js");
const { needsHuman } = await import("../services/ai/human-gate.js");
const { evaluateRisk } = await import("../services/ai/risk-classes.js");

const originalDisableAuth = config.disableAuth;
const GH = `ghp_${"d".repeat(36)}`;
const RM = {
	version: 1,
	classes: [
		{
			id: "destructive",
			label: "rm -rf",
			match: { type: "regex" as const, pattern: "rm -rf" },
			policyOverride: "ask" as const,
		},
	],
};
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
	ir.__testing.reset();
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});
afterEach(() => ir.__testing.setCaps());

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

describe("1 and 2: redact first, then cut", () => {
	test("a reported host with a token that the 128-character cap would split is masked", async () => {
		const id = `rh-${Date.now()}`;
		await post(
			{ session_id: id, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			{ "X-AgentPulse-Host": encodeURIComponent(`${"h".repeat(100)} ${GH}`) },
		);
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
		expect(row?.reportedHost).not.toContain("ghp_");
		expect(row?.reportedHost).toContain("[REDACTED");
	});

	test("a cut that leaves an unrecognised token fragment loses the fragment", () => {
		const text = `${"a".repeat(100)} ghp_${"d".repeat(30)} tail`;
		const out = ir.redactShortForStorage(text, 128);
		expect(out).not.toContain("dddddddd");
		expect(out).toContain("[REDACTED:cut_token]");
		expect(ir.redactShortForStorage("short ghp_abc", 128)).toBe("short ghp_abc");
	});

	test("the invalid-hook log redacts before it cuts", async () => {
		const lines: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			await post({ session_id: `${"s".repeat(50)}:${GH}` });
		} finally {
			console.warn = original;
		}
		const logged = lines.join("\n");
		expect(logged).toContain("ingest_missing_fields");
		expect(logged).not.toContain("ghp_");
	});
});

describe("3: ids are bounded before any rule runs", () => {
	test("a huge or oddly shaped session id is refused without being scanned", async () => {
		const started = performance.now();
		expect(ir.refuseSessionIdForStorage("x".repeat(5_000_000))).toBe(true);
		expect(performance.now() - started).toBeLessThan(50);
		expect(ir.refuseSessionIdForStorage("has space")).toBe(true);
		expect(ir.refuseSessionIdForStorage("ok-id_1.2:3")).toBe(false);
		await post({ session_id: "has space", hook_event_name: "UserPromptSubmit", prompt: "hi" });
		expect(await getDb().select().from(sessions)).toEqual([]);
	});
});

describe("4: a plain mask does not fool the gate", () => {
	test("`export TOKEN=abcd;rm -rf ~` keeps its command, holds the gate and matches the risk class", async () => {
		const id = `gate-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "Stop",
			last_assistant_message: "export TOKEN=abcd;rm -rf ~",
		});
		const rows = (await rowsOf(id)).filter((r) => r.category === "assistant_message");
		expect(rows[0]?.content).toContain("rm -rf ~");
		expect(rows[0]?.content).toContain("[REDACTED]");
		expect(needsHuman(rows as never, { version: 1, classes: [] }).hold).toBe(true);
		expect(evaluateRisk(RM, { proposedPrompt: rows[0]?.content ?? "" }).length).toBeGreaterThan(0);
	});

	test("a pending call whose command was masked holds the gate", async () => {
		const id = `gate2-${Date.now()}`;
		await post({
			session_id: id,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_use_id: "toolu_g2",
			tool_input: { command: "curl -u bob:hunter2pass https://example.test" },
		});
		const rows = await rowsOf(id);
		expect(needsHuman(rows as never, { version: 1, classes: [] }).hold).toBe(true);
	});
});

describe("5: admission is charged per owner", () => {
	test("keys of one owner share a share; ownerless keys and other owners do not", async () => {
		expect(ir.senderOfPoster({ keyId: "k1", attribution: { ownerUserId: "u" } })).toBe(
			ir.senderOfPoster({ keyId: "k2", attribution: { ownerUserId: "u" } }),
		);
		expect(ir.senderOfPoster({ keyId: "k1" })).not.toBe(ir.senderOfPoster({ keyId: "k2" }));
		ir.__testing.setCaps(1_500_000, 10_000_000);
		const big = "w ".repeat(500_000);
		const prep = (keyId: string, owner: string | null) =>
			ir.prepareHookPayloadForStorage(
				{ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: big } as never,
				{ keyId, attribution: { ownerUserId: owner } },
			);
		const sameOwner = [prep("k1", "u"), prep("k2", "u")];
		expect(ir.__testing.pending().waiters).toBe(1);
		await Promise.all(sameOwner);
		const otherOwners = [prep("k1", "u1"), prep("k2", "u2")];
		expect(ir.__testing.pending().waiters).toBe(0);
		await Promise.all(otherOwners);
	}, 60_000);
});
