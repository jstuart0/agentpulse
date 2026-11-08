/**
 * Taking over an observed Claude Code session, and recovering the fork (AGEN-117 phase 5, server half).
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres: the real binding service,
 * the real claim and settle, the real admin lock. The only fakes are the clock injected into the bind and the
 * seams the concurrency cases need. The host's side is `src/supervisor/services/session-resume-claude.test.ts`.
 *
 * The invariant most cases hold: the observed session S's row is byte-equal after every outcome (the takeover
 * never writes it), and a failed takeover leaves exactly one failed action and no row for the fork N.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { CLAUDE_TURN_CONTROL, CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import * as sharedResume from "../../shared/session-resume.js";
import { CLAUDE_TAKEOVER, RESUMES_SESSIONS } from "../../shared/session-resume.js";
import type { Actor } from "../auth/actor.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { controlActions, events, launchRequests, managedSessions, sessions, supervisors, users } =
	await import("../db/schema/index.js");
const { cleanApprovalFixtures } = await import("../test-utils/codex-approvals-harness.js");
const { BindRefusal } = await import("./bind-refusal.js");
const { bindObservedSession, queueSessionResume } = await import("./session-binding.js");
const authz = await import("./authorization.js");
const ownership = await import("./session-ownership.js");
const control = await import("./control-actions.js");
const { sessionBus } = await import("./notifier.js");
const wsRevalidation = await import("../ws/revalidation.js");
const managedState = await import("./managed-session-state.js");
const { ENFORCES_LAUNCH_PRIVILEGES } = await import("./launch-compatibility.js");

beforeAll(() => initializeDatabase());

const originalDisableAuth = config.disableAuth;
const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
let counter = 0;

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

const WORK = "/work";
const CWD = "/work/project";
const T0 = Math.floor(Date.now() / 1000) * 1000;
const MIN = 60_000;
const NOW = () => T0;
const deps = { now: NOW };

const CAPABILITIES = {
	version: 1,
	agentTypes: ["claude_code"],
	launchModes: ["headless"],
	os: "macos",
	terminalSupport: [],
	features: [CLAUDE_TAKEOVER, CLAUDE_TURN_CONTROL, ENFORCES_LAUNCH_PRIVILEGES],
	executables: {
		claude: { available: true, command: "claude", resolvedPath: "/usr/bin/claude", source: "auto" },
	},
};

async function seedHost(
	opts: { ownerUserId?: string | null; capabilities?: unknown; roots?: string[] } = {},
): Promise<string> {
	counter++;
	const id = `fork-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	hostsUsed.push(id);
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `${id}-name`,
			platform: "darwin",
			arch: "arm64",
			version: "1.0.0",
			capabilities: (opts.capabilities ?? CAPABILITIES) as Record<string, unknown>,
			trustedRoots: opts.roots ?? [WORK],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60 * MIN).toISOString(),
			enrollmentState: "active",
			ownerUserId: opts.ownerUserId ?? null,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

async function seedObserved(
	opts: {
		ownerUserId?: string | null;
		agentType?: string;
		cwd?: string | null;
		isWorking?: boolean;
	} = {},
): Promise<string> {
	const sessionId = crypto.randomUUID();
	const ingestKeyId = opts.ownerUserId
		? (await seedKey("fork-reporter", ["ingest"], opts.ownerUserId)).id
		: null;
	sessionsUsed.push(sessionId);
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: opts.agentType ?? "claude_code",
			cwd: opts.cwd === undefined ? CWD : opts.cwd,
			displayName: "refactor the parser",
			ownerUserId: opts.ownerUserId ?? null,
			ingestKeyId,
			lastActivityAt: new Date(T0 - 10 * MIN).toISOString(),
			isWorking: opts.isWorking ?? false,
			status: "idle",
		});
	return sessionId;
}

const SOLO: Actor = { userId: null, label: "anonymous", role: "admin", mode: "solo" };
const ADMIN = (userId: string): Actor => ({ userId, label: "user", role: "admin", mode: "team" });
const MEMBER = (userId: string): Actor => ({ userId, label: "user", role: "member", mode: "team" });

async function team() {
	await setStoredMode("team");
	return {
		alice: await seedLocalUser("fork-alice"),
		bob: await seedLocalUser("fork-bob"),
		admin: await seedLocalUser("fork-admin", "admin"),
	};
}

function bind(sessionId: string, hostId: string, actor: Actor = SOLO, extra = deps) {
	return bindObservedSession(
		sessionId,
		{ targetSupervisorId: hostId, sameMachineConfirmed: true },
		actor,
		extra,
	);
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof BindRefusal) return { code: error.code, status: error.status };
		throw error;
	}
	throw new Error("expected a BindRefusal, but the call succeeded");
}

async function sessionRow(id: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
	return row;
}
const snapshot = async (id: string) => JSON.stringify(await sessionRow(id));

async function actionsOn(id: string) {
	return getDb().select().from(controlActions).where(eq(controlActions.sessionId, id));
}

async function rowsOf(id: string) {
	const [launch] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, id));
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, id));
	const session = await sessionRow(id);
	const evs = await getDb().select().from(events).where(eq(events.sessionId, id));
	return { launch, managed, session, events: evs };
}

async function expectNoForkRows(forkId: string) {
	const r = await rowsOf(forkId);
	expect({ l: !!r.launch, m: !!r.managed, s: !!r.session, e: r.events.length }).toEqual({
		l: false,
		m: false,
		s: false,
		e: 0,
	});
}

interface Started {
	id: string;
	host: string;
	forkId: string;
	actionId: string;
	before: string;
}

/** Binds a fresh observed session and claims the action as the host. */
async function started(
	opts: {
		host?: string;
		actor?: Actor;
		ownerUserId?: string | null;
		hostOwner?: string | null;
	} = {},
): Promise<Started> {
	const host = opts.host ?? (await seedHost({ ownerUserId: opts.hostOwner ?? null }));
	const id = await seedObserved({ ownerUserId: opts.ownerUserId ?? null });
	const before = await snapshot(id);
	const result = await bind(id, host, opts.actor ?? SOLO);
	const meta = result.action.metadata as Record<string, unknown>;
	const forkId = meta.forkSessionId as string;
	sessionsUsed.push(forkId);
	const claimed = await control.claimNextControlAction(host);
	expect(claimed?.id).toBe(result.action.id);
	return { id, host, forkId, actionId: result.action.id, before };
}

function report(s: Started, body: Record<string, unknown> = {}) {
	return control.updateControlAction({
		actionId: s.actionId,
		supervisorId: s.host,
		status: "succeeded",
		provedCwd: CWD,
		permissionMode: "ask",
		...body,
	});
}

async function failedWith(s: Started, mustContain?: string) {
	const [action] = await actionsOn(s.id);
	expect(action?.status).toBe("failed");
	if (mustContain) expect(String(action?.error)).toContain(mustContain);
	await expectNoForkRows(s.forkId);
	expect(await snapshot(s.id)).toBe(s.before);
}

// ── bind: one action on S and nothing else ───────────────────────────────────

describe("the bind writes one action on the observed session", () => {
	test("solo: a queued resume action names the fork, and no session, launch or managed row is written", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const before = await snapshot(id);
		const result = await bind(id, host);

		const meta = result.action.metadata as Record<string, any>;
		expect(meta).toMatchObject({
			resumeKind: "takeover",
			agentType: "claude_code",
			threadId: id,
			candidateCwd: CWD,
			targetSupervisorId: host,
			expectedEnforcedArgs: ["--permission-mode", "default"],
		});
		expect(meta.forkSessionId).not.toBe(id);
		expect(meta.forkSessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.launchRequestId).toBe(meta.carrierLaunchId);
		expect(Date.parse(meta.forkDeadlineAt) - T0).toBe(90_000);
		expect(result.action.status).toBe("queued");

		sessionsUsed.push(meta.forkSessionId);
		await expectNoForkRows(meta.forkSessionId);
		// S: no managed row, no launch row, nothing written to the row.
		const s = await rowsOf(id);
		expect({ l: !!s.launch, m: !!s.managed }).toEqual({ l: false, m: false });
		expect(await snapshot(id)).toBe(before);
		expect((await actionsOn(id)).length).toBe(1);
	});

	test("the bind body's strict key set is unchanged: an extra key is invalid_body from the route, and the service refuses a missing confirmation", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		expect(
			await refusal(
				bindObservedSession(
					id,
					{ targetSupervisorId: host, sameMachineConfirmed: false },
					SOLO,
					deps,
				),
			),
		).toEqual({ code: "invalid_body", status: 400 });
		expect((await actionsOn(id)).length).toBe(0);
	});

	test.each([
		["copilot_cli", "agent_not_supported"],
		["codex_cli", null],
	] as const)("agent %s", async (agentType, code) => {
		const host = await seedHost({
			capabilities: {
				...CAPABILITIES,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "managed_codex"],
				features: [
					CLAUDE_TAKEOVER,
					ENFORCES_LAUNCH_PRIVILEGES,
					RESUMES_SESSIONS,
					CODEX_FOLLOW_UP_PROMPTS,
				],
				executables: {
					...CAPABILITIES.executables,
					codex: {
						available: true,
						command: "codex",
						resolvedPath: "/usr/bin/codex",
						source: "auto",
					},
				},
			},
		});
		const id = await seedObserved({ agentType });
		if (code) {
			expect((await refusal(bind(id, host))).code).toBe(code);
			expect((await actionsOn(id)).length).toBe(0);
		} else {
			// The Codex path is unchanged: three rows and an action.
			await bind(id, host);
			expect((await rowsOf(id)).managed?.managedState).toBe("pending");
		}
	});

	test("a host that doesn't advertise the Claude feature is host_cannot_run_claude, with nothing written", async () => {
		const host = await seedHost({
			capabilities: { ...CAPABILITIES, features: [ENFORCES_LAUNCH_PRIVILEGES, RESUMES_SESSIONS] },
		});
		const id = await seedObserved();
		expect(await refusal(bind(id, host))).toEqual({ code: "host_cannot_run_claude", status: 409 });
		expect((await actionsOn(id)).length).toBe(0);
	});

	test("a Claude-only host (no Codex feature at all) can take over", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		await bind(id, host);
		expect((await actionsOn(id)).length).toBe(1);
	});

	test("a session that was working a moment ago is session_active", async () => {
		const host = await seedHost();
		const id = await seedObserved({ isWorking: true });
		expect((await refusal(bind(id, host))).code).toBe("session_active");
		expect((await actionsOn(id)).length).toBe(0);
	});

	test("a second bind while the first is open is already_managed, and nothing is added", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const first = await bind(id, host);
		sessionsUsed.push((first.action.metadata as { forkSessionId: string }).forkSessionId);
		expect((await refusal(bind(id, host))).code).toBe("already_managed");
		expect((await actionsOn(id)).length).toBe(1);
	});

	test("two concurrent takeovers of one session: one action, one refusal", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const results = await Promise.allSettled([bind(id, host), bind(id, host)]);
		const ok = results.filter((r) => r.status === "fulfilled");
		expect(ok.length).toBe(1);
		const bad = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect((bad.reason as InstanceType<typeof BindRefusal>).code).toBe("already_managed");
		expect((await actionsOn(id)).length).toBe(1);
		for (const r of ok) {
			sessionsUsed.push(
				((r as PromiseFulfilledResult<any>).value.action.metadata as { forkSessionId: string })
					.forkSessionId,
			);
		}
	});
});

describe("authority at the bind", () => {
	test("a member of a different owner is refused; the owner takes their own session over a host they own", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		expect((await refusal(bind(id, host, MEMBER(t.bob.id)))).code).toMatch(
			/not_owner|session_not_found|host_not_allowed/,
		);
		expect((await actionsOn(id)).length).toBe(0);
		const result = await bind(id, host, MEMBER(t.alice.id));
		sessionsUsed.push((result.action.metadata as { forkSessionId: string }).forkSessionId);
		expect((await actionsOn(id)).length).toBe(1);
	});

	test("two different owners are refused for an admin too, and the foreign host's rows are byte-equal", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.bob.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const [hostBefore] = await getDb().select().from(supervisors).where(eq(supervisors.id, host));
		expect((await refusal(bind(id, host, ADMIN(t.admin.id)))).code).toBe("host_owner_mismatch");
		const [hostAfter] = await getDb().select().from(supervisors).where(eq(supervisors.id, host));
		expect(JSON.stringify(hostAfter)).toBe(JSON.stringify(hostBefore));
		expect((await actionsOn(id)).length).toBe(0);
	});
});

// ── H1: before the settle the fork does not exist ───────────────────────────

describe("before the settle the fork doesn't exist (H1)", () => {
	test("the owning host claims the action; no owner of record, row, launch or approval target exists for N, and S's owner of record is unchanged", async () => {
		const t = await team();
		const hostA = await seedHost({ ownerUserId: t.alice.id });
		const hostB = await seedHost({ ownerUserId: t.bob.id });
		const s = await started({ host: hostA, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
		// Another host's claim finds nothing.
		expect(await control.claimNextControlAction(hostB)).toBeNull();
		// No host owns N: B's reports about it are refused as a foreign or absent owner.
		expect(await ownership.resolveSessionOwner(getDb(), s.forkId)).toBeNull();
		await expect(ownership.assertSupervisorCanWriteSession(hostB, s.forkId)).rejects.toThrow();
		await expect(ownership.assertSupervisorCanWriteSession(hostA, s.forkId)).rejects.toThrow();
		await expectNoForkRows(s.forkId);
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test("a queued action past its deadline is failed at claim, not handed to the host", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const r = await bind(id, host);
		sessionsUsed.push((r.action.metadata as { forkSessionId: string }).forkSessionId);
		await getDb()
			.update(controlActions)
			.set({
				metadata: {
					...(r.action.metadata as object),
					forkDeadlineAt: new Date(Date.now() - MIN).toISOString(),
				},
			})
			.where(eq(controlActions.id, r.action.id));
		expect(await control.claimNextControlAction(host)).toBeNull();
		const [action] = await actionsOn(id);
		expect(action.status).toBe("failed");
		expect(String(action.error)).toContain("didn't answer in time");
	});
});

// ── the settle ───────────────────────────────────────────────────────────────

describe("the settle", () => {
	test("success writes N's session, carrier launch, managed row and first event; S is byte-equal; the answer is the action", async () => {
		const s = await started();
		const answer = await report(s, { permissionMode: "restricted" });
		expect(answer?.status).toBe("succeeded");

		const n = await rowsOf(s.forkId);
		expect(n.session).toMatchObject({
			agentType: "claude_code",
			cwd: CWD,
			ownerUserId: null,
			status: "idle",
			isWorking: false,
		});
		expect(n.session.displayName).toBe("refactor the parser (continued)");
		expect(n.session.metadata).toMatchObject({
			forkedFromSessionId: s.id,
			forkPermissionBranch: "restricted",
		});
		expect(n.launch).toMatchObject({
			status: "completed",
			agentType: "claude_code",
			requestedLaunchMode: "headless",
			claimedBySupervisorId: s.host,
			approvalPolicy: "manual",
			sandboxMode: null,
		});
		expect(n.launch.metadata).toMatchObject({
			boundObservedSession: true,
			sourceSessionId: s.id,
			permissionBranch: "restricted",
		});
		expect(n.managed).toMatchObject({
			managedState: "managed",
			providerThreadId: s.forkId,
			providerSessionId: s.forkId,
			supervisorId: s.host,
		});
		expect(n.events.map((e) => e.eventType)).toEqual(["ManagedSessionResumed"]);
		expect(await snapshot(s.id)).toBe(s.before);
		expect(await ownership.resolveSessionOwner(getDb(), s.forkId)).toBe(s.host);
		// S still has no managed row of its own: it can be taken again once N has ended.
		expect(await ownership.findManagedRowForThread(getDb(), s.id)).toBeNull();
	});

	test.each(["ask", "restricted"])(
		"the reported mode %s is stored once on N and on the carrier",
		async (mode) => {
			const s = await started();
			await report(s, { permissionMode: mode });
			const n = await rowsOf(s.forkId);
			expect((n.session.metadata as any).forkPermissionBranch).toBe(mode);
			expect((n.launch.metadata as any).permissionBranch).toBe(mode);
		},
	);

	test("a second takeover while N is live is already_managed; after N ends it is allowed and is named (continued 2)", async () => {
		const s = await started();
		await report(s);
		expect((await refusal(bind(s.id, s.host))).code).toBe("already_managed");
		await getDb()
			.update(managedSessions)
			.set({ managedState: "stopped" })
			.where(eq(managedSessions.sessionId, s.forkId));
		const again = await bind(s.id, s.host);
		const second = (again.action.metadata as { forkSessionId: string }).forkSessionId;
		sessionsUsed.push(second);
		await control.claimNextControlAction(s.host);
		await control.updateControlAction({
			actionId: again.action.id,
			supervisorId: s.host,
			status: "succeeded",
			provedCwd: CWD,
			permissionMode: "ask",
		});
		expect((await sessionRow(second)).displayName).toBe("refactor the parser (continued 2)");
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test("session_created for N and one revalidation are sent once; a failure to announce does not undo the settle", async () => {
		const s = await started();
		const created: string[] = [];
		const onCreated = (row: { sessionId: string }) => created.push(row.sessionId);
		sessionBus.on("session_created", onCreated);
		const revalidate = spyOn(wsRevalidation, "requestWsRevalidation");
		try {
			await report(s);
			expect(created.filter((id) => id === s.forkId).length).toBe(1);
			expect(revalidate.mock.calls.length).toBeGreaterThanOrEqual(1);
		} finally {
			sessionBus.off("session_created", onCreated);
			revalidate.mockRestore();
		}
		expect((await rowsOf(s.forkId)).managed?.managedState).toBe("managed");
	});

	test("an unowned S in team mode with an assigned owner: N gets the intended owner; S stays unowned", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const s = await started({ host, actor: ADMIN(t.admin.id) });
		await report(s);
		expect((await sessionRow(s.forkId)).ownerUserId).toBe(t.alice.id);
		expect((await sessionRow(s.id)).ownerUserId).toBeNull();
		expect(await snapshot(s.id)).toBe(s.before);
	});

	describe("every failed judgement leaves one failed action and no row for N", () => {
		test("a missing permissionMode", async () => {
			const s = await started();
			await report(s, { permissionMode: undefined });
			await failedWith(s, "couldn't start this");
		});
		test("an unknown permissionMode", async () => {
			const s = await started();
			await report(s, { permissionMode: "bypass" });
			await failedWith(s);
		});
		test("a provedCwd outside the host's trusted roots", async () => {
			const s = await started();
			await report(s, { provedCwd: "/etc" });
			await failedWith(s);
		});
		test("a candidate that is not inside provedCwd", async () => {
			const s = await started();
			await report(s, { provedCwd: "/work/elsewhere" });
			await failedWith(s);
		});
		test("a provedCwd that isn't absolute", async () => {
			const s = await started();
			await report(s, { provedCwd: "work/project" });
			await failedWith(s);
		});
		test("S's owner changes inside the window: ownership_changed", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await started({ host, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
			await getDb()
				.update(sessions)
				.set({ ownerUserId: t.bob.id })
				.where(eq(sessions.sessionId, s.id));
			const changed = await snapshot(s.id);
			await report(s);
			const [action] = await actionsOn(s.id);
			expect(action.status).toBe("failed");
			expect(String(action.error)).toContain("changed while it was starting");
			await expectNoForkRows(s.forkId);
			expect(await snapshot(s.id)).toBe(changed);
		});
		test("an unowned S fills an owner inside the window", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await started({ host, actor: ADMIN(t.admin.id) });
			await getDb()
				.update(sessions)
				.set({ ownerUserId: t.alice.id })
				.where(eq(sessions.sessionId, s.id));
			await report(s);
			expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
			await expectNoForkRows(s.forkId);
		});
		test("the intended owner is disabled", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await started({ host, actor: ADMIN(t.admin.id) });
			await getDb()
				.update(users)
				.set({ disabledAt: new Date().toISOString() })
				.where(eq(users.id, t.alice.id));
			await report(s);
			expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
			await expectNoForkRows(s.forkId);
		});
		test("the binder loses the admin role", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await started({ host, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
			await getDb().update(users).set({ role: "user" }).where(eq(users.id, t.admin.id));
			await report(s);
			expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
			await expectNoForkRows(s.forkId);
		});
		test("the host's owner changes to someone S's owner is not", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await started({ host, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
			await getDb()
				.update(supervisors)
				.set({ ownerUserId: t.bob.id })
				.where(eq(supervisors.id, host));
			await report(s);
			expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
			await expectNoForkRows(s.forkId);
		});
		test("the binder is the host's owner, then loses the admin role: an unowned S is no longer theirs to take over", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			// An admin who owns the host binds an unowned session; the role is withdrawn before the settle.
			await getDb().update(users).set({ role: "admin" }).where(eq(users.id, t.alice.id));
			const s = await started({ host, actor: ADMIN(t.alice.id) });
			await getDb().update(users).set({ role: "user" }).where(eq(users.id, t.alice.id));
			await report(s);
			expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
			await expectNoForkRows(s.forkId);
		});
		test("a provedCwd above the trusted root that contains the candidate is still outside the roots", async () => {
			const s = await started();
			await report(s, { provedCwd: "/" });
			await failedWith(s);
		});
		test("S deleted before the settle", async () => {
			const s = await started();
			await getDb().delete(sessions).where(eq(sessions.sessionId, s.id));
			// The action goes with the session it is about; a late report finds nothing to settle.
			expect(await report(s)).toBeNull();
			await expectNoForkRows(s.forkId);
		});
		test("a row already named N: the settle fails with its own words, and that row is unchanged (hook-before-row race)", async () => {
			const s = await started();
			await getDb().insert(sessions).values({
				sessionId: s.forkId,
				agentType: "claude_code",
				cwd: "/somewhere/else",
				displayName: "forged by a hook",
			});
			const forged = await snapshot(s.forkId);
			await report(s);
			const [action] = await actionsOn(s.id);
			expect(action.status).toBe("failed");
			expect(String(action.error)).toContain("couldn't set this up");
			expect(await snapshot(s.forkId)).toBe(forged);
			const n = await rowsOf(s.forkId);
			expect({ l: !!n.launch, m: !!n.managed }).toEqual({ l: false, m: false });
			expect(await snapshot(s.id)).toBe(s.before);
		});
		test("a launch row already holding the carrier id rolls the whole settle back, N's session row included", async () => {
			const s = await started();
			const carrier = ((await actionsOn(s.id))[0].metadata as any).carrierLaunchId as string;
			const other = crypto.randomUUID();
			sessionsUsed.push(other);
			await getDb()
				.insert(launchRequests)
				.values({
					id: carrier,
					launchCorrelationId: other,
					agentType: "claude_code",
					cwd: CWD,
					baseInstructions: "",
					taskPrompt: "",
					approvalPolicy: "manual",
					requestedLaunchMode: "headless",
					env: {},
					launchSpec: {},
					requestedBy: "x",
					status: "completed",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				} as never);
			await report(s);
			expect((await actionsOn(s.id))[0].status).toBe("failed");
			expect((await sessionRow(s.forkId)) === undefined).toBe(true);
			expect((await rowsOf(s.forkId)).managed).toBeUndefined();
			await getDb().delete(launchRequests).where(eq(launchRequests.id, carrier));
		});
	});

	test("a failure the host reports itself fails the action and leaves no rows", async () => {
		const s = await started();
		await control.updateControlAction({
			actionId: s.actionId,
			supervisorId: s.host,
			status: "failed",
			error: "the host's words",
		});
		await failedWith(s, "the host's words");
	});

	test("another host's report on the action is ignored", async () => {
		const s = await started();
		const other = await seedHost();
		expect(
			await control.updateControlAction({
				actionId: s.actionId,
				supervisorId: other,
				status: "succeeded",
				provedCwd: CWD,
				permissionMode: "ask",
			}),
		).toBeNull();
		await expectNoForkRows(s.forkId);
	});
});

// ── the deadline, registration, and the lost answer ─────────────────────────

describe("deadline and restart", () => {
	test("queued and running actions both fail past the deadline; a late success then changes nothing and writes no rows", async () => {
		const host = await seedHost();
		const queuedId = await seedObserved();
		const queued = await bind(queuedId, host);
		sessionsUsed.push((queued.action.metadata as any).forkSessionId);
		const runningId = await seedObserved();
		const running = await bind(runningId, host);
		const runningFork = (running.action.metadata as any).forkSessionId as string;
		sessionsUsed.push(runningFork);
		await control.claimNextControlAction(host);
		await control.claimNextControlAction(host);

		expect(await control.sweepExpiredResumeActions(Date.now() + 120_000)).toBeGreaterThanOrEqual(2);
		expect((await actionsOn(queuedId))[0].status).toBe("failed");
		expect((await actionsOn(runningId))[0].status).toBe("failed");

		const late = await control.updateControlAction({
			actionId: (await actionsOn(runningId))[0].id,
			supervisorId: host,
			status: "succeeded",
			provedCwd: CWD,
			permissionMode: "ask",
		});
		expect(late?.status).toBe("failed");
		await expectNoForkRows(runningFork);
	});

	test("an action inside its deadline is left alone by the sweep", async () => {
		const s = await started();
		await control.sweepExpiredResumeActions(Date.now());
		expect((await actionsOn(s.id))[0].status).toBe("running");
	});

	test("registration fails the host's claimed takeover actions by claimant and leaves its queued ones", async () => {
		const s = await started();
		const queuedId = await seedObserved();
		// Same host, a second session: queued, unclaimed. It must exist, or the assertion below proves nothing.
		const queued = await bind(queuedId, s.host);
		sessionsUsed.push((queued.action.metadata as any).forkSessionId);
		expect((await actionsOn(queuedId))[0].status).toBe("queued");
		expect(await control.failOpenForkActionsOfRestartedHost(s.host)).toBe(1);
		expect((await actionsOn(s.id))[0].status).toBe("failed");
		expect(String((await actionsOn(s.id))[0].error)).toContain("restarted");
		expect((await actionsOn(queuedId))[0].status).toBe("queued");
		await expectNoForkRows(s.forkId);
	});
});

// ── restart degrades the forks ───────────────────────────────────────────────

describe("registration degrades a restarted host's forks (P3-I19)", () => {
	test("a managed fork becomes degraded with the fork marker, stops reading as working, and its open prompt fails; a second restart writes nothing", async () => {
		const s = await started();
		await report(s);
		await getDb().update(sessions).set({ isWorking: true }).where(eq(sessions.sessionId, s.forkId));
		const changed = await managedState.degradeClaudeForksOfRestartedHost(s.host);
		expect(changed).toEqual([s.forkId]);
		const n = await rowsOf(s.forkId);
		expect(n.managed).toMatchObject({ managedState: "degraded", providerSyncState: "failed" });
		expect(String(n.managed.providerSyncError)).toContain("Claude process is gone");
		expect(n.session.isWorking).toBe(false);
		expect(await managedState.degradeClaudeForksOfRestartedHost(s.host)).toEqual([]);
		// S is not a fork and not managed: untouched.
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test("a launched (not forked) Claude session of the host is not degraded by it", async () => {
		const host = await seedHost();
		const id = crypto.randomUUID();
		sessionsUsed.push(id);
		await getDb().insert(sessions).values({ sessionId: id, agentType: "claude_code", cwd: CWD });
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: id,
				launchRequestId: id,
				supervisorId: host,
				managedState: "managed",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			} as never);
		expect(await managedState.degradeClaudeForksOfRestartedHost(host)).toEqual([]);
	});

	test("a prompt queued for a degraded fork is refused as not continuable, with nothing queued", async () => {
		const s = await started();
		await report(s);
		await managedState.degradeClaudeForksOfRestartedHost(s.host);
		await expect(control.queuePromptAction(s.forkId, "go on", SOLO)).rejects.toThrow(
			"can't take more prompts",
		);
		expect((await actionsOn(s.forkId)).filter((a) => a.actionType === "prompt").length).toBe(0);
	});
});

// ── the host-feature gates (P3-I17) ──────────────────────────────────────────

describe("the Claude feature gates fork prompts at enqueue, claim and deliverability (P3-I17)", () => {
	async function settledFork() {
		const s = await started();
		await report(s);
		return s;
	}
	const WITHOUT = {
		...CAPABILITIES,
		features: CAPABILITIES.features.filter((f) => f !== CLAUDE_TAKEOVER),
	};

	test("with the feature a prompt is accepted; without it, refused host_upgrade_required, nothing queued", async () => {
		const s = await settledFork();
		const ok = await control.queuePromptAction(s.forkId, "hello", SOLO);
		expect(ok.status).toBe("queued");
		await getDb().delete(controlActions).where(eq(controlActions.sessionId, s.forkId));
		await getDb()
			.update(managedSessions)
			.set({ activeControlActionId: null, controlLockExpiresAt: null })
			.where(eq(managedSessions.sessionId, s.forkId));
		await getDb()
			.update(supervisors)
			.set({ capabilities: WITHOUT })
			.where(eq(supervisors.id, s.host));
		await expect(control.queuePromptAction(s.forkId, "hello", SOLO)).rejects.toThrow(
			/older supervisor|update/i,
		);
		expect((await actionsOn(s.forkId)).length).toBe(0);
	});

	test("a prompt queued before the host lost the feature fails at claim instead of being handed over", async () => {
		const s = await settledFork();
		const queued = await control.queuePromptAction(s.forkId, "hello", SOLO);
		expect(queued.status).toBe("queued");
		await getDb()
			.update(supervisors)
			.set({ capabilities: WITHOUT })
			.where(eq(supervisors.id, s.host));
		expect(await control.claimNextControlAction(s.host)).toBeNull();
		const [prompt] = (await actionsOn(s.forkId)).filter((a) => a.actionType === "prompt");
		expect(prompt.status).toBe("failed");
	});

	test("deliverability says the host needs an upgrade exactly when it lacks the feature", async () => {
		const s = await settledFork();
		expect(await control.promptNeedsHostUpgrade(getDb(), s.forkId)).toBe(false);
		await getDb()
			.update(supervisors)
			.set({ capabilities: WITHOUT })
			.where(eq(supervisors.id, s.host));
		expect(await control.promptNeedsHostUpgrade(getDb(), s.forkId)).toBe(true);
	});

	test("a claim for a Claude resume needs the Claude feature; a host with only the Codex one is told to upgrade", async () => {
		const host = await seedHost({
			capabilities: { ...CAPABILITIES, features: [RESUMES_SESSIONS, ENFORCES_LAUNCH_PRIVILEGES] },
		});
		const id = await seedObserved();
		// Bound while the host advertised the feature, then it was replaced by a build without it.
		await getDb()
			.update(supervisors)
			.set({ capabilities: CAPABILITIES })
			.where(eq(supervisors.id, host));
		const r = await bind(id, host);
		sessionsUsed.push((r.action.metadata as any).forkSessionId);
		await getDb()
			.update(supervisors)
			.set({ capabilities: { ...CAPABILITIES, features: [RESUMES_SESSIONS] } })
			.where(eq(supervisors.id, host));
		expect(await control.claimNextControlAction(host)).toBeNull();
		expect(String((await actionsOn(id))[0].error)).toContain("older supervisor");
	});
});

// ── delete and archive (T17) ────────────────────────────────────────────────

describe("delete and archive of a fork (T17)", () => {
	test.each([
		["pending", true],
		["managed", true],
		["degraded", true],
		["stopped", false],
		["failed", false],
		["completed", false],
	])("a fork in %s: refused=%s", async (state, refused) => {
		const s = await started();
		await report(s);
		await getDb()
			.update(managedSessions)
			.set({ managedState: state })
			.where(eq(managedSessions.sessionId, s.forkId));
		for (const check of [authz.assertCanDeleteSession, authz.assertCanArchiveSession]) {
			const promise = check(SOLO, s.forkId);
			if (refused) {
				expect(await refusal(promise)).toEqual({ code: "end_session_first", status: 409 });
			} else {
				await promise;
			}
		}
	});

	test("a host that is gone lifts the refusal; an offline one keeps it", async () => {
		const s = await started();
		await report(s);
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() - MIN).toISOString() })
			.where(eq(supervisors.id, s.host));
		expect((await refusal(authz.assertCanDeleteSession(SOLO, s.forkId))).code).toBe(
			"end_session_first",
		);
		await getDb()
			.update(supervisors)
			.set({ enrollmentState: "revoked" })
			.where(eq(supervisors.id, s.host));
		await authz.assertCanDeleteSession(SOLO, s.forkId);
	});

	test("the observed session itself is refused only while its takeover is open", async () => {
		const s = await started();
		expect(await refusal(authz.assertCanArchiveSession(SOLO, s.id))).toEqual({
			code: "takeover_in_progress",
			status: 409,
		});
		await report(s);
		await authz.assertCanDeleteSession(SOLO, s.id);
	});
});

// ── recovery of a fork ───────────────────────────────────────────────────────

describe("recovery of a fork", () => {
	test("a degraded fork queues a recovery action on N, naming no mode; a managed one is not_resumable", async () => {
		const s = await started();
		await report(s);
		expect((await refusal(queueSessionResume(s.forkId, SOLO, deps))).code).toBe("not_resumable");
		await managedState.degradeClaudeForksOfRestartedHost(s.host);
		const result = await queueSessionResume(s.forkId, SOLO, deps);
		const meta = result.action.metadata as Record<string, any>;
		expect(meta).toMatchObject({
			resumeKind: "recovery",
			agentType: "claude_code",
			threadId: s.forkId,
			expectedEnforcedArgs: ["--permission-mode", "default"],
		});
		expect(meta.permissionMode).toBeUndefined();
		expect(meta.forkSessionId).toBeUndefined();
		const open = (await actionsOn(s.forkId)).filter((a) => a.actionType === "resume");
		expect(open.length).toBe(1);
		// The recovery is claimed by the owner-of-record join (N has a managed row) and refused if the host
		// lacks the feature.
		const claimed = await control.claimNextControlAction(s.host);
		expect(claimed?.id).toBe(result.action.id);
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test("a launched Claude session that is not a fork is never resumed through this path", async () => {
		const host = await seedHost();
		const id = crypto.randomUUID();
		sessionsUsed.push(id);
		await getDb().insert(sessions).values({ sessionId: id, agentType: "claude_code", cwd: CWD });
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: id,
				launchRequestId: id,
				supervisorId: host,
				managedState: "degraded",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			} as never);
		expect((await refusal(queueSessionResume(id, SOLO, deps))).code).toBe("not_resumable");
	});
});

// ── a forged mode and metadata can't be injected by a client ────────────────

describe("what a client can't choose", () => {
	test("the action carries no mode and no client field reaches it: the bind's keys are the service's own", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await bindObservedSession(
			id,
			{ targetSupervisorId: host, sameMachineConfirmed: true, dialogBranch: "restricted" } as never,
			SOLO,
			deps,
		);
		sessionsUsed.push((result.action.metadata as any).forkSessionId);
		const meta = result.action.metadata as Record<string, unknown>;
		expect(meta.permissionMode).toBeUndefined();
		expect(meta.dialogBranch).toBeUndefined();
	});
});

// ── review round: the settle window, races, D6, H1 exact codes ──────────────

const PG = process.env.AGENTPULSE_TEST_BACKEND === "postgres";

async function settleWith(s: Started, afterFlip: (tx: any) => Promise<void>) {
	const [action] = await actionsOn(s.id);
	return control.completeResumeAction(null, action, {
		fork: { provedCwd: CWD, permissionMode: "ask" },
		afterFlip,
	});
}

describe("the re-judge reads inside the settle's own transaction (P5-T4)", () => {
	test("S's owner changing inside the window fails the settle and writes nothing", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const s = await started({ host, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
		const outcome = await settleWith(s, async (tx) => {
			await tx.update(sessions).set({ ownerUserId: t.bob.id }).where(eq(sessions.sessionId, s.id));
		});
		expect(outcome).toMatchObject({ settled: true, outcome: "failed" });
		expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
		await expectNoForkRows(s.forkId);
	});

	test("the intended owner deleted inside the window ('owner gone') fails it", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const s = await started({ host, actor: ADMIN(t.admin.id) });
		// The host's owner was the intended owner of the unowned session; remove them inside the window.
		const outcome = await settleWith(s, async (tx) => {
			await tx.update(supervisors).set({ ownerUserId: null }).where(eq(supervisors.id, host));
			await tx.delete(users).where(eq(users.id, t.alice.id));
		});
		expect(outcome).toMatchObject({ settled: true, outcome: "failed" });
		await expectNoForkRows(s.forkId);
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test("with nothing changed inside the window the same seam settles (the control)", async () => {
		const s = await started();
		const outcome = await settleWith(s, async () => {});
		expect(outcome).toMatchObject({ settled: true, outcome: "succeeded", forkId: s.forkId });
	});
});

describe("racing settles", () => {
	test("two settles of one action: exactly one writes N's rows", async () => {
		const s = await started();
		const [a, b] = await Promise.all([report(s), report(s)]);
		expect([a?.status, b?.status].filter((x) => x === "succeeded").length).toBeGreaterThanOrEqual(
			1,
		);
		const n = await rowsOf(s.forkId);
		expect(n.events.length).toBe(1);
		expect(n.managed?.managedState).toBe("managed");
		expect((await actionsOn(s.id))[0].status).toBe("succeeded");
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test.skipIf(!PG)(
		"a settle racing a delete of S on two Postgres connections: all of it or none of it",
		async () => {
			for (let i = 0; i < 5; i++) {
				const s = await started();
				await Promise.allSettled([
					report(s),
					getDb().delete(sessions).where(eq(sessions.sessionId, s.id)),
				]);
				const n = await rowsOf(s.forkId);
				const [action] = await actionsOn(s.id);
				if (n.session) {
					// The settle won: everything of N exists, and the action says so (or went with S).
					expect(!!n.launch && !!n.managed).toBe(true);
					if (action) expect(action.status).toBe("succeeded");
				} else {
					expect({ l: !!n.launch, m: !!n.managed }).toEqual({ l: false, m: false });
				}
			}
		},
	);
});

describe("the owner N gets (D6), by what S and the host were", () => {
	test("an unowned S on an unowned host, taken over by an admin: the binder", async () => {
		const t = await team();
		const host = await seedHost();
		const s = await started({ host, actor: ADMIN(t.admin.id) });
		await report(s);
		expect((await sessionRow(s.forkId)).ownerUserId).toBe(t.admin.id);
		expect((await sessionRow(s.id)).ownerUserId).toBeNull();
	});

	test("an owned S: its owner, whoever the admin is and whoever owns the host", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const s = await started({ host, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
		await report(s);
		expect((await sessionRow(s.forkId)).ownerUserId).toBe(t.alice.id);
		expect(await snapshot(s.id)).toBe(s.before);
	});

	test("solo: N has no owner", async () => {
		const s = await started();
		await report(s);
		expect((await sessionRow(s.forkId)).ownerUserId).toBeNull();
	});

	test("a member's takeover whose key no longer belongs to the host's owner fails at the settle too (parity with the bind)", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const s = await started({ host, actor: MEMBER(t.alice.id), ownerUserId: t.alice.id });
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, s.id));
		await getDb()
			.update(sessions)
			.set({ ingestKeyId: (await seedKey("other", ["ingest"], t.bob.id)).id })
			.where(eq(sessions.sessionId, s.id));
		expect(row.ingestKeyId).not.toBeNull();
		const changed = await snapshot(s.id);
		await report(s);
		expect(String((await actionsOn(s.id))[0].error)).toContain("changed while it was starting");
		await expectNoForkRows(s.forkId);
		expect(await snapshot(s.id)).toBe(changed);
	});
});

describe("before the settle, as the host's owner and as another host see N (Codex-H1 exact codes)", () => {
	test("a state report is no_owner, an approval report is session_unknown, and no row exists to read", async () => {
		const t = await team();
		const hostA = await seedHost({ ownerUserId: t.alice.id });
		const hostB = await seedHost({ ownerUserId: t.bob.id });
		const s = await started({ host: hostA, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
		for (const host of [hostA, hostB]) {
			await expect(ownership.assertSupervisorCanWriteSession(host, s.forkId)).rejects.toMatchObject(
				{
					name: "SessionOwnershipError",
					reason: "no_owner",
				},
			);
		}
		const { recordApprovalRequest } = await import("./codex-approvals.js");
		await expect(recordApprovalRequest(hostA, s.forkId, {} as never)).rejects.toMatchObject({
			code: "session_unknown",
		});
		expect(await sessionRow(s.forkId)).toBeUndefined();
	});
});

describe("registration and the open actions of a stamped fork (P5-B5)", () => {
	test("a recovery in flight on an already-stamped fork ends through the resume settle, with the resume words", async () => {
		const s = await started();
		await report(s);
		await managedState.degradeClaudeForksOfRestartedHost(s.host);
		const recovery = await queueSessionResume(s.forkId, SOLO, deps);
		await control.claimNextControlAction(s.host);
		// A second restart: nothing new to degrade, but the open recovery's process is gone.
		expect(await managedState.degradeClaudeForksOfRestartedHost(s.host)).toEqual([]);
		const [row] = (await actionsOn(s.forkId)).filter((a) => a.id === recovery.action.id);
		expect(row.status).toBe("failed");
		expect(String(row.error)).toContain("restarted before it finished");
		expect(row.finishedAt).not.toBeNull();
	});
});

describe("what a reader of the actions sees (P5-I8)", () => {
	test("the user ids in a takeover action are not served", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const s = await started({ host, actor: ADMIN(t.admin.id), ownerUserId: t.alice.id });
		const rows = await control.listControlActionsForSession(s.id);
		const meta = JSON.stringify(rows.map((r) => r.metadata));
		for (const id of [t.alice.id, t.admin.id]) expect(meta).not.toContain(id);
		expect(meta).toContain(s.forkId);
	});
});

describe("a bind to a host that isn't on macOS is refused (P5-I9)", () => {
	test("host_cannot_run_claude, nothing queued", async () => {
		const host = await seedHost({
			capabilities: { ...CAPABILITIES, os: "linux" },
		});
		const id = await seedObserved();
		expect(await refusal(bind(id, host))).toEqual({ code: "host_cannot_run_claude", status: 409 });
		expect((await actionsOn(id)).length).toBe(0);
	});
});

describe("announcing a queued takeover (P5-I3)", () => {
	test("S is announced once as updated, with its row unchanged", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const before = await snapshot(id);
		const seen: string[] = [];
		const on = (row: { sessionId: string }) => seen.push(row.sessionId);
		sessionBus.on("session_updated", on);
		try {
			const r = await bind(id, host);
			sessionsUsed.push((r.action.metadata as any).forkSessionId);
		} finally {
			sessionBus.off("session_updated", on);
		}
		expect(seen.filter((x) => x === id).length).toBe(1);
		expect(await snapshot(id)).toBe(before);
	});
});

// ── fork options (AGEN-119..123 Track 0): the bind body, the rule, the stored value, recovery ──────────────

describe("fork options", () => {
	const { FORK_OPTIONS_OFF } = sharedResume;
	const APPLIED = {
		mcpServers: [{ name: "probe", digest: "a".repeat(64) }],
		subagents: true,
		claudeVersion: "2.1.319",
	};

	function bindWith(
		id: string,
		host: string,
		actor: Actor,
		forkOptions?: { mcp?: boolean; subagents?: boolean },
	) {
		return bindObservedSession(
			id,
			{
				targetSupervisorId: host,
				sameMachineConfirmed: true,
				...(forkOptions ? { forkOptions } : {}),
			},
			actor,
			deps,
		);
	}

	async function claimed(id: string, host: string, actor: Actor, forkOptions?: object) {
		const result = await bindWith(id, host, actor, forkOptions);
		const forkId = (result.action.metadata as Record<string, string>).forkSessionId as string;
		sessionsUsed.push(forkId);
		expect((await control.claimNextControlAction(host))?.id).toBe(result.action.id);
		return { id, host, forkId, actionId: result.action.id, before: await snapshot(id) } as Started;
	}

	const storedOptions = async (forkId: string) =>
		((await sessionRow(forkId)).metadata as Record<string, unknown>).forkOptions;

	test("a bind without options carries none, and the settle stores FORK_OPTIONS_OFF when the host reports nothing", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const s = await claimed(id, host, SOLO);
		const [action] = await actionsOn(id);
		expect(action?.metadata).not.toHaveProperty("forkOptions");
		await report(s);
		expect(await storedOptions(s.forkId)).toEqual(FORK_OPTIONS_OFF);
	});

	test("the options asked for reach the host in the action's metadata, and only those two keys", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await bindWith(id, host, SOLO, { mcp: true });
		sessionsUsed.push((result.action.metadata as Record<string, string>).forkSessionId as string);
		expect((result.action.metadata as Record<string, unknown>).forkOptions).toEqual({ mcp: true });
	});

	test("what the host reports it applied is stored, judged for shape; a malformed report stores none", async () => {
		const host = await seedHost();
		const a = await claimed(await seedObserved(), host, SOLO, { mcp: true, subagents: true });
		await report(a, { applied: APPLIED });
		expect(await storedOptions(a.forkId)).toEqual(APPLIED);

		for (const bad of [
			{ ...APPLIED, extra: 1 },
			{ ...APPLIED, mcpServers: [{ name: "bad name!", digest: "a".repeat(64) }] },
			{ ...APPLIED, mcpServers: [{ name: "probe", digest: "short" }] },
			{ ...APPLIED, subagents: "yes" },
			"nonsense",
		]) {
			const s = await claimed(await seedObserved(), host, SOLO, { mcp: true, subagents: true });
			await report(s, { applied: bad });
			expect(await storedOptions(s.forkId), JSON.stringify(bad)).toEqual(FORK_OPTIONS_OFF);
		}
	});

	test("recovery carries the stored value in the resume action's metadata; a session from before the options reads as none", async () => {
		const host = await seedHost();
		const s = await claimed(await seedObserved(), host, SOLO, { mcp: true, subagents: true });
		await report(s, { applied: APPLIED });
		await managedState.degradeClaudeForksOfRestartedHost(host);
		const result = await queueSessionResume(s.forkId, SOLO, deps);
		expect((result.action.metadata as Record<string, unknown>).storedForkOptions).toEqual(APPLIED);

		// The same fork as an older server left it: no forkOptions key on the session.
		const old = await claimed(await seedObserved(), host, SOLO);
		await report(old);
		await getDb()
			.update(sessions)
			.set({ metadata: { forkedFromSessionId: old.id, forkPermissionBranch: "ask" } })
			.where(eq(sessions.sessionId, old.forkId));
		await managedState.degradeClaudeForksOfRestartedHost(host);
		const again = await queueSessionResume(old.forkId, SOLO, deps);
		expect((again.action.metadata as Record<string, unknown>).storedForkOptions).toEqual(
			FORK_OPTIONS_OFF,
		);
	});

	test("a supervisor report can't write the stored options onto a session", async () => {
		const host = await seedHost();
		const s = await claimed(await seedObserved(), host, SOLO);
		await report(s);
		await managedState.upsertManagedSessionState(host, {
			sessionId: s.forkId,
			agentType: "claude_code",
			status: "active",
			metadata: { forkOptions: APPLIED },
		});
		expect(await storedOptions(s.forkId)).toEqual(FORK_OPTIONS_OFF);
	});

	test("only the bind, the settle, the approval-report check (a read) and the supervisor-report filter name forkOptions in server code (no hook, rename or native-name path writes it)", () => {
		const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
		const { join, relative } = require("node:path") as typeof import("node:path");
		const root = join(import.meta.dir, "..");
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
					if (readFileSync(full, "utf8").includes("forkOptions")) found.push(relative(root, full));
				}
			}
		};
		walk(root);
		// codex-approvals.ts, authorization.ts and control-actions.ts only read it (which MCP servers a report may
		// name, and whether the options need the consenting owner to drive the fork).
		expect(found.sort()).toEqual([
			"routes/sessions.ts",
			"services/authorization.ts",
			"services/claude-takeover-settle.ts",
			"services/codex-approvals.ts",
			"services/control-actions.ts",
			"services/managed-session-state.ts",
			"services/session-binding.ts",
		]);
	});

	describe("who may use them (C-H4)", () => {
		test("solo may, with or without options", async () => {
			const host = await seedHost();
			const id = await seedObserved();
			await bindWith(id, host, SOLO, { mcp: true, subagents: true }).then((r) =>
				sessionsUsed.push((r.action.metadata as Record<string, string>).forkSessionId as string),
			);
		});

		test("in team mode an admin binding an unowned session to a member's host: fine without options, 403 with either", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const refusedMcp = await refusal(
				bindWith(await seedObserved(), host, ADMIN(t.admin.id), { mcp: true }),
			);
			expect(refusedMcp).toEqual({ code: "fork_options_host_not_yours", status: 403 });
			const refusedSub = await refusal(
				bindWith(await seedObserved(), host, ADMIN(t.admin.id), { subagents: true }),
			);
			expect(refusedSub.code).toBe("fork_options_host_not_yours");
			// Positive control: the same bind without options succeeds, and "asking for none" is none.
			const ok = await bindWith(await seedObserved(), host, ADMIN(t.admin.id));
			sessionsUsed.push((ok.action.metadata as Record<string, string>).forkSessionId as string);
			const none = await bindWith(await seedObserved(), host, ADMIN(t.admin.id), {});
			sessionsUsed.push((none.action.metadata as Record<string, string>).forkSessionId as string);
			const falsy = await bindWith(await seedObserved(), host, ADMIN(t.admin.id), { mcp: false });
			sessionsUsed.push((falsy.action.metadata as Record<string, string>).forkSessionId as string);
		});

		test("a member on their own host passes; on an ownerless host an admin is refused", async () => {
			const t = await team();
			const own = await seedHost({ ownerUserId: t.alice.id });
			const id = await seedObserved({ ownerUserId: t.alice.id });
			const ok = await bindWith(id, own, MEMBER(t.alice.id), { mcp: true, subagents: true });
			sessionsUsed.push((ok.action.metadata as Record<string, string>).forkSessionId as string);

			const ownerless = await seedHost();
			const refused = await refusal(
				bindWith(await seedObserved(), ownerless, ADMIN(t.admin.id), { subagents: true }),
			);
			expect(refused.code).toBe("fork_options_host_not_yours");
			expect(authz.mayUseForkOptionsOnHost(ADMIN(t.admin.id), "team", null)).toBe(
				"fork_options_host_not_yours",
			);
			expect(
				authz.mayUseForkOptionsOnHost(MEMBER(t.alice.id), "team", { ownerUserId: t.alice.id }),
			).toBeNull();
			expect(
				authz.mayUseForkOptionsOnHost(
					{ userId: null, label: "anonymous", role: "admin", mode: "team" },
					"team",
					{ ownerUserId: null },
				),
			).toBe("fork_options_host_not_yours");
		});

		test("the settle judges it again: a host that changed hands before the host reported fails the takeover", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const id = await seedObserved({ ownerUserId: t.alice.id });
			const s = await claimed(id, host, MEMBER(t.alice.id), { mcp: true });
			await getDb()
				.update(supervisors)
				.set({ ownerUserId: t.bob.id })
				.where(eq(supervisors.id, host));
			await report(s, { applied: APPLIED });
			await failedWith(s);
		});

		test("the settle's options rule stands on its own: an admin's host that lost its owner fails the takeover though an admin may use any host", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.admin.id });
			const s = await claimed(await seedObserved(), host, ADMIN(t.admin.id), { subagents: true });
			await getDb().update(supervisors).set({ ownerUserId: null }).where(eq(supervisors.id, host));
			await report(s, { applied: APPLIED });
			await failedWith(s);
			// Positive control: the same takeover without options settles on an ownerless host.
			const host2 = await seedHost({ ownerUserId: t.admin.id });
			const ok = await claimed(await seedObserved(), host2, ADMIN(t.admin.id));
			await getDb().update(supervisors).set({ ownerUserId: null }).where(eq(supervisors.id, host2));
			expect((await report(ok))?.status).toBe("succeeded");
		});

		test("options on a Codex session are refused fork_options_not_supported (409)", async () => {
			const host = await seedHost({
				capabilities: {
					...CAPABILITIES,
					agentTypes: ["claude_code", "codex_cli"],
					launchModes: ["headless", "managed_codex"],
					features: [
						CLAUDE_TAKEOVER,
						ENFORCES_LAUNCH_PRIVILEGES,
						RESUMES_SESSIONS,
						CODEX_FOLLOW_UP_PROMPTS,
					],
					executables: {
						...CAPABILITIES.executables,
						codex: {
							available: true,
							command: "codex",
							resolvedPath: "/usr/bin/codex",
							source: "auto",
						},
					},
				},
			});
			const id = await seedObserved({ agentType: "codex_cli" });
			expect(await refusal(bindWith(id, host, SOLO, { mcp: true }))).toEqual({
				code: "fork_options_not_supported",
				status: 409,
			});
			// Positive control: the same Codex session binds without options.
			const ok = await bindWith(id, host, SOLO);
			sessionsUsed.push((ok.action.metadata as Record<string, string>).forkSessionId as string);
		});
	});

	describe("the host's report is held to the request (codex-M1)", () => {
		test("a bind that asked for nothing stores nothing the host says it applied", async () => {
			const host = await seedHost();
			const s = await claimed(await seedObserved(), host, SOLO);
			await report(s, { applied: APPLIED });
			expect(await storedOptions(s.forkId)).toEqual({
				...FORK_OPTIONS_OFF,
				claudeVersion: "2.1.319",
			});
			const meta = (await sessionRow(s.forkId)).metadata as Record<string, unknown>;
			expect(meta.forkOptionsConsentUserId).toBeUndefined();
		});

		test("an option that was asked for stays; one that wasn't is forced off", async () => {
			const host = await seedHost();
			const s = await claimed(await seedObserved(), host, SOLO, { subagents: true });
			await report(s, { applied: APPLIED });
			expect(await storedOptions(s.forkId)).toEqual({ ...APPLIED, mcpServers: [] });
			const m = await claimed(await seedObserved(), host, SOLO, { mcp: true });
			await report(m, { applied: APPLIED });
			expect(await storedOptions(m.forkId)).toEqual({ ...APPLIED, subagents: false });
		});

		test("the consenting host owner is recorded in team mode when options run, and not otherwise", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await claimed(
				await seedObserved({ ownerUserId: t.alice.id }),
				host,
				MEMBER(t.alice.id),
				{
					mcp: true,
				},
			);
			await report(s, { applied: APPLIED });
			const meta = (await sessionRow(s.forkId)).metadata as Record<string, unknown>;
			expect(meta.forkOptionsConsentUserId).toBe(t.alice.id);
			const none = await claimed(
				await seedObserved({ ownerUserId: t.alice.id }),
				host,
				MEMBER(t.alice.id),
			);
			await report(none);
			expect(
				((await sessionRow(none.forkId)).metadata as Record<string, unknown>)
					.forkOptionsConsentUserId,
			).toBeUndefined();
		});
	});

	describe("only the consenting host owner drives a fork's options (H1)", () => {
		// A bind can't create the split by itself (host_owner_mismatch keeps a host's owner and the session's owner
		// equal), so it arises when an admin later hands the fork to someone else. The consent stays with the owner
		// who gave it.
		async function handedOverFork() {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await claimed(
				await seedObserved({ ownerUserId: t.alice.id }),
				host,
				MEMBER(t.alice.id),
				{
					mcp: true,
					subagents: true,
				},
			);
			await report(s, { applied: APPLIED });
			await getDb()
				.update(sessions)
				.set({ ownerUserId: t.bob.id })
				.where(eq(sessions.sessionId, s.forkId));
			return { t, host, s };
		}

		test("resume: the new owner and an admin are refused with the stable code; the consenting owner is not", async () => {
			const { t, host, s } = await handedOverFork();
			await managedState.degradeClaudeForksOfRestartedHost(host);
			expect(await refusal(queueSessionResume(s.forkId, MEMBER(t.bob.id), deps))).toEqual({
				code: "fork_options_host_not_yours",
				status: 403,
			});
			expect((await refusal(queueSessionResume(s.forkId, ADMIN(t.admin.id), deps))).code).toBe(
				"fork_options_host_not_yours",
			);
			expect((await actionsOn(s.forkId)).filter((a) => a.actionType === "resume").length).toBe(0);
			// Positive control: handed back, the consenting owner queues it.
			await getDb()
				.update(sessions)
				.set({ ownerUserId: t.alice.id })
				.where(eq(sessions.sessionId, s.forkId));
			const ok = await queueSessionResume(s.forkId, MEMBER(t.alice.id), deps);
			expect(ok.action.actionType).toBe("resume");
		});

		test("resume: a member's fork with no options resumes for the member (control)", async () => {
			const t = await team();
			const host = await seedHost({ ownerUserId: t.alice.id });
			const s = await claimed(
				await seedObserved({ ownerUserId: t.alice.id }),
				host,
				MEMBER(t.alice.id),
			);
			await report(s);
			await managedState.degradeClaudeForksOfRestartedHost(host);
			const ok = await queueSessionResume(s.forkId, MEMBER(t.alice.id), deps);
			expect(ok.action.actionType).toBe("resume");
		});

		test("prompt: the new owner and an identity-less actor are refused with the stable code; the consenting owner is not", async () => {
			const { t, s } = await handedOverFork();
			await expect(
				control.queuePromptAction(s.forkId, "hello", MEMBER(t.bob.id)),
			).rejects.toMatchObject({ code: "fork_options_host_not_yours" });
			await expect(
				control.queuePromptAction(s.forkId, "hello", {
					userId: null,
					label: "telegram",
					mode: "team",
				}),
			).rejects.toMatchObject({ code: "fork_options_host_not_yours" });
			const ok = await control.queuePromptAction(s.forkId, "hello", MEMBER(t.alice.id));
			expect(ok.actionType).toBe("prompt");
		});

		test("solo is unaffected by recorded consent", async () => {
			const host = await seedHost();
			const s = await claimed(await seedObserved(), host, SOLO, { mcp: true });
			await report(s, { applied: APPLIED });
			const ok = await control.queuePromptAction(s.forkId, "hello", SOLO);
			expect(ok.actionType).toBe("prompt");
		});
	});
});
