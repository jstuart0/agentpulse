/**
 * POST /sessions/:sessionId/bind: the route that takes over an observed Codex session (AGEN-115, phase 1).
 *
 * The service's own rules (rows, host, quiet clock, collisions, concurrency) are in
 * services/session-binding.test.ts; this file proves the gates in front of it and the shape of the answers:
 * scope, human-only, the browser origin gate, the strict body, the limiter, and that a refusal writes nothing.
 * Real SQLite by default and real Postgres under AGENTPULSE_TEST_BACKEND=postgres.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import "../db/__test_db.js";
import { CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import { RESUMES_SESSIONS } from "../../shared/session-resume.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	disableUserDirectly,
	seedKey,
	seedLocalUser,
	setAdminServiceKeyList,
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
const { ENFORCES_LAUNCH_PRIVILEGES } = await import("../services/launch-compatibility.js");
const policy = await import("../auth/route-scope-policy.js");
const { _resetSessionBindLimitForTest } = await import("../services/session-bind-limit.js");

const ORIGIN = "http://localhost:3000";
const originalDisableAuth = config.disableAuth;

beforeAll(() => initializeDatabase());

const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	_resetSessionBindLimitForTest();
	await cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

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

async function seedHost(ownerUserId: string | null = null): Promise<string> {
	const id = `bind-route-host-${crypto.randomUUID().slice(0, 8)}`;
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
			capabilities: CAPABILITIES,
			trustedRoots: ["/work"],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			enrollmentState: "active",
			ownerUserId,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

async function seedObserved(
	opts: { ownerUserId?: string | null; ingestKeyId?: string | null; agentType?: string } = {},
): Promise<string> {
	const sessionId = crypto.randomUUID();
	sessionsUsed.push(sessionId);
	// An owned session was reported by its owner's key unless a test says otherwise (null = no key recorded).
	const ingestKeyId =
		opts.ingestKeyId !== undefined
			? opts.ingestKeyId
			: opts.ownerUserId
				? (await seedKey("br-reporter", ["ingest"], opts.ownerUserId)).id
				: null;
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: opts.agentType ?? "codex_cli",
			cwd: "/work/project",
			displayName: "observed",
			ownerUserId: opts.ownerUserId ?? null,
			ingestKeyId,
			lastActivityAt: new Date(Date.now() - 30 * 60_000).toISOString(),
			status: "idle",
		});
	return sessionId;
}

function withHeaders(base: Headers, extra: Record<string, string> = {}): Headers {
	const merged = new Headers(base);
	for (const [key, value] of Object.entries(extra)) merged.set(key, value);
	return merged;
}

interface BindOptions {
	contentType?: string | null;
	raw?: string;
}

function bind(sessionId: string, headers: Headers, body: unknown, options: BindOptions = {}) {
	const merged = new Headers(headers);
	const contentType = options.contentType === undefined ? "application/json" : options.contentType;
	if (contentType !== null) merged.set("Content-Type", contentType);
	return app.request(`/api/v1/sessions/${sessionId}/bind`, {
		method: "POST",
		headers: merged,
		body: options.raw ?? JSON.stringify(body),
	});
}

const confirmed = (host: string) => ({ targetSupervisorId: host, sameMachineConfirmed: true });

async function browser(userId: string) {
	return withHeaders(await cookieHeadersFor(userId), { Origin: ORIGIN });
}

async function team() {
	await setStoredMode("team");
	const alice = await seedLocalUser("br-alice");
	const bob = await seedLocalUser("br-bob");
	const admin = await seedLocalUser("br-admin", "admin");
	return { alice, bob, admin };
}

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

async function bytes(res: Response) {
	return {
		status: res.status,
		contentType: res.headers.get("content-type"),
		cacheControl: res.headers.get("cache-control"),
		body: await res.text(),
	};
}

async function noRows(sessionId: string) {
	const launches = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, sessionId));
	const managed = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	const actions = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, sessionId));
	expect([launches.length, managed.length, actions.length]).toEqual([0, 0, 0]);
}

describe("solo", () => {
	test("any caller gets 202 with the action and the launch id, never cached", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const user = await seedLocalUser("br-solo");

		const res = await bind(id, await browser(user.id), confirmed(host));

		expect(res.status).toBe(202);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as {
			action: { actionType: string; status: string; metadata?: Record<string, unknown> };
			launchRequestId: string;
		};
		expect(body.action.actionType).toBe("resume");
		expect(body.action.status).toBe("queued");
		expect(typeof body.launchRequestId).toBe("string");
		expect(body.action.metadata?.env).toBeUndefined();
	});
});

describe("team: who may take over", () => {
	test("the owner and an admin get 202", async () => {
		const t = await team();
		const hostA = await seedHost(t.alice.id);
		const idA = await seedObserved({ ownerUserId: t.alice.id });
		expect((await bind(idA, await browser(t.alice.id), confirmed(hostA))).status).toBe(202);

		const idB = await seedObserved({ ownerUserId: t.alice.id });
		expect((await bind(idB, await browser(t.admin.id), confirmed(hostA))).status).toBe(202);
	});

	test("a member on another's session answers byte-for-byte what a missing session answers", async () => {
		const t = await team();
		const host = await seedHost(t.bob.id);
		const owned = await seedObserved({ ownerUserId: t.alice.id });
		const missing = crypto.randomUUID();
		const headers = await browser(t.bob.id);

		const foreign = await bytes(await bind(owned, headers, confirmed(host)));
		const absent = await bytes(await bind(missing, headers, confirmed(host)));

		expect(foreign).toEqual(absent);
		expect(foreign.status).toBe(404);
		expect(JSON.parse(foreign.body)).toEqual({ error: "session_not_found" });
		await noRows(owned);
	});

	test("negative control: a member on an unowned session is 403 not_owner (a different answer)", async () => {
		const t = await team();
		const host = await seedHost(t.bob.id);
		const unowned = await seedObserved({ ownerUserId: null });
		const res = await bind(unowned, await browser(t.bob.id), confirmed(host));
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("not_owner");
		await noRows(unowned);
	});

	test("a member's foreign, unowned and nonexistent hosts answer byte-equal", async () => {
		const t = await team();
		const foreign = await seedHost(t.bob.id);
		const unowned = await seedHost(null);
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const headers = await browser(t.alice.id);

		const answers = [];
		for (const host of [foreign, unowned, "missing-host"]) {
			answers.push(await bytes(await bind(id, headers, confirmed(host))));
		}
		expect(answers[0].status).toBe(403);
		expect(JSON.parse(answers[0].body)).toEqual({ error: "host_not_allowed" });
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[2]).toEqual(answers[0]);
		await noRows(id);
	});

	test("a disabled user is refused, and so is one who must change their password", async () => {
		const t = await team();
		const host = await seedHost(t.alice.id);
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const headers = await browser(t.alice.id);
		await disableUserDirectly(t.alice.id);
		expect((await bind(id, headers, confirmed(host))).status).toBe(401);

		const carol = await seedLocalUser("br-carol", "user", { mustChangePassword: true });
		const carolHost = await seedHost(carol.id);
		const carolSession = await seedObserved({ ownerUserId: carol.id });
		const res = await bind(carolSession, await browser(carol.id), confirmed(carolHost));
		expect(res.status).toBe(403);
		expect(await errorOf(res)).toBe("password_change_required");
		await noRows(id);
		await noRows(carolSession);
	});
});

describe("keys", () => {
	async function setup() {
		const t = await team();
		const host = await seedHost(t.alice.id);
		const id = await seedObserved({ ownerUserId: t.alice.id });
		return { t, host, id };
	}

	test.each(["ingest", "observe", "respond"])(
		"a %s key is 403 insufficient_scope",
		async (scope) => {
			const { t, host, id } = await setup();
			const key = await seedKey(`br-${scope}`, [scope], t.alice.id);
			const res = await bind(id, bearerHeaders(key.key), confirmed(host));
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("insufficient_scope");
			await noRows(id);
		},
	);

	test("a manage key and an admin-owned manage key are 403 human_required; the same body from the cookie human succeeds", async () => {
		const { t, host, id } = await setup();
		const ownerKey = await seedKey("br-manage-owner", ["manage"], t.alice.id);
		const adminKey = await seedKey("br-manage-admin", ["manage"], t.admin.id);
		const serviceKey = await seedKey("br-manage-service", ["manage"], null);
		await setAdminServiceKeyList([serviceKey.id]);
		for (const key of [ownerKey, adminKey, serviceKey]) {
			const res = await bind(id, bearerHeaders(key.key), confirmed(host));
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("human_required");
		}
		await noRows(id);

		const human = await bind(id, await browser(t.alice.id), confirmed(host));
		expect(human.status).toBe(202);
	});
});

describe("the browser origin gate", () => {
	test("a foreign Origin is 403 bad_origin, for a cookie and for a key", async () => {
		const t = await team();
		const host = await seedHost(t.alice.id);
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const key = await seedKey("br-origin", ["manage"], t.alice.id);
		const evil = { Origin: "https://evil.example" };
		for (const headers of [
			withHeaders(await cookieHeadersFor(t.alice.id), evil),
			withHeaders(bearerHeaders(key.key), evil),
		]) {
			const res = await bind(id, headers, confirmed(host));
			expect(res.status).toBe(403);
			expect(await errorOf(res)).toBe("bad_origin");
		}
		await noRows(id);
	});

	test("a cookie caller with no Origin and no Sec-Fetch-Site is refused; the page's own Origin and same-origin pass", async () => {
		const t = await team();
		const host = await seedHost(t.alice.id);
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const plain = await cookieHeadersFor(t.alice.id);

		const refused = await bind(id, plain, confirmed(host));
		expect(refused.status).toBe(403);
		expect(await errorOf(refused)).toBe("bad_origin");
		await noRows(id);

		const sameOrigin = await bind(
			id,
			withHeaders(plain, { "Sec-Fetch-Site": "same-origin" }),
			confirmed(host),
		);
		expect(sameOrigin.status).toBe(202);
	});

	describe("DISABLE_AUTH", () => {
		test("an untrusted Host is refused before the body is read; a rebound page (Origin equals Host) too", async () => {
			const host = await seedHost();
			const id = await seedObserved();
			(config as Record<string, unknown>).disableAuth = true;
			const rebound = await bind(
				id,
				new Headers({ Host: "attacker.example:3000", Origin: "http://attacker.example:3000" }),
				confirmed(host),
			);
			expect(rebound.status).toBe(403);
			expect(await errorOf(rebound)).toBe("bad_origin");
			const garbage = await bind(id, new Headers({ Host: "attacker.example:3000" }), null, {
				raw: "{not json",
			});
			expect(garbage.status).toBe(403);
			await noRows(id);
		});

		test("a loopback client sending JSON with no Origin passes; no Origin and not JSON does not", async () => {
			const host = await seedHost();
			const id = await seedObserved();
			(config as Record<string, unknown>).disableAuth = true;
			const refused = await bind(id, new Headers({ Host: "localhost:3000" }), null, {
				contentType: "text/plain",
				raw: JSON.stringify(confirmed(host)),
			});
			expect(refused.status).toBe(403);
			await noRows(id);

			const ok = await bind(id, new Headers({ Host: "localhost:3000" }), confirmed(host));
			expect(ok.status).toBe(202);
		});
	});
});

describe("the body is strict", () => {
	async function setup() {
		const host = await seedHost();
		const id = await seedObserved();
		const user = await seedLocalUser("br-body");
		return { host, id, headers: await browser(user.id) };
	}

	test.each([
		["cwd", { cwd: "/work/other" }],
		["env", { env: { A: "b" } }],
		["model", { model: "gpt-x" }],
		["approvalPolicy", { approvalPolicy: "never" }],
		["sandboxMode", { sandboxMode: "danger-full-access" }],
		["agentType", { agentType: "codex_cli" }],
		["cliArgs", { cliArgs: ["--x"] }],
		["prompt", { prompt: "do it" }],
		["an unknown key", { somethingElse: 1 }],
	])("%s is a 400", async (_name, extra) => {
		const { host, id, headers } = await setup();
		const res = await bind(id, headers, { ...confirmed(host), ...extra });
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("invalid_body");
		await noRows(id);
	});

	test.each([
		["a non-object", "mcp"],
		["null", null],
		["an array", [true]],
		["an unknown key", { sandbox: true }],
		["a string value", { mcp: "yes" }],
		["a number value", { subagents: 1 }],
		["a nested object", { mcp: { servers: ["a"] } }],
	])("forkOptions that is %s is a 400", async (_name, forkOptions) => {
		const { host, id, headers } = await setup();
		const res = await bind(id, headers, { ...confirmed(host), forkOptions });
		expect(res.status).toBe(400);
		expect(await errorOf(res)).toBe("invalid_body");
		await noRows(id);
	});

	test("forkOptions is exactly the two booleans: asking for none passes, asking for an option on a Codex session is a 409 fork_options_not_supported", async () => {
		const { host, id, headers } = await setup();
		const asked = await bind(id, headers, { ...confirmed(host), forkOptions: { mcp: true } });
		expect(asked.status).toBe(409);
		expect(await errorOf(asked)).toBe("fork_options_not_supported");
		await noRows(id);
		const none = await bind(id, headers, { ...confirmed(host), forkOptions: { mcp: false } });
		expect(none.status).toBe(202);
	});

	test.each([
		["missing", undefined],
		["false", false],
		['the string "true"', "true"],
		["1", 1],
		["null", null],
	])("sameMachineConfirmed %s is a 400", async (_name, value) => {
		const { host, id, headers } = await setup();
		const body: Record<string, unknown> = { targetSupervisorId: host };
		if (value !== undefined) body.sameMachineConfirmed = value;
		const res = await bind(id, headers, body);
		expect(res.status).toBe(400);
		await noRows(id);
	});

	test("a missing, empty or non-string target is a 400; a non-object body is a 400", async () => {
		const { id, headers } = await setup();
		for (const body of [
			{ sameMachineConfirmed: true },
			{ targetSupervisorId: "", sameMachineConfirmed: true },
			{ targetSupervisorId: 7, sameMachineConfirmed: true },
			[],
			"x",
			null,
		]) {
			expect((await bind(id, headers, body)).status).toBe(400);
		}
		await noRows(id);
	});

	test("a body over 16 KiB is 413, and a missing or non-JSON content type is 415", async () => {
		const { host, id, headers } = await setup();
		const padding = "x".repeat(16 * 1024 + 1);
		const oversized = JSON.stringify({ ...confirmed(host), padding });
		const tooBig = await bind(
			id,
			withHeaders(headers, {
				"Content-Length": String(new TextEncoder().encode(oversized).length),
			}),
			null,
			{ raw: oversized },
		);
		expect(tooBig.status).toBe(413);

		const wrongType = await bind(id, headers, null, {
			contentType: "text/plain",
			raw: JSON.stringify(confirmed(host)),
		});
		expect(wrongType.status).toBe(415);
		const noType = await bind(id, headers, null, {
			contentType: null,
			raw: JSON.stringify(confirmed(host)),
		});
		expect(noType.status).toBe(415);
		await noRows(id);
	});

	test("a claude_code session on a host that can't continue Claude is host_cannot_run_claude, with no rows; copilot_cli stays agent_not_supported", async () => {
		const host = await seedHost();
		const user = await seedLocalUser("br-claude");
		const claudeId = await seedObserved({ agentType: "claude_code" });
		const res = await bind(claudeId, await browser(user.id), confirmed(host));
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("host_cannot_run_claude");
		await noRows(claudeId);
		const copilotId = await seedObserved({ agentType: "copilot_cli" });
		const copilot = await bind(copilotId, await browser(user.id), confirmed(host));
		expect(copilot.status).toBe(409);
		expect(await errorOf(copilot)).toBe("agent_not_supported");
		await noRows(copilotId);
	});
});

describe("the limiter", () => {
	test("the 11th request in a minute is 429 rate_limited and writes no row; another caller is unaffected", async () => {
		const host = await seedHost();
		const user = await seedLocalUser("br-limit");
		const other = await seedLocalUser("br-limit-other");
		const headers = await browser(user.id);
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			const id = await seedObserved({ agentType: "claude_code" });
			ids.push(id);
			expect((await bind(id, headers, confirmed(host))).status).toBe(409);
		}
		const eleventh = await seedObserved();
		const limited = await bind(eleventh, headers, confirmed(host));
		expect(limited.status).toBe(429);
		expect(await errorOf(limited)).toBe("rate_limited");
		await noRows(eleventh);

		const unaffected = await bind(eleventh, await browser(other.id), confirmed(host));
		expect(unaffected.status).toBe(202);
	});
});

describe("classification", () => {
	test("the route is owner-checked and in no scope grant", () => {
		expect(policy.OWNER_CHECKED_ROUTES.has("POST /sessions/:sessionId/bind")).toBe(true);
		for (const scope of [
			policy.SCOPE_GRANTS.observe,
			policy.SCOPE_GRANTS.ingest,
			policy.SCOPE_GRANTS.respond,
		]) {
			expect(scope.writes.has("POST /sessions/:sessionId/bind")).toBe(false);
		}
	});

	test("a credential-less request is not served", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const res = await bind(id, new Headers(), confirmed(host));
		expect([401, 403]).toContain(res.status);
		await noRows(id);
	});
});

describe("retry on a taken-over session (D19)", () => {
	test("is 409 retry_not_available with no launch row; a launched session's retry still works", async () => {
		const host = await seedHost();
		const id = await seedObserved();
		const user = await seedLocalUser("br-retry");
		const headers = await browser(user.id);
		expect((await bind(id, headers, confirmed(host))).status).toBe(202);
		const before = await getDb().select().from(launchRequests);

		const res = await app.request(`/api/v1/sessions/${id}/retry`, { method: "POST", headers });

		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("retry_not_available");
		expect((await getDb().select().from(launchRequests)).length).toBe(before.length);

		// The control: a launched session's retry is not refused.
		const launchedId = crypto.randomUUID();
		sessionsUsed.push(launchedId);
		await getDb().insert(sessions).values({
			sessionId: launchedId,
			agentType: "claude_code",
			cwd: "/tmp/owned-launch-fixture",
		});
		const { launchId } = await seedOwnedLaunch(launchedId, host);
		await getDb()
			.update(launchRequests)
			.set({ cwd: "/work/launched", requestedLaunchMode: "headless" })
			.where(eq(launchRequests.id, launchId));
		await getDb().insert(managedSessions).values({
			sessionId: launchedId,
			launchRequestId: launchId,
			supervisorId: host,
			managedState: "managed",
		});
		const retried = await app.request(`/api/v1/sessions/${launchedId}/retry`, {
			method: "POST",
			headers,
		});
		expect(retried.status).toBe(201);
		await getDb().delete(launchRequests).where(eq(launchRequests.retryOfLaunchRequestId, launchId));
		await getDb()
			.delete(controlActions)
			.where(inArray(controlActions.sessionId, [launchedId]));
	});
});

describe("the carrier row in launch lists and in launchesToday (D2, documented)", () => {
	test("GET /launches shows it to its requester only; launchesToday counts it for the owner", async () => {
		const t = await team();
		const host = await seedHost(t.alice.id);
		const id = await seedObserved({ ownerUserId: t.alice.id });
		const adminHeaders = await browser(t.admin.id);
		const stats = async () =>
			(
				(await (
					await app.request(`/api/v1/sessions/stats?owner=${t.alice.id}`, { headers: adminHeaders })
				).json()) as { launchesToday: number }
			).launchesToday;
		const before = await stats();

		const res = await bind(id, await browser(t.alice.id), confirmed(host));
		expect(res.status).toBe(202);
		const { launchRequestId } = (await res.json()) as { launchRequestId: string };

		const ids = async (userId: string) =>
			(
				(await (
					await app.request("/api/v1/launches", { headers: await browser(userId) })
				).json()) as { launches: Array<{ id: string }> }
			).launches.map((launch) => launch.id);
		expect(await ids(t.alice.id)).toContain(launchRequestId);
		expect(await ids(t.bob.id)).not.toContain(launchRequestId);
		expect(await stats()).toBe(before + 1);
	});
});
