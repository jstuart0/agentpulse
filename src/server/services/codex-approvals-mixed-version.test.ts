/**
 * Codex approvals, phase 5: every pairing of an old and a new server with an old and a new supervisor
 * (AGEN-87, D14). The new server only adds; the new supervisor never relies on a thing an old server can't
 * say; an old supervisor is neither helped nor harmed. Real enrollment over the real app; the supervisor's
 * own tracker and gate for the new side; an old supervisor is a client that reads only what the base
 * contract had.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import {
	type ApprovalGatePort,
	createCodexApprovalTracker,
} from "../../supervisor/providers/codex-approvals.js";
import { RpcClient } from "../../supervisor/providers/codex-rpc.js";
import { SupervisorRequestError } from "../../supervisor/services/report-resilience.js";
import { deleteAllSupervisors } from "./__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const { codexApprovals, managedSessions, supervisors } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");

const originalDisableAuth = config.disableAuth;
let manageKey: string;
const sessionsUsed: string[] = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("p5-mixed-manage", ["manage"])).key;
});
afterEach(async () => {
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
});
afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await deleteAllSupervisors();
});

async function enroll(name: string) {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` },
		body: JSON.stringify({ name }),
	});
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: name,
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
	const body = (await registered.json()) as Record<string, unknown> & {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential, body };
}

const agent = (token: string) => ({
	"Content-Type": "application/json",
	"X-AgentPulse-Supervisor-Token": token,
});

describe("a new server and an old supervisor", () => {
	test("what an old supervisor reads is all still there; serverFeatures is one more key it never looks at", async () => {
		const host = await enroll("p5-old-supervisor");
		// The base contract: register answered { supervisor, heartbeatIntervalMs, supervisorCredential }, heartbeat { supervisor }.
		for (const key of ["supervisor", "heartbeatIntervalMs", "supervisorCredential"]) {
			expect(Object.keys(host.body), key).toContain(key);
		}
		const beat = await app.request(`/api/v1/supervisors/${host.id}/heartbeat`, {
			method: "POST",
			headers: agent(host.token),
		});
		expect(Object.keys((await beat.json()) as object)).toContain("supervisor");
		expect(Object.keys(host.body).sort()).toEqual(
			["heartbeatIntervalMs", "serverFeatures", "supervisor", "supervisorCredential"].sort(),
		);
	});

	test("it never reports an approval, so no card exists, its snapshot has no verdict key, and Stop to a gone host still refuses", async () => {
		const host = await enroll("p5-old-supervisor-2");
		const sessionId = `p5-old-${crypto.randomUUID().slice(0, 6)}`;
		sessionsUsed.push(sessionId);
		await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
		await getDb()
			.update(managedSessions)
			.set({ providerCapabilitySnapshot: { protocolVersion: "x", userAgent: "old/1.0" } })
			.where(eq(managedSessions.sessionId, sessionId));

		const list = await app.request(`/api/v1/sessions/${sessionId}/approvals`, {
			headers: { Authorization: `Bearer ${manageKey}` },
		});
		expect(list.status).toBe(200);
		expect(((await list.json()) as { approvals: unknown[] }).approvals).toEqual([]);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(Object.keys(managed.providerCapabilitySnapshot as object)).not.toContain(
			"agentpulseApprovals",
		);

		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
			.where(eq(supervisors.id, host.id));
		const stop = await app.request(`/api/v1/sessions/${sessionId}/stop`, {
			method: "POST",
			headers: { Authorization: `Bearer ${manageKey}`, "Content-Type": "application/json" },
		});
		expect(stop.status).toBe(409);
		expect(((await stop.json()) as { error: string }).error).toBe("host_offline");
		expect(
			await getDb().select().from(codexApprovals).where(eq(codexApprovals.sessionId, sessionId)),
		).toEqual([]);
	});
});

describe("a new supervisor and an old server", () => {
	function memoryClient() {
		const written: any[] = [];
		const client = new RpcClient({ write: (f) => written.push(JSON.parse(f)), close: () => {} });
		return {
			client,
			written,
			feed: (frame: unknown) => client.receive(`${JSON.stringify(frame)}\n`),
		};
	}
	const COMMAND = "item/commandExecution/requestApproval";
	const params = {
		kind: "command",
		threadId: "t",
		turnId: "u",
		itemId: "i",
		command: "ls",
		cwd: "/work",
		availableDecisions: ["accept"],
	};

	function trackerAgainst(answer: (path: string) => Error) {
		const calls: string[] = [];
		const gate: ApprovalGatePort = {
			verdict: () => "send",
			excludesPath: () => false,
			isOffline: () => false,
			reportApproval: async () => {
				calls.push("report");
				throw answer("report");
			},
			syncApprovals: async () => {
				calls.push("sync");
				throw answer("sync");
			},
		};
		const tracker = createCodexApprovalTracker({ gate });
		const mem = memoryClient();
		const handle = tracker.attachClient(mem.client, { sessionId: "s", warn: async () => {} });
		tracker.setVerdict(handle, { verdict: "supported", reason: "ok" });
		return { tracker, calls, ...mem };
	}

	test("no serverFeatures in the answer (an old server): every request is declined at once, and the approval routes are never called, whatever they would answer", async () => {
		for (const status of [401, 403, 404]) {
			const { tracker, calls, written, feed } = trackerAgainst(
				() => new SupervisorRequestError(status, "x"),
			);
			tracker.setServerFeatures(undefined);
			feed({ id: 0, method: COMMAND, params });
			await Bun.sleep(5);
			await tracker.tick();
			expect(written, String(status)).toEqual([{ id: 0, result: { decision: "decline" } }]);
			expect(calls, String(status)).toEqual([]);
		}
	});

	test("an old server that does answer the paths (a 404 after a rollback): decline, and nothing more is tried until a heartbeat says otherwise", async () => {
		const { tracker, calls, written, feed } = trackerAgainst(
			() => new SupervisorRequestError(404, "Not Found"),
		);
		tracker.setServerFeatures(["codex_approvals"]);
		feed({ id: 0, method: COMMAND, params });
		await Bun.sleep(5);
		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(calls).toEqual(["report"]);
		feed({ id: 1, method: COMMAND, params });
		await Bun.sleep(5);
		expect(calls).toEqual(["report"]);
	});

	test("a server that advertised the feature and then stops (a rollback while running) puts the next heartbeat's silence at decline", async () => {
		const { tracker, calls, written, feed } = trackerAgainst(() => new Error("not reached"));
		tracker.setServerFeatures(["codex_approvals"]);
		feed({ id: 0, method: COMMAND, params });
		await Bun.sleep(5);
		expect(calls).toEqual(["report"]);
		tracker.setServerFeatures(undefined);
		expect(written.at(-1)).toEqual({ id: 0, result: { decision: "decline" } });
		feed({ id: 1, method: COMMAND, params });
		await Bun.sleep(5);
		expect(written.at(-1)).toEqual({ id: 1, result: { decision: "decline" } });
		expect(calls).toEqual(["report"]);
	});

	test("a failed heartbeat leaves the last known value alone: the supervisor sets features only on a success (behaviour: codex-approvals-wiring.test.ts)", () => {
		const source = readFileSync(join(import.meta.dir, "../../supervisor/index.ts"), "utf8");
		const call = source.indexOf("approvalsWiring.applyHeartbeat(");
		// The heartbeat request is made inside the call that applies its features on success.
		const request = source.indexOf("`/supervisors/${registration.supervisor.id}/heartbeat`", call);
		const catchAt = source.indexOf("} catch (error) {", call);
		expect(call).toBeGreaterThan(0);
		expect(request).toBeGreaterThan(call);
		expect(catchAt).toBeGreaterThan(request);
		// ... and nothing in the failure branch touches it.
		const failure = source.slice(catchAt, source.indexOf("} finally {", catchAt));
		expect(failure).not.toContain("setServerFeatures");
		expect(failure).not.toContain("applyHeartbeat");
	});

	test("a rolled-back server leaves the tables and rows as they were, and a supervisor that declines changes none of them", async () => {
		const host = await enroll("p5-rolled-back");
		const sessionId = `p5-rb-${crypto.randomUUID().slice(0, 6)}`;
		sessionsUsed.push(sessionId);
		await harness.seedApprovalSession({ sessionId, supervisorId: host.id });
		const res = await app.request(
			`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/approvals`,
			{ method: "POST", headers: agent(host.token), body: JSON.stringify(harness.commandReport()) },
		);
		expect(res.status).toBe(201);
		const before = await harness.approvalRows(sessionId);

		const { tracker, written, feed } = trackerAgainst(() => new Error("never reached"));
		tracker.setServerFeatures(undefined);
		feed({ id: 0, method: COMMAND, params });
		await Bun.sleep(5);

		expect(written).toEqual([{ id: 0, result: { decision: "decline" } }]);
		expect(await harness.approvalRows(sessionId)).toEqual(before);
	});
});

describe("a new supervisor and a Codex with no stdio transport", () => {
	test("the launch fails at once with a clear error and no listener is tried as a fallback", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { installFakeCodex, readFakeLog } = await import(
			"../../supervisor/providers/__fixtures__/fake-codex.js"
		);
		const { launchManagedCodexRequest } = await import(
			"../../supervisor/providers/codex-managed.js"
		);
		const home = mkdtempSync(join(tmpdir(), "ap-no-stdio-"));
		const keys = [
			"HOME",
			"AGENTPULSE_CODEX_COMMAND",
			"AGENTPULSE_SUPERVISOR_DRY_RUN",
			"FAKE_CODEX_LOG",
			"FAKE_CODEX_EARLY_EXIT",
		];
		const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		try {
			process.env.HOME = home;
			process.env.AGENTPULSE_CODEX_COMMAND = installFakeCodex(home);
			process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
			process.env.FAKE_CODEX_LOG = join(home, "fake.log");
			process.env.FAKE_CODEX_EARLY_EXIT = "2";
			const started = Date.now();
			await expect(
				launchManagedCodexRequest(
					{
						id: "l-1",
						launchCorrelationId: "c-1",
						agentType: "codex_cli",
						cwd: home,
						baseInstructions: "",
						taskPrompt: "x",
						approvalPolicy: null,
						sandboxMode: null,
						env: {},
						launchSpec: {},
					} as never,
					{
						reportState: async () => ({ session: {}, managedSession: {} }) as never,
						reportEvents: async () => "sent" as const,
					},
				),
			).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(15_000);
			const argvs = readFakeLog(join(home, "fake.log")).filter((e) => e.argv);
			expect(argvs.length).toBeGreaterThan(0);
			expect(argvs.every((e) => JSON.stringify(e.argv) === JSON.stringify(["app-server"]))).toBe(
				true,
			);
		} finally {
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
			rmSync(home, { recursive: true, force: true });
		}
	});
});
