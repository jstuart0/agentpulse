/**
 * AGEN-66: a host that re-enrolls gets a new supervisor id, and the sessions it
 * ran stay with the old one. Nothing can re-point them (no proof survives losing
 * the credential), so the server says so at once: stop and prompt are refused
 * 409 host_offline / host_gone with nothing queued, instead of sitting for the
 * 90 s control lock and failing. Built on the real enroll, register, claim and
 * report HTTP flow, then the lease is moved the way time would.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { CLAUDE_STOP_UPGRADE_MESSAGE } from "../../shared/managed-messages.js";
import "../db/__test_db.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { app } = await import("../app.js");
const { createApiKey } = await import("../auth/api-key.js");
const {
	controlActions,
	events,
	launchRequests,
	managedSessions,
	sessions,
	supervisorEnrollmentTokens,
	supervisors,
} = await import("../db/schema/index.js");
const { getSessionOwnerHostStates } = await import("../services/session-ownership.js");

type Credential = { id: string; token: string };

const originalDisableAuth = config.disableAuth;
const CWD = "/tmp/reenrolled-host-control";
let manageKey: string;

const bearer = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${manageKey}` });
const agent = (cred: Credential) => ({
	"Content-Type": "application/json",
	"X-AgentPulse-Supervisor-Token": cred.token,
});

async function enroll(hostName: string): Promise<Credential> {
	const enrolled = await app.request("/api/v1/admin/supervisors/enroll", {
		method: "POST",
		headers: bearer(),
		body: JSON.stringify({ name: hostName }),
	});
	expect(enrolled.status).toBe(201);
	const { token: enrollmentToken } = (await enrolled.json()) as { token: string };
	const registered = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken,
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: ["claude_stop"],
				executables: {
					claude: { available: true, command: "claude", resolvedPath: "/bin/claude" },
				},
			},
			trustedRoots: ["/tmp"],
		}),
	});
	expect(registered.status).toBe(200);
	const body = (await registered.json()) as {
		supervisor: { id: string };
		supervisorCredential: string;
	};
	return { id: body.supervisor.id, token: body.supervisorCredential };
}

/** A validated launch for `sessionId` aimed at `host`, claimed and reported over HTTP, so the claim is real. */
async function launchedOn(sessionId: string, host: Credential): Promise<string> {
	await getDb().insert(launchRequests).values({
		launchCorrelationId: sessionId,
		agentType: "claude_code",
		cwd: CWD,
		requestedSupervisorId: host.id,
		requestedLaunchMode: "headless",
		status: "validated",
	});
	const claim = await app.request(`/api/v1/supervisors/${host.id}/launches/claim`, {
		method: "POST",
		headers: agent(host),
	});
	const { launchRequest } = (await claim.json()) as { launchRequest: { id: string } | null };
	expect(launchRequest?.id).toBeTruthy();
	const report = await app.request(`/api/v1/supervisors/${host.id}/managed-session-state`, {
		method: "POST",
		headers: agent(host),
		// The row names the launch's agent type, as a real supervisor's first report does.
		body: JSON.stringify({
			sessionId,
			launchRequestId: launchRequest?.id,
			agentType: "claude_code",
		}),
	});
	expect(report.status).toBe(200);
	return launchRequest?.id as string;
}

async function setLease(hostId: string, offsetMs: number) {
	await getDb()
		.update(supervisors)
		.set({ heartbeatLeaseExpiresAt: new Date(Date.now() + offsetMs).toISOString() })
		.where(eq(supervisors.id, hostId));
}
async function heartbeat(host: Credential) {
	const res = await app.request(`/api/v1/supervisors/${host.id}/heartbeat`, {
		method: "POST",
		headers: agent(host),
	});
	expect(res.status).toBe(200);
}

const post = (path: string, body?: unknown) =>
	app.request(`/api/v1${path}`, {
		method: "POST",
		headers: bearer(),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const actionRows = () => getDb().select().from(controlActions);
const launchRows = () => getDb().select().from(launchRequests);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	manageKey = (await createApiKey("reenrolled-host-control", ["manage"])).key;
});
afterAll(async () => {
	await deleteAllSupervisors();
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});
beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await deleteAllSupervisors();
	await getDb().delete(supervisorEnrollmentTokens).execute();
});

/** The same machine enrolling again (same host name) and a different name both get a new id. */
for (const [label, newHostName] of [
	["re-enrolled under the same host name", "studio"],
	["a different host with another name", "other-box"],
] as const) {
	describe(`after the host ran a session and ${label}`, () => {
		async function world() {
			const old = await enroll("studio");
			const sessionId = `reenroll-${crypto.randomUUID().slice(0, 8)}`;
			const launchId = await launchedOn(sessionId, old);
			const replacement = await enroll(newHostName);
			expect(replacement.id).not.toBe(old.id);
			return { old, replacement, sessionId, launchId };
		}

		test("with the old lease expired, stop and prompt are refused host_offline at once and queue nothing", async () => {
			const { old, sessionId } = await world();
			await setLease(old.id, -1_000);

			const stop = await post(`/sessions/${sessionId}/stop`);
			expect(stop.status).toBe(409);
			expect(await errorOf(stop)).toBe("host_offline");
			const prompt = await post(`/sessions/${sessionId}/prompt`, { prompt: "hello" });
			expect(prompt.status).toBe(409);
			expect(await errorOf(prompt)).toBe("host_offline");

			expect(await actionRows()).toHaveLength(0);
			const [managed] = await getDb()
				.select()
				.from(managedSessions)
				.where(eq(managedSessions.sessionId, sessionId));
			expect(managed?.activeControlActionId).toBeNull();
		});

		test("the new id claims nothing, and its reports about the old session are 403 session_not_owned", async () => {
			const { old, replacement, sessionId } = await world();
			await heartbeat(old);
			const queued = await post(`/sessions/${sessionId}/stop`);
			expect(queued.status).toBe(202);
			await setLease(old.id, -1_000);

			const claim = await app.request(
				`/api/v1/supervisors/${replacement.id}/control-actions/claim`,
				{ method: "POST", headers: agent(replacement) },
			);
			expect(((await claim.json()) as { action: unknown }).action).toBeNull();

			const state = await app.request(
				`/api/v1/supervisors/${replacement.id}/managed-session-state`,
				{ method: "POST", headers: agent(replacement), body: JSON.stringify({ sessionId }) },
			);
			expect(state.status).toBe(403);
			expect(await errorOf(state)).toBe("session_not_owned");
			const eventsRes = await app.request(
				`/api/v1/supervisors/${replacement.id}/managed-sessions/${sessionId}/events`,
				{
					method: "POST",
					headers: agent(replacement),
					body: JSON.stringify({ events: [{ eventType: "ManagedNote", content: "x" }] }),
				},
			);
			expect(eventsRes.status).toBe(403);
			expect(await errorOf(eventsRes)).toBe("session_not_owned");
		});
	});
}

describe("the old host's own state", () => {
	test("a revoked host gives host_gone on stop, prompt and retry, with nothing queued or cloned", async () => {
		const old = await enroll("studio");
		const sessionId = `revoked-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		const launchesBefore = (await launchRows()).length;
		const revoke = await post(`/admin/supervisors/${old.id}/revoke`);
		expect(revoke.status).toBe(200);

		for (const [path, body] of [
			[`/sessions/${sessionId}/stop`, undefined],
			[`/sessions/${sessionId}/prompt`, { prompt: "hello" }],
			[`/sessions/${sessionId}/retry`, undefined],
		] as const) {
			const res = await post(path, body);
			expect(res.status).toBe(409);
			expect(await errorOf(res)).toBe("host_gone");
		}
		expect(await actionRows()).toHaveLength(0);
		expect(await launchRows()).toHaveLength(launchesBefore);
	});

	test("with a live lease, stop still queues", async () => {
		const old = await enroll("studio");
		const sessionId = `live-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		await heartbeat(old);
		const stop = await post(`/sessions/${sessionId}/stop`);
		expect(stop.status).toBe(202);
		expect(await actionRows()).toHaveLength(1);
	});

	test("retry to an offline host still works and queues its launch", async () => {
		const old = await enroll("studio");
		const sessionId = `retry-off-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		await setLease(old.id, -1_000);
		const retry = await post(`/sessions/${sessionId}/retry`);
		expect(retry.status).toBe(201);
		const body = (await retry.json()) as { launchRequest: { status: string } };
		expect(body.launchRequest.status).toBe("validated");
	});

	test("retry with a requested host that no longer exists gives host_gone, with no cloned launch and no action", async () => {
		const old = await enroll("studio");
		const sessionId = `retry-gone-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		await getDb()
			.update(launchRequests)
			.set({ requestedSupervisorId: "removed-host" })
			.where(eq(launchRequests.launchCorrelationId, sessionId));
		const launchesBefore = (await launchRows()).length;

		const retry = await post(`/sessions/${sessionId}/retry`);
		expect(retry.status).toBe(409);
		expect(await errorOf(retry)).toBe("host_gone");
		expect(await launchRows()).toHaveLength(launchesBefore);
		expect(await actionRows()).toHaveLength(0);
	});

	test("the lease boundary: now equal to the expiry reads offline", async () => {
		const old = await enroll("studio");
		const sessionId = `edge-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		const expiry = Date.now() + 60_000;
		await getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(expiry).toISOString() })
			.where(eq(supervisors.id, old.id));
		const at = async (nowMs: number) =>
			(await getSessionOwnerHostStates([sessionId], nowMs)).get(sessionId)?.state;
		expect(await at(expiry)).toBe("offline");
		expect(await at(expiry - 1)).toBe("live");
	});

	test("a lease that runs out after the check is accepted: the queued action fails by the existing lock expiry", async () => {
		// Accepted, not fixed: the check and the insert are one transaction, but the host can
		// still stop heartbeating the next millisecond. That action is no worse than before
		// this change: it holds the lock and fails when the 90 s lock lapses.
		const old = await enroll("studio");
		const sessionId = `toctou-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		await heartbeat(old);
		const queued = await post(`/sessions/${sessionId}/stop`);
		expect(queued.status).toBe(202);
		await setLease(old.id, -1_000);
		expect((await actionRows())[0]?.status).toBe("queued");

		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(managedSessions.sessionId, sessionId));
		const next = await post(`/sessions/${sessionId}/stop`);
		expect(next.status).toBe(409);
		expect(await errorOf(next)).toBe("host_offline");
		const [first] = await actionRows();
		expect(first?.status).toBe("failed");
	});
});

describe("re-enrollment errors are unchanged", () => {
	async function registerWith(body: Record<string, unknown>) {
		return app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hostName: "studio",
				platform: "linux",
				arch: "x64",
				version: "1.0.0",
				capabilities: {
					version: 1,
					agentTypes: ["claude_code"],
					launchModes: ["headless"],
					os: "linux",
					terminalSupport: [],
					features: [],
				},
				trustedRoots: [],
				...body,
			}),
		});
	}

	async function tokenFor(name: string): Promise<string> {
		const res = await app.request("/api/v1/admin/supervisors/enroll", {
			method: "POST",
			headers: bearer(),
			body: JSON.stringify({ name }),
		});
		return ((await res.json()) as { token: string }).token;
	}

	test("a deactivated enrollment token is refused 401 and creates no host; the old session stays refused", async () => {
		const old = await enroll("studio");
		const sessionId = `err-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		const token = await tokenFor("studio");
		await getDb().update(supervisorEnrollmentTokens).set({ isActive: false });
		const hostsBefore = (await getDb().select().from(supervisors)).length;

		const res = await registerWith({ enrollmentToken: token });
		expect(res.status).toBe(401);
		expect(await errorOf(res)).toBe("Invalid enrollment token");
		expect(await getDb().select().from(supervisors)).toHaveLength(hostsBefore);

		await setLease(old.id, -1_000);
		expect((await post(`/sessions/${sessionId}/stop`)).status).toBe(409);
	});

	test("an unscoped token naming an existing host id is refused supervisor_exists_use_rotate and creates no host", async () => {
		const old = await enroll("studio");
		const sessionId = `err2-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, old);
		const token = await tokenFor("studio");
		const hostsBefore = (await getDb().select().from(supervisors)).length;

		const res = await registerWith({ enrollmentToken: token, id: old.id });
		expect(res.status).toBe(409);
		expect(await errorOf(res)).toBe("supervisor_exists_use_rotate");
		expect(await getDb().select().from(supervisors)).toHaveLength(hostsBefore);

		await setLease(old.id, -1_000);
		const stop = await post(`/sessions/${sessionId}/stop`);
		expect(await errorOf(stop)).toBe("host_offline");
	});
});

describe("a Claude stop's refusals, as the dashboard and MCP read them", () => {
	async function liveWorld() {
		const host = await enroll("studio");
		const sessionId = `refusal-${crypto.randomUUID().slice(0, 8)}`;
		await launchedOn(sessionId, host);
		await heartbeat(host);
		return { host, sessionId };
	}
	const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

	test("a host that predates claude_stop: 409 host_upgrade_required in words about Claude, nothing queued", async () => {
		const { host, sessionId } = await liveWorld();
		await getDb()
			.update(supervisors)
			.set({ capabilities: { version: 1, features: [] } as never })
			.where(eq(supervisors.id, host.id));
		const res = await post(`/sessions/${sessionId}/stop`);
		expect(res.status).toBe(409);
		expect(await body(res)).toEqual({
			error: "host_upgrade_required",
			message: CLAUDE_STOP_UPGRADE_MESSAGE,
		});
		expect(await actionRows()).toHaveLength(0);
	});

	test("a second stop while one is open: 400 control_busy, the code in `error` and the old sentence in `message`", async () => {
		const { sessionId } = await liveWorld();
		expect((await post(`/sessions/${sessionId}/stop`)).status).toBe(202);
		const res = await post(`/sessions/${sessionId}/stop`);
		expect(res.status).toBe(400);
		expect(await body(res)).toEqual({
			error: "control_busy",
			message: "Another control action is already in progress for this session.",
		});
	});

	test("a session that has already ended: 409 nothing_to_stop", async () => {
		const { sessionId } = await liveWorld();
		await getDb()
			.update(managedSessions)
			.set({ managedState: "stopped" })
			.where(eq(managedSessions.sessionId, sessionId));
		await getDb()
			.update(launchRequests)
			.set({ status: "completed" })
			.where(eq(launchRequests.launchCorrelationId, sessionId));
		const res = await post(`/sessions/${sessionId}/stop`);
		expect(res.status).toBe(409);
		expect((await body(res)).error).toBe("nothing_to_stop");
		expect(await actionRows()).toHaveLength(0);
	});

	test("a session started in a terminal: 409 stop_not_supported in fixed words, nothing queued, no lock", async () => {
		const { sessionId } = await liveWorld();
		await getDb()
			.update(launchRequests)
			.set({ requestedLaunchMode: "interactive_terminal" })
			.where(eq(launchRequests.launchCorrelationId, sessionId));
		const res = await post(`/sessions/${sessionId}/stop`);
		expect(res.status).toBe(409);
		expect(await body(res)).toEqual({
			error: "stop_not_supported",
			message:
				"Stop isn't available for sessions started in a terminal yet. Stop it in that terminal.",
		});
		expect(await actionRows()).toHaveLength(0);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, sessionId));
		expect(managed?.activeControlActionId).toBeNull();
	});

	test("an unexpected failure while queueing says nothing about it: fixed words out, detail in the log", async () => {
		const { sessionId } = await liveWorld();
		const actions = await import("../services/control-actions.js");
		const failing = spyOn(actions, "queueStopAction").mockRejectedValue(
			new Error('relation "control_actions" at /srv/db/secret-path exploded'),
		);
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await post(`/sessions/${sessionId}/stop`);
			expect(res.status).toBe(400);
			expect(await body(res)).toEqual({ error: "Unable to queue stop" });
			expect(logged.mock.calls.flat().map(String).join(" ")).toContain("secret-path");
		} finally {
			failing.mockRestore();
			logged.mockRestore();
		}
	});
});
