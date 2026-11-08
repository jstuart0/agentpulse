/**
 * AGEN-121, end to end: an MCP tool call on a continued Claude session, from the request Claude recorded to
 * the person's answer.
 *
 *  1. the host parses the recorded request (`m1-base-key`, Claude Code 2.1.319) and builds its report;
 *  2. the gate's report reaches the server through the supervisor route, and the person's read shows the `mcp` card;
 *  3. a signed-in person's accept, carrying the hash, is issued to the host by `approvals/sync`;
 *  4. a decline closes the row `declined`;
 *  5. a manage key's accept gets `human_required`;
 *  6. a report naming a server that isn't applied, or a 65-character name, is refused `invalid_body`.
 *
 * Real enrollment and credentials over the real app. SQLite by default and Postgres under
 * AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import type { CodexApprovalDetail, CodexApprovalList } from "../../shared/codex-approvals.js";
import type { AppliedForkOptions } from "../../shared/session-resume.js";
import { parseClaudeRequest } from "../../supervisor/providers/claude-approval-params.js";
import { buildClaudeReportBody } from "../../supervisor/providers/claude-approval-params.js";
import { deleteAllSupervisors } from "./__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { codexApprovals, sessions } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { seedLocalUser, cookieHeadersFor } = await import("../test-utils/team-fixtures.js");
const { resetIdentityState } = await import("../test-utils/identity-reset.js");

const ORIGIN = "http://localhost:3000";
const originalDisableAuth = config.disableAuth;
const DIGEST = "a".repeat(64);
const APPLIED: AppliedForkOptions = {
	mcpServers: [{ name: "probe", digest: DIGEST }],
	subagents: false,
	claudeVersion: "2.1.319",
};

/** The `can_use_tool` request Claude Code 2.1.319 raised for `mcp__probe__echo_note`, as recorded. */
function recordedMcpRequest(): Record<string, unknown> {
	const path = join(
		import.meta.dir,
		"../../supervisor/providers/__fixtures__/claude-2.1.319/m1-base-key.jsonl",
	);
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line) as { dir: string; frame: Record<string, any> };
		const request = entry.frame?.request;
		if (entry.dir === "out" && request?.subtype === "can_use_tool") return request;
	}
	throw new Error("the fixture holds no can_use_tool request");
}

let manageKey: string;
type Host = { id: string; token: string };
let host: Host;
const sessionsUsed: string[] = [];

async function enroll(name: string): Promise<Host> {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: name,
			enrollmentToken,
			platform: "darwin",
			arch: "arm64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["claude_takeover", "claude_fork_mcp"],
			},
			trustedRoots: ["/tmp"],
		}),
	});
	expect(registered.status).toBe(200);
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

const agentHeaders = (h: Host) => ({
	"Content-Type": "application/json",
	"X-AgentPulse-Supervisor-Token": h.token,
});
const post = (path: string, h: Host, body: unknown) =>
	app.request(path, { method: "POST", headers: agentHeaders(h), body: JSON.stringify(body) });

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("t121-manage", ["manage"])).key;
	host = await enroll("t121-host");
});

afterEach(async () => {
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
});

afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
	await deleteAllSupervisors();
	await resetIdentityState();
});

let counter = 0;
/** A continued Claude session on the host that was started with `applied` MCP servers. */
async function fork(applied: AppliedForkOptions | null = APPLIED) {
	const sessionId = `t121-${++counter}-${crypto.randomUUID().slice(0, 6)}`;
	sessionsUsed.push(sessionId);
	await harness.seedApprovalSession({
		sessionId,
		supervisorId: host.id,
		agentType: "claude_code",
	});
	await getDb()
		.update(sessions)
		.set({
			metadata: {
				forkedFromSessionId: "src-1",
				forkPermissionBranch: "ask",
				...(applied ? { forkOptions: applied } : {}),
			},
		})
		.where(eq(sessions.sessionId, sessionId));
	return sessionId;
}

/** What the host's gate sends for the recorded request. */
function hostReport(
	sessionId: string,
	over: { params?: Record<string, unknown>; applied?: AppliedForkOptions } = {},
) {
	const parsed = parseClaudeRequest(over.params ?? recordedMcpRequest(), {
		threadId: sessionId,
		turnId: "turn-1",
		cwd: "/work/project",
		configDir: null,
		inputStable: true,
		applied: over.applied ?? APPLIED,
	});
	if (!parsed) throw new Error("the host could not parse the request");
	return {
		parsed,
		body: buildClaudeReportBody({
			runtimeEpoch: "epoch-1",
			rpcId: `"${crypto.randomUUID()}"`,
			parsed,
			ageMs: 0,
			revision: 1,
		}),
	};
}

const reportPath = (sessionId: string) =>
	`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`;
const syncPath = () => `/api/v1/supervisors/${host.id}/approvals/sync`;
const approvalsPath = (sessionId: string) => `/api/v1/sessions/${sessionId}/approvals`;

async function person() {
	const user = await seedLocalUser("t121-person");
	const headers = await cookieHeadersFor(user.id);
	headers.set("Origin", ORIGIN);
	headers.set("Content-Type", "application/json");
	return headers;
}

async function openCard(sessionId: string) {
	const { body } = hostReport(sessionId);
	const res = await post(reportPath(sessionId), host, body);
	expect(res.status).toBe(201);
	return ((await res.json()) as { approvalId: string }).approvalId;
}

describe("an MCP tool call on a continued session, end to end", () => {
	test("1. the host parses the recorded request: approvable, split against the applied server, input shown whole", () => {
		const { parsed, body } = hostReport("s");
		expect(parsed.declineOnly).toEqual([]);
		expect(parsed.claude?.mcp).toEqual({
			server: "probe",
			tool: "echo_note",
			rawToolName: "mcp__probe__echo_note",
		});
		expect(body).toMatchObject({
			requestKind: "claude_tool",
			tool: "mcp__probe__echo_note",
			mcp: { server: "probe", tool: "echo_note", rawToolName: "mcp__probe__echo_note" },
			declineOnly: [],
			truncated: false,
		});
		expect(JSON.parse(String(body.target))).toEqual({ text: "hello-base" });
	});

	test("2. the report is recorded and the person reads the mcp card with its hash", async () => {
		const sessionId = await fork();
		const approvalId = await openCard(sessionId);
		const reader = await person();

		const detailRes = await app.request(`${approvalsPath(sessionId)}/${approvalId}`, {
			headers: reader,
		});
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as CodexApprovalDetail;
		expect(detail.approval.approvable).toBe(true);
		expect(detail.presentation).toMatchObject({
			requestKind: "claude_tool",
			tool: "mcp",
			mcp: { server: "probe", tool: "echo_note", rawToolName: "mcp__probe__echo_note" },
		});
		expect(JSON.parse((detail.presentation as { target: string }).target)).toEqual({
			text: "hello-base",
		});

		const listRes = await app.request(approvalsPath(sessionId), { headers: reader });
		const list = (await listRes.json()) as CodexApprovalList;
		expect(list.approvals[0]?.preview).toMatchObject({ tool: "mcp", target: "probe/echo_note" });
		// The list never carries the input.
		expect(JSON.stringify(list)).not.toContain("hello-base");
	});

	test("3. a signed-in person's accept, with the hash, is issued to the host by sync", async () => {
		const sessionId = await fork();
		const approvalId = await openCard(sessionId);
		const reader = await person();
		const detail = (await (
			await app.request(`${approvalsPath(sessionId)}/${approvalId}`, { headers: reader })
		).json()) as CodexApprovalDetail;

		const accepted = await app.request(`${approvalsPath(sessionId)}/${approvalId}/decision`, {
			method: "POST",
			headers: reader,
			body: JSON.stringify({
				decision: "accept",
				presentationHash: detail.approval.presentationHash,
			}),
		});
		expect(accepted.status).toBe(200);

		const synced = await post(syncPath(), host, {
			v: 1,
			live: [{ approvalId, revision: 1 }],
			resolved: [],
		});
		const answers = ((await synced.json()) as { answers: Array<Record<string, unknown>> }).answers;
		expect(answers).toEqual([{ approvalId, decision: "accept", revision: 1 }]);
	});

	test("4. a decline closes the row declined", async () => {
		const sessionId = await fork();
		const approvalId = await openCard(sessionId);
		const reader = await person();
		const declined = await app.request(`${approvalsPath(sessionId)}/${approvalId}/decision`, {
			method: "POST",
			headers: reader,
			body: JSON.stringify({ decision: "decline" }),
		});
		expect(declined.status).toBe(200);
		await post(syncPath(), host, { v: 1, live: [{ approvalId, revision: 1 }], resolved: [] });
		await post(syncPath(), host, {
			v: 1,
			live: [],
			resolved: [{ approvalId, outcome: "resolved_after_response", sentDecision: "decline" }],
		});
		const [row] = await getDb()
			.select()
			.from(codexApprovals)
			.where(eq(codexApprovals.id, approvalId));
		expect(row?.status).toBe("closed");
		expect(row?.decision).toBe("decline");
		const list = (await (
			await app.request(approvalsPath(sessionId), { headers: reader })
		).json()) as CodexApprovalList;
		expect(list.approvals[0]?.outcome).toBe("declined");
	});

	test("5. a manage key's accept is 403 human_required", async () => {
		const sessionId = await fork();
		const approvalId = await openCard(sessionId);
		const res = await app.request(`${approvalsPath(sessionId)}/${approvalId}/decision`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${manageKey}`,
				"Content-Type": "application/json",
				Origin: ORIGIN,
			},
			body: JSON.stringify({ decision: "accept", presentationHash: "x".repeat(64) }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("human_required");
	});

	describe("6. what the server refuses, so the host declines", () => {
		test("a report naming a server that isn't applied is invalid_body, and no row is written", async () => {
			const sessionId = await fork();
			const { body } = hostReport(sessionId);
			const stranger = {
				...body,
				tool: "mcp__other__echo_note",
				mcp: { server: "other", tool: "echo_note", rawToolName: "mcp__other__echo_note" },
			};
			const res = await post(reportPath(sessionId), host, stranger);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
			expect(
				await getDb().select().from(codexApprovals).where(eq(codexApprovals.sessionId, sessionId)),
			).toEqual([]);
		});

		test("a session started with no MCP servers refuses an MCP report", async () => {
			const sessionId = await fork(null);
			const { body } = hostReport(sessionId);
			const res = await post(reportPath(sessionId), host, body);
			expect(res.status).toBe(400);
		});

		test("a 65-character wire name is invalid_body", async () => {
			const sessionId = await fork();
			const { body } = hostReport(sessionId);
			const tool = "t".repeat(65 - "mcp__probe__".length);
			const raw = `mcp__probe__${tool}`;
			expect(raw.length).toBe(65);
			const res = await post(reportPath(sessionId), host, {
				...body,
				tool: raw,
				mcp: { server: "probe", tool, rawToolName: raw },
			});
			expect(res.status).toBe(400);
		});

		test("an mcp field that disagrees with the server's own split is invalid_body", async () => {
			const sessionId = await fork();
			const { body } = hostReport(sessionId);
			const res = await post(reportPath(sessionId), host, {
				...body,
				mcp: { server: "pro", tool: "be__echo_note", rawToolName: "mcp__probe__echo_note" },
			});
			expect(res.status).toBe(400);
		});

		test("an input that isn't a JSON object is invalid_body", async () => {
			const sessionId = await fork();
			const { body } = hostReport(sessionId);
			for (const target of ['["a"]', "not json", "42", "null"]) {
				const res = await post(reportPath(sessionId), host, { ...body, target });
				expect(res.status, target).toBe(400);
			}
		});

		test("an MCP report on a Codex session is refused", async () => {
			const sessionId = `t121-codex-${crypto.randomUUID().slice(0, 6)}`;
			sessionsUsed.push(sessionId);
			await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
			const { body } = hostReport(sessionId);
			const res = await post(reportPath(sessionId), host, body);
			expect(res.status).toBe(400);
		});
	});

	describe("7. team mode: only the consenting host owner accepts an MCP card (review H1)", () => {
		async function teamFork() {
			const { setStoredMode, clearInstanceSettings } = await import(
				"../test-utils/team-fixtures.js"
			);
			await setStoredMode("team");
			const consenter = await seedLocalUser("t121-consenter", "admin");
			const member = await seedLocalUser("t121-member");
			const sessionId = await fork();
			await getDb()
				.update(sessions)
				.set({
					ownerUserId: member.id,
					metadata: {
						forkedFromSessionId: "src-1",
						forkPermissionBranch: "ask",
						forkOptions: APPLIED,
						forkOptionsConsentUserId: consenter.id,
					},
				})
				.where(eq(sessions.sessionId, sessionId));
			const approvalId = await openCard(sessionId);
			const asUser = async (id: string) => {
				const headers = await cookieHeadersFor(id);
				headers.set("Origin", ORIGIN);
				headers.set("Content-Type", "application/json");
				return headers;
			};
			const detail = (await (
				await app.request(`${approvalsPath(sessionId)}/${approvalId}`, {
					headers: await asUser(member.id),
				})
			).json()) as CodexApprovalDetail;
			const decide = async (id: string, body: object) =>
				app.request(`${approvalsPath(sessionId)}/${approvalId}/decision`, {
					method: "POST",
					headers: await asUser(id),
					body: JSON.stringify(body),
				});
			return { consenter, member, detail, decide, clear: clearInstanceSettings };
		}

		test("the member who owns the fork can't accept the card; a decline is allowed; the consenter can accept", async () => {
			const t = await teamFork();
			try {
				const hash = t.detail.approval.presentationHash;
				const refused = await t.decide(t.member.id, { decision: "accept", presentationHash: hash });
				expect(refused.status).toBe(403);
				expect(((await refused.json()) as { error: string }).error).toBe(
					"fork_options_host_not_yours",
				);
				// Nothing was recorded by the refused accept: the consenter's accept still finds it pending.
				const ok = await t.decide(t.consenter.id, { decision: "accept", presentationHash: hash });
				expect(ok.status).toBe(200);
			} finally {
				await t.clear();
			}
		});

		test("a decline by the member still works (declining is always safe)", async () => {
			const t = await teamFork();
			try {
				const declined = await t.decide(t.member.id, { decision: "decline" });
				expect(declined.status).toBe(200);
			} finally {
				await t.clear();
			}
		});
	});

	test("the opened-event words name no server and no tool", async () => {
		const { openedWords } = await import("./codex-approvals.js");
		expect(
			openedWords({ requestKind: "claude_tool", fileCount: 0, agent: "claude", tool: "mcp" }),
		).toBe("Claude asks to use an MCP tool");
	});
});
