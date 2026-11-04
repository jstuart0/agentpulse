/**
 * Codex approvals, phase 5: nothing the agent wrote leaves the approval row (AGEN-87, D7, D8). A unique
 * command (with a secret in it) goes through a whole life on the real routes - reported by the host, listed
 * and read by the person, answered, reported on, closed - and then every place something is written or
 * sent is scanned: the event rows and their raw payloads, the push the session's wait raised, the
 * frames a socket subscribed to the session would get, the audit table, the captured logs, and the
 * approval row itself. Two lives run: a decline with auth off, and an accept with auth on (a signed-in
 * person and a host credential).
 *
 * The command text appears only in the one place a person reads it (the list preview and the detail);
 * the raw secret appears nowhere at all, the row included. Each scan first proves it saw something: an
 * empty list of frames or pushes would pass for the wrong reason.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const schema = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { handleWsOpen, handleWsClose, handleWsMessage, initWsBroadcaster } = await import(
	"../ws/handler.js"
);
const { sessionBus } = await import("../services/notifier.js");
const { configurePushRuntime, _resetDispatchForTest } = await import(
	"../services/push/dispatch.js"
);
const { _resetApprovalWaitRepairForTest } = await import("../services/codex-approvals.js");
const { createApiKey } = await import("../auth/api-key.js");
const fixtures = await import("../test-utils/team-fixtures.js");
const { deleteAllSupervisors } = await import("../services/__test_supervisors.js");

const originalDisableAuth = config.disableAuth;
const sessionsUsed: string[] = [];
const ORIGIN = "http://localhost:3000";

beforeAll(() => initializeDatabase());
afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
	_resetApprovalWaitRepairForTest();
	_resetDispatchForTest();
});
afterAll(async () => {
	configurePushRuntime(null);
	await deleteAllSupervisors();
});

/** Who calls: auth off (everyone is the local person), or auth on with a signed-in person and a host credential. */
type Caller = {
	supervisorId: string;
	agentHeaders: Record<string, string>;
	personHeaders: () => Promise<Headers>;
};

async function authOffCaller(unique: string): Promise<Caller> {
	(config as Record<string, unknown>).disableAuth = true;
	return {
		supervisorId: `leak-host-${unique}`,
		agentHeaders: { "Content-Type": "application/json" },
		personHeaders: async () =>
			new Headers({ "Content-Type": "application/json", Host: "localhost:3000", Origin: ORIGIN }),
	};
}

async function authOnCaller(): Promise<Caller> {
	(config as Record<string, unknown>).disableAuth = false;
	const manage = await createApiKey("leak-manage", ["manage"]);
	const name = `leak-host-${crypto.randomUUID().slice(0, 6)}`;
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manage.key}` },
		body: JSON.stringify({ name }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			hostName: name,
			enrollmentToken,
			capabilities: {
				version: 1,
				agentTypes: ["codex_cli"],
				launchModes: ["managed_codex"],
				os: "linux",
				terminalSupport: [],
				features: [],
				executables: { codex: { available: true, command: "codex", resolvedPath: "/bin/codex" } },
			},
			trustedRoots: ["/tmp"],
		}),
	});
	expect(registered.status).toBe(200);
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	const person = await fixtures.seedLocalUser(`leak-person-${name}`, "admin");
	return {
		supervisorId: body.supervisor.id,
		agentHeaders: {
			"Content-Type": "application/json",
			"X-AgentPulse-Supervisor-Token": body.supervisorCredential,
		},
		personHeaders: async () => {
			const headers = await fixtures.cookieHeadersFor(person.id);
			headers.set("Origin", ORIGIN);
			headers.set("Content-Type", "application/json");
			return headers;
		},
	};
}

async function lifeOfACommand(life: { auth: "off" | "on"; decision: "decline" | "accept" }) {
	const unique = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
	const secret = `AKIA${"Q7".repeat(8)}`;
	// A command or reason the redactor had to change is decline-only, so the life that accepts carries no secret;
	// it still has to leave nothing behind but the row.
	const withSecret = life.decision === "decline";
	const command = withSecret
		? `curl-LEAKCMD-${unique} --header 'x-key: ${secret}'`
		: `curl-LEAKCMD-${unique} https://example.invalid/ok`;
	const reasonText = withSecret
		? `LEAKREASON-${unique} paste this token ${secret}`
		: `LEAKREASON-${unique} needs the network`;
	const sessionId = `leak-${unique}`;
	const caller = life.auth === "off" ? await authOffCaller(unique) : await authOnCaller();
	const { supervisorId } = caller;
	sessionsUsed.push(sessionId);
	await harness.seedApprovalSession({ sessionId, supervisorId });

	const pushes: string[] = [];
	configurePushRuntime({
		targets: {
			resolve: async (event: unknown) => {
				pushes.push(JSON.stringify(event));
				return [];
			},
		},
		service: {
			sendToDevices: async (...args: unknown[]) => void pushes.push(JSON.stringify(args)),
		},
		logger: { info: () => undefined, warn: () => undefined },
	} as never);
	// The bus is observed and still delivers, so the socket broadcaster (the one a server runs) really sends.
	initWsBroadcaster(sessionBus);
	const bus: string[] = [];
	const emit = sessionBus.emit.bind(sessionBus) as (...args: unknown[]) => boolean;
	const busSpy = spyOn(sessionBus, "emit").mockImplementation(((...args: unknown[]) => {
		bus.push(JSON.stringify(args));
		return emit(...args);
	}) as never);
	const frames: string[] = [];
	const ws = { send: (raw: string) => frames.push(raw) } as unknown as ServerWebSocket<unknown>;
	await handleWsOpen(ws);
	await handleWsMessage(
		ws,
		JSON.stringify({ type: "subscribe", channels: [`session:${sessionId}`] }),
	);
	const logs: string[] = [];
	const spies = (["log", "info", "warn", "error"] as const).map((level) =>
		spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
		}),
	);

	try {
		const reported = await app.request(
			`/api/v1/supervisors/${supervisorId}/managed-sessions/${sessionId}/approvals`,
			{
				method: "POST",
				headers: caller.agentHeaders,
				body: JSON.stringify(
					harness.commandReport({ command, reason: reasonText, itemId: `item-${unique}` }),
				),
			},
		);
		expect(reported.status).toBe(201);
		const { approvalId } = (await reported.json()) as { approvalId: string };

		const list = await app.request(`/api/v1/sessions/${sessionId}/approvals`, {
			headers: await caller.personHeaders(),
		});
		const detail = await app.request(`/api/v1/sessions/${sessionId}/approvals/${approvalId}`, {
			headers: await caller.personHeaders(),
		});
		expect(list.status).toBe(200);
		expect(detail.status).toBe(200);
		const listText = await list.text();
		const personText = listText + (await detail.text());
		// The redacted text is what the person gets to read; the secret is not in it.
		expect(personText).not.toContain(secret);
		const presentationHash = (
			JSON.parse(listText) as { approvals: Array<{ presentationHash: string }> }
		).approvals[0].presentationHash;

		const decided = await app.request(
			`/api/v1/sessions/${sessionId}/approvals/${approvalId}/decision`,
			{
				method: "POST",
				headers: await caller.personHeaders(),
				body: JSON.stringify({
					decision: life.decision,
					...(life.decision === "accept" ? { presentationHash } : {}),
				}),
			},
		);
		expect(decided.status, await decided.clone().text()).toBe(200);
		const synced = await app.request(`/api/v1/supervisors/${supervisorId}/approvals/sync`, {
			method: "POST",
			headers: caller.agentHeaders,
			body: JSON.stringify({
				v: 1,
				live: [{ approvalId, revision: 1 }],
				resolved: [
					{ approvalId, outcome: "respond_sent", sentDecision: life.decision },
					{ approvalId, outcome: "resolved_after_response", sentDecision: life.decision },
				],
			}),
		});
		expect(synced.status).toBe(200);
		expect(await synced.text()).not.toContain(command);
		await new Promise((r) => setTimeout(r, 50));

		const rows = await getDb()
			.select()
			.from(schema.codexApprovals)
			.where(eq(schema.codexApprovals.sessionId, sessionId));
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("closed");
		const eventRows = await getDb()
			.select()
			.from(schema.events)
			.where(eq(schema.events.sessionId, sessionId));
		expect(eventRows.length).toBeGreaterThanOrEqual(2);
		const auditRows = await harness.auditRows(sessionId);
		expect(auditRows.length).toBeGreaterThanOrEqual(1);

		// The scans below saw something to scan: a socket subscribed to the session got frames about it, the
		// push runtime was asked, and the bus carried the events.
		expect(frames.length).toBeGreaterThan(0);
		expect(frames.some((frame) => frame.includes(sessionId))).toBe(true);
		expect(pushes.length).toBeGreaterThan(0);
		expect(bus.length).toBeGreaterThan(0);
		expect(logs.length).toBeGreaterThan(0);

		const everywhere = {
			"event rows": JSON.stringify(eventRows),
			pushes: pushes.join("\n"),
			"bus emissions": bus.join("\n"),
			"socket frames": frames.join("\n"),
			"audit table": JSON.stringify(auditRows),
			logs: logs.join("\n"),
			"approval row": JSON.stringify(rows),
		};
		for (const [where, text] of Object.entries(everywhere)) {
			expect(text, `${where} holds the command`).not.toContain(`LEAKCMD-${unique}`);
			expect(text, `${where} holds the reason`).not.toContain(`LEAKREASON-${unique}`);
			expect(text, `${where} holds the secret`).not.toContain(secret);
			expect(text, `${where} holds the secret's body`).not.toContain("Q7Q7Q7Q7");
		}
		// ... and the closed row kept its hash, not its text.
		expect(rows[0].presentation).toBeNull();
		expect(rows[0].reasonText).toBeNull();
		expect(rows[0].presentationHash).toMatch(/^[0-9a-f]{64}$/);
		expect(rows[0].decision).toBe(life.decision);
		expect(eventRows.some((e) => e.eventType === "PermissionRequest")).toBe(true);
		expect(eventRows.some((e) => e.eventType === "ManagedApprovalResolved")).toBe(true);
	} finally {
		for (const spy of spies) spy.mockRestore();
		busSpy.mockRestore();
		handleWsClose(ws);
	}
}

describe("a command and its secret", () => {
	test("declined with auth off: the command is read in one place, the secret is in none, and no event, push, frame, audit row or log carries either", async () => {
		await lifeOfACommand({ auth: "off", decision: "decline" });
	});

	test("accepted with auth on (a signed-in person, a host credential): the same holds", async () => {
		await lifeOfACommand({ auth: "on", decision: "accept" });
	});
});
