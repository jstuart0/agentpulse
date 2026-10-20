/**
 * AGEN-76 boundary contract (D6): after the sweep completes a session whose
 * supervisor lease expired, the wire shape is unchanged. `managed` still means
 * "a supervisor launched it", the host reads offline, and the session stays
 * controllable: prompt and stop queue as for any offline host and wait for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { updateStaleSessions } = await import("../services/session-tracker.js");
const { seedManagedSession, seedSupervisor } = await import("../test-utils/supervisor-fixture.js");

const originalDisableAuth = config.disableAuth;
const HUNDRED_DAYS = 100 * 24 * 60 * 60 * 1000;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

const get = (path: string) => app.request(`/api/v1${path}`);
const post = (path: string, body?: unknown) =>
	app.request(`/api/v1${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

async function sweptStaleSession(sessionId: string) {
	await seedManagedSession({
		sessionId,
		supervisorId: "dead-host",
		managedState: "interactive_terminal",
		session: {
			status: "active",
			isWorking: true,
			lastActivityAt: new Date(Date.now() - HUNDRED_DAYS).toISOString(),
		},
	});
}

async function world() {
	await seedSupervisor("dead-host", {
		storedStatus: "connected",
		leaseOffsetMs: -HUNDRED_DAYS,
		leaseBaseMs: Date.now(),
	});
	await sweptStaleSession("stale-a");
	await sweptStaleSession("stale-b");
	await updateStaleSessions();
}

describe("a session completed by a lease-expired supervisor", () => {
	test("is listed as completed and managed", async () => {
		await world();
		const body = (await (await get("/sessions?tab=completed")).json()) as {
			sessions: { sessionId: string; managed: boolean; operationalStatus: string }[];
		};
		const row = body.sessions.find((s) => s.sessionId === "stale-a");
		expect(row?.managed).toBe(true);
		expect(row?.operationalStatus).toBe("completed");
	});

	test("detail still carries managedSession", async () => {
		await world();
		const body = (await (await get("/sessions/stale-a")).json()) as {
			session: { managedSession?: { managedState: string } };
		};
		expect(body.session.managedSession?.managedState).toBe("interactive_terminal");
	});

	test("the host reads offline although its stored status is connected", async () => {
		await world();
		const res = await get("/admin/supervisors");
		const body = (await res.json()) as { supervisors: { id: string; status: string }[] };
		expect(body.supervisors.find((s) => s.id === "dead-host")?.status).toBe("offline");
	});

	test("prompt and stop still queue, and stay queued after another sweep", async () => {
		await world();
		const prompt = await post("/sessions/stale-a/prompt", { prompt: "hi" });
		expect(prompt.status).toBe(202);
		const promptBody = (await prompt.json()) as { action: { status: string; actionType: string } };
		expect(promptBody.action).toMatchObject({ status: "queued", actionType: "prompt" });

		const stop = await post("/sessions/stale-b/stop");
		expect(stop.status).toBe(202);
		expect(((await stop.json()) as { action: { status: string } }).action.status).toBe("queued");

		await updateStaleSessions();
		const rows = await getDb().select().from(controlActions);
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.status === "queued")).toBe(true);
		const [session] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, "stale-a"));
		expect(session?.status).toBe("completed");
	});
});
