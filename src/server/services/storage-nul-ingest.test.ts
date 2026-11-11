/**
 * AGEN-39: text holding U+0000 or a lone surrogate is stored, the same way, on both dialects.
 * Postgres refuses the first in a `text` value and the second in a `json` value, and can't read
 * any key of a `json` value holding a `\u0000` escape. Every case drives a real writer end to end
 * and asserts the exact stored text: NUL is `␀`, a lone surrogate is U+FFFD, and no stored string
 * or key holds either raw. Run it with AGENTPULSE_TEST_BACKEND=postgres for the Postgres half.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { isPostgresTest } from "../test-utils/backend.js";

const { eq, sql } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { executeRows, jsonExtractText } = await import("../db/sql-helpers.js");
const {
	askMessages,
	askThreads,
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
} = await import("../db/schema/index.js");
const { processHookEvent, processStatusUpdate, insertNormalizedEvents } = await import(
	"./event-processor.js"
);
const { _resetEventDedupForTest, getEventsDeduplicatedCounts } = await import("./event-dedup.js");
const { appendManagedSessionDelivery, appendManagedSessionEvents, upsertManagedSessionState } =
	await import("./managed-session-state.js");
const { getIngestRedactionCounters, prepareHookPayloadForStorage } = await import(
	"./ingest-redaction.js"
);
const { supervisorsAgentRouter } = await import("../routes/supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { deleteAllSupervisors } = await import("./__test_supervisors.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { buildPresentation, buildPreview } = await import("./codex-approval-presentation.js");
const { commandReport } = await import("../test-utils/codex-approvals-harness.js");
const { appendMessage, findOrCreateTelegramThread } = await import("./ask/ask-service.js");

import type { HookEventPayload } from "../../shared/types.js";
import type { HookDeliveryContext } from "./event-dedup.js";

const NUL = "\u0000";
const MARK = "␀";
const LONE = "\ud800";
const FFFD = "�";

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});
afterAll(async () => {
	await deleteAllSupervisors();
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

const sid = (p: string) => `${p}-${crypto.randomUUID()}`;
const CTX: HookDeliveryContext = { keyId: "anonymous", deliveryId: null, origin: "native" };

function post(
	sessionId: string,
	payload: Partial<HookEventPayload> & { hook_event_name: string },
	ctx: HookDeliveryContext = CTX,
	agent: "claude_code" | "codex_cli" = "claude_code",
) {
	const body = { session_id: sessionId, cwd: "/w", ...payload } as HookEventPayload;
	if (agent === "codex_cli" && !body.transcript_path) body.transcript_path = "/t.jsonl";
	return processHookEvent(body, agent, ctx);
}

/** Every string and key reachable in a value. */
function allStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
	else if (value !== null && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			out.push(k);
			allStrings(v, out);
		}
	}
	return out;
}

function expectStorable(value: unknown) {
	for (const text of allStrings(value)) {
		expect(text.includes(NUL)).toBe(false);
		expect((text as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
	}
}

const rowsOf = (sessionId: string) =>
	getDb().select().from(events).where(eq(events.sessionId, sessionId)).orderBy(events.id);
const sessionOf = async (sessionId: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId)))[0];

describe("hook events", () => {
	test("(a) a tool response string with NUL is stored with the marker, broadcast, and not flagged as redacted", async () => {
		const s = sid("a");
		const result = await post(s, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "x" },
			tool_response: `ok${NUL}done`,
		});
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.toolResponse).toBe(`ok${MARK}done`);
		const rows = await rowsOf(s);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.toolResponse).toBe(`ok${MARK}done`);
		expect((rows[0]?.rawPayload as Record<string, unknown>).tool_response).toBe(`ok${MARK}done`);
		expectStorable(rows);
	});

	test("(m) the fix is counted on /health and is not a redaction", async () => {
		const s = sid("m");
		const before = getIngestRedactionCounters().storageTextFixed;
		await post(s, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "x" },
			tool_response: `ok${NUL}done`,
		});
		expect(getIngestRedactionCounters().storageTextFixed).toBeGreaterThan(before);
		const [row] = await rowsOf(s);
		expect(row?.toolResponse).toBe(`ok${MARK}done`);
		// The marker is deterministic, so a retry and a stored row hold the same text: not a "changed" event.
		const prepared = await prepareHookPayloadForStorage(
			{
				session_id: s,
				hook_event_name: "UserPromptSubmit",
				prompt: `a${NUL}b`,
			} as HookEventPayload,
			{ keyId: "anonymous" },
		);
		if ("refused" in prepared) throw new Error("refused");
		expect(prepared.stats.changed).toBe(false);
		expect((prepared.payload as unknown as { prompt: string }).prompt).toBe(`a${MARK}b`);
	});

	test("(b) a structured tool response stores the marker in its leaves", async () => {
		const s = sid("b");
		await post(s, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "x" },
			tool_response: { stdout: `x${NUL}y` },
		});
		const [row] = await rowsOf(s);
		expect(row?.toolResponse).toBe(`{"stdout":"x${MARK}y"}`);
		expectStorable(row);
	});

	test("(c) a prompt with NUL is stored; on Postgres the trigram-indexed key is intact", async () => {
		if (isPostgresTest) {
			const idx = await executeRows<{ n: string }>(
				getDb(),
				sql`select relname as n from pg_class where relname = 'idx_events_prompt_trgm'`,
			);
			expect(idx).toHaveLength(1);
		}
		const s = sid("c");
		await post(s, { hook_event_name: "UserPromptSubmit", prompt: `a${NUL}b` });
		const [row] = await rowsOf(s);
		expect(row?.content).toBe(`a${MARK}b`);
		expect((row?.rawPayload as Record<string, unknown>).prompt).toBe(`a${MARK}b`);
		expectStorable(row);
	});

	test("(d) tool input with NUL in a value and a key stays readable by key", async () => {
		const s = sid("d");
		await post(s, {
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: `a${NUL}b`, [`k${NUL}`]: 1 },
		});
		const [row] = await rowsOf(s);
		expect(row?.toolInput).toEqual({ command: `a${MARK}b`, [`k${MARK}`]: 1 });
		expectStorable(row);
		const [read] = await getDb()
			.select({
				name: jsonExtractText(events.rawPayload, "$.tool_name"),
			})
			.from(events)
			.where(eq(events.id, row?.id as number));
		expect(read?.name).toBe("Bash");
		const [command] = await getDb()
			.select({ v: jsonExtractText(events.toolInput, "$.command") })
			.from(events)
			.where(eq(events.id, row?.id as number));
		expect(command?.v).toBe(`a${MARK}b`);
	});

	test("(e) a cut inside a surrogate pair leaves well-formed text", async () => {
		const s = sid("e");
		await post(s, {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "x" },
			tool_response: `${"a".repeat(1999)}\u{1F600}${"b".repeat(100)}`,
		});
		const [row] = await rowsOf(s);
		expect(row?.toolResponse).toBe("a".repeat(1999));
		expectStorable(row);
	});

	test("(f) a lone surrogate in tool input becomes U+FFFD", async () => {
		const s = sid("f");
		await post(s, {
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: `a${LONE}b` },
		});
		const [row] = await rowsOf(s);
		expect((row?.toolInput as Record<string, unknown>).command).toBe(`a${FFFD}b`);
		expectStorable(row);
	});

	test("(g) a session created with NUL in cwd and transcript_path", async () => {
		const s = sid("g");
		await post(s, {
			hook_event_name: "SessionStart",
			cwd: `/w${NUL}x`,
			transcript_path: `/t${NUL}.jsonl`,
		});
		const row = await sessionOf(s);
		expect(row?.cwd).toBe(`/w${MARK}x`);
		expect(row?.transcriptPath).toBe(`/t${MARK}.jsonl`);
		expectStorable(row);
		// the update path
		await post(s, { hook_event_name: "Notification", cwd: `/v${NUL}y`, message: "hi" });
		expect((await sessionOf(s))?.cwd).toBe(`/v${MARK}y`);
	});

	test("(h) a task subject with NUL becomes the session's current task", async () => {
		const s = sid("h");
		await post(s, { hook_event_name: "SessionStart" });
		await post(s, { hook_event_name: "TaskCreated", task_subject: `do${NUL}it` });
		const row = await sessionOf(s);
		expect(row?.currentTask).toBe(`do${MARK}it`);
		expectStorable(row);
	});

	test("(n) a model name with NUL, on the insert and the update path", async () => {
		const s = sid("n");
		await post(s, { hook_event_name: "SessionStart", model: `m${NUL}x` });
		expect((await sessionOf(s))?.model).toBe(`m${MARK}x`);
		await post(s, { hook_event_name: "PostToolUse", tool_name: "Bash", model: `n${NUL}y` });
		expect((await sessionOf(s))?.model).toBe(`n${MARK}y`);
	});

	test("(l) the same delivery twice stores one row", async () => {
		const s = sid("l");
		const ctx: HookDeliveryContext = { ...CTX, deliveryId: `d-${crypto.randomUUID()}` };
		_resetEventDedupForTest();
		const before = getEventsDeduplicatedCounts().deliveryRetry;
		const payload = {
			hook_event_name: "UserPromptSubmit",
			prompt: `p${NUL}q`,
		};
		await post(s, payload, ctx);
		await post(s, payload, ctx);
		expect(await rowsOf(s)).toHaveLength(1);
		expect(getEventsDeduplicatedCounts().deliveryRetry).toBe(before + 1);
	});

	test("(k) a status update with NUL in the task and a plan line", async () => {
		const s = sid("k");
		await post(s, { hook_event_name: "SessionStart" });
		const ok = await processStatusUpdate({
			session_id: s,
			status: "implementing",
			task: `t${NUL}ask`,
			plan: [`step${NUL}1`, "step 2"],
		} as never);
		expect(ok).toBe(true);
		const row = await sessionOf(s);
		expect(row?.currentTask).toBe(`t${MARK}ask`);
		expect(row?.planSummary).toEqual([`step${MARK}1`, "step 2"]);
		expectStorable(await rowsOf(s));
		expectStorable(row);
	});
});

describe("other writers", () => {
	test("(i) normalized and managed events with NUL in content and in a raw-payload key", async () => {
		const s = sid("i");
		await getDb()
			.insert(sessions)
			.values({ sessionId: s, agentType: "codex_cli", status: "active" });
		await seedOwnedLaunch(s, "sup-i", { agentType: "codex_cli" });
		const event = {
			eventType: "ManagedAgentMessage",
			category: "assistant_message" as const,
			content: `hello${NUL}there`,
			rawPayload: { [`key${NUL}`]: `v${LONE}` },
		};
		await appendManagedSessionEvents("sup-i", s, [event]);
		await appendManagedSessionDelivery("sup-i", s, [{ ...event, content: `second${NUL}one` }], {
			deliveryId: `del-${crypto.randomUUID()}`,
			bodyDigest: "digest-i",
		});
		const rows = await rowsOf(s);
		expect(rows.map((r) => r.content)).toEqual([`hello${MARK}there`, `second${MARK}one`]);
		expect(rows[0]?.rawPayload).toEqual({ [`key${MARK}`]: `v${FFFD}` });
		expectStorable(rows);
		await insertNormalizedEvents(s, [
			{
				eventType: "Notification",
				category: "system_event",
				source: "observed_transcript",
				content: `third${NUL}`,
				isNoise: false,
				toolName: null,
				toolInput: null,
				toolResponse: null,
				providerEventType: null,
				rawPayload: {},
			} as never,
		]);
		expect((await rowsOf(s)).at(-1)?.content).toBe(`third${MARK}`);
	});

	test("(j) a managed state report with NUL in cwd, title and metadata; deep metadata becomes a marker", async () => {
		const s = sid("j");
		await getDb()
			.insert(sessions)
			.values({ sessionId: s, agentType: "codex_cli", status: "active" });
		await seedOwnedLaunch(s, "sup-j", { agentType: "codex_cli" });
		let deep: Record<string, unknown> = { leaf: "x" };
		for (let i = 0; i < 70; i++) deep = { n: deep };
		await upsertManagedSessionState("sup-j", {
			sessionId: s,
			cwd: `/c${NUL}d`,
			desiredThreadTitle: `title${NUL}`,
			metadata: { note: `v${NUL}`, [`k${NUL}`]: 1, deep },
			providerCapabilitySnapshot: { feature: `f${LONE}` },
		});
		const session = await sessionOf(s);
		expect(session?.cwd).toBe(`/c${MARK}d`);
		const meta = session?.metadata as Record<string, unknown>;
		expect(meta.note).toBe(`v${MARK}`);
		expect(meta[`k${MARK}`]).toBe(1);
		let node: unknown = meta.deep;
		while (typeof node === "object" && node !== null) node = (node as Record<string, unknown>).n;
		expect(node).toBe("[STORAGE:too_deep]");
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, s));
		expect(managed?.desiredThreadTitle).toBe(`title${MARK}`);
		expect(managed?.providerCapabilitySnapshot).toEqual({ feature: `f${FFFD}` });
		expectStorable(session);
		expectStorable(managed);
		// a new session, through the insert path
		const fresh = sid("j2");
		await seedOwnedLaunch(fresh, "sup-j", { agentType: "codex_cli" });
		await upsertManagedSessionState("sup-j", {
			sessionId: fresh,
			cwd: `/n${NUL}`,
			model: `m${NUL}`,
		});
		const created = await sessionOf(fresh);
		expect(created?.cwd).toBe(`/n${MARK}`);
		expect(created?.model).toBe(`m${MARK}`);
	});

	test("(o) a degraded fork's peer text cut inside a pair stays well formed", async () => {
		const s = sid("o");
		await getDb()
			.insert(sessions)
			.values({
				sessionId: s,
				agentType: "claude_code",
				status: "active",
				metadata: { forkedFromSessionId: "origin-session" },
			});
		await seedOwnedLaunch(s, "sup-o", { agentType: "claude_code", takeover: true });
		await upsertManagedSessionState("sup-o", {
			sessionId: s,
			managedState: "degraded",
			peerTurnText: `${"a".repeat(1023)}\u{1F600}tail`,
		});
		const meta = (await sessionOf(s))?.metadata as Record<string, unknown>;
		const peer = meta.peerTurn as { text: string | null; hidden: boolean };
		expect(peer.hidden).toBe(false);
		expect(peer.text).toBe("a".repeat(1023));
		expectStorable(meta);
	});

	describe("supervisor status routes", () => {
		async function supervisor() {
			const { token } = await createSupervisorEnrollmentToken(
				`nul-${crypto.randomUUID()}`,
				null,
				null,
			);
			const id = crypto.randomUUID();
			const res = await app.request("/api/v1/supervisors/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					hostName: "nul-host",
					platform: "linux",
					arch: "x64",
					version: "1.0.0",
					enrollmentToken: token,
					id,
				}),
			});
			const body = (await res.json()) as { supervisorCredential: string };
			return { id, credential: body.supervisorCredential };
		}
		const send = (sup: { id: string; credential: string }, path: string, body: unknown) =>
			app.request(`/api/v1/supervisors/${sup.id}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${sup.credential}`,
				},
				body: JSON.stringify(body),
			});

		test("(p) a control action status with NUL in metadata and error", async () => {
			const sup = await supervisor();
			const id = crypto.randomUUID();
			await getDb().insert(controlActions).values({
				id,
				actionType: "prompt",
				status: "running",
				claimedBySupervisorId: sup.id,
			});
			const res = await send(sup, `/control-actions/${id}/status`, {
				status: "succeeded",
				error: `bad${NUL}thing`,
				metadata: { note: `a${NUL}b`, [`k${NUL}`]: LONE },
			});
			expect(res.status).toBe(200);
			const [row] = await getDb().select().from(controlActions).where(eq(controlActions.id, id));
			expect(row?.status).toBe("succeeded");
			expect(row?.metadata).toEqual({ note: `a${MARK}b`, [`k${MARK}`]: FFFD });
			// The body is repaired at the route, so the marker is in place before cleanHostText runs.
			expect(row?.error).toBe(`bad${MARK}thing`);
			expectStorable(row);
		});

		test("(q) a launch status with NUL in error and provider metadata", async () => {
			const sup = await supervisor();
			const s = sid("q");
			const { launchId } = await seedOwnedLaunch(s, sup.id, { status: "launching" });
			const res = await send(sup, `/launches/${launchId}/status`, {
				status: "awaiting_session",
				error: `warn${NUL}`,
				providerLaunchMetadata: { note: `a${NUL}`, [`k${NUL}`]: LONE },
			});
			expect(res.status).toBe(200);
			const [row] = await getDb()
				.select()
				.from(launchRequests)
				.where(eq(launchRequests.id, launchId));
			expect(row?.status).toBe("awaiting_session");
			expect(row?.error).toBe(`warn${MARK}`);
			expect(row?.providerLaunchMetadata).toEqual({ note: `a${MARK}`, [`k${MARK}`]: FFFD });
			expectStorable(row);
		});

		test("(t) a registration body is repaired before it is stored", async () => {
			const { token } = await createSupervisorEnrollmentToken(
				`nul-${crypto.randomUUID()}`,
				null,
				null,
			);
			const res = await app.request("/api/v1/supervisors/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					hostName: "nul-host",
					platform: `lin${NUL}ux`,
					arch: "x64",
					version: "1.0.0",
					enrollmentToken: token,
					id: crypto.randomUUID(),
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { supervisor: { platform: string } };
			expect(body.supervisor.platform).toBe(`lin${MARK}ux`);
		});

		test("(u) an id or a state word that would need repair is refused, never repaired", async () => {
			const sup = await supervisor();
			const bad = async (path: string, body: unknown) => {
				const res = await send(sup, path, body);
				expect(res.status).toBe(400);
				expect(await res.json()).toEqual({ error: "invalid_body" });
			};
			await bad("/managed-session-state", { sessionId: `ab${NUL}` });
			await bad("/managed-session-state", { sessionId: "ok-session", status: `act${NUL}ive` });
			await bad("/managed-session-state", { sessionId: "ok-session", launchRequestId: `l${LONE}` });
			await bad("/launches/some-launch/status", { status: `run${NUL}ning` });
			await bad("/control-actions/some-action/status", { status: "succeeded", id: `a${NUL}` });
			// the two raw ids that would have collided after repair create nothing
			const rows = await getDb()
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, `ab${MARK}`));
			expect(rows).toHaveLength(0);
		});

		test("(v) a path parameter that would need repair is refused", async () => {
			const sup = await supervisor();
			const res = await send(sup, "/control-actions/a%00b/status", { status: "succeeded" });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_body" });
		});

		test("(w) a status body over 2 MiB is accepted, and its single huge string is repaired", async () => {
			const sup = await supervisor();
			const id = crypto.randomUUID();
			await getDb()
				.insert(controlActions)
				.values({ id, actionType: "prompt", status: "running", claimedBySupervisorId: sup.id });
			const pad = `${"x".repeat(5 * 1024 * 1024)}${NUL}end`;
			const res = await send(sup, `/control-actions/${id}/status`, {
				status: "succeeded",
				metadata: { pad },
			});
			expect(res.status).toBe(200);
			const [row] = await getDb().select().from(controlActions).where(eq(controlActions.id, id));
			const stored = (row?.metadata as { pad: string }).pad;
			expect(stored.length).toBe(pad.length);
			expect(stored.endsWith(`${MARK}end`)).toBe(true);
			// a launch status of the same size is not refused for its size
			const launch = await send(sup, "/launches/no-such-launch/status", {
				status: "running",
				providerLaunchMetadata: { pad },
			});
			expect(launch.status).toBe(404);
		});

		test("(w2) a malformed path parameter is judged after the credential", async () => {
			const sup = await supervisor();
			const res = await app.request(`/api/v1/supervisors/${sup.id}/control-actions/a%00b/status`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${"not-a-credential"}`,
				},
				body: JSON.stringify({ status: "succeeded" }),
			});
			expect([401, 403]).toContain(res.status);
			const get = await app.request(`/api/v1/supervisors/${sup.id}/provider-sync`, {
				headers: { Authorization: `Bearer ${sup.credential}` },
			});
			expect(get.status).toBe(200);
			const badGet = await app.request("/api/v1/supervisors/a%00b/provider-sync", {
				headers: { Authorization: `Bearer ${sup.credential}` },
			});
			expect([400, 401, 403]).toContain(badGet.status);
		});

		test("(x) a managed events delivery is repaired but its receipt comes from the raw body", async () => {
			const sup = await supervisor();
			const s = sid("x");
			await getDb()
				.insert(sessions)
				.values({ sessionId: s, agentType: "claude_code", status: "active" });
			await seedOwnedLaunch(s, sup.id);
			const deliveryId = `del-${crypto.randomUUID()}`;
			const body = JSON.stringify({
				events: [
					{ eventType: "ManagedAgentMessage", category: "assistant_message", content: `a${NUL}b` },
				],
			});
			const post = () =>
				app.request(`/api/v1/supervisors/${sup.id}/managed-sessions/${s}/events`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${sup.credential}`,
						"X-AgentPulse-Delivery-Id": deliveryId,
					},
					body,
				});
			expect((await post()).status).toBeLessThan(300);
			expect((await post()).status).toBeLessThan(300);
			const rows = await rowsOf(s);
			expect(rows.map((r) => r.content)).toEqual([`a${MARK}b`]);
		});
	});

	test("(y) the approval preview's tail cut never starts on a low surrogate", () => {
		const command = `a\u{1F600}${"b".repeat(1199)}`;
		const lines = buildPreview(
			buildPresentation(commandReport({ command })).presentation,
		).lastLines;
		expect(lines).toBe("b".repeat(1199));
	});

	test("(r) Ask: message content, error text and a thread title cut inside a pair", async () => {
		const thread = await findOrCreateTelegramThread({
			telegramChatId: `chat-${crypto.randomUUID()}`,
			seedTitle: `${"t".repeat(79)}\u{1F600} more`,
		});
		expect(thread.title).toBe("t".repeat(79));
		const message = await appendMessage({
			threadId: thread.id,
			role: "assistant",
			content: `hi${NUL}there`,
			errorMessage: `err${NUL}${LONE}`,
		});
		expect(message.content).toBe(`hi${MARK}there`);
		expect(message.errorMessage).toBe(`err${MARK}${FFFD}`);
		const rows = await getDb()
			.select()
			.from(askMessages)
			.where(eq(askMessages.threadId, thread.id));
		expectStorable(rows);
		await getDb().delete(askMessages).where(eq(askMessages.threadId, thread.id));
		await getDb().delete(askThreads).where(eq(askThreads.id, thread.id));
	});

	test("(s) an approval field cut inside a pair is well formed, and the hash is of the stored text", async () => {
		const built = buildPresentation(
			commandReport({ reason: `${"a".repeat(3839)}\u{1F600}${"b".repeat(500)}` }),
		);
		expectStorable(JSON.parse(built.presentationJson));
		expect((built.reasonText as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
		const { hashPresentation } = await import("./codex-approval-presentation.js");
		expect(built.hash).toBe(hashPresentation(JSON.parse(built.presentationJson)));
		const lone = buildPresentation(commandReport({ reason: `x${LONE}y` }));
		expect(lone.approvable).toBe(false);
		expect(lone.notApprovableReason).toBe("invisible_chars");
		expect(lone.reasonText).toBe(`x${FFFD}y`);
	});
});
