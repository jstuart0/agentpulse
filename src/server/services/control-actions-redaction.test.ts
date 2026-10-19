/**
 * What a person can read of a control action. The launch environment is for the supervisor that runs the
 * action and is never shown to anyone else; the prompt is shown only after the caller's own owner check
 * (the reader asks for it). The supervisor's own channel (claim, update) still gets everything it needs.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { bearerHeaders, jsonRequest, seedKey } from "../test-utils/team-fixtures.js";

setDefaultTimeout(60_000);

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { app } = await import("../app.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const {
	claimNextControlAction,
	listControlActionsForSession,
	queuePromptAction,
	redactControlAction,
} = await import("./control-actions.js");

const ENV = { SECRET_TOKEN: "env-secret-value" };
beforeAll(() => initializeDatabase(), 60_000);
async function reset() {
	await getDb().delete(controlActions);
	await getDb().delete(managedSessions);
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
	await getDb().delete(sessions);
}
beforeEach(reset, 60_000);
afterEach(reset, 60_000);

async function managedSession(sessionId: string) {
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", metadata: {} });
	await getDb()
		.insert(supervisors)
		.values({ id: "rd-sup", hostName: "h", platform: "linux", arch: "x64", version: "0" })
		.onConflictDoNothing();
	const { launchId } = await seedOwnedLaunch(sessionId, "rd-sup");
	await getDb().update(launchRequests).set({ env: ENV }).where(eq(launchRequests.id, launchId));
	const now = new Date().toISOString();
	await getDb().insert(managedSessions).values({
		sessionId,
		launchRequestId: launchId,
		supervisorId: "rd-sup",
		managedState: "managed",
		createdAt: now,
		updatedAt: now,
	});
}

describe("redaction", () => {
	const action = {
		id: "a",
		sessionId: "s",
		launchRequestId: null,
		actionType: "prompt",
		requestedBy: null,
		requestedByUserId: null,
		status: "queued",
		error: null,
		metadata: { prompt: "do it", env: ENV, cwd: "/x" },
		idempotencyKey: null,
		claimedBySupervisorId: null,
		finishedAt: null,
		createdAt: "x",
		updatedAt: "x",
	} as never;

	test("the environment is dropped whether or not the prompt is shown; the prompt only when asked for", () => {
		const withPrompt = redactControlAction(action, { includePrompt: true });
		expect(withPrompt.metadata).toEqual({ prompt: "do it", cwd: "/x" });
		const without = redactControlAction(action, { includePrompt: false });
		expect(without.metadata).toEqual({ cwd: "/x" });
	});

	test("an action with no metadata passes through", () => {
		const bare = { ...(action as object), metadata: null } as never;
		expect(redactControlAction(bare, { includePrompt: false })).toBe(bare);
	});
});

describe("the readers and the supervisor channel", () => {
	test("a list shows no environment, and no prompt unless the caller asked for it after its own check", async () => {
		await managedSession("rd-1");
		await queuePromptAction("rd-1", "run the tests", { userId: null, label: "user" });

		const [plain] = await listControlActionsForSession("rd-1");
		const [owned] = await listControlActionsForSession("rd-1", { includePrompt: true });

		expect(JSON.stringify(plain)).not.toContain("run the tests");
		expect(JSON.stringify(owned)).toContain("run the tests");
		for (const read of [plain, owned])
			expect(JSON.stringify(read)).not.toContain("env-secret-value");
	});

	test("the supervisor that claims the action still gets the prompt and the environment it needs to run it", async () => {
		await managedSession("rd-2");
		await queuePromptAction("rd-2", "run the tests", { userId: null, label: "user" });

		const claimed = await claimNextControlAction("rd-sup");

		const metadata = claimed?.metadata as { prompt?: string; env?: Record<string, string> };
		expect(metadata.prompt).toBe("run the tests");
		expect(metadata.env).toEqual(ENV);
	});

	test("the prompt and stop answers carry the action without the environment", async () => {
		await managedSession("rd-3");
		const key = (await seedKey("rd-manage", ["manage"])).key;

		const res = await app.request(
			"/api/v1/sessions/rd-3/prompt",
			jsonRequest("POST", { prompt: "hello there" }, bearerHeaders(key)),
		);

		expect(res.status).toBe(202);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("hello there");
		expect(text).not.toContain("env-secret-value");
	});
});
