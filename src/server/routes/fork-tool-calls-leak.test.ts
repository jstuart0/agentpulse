/**
 * Owner-only tool detail (AGEN-123): what a fork's tool calls ran leaves the detail table in exactly one
 * place, the owner's `GET .../tool-calls/:id`. A sentinel in a call's input and in its output goes through a
 * whole life on the real routes (reported by a host, read by a signed-in person) and then every place
 * something is written, sent or searched is scanned: the session detail and its timeline (full and
 * compact), the lists and stats, search, the frames a socket subscribed to the session gets, the push
 * runtime, the bus, the watcher's context builder fed from the real reads, the event, control-action and
 * session rows, and the captured logs. Each scan first proves it saw something: an empty list of frames
 * or pushes would pass for the wrong reason.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import type { ForkToolCallReport } from "../../shared/fork-tool-calls.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const schema = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const fixtures = await import("../test-utils/team-fixtures.js");
const { createApiKey } = await import("../auth/api-key.js");
const { handleWsOpen, handleWsClose, handleWsMessage, initWsBroadcaster } = await import(
	"../ws/handler.js"
);
const { sessionBus } = await import("../services/notifier.js");
const { configurePushRuntime, _resetDispatchForTest } = await import(
	"../services/push/dispatch.js"
);
const { buildWatcherContext } = await import("../services/ai/context.js");
const { deleteAllSupervisors } = await import("../services/__test_supervisors.js");

const originalDisableAuth = config.disableAuth;
const used: string[] = [];

beforeAll(() => initializeDatabase());
afterEach(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await harness.cleanApprovalFixtures(used.splice(0));
	_resetDispatchForTest();
});
afterAll(async () => {
	configurePushRuntime(null);
	await deleteAllSupervisors();
});

async function enrolledHost() {
	(config as Record<string, unknown>).disableAuth = false;
	const manage = await createApiKey("t123-leak-manage", ["manage"]);
	const name = `t123-leak-host-${crypto.randomUUID().slice(0, 6)}`;
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${manage.key}` },
		body: JSON.stringify({ name }),
	});
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
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
				executables: {},
			},
			trustedRoots: ["/tmp"],
		}),
	});
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

describe("a sentinel in a call's input and output", () => {
	test("is read in one place, the owner's per-call read, and is in no other row, frame, push, log or search", async () => {
		const unique = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
		// Its own random body, so a session id or a tool-use id can't be mistaken for it.
		const body = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
		const sentinel = `LEAKDETAIL-${body}`;
		const host = await enrolledHost();
		const person = await fixtures.seedLocalUser(`t123-leak-person-${unique}`, "admin");
		const headers = await fixtures.cookieHeadersFor(person.id);
		const sessionId = `t123-leak-${unique}`;
		used.push(sessionId);
		await harness.seedApprovalSession({
			sessionId,
			supervisorId: host.id,
			agentType: "claude_code",
		});
		await getDb()
			.update(schema.sessions)
			.set({ metadata: { forkedFromSessionId: "the-original" } })
			.where(eq(schema.sessions.sessionId, sessionId));
		await harness.seedActiveStop(sessionId);

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
			const agent = {
				"Content-Type": "application/json",
				"X-AgentPulse-Supervisor-Token": host.token,
			};
			// The rows a fork writes for the call, as the host reports them (fixed words, a tool-use id).
			const toolUseId = `toolu_${unique}`;
			const reportedRows = await app.request(
				`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/events`,
				{
					method: "POST",
					headers: agent,
					body: JSON.stringify({
						events: [
							{
								eventType: "HeadlessStatus",
								category: "progress_update",
								content: "Bash: ran without asking",
								rawPayload: { source: "claude_stream", kind: "call", tool_use_id: toolUseId },
							},
							{
								eventType: "HeadlessStatus",
								category: "progress_update",
								content:
									"Ran without asking you this turn: Bash (1). Claude treated these as read-only.",
								rawPayload: { source: "claude_stream", kind: "turn_unasked" },
							},
						],
					}),
				},
			);
			expect(reportedRows.status).toBeLessThan(300);

			const call: ForkToolCallReport = {
				toolUseId,
				turnActionId: "act-leak",
				tool: "Bash",
				outcome: "unasked",
				fromSubagent: false,
				input: JSON.stringify({ command: `echo ${sentinel}` }),
				inputTruncated: false,
				output: `${sentinel}\nsecond line`,
				outputTruncated: false,
			};
			const posted = await app.request(
				`/api/v1/supervisors/${host.id}/managed-sessions/${sessionId}/tool-calls`,
				{ method: "POST", headers: agent, body: JSON.stringify({ v: 1, calls: [call] }) },
			);
			expect(posted.status).toBe(201);
			expect(await posted.text()).not.toContain(sentinel);

			// The one place it is read.
			const got = await app.request(`/api/v1/sessions/${sessionId}/tool-calls/${toolUseId}`, {
				headers,
			});
			expect(got.status).toBe(200);
			const gotText = await got.text();
			expect(gotText).toContain(sentinel);
			// The list never carries it when asked for the index.
			const index = await app.request(`/api/v1/sessions/${sessionId}/tool-calls?view=index`, {
				headers,
			});
			const indexText = await index.text();
			expect(indexText).toContain(toolUseId);
			expect(indexText).not.toContain(sentinel);

			// Every other read of the session.
			const reads: Record<string, string> = {};
			for (const [name, path] of Object.entries({
				detail: `/api/v1/sessions/${sessionId}`,
				"detail compact": `/api/v1/sessions/${sessionId}?compact=true&eventsLimit=50`,
				timeline: `/api/v1/sessions/${sessionId}/timeline`,
				"timeline compact": `/api/v1/sessions/${sessionId}/timeline?compact=true`,
				list: "/api/v1/sessions",
				"list card": "/api/v1/sessions?view=card",
				stats: "/api/v1/sessions/stats",
				"control actions": `/api/v1/sessions/${sessionId}/control-actions`,
				"search events": `/api/v1/search?q=${sentinel}`,
				"search sessions": `/api/v1/search?kinds=session&q=${sentinel}`,
				"approvals list": `/api/v1/sessions/${sessionId}/approvals`,
			})) {
				const res = await app.request(path, { headers });
				reads[name] = `${res.status} ${await res.text()}`;
			}
			// Each one answered with something of this session (or, for a search, answered at all).
			for (const name of [
				"detail",
				"detail compact",
				"timeline",
				"timeline compact",
				"control actions",
			]) {
				expect(reads[name], name).toMatch(/^200 /);
			}
			expect(reads.detail).toContain(sessionId);
			expect(reads.timeline).toContain("ran without asking");
			expect(reads.list).toContain(sessionId);
			expect(reads["control actions"]).toContain("stop");
			for (const name of ["search events", "search sessions"])
				expect(reads[name], name).toMatch(/^\d{3} /);

			await new Promise((r) => setTimeout(r, 50));
			const eventRows = await getDb()
				.select()
				.from(schema.events)
				.where(eq(schema.events.sessionId, sessionId));
			const sessionRows = await getDb()
				.select()
				.from(schema.sessions)
				.where(eq(schema.sessions.sessionId, sessionId));
			const actionRows = await getDb()
				.select()
				.from(schema.controlActions)
				.where(eq(schema.controlActions.sessionId, sessionId));
			expect(eventRows.length).toBeGreaterThanOrEqual(2);
			expect(actionRows.length).toBeGreaterThanOrEqual(1);
			expect(frames.some((f) => f.includes(sessionId))).toBe(true);
			expect(bus.length).toBeGreaterThan(0);

			// The watcher's context, fed from the real reads.
			const detailJson = JSON.parse(reads.detail.slice(4)) as { session: never; events: never[] };
			const context = buildWatcherContext({
				session: detailJson.session,
				events: detailJson.events,
				triggerType: "stop" as never,
			});
			expect(context.eventsIncluded).toBeGreaterThan(0);

			const everywhere: Record<string, string> = {
				...reads,
				"event rows": JSON.stringify(eventRows),
				"session row": JSON.stringify(sessionRows),
				"control action rows": JSON.stringify(actionRows),
				pushes: pushes.join("\n"),
				"bus emissions": bus.join("\n"),
				"socket frames": frames.join("\n"),
				// No population claim for the logs: the service logs only when it drops a call, and that line is
				// held to counts by the service test; this scan covers everything else the routes wrote.
				logs: logs.join("\n"),
				"watcher context": `${context.systemPrompt}\n${context.transcriptPrompt}`,
			};
			for (const [where, text] of Object.entries(everywhere)) {
				expect(text, `${where} holds the sentinel`).not.toContain(sentinel);
				expect(text, `${where} holds the sentinel's body`).not.toContain(body);
			}
			// The ciphertext columns hold neither.
			const [raw] = await getDb()
				.select()
				.from(schema.forkToolCalls)
				.where(eq(schema.forkToolCalls.sessionId, sessionId));
			expect(JSON.stringify(raw)).not.toContain(body);
		} finally {
			for (const spy of spies) spy.mockRestore();
			busSpy.mockRestore();
			handleWsClose(ws);
		}
	});
});
