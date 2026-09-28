/**
 * F85 (ian mid-build): POST /api/v1/supervisors/:id/managed-session-state's
 * REST response must carry nameSource/nativeName — before this fix the WS
 * broadcast (notifySessionUpdated) got the mapped session but c.json(result)
 * returned the raw, unmapped row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function registerFreshSupervisor(): Promise<{ id: string; credential: string }> {
	const { token } = await createSupervisorEnrollmentToken(
		`f85-test-${crypto.randomUUID()}`,
		null,
		null,
	);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "f85-test-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
		}),
	});
	const body = (await res.json()) as { supervisorCredential: string };
	return { id, credential: body.supervisorCredential };
}

describe("POST /supervisors/:id/managed-session-state — response carries nameSource/nativeName", () => {
	test("a pinned session's response.session reflects nameSource:'user'", async () => {
		const { id, credential } = await registerFreshSupervisor();
		const sessionId = `f85-pinned-${crypto.randomUUID()}`;
		await getDb()
			.insert(sessions)
			.values({
				sessionId,
				displayName: "human-chosen-name",
				agentType: "codex_cli",
				status: "active",
				lastActivityAt: new Date().toISOString(),
				metadata: { renameSource: "user", nativeName: "codex-thread-name" },
			})
			.execute();

		const res = await app.request(`/api/v1/supervisors/${id}/managed-session-state`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credential}`,
			},
			body: JSON.stringify({ sessionId }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			session: { nameSource: string; nativeName: string | null };
		};
		expect(body.session.nameSource).toBe("user");
		expect(body.session.nativeName).toBe("codex-thread-name");
	});
});
