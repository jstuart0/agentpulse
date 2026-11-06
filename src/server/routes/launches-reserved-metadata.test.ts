/**
 * AGEN-110 / AGEN-117 T11: `boundObservedSession` and `boundByUserId` in a launch's metadata are the
 * server's own record of a takeover. A client that posts them to `POST /launches` must not get them: the
 * first would route that launch's Stop down the stream path and its resume as a takeover, the second would
 * name a person who pressed nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests, supervisors } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { stopRuntimeOf } = await import("../services/control-actions.js");

const originalDisableAuth = config.disableAuth;
beforeAll(async () => {
	await initializeDatabase();
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function reset() {
	(config as Record<string, unknown>).disableAuth = false;
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

async function seedHost() {
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id: "rm-host",
			hostName: "rm-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: ["enforces_launch_privileges"],
				executables: {
					claude: { available: true, command: "claude", resolvedPath: "/bin/claude" },
				},
			},
			trustedRoots: ["/tmp"],
			status: "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			createdAt: now,
			updatedAt: now,
		} as never);
}

function payload(metadata: Record<string, unknown>) {
	return JSON.stringify({
		template: {
			name: "t",
			agentType: "claude_code",
			cwd: "/tmp/rm",
			baseInstructions: "",
			taskPrompt: "go",
			model: "m",
			approvalPolicy: "manual",
			sandboxMode: null,
			env: {},
		},
		requestedLaunchMode: "headless",
		requestedSupervisorId: "rm-host",
		launchSpec: { version: 1, providerConfig: { command: "claude", cliArgs: [] } },
		metadata,
	});
}

async function post(metadata: Record<string, unknown>) {
	await setStoredMode("solo");
	await seedHost();
	const user = await seedLocalUser("rm-post");
	const headers = new Headers(await cookieHeadersFor(user.id));
	headers.set("Content-Type", "application/json");
	return app.request("/api/v1/launches", { method: "POST", headers, body: payload(metadata) });
}

describe("POST /launches: server-only metadata", () => {
	test("a posted boundObservedSession and boundByUserId are dropped, other metadata is kept, and Stop still routes as a headless launch", async () => {
		const res = await post({
			clientRequestId: "rm-req-1",
			boundObservedSession: true,
			boundByUserId: "someone-else",
			note: "keep me",
		});
		expect(res.status).toBe(201);
		const [row] = await getDb().select().from(launchRequests);
		const metadata = (row?.metadata ?? {}) as Record<string, unknown>;
		expect(metadata.boundObservedSession).toBeUndefined();
		expect(metadata.boundByUserId).toBeUndefined();
		expect(metadata.note).toBe("keep me");
		expect(metadata.clientRequestId).toBe("rm-req-1");
		expect(stopRuntimeOf(row as never)).toBe("claude_headless");
	});

	test("positive control: the same flag written by a server-only writer does route as a carrier", async () => {
		await post({ clientRequestId: "rm-req-2" });
		const [row] = await getDb().select().from(launchRequests);
		expect(
			stopRuntimeOf({ ...(row as object), metadata: { boundObservedSession: true } } as never),
		).toBe("claude_stream");
	});
});
