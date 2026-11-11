/**
 * AGEN-146: secrets are masked on the way into storage, for every agent type, through the
 * real ingest path (detectAgentType -> canonicalizeHookPayload -> processHookEvent) with a
 * real DB. Each check reads the stored rows with a plain select(), asserts the secret is
 * absent from the whole row and that the marker is present. Secrets are built at run time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";
import { AGENT_TYPES } from "../../shared/constants.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { ingest, getInFlightCount } = await import("./ingest.js");
const { sessionsRouter } = await import("./sessions.js");
const { _resetBucketsForTest } = await import("../middleware/hook-rate-limit.js");
const { _resetCountersForTest } = await import("./ingest-counters.js");
const { _resetEventDedupForTest, getEventsDeduplicatedCounts } = await import(
	"../services/event-dedup.js"
);
const { processHookEvent } = await import("../services/event-processor.js");
const { getIngestRedactionCounters, __testing } = await import("../services/ingest-redaction.js");

const originalDisableAuth = config.disableAuth;
const AGENTS = join(import.meta.dir, "..", "services", "agents", "__fixtures__");

type Raw = Record<string, unknown>;

const KEY = `sk-ant-${"api03-"}${"A".repeat(40)}`;
const PROOF = "AAAAAAAAAAAAAAAA";
const MARKER = "[REDACTED:anthropic_api_key]";
const GH = `ghp_${"d".repeat(36)}`;

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
	await getDb().delete(sessions).execute();
});

async function quiesce() {
	for (let i = 0; i < 600 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	expect(getInFlightCount()).toBe(0);
}

let seq = 0;
async function post(
	body: Raw,
	agent: string,
	opts: { query?: string; headers?: Record<string, string> } = {},
) {
	const res = await app.request(`/api/v1/hooks${opts.query ?? ""}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Agent-Type": agent,
			"X-AgentPulse-Delivery-Id": `dlv-red-${++seq}-${crypto.randomUUID()}`,
			...opts.headers,
		},
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await quiesce();
}

const fixture = (agent: string, name: string): Raw =>
	JSON.parse(readFileSync(join(AGENTS, agent, `${name}.json`), "utf8"));

async function storedFor(sessionId: string) {
	const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return { rows: rows.sort((a, b) => a.id - b.id), session };
}

function expectMasked(value: unknown, marker = true) {
	const text = JSON.stringify(value);
	expect(text).not.toContain(PROOF);
	if (marker) expect(text).toContain(MARKER);
}

describe("every agent type is covered", () => {
	const COVERED = ["claude_code", "codex_cli", "copilot_cli", "opencode"];
	test("the covered list equals AGENT_TYPES (a new agent must add a case here)", () => {
		expect([...COVERED].sort()).toEqual([...AGENT_TYPES].sort());
	});
});

describe("claude_code", () => {
	test("a prompt and a Bash tool result carrying a key are masked everywhere they are stored", async () => {
		const sessionId = `claude-red-${Date.now()}`;
		await post(
			{
				session_id: sessionId,
				hook_event_name: "UserPromptSubmit",
				cwd: "/tmp/p",
				prompt: `use ${KEY} for it`,
			},
			"claude_code",
		);
		await post(
			{
				session_id: sessionId,
				hook_event_name: "PostToolUse",
				cwd: "/tmp/p",
				tool_name: "Bash",
				tool_use_id: "toolu_01RedA",
				tool_input: { command: `curl -H "x: ${KEY}" https://example.test` },
				tool_response: {
					stdout: `token ${KEY}\nTOKEN=${"q".repeat(12)}`,
					stderr: "",
					interrupted: false,
				},
			},
			"claude_code",
		);
		const { rows, session } = await storedFor(sessionId);
		expect(rows.map((r) => r.eventType)).toEqual(["UserPromptSubmit", "PostToolUse"]);
		for (const row of rows) expectMasked(row);
		expect(JSON.stringify(rows)).not.toContain("qqqqqqqq");
		expectMasked(session, false);
		const tool = rows[1];
		expect(tool?.toolName).toBe("Bash");
		expect((tool?.rawPayload as Raw).tool_use_id).toBe("toolu_01RedA");
		expect(getIngestRedactionCounters().hits).toBeGreaterThan(0);
	});

	test("a long tool response is cut for storage, and its true length and truncation are still reported", async () => {
		const sessionId = `claude-long-${Date.now()}`;
		const response = `${"line of output\n".repeat(2000)}token ${KEY}\n`;
		await post(
			{
				session_id: sessionId,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: "toolu_long",
				tool_input: { command: "run" },
				tool_response: response,
			},
			"claude_code",
		);
		const { rows } = await storedFor(sessionId);
		const raw = rows[0]?.rawPayload as Raw;
		expect(raw.tool_response_truncated).toBe(true);
		expect(raw.tool_response_chars).toBe(response.length);
		expect((raw.tool_response as string).length).toBe(4096);
		expectMasked(rows, false);
	});

	test("a model name and a git branch carrying a key are masked and cut", async () => {
		const sessionId = `claude-meta-${Date.now()}`;
		await post(
			{ session_id: sessionId, hook_event_name: "SessionStart", cwd: "/tmp/p", model: `m-${KEY}` },
			"claude_code",
		);
		await post(
			{
				session_id: sessionId,
				hook_event_name: "PostToolUse",
				cwd: "/tmp/p",
				tool_name: "Bash",
				tool_use_id: "toolu_branch",
				tool_input: { command: "git status" },
				tool_response: `On branch ${GH}\nnothing to commit`,
			},
			"claude_code",
		);
		const { session } = await storedFor(sessionId);
		expect(JSON.stringify(session)).not.toContain("dddddddd");
		expect(session?.model?.length ?? 0).toBeLessThanOrEqual(256);
		expect(session?.model).not.toContain(PROOF);
	});
});

describe("codex_cli", () => {
	test("the real fixtures with a key in the prompt and the command", async () => {
		const prompt = fixture("codex", "UserPromptSubmit");
		const tool = fixture("codex", "PostToolUse");
		const sessionId = prompt.session_id as string;
		await post({ ...prompt, prompt: `run with ${KEY}` }, "codex_cli", {
			headers: { "X-AgentPulse-Origin": "codex-observer" },
		});
		await post(
			{ ...tool, tool_input: { command: `echo ${KEY}` }, tool_response: `out ${KEY}\n` },
			"codex_cli",
			{ headers: { "X-AgentPulse-Origin": "codex-observer" } },
		);
		const { rows } = await storedFor(sessionId);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) expectMasked(row, false);
		expectMasked(rows, true);
		// The fixtures' real ids are plain, so they survive unchanged and keep their `t:` key.
		const toolRow = rows.find((r) => r.eventType === "PostToolUse");
		expect((toolRow?.rawPayload as Raw).tool_use_id).toBe(tool.tool_use_id as string);
		expect(toolRow?.dedupKey?.startsWith("t:")).toBe(true);
	});

	test("the legacy observer shape (no transcript path, native origin) is redacted once, not twice", async () => {
		const prompt = fixture("codex", "UserPromptSubmit");
		const { transcript_path: _t, ...legacy } = prompt;
		const sessionId = `${legacy.session_id as string}-legacy`;
		await post({ ...legacy, session_id: sessionId, prompt: `go ${KEY}` }, "codex_cli");
		const { rows } = await storedFor(sessionId);
		const content = rows.find((r) => r.eventType === "UserPromptSubmit")?.content ?? "";
		expect(content).toBe(`go ${MARKER}`);
		expect(content).not.toContain("[REDACTED:[REDACTED");
	});
});

describe("copilot_cli", () => {
	test("the fixtures' prompt and tool response", async () => {
		const prompt = fixture("copilot", "userPromptSubmitted");
		const tool = fixture("copilot", "postToolUse");
		const sessionId = prompt.sessionId as string;
		await post({ ...prompt, prompt: `deploy with ${KEY}` }, "copilot_cli", {
			query: "?event=userPromptSubmitted",
		});
		await post(
			{ ...tool, toolArgs: { command: `echo ${KEY}` }, toolResponse: `printed ${KEY}\n` },
			"copilot_cli",
			{ query: "?event=postToolUse" },
		);
		const { rows } = await storedFor(sessionId);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expectMasked(rows);
	});
});

describe("opencode", () => {
	test("a v2 shell tool envelope", async () => {
		const file = JSON.parse(
			readFileSync(join(AGENTS, "opencode", "envelopes", "v2", "shell-tool.json"), "utf8"),
		);
		const [before, after] = file.envelopes as Raw[];
		const sessionId = before?.session_id as string;
		const withSecret = (e: Raw, extra: Raw): Raw => ({
			...e,
			data: { ...(e.data as Raw), input: { command: `echo ${KEY}` }, ...extra },
		});
		await post(withSecret(before as Raw, {}), "opencode");
		await post(withSecret(after as Raw, { output: `ok ${KEY}` }), "opencode");
		const { rows } = await storedFor(sessionId);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expectMasked(rows);
		const toolRows = rows.filter((r) => r.category === "tool_event");
		for (const row of toolRows) {
			expect((row.rawPayload as Raw).tool_use_id).toBe("call_stub_ok_1");
		}
	});
});

describe("other writers on the hook route", () => {
	test("a synthetic acknowledgement keeps working and stores no secret from a hostile source", async () => {
		const sessionId = `ack-red-${Date.now()}`;
		await post(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			"claude_code",
		);
		await post(
			{
				session_id: sessionId,
				hook_event_name: "UserAcknowledge",
				source: KEY,
				acknowledged_at: "2026-01-01T00:00:00Z",
			},
			"claude_code",
		);
		const { rows, session } = await storedFor(sessionId);
		expect(rows.some((r) => r.eventType === "UserAcknowledge")).toBe(true);
		expect(session?.lastUserAcknowledgedAt).toBeTruthy();
		expectMasked(rows, false);
	});

	test("/hooks/status: the task and the plan are masked on the session and in the timeline", async () => {
		const sessionId = `status-red-${Date.now()}`;
		await post(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			"claude_code",
		);
		const res = await app.request("/api/v1/hooks/status", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session_id: sessionId,
				status: "implementing",
				task: `fix ${KEY}`,
				plan: [`step ${KEY}`, "step two"],
			}),
		});
		expect(res.status).toBe(200);
		await quiesce();
		const { rows, session } = await storedFor(sessionId);
		expect(session?.currentTask).toContain(MARKER);
		expectMasked(session);
		expectMasked(rows);
	});

	test("native-name: a key in the reported name is masked", async () => {
		const sessionId = `name-red-${Date.now()}`;
		await post(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			"claude_code",
		);
		const res = await app.request(`/api/v1/sessions/${sessionId}/native-name`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: `work ${KEY}` }),
		});
		expect([200, 204]).toContain(res.status);
		const { session } = await storedFor(sessionId);
		expect(session?.displayName).toContain(MARKER);
		expectMasked(session);
	});

	test("an oversize stub with a token-shaped tool_use_id stores neither the id nor a key", async () => {
		const sessionId = `stub-red-${Date.now()}`;
		await processHookEvent(
			{
				session_id: sessionId,
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_use_id: GH,
			} as never,
			"claude_code",
			{ keyId: "anonymous", deliveryId: "dlv-stub-1", origin: "native", oversizeStub: true },
		);
		const { rows } = await storedFor(sessionId);
		expect(JSON.stringify(rows)).not.toContain("dddddddd");
		expect(rows[0]?.content).toContain("exceeded");
	});

	test("a session id that is itself a key refuses the delivery: 200 and nothing stored", async () => {
		const res = await app.request("/api/v1/hooks", {
			method: "POST",
			headers: { "content-type": "application/json", "X-Agent-Type": "claude_code" },
			body: JSON.stringify({ session_id: GH, hook_event_name: "UserPromptSubmit", prompt: "hi" }),
		});
		expect(res.status).toBe(200);
		await quiesce();
		expect(await getDb().select().from(events)).toEqual([]);
		expect(await getDb().select().from(sessions)).toEqual([]);
		expect(getIngestRedactionCounters().sessionIdRefused).toBe(1);
	});

	test("every fixture's own ids pass the id grammar unchanged", async () => {
		for (const agent of ["codex", "copilot"]) {
			for (const name of readdirSync(join(AGENTS, agent))) {
				const body = JSON.parse(readFileSync(join(AGENTS, agent, name), "utf8")) as Raw;
				for (const key of ["session_id", "sessionId", "turn_id", "tool_use_id"]) {
					const value = body[key];
					if (typeof value === "string") expect(value).toMatch(/^[A-Za-z0-9_.:#-]{1,200}$/);
				}
			}
		}
	});
});

describe("dedup still works on redacted rows", () => {
	test("a t: retry of the same tool call stores one row, keyed by the original id", async () => {
		const sessionId = `dedup-red-${Date.now()}`;
		const body = {
			session_id: sessionId,
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "toolu_dedup",
			tool_input: { command: `echo ${KEY}` },
			tool_response: `x ${KEY}`,
		};
		await post(body, "claude_code");
		await post(body, "claude_code");
		const { rows } = await storedFor(sessionId);
		expect(rows.filter((r) => r.eventType === "PostToolUse")).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry).toBe(1);
		expectMasked(rows);
	});
});
