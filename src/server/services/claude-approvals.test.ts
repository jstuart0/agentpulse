/**
 * AGEN-117 P4, server half: a takeover fork's tool requests through the approval service (T9, T10). Recording a
 * Claude request (the fields only a Claude request has), the new decline-only reasons, the new kind, the
 * `decided_elsewhere` outcome and how long it stays listed, and that a Codex row's stored text is untouched.
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres (it is in the Postgres
 * workflow's list).
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import {
	CODEX_CLOSED_VISIBLE_MS,
	CODEX_DECIDED_ELSEWHERE_VISIBLE_MS,
	type CodexApprovalReportRequest,
	NOT_APPROVABLE_REASONS,
	type NotApprovableReason,
	TRACKER_OUTCOME_TABLE,
} from "../../shared/codex-approvals.js";

import { countDbCalls } from "../test-utils/db-call-counter.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovals, events, launchRequests, sessions } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const {
	ApprovalRefusal,
	answerApproval,
	getApprovalDetail,
	listApprovalsForSession,
	openedWords,
	parseApprovalReport,
	recordApprovalRequest,
	syncApprovals,
} = await import("./codex-approvals.js");
const { buildPresentation, touchesAgentConfig, pathIsAgentConfig, urlHostLooksLikeAnother } =
	await import("./codex-approval-presentation.js");

beforeAll(() => initializeDatabase());

const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
});

let counter = 0;
async function setup(agent: "claude_code" | "codex_cli" = "claude_code") {
	counter++;
	const sessionId = `cl-session-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	const supervisorId = `cl-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId, agentType: agent });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, clock, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const rowOf = async (id: string) =>
	(await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id)))[0];

const bash = (over: Partial<CodexApprovalReportRequest> = {}) =>
	harness.commandReport({
		rpcId: `"${crypto.randomUUID()}"`,
		itemId: `toolu_${crypto.randomUUID().slice(0, 8)}`,
		runtimeEpoch: "epoch-claude",
		blockedPath: "/work/project/a.txt",
		...over,
	});

const toolReport = (
	over: Partial<CodexApprovalReportRequest> = {},
): CodexApprovalReportRequest => ({
	...bash(),
	requestKind: "claude_tool",
	command: undefined,
	blockedPath: undefined,
	tool: "WebFetch",
	target: "https://example.com/docs",
	reason: "summarise the docs",
	...over,
});

const writeReport = (kind: string, over: Partial<CodexApprovalReportRequest> = {}) =>
	harness.fileChangeReport({
		rpcId: `"${crypto.randomUUID()}"`,
		itemId: `toolu_${crypto.randomUUID().slice(0, 8)}`,
		runtimeEpoch: "epoch-claude",
		changes: [{ path: "/work/project/a.txt", kind, movePath: null, diff: "hello" }],
		...over,
	});

async function record(ctx: Ctx, report: CodexApprovalReportRequest) {
	return (await recordApprovalRequest(ctx.supervisorId, ctx.sessionId, report, ctx.deps)).response
		.approvalId;
}

const syncBody = (live: string[] = [], resolved: Array<Record<string, unknown>> = []) => ({
	v: 1 as const,
	live: live.map((approvalId) => ({ approvalId, revision: 1 })),
	resolved: resolved as never,
});

async function eventsOf(sessionId: string) {
	return getDb().select().from(events).where(eq(events.sessionId, sessionId));
}

describe("a Claude request is recorded under the Claude presentation", () => {
	test("Bash carries the path Claude named, and a Codex command row does not get the key", async () => {
		const claude = await setup();
		const id = await record(claude, bash());
		const stored = JSON.parse((await rowOf(id))?.presentation ?? "{}");
		expect(stored).toMatchObject({ requestKind: "command", blockedPath: "/work/project/a.txt" });

		const codex = await setup("codex_cli");
		const codexId = await record(codex, harness.commandReport({ blockedPath: "/etc/x" }));
		const codexStored = JSON.parse((await rowOf(codexId))?.presentation ?? "{}");
		expect(Object.keys(codexStored).sort()).toEqual([
			"command",
			"cwd",
			"grantRoot",
			"reason",
			"requestKind",
			"v",
		]);
	});

	test("the presentation builder gives a Codex command the same canonical text as before", () => {
		const built = buildPresentation(harness.commandReport());
		expect(built.presentationJson).toBe(
			'{"command":"npm test","cwd":"/work/project","grantRoot":null,"reason":null,"requestKind":"command","v":1}',
		);
	});

	test("a WebFetch and a Read are claude_tool rows; a plain URL is approvable", async () => {
		const ctx = await setup();
		const fetchId = await record(ctx, toolReport());
		const readId = await record(
			ctx,
			toolReport({ tool: "Read", target: "/etc/hosts", reason: null }),
		);
		const fetched = await rowOf(fetchId);
		expect(fetched).toMatchObject({ requestKind: "claude_tool", approvable: true });
		expect(JSON.parse(fetched?.presentation ?? "{}")).toMatchObject({
			requestKind: "claude_tool",
			tool: "WebFetch",
			target: "https://example.com/docs",
		});
		expect(await rowOf(readId)).toMatchObject({ requestKind: "claude_tool", approvable: true });
	});

	test("a claude_tool request from a Codex session is refused, not made into a card", async () => {
		const codex = await setup("codex_cli");
		await expect(record(codex, toolReport())).rejects.toBeInstanceOf(ApprovalRefusal);
		expect(await harness.approvalRows(codex.sessionId)).toEqual([]);
	});

	test("a non-ASCII or punycode host is decline-only lookalike_text; an IP and a normal host are not", async () => {
		const ctx = await setup();
		for (const url of [
			"https://exаmple.com/",
			"https://日本.example/",
			"https://xn--exmple-cua.com/",
		]) {
			const row = await rowOf(await record(ctx, toolReport({ target: url })));
			expect(row, url).toMatchObject({ approvable: false, notApprovableReason: "lookalike_text" });
		}
		for (const url of ["https://example.com/", "http://127.0.0.1:3000/a?b=é"]) {
			const row = await rowOf(await record(ctx, toolReport({ target: url })));
			expect(row?.approvable, url).toBe(true);
		}
		expect(urlHostLooksLikeAnother("https://example.com/日本")).toBe(false);
		// Credentials in the authority, and an authority that can't be found, are not a host a person can read.
		for (const url of [
			"https://example.com@evil.test/",
			`https://user:${"pw"}@example.com/`,
			"https:\\\\example.com",
			"https:/example.com",
			"example.com/path",
		]) {
			expect(urlHostLooksLikeAnother(url), url).toBe(true);
		}
	});

	test("a Write kind is kept as the host named it, and a secret in the content makes it decline-only", async () => {
		const ctx = await setup();
		for (const kind of ["write", "add", "write_unchecked"]) {
			const row = await rowOf(await record(ctx, writeReport(kind)));
			expect(row?.approvable, kind).toBe(true);
			expect(JSON.parse(row?.presentation ?? "{}").changes[0].kind).toBe(kind);
		}
		const secret = await rowOf(
			await record(
				ctx,
				writeReport("add", {
					changes: [
						{
							path: "/work/project/.env",
							kind: "add",
							movePath: null,
							diff: "KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
						},
					],
				}),
			),
		);
		expect(secret).toMatchObject({ approvable: false, notApprovableReason: "redacted" });
	});
});

describe("the new decline-only reasons", () => {
	test("each one the host sends makes the row decline-only with that reason, and the list holds every reason", async () => {
		const ctx = await setup();
		const fromHost: NotApprovableReason[] = [
			"unknown_tool",
			"requires_interaction",
			"symlink_target",
			"input_not_stable",
			"agent_memory",
		];
		for (const reason of fromHost) {
			const row = await rowOf(await record(ctx, bash({ declineOnly: [reason] })));
			expect(row, reason).toMatchObject({ approvable: false, notApprovableReason: reason });
			expect(NOT_APPROVABLE_REASONS).toContain(reason);
		}
	});

	test("an accept for a decline-only row is refused not_approvable", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash({ declineOnly: ["agent_memory"] }));
		const row = await rowOf(id);
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row?.presentationHash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "not_approvable" });
	});
});

describe("the report is read strictly", () => {
	test("tool, target and blockedPath are copied; a claude_tool needs a known tool", () => {
		const parsed = parseApprovalReport(toolReport());
		expect(parsed).toMatchObject({
			requestKind: "claude_tool",
			tool: "WebFetch",
			target: "https://example.com/docs",
		});
		expect(parseApprovalReport(toolReport({ tool: "Bash" }))).toBeNull();
		expect(parseApprovalReport(toolReport({ tool: null }))).toBeNull();
		expect(parseApprovalReport({ ...toolReport(), target: 7 })).toBeNull();
		expect(parseApprovalReport({ ...bash(), blockedPath: 5 })).toBeNull();
		expect(parseApprovalReport({ ...bash(), requestKind: "nonsense" })).toBeNull();
		expect(parseApprovalReport({ ...bash(), extra: "dropped" })).not.toHaveProperty("extra");
	});
});

describe("the words on the timeline", () => {
	test("opening a request says fixed words by agent and kind, with no agent text", async () => {
		const base = { fileCount: 0, tool: null };
		expect(openedWords({ ...base, requestKind: "command", agent: "codex" })).toBe(
			"Codex asks to run a command",
		);
		expect(openedWords({ ...base, requestKind: "command", agent: "claude" })).toBe(
			"Claude asks to run a command",
		);
		expect(
			openedWords({ ...base, requestKind: "file_change", fileCount: 1, agent: "claude" }),
		).toBe("Claude asks to change 1 file");
		expect(openedWords({ ...base, requestKind: "file_change", fileCount: 3, agent: "codex" })).toBe(
			"Codex asks to change 3 files",
		);
		expect(
			openedWords({ ...base, requestKind: "claude_tool", tool: "WebFetch", agent: "claude" }),
		).toBe("Claude asks to fetch a URL");
		expect(
			openedWords({ ...base, requestKind: "claude_tool", tool: "Read", agent: "claude" }),
		).toBe("Claude asks to read a file");
	});

	test("the event a recorded Claude request writes is the fixed line, never its command", async () => {
		const ctx = await setup();
		await record(ctx, bash({ command: "echo SENTINEL-4242" }));
		const stored = JSON.stringify(await eventsOf(ctx.sessionId));
		expect(stored).toContain("Claude asks to run a command");
		expect(stored).not.toContain("SENTINEL-4242");
	});
});

describe("decided_elsewhere", () => {
	test("has a table entry that closes a pending row and an answered one with the same reason", () => {
		expect(TRACKER_OUTCOME_TABLE.decided_elsewhere).toEqual({
			terminal: true,
			accept: "decided_elsewhere",
			other: "decided_elsewhere",
		});
	});

	test("reported for a row nobody answered, it closes the row and the outcome says it may have run", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash());
		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "decided_elsewhere", sentDecision: null }]),
			ctx.deps,
		);
		const row = await rowOf(id);
		expect(row).toMatchObject({ status: "closed", closedReason: "decided_elsewhere" });
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.approvals[0]).toMatchObject({ state: "closed", outcome: "decided_elsewhere" });
	});

	test("reported after a person declined, it is decided_elsewhere, not declined", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash());
		await answerApproval(ctx.sessionId, id, { decision: "decline" }, harness.SOLO_PERSON, ctx.deps);
		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "decided_elsewhere", sentDecision: "decline" }]),
			ctx.deps,
		);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "decided_elsewhere" });
	});

	test("stays on the list past five minutes, up to 24 hours; any other closed row leaves at five", async () => {
		const ctx = await setup();
		const elsewhere = await record(ctx, bash());
		const stopped = await record(ctx, bash());
		await syncApprovals(
			ctx.supervisorId,
			syncBody(
				[elsewhere, stopped],
				[
					{ approvalId: elsewhere, outcome: "decided_elsewhere", sentDecision: null },
					{ approvalId: stopped, outcome: "resolved_before_response", sentDecision: null },
				],
			),
			ctx.deps,
		);
		const idsAt = async (ms: number) => {
			ctx.clock.advance(ms);
			return (
				await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps)
			).approvals.map((a) => a.id);
		};
		expect(await idsAt(CODEX_CLOSED_VISIBLE_MS - 1000)).toEqual(
			expect.arrayContaining([elsewhere, stopped]),
		);
		const later = await idsAt(2000 + 60 * 60 * 1000);
		expect(later).toContain(elsewhere);
		expect(later).not.toContain(stopped);
		expect(await idsAt(CODEX_DECIDED_ELSEWHERE_VISIBLE_MS)).not.toContain(elsewhere);
	});

	test("the timeline word is the fixed one", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash());
		await syncApprovals(
			ctx.supervisorId,
			syncBody([id], [{ approvalId: id, outcome: "decided_elsewhere", sentDecision: null }]),
			ctx.deps,
		);
		expect(JSON.stringify(await eventsOf(ctx.sessionId))).toContain(
			"Approval resolved: may have run",
		);
	});
});

describe("who may answer, and Stop against an accept", () => {
	test("an accept needs a signed-in person: an API key is refused even for an admin's session; a decline is not", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash());
		const row = await rowOf(id);
		const key = { ...harness.SOLO_PERSON, isHuman: false };
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row?.presentationHash },
				key,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "human_required" });
		await expect(
			answerApproval(ctx.sessionId, id, { decision: "decline" }, key, ctx.deps),
		).resolves.toBeTruthy();
	});

	test("in team mode an unowned fork's accept is an admin's: a member is not_owner, an admin is let through", async () => {
		const ctx = await setup();
		const member = `cl-member-${crypto.randomUUID().slice(0, 6)}`;
		const admin = `cl-admin-${crypto.randomUUID().slice(0, 6)}`;
		await harness.seedUser(member, { role: "user" });
		await harness.seedUser(admin, { role: "admin" });
		const id = await record(ctx, bash());
		const hash = (await rowOf(id))?.presentationHash;
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: hash },
				harness.teamCaller(member, "member"),
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "not_owner" });
		const answered = await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "accept", presentationHash: hash },
			harness.teamCaller(admin, "admin"),
			ctx.deps,
		);
		expect(answered.approval.state).toBe("answered");
	});

	test("a Stop queued after an accept is answered: the sync does not issue it", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash());
		const row = await rowOf(id);
		await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "accept", presentationHash: row?.presentationHash },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		await harness.seedActiveStop(ctx.sessionId, "running");
		const response = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(response.answers.filter((a) => a.decision === "accept")).toEqual([]);
		expect((await rowOf(id))?.firstDeliveredAt).toBeNull();
	});
});

describe("files a later Claude session loads", () => {
	test("each member of the set is labelled; a backup name is not", () => {
		for (const path of [
			"/p/CLAUDE.md",
			"/p/sub/claude.md",
			"/p/AGENTS.md",
			"/p/.claude/settings.json",
			"/home/u/.claude/CLAUDE.md",
			"/p/.mcp.json",
			"/p/.git/hooks/pre-commit",
			"/home/u/.zshrc",
			"/home/u/.bashrc",
			"/home/u/.profile",
			"/home/u/.zprofile",
			"/p/.git/config",
			"/p/.gitmodules",
			"/home/u/.gitconfig",
			"/p/.husky/pre-commit",
			"/p/.envrc",
			"/home/u/.npmrc",
			"/home/u/.ssh/authorized_keys",
		]) {
			expect(pathIsAgentConfig(path), path).toBe(true);
		}
		for (const path of [
			"/p/CLAUDE.md.bak",
			"/p/notes/claude.md.txt",
			"/p/.claudeignore",
			"/p/src/agents.ts",
			"/p/.git/HEAD",
			"/p/.gitignore",
		]) {
			expect(pathIsAgentConfig(path), path).toBe(false);
		}
	});

	test("a file card and a Bash card that names one carry the flag; the detail says so only for Claude", async () => {
		expect(
			touchesAgentConfig(
				buildPresentation(
					writeReport("write", {
						changes: [{ path: "/p/CLAUDE.md", kind: "write", movePath: null, diff: "x" }],
					}),
					"claude",
				).presentation,
			),
		).toBe(true);
		expect(
			touchesAgentConfig(
				buildPresentation(bash({ command: "echo hi >> ~/.claude/settings.json" }), "claude")
					.presentation,
			),
		).toBe(true);
		expect(
			touchesAgentConfig(buildPresentation(bash({ command: "ls -la" }), "claude").presentation),
		).toBe(false);

		const ctx = await setup();
		const id = await record(
			ctx,
			writeReport("write", {
				changes: [{ path: "/work/project/CLAUDE.md", kind: "write", movePath: null, diff: "x" }],
			}),
		);
		const detail = await getApprovalDetail(ctx.sessionId, id, harness.SOLO_PERSON, ctx.deps);
		expect(detail.touchesAgentConfig).toBe(true);
		const codex = await setup("codex_cli");
		const codexId = await record(
			codex,
			writeReport("update", {
				changes: [{ path: "/work/project/CLAUDE.md", kind: "update", movePath: null, diff: "x" }],
			}),
		);
		expect(
			(await getApprovalDetail(codex.sessionId, codexId, harness.SOLO_PERSON, codex.deps))
				.touchesAgentConfig,
		).toBeUndefined();
	});
});

describe("one sync for both agents", () => {
	test("a sync with nothing to do is one statement however many Claude and Codex rows the host holds (liveMax, mixed)", async () => {
		const claude = await setup("claude_code");
		// A second session on the same host, a Codex one.
		const codexSession = `cl-codex-${crypto.randomUUID().slice(0, 6)}`;
		used.push(codexSession);
		await harness.seedApprovalSession({
			sessionId: codexSession,
			supervisorId: claude.supervisorId,
		});
		const live: string[] = [];
		for (let i = 0; i < 32; i++) live.push(await record(claude, bash()));
		for (let i = 0; i < 32; i++) {
			const report = harness.commandReport({
				rpcId: `"${crypto.randomUUID()}"`,
				itemId: `item-${i}`,
				runtimeEpoch: "epoch-codex",
			});
			live.push(
				(await recordApprovalRequest(claude.supervisorId, codexSession, report, claude.deps))
					.response.approvalId,
			);
		}
		expect(live).toHaveLength(64);
		const statements = await countDbCalls(async () => {
			await syncApprovals(claude.supervisorId, syncBody(live), claude.deps);
		});
		expect(statements).toBe(1);
	});
});

describe("the agent is the launch's, not the session row's (AGEN-91)", () => {
	test("a session row that says claude_code over a Codex launch is still a Codex row; the reverse is Claude's", async () => {
		const ctx = await setup("codex_cli");
		await getDb()
			.update(sessions)
			.set({ agentType: "claude_code" })
			.where(eq(sessions.sessionId, ctx.sessionId));
		const id = await record(ctx, bash());
		expect(Object.keys(JSON.parse((await rowOf(id))?.presentation ?? "{}"))).not.toContain(
			"blockedPath",
		);
		await expect(record(ctx, toolReport())).rejects.toBeInstanceOf(ApprovalRefusal);

		const claude = await setup("claude_code");
		await getDb()
			.update(sessions)
			.set({ agentType: "codex_cli" })
			.where(eq(sessions.sessionId, claude.sessionId));
		const claudeId = await record(claude, bash());
		expect(JSON.parse((await rowOf(claudeId))?.presentation ?? "{}")).toHaveProperty("blockedPath");
		const [launch] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.launchCorrelationId, claude.sessionId));
		expect(launch?.agentType).toBe("claude_code");
	});
});

describe("the list never loses an open row to a closed one", () => {
	test("40 closed decided_elsewhere rows and 5 open: all 5 open are listed first, within the cap of 52", async () => {
		const ctx = await setup();
		let closed = 0;
		for (let batch = 0; batch < 2; batch++) {
			const ids: string[] = [];
			for (let i = 0; i < 20; i++) ids.push(await record(ctx, bash()));
			await syncApprovals(
				ctx.supervisorId,
				syncBody(
					ids,
					ids.map((approvalId) => ({
						approvalId,
						outcome: "decided_elsewhere",
						sentDecision: null,
					})),
				),
				ctx.deps,
			);
			closed += ids.length;
			// Past the per-ten-minutes creation window, so the next batch may be recorded.
			ctx.clock.advance(11 * 60 * 1000);
		}
		const open: string[] = [];
		for (let i = 0; i < 5; i++) open.push(await record(ctx, bash()));
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(closed).toBe(40);
		expect(list.approvals.length).toBeLessThanOrEqual(52);
		const ids = list.approvals.map((a) => a.id);
		for (const id of open) expect(ids).toContain(id);
		expect(list.approvals.slice(0, 5).map((a) => a.state)).toEqual(Array(5).fill("pending"));
	});
});

describe("Stop against a claude_tool request", () => {
	test("Stop committed after the accept was issued: it is not issued again", async () => {
		const ctx = await setup();
		const id = await record(ctx, toolReport());
		const row = await rowOf(id);
		await answerApproval(
			ctx.sessionId,
			id,
			{ decision: "accept", presentationHash: row?.presentationHash },
			harness.SOLO_PERSON,
			ctx.deps,
		);
		const first = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(first.answers.map((a) => a.decision)).toEqual(["accept"]);
		await harness.seedActiveStop(ctx.sessionId, "queued");
		const second = await syncApprovals(ctx.supervisorId, syncBody([id]), ctx.deps);
		expect(second.answers.filter((a) => a.decision === "accept")).toEqual([]);
	});

	test("an answer after Stop committed is refused", async () => {
		const ctx = await setup();
		const id = await record(ctx, toolReport());
		const row = await rowOf(id);
		await harness.seedActiveStop(ctx.sessionId, "running");
		await expect(
			answerApproval(
				ctx.sessionId,
				id,
				{ decision: "accept", presentationHash: row?.presentationHash },
				harness.SOLO_PERSON,
				ctx.deps,
			),
		).rejects.toMatchObject({ code: "session_stopped" });
		expect((await rowOf(id))?.decision).toBeNull();
	});
});

describe("the rollback path: a host told the server lacks claude_approvals", () => {
	test("the downgraded outcome (an accept whose end is unknown) closes the row and reads may-have-run, not 'didn't run'", async () => {
		const ctx = await setup();
		const id = await record(ctx, bash());
		await syncApprovals(
			ctx.supervisorId,
			syncBody(
				[id],
				[{ approvalId: id, outcome: "runtime_gone_after_response", sentDecision: "accept" }],
			),
			ctx.deps,
		);
		expect(await rowOf(id)).toMatchObject({ status: "closed", closedReason: "outcome_unknown" });
		const list = await listApprovalsForSession(ctx.sessionId, harness.SOLO_PERSON, ctx.deps);
		expect(list.approvals[0]?.outcome).toBe("may_have_run");
	});
});
