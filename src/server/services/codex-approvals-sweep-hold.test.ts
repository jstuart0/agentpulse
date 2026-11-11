/**
 * AGEN-94: a session with an open approval row isn't completed by an indirect writer. The inactivity
 * sweep, a hook SessionEnd and a replayed terminal report all leave it alone, and an approval opening on
 * a session the sweep completed reopens it. The host in every case is dead (no live lease), which is the
 * case the badge used to get wrong: the card said "you can answer", the badge said COMPLETED.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import type { HookEventPayload } from "../../shared/types.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { codexApprovals, managedSessions, sessions } = await import("../db/schema/index.js");
const harness = await import("../test-utils/codex-approvals-harness.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { getOperationalStatus } = await import("../../shared/session-state.js");
const { APPROVAL_WAIT_ID_PREFIX } = await import("../../shared/codex-approvals.js");
const { recordApprovalRequest, sweepApprovals, _resetApprovalWaitRepairForTest } = await import(
	"./codex-approvals.js"
);
const { updateStaleSessions } = await import("./session-tracker.js");
const { processHookEvent } = await import("./event-processor.js");
const { upsertManagedSessionState } = await import("./managed-session-state.js");

beforeAll(() => initializeDatabase());
const used: string[] = [];
const hosts: string[] = [];
afterEach(async () => {
	await harness.cleanApprovalFixtures(used.splice(0), hosts.splice(0));
	_resetApprovalWaitRepairForTest();
});

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

interface SeedOptions {
	status?: string;
	isWorking?: boolean;
	quietMs?: number;
	agentType?: "codex_cli" | "claude_code";
	fork?: boolean;
	/** The open row to insert, or none. */
	row?: { status: "pending" | "answered" | "closed"; expiresAt: string; kind?: string } | null;
	managedState?: string;
	metadata?: Record<string, unknown>;
}

/** A managed session on a host with no live lease, quiet for 45 minutes by default. */
async function seed(options: SeedOptions = {}) {
	const sessionId = `hold-${crypto.randomUUID().slice(0, 8)}`;
	const supervisorId = `hold-host-${crypto.randomUUID().slice(0, 8)}`;
	used.push(sessionId);
	hosts.push(supervisorId);
	const agentType = options.fork ? "claude_code" : (options.agentType ?? "codex_cli");
	await harness.seedApprovalSession({ sessionId, supervisorId, host: "none", agentType });
	if (options.fork) {
		await seedOwnedLaunch(sessionId, supervisorId, {
			host: "none",
			agentType: "claude_code",
			takeover: true,
		});
	}
	let rowId: string | null = null;
	const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
	if (options.fork) metadata.forkedFromSessionId = "source-session";
	if (options.row) {
		rowId = crypto.randomUUID();
		await getDb()
			.insert(codexApprovals)
			.values({
				id: rowId,
				sessionId,
				runtimeEpoch: "e",
				rpcId: "1",
				requestKind: options.row.kind ?? (options.fork ? "claude_tool" : "command"),
				threadId: "t",
				turnId: "t",
				itemId: "i",
				presentationHash: "h",
				presentationRevision: 1,
				approvable: true,
				status: options.row.status,
				closedReason: options.row.status === "closed" ? "applied" : null,
				createdAt: ago(MIN),
				updatedAt: ago(MIN),
				expiresAt: options.row.expiresAt,
			});
		if (options.row.status !== "closed") {
			metadata.permissionWait = {
				ids: [`${APPROVAL_WAIT_ID_PREFIX}${rowId}`],
				anon: 0,
				prevStatus: null,
			};
		}
	}
	await getDb()
		.update(sessions)
		.set({
			status: options.status ?? "idle",
			isWorking: options.isWorking ?? false,
			lastActivityAt: ago(options.quietMs ?? 45 * MIN),
			metadata,
			...(options.status === "completed" ? { endedAt: ago(5 * MIN) } : {}),
		})
		.where(eq(sessions.sessionId, sessionId));
	if (options.managedState) {
		await getDb()
			.update(managedSessions)
			.set({ managedState: options.managedState as never })
			.where(eq(managedSessions.sessionId, sessionId));
	}
	return { sessionId, supervisorId, rowId };
}

async function sessionRow(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}
const operational = async (sessionId: string) =>
	getOperationalStatus((await sessionRow(sessionId)) as never);
const hook = (sessionId: string, name: string) =>
	({ session_id: sessionId, hook_event_name: name }) as HookEventPayload;

describe("the inactivity sweep holds a session with an open approval row", () => {
	test("1. a pending row holds a quiet idle session", async () => {
		const { sessionId } = await seed({ row: { status: "pending", expiresAt: fromNow(10 * MIN) } });
		await updateStaleSessions(Date.now());
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("idle");
		expect(row.endedAt).toBeNull();
		expect(await operational(sessionId)).toBe("waiting");
	});

	test("2. a working session is still cleared and idled, only completion waits", async () => {
		const { sessionId } = await seed({
			status: "active",
			isWorking: true,
			quietMs: 65 * MIN,
			row: { status: "pending", expiresAt: fromNow(10 * MIN) },
		});
		await updateStaleSessions(Date.now());
		const row = await sessionRow(sessionId);
		expect(row.isWorking).toBe(false);
		expect(row.status).toBe("idle");
		expect(row.endedAt).toBeNull();
		expect(await operational(sessionId)).toBe("waiting");
	});

	test("3. an answered row holds, even a minute past its expiry", async () => {
		const { sessionId } = await seed({ row: { status: "answered", expiresAt: ago(MIN) } });
		await updateStaleSessions(Date.now());
		expect((await sessionRow(sessionId)).status).toBe("idle");
		expect(await operational(sessionId)).toBe("waiting");
	});

	test("4. the hold ends when the row closes by its own rules", async () => {
		const { sessionId, rowId } = await seed({
			row: { status: "pending", expiresAt: fromNow(10 * MIN) },
		});
		await updateStaleSessions(Date.now());
		expect((await sessionRow(sessionId)).status).toBe("idle");
		const later = Date.now() + 11 * MIN;
		await sweepApprovals({}, { now: () => later });
		const [approval] = await getDb()
			.select()
			.from(codexApprovals)
			.where(eq(codexApprovals.id, rowId as string));
		expect(approval.status).toBe("closed");
		expect(approval.closedReason).toBe("expired");
		await updateStaleSessions(later);
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("completed");
		expect(await operational(sessionId)).toBe("completed");
	});

	test("5. the ceiling: a row left open 11 minutes past its expiry no longer holds", async () => {
		const { sessionId } = await seed({ row: { status: "pending", expiresAt: ago(11 * MIN) } });
		await updateStaleSessions(Date.now());
		expect((await sessionRow(sessionId)).status).toBe("completed");
	});

	test("6. a closed row doesn't hold, and a session with no approval completes in the same call", async () => {
		const closed = await seed({ row: { status: "closed", expiresAt: fromNow(10 * MIN) } });
		const plain = await seed({});
		const held = await seed({ row: { status: "pending", expiresAt: fromNow(10 * MIN) } });
		await updateStaleSessions(Date.now());
		expect((await sessionRow(closed.sessionId)).status).toBe("completed");
		expect((await sessionRow(plain.sessionId)).status).toBe("completed");
		expect((await sessionRow(held.sessionId)).status).toBe("idle");
	});

	test("7. a Claude fork with a claude_tool row is held the same way", async () => {
		const { sessionId } = await seed({
			fork: true,
			row: { status: "pending", expiresAt: fromNow(10 * MIN) },
		});
		await updateStaleSessions(Date.now());
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("idle");
		expect(await operational(sessionId)).toBe("waiting");
	});
});

describe("an approval opening on a session the sweep completed reopens it", () => {
	const report = () => harness.commandReport({ rpcId: crypto.randomUUID() });

	test("8. reopened: active, not ended, WAITING", async () => {
		const { sessionId, supervisorId } = await seed({
			status: "completed",
			managedState: "managed",
		});
		expect(await operational(sessionId)).toBe("completed");
		await recordApprovalRequest(supervisorId, sessionId, report());
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("active");
		expect(row.endedAt).toBeNull();
		expect(await operational(sessionId)).toBe("waiting");
	});

	const stays: [string, SeedOptions][] = [
		[
			"a hook SessionEnd ended it (endedByEvent)",
			{
				status: "completed",
				managedState: "managed",
				metadata: { endedByEvent: { at: new Date().toISOString() } },
			},
		],
		["the host's managed state is stopped", { status: "completed", managedState: "stopped" }],
		["the session failed", { status: "failed", managedState: "managed" }],
	];
	for (const [name, options] of stays) {
		test(`8. stays ended: ${name}`, async () => {
			const { sessionId, supervisorId } = await seed(options);
			await recordApprovalRequest(supervisorId, sessionId, report());
			const row = await sessionRow(sessionId);
			expect(row.status).toBe(options.status as string);
			expect(row.endedAt === null).toBe(options.status === "failed");
		});
	}

	test("8. stays archived", async () => {
		const { sessionId, supervisorId } = await seed({
			status: "completed",
			managedState: "managed",
		});
		await getDb()
			.update(sessions)
			.set({ isArchived: true })
			.where(eq(sessions.sessionId, sessionId));
		await recordApprovalRequest(supervisorId, sessionId, report());
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("completed");
		expect(row.endedAt).not.toBeNull();
	});
});

describe("a hook SessionEnd doesn't end a session that holds an approval wait", () => {
	test("9. fenced with an approval: wait id", async () => {
		const { sessionId } = await seed({
			status: "active",
			quietMs: MIN,
			row: { status: "pending", expiresAt: fromNow(10 * MIN) },
		});
		await processHookEvent(hook(sessionId, "SessionEnd"), "codex_cli");
		const row = await sessionRow(sessionId);
		expect(row.status).not.toBe("completed");
		expect(row.endedAt).toBeNull();
		expect((row.metadata as Record<string, unknown>).endedByEvent).toBeUndefined();
	});

	test("9. control: the same hook with no approval wait completes the session", async () => {
		const { sessionId } = await seed({ status: "active", quietMs: MIN });
		await processHookEvent(hook(sessionId, "SessionEnd"), "codex_cli");
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("completed");
		expect(row.endedAt).not.toBeNull();
	});
});

describe("a replayed terminal report doesn't complete a session with an open row", () => {
	const terminal = (sessionId: string) => ({
		sessionId,
		status: "completed" as const,
		managedState: "completed" as const,
	});
	const managedState = async (sessionId: string) =>
		(
			await getDb()
				.select({ state: managedSessions.managedState })
				.from(managedSessions)
				.where(eq(managedSessions.sessionId, sessionId))
		)[0]?.state;

	test("10. replay with an open row: the session keeps its status, the managed row ends", async () => {
		const { sessionId, supervisorId } = await seed({
			status: "active",
			quietMs: MIN,
			row: { status: "pending", expiresAt: fromNow(10 * MIN) },
		});
		await upsertManagedSessionState(supervisorId, terminal(sessionId), { replay: true });
		expect((await sessionRow(sessionId)).status).toBe("active");
		expect(await managedState(sessionId)).toBe("completed");
	});

	test("10. control: a replay with no open row completes the session", async () => {
		const { sessionId, supervisorId } = await seed({ status: "active", quietMs: MIN });
		await upsertManagedSessionState(supervisorId, terminal(sessionId), { replay: true });
		expect((await sessionRow(sessionId)).status).toBe("completed");
	});

	test("10. a live report completes the session and closes the row", async () => {
		const { sessionId, supervisorId, rowId } = await seed({
			status: "active",
			quietMs: MIN,
			row: { status: "pending", expiresAt: fromNow(10 * MIN) },
		});
		await upsertManagedSessionState(supervisorId, terminal(sessionId));
		expect((await sessionRow(sessionId)).status).toBe("completed");
		const [approval] = await getDb()
			.select()
			.from(codexApprovals)
			.where(eq(codexApprovals.id, rowId as string));
		expect(approval.status).toBe("closed");
		expect(approval.closedReason).toBe("session_stopped");
	});
});
