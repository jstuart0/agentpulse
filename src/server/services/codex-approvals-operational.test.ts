/**
 * What an open Codex approval does to the rest of the system (D8, D9): the
 * session reads WAITING through the existing permission-wait machinery, the
 * timeline carries fixed words only, no hook can touch the `approval:` ids, and
 * nothing is indexed or embedded.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import "./ai/__test_db.js";
import type { HookEventPayload } from "../../shared/types.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovals, events, sessions } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { getOperationalStatus } = await import("../../shared/session-state.js");
const { APPROVAL_WAIT_ID_PREFIX, APPROVAL_RESOLVED_EVENT_TYPE } = await import(
	"../../shared/codex-approvals.js"
);
const {
	answerApproval,
	recordApprovalRequest,
	sweepApprovals,
	syncApprovals,
	closeApprovalsForSession,
	_resetApprovalWaitRepairForTest,
} = await import("./codex-approvals.js");
const { processHookEvent, applyPermissionWaitTransition } = await import("./event-processor.js");
const { configurePushRuntime, dispatchEvent, _resetDispatchForTest } = await import(
	"./push/dispatch.js"
);
const { isTurnStale } = await import("./ai/turn-identity.js");
const { needsHuman } = await import("./ai/human-gate.js");
const { toSessionEventDtos } = await import("./event-dto.js");
const { intelligenceForSession } = await import("./ai/intelligence-service.js");
const { getIngestReservedToolUseIdDropped, _resetCountersForTest } = await import(
	"../routes/ingest-counters.js"
);
const { FTS_INDEXED_EVENT_TYPES } = await import("../db/fts-ddl.js");
const { EMBEDDED_EVENT_TYPES } = await import("./ai/embeddings/embedding-service.js");
const { appendManagedSessionEvents, ReservedEventTypeError } = await import(
	"./managed-session-state.js"
);
const { normalizeHookEvent } = await import("./event-normalizer.js");

beforeAll(() => initializeDatabase());
const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
	_resetApprovalWaitRepairForTest();
	_resetDispatchForTest();
});
afterAll(() => configurePushRuntime(null));

async function setup() {
	const sessionId = `op-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `op-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	await harness.seedApprovalSession({ sessionId, supervisorId });
	const clock = harness.createApprovalClock();
	return { sessionId, supervisorId, clock, deps: { now: clock.now } };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function sessionRow(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}
interface StoredWait {
	ids: string[];
	anon: number;
	prevStatus: string | null;
}
const waitOf = async (sessionId: string): Promise<StoredWait | undefined> =>
	((await sessionRow(sessionId)).metadata as { permissionWait?: StoredWait } | null)
		?.permissionWait;
const waitIds = async (sessionId: string): Promise<string[]> =>
	(await waitOf(sessionId))?.ids ?? [];
const operational = async (sessionId: string) =>
	getOperationalStatus((await sessionRow(sessionId)) as never);
const record = async (ctx: Ctx, overrides: Parameters<typeof harness.commandReport>[0] = {}) =>
	(
		await recordApprovalRequest(
			ctx.supervisorId,
			ctx.sessionId,
			harness.commandReport({ rpcId: crypto.randomUUID(), ...overrides }),
			ctx.deps,
		)
	).response.approvalId;
const hook = (sessionId: string, name: string, extra: Partial<HookEventPayload> = {}) =>
	({ session_id: sessionId, hook_event_name: name, ...extra }) as HookEventPayload;
/**
 * Pushes are dispatched without being awaited, and each dispatch yields to the event loop once before
 * it reaches the target resolver. A sentinel dispatched after the action therefore reaches the resolver
 * after every push the action started: awaiting it is the signal that all of them have been seen, for a
 * negative as well as a positive. No sleep, no guess at how long a push takes.
 */
async function drainPushes(): Promise<void> {
	await dispatchEvent({ type: "permission_wait", sessionId: `sentinel-${crypto.randomUUID()}` });
}

/** What the resolver saw for one session, in order. */
const pushesFor = (seen: SeenPush[], sessionId: string) =>
	seen.filter((push) => push.sessionId === sessionId).map((push) => push.type);

interface SeenPush {
	type: string;
	sessionId: string;
}

/** Records the type and session of every push the server tries to send; nothing leaves the process. */
function recordPushes(seen: SeenPush[]): void {
	configurePushRuntime({
		targets: {
			resolve: async (event: { type: string; sessionId: string }) => {
				seen.push({ type: event.type, sessionId: event.sessionId });
				return [];
			},
		},
		service: { sendToDevices: async () => [] },
		logger: { info: () => undefined, warn: () => undefined },
	} as never);
}

describe("an open approval is a permission wait", () => {
	test("WAITING while pending, even with isWorking set, and back to the prior state after close", async () => {
		const ctx = await setup();
		await getDb()
			.update(sessions)
			.set({ isWorking: true, semanticStatus: "implementing" })
			.where(eq(sessions.sessionId, ctx.sessionId));
		expect(await operational(ctx.sessionId)).toBe("working");
		const id = await record(ctx);
		expect(await operational(ctx.sessionId)).toBe("waiting");
		expect(await waitIds(ctx.sessionId)).toEqual([`${APPROVAL_WAIT_ID_PREFIX}${id}`]);
		expect((await sessionRow(ctx.sessionId)).semanticStatus).toBe("waiting");

		await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [],
				resolved: [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }],
			},
			ctx.deps,
		);
		expect(await waitIds(ctx.sessionId)).toEqual([]);
		expect(await operational(ctx.sessionId)).toBe("working");
		expect((await sessionRow(ctx.sessionId)).semanticStatus).toBe("implementing");
	});

	test("one push on open, none for a second request, none on close", async () => {
		const seen: SeenPush[] = [];
		recordPushes(seen);
		const ctx = await setup();
		const a = await record(ctx);
		await drainPushes();
		expect(pushesFor(seen, ctx.sessionId)).toEqual(["permission_wait"]);
		const b = await record(ctx);
		await drainPushes();
		expect(pushesFor(seen, ctx.sessionId)).toEqual(["permission_wait"]);
		await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [],
				resolved: [a, b].map((approvalId) => ({
					approvalId,
					outcome: "runtime_gone" as const,
					sentDecision: null,
				})),
			},
			ctx.deps,
		);
		await drainPushes();
		expect(pushesFor(seen, ctx.sessionId)).toEqual(["permission_wait"]);
	});

	test("two requests keep the session waiting until both close", async () => {
		const ctx = await setup();
		const a = await record(ctx);
		const b = await record(ctx);
		expect(await waitIds(ctx.sessionId)).toHaveLength(2);
		await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [{ approvalId: b, revision: 1 }],
				resolved: [{ approvalId: a, outcome: "runtime_gone", sentDecision: null }],
			},
			ctx.deps,
		);
		expect(await waitIds(ctx.sessionId)).toEqual([`${APPROVAL_WAIT_ID_PREFIX}${b}`]);
		expect(await operational(ctx.sessionId)).toBe("waiting");
	});

	test("closing an approval leaves a Claude wait that has no id (the anonymous count) alone", async () => {
		const ctx = await setup();
		await processHookEvent(
			hook(ctx.sessionId, "PermissionRequest", { tool_name: "Bash" }),
			"claude_code",
		);
		expect((await waitOf(ctx.sessionId))?.anon).toBe(1);
		const id = await record(ctx);
		await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [],
				resolved: [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }],
			},
			ctx.deps,
		);
		expect(await waitOf(ctx.sessionId)).toMatchObject({ ids: [], anon: 1 });
		expect(await operational(ctx.sessionId)).toBe("waiting");
	});

	test("isTurnStale is true once an approval is open, and needsHuman holds the turn", async () => {
		const ctx = await setup();
		const [stop] = await getDb()
			.insert(events)
			.values({
				sessionId: ctx.sessionId,
				eventType: "Stop",
				category: "system_event",
				source: "observed_hook",
				rawPayload: {},
			})
			.returning();
		const session = { sessionId: ctx.sessionId, agentType: "codex_cli" };
		expect(await isTurnStale(getDb(), session, "p:0", { id: stop.id })).toBe(false);
		await record(ctx);
		expect(await isTurnStale(getDb(), session, "p:0", { id: stop.id })).toBe(true);
		const turn = toSessionEventDtos(
			await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId)),
		);
		expect(needsHuman(turn, { version: 1, classes: [] }).hold).toBe(true);
	});

	test("the classifier reads it as blocked / hitl_pending_long at once and never stuck or risky", async () => {
		const ctx = await setup();
		const before = await intelligenceForSession(ctx.sessionId);
		expect(before?.reasonCode).not.toBe("hitl_pending_long");
		await record(ctx);
		const intel = await intelligenceForSession(ctx.sessionId);
		expect(intel).toMatchObject({ health: "blocked", reasonCode: "hitl_pending_long" });
		expect(["stuck", "risky"]).not.toContain(intel?.health);
	});

	test("a Claude permission wait is unchanged", async () => {
		const ctx = await setup();
		await processHookEvent(
			hook(ctx.sessionId, "PermissionRequest", { tool_use_id: "toolu_1", tool_name: "Bash" }),
			"claude_code",
		);
		expect(await waitIds(ctx.sessionId)).toEqual(["toolu_1"]);
		await processHookEvent(
			hook(ctx.sessionId, "PostToolUse", { tool_use_id: "toolu_1", tool_name: "Bash" }),
			"claude_code",
		);
		expect(await waitIds(ctx.sessionId)).toEqual([]);
		await processHookEvent(
			hook(ctx.sessionId, "PermissionRequest", { tool_use_id: "toolu_2", tool_name: "Bash" }),
			"claude_code",
		);
		await processHookEvent(hook(ctx.sessionId, "Stop"), "claude_code");
		expect(await waitIds(ctx.sessionId)).toEqual([]);
	});

	test("the timeline carries fixed words and no agent text, and the closing event is reserved", async () => {
		const ctx = await setup();
		const marker = "MARKER-PRIVATE-COMMAND-5521";
		const id = await record(ctx, { command: `echo ${marker}`, reason: marker });
		await syncApprovals(
			ctx.supervisorId,
			{
				v: 1,
				live: [],
				resolved: [{ approvalId: id, outcome: "runtime_gone", sentDecision: null }],
			},
			ctx.deps,
		);
		const rows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, ctx.sessionId))
			.orderBy(events.id);
		expect(rows.map((r) => r.eventType)).toEqual([
			"PermissionRequest",
			APPROVAL_RESOLVED_EVENT_TYPE,
		]);
		expect(rows.map((r) => r.category)).toEqual(["permission_event", "permission_event"]);
		expect(rows[1].content).toBe("Approval resolved: ended");
		expect(JSON.stringify(rows)).not.toContain(marker);
		expect(rows[0].rawPayload).toMatchObject({
			approval_id: id,
			request_kind: "command",
			tool_use_id: `approval:${id}`,
		});
	});

	test("nothing the agent wrote reaches a log line, an event, the audit or a closed row", async () => {
		const marker = "UNIQUE-AGENT-TEXT-77310";
		const secret = "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
		const lines: string[] = [];
		const spies = (["log", "warn", "error", "info"] as const).map((level) =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => {
				lines.push(args.map(String).join(" "));
			}),
		);
		try {
			const ctx = await setup();
			const id = await record(ctx, { command: `echo ${marker} ${secret}`, reason: marker });
			await answerApproval(
				ctx.sessionId,
				id,
				{ decision: "decline" },
				harness.SOLO_PERSON,
				ctx.deps,
			);
			await syncApprovals(
				ctx.supervisorId,
				{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
				ctx.deps,
			);
			await processHookEvent(
				hook(ctx.sessionId, "PostToolUse", { tool_use_id: `approval:${id}` }),
				"claude_code",
			);
			await syncApprovals(
				ctx.supervisorId,
				{
					v: 1,
					live: [],
					resolved: [
						{ approvalId: id, outcome: "resolved_after_response", sentDecision: "decline" },
					],
				},
				ctx.deps,
			);
			const dump = JSON.stringify([
				await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId)),
				await getDb()
					.select()
					.from(codexApprovals)
					.where(eq(codexApprovals.sessionId, ctx.sessionId)),
				await harness.auditRows(ctx.sessionId),
			]);
			expect(dump).not.toContain(marker);
			expect(dump).not.toContain(secret);
			expect(lines.join("\n")).not.toContain(marker);
			expect(lines.join("\n")).not.toContain(secret);
			expect(lines.some((line) => line.includes("codex_approval_answered"))).toBe(true);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	test("two identical requests each get their own line (no content-window drop)", async () => {
		const ctx = await setup();
		await record(ctx);
		await record(ctx);
		const rows = await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId));
		expect(rows.filter((r) => r.eventType === "PermissionRequest")).toHaveLength(2);
	});

	test("each closing reason has a fixed word", async () => {
		const words: Record<string, string> = {};
		const cases: Array<[string, (ctx: Ctx, id: string) => Promise<void>]> = [
			[
				"approved",
				async (ctx, id) => {
					await answerApproval(
						ctx.sessionId,
						id,
						{
							decision: "accept",
							presentationHash: (
								await getDb().select().from(codexApprovals).where(eq(codexApprovals.id, id))
							)[0].presentationHash,
						},
						harness.SOLO_PERSON,
						ctx.deps,
					);
					await syncApprovals(
						ctx.supervisorId,
						{ v: 1, live: [{ approvalId: id, revision: 1 }], resolved: [] },
						ctx.deps,
					);
					await syncApprovals(
						ctx.supervisorId,
						{
							v: 1,
							live: [],
							resolved: [
								{ approvalId: id, outcome: "resolved_after_response", sentDecision: "accept" },
							],
						},
						ctx.deps,
					);
				},
			],
			[
				"declined",
				async (ctx, id) => {
					await answerApproval(
						ctx.sessionId,
						id,
						{ decision: "decline" },
						harness.SOLO_PERSON,
						ctx.deps,
					);
					await syncApprovals(
						ctx.supervisorId,
						{
							v: 1,
							live: [],
							resolved: [
								{ approvalId: id, outcome: "resolved_after_response", sentDecision: "decline" },
							],
						},
						ctx.deps,
					);
				},
			],
			[
				"expired",
				async (ctx) => {
					ctx.clock.advance(20 * 60_000 + 1);
					await sweepApprovals({}, ctx.deps);
				},
			],
			["stopped", async (ctx) => void (await closeApprovalsForSession(ctx.sessionId, ctx.deps))],
			[
				"ended",
				async (ctx, id) =>
					void (await syncApprovals(
						ctx.supervisorId,
						{
							v: 1,
							live: [],
							resolved: [
								{ approvalId: id, outcome: "resolved_before_response", sentDecision: null },
							],
						},
						ctx.deps,
					)),
			],
		];
		for (const [word, run] of cases) {
			const ctx = await setup();
			const id = await record(ctx);
			await run(ctx, id);
			const rows = await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId));
			words[word] = rows.find((r) => r.eventType === APPROVAL_RESOLVED_EVENT_TYPE)?.content ?? "";
		}
		expect(words).toEqual({
			approved: "Approval resolved: approved",
			declined: "Approval resolved: declined",
			expired: "Approval resolved: expired",
			stopped: "Approval resolved: stopped",
			ended: "Approval resolved: ended",
		});
	});

	test("only the writer whose guarded update changed the row runs the effects", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const body = {
			v: 1 as const,
			live: [],
			resolved: [{ approvalId: id, outcome: "runtime_gone" as const, sentDecision: null }],
		};
		await Promise.all([
			syncApprovals(ctx.supervisorId, body, ctx.deps),
			closeApprovalsForSession(ctx.sessionId, ctx.deps),
		]);
		const resolved = (
			await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId))
		).filter((r) => r.eventType === APPROVAL_RESOLVED_EVENT_TYPE);
		expect(resolved).toHaveLength(1);
	});
});

describe("the sweep's wait reconcile", () => {
	const asId = (id: string) => `${APPROVAL_WAIT_ID_PREFIX}${id}`;
	async function setWait(sessionId: string, wait: unknown) {
		await getDb()
			.update(sessions)
			.set({ metadata: wait === null ? {} : { permissionWait: wait } })
			.where(eq(sessions.sessionId, sessionId));
	}

	test("a stale approval id (no open row) is removed, and the displaced status comes back", async () => {
		const ctx = await setup();
		await getDb()
			.update(sessions)
			.set({ semanticStatus: "waiting" })
			.where(eq(sessions.sessionId, ctx.sessionId));
		await setWait(ctx.sessionId, { ids: [asId("ghost")], anon: 0, prevStatus: "testing" });
		const result = await sweepApprovals({ full: true }, ctx.deps);
		// Counts are for the whole sweep; what it did to this session is asserted below, by id.
		expect(result.waitsRemoved).toBeGreaterThanOrEqual(1);
		expect(await waitIds(ctx.sessionId)).toEqual([]);
		expect((await sessionRow(ctx.sessionId)).semanticStatus).toBe("testing");
	});

	test("an open row whose id is absent is added with no push and prevStatus and semanticStatus untouched", async () => {
		const seen: SeenPush[] = [];
		recordPushes(seen);
		const ctx = await setup();
		const id = await record(ctx);
		await drainPushes();
		seen.length = 0;
		await getDb()
			.update(sessions)
			.set({ semanticStatus: "reviewing" })
			.where(eq(sessions.sessionId, ctx.sessionId));
		await setWait(ctx.sessionId, null);
		const result = await sweepApprovals({}, ctx.deps);
		await drainPushes();
		// Counts are for the whole sweep; what it did to this session is asserted below, by id.
		expect(result.waitsAdded).toBeGreaterThanOrEqual(1);
		expect(await waitIds(ctx.sessionId)).toEqual([asId(id)]);
		const row = await sessionRow(ctx.sessionId);
		expect(row.semanticStatus).toBe("reviewing");
		expect((await waitOf(ctx.sessionId))?.prevStatus).toBeNull();
		expect(pushesFor(seen, ctx.sessionId)).toEqual([]);
	});

	test("a wait that already agrees means zero writes", async () => {
		const ctx = await setup();
		await record(ctx);
		// The sweep's counts and statements are for every open row there is; they describe this session
		// alone only if it is the only one, so say so rather than assume it.
		const strangers = await getDb()
			.select({ id: codexApprovals.id })
			.from(codexApprovals)
			.where(
				and(
					inArray(codexApprovals.status, ["pending", "answered"]),
					ne(codexApprovals.sessionId, ctx.sessionId),
				),
			);
		expect(strangers).toEqual([]);
		const before = await sessionRow(ctx.sessionId);
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		let writes = 0;
		const statements = await countDbCalls(async () => {
			const result = await sweepApprovals({}, ctx.deps);
			writes = result.waitsAdded + result.waitsRemoved + result.closed;
		});
		expect(writes).toBe(0);
		expect(statements).toBeLessThanOrEqual(4);
		expect(await sessionRow(ctx.sessionId)).toEqual(before);
	});

	test("a Claude wait beside an approval one is left alone", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		await processHookEvent(
			hook(ctx.sessionId, "PermissionRequest", { tool_use_id: "toolu_9", tool_name: "Bash" }),
			"claude_code",
		);
		await sweepApprovals({ full: true }, ctx.deps);
		expect((await waitIds(ctx.sessionId)).sort()).toEqual(["toolu_9", asId(id)].sort());
	});
});

describe("forged clears", () => {
	test("a hook with an approval: tool_use_id is dropped and counted, still without throwing", async () => {
		_resetCountersForTest();
		const ctx = await setup();
		const id = await record(ctx);
		for (const name of [
			"PermissionRequest",
			"PermissionDenied",
			"PostToolUse",
			"PostToolUseFailure",
			"Stop",
			"UserPromptSubmit",
		]) {
			const result = await processHookEvent(
				hook(ctx.sessionId, name, { tool_use_id: `approval:${id}` }),
				"claude_code",
			);
			expect(result.session).toBeNull();
		}
		expect(getIngestReservedToolUseIdDropped()).toBe(6);
		expect(await waitIds(ctx.sessionId)).toEqual([`approval:${id}`]);
	});

	test("a non-string tool_use_id doesn't throw and isn't dropped as reserved", async () => {
		_resetCountersForTest();
		const ctx = await setup();
		for (const bad of [42, null, { a: 1 }, ["approval:x"], true]) {
			await processHookEvent(
				hook(ctx.sessionId, "PostToolUse", { tool_use_id: bad as never }),
				"claude_code",
			);
		}
		expect(getIngestReservedToolUseIdDropped()).toBe(0);
	});

	test("a forged Stop and a forged UserPromptSubmit keep approval ids while clearing the others", async () => {
		for (const name of ["Stop", "UserPromptSubmit", "SessionStart", "SessionEnd", "Interrupt"]) {
			const ctx = await setup();
			const id = await record(ctx);
			await processHookEvent(
				hook(ctx.sessionId, "PermissionRequest", { tool_use_id: "toolu_a", tool_name: "Bash" }),
				"claude_code",
			);
			expect((await waitIds(ctx.sessionId)).length).toBe(2);
			await processHookEvent(hook(ctx.sessionId, name), "claude_code");
			expect(await waitIds(ctx.sessionId), name).toEqual([`approval:${id}`]);
			if (name !== "SessionEnd") expect(await operational(ctx.sessionId), name).toBe("waiting");
		}
	});

	test("300 other ids can't fold an approval id into the anonymous count", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		for (let i = 0; i < 300; i++) {
			await applyPermissionWaitTransition(
				ctx.sessionId,
				hook(ctx.sessionId, "PermissionRequest", { tool_use_id: `toolu_${i}` }),
			);
		}
		const ids = await waitIds(ctx.sessionId);
		expect(ids).toContain(`approval:${id}`);
		expect((await waitOf(ctx.sessionId))?.anon).toBeGreaterThan(0);
	});

	test("a forged PostToolUse with an unknown id, many times, can't drain an approval", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		for (let i = 0; i < 10; i++) {
			await processHookEvent(
				hook(ctx.sessionId, "PostToolUse", { tool_use_id: `unknown-${i}`, tool_name: "Bash" }),
				"claude_code",
			);
			await processHookEvent(
				hook(ctx.sessionId, "PostToolUse", { tool_name: "Bash" }),
				"claude_code",
			);
			await processHookEvent(
				hook(ctx.sessionId, "PermissionDenied", { tool_name: "Bash" }),
				"claude_code",
			);
		}
		expect(await waitIds(ctx.sessionId)).toEqual([`approval:${id}`]);
	});

	test("the wait logic itself, called directly, ignores an approval: id from any hook event (second line behind the drop)", async () => {
		const ctx = await setup();
		const id = await record(ctx);
		const mine = `approval:${id}`;
		for (const name of ["PermissionDenied", "PostToolUse", "PostToolUseFailure"]) {
			await applyPermissionWaitTransition(
				ctx.sessionId,
				hook(ctx.sessionId, name, { tool_use_id: mine }),
			);
		}
		expect(await waitIds(ctx.sessionId)).toEqual([mine]);
		// ...and can't open one either.
		await applyPermissionWaitTransition(
			ctx.sessionId,
			hook(ctx.sessionId, "PermissionRequest", { tool_use_id: "approval:forged" }),
		);
		expect(await waitIds(ctx.sessionId)).toEqual([mine]);
		expect((await waitOf(ctx.sessionId))?.anon).toBe(0);
	});

	test("no tool_use_id in the recorded agent fixtures starts with the reserved prefix (at least one id scanned)", () => {
		const root = join(import.meta.dir, "agents/__fixtures__");
		let scanned = 0;
		const walk = (dir: string) => {
			for (const name of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, name.name);
				if (name.isDirectory()) walk(full);
				else if (name.name.endsWith(".json")) {
					for (const match of readFileSync(full, "utf8").matchAll(
						/"tool_use_id"\s*:\s*"([^"]*)"/g,
					)) {
						scanned++;
						expect(match[1].startsWith(APPROVAL_WAIT_ID_PREFIX)).toBe(false);
					}
				}
			}
		};
		walk(root);
		expect(scanned).toBeGreaterThanOrEqual(1);
	});

	test("the closing event can't be written from a hook or by a supervisor", async () => {
		const ctx = await setup();
		for (const name of [
			APPROVAL_RESOLVED_EVENT_TYPE,
			` ${APPROVAL_RESOLVED_EVENT_TYPE.toLowerCase()} `,
		]) {
			expect(normalizeHookEvent(hook(ctx.sessionId, name), "claude_code")).toEqual([]);
			expect(
				normalizeHookEvent(
					{ ...hook(ctx.sessionId, "Notification"), provider_event_name: name } as never,
					"claude_code",
				),
			).toEqual([]);
			await expect(
				appendManagedSessionEvents(ctx.supervisorId, ctx.sessionId, [
					{ eventType: name, category: "permission_event", content: "x" } as never,
				]),
			).rejects.toBeInstanceOf(ReservedEventTypeError);
		}
		await expect(
			appendManagedSessionEvents(ctx.supervisorId, ctx.sessionId, [
				{
					eventType: "Other",
					providerEventType: APPROVAL_RESOLVED_EVENT_TYPE,
					category: "system_event",
					content: "x",
				} as never,
			]),
		).rejects.toBeInstanceOf(ReservedEventTypeError);
		expect(await getDb().select().from(events).where(eq(events.sessionId, ctx.sessionId))).toEqual(
			[],
		);
	});
});

describe("not indexed", () => {
	test("neither the search index nor the embedder holds the new event types", () => {
		for (const list of [FTS_INDEXED_EVENT_TYPES, EMBEDDED_EVENT_TYPES] as unknown as string[][]) {
			expect(list.length).toBeGreaterThan(0);
			expect(list).toContain("UserPromptSubmit");
			expect(list).not.toContain(APPROVAL_RESOLVED_EVENT_TYPE);
			expect(list).not.toContain("PermissionRequest");
		}
	});
});
