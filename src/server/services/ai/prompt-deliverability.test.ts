import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./__test_db.js";
import { seedManagedSession, seedSupervisor } from "../../test-utils/supervisor-fixture.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const schema = await import("../../db/schema/index.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = schema;
const { promptDeliverability } = await import("./prompt-deliverability.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
});

async function seed(name: string, state: string, supervisor: "live" | "offline" = "live") {
	await seedSupervisor(`sup-${name}`, {
		leaseOffsetMs: supervisor === "live" ? 60_000 : -60_000,
		leaseBaseMs: Date.now(),
	});
	await seedManagedSession({
		sessionId: `s-${name}`,
		supervisorId: `sup-${name}`,
		managedState: state,
	});
	return `s-${name}`;
}

describe("promptDeliverability", () => {
	test("a session AgentPulse didn't launch is observed: never deliverable", async () => {
		await getDb().insert(sessions).values({ sessionId: "obs", agentType: "claude_code" });
		expect(await promptDeliverability("obs")).toEqual({ deliverable: false, reason: "observed" });
		expect(await promptDeliverability("no-such-session")).toEqual({
			deliverable: false,
			reason: "observed",
		});
	});

	test("a launched session with a live supervisor in a prompt-taking state is deliverable", async () => {
		for (const state of ["managed", "headless", "interactive_terminal"]) {
			const id = await seed(state, state);
			expect({ state, ...(await promptDeliverability(id)) }).toEqual({ state, deliverable: true });
		}
	});

	test("an offline supervisor is supervisor_offline", async () => {
		const id = await seed("off", "managed", "offline");
		expect(await promptDeliverability(id)).toEqual({
			deliverable: false,
			reason: "supervisor_offline",
		});
	});

	test("a state that doesn't take prompts is managed_state", async () => {
		for (const state of ["pending", "linked", "degraded", "stopped", "completed", "failed"]) {
			const id = await seed(state, state);
			expect(await promptDeliverability(id)).toEqual({
				deliverable: false,
				reason: "managed_state",
			});
		}
	});

	test("a live control lock is control_busy; an expired one is cleared first and reads deliverable", async () => {
		const id = await seed("busy", "managed");
		const actionId = crypto.randomUUID();
		await getDb().insert(controlActions).values({
			id: actionId,
			sessionId: id,
			actionType: "prompt",
			requestedBy: "user",
			status: "queued",
		});
		await getDb()
			.update(managedSessions)
			.set({
				activeControlActionId: actionId,
				controlLockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			})
			.where(eq(managedSessions.sessionId, id));
		expect(await promptDeliverability(id)).toEqual({ deliverable: false, reason: "control_busy" });

		await getDb()
			.update(managedSessions)
			.set({ controlLockExpiresAt: new Date(Date.now() - 1_000).toISOString() })
			.where(eq(managedSessions.sessionId, id));
		expect(await promptDeliverability(id)).toEqual({ deliverable: true });
		const [row] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, id));
		expect(row?.activeControlActionId).toBeNull();
		const [action] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, actionId));
		expect(action?.status).toBe("failed");
	});
});
