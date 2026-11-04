/**
 * Codex approvals, phase 5: nothing the agent wrote leaves the approval row (AGEN-87, D7, D8). A unique
 * command (with a secret in it) goes through a whole life on the real routes - reported by the host, listed
 * and read by the person, declined, reported on, closed - and then every place something is written or
 * sent is scanned: the event rows and their raw payloads, the push the session's wait raised, the
 * frames a socket would get, the audit table, the captured logs, and the approval row itself.
 *
 * The command text appears only in the one place a person reads it (the list preview and the detail);
 * the raw secret appears nowhere at all, the row included.
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
const { handleWsOpen, handleWsClose } = await import("../ws/handler.js");
const { sessionBus } = await import("../services/notifier.js");
const { configurePushRuntime, _resetDispatchForTest } = await import(
	"../services/push/dispatch.js"
);
const { _resetApprovalWaitRepairForTest } = await import("../services/codex-approvals.js");

const originalDisableAuth = config.disableAuth;
const sessionsUsed: string[] = [];

beforeAll(() => initializeDatabase());
afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(sessionsUsed.splice(0));
	_resetApprovalWaitRepairForTest();
	_resetDispatchForTest();
});
afterAll(() => configurePushRuntime(null));

describe("a command and its secret", () => {
	test("the command is read in one place, the secret is in none, and no event, push, frame, audit row or log carries either", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const unique = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
		const command = `curl-LEAKCMD-${unique} --header 'x-key: AKIA${"Q7".repeat(8)}'`;
		const secret = `AKIA${"Q7".repeat(8)}`;
		const reasonText = `LEAKREASON-${unique} paste this token ${secret}`;
		const sessionId = `leak-${unique}`;
		const supervisorId = `leak-host-${unique}`;
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
		const bus: string[] = [];
		const busSpy = spyOn(sessionBus, "emit").mockImplementation(((...args: unknown[]) => {
			bus.push(JSON.stringify(args));
			return true;
		}) as never);
		const frames: string[] = [];
		const ws = { send: (raw: string) => frames.push(raw) } as unknown as ServerWebSocket<unknown>;
		await handleWsOpen(ws);
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
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						harness.commandReport({ command, reason: reasonText, itemId: `item-${unique}` }),
					),
				},
			);
			expect(reported.status).toBe(201);
			const { approvalId } = (await reported.json()) as { approvalId: string };

			const list = await app.request(`/api/v1/sessions/${sessionId}/approvals`);
			const detail = await app.request(`/api/v1/sessions/${sessionId}/approvals/${approvalId}`);
			expect(list.status).toBe(200);
			expect(detail.status).toBe(200);
			const personText = (await list.text()) + (await detail.text());
			// The redacted text is what the person gets to read; the secret is not in it.
			expect(personText).not.toContain(secret);

			const declined = await app.request(
				`/api/v1/sessions/${sessionId}/approvals/${approvalId}/decision`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Host: "localhost:3000",
						Origin: "http://localhost:3000",
					},
					body: JSON.stringify({ decision: "decline" }),
				},
			);
			expect(declined.status).toBe(200);
			const synced = await app.request(`/api/v1/supervisors/${supervisorId}/approvals/sync`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					v: 1,
					live: [{ approvalId, revision: 1 }],
					resolved: [
						{ approvalId, outcome: "respond_sent", sentDecision: "decline" },
						{ approvalId, outcome: "resolved_after_response", sentDecision: "decline" },
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
			// ... and the scan saw something to scan: the events exist, the closed row kept its hash, not its text.
			expect(rows[0].presentation).toBeNull();
			expect(rows[0].reasonText).toBeNull();
			expect(rows[0].presentationHash).toMatch(/^[0-9a-f]{64}$/);
			expect(eventRows.some((e) => e.eventType === "PermissionRequest")).toBe(true);
			expect(eventRows.some((e) => e.eventType === "ManagedApprovalResolved")).toBe(true);
		} finally {
			for (const spy of spies) spy.mockRestore();
			busSpy.mockRestore();
			handleWsClose(ws);
		}
	});
});
