/**
 * POST /sessions/:sessionId/interrupt: Stop turn on a continued Claude session (AGEN-119).
 *
 * The service's rules are in services/control-actions-claude-interrupt.test.ts; this file proves the gates in
 * front of it and the shape of the answers: scope, the owner rule, the origin gate, the limiter, the refusal
 * codes, and that `respond` still can't reach it. Real SQLite by default and Postgres under
 * AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { CLAUDE_STOP, CLAUDE_TURN_CONTROL } from "../../shared/constants.js";
import { CLAUDE_TAKEOVER } from "../../shared/session-resume.js";
import { CLAUDE_TURN_INTERRUPT } from "../../shared/stop-turn.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { cleanApprovalFixtures } = await import("../test-utils/codex-approvals-harness.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const policy = await import("../auth/route-scope-policy.js");
const { _resetSessionInterruptLimitForTest, SESSION_INTERRUPT_LIMIT_PER_MINUTE } = await import(
	"../services/session-interrupt-limit.js"
);

const ORIGIN = "http://localhost:3000";
const originalDisableAuth = config.disableAuth;
const FEATURES = [CLAUDE_STOP, CLAUDE_TURN_CONTROL, CLAUDE_TAKEOVER, CLAUDE_TURN_INTERRUPT];

beforeAll(() => initializeDatabase());
const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	_resetSessionInterruptLimitForTest();
	await cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

/** A continued session with a running prompt on a live host. */
async function seedFork(
	opts: {
		ownerUserId?: string | null;
		running?: boolean;
		fork?: boolean;
		features?: string[];
	} = {},
): Promise<string> {
	const sessionId = crypto.randomUUID();
	const hostId = `int-route-host-${crypto.randomUUID().slice(0, 8)}`;
	sessionsUsed.push(sessionId);
	hostsUsed.push(hostId);
	const { launchId } = await seedOwnedLaunch(sessionId, hostId);
	await getDb()
		.update(launchRequests)
		.set({ metadata: opts.fork === false ? {} : { boundObservedSession: true } })
		.where(eq(launchRequests.id, launchId));
	await getDb()
		.update(supervisors)
		.set({ capabilities: { version: 1, features: opts.features ?? FEATURES } as never })
		.where(eq(supervisors.id, hostId));
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			cwd: "/work/project",
			displayName: "fork",
			ownerUserId: opts.ownerUserId ?? null,
			status: "active",
			metadata: { forkPermissionBranch: "ask" },
		});
	const promptId = crypto.randomUUID();
	if (opts.running !== false) {
		await getDb()
			.insert(controlActions)
			.values({
				id: promptId,
				sessionId,
				actionType: "prompt",
				status: "running",
				claimedBySupervisorId: hostId,
				metadata: { agentType: "claude_code", runtime: "claude_stream" },
			});
	}
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launchId,
			supervisorId: hostId,
			managedState: "managed",
			hostName: "build-host",
			activeControlActionId: opts.running === false ? null : promptId,
			controlLockExpiresAt:
				opts.running === false ? null : new Date(Date.now() + 90_000).toISOString(),
		});
	return sessionId;
}

function interrupt(sessionId: string, headers: Headers = new Headers()) {
	return app.request(`/api/v1/sessions/${sessionId}/interrupt`, { method: "POST", headers });
}
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;
async function browser(userId: string, extra: Record<string, string> = {}) {
	const headers = new Headers(await cookieHeadersFor(userId));
	headers.set("Origin", ORIGIN);
	for (const [k, v] of Object.entries(extra)) headers.set(k, v);
	return headers;
}

describe("solo", () => {
	test("a signed-in person gets 202 with the queued interrupt, naming the target", async () => {
		const id = await seedFork();
		const user = await seedLocalUser("int-solo");
		const res = await interrupt(id, await browser(user.id));
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			action: { actionType: string; status: string; metadata: Record<string, unknown> };
		};
		expect(body.action).toMatchObject({ actionType: "interrupt", status: "queued" });
		expect(body.action.metadata.runtime).toBe("claude_stream");
		expect(typeof body.action.metadata.targetPromptActionId).toBe("string");
	});
});

describe("scope: a mutation, so manage; never respond", () => {
	test.each(["observe", "respond", "ingest"])(
		"a %s key is 403 insufficient_scope",
		async (scope) => {
			const id = await seedFork();
			const key = await seedKey(`int-${scope}`, [scope]);
			const res = await interrupt(id, bearerHeaders(key.key));
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("insufficient_scope");
			expect(
				await getDb()
					.select()
					.from(controlActions)
					.where(eq(controlActions.actionType, "interrupt")),
			).toEqual([]);
		},
	);

	test("a manage key may press it (as it may Stop); the audit comes from the real caller", async () => {
		const id = await seedFork();
		const key = await seedKey("int-manage", ["manage"]);
		expect((await interrupt(id, bearerHeaders(key.key))).status).toBe(202);
	});

	test("SCOPE_GRANTS.respond is unchanged: no interrupt in its writes, and the route is owner-checked", () => {
		const writes = [...policy.SCOPE_GRANTS.respond.writes].map(String);
		expect(writes.some((w) => w.includes("interrupt"))).toBe(false);
		expect(policy.scopeGrantAllows("respond", "POST", "/sessions/s1/interrupt")).toBe(false);
		expect(policy.OWNER_CHECKED_ROUTES.has("POST /sessions/:sessionId/interrupt")).toBe(true);
	});
});

describe("team: owner or admin", () => {
	test("the owner and an admin get 202; another member gets 403 not_owner and nothing is queued", async () => {
		await setStoredMode("team");
		const alice = await seedLocalUser("int-alice");
		const bob = await seedLocalUser("int-bob");
		const admin = await seedLocalUser("int-admin", "admin");
		const id = await seedFork({ ownerUserId: alice.id });
		const refused = await interrupt(id, await browser(bob.id));
		expect(refused.status).toBe(403);
		expect(await errorOf(refused)).toBe("not_owner");
		expect(
			await getDb().select().from(controlActions).where(eq(controlActions.actionType, "interrupt")),
		).toEqual([]);
		expect((await interrupt(id, await browser(alice.id))).status).toBe(202);
		const other = await seedFork({ ownerUserId: alice.id });
		expect((await interrupt(other, await browser(admin.id))).status).toBe(202);
	});
});

describe("the origin gate", () => {
	test("a foreign Origin is 403 bad_origin and nothing is queued", async () => {
		const id = await seedFork();
		const user = await seedLocalUser("int-origin");
		const res = await interrupt(id, await browser(user.id, { Origin: "https://evil.example" }));
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("bad_origin");
		expect(
			await getDb().select().from(controlActions).where(eq(controlActions.actionType, "interrupt")),
		).toEqual([]);
	});

	test("with auth off, a Host that is neither loopback nor allowlisted is bad_origin; loopback passes", async () => {
		(config as Record<string, unknown>).disableAuth = true;
		const id = await seedFork();
		const foreign = await interrupt(id, new Headers({ Host: "attacker.example" }));
		expect(foreign.status).toBe(403);
		expect(await errorOf(foreign)).toBe("bad_origin");
		const local = await interrupt(id, new Headers({ Host: "localhost:3000" }));
		expect(local.status).toBe(202);
	});
});

describe("refusals carry a code a client can branch on", () => {
	test("session_not_found is 404", async () => {
		const user = await seedLocalUser("int-404");
		const res = await interrupt(crypto.randomUUID(), await browser(user.id));
		expect(res.status).toBe(404);
		expect(await errorOf(res)).toBe("session_not_found");
	});

	test.each([
		["no turn running", { running: false }, "no_turn_running"],
		[
			"a launched Claude that isn't a continued session",
			{ fork: false },
			"interrupt_not_supported",
		],
		[
			"a host without the feature",
			{ features: [CLAUDE_STOP, CLAUDE_TURN_CONTROL, CLAUDE_TAKEOVER] },
			"host_upgrade_required",
		],
	] as Array<[string, Parameters<typeof seedFork>[0], string]>)(
		"%s is 409 %s",
		async (_name, opts, code) => {
			const id = await seedFork(opts);
			const user = await seedLocalUser(`int-${code}`);
			const res = await interrupt(id, await browser(user.id));
			expect(res.status).toBe(409);
			expect(await errorOf(res)).toBe(code);
		},
	);

	test("an observed session with no managed row is 409 not_managed", async () => {
		const sessionId = crypto.randomUUID();
		sessionsUsed.push(sessionId);
		await getDb().insert(sessions).values({
			sessionId,
			agentType: "claude_code",
			cwd: "/w",
			displayName: "x",
			status: "active",
		});
		const user = await seedLocalUser("int-notmanaged");
		const res = await interrupt(sessionId, await browser(user.id));
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("not_managed");
	});
});

describe("the limiter: six a minute per caller", () => {
	test("the seventh press is 429 rate_limited with a Retry-After; another caller is unaffected", async () => {
		const id = await seedFork();
		const user = await seedLocalUser("int-limit");
		const other = await seedLocalUser("int-limit-2");
		const headers = await browser(user.id);
		expect(SESSION_INTERRUPT_LIMIT_PER_MINUTE).toBe(6);
		for (let i = 0; i < 6; i++) {
			expect((await interrupt(id, headers)).status).toBe(202);
		}
		const limited = await interrupt(id, headers);
		expect(limited.status).toBe(429);
		expect(await errorOf(limited)).toBe("rate_limited");
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect((await interrupt(id, await browser(other.id))).status).toBe(202);
	});
});
