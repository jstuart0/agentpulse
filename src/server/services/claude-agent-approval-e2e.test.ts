/**
 * AGEN-120, end to end on the recorded 2.1.319 requests: the host reads a request (`parseClaudeRequest`),
 * builds the report (`buildClaudeReportBody`), the report crosses the wire as JSON, the server parses it, builds
 * the presentation, stores the row, lists it, and a person's answer is judged. The Agent call's request is the
 * one recorded in G5; a helper's own requests are the ones recorded in s5, g6 and g7.
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import { FORK_OPTIONS_OFF } from "../../shared/session-resume.js";
import {
	CLAUDE_FIXTURE_DIR_2_1_319 as DIR,
	outLines,
} from "../../supervisor/providers/__fixtures__/claude-frames.js";
import {
	buildClaudeReportBody,
	parseClaudeRequest,
} from "../../supervisor/providers/claude-approval-params.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovals, events } = await import("../db/schema/index.js");
const { serializeApprovalDetail, serializeApprovalList } = await import(
	"../routes/codex-approvals.js"
);
const harness = await import("../test-utils/codex-approvals-harness.js");
const {
	answerApproval,
	getApprovalDetail,
	listApprovalsForSession,
	openedWords,
	parseApprovalReport,
	recordApprovalRequest,
} = await import("./codex-approvals.js");

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

const APPLIED = { mcpServers: [], subagents: true, claudeVersion: "2.1.319" };
const FS = {
	realpath: (p: string) => p,
	exists: () => "no" as const,
	isSymlink: () => false,
};

async function setup() {
	const sessionId = `ag-session-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `ag-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId, agentType: "claude_code" });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const requestsOf = (fixture: string) =>
	outLines(fixture, DIR)
		.filter((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool")
		.map((m) => m.request as Record<string, unknown>);

let rpc = 0;
/** What the host sends for one recorded request: through the parser, the report builder and JSON, then the server's wire parser. */
function wire(request: unknown, applied = APPLIED) {
	const parsed = parseClaudeRequest(request, {
		threadId: "ag-thread",
		turnId: "ag-turn",
		cwd: "/work/project",
		configDir: "/work/cfg",
		inputStable: true,
		applied,
		fs: FS,
	});
	if (!parsed) throw new Error("the host could not report this request");
	rpc++;
	const body = JSON.parse(
		JSON.stringify(
			buildClaudeReportBody({
				runtimeEpoch: "epoch-agent",
				rpcId: `"${rpc}"`,
				parsed,
				ageMs: 0,
				revision: 1,
			}),
		),
	);
	return { body, report: parseApprovalReport(body) };
}

async function record(ctx: Ctx, request: unknown) {
	const { report } = wire(request);
	if (!report) throw new Error("the server refused the report");
	const result = await recordApprovalRequest(ctx.supervisorId, ctx.sessionId, report, ctx.deps);
	return result.response.approvalId;
}

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];

const agentRequest = (fixture: string, nested = false) =>
	requestsOf(fixture).find(
		(r) => r.tool_name === "Agent" && (typeof r.agent_id === "string") === nested,
	);

describe("the Agent call, recorded in G5", () => {
	test("both logins: the report parses on the server and the card is approvable, listed as a helper of the recorded type", async () => {
		for (const fixture of ["g5-rule-allow-key", "g5-rule-allow-helper"]) {
			const ctx = await setup();
			const request = agentRequest(fixture);
			expect(request, fixture).toBeDefined();
			const id = await record(ctx, request);
			const row = await rowOf(id as string);
			expect(row).toMatchObject({ requestKind: "claude_tool", approvable: true });
			const stored = JSON.parse(row?.presentation ?? "{}");
			expect(stored.tool).toBe("Agent");
			expect(stored.target).toBe("general-purpose");
			expect(stored.agent).toMatchObject({ subagentType: "general-purpose", builtIn: true });
			expect(stored.agent.prompt).toBe((request?.input as { prompt: string }).prompt);
			expect(stored.fromSubagent).toBeUndefined();
			const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
			expect(list.approvals[0]?.preview).toMatchObject({
				tool: "Agent",
				target: "general-purpose",
			});
			expect(list.approvals[0]?.preview).not.toHaveProperty("fromSubagent");
		}
	});

	test("accepting needs the hash, a signed-in person, and is judged like any approvable row (accept and decline both work)", async () => {
		const ctx = await setup();
		const id = (await record(ctx, agentRequest("g5-rule-allow-key"))) as string;
		const hash = (await rowOf(id))?.presentationHash;
		await expect(
			answerApproval(ctx.sessionId, id, { decision: "accept" }, harness.SOLO_PERSON, ctx.deps),
		).rejects.toMatchObject({ code: "presentation_hash_required" });
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: hash },
				{ ...harness.SOLO_PERSON, isHuman: false },
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "human_required" });
		await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "accept", presentationHash: hash },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		expect(await rowOf(id)).toMatchObject({ status: "answered", decision: "accept" });

		const other = await setup();
		const declineId = (await record(other, agentRequest("g5-rule-allow-key"))) as string;
		await answerApproval(
			other.sessionId,
			declineId,
			{ decision: "decline" },
			harness.SOLO_PERSON,
			other.deps,
		);
		expect(await rowOf(declineId)).toMatchObject({ decision: "decline" });
	});

	test("the detail carries the whole prompt the helper would be told; the timeline line carries none of it", async () => {
		const ctx = await setup();
		const id = (await record(ctx, agentRequest("g5-rule-allow-key"))) as string;
		const detail = await getApprovalDetail(ctx.sessionId, id, harness.SOLO_PERSON, ctx.deps);
		expect(detail.presentation).toMatchObject({
			requestKind: "claude_tool",
			agent: { subagentType: "general-purpose" },
		});
		const rows = await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId));
		const permission = rows.find((r) => r.eventType === "PermissionRequest");
		expect(permission?.content).toBe("Claude asks to start a helper");
		const prompt = (agentRequest("g5-rule-allow-key")?.input as { prompt: string }).prompt;
		expect(JSON.stringify(rows)).not.toContain(prompt);
	});

	test("what crosses the wire to the person carries the whole slot: the route's serializers keep agent and fromSubagent (found live: an allowlist dropped them)", async () => {
		const ctx = await setup();
		const id = (await record(ctx, agentRequest("g5-rule-allow-key"))) as string;
		const prompt = (agentRequest("g5-rule-allow-key")?.input as { prompt: string }).prompt;
		const detail = serializeApprovalDetail(
			await getApprovalDetail(ctx.sessionId, id, harness.SOLO_PERSON, ctx.deps),
		);
		expect(detail.presentation).toMatchObject({
			requestKind: "claude_tool",
			tool: "Agent",
			agent: { subagentType: "general-purpose", prompt, builtIn: true },
		});
		expect(detail.presentation).not.toHaveProperty("fromSubagent");

		const helper = await setup();
		const write = requestsOf("s5-general-key").find((r) => r.tool_name === "Write");
		const helperId = (await record(helper, write)) as string;
		const helperDetail = serializeApprovalDetail(
			await getApprovalDetail(helper.sessionId, helperId, harness.SOLO_PERSON, helper.deps),
		);
		expect(helperDetail.presentation).toMatchObject({
			requestKind: "file_change",
			fromSubagent: true,
		});
		const list = serializeApprovalList(
			await listApprovalsForSession(helper.sessionId, harness.SOLO_PERSON, helper.deps),
		);
		expect(list.approvals[0]?.preview).toMatchObject({ fromSubagent: true });

		const bash = await setup();
		const bashId = (await record(
			bash,
			requestsOf("g7-with-helper").find((r) => r.tool_name === "Bash"),
		)) as string;
		expect(
			serializeApprovalDetail(
				await getApprovalDetail(bash.sessionId, bashId, harness.SOLO_PERSON, bash.deps),
			).presentation,
		).toMatchObject({ requestKind: "command", fromSubagent: true });

		// The fork's own request: no new key at all (responses are unchanged).
		const own = await setup();
		const ownId = (await record(own, {
			tool_name: "Bash",
			tool_use_id: "toolu_own",
			input: { command: "ls" },
		})) as string;
		const ownDetail = serializeApprovalDetail(
			await getApprovalDetail(own.sessionId, ownId, harness.SOLO_PERSON, own.deps),
		);
		expect(ownDetail.presentation).not.toHaveProperty("fromSubagent");
		expect(
			serializeApprovalList(
				await listApprovalsForSession(own.sessionId, harness.SOLO_PERSON, own.deps),
			).approvals[0]?.preview,
		).not.toHaveProperty("fromSubagent");
	});

	test("a custom type (G7) is stored decline-only custom_agent, and its accept is refused not_approvable", async () => {
		const ctx = await setup();
		const request = agentRequest("g7-with-helper");
		const id = (await record(ctx, request)) as string;
		const row = await rowOf(id);
		expect(row).toMatchObject({ approvable: false, notApprovableReason: "custom_agent" });
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row?.presentationHash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "not_approvable" });
		await answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
		expect(await rowOf(id)).toMatchObject({ decision: "decline" });
	});

	test("a nested call (G6, agent_id on an Agent request) is stored decline-only nested_agent with fromSubagent", async () => {
		const ctx = await setup();
		const nested = agentRequest("g6-rule-denynested-key", true);
		expect(nested).toBeDefined();
		const id = (await record(ctx, nested)) as string;
		const row = await rowOf(id);
		expect(row).toMatchObject({ approvable: false, notApprovableReason: "nested_agent" });
		expect(JSON.parse(row?.presentation ?? "{}").fromSubagent).toBe(true);
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.approvals[0]?.preview).toMatchObject({ fromSubagent: true });
	});

	test("the server decides what ships with Claude Code: a host that calls a custom type built in is not believed", async () => {
		const ctx = await setup();
		const { body } = wire(agentRequest("g5-rule-allow-key"));
		const lying = {
			...body,
			target: "probeagent",
			agent: { ...body.agent, subagentType: "probeagent", builtIn: true },
		};
		const report = parseApprovalReport(lying);
		expect(report).not.toBeNull();
		const id = (
			await recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				{ ...(report as NonNullable<typeof report>), rpcId: '"lie"' },
				ctx.deps,
			)
		).response.approvalId;
		const row = await rowOf(id);
		expect(row).toMatchObject({ approvable: false, notApprovableReason: "custom_agent" });
		expect(JSON.parse(row?.presentation ?? "{}").agent.builtIn).toBe(false);
	});

	test("a helper's call reported as a top-level one (no fromSubagent) is still decline-only if it names a custom type, and nested is judged from fromSubagent alone", async () => {
		const ctx = await setup();
		const { body } = wire(agentRequest("g5-rule-allow-key"));
		const withMark = parseApprovalReport({ ...body, fromSubagent: true, declineOnly: [] });
		const id = (
			await recordApprovalRequest(
				ctx.supervisorId,
				ctx.sessionId,
				{ ...(withMark as NonNullable<typeof withMark>), rpcId: '"marked"' },
				ctx.deps,
			)
		).response.approvalId;
		expect(await rowOf(id)).toMatchObject({ notApprovableReason: "nested_agent" });
	});

	test("openedWords says a helper, with no names and no prompt; a subagent's own request says so", () => {
		const base = {
			requestKind: "claude_tool",
			fileCount: 0,
			agent: "claude",
			tool: "Agent",
		} as const;
		expect(openedWords(base)).toBe("Claude asks to start a helper");
		expect(openedWords({ ...base, fromSubagent: true })).toBe("A subagent asks to start a helper");
		expect(openedWords({ requestKind: "command", fileCount: 0, agent: "claude", tool: null })).toBe(
			"Claude asks to run a command",
		);
		expect(
			openedWords({
				requestKind: "command",
				fileCount: 0,
				agent: "claude",
				tool: null,
				fromSubagent: true,
			}),
		).toBe("A subagent asks to run a command");
	});
});

describe("a helper's own requests", () => {
	test("a Write from a helper is a file_change marked fromSubagent: the hash differs from the same Write by the fork", async () => {
		const ctx = await setup();
		const write = requestsOf("s5-general-key").find((r) => r.tool_name === "Write") as Record<
			string,
			unknown
		>;
		expect(typeof write.agent_id).toBe("string");
		const id = (await record(ctx, write)) as string;
		const row = await rowOf(id);
		expect(row).toMatchObject({ requestKind: "file_change" });
		const stored = JSON.parse(row?.presentation ?? "{}");
		expect(stored.fromSubagent).toBe(true);

		const { agent_id: _helper, ...own } = write;
		const ownCtx = await setup();
		const ownId = (await record(ownCtx, { ...own, tool_use_id: "toolu_own" })) as string;
		const ownRow = await rowOf(ownId);
		expect(JSON.parse(ownRow?.presentation ?? "{}").fromSubagent).toBeUndefined();
		expect(ownRow?.presentationHash).not.toBe(row?.presentationHash);
	});

	test("a Bash from a helper (G7) is a command marked fromSubagent, approvable like the fork's own", async () => {
		const ctx = await setup();
		const bash = requestsOf("g7-with-helper").find((r) => r.tool_name === "Bash");
		const id = (await record(ctx, bash)) as string;
		const row = await rowOf(id);
		expect(row).toMatchObject({ requestKind: "command" });
		expect(JSON.parse(row?.presentation ?? "{}").fromSubagent).toBe(true);
	});
});

describe("the options stay off by default", () => {
	test("with no option applied the host cannot report the Agent call at all (unknown tool), so no Agent card exists", () => {
		const parsed = parseClaudeRequest(agentRequest("g5-rule-allow-key"), {
			threadId: "t",
			turnId: "u",
			cwd: "/work/project",
			configDir: null,
			inputStable: true,
			applied: FORK_OPTIONS_OFF,
			fs: FS,
		});
		expect(parsed?.declineOnly).toContain("unknown_tool");
		expect(parsed?.claude?.agent).toBeUndefined();
	});

	test("a report claiming a helper from a Codex session is refused as malformed", async () => {
		const sessionId = `ag-codex-${crypto.randomUUID().slice(0, 8)}`;
		const supervisorId = `ag-codex-host-${crypto.randomUUID().slice(0, 8)}`;
		used.push(sessionId);
		hosts.push(supervisorId);
		await harness.seedApprovalSession({ sessionId, supervisorId, agentType: "codex_cli" });
		const clock = harness.createApprovalClock();
		const report = parseApprovalReport({ ...harness.commandReport(), fromSubagent: true });
		expect(report).not.toBeNull();
		await expect(
			recordApprovalRequest(supervisorId, sessionId, report as NonNullable<typeof report>, {
				now: clock.now,
			}),
		).rejects.toMatchObject({ code: "invalid_body" });
	});
});
