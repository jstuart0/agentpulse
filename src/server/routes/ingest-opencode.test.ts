/**
 * AGEN-141 phase 1: OpenCode envelopes through the real ingest path
 * (detectAgentType -> canonicalizeHookPayload -> event-processor) with a real
 * DB. The envelopes are the hand-written fixtures the phase 2 plugins must
 * produce, so this is also the contract test for what a plugin may post.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

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
const { mapSessionDto } = await import("../services/session-dto.js");

const originalDisableAuth = config.disableAuth;
const FIXTURES = join(import.meta.dir, "..", "services", "agents", "__fixtures__", "opencode");

type Raw = Record<string, unknown>;

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
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function quiesce() {
	for (let i = 0; i < 400 && getInFlightCount() > 0; i++) {
		await new Promise((r) => setTimeout(r, 5));
	}
	expect(getInFlightCount()).toBe(0);
}

let deliverySeq = 0;
/** Posts one envelope the way the plugin does: a distinct delivery id per event. */
async function post(envelope: Raw, opts: { deliveryId?: string } = {}): Promise<void> {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Agent-Type": "opencode",
			"X-AgentPulse-Delivery-Id":
				opts.deliveryId ?? `dlv-oc-${++deliverySeq}-${crypto.randomUUID()}`,
		},
		body: JSON.stringify(envelope),
	});
	expect(res.status).toBe(200);
	await quiesce();
}

function scenario(line: "v1" | "v2", name: string): Raw[] {
	const file = JSON.parse(readFileSync(join(FIXTURES, "envelopes", line, `${name}.json`), "utf8"));
	return file.envelopes as Raw[];
}

async function postScenario(line: "v1" | "v2", name: string): Promise<void> {
	for (const e of scenario(line, name)) await post(e);
}

async function rowsOf(sessionId: string) {
	const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
	return rows.sort((a, b) => a.id - b.id);
}

async function sessionOf(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

/** The permission waits still open on a session (the turn ending also reads WAITING, so state alone can't tell). */
async function outstandingWaits(sessionId: string): Promise<string[]> {
	const row = await sessionOf(sessionId);
	const wait = (row.metadata as { permissionWait?: { ids?: string[]; anon?: number } } | null)
		?.permissionWait;
	return [...(wait?.ids ?? []), ...Array.from({ length: wait?.anon ?? 0 }, () => "anon")];
}

async function operationalOf(sessionId: string) {
	const row = await sessionOf(sessionId);
	return mapSessionDto(row as never).operationalStatus;
}

const envelope = (
	line: 1 | 2,
	sessionId: string,
	name: string,
	data: Raw,
	extra: Raw = {},
): Raw => ({
	session_id: sessionId,
	hook_event_name: name,
	opencode: { line, protocol: 1 },
	cwd: "/scratch/proj/x",
	data,
	...extra,
});

describe("a turn on each line", () => {
	for (const [line, sid, tail] of [
		["v1", "ses_e409b54daffeeg8BXRz7WOao2x", "tool.execute"],
		["v2", "ses_e409ad1f6ffegI64qT1DgzijzJ", "tool."],
	] as const) {
		test(`${line}/shell-tool is stored as an opencode session, in order, and a Stop ends the turn`, async () => {
			await postScenario(line, "shell-tool");
			const session = await sessionOf(sid);
			expect(session.agentType).toBe("opencode");
			expect(session.cwd).toBe(`/scratch/proj/${line}-shell-tool`);
			const rows = await rowsOf(sid);
			const types = rows.map((r) => r.eventType);
			for (const t of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
				// v2's fixture starts at the tool call: it has no SessionStart or prompt of its own.
				if (line === "v2" && (t === "SessionStart" || t === "UserPromptSubmit" || t === "Stop")) {
					continue;
				}
				expect(types, `${line} ${t}`).toContain(t);
			}
			expect(rows.find((r) => r.eventType === "PreToolUse")?.providerEventType).toContain(tail);
			if (line === "v1") expect(session.isWorking).toBe(false);
		});
	}

	test("a prompt starts the turn and a Stop ends it (v2 plain)", async () => {
		await postScenario("v2", "plain");
		const sid = "ses_e409ae358ffeA525XpuAwGG4NA";
		const session = await sessionOf(sid);
		expect(session.isWorking).toBe(false);
		expect(session.lastAgentTurnCompletedAt).not.toBeNull();
		const prompt = (await rowsOf(sid)).find((r) => r.eventType === "UserPromptSubmit");
		expect(prompt?.content).toBe("PLAIN hello");
	});

	test("the working flag is set between the prompt and the Stop", async () => {
		const [created, prompt, stop] = scenario("v1", "plain") as [Raw, Raw, Raw];
		const sid = "ses_e409b5f45ffe8k06g2lzPXO9ZQ";
		await post(created);
		await post(prompt);
		expect((await sessionOf(sid)).isWorking).toBe(true);
		expect(await operationalOf(sid)).toBe("working");
		await post(stop);
		expect((await sessionOf(sid)).isWorking).toBe(false);
	});
});

describe("tool rows: Pre and Post are separate, each retry-safe on its own key", () => {
	test("Pre and Post posted twice each yield 2 rows and toolUseRetry +2", async () => {
		const [pre, post_] = scenario("v1", "shell-tool").slice(2, 4) as [Raw, Raw];
		const sid = "ses_e409b54daffeeg8BXRz7WOao2x";
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		await post(pre);
		await post(post_);
		await post(pre);
		await post(post_);
		const toolRows = (await rowsOf(sid)).filter(
			(r) => r.eventType === "PreToolUse" || r.eventType === "PostToolUse",
		);
		expect(toolRows.map((r) => r.eventType).sort()).toEqual(["PostToolUse", "PreToolUse"]);
		expect(new Set(toolRows.map((r) => r.dedupKey)).size).toBe(2);
		for (const r of toolRows) expect(r.dedupKey).toMatch(/^t:[0-9a-f]{32}$/);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(2);
	});

	test("a reused callID (call_0, then call_0#2) stores both pairs", async () => {
		await postScenario("v1", "callid-reuse");
		const rows = (await rowsOf("ses_reuse0000000000000000000001")).filter(
			(r) => r.eventType === "PreToolUse" || r.eventType === "PostToolUse",
		);
		expect(rows.map((r) => r.eventType)).toEqual([
			"PreToolUse",
			"PostToolUse",
			"PreToolUse",
			"PostToolUse",
		]);
		expect(new Set(rows.map((r) => r.dedupKey)).size).toBe(4);
	});

	test("the same callID posted again without the suffix is a retry, not a new call", async () => {
		const [pre] = scenario("v1", "callid-reuse") as [Raw];
		const before = getEventsDeduplicatedCounts().toolUseRetry;
		await post(pre);
		await post(pre);
		const rows = (await rowsOf("ses_reuse0000000000000000000001")).filter(
			(r) => r.eventType === "PreToolUse",
		);
		expect(rows).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().toolUseRetry - before).toBe(1);
	});

	test("a tool_use_id of approval:x is dropped by the existing rule", async () => {
		const sid = "ses_approvalx0000000000000000001";
		await post(envelope(1, sid, "session.created", {}));
		await post(
			envelope(1, sid, "tool.execute.before", {
				tool: "bash",
				tool_use_id: "approval:x",
				input: { command: "ls" },
			}),
		);
		const types = (await rowsOf(sid)).map((r) => r.eventType);
		expect(types).toEqual(["SessionStart"]);
	});

	test("a failed tool is stored as PostToolUseFailure", async () => {
		await postScenario("v1", "failed-tool-exit");
		const rows = await rowsOf("ses_e409b3f15ffe7Gm45xcOJhC5w2");
		expect(rows.map((r) => r.eventType)).toEqual(["PreToolUse", "PostToolUseFailure"]);
	});
});

describe("repeated turn ends and prompts across turns (G7 path)", () => {
	const sid = "ses_twoturns0000000000000000001";
	const prompt = () => envelope(1, sid, "chat.message", { text: "do the thing" });
	const stop = () => envelope(1, sid, "session.idle", {});

	test("two identical turns both store, each delivery under its own id", async () => {
		await post(envelope(1, sid, "session.created", {}));
		await post(prompt());
		await post(stop());
		await post(prompt());
		await post(stop());
		const types = (await rowsOf(sid)).map((r) => r.eventType);
		expect(types.filter((t) => t === "UserPromptSubmit")).toHaveLength(2);
		expect(types.filter((t) => t === "Stop")).toHaveLength(2);
	});

	test("the same delivery posted twice (a V2 fan-out duplicate) stores once", async () => {
		await post(envelope(1, sid, "session.created", {}));
		await post(prompt());
		await post(stop(), { deliveryId: "dlv-fanout-0001" });
		await post(stop(), { deliveryId: "dlv-fanout-0001" });
		const stops = (await rowsOf(sid)).filter((r) => r.eventType === "Stop");
		expect(stops).toHaveLength(1);
	});
});

describe("permissions: a wait is cleared by its own call only", () => {
	const ask = (sid: string, id: string, perId: string, extra: Raw = {}) =>
		envelope(
			1,
			sid,
			"permission.asked",
			{ request_id: perId, tool_use_id: id, permission: "edit", patterns: ["a.txt"] },
			extra,
		);
	const denied = (sid: string, id: string, perId: string, extra: Raw = {}) =>
		envelope(
			1,
			sid,
			"permission.replied",
			{ request_id: perId, tool_use_id: id, reply: "reject" },
			extra,
		);
	const toolPost = (sid: string, id: string, extra: Raw = {}) =>
		envelope(
			1,
			sid,
			"tool.execute.after",
			{ tool: "write", tool_use_id: id, input: {}, status: "completed", output: "ok" },
			extra,
		);
	const start = async (sid: string) => {
		await post(envelope(1, sid, "session.created", {}));
		await post(envelope(1, sid, "chat.message", { text: "go" }));
	};

	test("ask is WAITING; reject clears it", async () => {
		const sid = "ses_permreject00000000000000001";
		await start(sid);
		expect(await operationalOf(sid)).toBe("working");
		await post(ask(sid, "call_1", "per_1"));
		expect(await operationalOf(sid)).toBe("waiting");
		await post(denied(sid, "call_1", "per_1"));
		expect(await operationalOf(sid)).toBe("working");
	});

	test("an accepted ask is cleared by Post on the same id", async () => {
		const sid = "ses_permaccept0000000000000001";
		await start(sid);
		await post(ask(sid, "call_1", "per_1"));
		expect(await operationalOf(sid)).toBe("waiting");
		// permission.replied with "once" is never forwarded; the tool runs and its Post clears the wait.
		await post(toolPost(sid, "call_1"));
		expect(await operationalOf(sid)).toBe("working");
	});

	test("a Post for another call does not clear the wait (negative control)", async () => {
		const sid = "ses_permother00000000000000001";
		await start(sid);
		await post(ask(sid, "call_1", "per_1"));
		await post(toolPost(sid, "call_2"));
		expect(await operationalOf(sid)).toBe("waiting");
	});

	test("a child's ask is WAITING on the parent and cleared by the child's Post", async () => {
		const parent = "ses_parent000000000000000000001";
		const child = "ses_child0000000000000000000001";
		await start(parent);
		await post(envelope(1, child, "session.created", {}, { parent_session_id: parent }));
		const childId = `${child}:call_1#2`;
		await post(ask(child, "call_1#2", "per_c1", { parent_session_id: parent }));
		expect(await operationalOf(parent)).toBe("waiting");
		const ids = ((await sessionOf(parent)).metadata as { permissionWait?: { ids?: string[] } })
			.permissionWait?.ids;
		expect(ids).toContain(childId);
		await post(toolPost(child, "call_1#2", { parent_session_id: parent }));
		expect(await operationalOf(parent)).toBe("working");
	});

	test("two concurrent asks, one rejected: still WAITING on the other, until its Post", async () => {
		const sid = "ses_permtwo0000000000000000001";
		await start(sid);
		await post(ask(sid, "call_a", "per_a"));
		await post(ask(sid, "call_b", "per_b"));
		await post(denied(sid, "call_a", "per_a"));
		expect(await operationalOf(sid)).toBe("waiting");
		await post(toolPost(sid, "call_b"));
		expect(await operationalOf(sid)).toBe("working");
	});

	/** Posts a permission fixture, returning the open waits right after the ask and at the end. */
	async function runPermissionFixture(line: "v1" | "v2", name: string, sid: string) {
		let afterAsk: string[] | null = null;
		for (const e of scenario(line, name)) {
			await post(e);
			if (e.hook_event_name === "permission.asked") afterAsk = await outstandingWaits(sid);
		}
		return { afterAsk, atEnd: await outstandingWaits(sid) };
	}

	for (const [name, line, sid] of [
		["permission-reject", "v1", "ses_e409af519ffeAgKvL1z8eZp1j2"],
		["permission-reject", "v2", "ses_e409a4ecbffeae1R7qvn7pIZI0"],
		["permission-accept", "v1", "ses_e409a268effe1H6n49ViXfJ0oa"],
		["permission-accept", "v2", "ses_e409991b7ffeGR5JG6fOri4pYa"],
	] as const) {
		test(`${line}/${name}: one wait opens at the ask and none is left at the end`, async () => {
			const { afterAsk, atEnd } = await runPermissionFixture(line, name, sid);
			expect(afterAsk).toEqual(["call_stub_perm_1"]);
			expect(atEnd).toEqual([]);
		});
	}
});

describe("subagents are folded into their parent", () => {
	for (const [line, parent, child] of [
		["v1", "ses_e409b228bffe8UiJIX3B6hKEVy", "ses_e409b1d18ffeWjzFzszlIdpkVh"],
		["v2", "ses_e409a7d1fffeRRBiaxLFMVxZBh", "ses_e409a7602ffeFctdrNv0LDEI4k"],
	] as const) {
		test(`${line}/child-session: the child's rows sit on the parent, there is no child row`, async () => {
			await postScenario(line, "child-session");
			expect(await sessionOf(child)).toBeUndefined();
			expect(await rowsOf(child)).toEqual([]);
			const rows = await rowsOf(parent);
			const types = rows.map((r) => r.eventType);
			expect(types).toContain("SubagentStart");
			expect(types).toContain("SubagentStop");
			const childTool = rows.find(
				(r) =>
					r.eventType === "PreToolUse" &&
					r.toolName !== null &&
					r.toolName !== "task" &&
					r.toolName !== "subagent",
			);
			expect(childTool).toBeDefined();
			const raw = childTool?.rawPayload as { agent_id?: string; tool_use_id?: string };
			expect(raw.agent_id).toBe(child);
			expect(raw.tool_use_id).toBe(`${child}:call_stub_ok_1`);
			// The child's prompt is not a user turn.
			expect(types.filter((t) => t === "UserPromptSubmit")).toHaveLength(1);
		});
	}
});

describe("failures and aborts", () => {
	test("v1 forced 400: an error row with name and status only, then Stop", async () => {
		await postScenario("v1", "forced-400");
		const rows = await rowsOf("ses_e409b0823ffenWLNr1vBO8pCr6");
		const error = rows.find((r) => r.eventType === "ErrorOccurred");
		expect(error?.content).toBe("Error: APIError (HTTP 400)");
		const stored = JSON.stringify(error?.rawPayload);
		for (const forbidden of [
			"responseHeaders",
			"keep-alive",
			"responseBody",
			"stub forced failure",
		]) {
			expect(stored).not.toContain(forbidden);
		}
	});

	test("v2 forced 400: an error row, and the failed execution is a plain Stop", async () => {
		await postScenario("v2", "forced-400");
		const rows = await rowsOf("ses_e409a5e2dffeDMjWcYhzWx1ACt");
		expect(rows.map((r) => r.eventType)).toEqual(["UserPromptSubmit", "ErrorOccurred", "Stop"]);
	});

	test("abort is an Interrupt row on both lines and stops the working flag", async () => {
		await postScenario("v1", "abort");
		const v1 = await rowsOf("ses_e4099e69dffer6O0RUE8r04ehr");
		expect(v1.map((r) => r.eventType)).toContain("Interrupt");
		await postScenario("v2", "abort");
		const v2 = await rowsOf("ses_e40995238ffewJFQAEVMiTZ4Qc");
		expect(v2.map((r) => r.eventType)).toContain("Interrupt");
		// The aborted 2.x step adds no row of its own.
		expect(v2.filter((r) => r.eventType === "ErrorOccurred")).toHaveLength(0);
		expect((await sessionOf("ses_e40995238ffewJFQAEVMiTZ4Qc")).isWorking).toBe(false);
	});
});

describe("hostile bodies never reach a row", () => {
	test("a body that fails the contract is acknowledged and stores nothing", async () => {
		const sid = "ses_hostile000000000000000000001";
		await post({ session_id: sid, hook_event_name: "PreToolUse", tool_name: "x", extra: true });
		await post(
			envelope(1, sid, "tool.execute.before", { tool: "bash", tool_use_id: "a\nb", input: {} }),
		);
		await post(
			envelope(2, sid, "tool.execute.before", { tool: "bash", tool_use_id: "a", input: {} }),
		);
		expect(await rowsOf(sid)).toEqual([]);
		expect(await sessionOf(sid)).toBeUndefined();
	});

	test("fields the contract does not name are not stored", async () => {
		const sid = "ses_extrafields0000000000000000001";
		await post(
			envelope(
				1,
				sid,
				"session.idle",
				{ smuggled: "data" },
				{
					transcript_path: "/etc/passwd",
					prompt: "injected",
					tool_name: "injected",
				},
			),
		);
		const rows = await rowsOf(sid);
		const stored = JSON.stringify(rows.map((r) => r.rawPayload));
		for (const forbidden of ["/etc/passwd", "injected", "smuggled"]) {
			expect(stored).not.toContain(forbidden);
		}
	});
});

describe("the API knows the type", () => {
	test("GET /sessions?agent_type=opencode is 200 and lists the session", async () => {
		await postScenario("v1", "plain");
		const res = await app.request("/api/v1/sessions?agent_type=opencode");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sessions: Array<{ sessionId: string; agentType: string }>;
		};
		expect(body.sessions.map((s) => s.sessionId)).toEqual(["ses_e409b5f45ffe8k06g2lzPXO9ZQ"]);
		expect(body.sessions[0]?.agentType).toBe("opencode");
	});

	test("GET /sessions/stats counts it under byAgentType.opencode", async () => {
		await postScenario("v1", "plain");
		await postScenario("v2", "plain");
		const res = await app.request("/api/v1/sessions/stats");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { byAgentType: Record<string, number> };
		expect(body.byAgentType.opencode).toBe(2);
		expect(body.byAgentType.claude_code).toBe(0);
	});
});
