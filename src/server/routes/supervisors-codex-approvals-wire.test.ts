/**
 * Codex approvals, phase 5: the supervisor wire (D17, messages 4 and 5). The request bodies are what the
 * supervisor's own builders and gate produce; the responses are what the real routes return. Every one is
 * compared with a committed fixture by exact, recursive key sets (volatile values masked), so a field added
 * on either side without the other shows up here, and nothing persistence-only reaches the host.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import {
	buildReportBody,
	parseApprovalParams,
} from "../../supervisor/providers/codex-approval-params.js";
import { createReportGate } from "../../supervisor/services/report-gate.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { codexApprovals } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");

const FIXTURES = join(import.meta.dir, "__fixtures__/codex-approvals");
const originalDisableAuth = config.disableAuth;
const fixture = (name: string) =>
	JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as unknown;

let manageKey: string;
let host: { id: string; token: string };
const sessionsUsed: string[] = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("p5-wire-manage", ["manage"])).key;
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name: "p5-wire-host" }),
	});
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "p5-wire-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken,
			capabilities: {
				version: 1,
				agentTypes: ["codex_cli"],
				launchModes: ["managed_codex"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: ["/tmp"],
		}),
	});
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	host = { id: body.supervisor.id, token: body.supervisorCredential };
});

afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
	await deleteAllSupervisors();
});

/** Replaces the values that differ per run with a name, keeps every key and every stable value. */
function mask(value: unknown, names: Record<string, string>, key?: string): unknown {
	if (Array.isArray(value)) return value.map((v) => mask(v, names));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mask(v, names, k)]),
		);
	}
	if (typeof value === "string" && value in names) return names[value];
	if (key === "expiresInMs" && typeof value === "number") return "<ms>";
	return value;
}

const agent = () => ({
	"Content-Type": "application/json",
	"X-AgentPulse-Supervisor-Token": host.token,
});

async function newSession() {
	const sessionId = `p5-wire-${crypto.randomUUID().slice(0, 8)}`;
	sessionsUsed.push(sessionId);
	await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
	return sessionId;
}

describe("what the supervisor builds", () => {
	test("a command report equals the committed fixture, key for key", () => {
		const parsed = parseApprovalParams("item/commandExecution/requestApproval", {
			kind: "command",
			threadId: "thr-1",
			turnId: "turn-1",
			itemId: "item-7",
			startedAtMs: 1,
			environmentId: "local",
			reason: "run the unit tests",
			command: "npm test",
			cwd: "/work/project",
			availableDecisions: ["accept", "cancel"],
		});
		expect(parsed).not.toBeNull();
		const body = buildReportBody({
			runtimeEpoch: "epoch-1",
			rpcId: "7",
			parsed: parsed as NonNullable<typeof parsed>,
			fallbackCwd: null,
			changes: null,
			ageMs: 0,
			revision: 1,
		});
		expect(mask(body, { "epoch-1": "<epoch>" })).toEqual(
			fixture("supervisor-report-request-command"),
		);
	});

	test("a file-change report equals the committed fixture, key for key", () => {
		const parsed = parseApprovalParams("item/fileChange/requestApproval", {
			threadId: "thr-1",
			turnId: "turn-1",
			itemId: "fc-8",
			startedAtMs: 1,
			reason: null,
			grantRoot: null,
		});
		const body = buildReportBody({
			runtimeEpoch: "epoch-1",
			rpcId: "8",
			parsed: parsed as NonNullable<typeof parsed>,
			fallbackCwd: "/work/project",
			changes: [
				{ path: "/work/project/a.txt", kind: "add", movePath: null, diff: "hello\n" },
				{
					path: "/work/project/b.txt",
					kind: "update",
					movePath: "/work/project/c.txt",
					diff: "@@ -1 +1 @@\n-a\n+b\n",
				},
			],
			ageMs: 0,
			revision: 2,
		});
		expect(mask(body, { "epoch-1": "<epoch>" })).toEqual(
			fixture("supervisor-report-request-file-change"),
		);
	});

	test("the server accepts exactly what the builder produces, for both kinds", async () => {
		const sessionId = await newSession();
		for (const name of [
			"supervisor-report-request-command",
			"supervisor-report-request-file-change",
		]) {
			const body = {
				...(fixture(name) as Record<string, unknown>),
				runtimeEpoch: `epoch-${name}`,
			};
			const res = await app.request(
				`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`,
				{ method: "POST", headers: agent(), body: JSON.stringify(body) },
			);
			expect(res.status, name).toBe(201);
		}
	});
});

describe("what the server answers", () => {
	test("the report response equals the fixture, and carries no persistence-only field", async () => {
		const sessionId = await newSession();
		const res = await app.request(
			`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`,
			{ method: "POST", headers: agent(), body: JSON.stringify(harness.commandReport()) },
		);
		const json = (await res.json()) as { approvalId: string };
		expect(mask(json, { [json.approvalId]: "<approvalId>" })).toEqual(
			fixture("supervisor-report-response"),
		);
	});

	test("a poll through the real gate, and the real answer, equal the fixtures", async () => {
		const sessionId = await newSession();
		const open = async (rpcId: string) => {
			const res = await app.request(
				`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`,
				{
					method: "POST",
					headers: agent(),
					body: JSON.stringify(harness.commandReport({ rpcId, itemId: `i-${rpcId}` })),
				},
			);
			return ((await res.json()) as { approvalId: string }).approvalId;
		};
		const a = await open("1");
		const b = await open("2");
		const unknown = crypto.randomUUID();
		await getDb()
			.update(codexApprovals)
			.set({ status: "answered", decision: "accept", answeredAt: new Date().toISOString() })
			.where(eq(codexApprovals.id, a));

		const sent: unknown[] = [];
		const gate = createReportGate({
			request: async (path, options) => {
				sent.push(JSON.parse(String(options?.body)));
				const res = await app.request(`/api/v1${path}`, {
					method: "POST",
					headers: agent(),
					body: options?.body as string,
				});
				return res.json();
			},
			supervisorId: host.id,
			home: "/nonexistent-home-for-wire-test",
		});
		gate.noteCwd(sessionId, "/work/project");
		const result = await gate.syncApprovals({
			live: [
				{ sessionId, approvalId: a, revision: 1 },
				{ sessionId, approvalId: unknown, revision: 1 },
			],
			resolved: [{ sessionId, approvalId: b, outcome: "respond_sent", sentDecision: "decline" }],
		});

		const names = { [a]: "<approvalId>", [b]: "<other>", [unknown]: "<unknown>" };
		expect(mask(sent[0], names)).toEqual(fixture("supervisor-sync-request"));
		expect(result.outcome).toBe("sent");
		if (result.outcome !== "sent") return;
		expect(mask(result.response, names)).toEqual(fixture("supervisor-sync-response"));
	});

	test("a request of an unknown version is 400 invalid_body on both routes", async () => {
		const sessionId = await newSession();
		const report = await app.request(
			`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`,
			{
				method: "POST",
				headers: agent(),
				body: JSON.stringify(harness.commandReport({ v: 2 as never })),
			},
		);
		const sync = await app.request(`/api/v1/supervisors/${host.id}/approvals/sync`, {
			method: "POST",
			headers: agent(),
			body: JSON.stringify({ v: 2, live: [], resolved: [] }),
		});
		expect([report.status, sync.status]).toEqual([400, 400]);
		expect(((await report.json()) as { error: string }).error).toBe("invalid_body");
		expect(((await sync.json()) as { error: string }).error).toBe("invalid_body");
	});

	test("nothing a response carries is a persistence-only field", async () => {
		const sessionId = await newSession();
		const res = await app.request(
			`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`,
			{ method: "POST", headers: agent(), body: JSON.stringify(harness.commandReport()) },
		);
		const text = JSON.stringify(await res.json());
		for (const name of [
			"runtimeEpoch",
			"rpcId",
			"threadId",
			"turnId",
			"itemId",
			"firstDeliveredAt",
			"fencedAt",
			"sessionId",
		]) {
			expect(text).not.toContain(name);
		}
		const sync = await app.request(`/api/v1/supervisors/${host.id}/approvals/sync`, {
			method: "POST",
			headers: agent(),
			body: JSON.stringify({ v: 1, live: [], resolved: [] }),
		});
		expect(Object.keys((await sync.json()) as object).sort()).toEqual([
			"ack",
			"answers",
			"closed",
			"v",
		]);
	});
});
