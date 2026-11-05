/**
 * Taking over an observed Codex session: who may, which rows it writes, what it refuses (AGEN-115, phase 1).
 *
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres: real routes' service, real
 * `withAdminLock`, real validators. The only fakes are the clock (an injected `now`) and the seams the
 * concurrency cases need (a hook between the pre-reads and the lock; a hook after each write inside it).
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, like } from "drizzle-orm";
import "../db/__test_db.js";
import { CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import { privilegeCliArgs } from "../../shared/launch-privileges.js";
import {
	RESUMES_SESSIONS,
	type ResumeRefusalCode,
	TAKEOVER_PRIVILEGES,
} from "../../shared/session-resume.js";
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
const { controlActions, events, launchRequests, managedSessions, sessions, supervisors } =
	await import("../db/schema/index.js");
const { cleanApprovalFixtures } = await import("../test-utils/codex-approvals-harness.js");
const { BindRefusal } = await import("./bind-refusal.js");
const { bindObservedSession } = await import("./session-binding.js");
const authz = await import("./authorization.js");
const { resolveSessionOwner } = await import("./session-ownership.js");
const { mapLaunchRequest } = await import("./launch-validator.js");
const { claimNextLaunchRequest } = await import("./launch-dispatch.js");
const { ControlBusyError, claimNextControlAction, queuePromptAction, queueStopAction } =
	await import("./control-actions.js");
const { ENFORCES_LAUNCH_PRIVILEGES } = await import("./launch-compatibility.js");
const { updateStaleSessions } = await import("./session-tracker.js");
const { sessionBus } = await import("./notifier.js");
const wsRevalidation = await import("../ws/revalidation.js");
const { assignTakeoverOwner } = await import("./session-owner-admin.js");
const ownership = await import("./session-ownership.js");
const { withAdminLock } = await import("../db/admin-lock.js");

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
// The injected clock starts at the real one, so a host lease seeded here is live for code that reads Date.now() too.
const T0 = Math.floor(Date.now() / 1000) * 1000;
const MIN = 60_000;

const CAPABILITIES = {
	version: 1,
	agentTypes: ["claude_code", "codex_cli"],
	launchModes: ["headless", "interactive_terminal", "managed_codex"],
	os: "linux",
	terminalSupport: ["terminal"],
	features: [CODEX_FOLLOW_UP_PROMPTS, ENFORCES_LAUNCH_PRIVILEGES, RESUMES_SESSIONS],
	executables: {
		claude: { available: true, command: "claude", resolvedPath: "/usr/bin/claude", source: "auto" },
		codex: { available: true, command: "codex", resolvedPath: "/usr/bin/codex", source: "auto" },
	},
};

interface HostOptions {
	id?: string;
	ownerUserId?: string | null;
	capabilities?: unknown;
	leaseMs?: number;
	leaseBaseMs?: number;
	storedStatus?: string;
	enrollmentState?: string;
	trustedRoots?: string[];
}

async function seedHost(opts: HostOptions = {}): Promise<string> {
	counter++;
	const id = opts.id ?? `bind-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	hostsUsed.push(id);
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `${id}-name`,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: (opts.capabilities ?? CAPABILITIES) as Record<string, unknown>,
			trustedRoots: opts.trustedRoots ?? [WORK],
			status: opts.storedStatus ?? "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(
				(opts.leaseBaseMs ?? Date.now()) + (opts.leaseMs ?? 60 * MIN),
			).toISOString(),
			enrollmentState: opts.enrollmentState ?? "active",
			ownerUserId: opts.ownerUserId ?? null,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

interface ObservedOptions {
	sessionId?: string;
	ownerUserId?: string | null;
	ingestKeyId?: string | null;
	cwd?: string | null;
	agentType?: string;
	lastActivityMs?: number;
	isWorking?: boolean;
	isArchived?: boolean;
	metadata?: Record<string, unknown> | null;
	displayName?: string | null;
	status?: string;
	endedAt?: string | null;
	reportedHost?: string | null;
	model?: string | null;
}

async function seedObserved(opts: ObservedOptions = {}): Promise<string> {
	const sessionId = opts.sessionId ?? crypto.randomUUID();
	// An owned session was reported by its owner's key unless a test says otherwise (null = no key recorded).
	const ingestKeyId =
		opts.ingestKeyId !== undefined
			? opts.ingestKeyId
			: opts.ownerUserId
				? (await seedKey("bind-reporter", ["ingest"], opts.ownerUserId)).id
				: null;
	sessionsUsed.push(sessionId);
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: opts.agentType ?? "codex_cli",
			cwd: opts.cwd === undefined ? CWD : opts.cwd,
			displayName: opts.displayName === undefined ? "refactor the parser" : opts.displayName,
			ownerUserId: opts.ownerUserId ?? null,
			ingestKeyId,
			lastActivityAt: new Date(opts.lastActivityMs ?? T0 - 10 * MIN).toISOString(),
			isWorking: opts.isWorking ?? false,
			isArchived: opts.isArchived ?? false,
			status: opts.status ?? "idle",
			endedAt: opts.endedAt ?? null,
			metadata: (opts.metadata ?? null) as Record<string, unknown> | null,
			reportedHost: opts.reportedHost ?? null,
			model: opts.model ?? null,
		});
	return sessionId;
}

const NOW = () => T0;
const deps = { now: NOW };

const SOLO: Actor = { userId: null, label: "anonymous", role: "admin", mode: "solo" };
const ADMIN = (userId: string): Actor => ({ userId, label: "user", role: "admin", mode: "team" });
const MEMBER = (userId: string): Actor => ({ userId, label: "user", role: "member", mode: "team" });

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("bind-alice");
	const bob = await seedLocalUser("bind-bob");
	const admin = await seedLocalUser("bind-admin", "admin");
	return { alice, bob, admin };
}

function bind(
	sessionId: string,
	hostId: string,
	actor: Actor,
	extra: Parameters<typeof bindObservedSession>[3] = deps,
) {
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
		if (error instanceof BindRefusal) {
			return { code: error.code, status: error.status, message: error.message };
		}
		throw error;
	}
	throw new Error("expected a BindRefusal, but the call succeeded");
}

async function rowsFor(sessionId: string) {
	const [launch] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	const actions = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, sessionId));
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return { launch, managed, actions, session };
}

async function expectNoRows(sessionId: string) {
	const { launch, managed, actions } = await rowsFor(sessionId);
	expect({
		launch: launch ? "row" : null,
		managed: managed ? "row" : null,
		actions: actions.length,
	}).toEqual({
		launch: null,
		managed: null,
		actions: 0,
	});
}

// ── 1: solo baseline, and the rows a takeover writes (item 1, 14) ───────────

describe("the rows a takeover writes", () => {
	test("solo, any caller: the action is queued and the three rows exist (baseline for every refusal below)", async () => {
		const host = await seedHost();
		const id = await seedObserved({ model: "reported-model" });

		const result = await bind(id, host, SOLO);

		const { launch, managed, actions, session } = await rowsFor(id);
		expect(result.launchRequestId).toBe(launch.id);
		expect(actions.length).toBe(1);
		expect(result.action.id).toBe(actions[0].id);
		expect(session.ownerUserId).toBeNull();
		expect(managed.managedState).toBe("pending");
	});

	test("the carrier launch row looks like a real launch and names the target", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, displayName: "fix the build" });

		await bind(id, host, MEMBER(t.alice.id));

		const { launch } = await rowsFor(id);
		expect(launch.status).toBe("completed");
		expect(launch.agentType).toBe("codex_cli");
		expect(launch.launchCorrelationId).toBe(id);
		expect(launch.claimedBySupervisorId).toBe(host);
		expect(launch.requestedSupervisorId).toBe(host);
		expect(launch.resolvedSupervisorId).toBe(host);
		expect(launch.routingPolicy).toBe("manual_target");
		expect(launch.requestedLaunchMode).toBe("managed_codex");
		expect(launch.cwd).toBe(CWD);
		expect(launch.model).toBeNull();
		expect(launch.env).toEqual({});
		expect(launch.taskPrompt).toBe("");
		expect(launch.baseInstructions).toBe("");
		expect(launch.claimToken).toBeNull();
		expect(launch.requestedBy).toBe("user");
		expect(launch.metadata).toEqual({ boundObservedSession: true, boundByUserId: t.alice.id });
		const spec = launch.launchSpec as Record<string, unknown>;
		expect(spec.launchCorrelationId).toBe(id);
		expect(spec.agentType).toBe("codex_cli");
		expect(spec.approvalPolicy).toBe("untrusted");
		expect(spec.sandboxMode).toBe("workspace-write");
		expect(spec.name ?? spec.templateName ?? "Take over: fix the build").toBeDefined();
		expect(JSON.stringify(spec)).toContain("Take over: fix the build");
	});

	test("privileges are the takeover pair, not the defaults (distinguishable-policy rule)", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		expect(TAKEOVER_PRIVILEGES.approvalPolicy).not.toBe("default");

		await bind(id, host, SOLO);

		const { launch, actions } = await rowsFor(id);
		expect([launch.approvalPolicy, launch.sandboxMode]).toEqual(["untrusted", "workspace-write"]);
		const metadata = actions[0].metadata as Record<string, unknown>;
		expect(metadata.approvalPolicy).toBe("untrusted");
		expect(metadata.sandboxMode).toBe("workspace-write");
		expect(metadata.expectedEnforcedArgs).toEqual(
			privilegeCliArgs("codex_cli", "untrusted", "workspace-write"),
		);
	});

	test("the managed row is pending, names the thread, and is marked taken over", async () => {
		const host = await seedHost();
		const id = await seedObserved();

		await bind(id, host, SOLO);

		const { managed, launch } = await rowsFor(id);
		expect(managed.supervisorId).toBe(host);
		expect(managed.launchRequestId).toBe(launch.id);
		expect(managed.managedState).toBe("pending");
		expect(managed.providerThreadId).toBe(id);
		expect(managed.hostAffinityReason).toBe("taken_over");
		expect(managed.activeControlActionId).not.toBeNull();
	});

	test("one resume action, queued, holding the lock, with no env, model or prompt", async () => {
		const host = await seedHost();
		const id = await seedObserved();

		const { action } = await bind(id, host, SOLO);

		const { managed, actions, launch } = await rowsFor(id);
		expect(actions.length).toBe(1);
		expect(actions[0].actionType).toBe("resume");
		expect(actions[0].status).toBe("queued");
		expect(actions[0].launchRequestId).toBe(launch.id);
		expect(managed.activeControlActionId).toBe(action.id);
		const metadata = actions[0].metadata as Record<string, unknown>;
		expect(metadata.resumeKind).toBe("takeover");
		expect(metadata.threadId).toBe(id);
		expect(metadata.cwd).toBe(CWD);
		expect(metadata.agentType).toBe("codex_cli");
		for (const key of ["env", "model", "prompt", "assignOwner"]) {
			expect(Object.hasOwn(metadata, key)).toBe(false);
		}
	});

	test("the target is the owner of record at once, and ingest_key_id is untouched", async () => {
		const t = await team();
		const key = await seedKey("bind-key", ["ingest"], t.alice.id);
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId: key.id });

		await bind(id, host, MEMBER(t.alice.id));

		const { getDb: db } = { getDb };
		expect(await resolveSessionOwner(db(), id)).toBe(host);
		const { session } = await rowsFor(id);
		expect(session.ingestKeyId).toBe(key.id);
	});

	test("a hook-written model never reaches the launch row or the action", async () => {
		const host = await seedHost();
		const id = await seedObserved({ model: "gpt-hook-claimed" });

		await bind(id, host, SOLO);

		const { launch, actions } = await rowsFor(id);
		expect(launch.model).toBeNull();
		expect(JSON.stringify(actions[0].metadata)).not.toContain("gpt-hook-claimed");
	});

	test("reported_host naming another host changes no decision", async () => {
		const host = await seedHost();
		const other = await seedHost();
		const id = await seedObserved({ reportedHost: `${other}-name` });

		await bind(id, host, SOLO);

		expect((await rowsFor(id)).managed.supervisorId).toBe(host);
	});

	test("the carrier row's mapped key set equals a normal launch's (the iOS LaunchRecord)", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		await bind(id, host, SOLO);
		const { launch } = await rowsFor(id);

		const [normal] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: crypto.randomUUID(),
				agentType: "codex_cli",
				cwd: CWD,
				status: "validated",
				launchSpec: { version: 1 },
			})
			.returning();
		try {
			expect(Object.keys(mapLaunchRequest(launch)).sort()).toEqual(
				Object.keys(mapLaunchRequest(normal)).sort(),
			);
		} finally {
			await getDb().delete(launchRequests).where(eq(launchRequests.id, normal.id));
		}
	});
});

// ── 2: who may take over (items 2-4, 24) ─────────────────────────────────────

describe("mayBindSession", () => {
	const solo = "solo" as const;
	const teamMode = "team" as const;
	const member = (userId: string | null): Actor => ({ userId, label: "user", role: "member" });
	const admin: Actor = { userId: "u-admin", label: "user", role: "admin" };
	const none: Actor = { userId: null, label: "supervisor", role: "none" };

	test("solo allows every caller", () => {
		expect(authz.mayBindSession(member(null), solo, { ownerUserId: "someone" })).toBe(true);
	});
	test("a host credential never", () => {
		expect(authz.mayBindSession(none, teamMode, { ownerUserId: null })).toBe(false);
	});
	test("an admin always, owned or not", () => {
		expect(authz.mayBindSession(admin, teamMode, { ownerUserId: "u-1" })).toBe(true);
		expect(authz.mayBindSession(admin, teamMode, { ownerUserId: null })).toBe(true);
	});
	test("an unowned session is an admin's alone (not open to members, unlike the weak rule)", () => {
		expect(authz.mayBindSession(member("u-1"), teamMode, { ownerUserId: null })).toBe(false);
	});
	test("an owned session: its owner, nobody else", () => {
		expect(authz.mayBindSession(member("u-1"), teamMode, { ownerUserId: "u-1" })).toBe(true);
		expect(authz.mayBindSession(member("u-2"), teamMode, { ownerUserId: "u-1" })).toBe(false);
		expect(authz.mayBindSession(member(null), teamMode, { ownerUserId: "u-1" })).toBe(false);
	});
	test("a missing session gives a non-admin nothing", () => {
		expect(authz.mayBindSession(member("u-1"), teamMode, null)).toBe(false);
	});
});

describe("assertCanBindSession", () => {
	test("owner and admin pass; solo passes", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: t.alice.id });
		await authz.assertCanBindSession(MEMBER(t.alice.id), id);
		await authz.assertCanBindSession(ADMIN(t.admin.id), id);
		await authz.assertCanBindSession({ ...SOLO }, id);
	});

	test("a member on another's session is a session_not_found, the answer a missing session gets", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const missing = crypto.randomUUID();

		const foreign = await refusal(authz.assertCanBindSession(MEMBER(t.bob.id), id));
		const absent = await refusal(authz.assertCanBindSession(MEMBER(t.bob.id), missing));

		expect(foreign).toEqual({ code: "session_not_found", status: 404, message: absent.message });
		expect(absent.code).toBe("session_not_found");
		expect(foreign.message).toBe(absent.message);
	});

	test("negative control: a member on an UNOWNED session is a 403 not_owner (they can read it)", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: null });
		const result = await refusal(authz.assertCanBindSession(MEMBER(t.bob.id), id));
		expect(result.code).toBe("not_owner");
		expect(result.status).toBe(403);
	});

	test("a member who canReadSession but isn't the owner is refused (it isn't the weak rule)", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: null });
		const actor = MEMBER(t.bob.id);
		expect(authz.canReadSession(actor, { ownerUserId: null })).toBe(true);
		await expect(authz.assertCanBindSession(actor, id)).rejects.toBeInstanceOf(BindRefusal);
		// The weak alias lets the same member through, which is exactly why bind can't use it.
		await authz.assertCanDeleteSession(actor, id);
	});

	test("a refusal for authority performs no host read", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.bob.id });
		const owned = await seedObserved({ ownerUserId: t.alice.id });
		const unowned = await seedObserved({ ownerUserId: null });
		const supervisorRegistry = await import("./supervisor-registry.js");
		const spy = spyOn(supervisorRegistry, "getSupervisor");
		const ownership = await import("./session-ownership.js");
		const hostRead = spyOn(ownership, "readHostState");
		try {
			await refusal(bind(owned, host, MEMBER(t.bob.id)));
			await refusal(bind(unowned, host, MEMBER(t.bob.id)));
			await refusal(bind(crypto.randomUUID(), host, MEMBER(t.bob.id)));
			expect(spy).not.toHaveBeenCalled();
			expect(hostRead).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			hostRead.mockRestore();
		}
	});
});

describe("mayBindToHost", () => {
	const member = (userId: string | null): Actor => ({ userId, label: "user", role: "member" });
	const admin: Actor = { userId: "u-admin", label: "user", role: "admin" };
	const host = (ownerUserId: string | null, enrollmentState = "active") => ({
		ownerUserId,
		enrollmentState,
	});

	test("solo: only a missing or revoked host refuses", () => {
		expect(authz.mayBindToHost(member(null), "solo", null, host("someone"))).toBeNull();
		expect(authz.mayBindToHost(member(null), "solo", "u-1", host("u-2"))).toBeNull();
		expect(authz.mayBindToHost(member(null), "solo", null, null)).toBe("host_gone");
		expect(authz.mayBindToHost(member(null), "solo", null, host(null, "revoked"))).toBe(
			"host_gone",
		);
	});

	test("a member: a host they own; every other host is the same host_not_allowed", () => {
		expect(authz.mayBindToHost(member("u-1"), "team", "u-1", host("u-1"))).toBeNull();
		expect(authz.mayBindToHost(member("u-1"), "team", "u-1", host("u-2"))).toBe("host_not_allowed");
		expect(authz.mayBindToHost(member("u-1"), "team", "u-1", host(null))).toBe("host_not_allowed");
		expect(authz.mayBindToHost(member("u-1"), "team", "u-1", null)).toBe("host_not_allowed");
	});

	test("an admin: any existing host; missing or revoked is host_gone", () => {
		expect(authz.mayBindToHost(admin, "team", "u-1", host("u-1"))).toBeNull();
		expect(authz.mayBindToHost(admin, "team", null, host("u-2"))).toBeNull();
		expect(authz.mayBindToHost(admin, "team", null, host(null))).toBeNull();
		expect(authz.mayBindToHost(admin, "team", null, null)).toBe("host_gone");
		expect(authz.mayBindToHost(admin, "team", null, host(null, "revoked"))).toBe("host_gone");
	});

	test("different non-null owners are refused for an admin too", () => {
		expect(authz.mayBindToHost(admin, "team", "u-1", host("u-2"))).toBe("host_owner_mismatch");
	});

	test("an unowned session on an unowned host: an admin may", () => {
		expect(authz.mayBindToHost(admin, "team", null, host(null))).toBeNull();
	});

	test("a host credential never", () => {
		const none: Actor = { userId: null, label: "supervisor", role: "none" };
		expect(authz.mayBindToHost(none, "team", null, host("u-1"))).toBe("host_not_allowed");
	});
});

describe("hosts, through the service", () => {
	test("a member's foreign, unowned and nonexistent hosts answer byte-equal", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const foreign = await seedHost({ ownerUserId: t.bob.id });
		const unowned = await seedHost({ ownerUserId: null });
		const answers = [];
		for (const host of [foreign, unowned, "no-such-host"]) {
			answers.push(await refusal(bind(id, host, MEMBER(t.alice.id))));
		}
		expect(answers[0]).toEqual({
			code: "host_not_allowed",
			status: 403,
			message: answers[0].message,
		});
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
		await expectNoRows(id);
	});

	test("session owner A + host owner B: host_owner_mismatch for an admin too", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const host = await seedHost({ ownerUserId: t.bob.id });
		expect((await refusal(bind(id, host, ADMIN(t.admin.id)))).code).toBe("host_owner_mismatch");
		await expectNoRows(id);
	});

	test("an unowned session on an unowned host is an admin's alone", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: null });
		const id = await seedObserved({ ownerUserId: null });
		expect((await refusal(bind(id, host, MEMBER(t.alice.id)))).code).toBe("not_owner");
		await bind(id, host, ADMIN(t.admin.id));
		expect((await rowsFor(id)).managed.supervisorId).toBe(host);
	});

	test("an admin may use any existing host for an owned session whose host has the same owner", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		await bind(id, host, ADMIN(t.admin.id));
		expect((await rowsFor(id)).managed).toBeDefined();
	});

	test("host_offline: an expired lease, whatever the stored status column says", async () => {
		const host = await seedHost({ leaseMs: -MIN, storedStatus: "connected" });
		const id = await seedObserved();
		const result = await refusal(bind(id, host, SOLO));
		expect(result).toMatchObject({ code: "host_offline", status: 409 });
		await expectNoRows(id);
	});

	test("a live lease passes even when the stored column says offline (the column isn't read)", async () => {
		const host = await seedHost({ storedStatus: "offline" });
		const id = await seedObserved();
		await bind(id, host, SOLO);
		expect((await rowsFor(id)).managed.supervisorId).toBe(host);
	});

	test("the lease is strict: expiring exactly now is offline", async () => {
		const host = await seedHost({ leaseBaseMs: T0, leaseMs: 0 });
		const id = await seedObserved();
		expect((await refusal(bind(id, host, SOLO))).code).toBe("host_offline");
	});

	test("host_gone: a revoked host and a missing host, nothing queued", async () => {
		const revoked = await seedHost({ enrollmentState: "revoked" });
		const id = await seedObserved();
		expect((await refusal(bind(id, revoked, SOLO))).code).toBe("host_gone");
		expect((await refusal(bind(id, "missing-host", SOLO))).code).toBe("host_gone");
		await expectNoRows(id);
	});

	test("a host without resumes_sessions is host_upgrade_required (absent and malformed capabilities alike)", async () => {
		const id = await seedObserved();
		const withoutFeature = {
			...CAPABILITIES,
			features: [CODEX_FOLLOW_UP_PROMPTS, ENFORCES_LAUNCH_PRIVILEGES],
		};
		for (const capabilities of [
			withoutFeature,
			{ ...CAPABILITIES, features: "resumes_sessions" },
			{ ...CAPABILITIES, features: [RESUMES_SESSIONS.toUpperCase()] },
			{},
		]) {
			const host = await seedHost({ capabilities });
			const result = await refusal(bind(id, host, SOLO));
			expect(result).toMatchObject({ code: "host_upgrade_required", status: 409 });
		}
		await expectNoRows(id);
	});

	test("a host without enforces_launch_privileges is refused too", async () => {
		const host = await seedHost({
			capabilities: { ...CAPABILITIES, features: [CODEX_FOLLOW_UP_PROMPTS, RESUMES_SESSIONS] },
		});
		const id = await seedObserved();
		expect((await refusal(bind(id, host, SOLO))).code).toBe("host_upgrade_required");
	});
});

describe("what the fresh host row must still allow, and what a host that can't run Codex says", () => {
	test("a host downgraded after the pre-reads is refused inside the lock", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await refusal(
			bind(id, host, SOLO, {
				now: NOW,
				beforeLock: async () => {
					await getDb()
						.update(supervisors)
						.set({
							capabilities: {
								...CAPABILITIES,
								features: [CODEX_FOLLOW_UP_PROMPTS, RESUMES_SESSIONS],
							},
						})
						.where(eq(supervisors.id, host));
				},
			}),
		);
		expect(result.code).toBe("host_upgrade_required");
		await expectNoRows(id);
	});

	test("a host that lost its Codex executable after the pre-reads is host_cannot_run_codex", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await refusal(
			bind(id, host, SOLO, {
				now: NOW,
				beforeLock: async () => {
					await getDb()
						.update(supervisors)
						.set({
							capabilities: {
								...CAPABILITIES,
								executables: { codex: { available: false, command: "codex" } },
							},
						})
						.where(eq(supervisors.id, host));
				},
			}),
		);
		expect(result).toMatchObject({ code: "host_cannot_run_codex", status: 409 });
		await expectNoRows(id);
	});

	test.each([
		[
			"no usable Codex executable",
			{ executables: { codex: { available: false, command: "codex" } } },
		],
		["no managed_codex launch mode", { launchModes: ["headless", "interactive_terminal"] }],
		["no codex_cli agent type", { agentTypes: ["claude_code"] }],
	])("%s is host_cannot_run_codex, not an upgrade problem", async (_name, override) => {
		const host = await seedHost({ capabilities: { ...CAPABILITIES, ...override } });
		const id = await seedObserved();
		expect(await refusal(bind(id, host, SOLO))).toMatchObject({
			code: "host_cannot_run_codex",
			status: 409,
		});
		await expectNoRows(id);
	});

	test("a bind that committed answers even when announcing it fails", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const revalidate = spyOn(wsRevalidation, "requestWsRevalidation").mockRejectedValue(
			new Error("socket sweep failed"),
		);
		const errors = spyOn(console, "error");
		try {
			const result = await bind(id, host, SOLO);
			expect(result.launchRequestId).toBeDefined();
			expect((await rowsFor(id)).managed).toBeDefined();
			expect(
				errors.mock.calls.some((call) => String(call[0]).includes("session_bound_notify_failed")),
			).toBe(true);
		} finally {
			revalidate.mockRestore();
			errors.mockRestore();
		}
	});
});

// ── 3: inputs (items 10, 11) ─────────────────────────────────────────────────

describe("inputs", () => {
	test("claude_code and copilot_cli are refused with the same answer and no rows", async () => {
		const host = await seedHost();
		const answers = [];
		for (const agentType of ["claude_code", "copilot_cli"]) {
			const id = await seedObserved({ agentType });
			answers.push(await refusal(bind(id, host, SOLO)));
			await expectNoRows(id);
		}
		expect(answers[0]).toMatchObject({ code: "agent_not_supported", status: 409 });
		expect(answers[1]).toEqual(answers[0]);
	});

	test("a hook-written agent_type=codex_cli for an id with no managed rows is judged by isLaunchable then codex_cli only", async () => {
		const host = await seedHost();
		const id = await seedObserved({ agentType: "codex_cli" });
		await bind(id, host, SOLO);
		const { actions } = await rowsFor(id);
		expect((actions[0].metadata as Record<string, unknown>).agentType).toBe("codex_cli");
	});

	test.each([
		["a leading dash", "-x"],
		["a traversal", "../a"],
		["uppercase", "2F1B6C1E-8D3A-4A57-9C0E-5B7F3A9D1E42"],
		["a trailing newline", "2f1b6c1e-8d3a-4a57-9c0e-5b7f3a9d1e42\n"],
		["not a uuid", "session-123"],
	])("%s is session_id_unsupported, with no rows", async (_name, sessionId) => {
		const host = await seedHost();
		await seedObserved({ sessionId });
		const result = await refusal(bind(sessionId, host, SOLO));
		expect(result).toMatchObject({ code: "session_id_unsupported", status: 409 });
		await expectNoRows(sessionId);
	});

	test("sessions.cwd null is cwd_unknown", async () => {
		const host = await seedHost();
		const id = await seedObserved({ cwd: null });
		expect(await refusal(bind(id, host, SOLO))).toMatchObject({ code: "cwd_unknown", status: 409 });
		await expectNoRows(id);
	});

	test.each([
		["a traversal", "/work/project/../../etc"],
		["a relative path", "project"],
		["outside the trusted roots", "/srv/elsewhere"],
		["a sibling that shares a root prefix", "/workshop/project"],
	])("a cwd that is %s is cwd_not_trusted, naming no roots", async (_name, cwd) => {
		const host = await seedHost();
		const id = await seedObserved({ cwd });
		const result = await refusal(bind(id, host, SOLO));
		expect(result).toMatchObject({ code: "cwd_not_trusted", status: 409 });
		expect(result.message).not.toContain(WORK);
		await expectNoRows(id);
	});

	test("confirmation: anything but true is refused before the session is read", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		for (const sameMachineConfirmed of [false, undefined, "true", 1, null]) {
			const result = await refusal(
				bindObservedSession(
					id,
					{ targetSupervisorId: host, sameMachineConfirmed } as never,
					SOLO,
					deps,
				),
			);
			expect(result).toMatchObject({ code: "invalid_body", status: 400 });
		}
		await expectNoRows(id);
	});

	test("a missing session is session_not_found", async () => {
		const host = await seedHost();
		expect(await refusal(bind(crypto.randomUUID(), host, SOLO))).toMatchObject({
			code: "session_not_found",
			status: 404,
		});
	});

	test("an archived session is refused", async () => {
		const host = await seedHost();
		const id = await seedObserved({ isArchived: true });
		expect((await refusal(bind(id, host, SOLO))).code).toBe("session_not_found");
		await expectNoRows(id);
	});
});

// ── 4: is the original still running? (item 12) ──────────────────────────────

describe("the server's quiet rule", () => {
	async function attempt(opts: ObservedOptions, nowMs: number) {
		const host = await seedHost();
		const id = await seedObserved(opts);
		return refusal(bind(id, host, SOLO, { now: () => nowMs }));
	}
	async function passes(opts: ObservedOptions, nowMs: number) {
		const host = await seedHost();
		const id = await seedObserved(opts);
		await bind(id, host, SOLO, { now: () => nowMs });
		return id;
	}

	test("last activity exactly 5 minutes ago passes; one millisecond short is session_active", async () => {
		const last = T0 - 5 * MIN;
		await passes({ lastActivityMs: last }, T0);
		const result = await attempt({ lastActivityMs: last + 1 }, T0);
		expect(result).toMatchObject({ code: "session_active", status: 409 });
	});

	test("a working session is session_active however old", async () => {
		const result = await attempt({ isWorking: true, lastActivityMs: T0 - 30 * MIN }, T0);
		expect(result.code).toBe("session_active");
	});

	const WAIT = { permissionWait: { ids: ["tool-1"], anon: 0, prevStatus: "working" } };

	test("a live permission wait refuses while the session is under 60 minutes old; exactly 60 passes", async () => {
		const result = await attempt({ metadata: WAIT, lastActivityMs: T0 - 60 * MIN + 1 }, T0);
		expect(result.code).toBe("session_active");
		await passes({ metadata: WAIT, lastActivityMs: T0 - 60 * MIN }, T0);
	});

	test("an anonymous wait counts too", async () => {
		const result = await attempt(
			{
				metadata: { permissionWait: { ids: [], anon: 1, prevStatus: "working" } },
				lastActivityMs: T0 - 20 * MIN,
			},
			T0,
		);
		expect(result.code).toBe("session_active");
	});

	test("forged lifecycle claims inside the window don't shorten it", async () => {
		for (const opts of [
			{ endedAt: new Date(T0 - 2 * MIN).toISOString() },
			{ status: "completed" },
			{ metadata: { endedByEvent: "SessionEnd" } },
		]) {
			const result = await attempt({ ...opts, lastActivityMs: T0 - MIN }, T0);
			expect(result.code).toBe("session_active");
		}
	});

	test("a session stuck with isWorking passes only after the real sweep clears it", async () => {
		const host = await seedHost();
		const id = await seedObserved({ isWorking: true, lastActivityMs: T0 - 2 * 60 * MIN });
		expect((await refusal(bind(id, host, SOLO))).code).toBe("session_active");

		await updateStaleSessions(T0);

		await bind(id, host, SOLO, { now: () => T0 });
		expect((await rowsFor(id)).managed).toBeDefined();
	});
});

// ── 5: collisions (item 13) ─────────────────────────────────────────────────

describe("collisions are already_managed, identical for every kind", () => {
	async function expectAlreadyManaged(id: string, host: string) {
		const result = await refusal(bind(id, host, SOLO));
		expect(result).toMatchObject({ code: "already_managed", status: 409 });
		return result;
	}

	test("a managed row for the session, a launch row in any status, and shadows, all byte-equal", async () => {
		const host = await seedHost();
		const answers = [];

		const managedId = await seedObserved();
		const [launchA] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: crypto.randomUUID(),
				agentType: "codex_cli",
				cwd: CWD,
				status: "completed",
			})
			.returning();
		await getDb().insert(managedSessions).values({
			sessionId: managedId,
			launchRequestId: launchA.id,
			supervisorId: host,
			managedState: "managed",
		});
		answers.push(await expectAlreadyManaged(managedId, host));

		for (const status of ["draft", "validated", "running", "completed", "failed", "rejected"]) {
			const id = await seedObserved();
			await getDb()
				.insert(launchRequests)
				.values({ launchCorrelationId: id, agentType: "codex_cli", cwd: CWD, status });
			answers.push(await expectAlreadyManaged(id, host));
		}

		for (const column of ["providerThreadId", "providerSessionId"] as const) {
			const id = await seedObserved();
			const holder = await seedObserved();
			await getDb()
				.insert(managedSessions)
				.values({
					sessionId: holder,
					launchRequestId: launchA.id,
					supervisorId: host,
					managedState: "managed",
					[column]: id,
				});
			answers.push(await expectAlreadyManaged(id, host));
		}

		for (const answer of answers) expect(answer).toEqual(answers[0]);
		await getDb().delete(launchRequests).where(eq(launchRequests.id, launchA.id));
		await getDb()
			.delete(launchRequests)
			.where(inArray(launchRequests.launchCorrelationId, [...sessionsUsed]));
	});

	test("negative control: a managed row for an unrelated id doesn't block", async () => {
		const host = await seedHost();
		const unrelated = await seedObserved();
		await getDb().insert(managedSessions).values({
			sessionId: unrelated,
			launchRequestId: "lr-unrelated",
			supervisorId: host,
			managedState: "managed",
		});
		const id = await seedObserved();
		await bind(id, host, SOLO);
		expect((await rowsFor(id)).managed).toBeDefined();
	});
});

// ── 6: the member key rule (item 25) ─────────────────────────────────────────

describe("session_key_mismatch", () => {
	async function setup(ingestKeyId: string | null) {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId });
		return { t, host, id };
	}

	test("(a) the member's own key on their own host passes", async () => {
		const t = await team();
		const key = await seedKey("bind-own", ["ingest"], t.alice.id);
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId: key.id });
		await bind(id, host, MEMBER(t.alice.id));
		expect((await rowsFor(id)).managed).toBeDefined();
	});

	test("(b) another person's key, (c) a service key and (d) no key are one byte-equal refusal naming no key", async () => {
		const answers = [];
		const t0 = await team();
		const bobsKey = await seedKey("bind-bobs", ["ingest"], t0.bob.id);
		const serviceKey = await seedKey("bind-service", ["ingest"], null);
		for (const ingestKeyId of [bobsKey.id, serviceKey.id, null]) {
			const host = await seedHost({ ownerUserId: t0.alice.id });
			const id = await seedObserved({ ownerUserId: t0.alice.id, ingestKeyId });
			answers.push(await refusal(bind(id, host, MEMBER(t0.alice.id))));
			await expectNoRows(id);
		}
		expect(answers[0]).toMatchObject({ code: "session_key_mismatch", status: 403 });
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
		for (const text of [bobsKey.id, serviceKey.id, t0.bob.id]) {
			expect(JSON.stringify(answers)).not.toContain(text);
		}
	});

	test("an admin isn't subject to it", async () => {
		const { t, host, id } = await setup(null);
		await bind(id, host, ADMIN(t.admin.id));
		expect((await rowsFor(id)).managed).toBeDefined();
	});

	test("the rule is 'the key's owner owns the host', not 'the actor's key'", async () => {
		const t = await team();
		const aliceKey = await seedKey("bind-a", ["ingest"], t.alice.id);
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId: aliceKey.id });
		// An admin's own actor (not alice) with the same session and host passes the rule too.
		await bind(id, host, ADMIN(t.admin.id));
		expect((await rowsFor(id)).managed).toBeDefined();
	});

	test("a foreign host answers host_not_allowed first, whatever the key", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.bob.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId: null });
		expect((await refusal(bind(id, host, MEMBER(t.alice.id)))).code).toBe("host_not_allowed");
	});

	test("RESIDUAL (D5), pinned: a forged row, the member's own key on the member's own host, passes", async () => {
		// Two people's supervisors under one OS account: Alice forges an observed row for a thread that
		// belongs to Bob, using her own key, and takes it over on her own host. Every check passes, because
		// that host's account really holds the thread. AgentPulse can't tell people apart below the OS
		// account. This test exists so nobody later reads session_key_mismatch as stopping it.
		const t = await team();
		const aliceKey = await seedKey("bind-forger", ["ingest"], t.alice.id);
		const host = await seedHost({ ownerUserId: t.alice.id });
		const forged = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId: aliceKey.id });
		await bind(forged, host, MEMBER(t.alice.id));
		expect((await rowsFor(forged)).managed.supervisorId).toBe(host);
	});

	test("it is judged inside the lock: a key handed to another owner after the pre-reads refuses", async () => {
		const t = await team();
		const key = await seedKey("bind-late", ["ingest"], t.alice.id);
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id, ingestKeyId: key.id });
		const { apiKeys } = await import("../db/schema/index.js");

		const result = await refusal(
			bind(id, host, MEMBER(t.alice.id), {
				now: NOW,
				beforeLock: async () => {
					await getDb()
						.update(apiKeys)
						.set({ ownerUserId: t.bob.id })
						.where(eq(apiKeys.id, key.id));
				},
			}),
		);

		expect(result.code).toBe("session_key_mismatch");
		await expectNoRows(id);
	});
});

// ── 7: the owner of an unowned session, and requestedByUserId (items 14, 21) ─

describe("owner on success, not at bind", () => {
	test("an admin's takeover of an unowned session writes no owner at bind and says assignOwner", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: null });

		await bind(id, host, ADMIN(t.admin.id));

		const { session, launch, actions } = await rowsFor(id);
		expect(session.ownerUserId).toBeNull();
		expect((actions[0].metadata as Record<string, unknown>).assignOwner).toBe(true);
		expect(launch.requestedByUserId).toBe(t.alice.id);
		expect((launch.metadata as Record<string, unknown>).boundByUserId).toBe(t.admin.id);
	});

	test.each([
		["an owned session: the session's owner", "owned"],
		["an unowned session on an owned host: the host's owner", "unowned-owned-host"],
		["an unowned session on an unowned host: the actor", "unowned-unowned-host"],
	])("requestedByUserId is the intended owner for %s", async (_name, kind) => {
		const t = await team();
		const hostOwner = kind === "unowned-unowned-host" ? null : t.alice.id;
		const host = await seedHost({ ownerUserId: hostOwner });
		const id = await seedObserved({ ownerUserId: kind === "owned" ? t.alice.id : null });
		const expected =
			kind === "owned" ? t.alice.id : kind === "unowned-owned-host" ? t.alice.id : t.admin.id;

		await bind(id, host, ADMIN(t.admin.id));

		const { launch } = await rowsFor(id);
		expect(launch.requestedByUserId).toBe(expected);
		expect(launch.requestedByUserId).not.toBe(kind === "owned" ? t.admin.id : "never");
		expect(launch.requestedBy).toBe("user");
		expect(launch.requestedBy).not.toBe(t.admin.id);
	});

	test("an admin taking over a member's session: the member can read the launch", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		await bind(id, host, ADMIN(t.admin.id));
		const { launch } = await rowsFor(id);
		expect(authz.canReadLaunch(MEMBER(t.alice.id), launch)).toBe(true);
		expect(authz.canReadLaunch(MEMBER(t.bob.id), launch)).toBe(false);
	});

	test("solo carries no assignOwner", async () => {
		const host = await seedHost();
		const id = await seedObserved({ ownerUserId: null });
		await bind(id, host, SOLO);
		const { actions } = await rowsFor(id);
		expect(Object.hasOwn(actions[0].metadata as object, "assignOwner")).toBe(false);
	});

	test("a member's prompt or stop while the action holds the lock is refused; before the takeover it was allowed", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: null });
		// The hole: before a takeover an unowned session could not be managed at all, and any identified
		// member could already change it (refuseUnlessMayChange). After it, the lock holds them off.
		expect(authz.mayBindSession(MEMBER(t.bob.id), "team", { ownerUserId: null })).toBe(false);
		await bind(id, host, ADMIN(t.admin.id));

		const before = (await rowsFor(id)).actions.length;
		// The specific refusal, and nothing was added to the control history.
		await expect(queueStopAction(id, MEMBER(t.bob.id))).rejects.toBeInstanceOf(ControlBusyError);
		await expect(queuePromptAction(id, "hello", MEMBER(t.bob.id))).rejects.toBeInstanceOf(
			ControlBusyError,
		);
		expect((await rowsFor(id)).actions.length).toBe(before);
	});
});

// ── 8: invisibility (item 15) ────────────────────────────────────────────────

describe("what a pending takeover is invisible to", () => {
	test("the launch claim, the target's control claim only, and the redacted action", async () => {
		const host = await seedHost();
		const otherHost = await seedHost();
		const id = await seedObserved();
		await bind(id, host, SOLO);

		expect(await claimNextLaunchRequest(host)).toBeNull();
		expect(await claimNextLaunchRequest(otherHost)).toBeNull();
		expect(await claimNextControlAction(otherHost)).toBeNull();
		const claimed = await claimNextControlAction(host);
		expect(claimed?.actionType).toBe("resume");
		expect(claimed?.sessionId).toBe(id);
	});

	test("a stop while pending is refused", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		await bind(id, host, SOLO);
		await expect(queueStopAction(id, SOLO)).rejects.toThrow();
	});
});

// ── 9: delete and archive during a takeover (item 26) ────────────────────────

describe("delete and archive while a takeover is open", () => {
	test.each(["assertCanDeleteSession", "assertCanArchiveSession"] as const)(
		"%s answers takeover_in_progress, solo included, and works again after the action settles",
		async (name) => {
			const host = await seedHost();
			const id = await seedObserved();
			const { action } = await bind(id, host, SOLO);

			const result = await refusal(authz[name](SOLO, id));
			expect(result).toMatchObject({ code: "takeover_in_progress", status: 409 });

			await getDb()
				.update(controlActions)
				.set({ status: "failed" })
				.where(eq(controlActions.id, action.id));
			await authz[name](SOLO, id);
		},
	);

	test("in team mode the owner check still comes first", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		await bind(id, host, MEMBER(t.alice.id));
		await expect(authz.assertCanDeleteSession(MEMBER(t.bob.id), id)).rejects.toBeInstanceOf(
			authz.NotOwnerError,
		);
		expect((await refusal(authz.assertCanDeleteSession(MEMBER(t.alice.id), id))).code).toBe(
			"takeover_in_progress",
		);
	});
});

// ── 10: concurrency (C1-C5) ──────────────────────────────────────────────────

describe("concurrency", () => {
	function barrier(parties: number) {
		let arrived = 0;
		let release!: () => void;
		const open = new Promise<void>((resolve) => {
			release = resolve;
		});
		return async () => {
			arrived++;
			if (arrived >= parties) release();
			await open;
		};
	}

	test("C1: two binds of one session on one host, both past the pre-reads: one 202, one already_managed, one of each row", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const beforeLock = barrier(2);

		const outcomes = await Promise.allSettled([
			bind(id, host, SOLO, { now: NOW, beforeLock }),
			bind(id, host, SOLO, { now: NOW, beforeLock }),
		]);

		const ok = outcomes.filter((o) => o.status === "fulfilled");
		const failed = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
		expect(ok.length).toBe(1);
		expect(failed.length).toBe(1);
		expect(failed[0].reason).toBeInstanceOf(BindRefusal);
		expect((failed[0].reason as InstanceType<typeof BindRefusal>).code).toBe("already_managed");
		const { actions } = await rowsFor(id);
		expect(actions.length).toBe(1);
		const launches = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.launchCorrelationId, id));
		const managed = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, id));
		expect([launches.length, managed.length]).toEqual([1, 1]);
	});

	test("C2: two binds of one session on different hosts: the same outcome", async () => {
		const hostA = await seedHost();
		const hostB = await seedHost();
		const id = await seedObserved();
		const beforeLock = barrier(2);

		const outcomes = await Promise.allSettled([
			bind(id, hostA, SOLO, { now: NOW, beforeLock }),
			bind(id, hostB, SOLO, { now: NOW, beforeLock }),
		]);

		expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
		const failed = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
		expect((failed.reason as InstanceType<typeof BindRefusal>).code).toBe("already_managed");
		const managed = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, id));
		expect(managed.length).toBe(1);
	});

	test("C3: a UserPromptSubmit that lands after the pre-reads and before the lock refuses, with no partial state", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await refusal(
			bind(id, host, SOLO, {
				now: NOW,
				beforeLock: async () => {
					await getDb()
						.update(sessions)
						.set({ lastActivityAt: new Date(T0 - 1000).toISOString(), isWorking: true })
						.where(eq(sessions.sessionId, id));
				},
			}),
		);
		expect(result.code).toBe("session_active");
		await expectNoRows(id);
	});

	test.each(["claimed", "locked", "action"] as const)(
		"C4: a failure after the %s write leaves no row, no held lock, no audit line and no signal",
		async (step) => {
			const host = await seedHost();
			const id = await seedObserved();
			const log = spyOn(console, "log");
			const revalidate = spyOn(wsRevalidation, "requestWsRevalidation");
			const updated: unknown[] = [];
			const onUpdated = (s: unknown) => updated.push(s);
			sessionBus.on("session_updated", onUpdated);
			try {
				await expect(
					bind(id, host, SOLO, {
						now: NOW,
						afterStep: async (reached) => {
							if (reached === step) throw new Error("injected");
						},
					}),
				).rejects.toThrow("injected");
				await expectNoRows(id);
				const { session } = await rowsFor(id);
				expect(session.ownerUserId).toBeNull();
				expect(revalidate).not.toHaveBeenCalled();
				expect(updated).toEqual([]);
				expect(log.mock.calls.some((call) => String(call[0]).includes('"session_bound"'))).toBe(
					false,
				);
			} finally {
				sessionBus.off("session_updated", onUpdated);
				log.mockRestore();
				revalidate.mockRestore();
			}
		},
	);

	test("C4b: a managed row that appears between the check and the insert rolls the launch row back", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await refusal(
			bind(id, host, SOLO, {
				now: NOW,
				afterStep: async (reached, tx) => {
					if (reached !== "checked") return;
					await tx.insert(managedSessions).values({
						sessionId: id,
						launchRequestId: "racer",
						supervisorId: host,
						managedState: "managed",
					});
				},
			}),
		);
		// The racer is a leaked row the test planted inside the transaction, which is rolled back too.
		expect(result.code).toBe("already_managed");
		const launches = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.launchCorrelationId, id));
		expect(launches).toEqual([]);
	});

	test("C5: a bind racing a delete of the session either refuses or leaves no managed row for a deleted session", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		await getDb().delete(sessions).where(eq(sessions.sessionId, id));
		const result = await refusal(bind(id, host, SOLO));
		expect(result.code).toBe("session_not_found");
		const managed = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, id));
		expect(managed).toEqual([]);
	});

	test("C5b: the session disappears between the pre-reads and the lock", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const result = await refusal(
			bind(id, host, SOLO, {
				now: NOW,
				beforeLock: async () => {
					await getDb().delete(events).where(eq(events.sessionId, id));
					await getDb().delete(sessions).where(eq(sessions.sessionId, id));
				},
			}),
		);
		expect(result.code).toBe("session_not_found");
		await expectNoRows(id);
	});
});

// ── 11: audit and signals (item 16) ──────────────────────────────────────────

describe("audit and post-commit signals", () => {
	test("session_bound carries the real actor, the host and the launch; one revalidation and one session_updated, after commit", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: null });
		const log = spyOn(console, "log");
		const revalidate = spyOn(wsRevalidation, "requestWsRevalidation");
		const updated: unknown[] = [];
		const onUpdated = (s: unknown) => updated.push(s);
		sessionBus.on("session_updated", onUpdated);
		try {
			const { launchRequestId } = await bind(id, host, ADMIN(t.admin.id));

			const line = log.mock.calls
				.map((call) => String(call[0]))
				.find((text) => text.includes('"session_bound"'));
			expect(line).toBeDefined();
			const parsed = JSON.parse(line as string);
			expect(parsed).toMatchObject({
				kind: "session_bound",
				by: t.admin.id,
				sessionId: id,
				supervisorId: host,
				launchRequestId,
				intendedOwner: t.alice.id,
			});
			expect(parsed.by).not.toBe("local-user");
			expect(revalidate).toHaveBeenCalledTimes(1);
			expect(updated.length).toBe(1);
		} finally {
			sessionBus.off("session_updated", onUpdated);
			log.mockRestore();
			revalidate.mockRestore();
		}
	});

	test("a refusal sends no signal and writes no audit line", async () => {
		const host = await seedHost({ leaseMs: -MIN });
		const id = await seedObserved();
		const log = spyOn(console, "log");
		const revalidate = spyOn(wsRevalidation, "requestWsRevalidation");
		try {
			await refusal(bind(id, host, SOLO));
			expect(revalidate).not.toHaveBeenCalled();
			expect(log.mock.calls.some((call) => String(call[0]).includes('"session_bound"'))).toBe(
				false,
			);
		} finally {
			log.mockRestore();
			revalidate.mockRestore();
		}
	});
});

// ── 12: launch lists (item 18) ───────────────────────────────────────────────

describe("the carrier row in launch lists", () => {
	test("it reads as a launch to canReadLaunch for its requester only (documents D2)", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		await bind(id, host, MEMBER(t.alice.id));
		const { launch } = await rowsFor(id);
		expect(authz.canReadLaunch(MEMBER(t.alice.id), launch)).toBe(true);
		expect(authz.canReadLaunch(MEMBER(t.bob.id), launch)).toBe(false);
		const listed = await getDb()
			.select({ id: launchRequests.id })
			.from(launchRequests)
			.where(
				and(like(launchRequests.status, "completed"), eq(launchRequests.launchCorrelationId, id)),
			);
		expect(listed.length).toBe(1);
	});
});

// ── 12b: the owner and ownership writers a takeover's settle will use (steps 4, 5) ─

describe("assignTakeoverOwner", () => {
	const run = <T>(fn: (tx: unknown) => Promise<T>) => withAdminLock(fn as never);

	test("gives an unowned session its owner, and says so", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: null });
		expect(await run((tx) => assignTakeoverOwner(tx, id, t.alice.id))).toBe(true);
		expect((await rowsFor(id)).session.ownerUserId).toBe(t.alice.id);
	});

	test("never overwrites an owner set in the meantime (the guard is IS NULL)", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: t.bob.id });
		expect(await run((tx) => assignTakeoverOwner(tx, id, t.alice.id))).toBe(false);
		expect((await rowsFor(id)).session.ownerUserId).toBe(t.bob.id);
	});

	test("a disabled or unknown assignee throws and leaves the session unowned", async () => {
		const t = await team();
		const id = await seedObserved({ ownerUserId: null });
		const { disableUserDirectly } = await import("../test-utils/team-fixtures.js");
		await disableUserDirectly(t.alice.id);
		await expect(run((tx) => assignTakeoverOwner(tx, id, t.alice.id))).rejects.toThrow();
		await expect(run((tx) => assignTakeoverOwner(tx, id, "no-such-user"))).rejects.toThrow();
		expect((await rowsFor(id)).session.ownerUserId).toBeNull();
	});

	test("leaves the recorded ingest key alone", async () => {
		const t = await team();
		const key = await seedKey("bind-assign", ["ingest"], null);
		const id = await seedObserved({ ownerUserId: null, ingestKeyId: key.id });
		await run((tx) => assignTakeoverOwner(tx, id, t.alice.id));
		expect((await rowsFor(id)).session.ingestKeyId).toBe(key.id);
	});
});

describe("releaseObservedBinding", () => {
	const release = (sessionId: string, launchRequestId: string) =>
		withAdminLock((tx) =>
			ownership.releaseObservedBinding(tx, { sessionId, launchRequestId, reason: "test" }),
		);

	test("deletes the takeover's two rows and logs the reason and who pressed the button; the session and events stay", async () => {
		const t = await team();
		const host = await seedHost({ ownerUserId: t.alice.id });
		const id = await seedObserved({ ownerUserId: t.alice.id });
		await db_insertEvent(id);
		const { launchRequestId } = await bind(id, host, MEMBER(t.alice.id));
		const log = spyOn(console, "log");
		try {
			expect(await release(id, launchRequestId)).toBe(true);
			const line = log.mock.calls
				.map((c) => String(c[0]))
				.find((x) => x.includes("session_takeover_released"));
			expect(JSON.parse(line as string)).toMatchObject({
				sessionId: id,
				launchRequestId,
				reason: "test",
				boundByUserId: t.alice.id,
			});
		} finally {
			log.mockRestore();
		}
		const { launch, managed, session } = await rowsFor(id);
		expect([launch ?? null, managed ?? null].every((row) => row === null)).toBe(true);
		expect(session).toBeDefined();
		const evs = await getDb().select().from(events).where(eq(events.sessionId, id));
		expect(evs.length).toBe(1);
	});

	test("deletes nothing for a launched session's rows, another launch's id, or a launch without the flag", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const [launched] = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: id,
				agentType: "codex_cli",
				cwd: CWD,
				status: "running",
				requestedSupervisorId: host,
				claimedBySupervisorId: host,
			})
			.returning();
		await getDb().insert(managedSessions).values({
			sessionId: id,
			launchRequestId: launched.id,
			supervisorId: host,
			managedState: "managed",
		});

		expect(await release(id, launched.id)).toBe(false);
		expect(await release(id, "some-other-launch")).toBe(false);

		const { launch, managed } = await rowsFor(id);
		expect([Boolean(launch), Boolean(managed)]).toEqual([true, true]);
	});

	test("deletes nothing when the flagged launch has a different id than the one named", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const { launchRequestId } = await bind(id, host, SOLO);
		expect(await release(id, "not-this-launch")).toBe(false);
		expect((await rowsFor(id)).managed).toBeDefined();
		expect(launchRequestId).toBeDefined();
	});
});

async function db_insertEvent(sessionId: string) {
	await getDb()
		.insert(events)
		.values({ sessionId, eventType: "UserPromptSubmit", content: "hello", rawPayload: {} });
}

// ── 13: drift guards (item 19) and workflow paths (item 29) ──────────────────

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name === "node_modules") continue;
			sourceFiles(full, out);
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

describe("what the host is told: the session's name (D11 step 14)", () => {
	test("a takeover's action carries the session's display name, from the row read inside the lock", async () => {
		const host = await seedHost();
		const id = await seedObserved({ displayName: "refactor the parser" });
		const result = await bind(id, host, SOLO, deps);
		expect((result.action.metadata as Record<string, unknown>).sessionName).toBe(
			"refactor the parser",
		);
	});

	test("a 900-character name arrives intact, so it equals the title the server will hold", async () => {
		const host = await seedHost();
		const long = ` ${"long name! ".repeat(90)}`;
		const id = await seedObserved({ displayName: long });
		const result = await bind(id, host, SOLO, deps);
		expect((result.action.metadata as Record<string, unknown>).sessionName).toBe(long);
	});

	test("a session with no name sends none, so the host's runtime and the server's title agree on nothing to rename", async () => {
		const host = await seedHost();
		const id = await seedObserved({ displayName: null });
		const result = await bind(id, host, SOLO, deps);
		expect(Object.hasOwn(result.action.metadata as object, "sessionName")).toBe(false);
	});

	test("the host's own parser gets that name: real server-built metadata in, the resume input out, never the id's first eight characters", async () => {
		const { mkdtempSync, realpathSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { createSessionResumer } = await import("../../supervisor/services/session-resume.js");
		const { createManagedThreadRecord } = await import(
			"../../supervisor/services/managed-thread-record.js"
		);
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-title-")));
		const host = await seedHost({ trustedRoots: [dir] });
		const id = await seedObserved({ cwd: dir, displayName: "refactor the parser" });
		const result = await bind(id, host, SOLO, deps);
		// What the host's claim returns: the stored row, unredacted.
		const [row] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, result.action.id));
		const seen: Array<{ sessionName: string }> = [];
		const resume = createSessionResumer({
			gate: {
				rulesState: () => "none",
				queuedState: () => "none",
				verdictForDirectory: () => "send",
				reportControlStatus: async () => ({}),
				refuseResume: async () => {},
			} as never,
			hostName: "h",
			trustedRoots: [dir],
			record: createManagedThreadRecord({ path: join(dir, "threads.json"), log: () => {} }),
			hold: { add() {}, delete() {} },
			neutralCwd: async () => dir,
			providers: {
				managedCodexRuntimeHolds: () => false,
				resumeManagedCodexSession: (async (input: { sessionName: string }) => {
					seen.push(input);
					return { pid: 1, metadata: {} };
				}) as never,
			},
			log: () => {},
		});
		await resume(
			{
				id: row.id,
				sessionId: id,
				launchRequestId: row.launchRequestId,
				actionType: "resume",
				status: "running",
				metadata: row.metadata,
			} as never,
			id,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.sessionName).toBe("refactor the parser");
		expect(seen[0]?.sessionName).not.toBe(id.slice(0, 8));
	});
});

describe("drift guards", () => {
	const serviceSource = () =>
		readFileSync(join(REPO, "src/server/services/session-binding.ts"), "utf8");

	test("the service writes no launch or managed row itself and reads no supervisor status", () => {
		const text = serviceSource();
		expect(text).not.toMatch(/\.(insert|delete)\(\s*(launchRequests|managedSessions)\b/);
		expect(text).not.toMatch(/supervisors?\.status\b/);
	});

	test("only the sessions route calls the service entry point, and no AI executor imports it", () => {
		const callers = sourceFiles(join(REPO, "src/server"))
			.filter((file) => /\bbindObservedSession\(/.test(readFileSync(file, "utf8")))
			.map((file) => relative(REPO, file))
			.sort();
		expect(callers).toEqual([
			"src/server/routes/sessions.ts",
			"src/server/services/session-binding.ts",
		]);
		const importers = sourceFiles(join(REPO, "src/server/services/ai"))
			.concat(sourceFiles(join(REPO, "src/server/services/ask")))
			.filter((file) => /session-binding(\.js)?["']/.test(readFileSync(file, "utf8")));
		expect(importers).toEqual([]);
	});

	test("the removed owner-undo symbols stay removed", () => {
		const removed = [`revert${"TakeoverOwner"}`, `assigned${"OwnerUserId"}`];
		const hits = sourceFiles(join(REPO, "src")).filter((file) => {
			const text = readFileSync(file, "utf8");
			return removed.some((symbol) => text.includes(symbol));
		});
		expect(hits.map((file) => relative(REPO, file))).toEqual([]);
	});

	test("the Postgres pull-request workflow covers the takeover files", () => {
		const workflow = readFileSync(
			join(REPO, ".github/workflows/codex-approvals-postgres.yml"),
			"utf8",
		);
		for (const needle of [
			"src/server/services/session-binding",
			"session-resume-lifecycle",
			"src/server/services/control-actions.ts",
			"src/server/services/managed-session-state.ts",
			"src/server/services/session-owner-admin.ts",
			"src/server/services/session-binding.test.ts",
			"src/server/routes/session-bind-route.test.ts",
		]) {
			expect({ needle, present: workflow.includes(needle) }).toEqual({ needle, present: true });
		}
	});
});

// ── 14: a typed union check (compile-time) ───────────────────────────────────

test("a BindRefusal code is a member of the shared union or invalid_body", () => {
	const code: ResumeRefusalCode | "invalid_body" = new BindRefusal("not_owner").code;
	expect(code).toBe("not_owner");
});
